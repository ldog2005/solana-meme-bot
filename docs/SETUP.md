# Setup

1. **Install**: Node 20+, PostgreSQL 14+. `npm install`.
2. **Environment**: copy `.env.example` → `.env`. Only `DATABASE_URL` is required.
3. **RPC** (recommended): create a free Helius/QuickNode endpoint and set `SOLANA_RPC_URL`. The
   public endpoint returns 429 quickly; the bot tolerates that but on-chain verification is then
   sourced from RugCheck only, which the safety engine treats as slightly less certain.
4. **Market data**: DexScreener needs no key.
5. **Jupiter**: get a free key at portal.jup.ag → `JUPITER_API_KEY`. Without it, price impact is
   *estimated* from pool maths (clearly labelled) and live execution is impossible.
6. **Database**: `npx drizzle-kit push`.
7. **Run**: `npm run build && npm start` (or `npm run dev`). The bot auto-starts in PAPER mode.
8. **Dashboard**: http://localhost:3000 → System & Readiness shows provider health.
9. **Protect it**: set `ADMIN_TOKEN` and enter it on the Settings page before exposing the port.

## Deployment (VPS)
```
git clone … && cd app && npm ci && cp .env.example .env && $EDITOR .env
npx drizzle-kit push && npm run build
# systemd unit or pm2:
pm2 start "npm start" --name memebot --time
```
Graceful shutdown on SIGTERM/SIGINT; open positions persist and are reconciled on restart.
Put the dashboard behind a reverse proxy with TLS and IP allow-listing; it is single-user.
