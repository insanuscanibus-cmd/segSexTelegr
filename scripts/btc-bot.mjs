// btc-bot.mjs
// Motor de estratégias semanais para BTC/SOL (baseado no relatório V7).
// Roda a cada 30 min, mas só ENVIA mensagem quando estamos dentro da janela
// de decisão de alguma estratégia (logo após o candle diário relevante fechar).
// Cada janela gera exatamente 1 mensagem: sinal ACIONADO ou 🔇 Sem sinal.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const DATA_FILE = path.join(process.cwd(), "data", "state.json");
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("Faltam variáveis de ambiente: TELEGRAM_BOT_TOKEN e/ou TELEGRAM_CHAT_ID");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Utilitários de tempo
// ---------------------------------------------------------------------------

const now = new Date();

function isoWeekday(date) {
  const d = date.getUTCDay(); // 0=Dom..6=Sáb
  return d === 0 ? 7 : d; // 1=Seg..7=Dom
}

function fmtDateTime(date) {
  const utc = date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const brt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  return `🕒 ${brt} (BRT) — ${utc}`;
}

function dateKey(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Só dispara na primeira execução do dia (hora 0, UTC) — cron roda a cada 30min
const isFirstRunOfDay = now.getUTCHours() === 0;

// ---------------------------------------------------------------------------
// Binance: candles diários e mensais
// ---------------------------------------------------------------------------

async function fetchKlines(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Binance klines ${symbol}/${interval} falhou ${res.status}: ${raw}`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Binance klines ${symbol}/${interval} retornou algo inválido: ${raw.slice(0, 200)}`);
  }
  return json.map((k) => ({
    openTime: new Date(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
  }));
}

function groupIntoWeeks(dailyCandles) {
  const weeks = [];
  let current = null;
  for (const c of dailyCandles) {
    const wd = isoWeekday(c.openTime);
    if (wd === 1 || !current) {
      current = { days: {} };
      weeks.push(current);
    }
    current.days[wd] = c;
  }
  return weeks;
}

