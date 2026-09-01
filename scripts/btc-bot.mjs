// btc-bot.mjs
// Busca o preço atual do BTC, compara com o preço salvo da última execução
// e envia uma mensagem para o Telegram com a variação.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const DATA_FILE = path.join(process.cwd(), "data", "last-price.json");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("Faltam variáveis de ambiente: TELEGRAM_BOT_TOKEN e/ou TELEGRAM_CHAT_ID");
  process.exit(1);
}

async function getBtcPrice() {
  // CoinGecko: API pública, gratuita, sem necessidade de chave.
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,brl";
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Falha ao buscar preço do BTC: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  return {
    usd: json.bitcoin.usd,
    brl: json.bitcoin.brl,
  };
}

async function readLastPrice() {
  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null; // primeira execução, ainda não existe histórico
  }
}

async function saveLastPrice(price) {
  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  await writeFile(
    DATA_FILE,
    JSON.stringify({ ...price, updatedAt: new Date().toISOString() }, null, 2)
  );
}

function formatUsd(value) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function formatBrl(value) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function buildMessage(current, previous) {
  const usdLine = `💵 USD: ${formatUsd(current.usd)}`;
  const brlLine = `🇧🇷 BRL: ${formatBrl(current.brl)}`;

  if (!previous) {
    return [
      "📊 *Monitor BTC iniciado*",
      usdLine,
      brlLine,
    ].join("\n");
  }

  const diffUsd = current.usd - previous.usd;
  const pctUsd = (diffUsd / previous.usd) * 100;
  const arrow = diffUsd > 0 ? "🟢⬆️" : diffUsd < 0 ? "🔴⬇️" : "⚪️➡️";

  return [
    `${arrow} *BTC ${pctUsd >= 0 ? "+" : ""}${pctUsd.toFixed(2)}%*`,
    usdLine,
    brlLine,
    `_Anterior: ${formatUsd(previous.usd)}_`,
  ].join("\n");
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Falha ao enviar mensagem no Telegram: ${res.status} ${body}`);
  }
}

async function main() {
  const current = await getBtcPrice();
  const previous = await readLastPrice();

  const message = buildMessage(current, previous);
  await sendTelegramMessage(message);
  await saveLastPrice(current);

  console.log("Mensagem enviada com sucesso:");
  console.log(message);
}

main().catch((err) => {
  console.error("Erro na execução do bot:", err);
  process.exit(1);
});
