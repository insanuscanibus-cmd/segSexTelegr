# BTC Telegram Bot (GitHub Actions — 100% gratuito)

Bot que verifica o preço do BTC periodicamente e envia uma mensagem para o
Telegram comparando com a última verificação. Roda inteiramente no GitHub
Actions, sem precisar de servidor, sem "dormir" e sem custo.

## Como usar

1. **Suba esta pasta para um repositório no GitHub** (pode ser o mesmo
   `insanuscanibus-cmd/SegSex` ou um repositório novo só para isso — recomendo
   um novo, mais simples de manter).

2. **Adicione os secrets do Telegram no repositório:**
   - Vá em `Settings` → `Secrets and variables` → `Actions` → `New repository secret`
   - Crie `TELEGRAM_BOT_TOKEN` com o token gerado pelo BotFather
   - Crie `TELEGRAM_CHAT_ID` com o chat id que você já tem

3. **Pronto.** O workflow em `.github/workflows/btc-bot.yml` já está
   configurado para rodar a cada 30 minutos. Ele também pode ser disparado
   manualmente pela aba **Actions** do GitHub, clicando em "Run workflow" —
   útil para testar sem esperar o horário do cron.

## Ajustar a frequência

Edite a linha `cron` em `.github/workflows/btc-bot.yml`:

| Frequência    | Valor do cron     |
|---------------|--------------------|
| A cada 30 min | `*/30 * * * *`     |
| 1x por hora   | `0 * * * *`        |
| 1x por dia    | `0 12 * * *` (12h UTC ≈ 9h BRT) |

⚠️ O GitHub Actions **não garante** que o cron dispare no segundo exato —
em horários de pico pode atrasar alguns minutos. Isso é normal e não é bug.

## Como funciona

- `scripts/btc-bot.mjs` busca o preço do BTC na API pública da CoinGecko
  (gratuita, sem necessidade de chave de API).
- Compara com o valor salvo em `data/last-price.json` (da execução anterior).
- Envia uma mensagem formatada para o Telegram com a variação percentual.
- Salva o novo preço em `data/last-price.json` e o workflow faz commit
  automático desse arquivo, para a próxima execução ter algo para comparar.

## Testar localmente (opcional)

```bash
export TELEGRAM_BOT_TOKEN="seu_token_aqui"
export TELEGRAM_CHAT_ID="seu_chat_id_aqui"
node scripts/btc-bot.mjs
```

## Limites do plano gratuito do GitHub Actions

- Repositórios **públicos**: minutos ilimitados.
- Repositórios **privados**: 2.000 minutos/mês grátis. Esse bot roda em
  segundos por execução, então mesmo rodando a cada 30 min o consumo mensal
  fica bem abaixo do limite.