function groupIntoMonths(dailyCandles) {
  const months = new Map();
  for (const c of dailyCandles) {
    const key = `${c.openTime.getUTCFullYear()}-${String(c.openTime.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!months.has(key)) months.set(key, { open: c.open, close: c.close, days: [] });
    const m = months.get(key);
    m.close = c.close; // último candle do mês vira o close corrente
    m.days.push(c);
  }
  return months;
}

// ---------------------------------------------------------------------------
// Helpers de estratégia
// ---------------------------------------------------------------------------

const pct = (a, b) => ((b - a) / a) * 100;
const isGreen = (c) => c && c.close > c.open;

function weekOpen(week) {
  return week?.days?.[1]?.open;
}

function returnFromMondayOpen(week, throughWeekday) {
  const open = weekOpen(week);
  const c = week?.days?.[throughWeekday];
  if (open == null || !c) return null;
  return pct(open, c.close);
}

function lowFromMonday(week, throughWeekday) {
  let low = null;
  for (let d = 1; d <= throughWeekday; d++) {
    const c = week?.days?.[d];
    if (!c) return null;
    if (low === null || c.low < low) low = c.low;
  }
  const open = weekOpen(week);
  if (open == null || low === null) return null;
  return pct(open, low); // negativo = drawdown
}

function countGreens(week, throughWeekday) {
  let n = 0;
  for (let d = 1; d <= throughWeekday; d++) {
    if (isGreen(week?.days?.[d])) n++;
  }
  return n;
}

function weekHigh(week, throughWeekday = 7) {
  let high = null;
  for (let d = 1; d <= throughWeekday; d++) {
    const c = week?.days?.[d];
    if (c && (high === null || c.high > high)) high = c.high;
  }
  return high;
}

function weekLow(week, throughWeekday = 7) {
  let low = null;
  for (let d = 1; d <= throughWeekday; d++) {
    const c = week?.days?.[d];
    if (c && (low === null || c.low < low)) low = c.low;
  }
  return low;
}

// ---------------------------------------------------------------------------
// Estado (evita alertar 2x na mesma janela)
// ---------------------------------------------------------------------------

async function loadState() {
  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { fired: {} };
  }
}

async function saveState(state) {
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "Markdown" }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Falha ao enviar mensagem no Telegram: ${res.status} ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Definição das estratégias
// Cada uma: id, weekday (janela de disparo, 1=Seg..7=Dom) ou custom(),
// e evaluate(ctx) -> { fired: bool, text: string }
// ---------------------------------------------------------------------------

const STRATEGIES = [];

// 1) BREAKOUT — Segunda, olha as últimas 4+ semanas fechadas
STRATEGIES.push({
  id: "breakout",
  weekday: 1,
  evaluate({ weeksBtc }) {
    const closed = weeksBtc.slice(0, -1);
    if (closed.length < 5) return { fired: false, text: "Histórico insuficiente ainda." };
    const lastWeek = closed[closed.length - 1];
    const prior4 = closed.slice(-5, -1);
    const rets = prior4.map((w) => returnFromMondayOpen(w, 7)).filter((v) => v != null);
    if (rets.length < 4) return { fired: false, text: "Histórico insuficiente ainda." };
    const volatility = Math.max(...rets) - Math.min(...rets);
    const lastWeekRet = returnFromMondayOpen(lastWeek, 7);
    const consolidado = volatility < 5;
    const rompeu = lastWeekRet != null && lastWeekRet > 5;
    if (consolidado && rompeu) {
      return {
        fired: true,
        text: `🚀 *BREAKOUT confirmado!*\nConsolidação de 4+ semanas (variação ${volatility.toFixed(2)}%) seguida de alta semanal de ${lastWeekRet.toFixed(2)}%.\nHistoricamente: 75% de chance da próxima semana fechar positiva (+5,43% em média).`,
      };
    }
    return {
      fired: false,
      text: `Consolidação: ${consolidado ? "sim" : "não"} (variação ${volatility.toFixed(2)}%). Última semana: ${lastWeekRet?.toFixed(2) ?? "?"}%.`,
    };
  },
});

// 2) MONDAY PATTERNS — Segunda, compara com semana anterior
STRATEGIES.push({
  id: "monday_patterns",
  weekday: 1,
  evaluate({ weeksBtc }) {
    const closed = weeksBtc.slice(0, -1);
    if (closed.length < 2) return { fired: false, text: "Histórico insuficiente ainda." };
    const lastWeek = closed[closed.length - 1];
    const prevWeek = closed[closed.length - 2];
    const mondayCandle = lastWeek.days[1];
    if (!mondayCandle) return { fired: false, text: "Sem candle de segunda disponível." };
    const prevHigh = weekHigh(prevWeek);
    const varVsPrevHigh = prevHigh ? pct(prevHigh, mondayCandle.close) : null;
    const prevWeekPositive = returnFromMondayOpen(prevWeek, 7) > 0;

    if (varVsPrevHigh != null && varVsPrevHigh >= 8 && prevWeekPositive) {
      return {
        fired: true,
        text: `🔹 *Padrão 2 acionado!*\nSegunda fechou +${varVsPrevHigh.toFixed(2)}% acima da máxima da semana passada, e a semana anterior foi positiva.\nHistórico: 10/10 casos fecharam em alta (+12,4% em média).`,
      };
    }
    if (varVsPrevHigh != null && varVsPrevHigh >= 4) {
      return {
        fired: true,
        text: `🔹 *Padrão 1 acionado!*\nSegunda fechou +${varVsPrevHigh.toFixed(2)}% acima da máxima da semana passada.\nHistórico: 15/15 casos fecharam em alta.`,
      };
    }
    return {
      fired: false,
      text: `Segunda vs máxima da semana passada: ${varVsPrevHigh?.toFixed(2) ?? "?"}% (precisa de +4% ou +8%).`,
    };
  },
});

// 3) MONDAY INDICATORS — Terça (após fechamento de segunda)
STRATEGIES.push({
  id: "monday_indicators",
  weekday: 2,
  evaluate({ weeksBtc }) {
    const closed = weeksBtc.slice(0, -1);
    const currentWeek = weeksBtc[weeksBtc.length - 1];
    const monday = currentWeek.days[1];
    if (!monday) return { fired: false, text: "Sem candle de segunda ainda." };
    const prevWeek = closed[closed.length - 1];

    const prevHigh = prevWeek ? weekHigh(prevWeek) : null;
    const prevLow = prevWeek ? weekLow(prevWeek) : null;
    const isWeeklyHigh = prevHigh != null && monday.high >= prevHigh;
    const isWeeklyLow = prevLow != null && monday.low <= prevLow;
    const mondayRet = pct(monday.open, monday.close);
    const isPump = mondayRet > 5;

    const hits = [];
    if (isPump) hits.push(`🚀 *5% Pump!* Segunda fechou +${mondayRet.toFixed(2)}%. Abertura: $${monday.open.toFixed(0)} → Fechamento: $${monday.close.toFixed(0)}.`);
    if (isWeeklyHigh) hits.push(`📈 *Weekly High!* Segunda foi o preço mais alto da semana passada+atual. Preço: $${monday.close.toFixed(0)}.`);
    if (isWeeklyLow) hits.push(`📉 *Weekly Low!* Segunda foi o preço mais baixo. Preço: $${monday.close.toFixed(0)}.`);

    if (hits.length > 0) return { fired: true, text: hits.join("\n\n") };
    return { fired: false, text: `Segunda: ${mondayRet.toFixed(2)}%. Sem rompimento de máxima/mínima e sem pump de 5%.` };
  },
});

// 4) 1-2 PUNCH — Quarta (após fechamento de terça)
STRATEGIES.push({
  id: "one_two_punch",
  weekday: 3,
  evaluate({ weeksBtc }) {
    const week = weeksBtc[weeksBtc.length - 1];
    const mon = week.days[1];
    const tue = week.days[2];
    if (!mon || !tue) return { fired: false, text: "Candles insuficientes." };
    const monPct = pct(mon.open, mon.close);
    const tuePct = pct(tue.open, tue.close);
    if (monPct > 1 && tuePct > 1) {
      return {
        fired: true,
        text: `🥊 *1-2 Punch!*\nSegunda e Terça fecharam acima de +1%.\nSeg: +${monPct.toFixed(2)}% | Ter: +${tuePct.toFixed(2)}%`,
      };
    }
    return { fired: false, text: `Seg: ${monPct.toFixed(2)}% | Ter: ${tuePct.toFixed(2)}% (precisa >+1% nos dois dias).` };
  },
});

// 5) WEDNESDAY PUMP — Quinta (após fechamento de quarta) — contexto informativo
STRATEGIES.push({
  id: "wednesday_pump",
  weekday: 4,
  evaluate({ weeksBtc }) {
    const week = weeksBtc[weeksBtc.length - 1];
    const ret = returnFromMondayOpen(week, 3);
    if (ret == null) return { fired: false, text: "Candles insuficientes." };
    if (ret >= 5) {
      return { fired: true, text: `📈 *Wednesday Pump forte!*\nVariação Seg→Qua: +${ret.toFixed(2)}%.\nHistórico: 91% das semanas fecham positivas quando isso acontece.` };
    }
    if (ret >= 3) {
      return { fired: true, text: `📈 *Wednesday Pump!*\nVariação Seg→Qua: +${ret.toFixed(2)}%.\nHistórico: 86% das semanas fecham positivas quando isso acontece.` };
    }
    return { fired: false, text: `Variação Seg→Qua: ${ret.toFixed(2)}% (precisa de pelo menos +3%).` };
  },
});

// 6) LONG QUINTA (V7 refinado) — Quinta (após fechamento de quarta)
// Entrada causal Qui 00:00, baseada em Mon+Tue+Wed
STRATEGIES.push({
  id: "long_thu_v7",
  weekday: 4,
  evaluate({ weeksBtc }) {
    const week = weeksBtc[weeksBtc.length - 1];
    const greens = countGreens(week, 3);
    const wedRet = returnFromMondayOpen(week, 3);
    const low = lowFromMonday(week, 3);
    if (wedRet == null || low == null) return { fired: false, text: "Candles insuficientes." };

    const tiers = [
      { greensMin: 3, retMin: 4, lowMin: -1, wr: "92,3%", n: 13 },
      { greensMin: 3, retMin: 2, lowMin: -1, wr: "86,7%", n: 15 },
      { greensMin: 3, retMin: 3, lowMin: -1, wr: "85,7%", n: 14 },
    ];
    for (const t of tiers) {
      if (greens >= t.greensMin && wedRet >= t.retMin && low >= t.lowMin) {
        return {
          fired: true,
          text: `✅✅ *LONG BTC — sinal Quinta (V7)*\nSeg-Qua: ${greens}/3 dias verdes, variação Seg→Qua +${wedRet.toFixed(2)}%, drawdown máx ${low.toFixed(2)}%.\nBacktest: WR causal ${t.wr} (n=${t.n}), entrada Qui 00:00 UTC, SL5%/TP5%, saída Dom 23:00 UTC.`,
        };
      }
    }
    return {
      fired: false,
      text: `Seg-Qua: ${greens}/3 dias verdes, variação +${wedRet.toFixed(2)}%, drawdown ${low.toFixed(2)}% — não atingiu nenhum tier (mínimo: 3 verdes, +2% e drawdown ≥-1%).`,
    };
  },
});

// 7) LONG SEXTA (V7 refinado) — Sexta (após fechamento de quinta)
STRATEGIES.push({
  id: "long_fri_v7",
  weekday: 5,
  evaluate({ weeksBtc }) {
    const week = weeksBtc[weeksBtc.length - 1];
    const greens = countGreens(week, 3);
    const thuRet = returnFromMondayOpen(week, 4);
    const low = lowFromMonday(week, 4);
    if (thuRet == null || low == null) return { fired: false, text: "Candles insuficientes." };

    const tiers = [
      { retMin: 6, lowMin: -2, wr: "86,7%", n: 15 },
      { retMin: 5, lowMin: -1, wr: "84,6%", n: 13 },
      { retMin: 5, lowMin: -2, wr: "82,4%", n: 17 },
      { retMin: 2, lowMin: -1, wr: "80,0%", n: 15 },
    ];
    if (greens >= 3) {
      for (const t of tiers) {
        if (thuRet >= t.retMin && low >= t.lowMin) {
          return {
            fired: true,
            text: `✅ *LONG BTC — sinal Sexta (V7)*\nSeg-Qua verdes, variação Seg→Qui +${thuRet.toFixed(2)}%, drawdown máx ${low.toFixed(2)}%.\nBacktest: WR causal ${t.wr} (n=${t.n}), entrada Sex 00:00 UTC, SL5%/TP3-5%, saída Dom 23:00 UTC.`,
          };
        }
      }
    }
    return {
      fired: false,
      text: `Verdes Seg-Qua: ${greens}/3, variação Seg→Qui: +${thuRet.toFixed(2)}%, drawdown ${low.toFixed(2)}% — condição não atingida.`,
    };
  },
});

// 8) SOL LONG SEXTA (V7)
STRATEGIES.push({
  id: "long_fri_sol_v7",
  weekday: 5,
  evaluate({ weeksSol }) {
    if (!weeksSol) return { fired: false, text: "Sem dados de SOL." };
    const week = weeksSol[weeksSol.length - 1];
    const greens = countGreens(week, 3);
    const thuRet = returnFromMondayOpen(week, 4);
    const low = lowFromMonday(week, 4);
    if (thuRet == null || low == null) return { fired: false, text: "Candles insuficientes." };

    if (greens >= 2 && thuRet >= 12 && low >= -2) {
      return {
        fired: true,
        text: `✅ *LONG SOL — sinal Sexta (V7)*\nSeg-Qua: ${greens}/3 dias verdes, variação Seg→Qui +${thuRet.toFixed(2)}%, drawdown máx ${low.toFixed(2)}%.\nBacktest: WR causal 81,8% (n=11), entrada Sex 00:00 UTC, SL8%/TP8%, saída Dom 23:00 UTC.\n⚠️ SOL precisa de stop mais largo (8-10%) que BTC.`,
      };
    }
    return {
      fired: false,
      text: `SOL Seg-Qua: ${greens}/3 verdes, variação Seg→Qui +${thuRet.toFixed(2)}%, drawdown ${low.toFixed(2)}% — condição não atingida (precisa ≥2 verdes, +12%, drawdown ≥-2%).`,
    };
  },
});

// 9) WEEKLY CANDLES — Domingo (após fechamento de sábado) — prioridade Verde > Amarela > Branca
STRATEGIES.push({
  id: "weekly_candles",
  weekday: 7,
  evaluate({ weeksBtc }) {
    const week = weeksBtc[weeksBtc.length - 1];
    const daysPresent = [1, 2, 3, 4, 5, 6].every((d) => week.days[d]);
    if (!daysPresent) return { fired: false, text: "Candles insuficientes." };

    const retsMonSab = [1, 2, 3, 4, 5, 6].map((d) => returnFromMondayOpen(week, d));
    const retsMonSex = retsMonSab.slice(0, 5);

    const verde = retsMonSab.every((r) => r <= 0);
    const amarela = retsMonSex.every((r) => r <= 0);
    const branca = retsMonSab.every((r) => r < 1);

    if (verde) {
      return { fired: true, text: `🟢 *Regra Verde!*\nSeg→Sáb todos ≤0%.\n👉 100% Long Domingo, mínimo de 2% de lucro (histórico).` };
    }
    if (amarela) {
      return { fired: true, text: `🟡 *Regra Amarela!*\nSeg→Sex todos ≤0%.\n👉 Possível alta no Domingo — atenção, mas menor confiança que a Verde.` };
    }
    if (branca) {
      return { fired: true, text: `⚪ *Regra Branca!*\nSeg→Sáb todos <1%.\n👉 Possível alta no Domingo.` };
    }
    return { fired: false, text: `Nenhuma condição de semana "parada" bateu (Seg→Sáb teve variação relevante).` };
  },
});

// 10) SELL IN MAY — 1 a 6 de maio
STRATEGIES.push({
  id: "sell_in_may",
  custom: (d) => d.getUTCMonth() === 4 && d.getUTCDate() >= 1 && d.getUTCDate() <= 6,
  evaluate({ dailyBtc, dateObj }) {
    const day = dateObj.getUTCDate();
    const aprilDays = dailyBtc.filter(
      (c) => c.openTime.getUTCFullYear() === dateObj.getUTCFullYear() && c.openTime.getUTCMonth() === 3
    );
    if (aprilDays.length === 0) return { fired: false, text: "Sem dados de abril ainda." };
    const aprilHigh = Math.max(...aprilDays.map((c) => c.high));

    const mayDays = dailyBtc.filter(
      (c) => c.openTime.getUTCFullYear() === dateObj.getUTCFullYear() && c.openTime.getUTCMonth() === 4 && c.openTime.getUTCDate() < day
    );
    const romperMaximaAbril = mayDays.some((c) => c.high >= aprilHigh);

    if (day <= 5) {
      if (romperMaximaAbril) {
        return { fired: true, text: `🟢 *Sell in May — COMPRA!*\nMaio rompeu a máxima de abril ($${aprilHigh.toFixed(0)}) até o dia ${day}.` };
      }
      return { fired: false, text: `Ainda não rompeu a máxima de abril ($${aprilHigh.toFixed(0)}). Dia ${day}/6.` };
    }
    if (!romperMaximaAbril) {
      return { fired: true, text: `🔻 *Sell in May — VENDA!*\nMaio não rompeu a máxima de abril ($${aprilHigh.toFixed(0)}) nos primeiros 5 dias.` };
    }
    return { fired: false, text: `Máxima de abril já havia sido rompida antes do dia 6 — regra de venda não se aplica.` };
  },
});

// 11) GREEN MONTH — dia 2 do mês
STRATEGIES.push({
  id: "green_month",
  custom: (d) => d.getUTCDate() === 2,
  evaluate({ monthsBtc, dateObj }) {
    const keyThis = `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, "0")}`;
    const prevDate = new Date(Date.UTC(dateObj.getUTCFullYear(), dateObj.getUTCMonth() - 1, 1));
    const keyPrev = `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, "0")}`;

    const thisMonth = monthsBtc.get(keyThis);
    const prevMonth = monthsBtc.get(keyPrev);
    if (!thisMonth || !prevMonth || thisMonth.days.length === 0) {
      return { fired: false, text: "Dados de mês insuficientes." };
    }
    const day1 = thisMonth.days[0];
    const prevMonthGreen = prevMonth.close > prevMonth.open;
    const day1Green = day1.close > day1.open;

    if (prevMonthGreen && day1Green) {
      return {
        fired: true,
        text: `🟢 *Green Month confirmado!*\nMês anterior fechou verde e dia 1 também abriu/fechou verde.\nHistórico: 90% dos casos (30/33) o BTC sobe ≥5% em 60 dias, média +38,8%.`,
      };
    }
    return {
      fired: false,
      text: `Mês anterior: ${prevMonthGreen ? "verde" : "vermelho"}. Dia 1 deste mês: ${day1Green ? "verde" : "vermelho"}. Precisa dos dois verdes.`,
    };
  },
});

// ---------------------------------------------------------------------------
// Execução principal
// ---------------------------------------------------------------------------

async function main() {
  if (!isFirstRunOfDay) {
    console.log(`Fora da janela de decisão (hora UTC atual: ${now.getUTCHours()}). Nada a fazer.`);
    return;
  }

  const [dailyBtc, dailySol] = await Promise.all([
    fetchKlines("BTCUSDT", "1d", 200),
    fetchKlines("SOLUSDT", "1d", 200),
  ]);
  const weeksBtc = groupIntoWeeks(dailyBtc);
  const weeksSol = groupIntoWeeks(dailySol);
  const monthsBtc = groupIntoMonths(dailyBtc);

  const ctx = { dailyBtc, dailySol, weeksBtc, weeksSol, monthsBtc, dateObj: now };
  const state = await loadState();
  const wd = isoWeekday(now);

  for (const strat of STRATEGIES) {
    const inWindow = strat.custom ? strat.custom(now) : strat.weekday === wd;
    if (!inWindow) continue;

    const key = `${strat.id}:${dateKey(now)}`;
    if (state.fired[key]) continue;

    let result;
    try {
      result = strat.evaluate(ctx);
    } catch (err) {
      console.error(`Erro ao avaliar estratégia ${strat.id}:`, err);
      continue;
    }

    const header = result.fired ? "" : "🔇 *Sem sinal*\n";
    const message = `${header}${result.text}\n\n${fmtDateTime(now)}\n_Estratégia: ${strat.id}_`;

    try {
      await sendTelegramMessage(message);
      console.log(`Enviado [${strat.id}] fired=${result.fired}`);
      state.fired[key] = true;
    } catch (err) {
      console.error(`Falha ao enviar Telegram para ${strat.id}:`, err);
    }
  }

  const cutoff = Date.now() - 40 * 24 * 60 * 60 * 1000;
  for (const key of Object.keys(state.fired)) {
    const d = key.split(":")[1];
    if (d && new Date(d).getTime() < cutoff) delete state.fired[key];
  }

  await saveState(state);
}

main().catch((err) => {
  console.error("Erro na execução do bot:", err);
  process.exit(1);
});
