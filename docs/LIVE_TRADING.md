# Live Trading (DISABLED BY DEFAULT)

Status of this build: the live path (Jupiter quote → swap tx → Ed25519 signing via Node crypto →
RPC broadcast → confirmation polling → reconciliation) is implemented and unit-tested for its
gating, but **has not been exercised with real funds**. Treat it as untested until you have run it
with dust amounts yourself.

Required, all at once:
1. `LIVE_TRADING_ENABLED=true` in the server environment (restart required).
2. `ADMIN_TOKEN` set; `JUPITER_API_KEY` set; `SOLANA_RPC_URL` set to a dedicated endpoint.
3. `TRADING_WALLET_SECRET` = key of a **dedicated wallet holding only what you can afford to lose**.
   Never paste it anywhere except the server environment / secret manager.
4. Every readiness check passing (System & Readiness page).
5. Settings → "Enable LIVE trading…" and typing `I UNDERSTAND THIS USES REAL FUNDS`.

Even then every order re-validates all flags, uses the router's real price impact, refuses if
slippage/impact exceed hard limits, times out after 45 s and raises a CRITICAL alert if a
transaction is unconfirmed so you can reconcile. Emergency Stop and Disable Live are always one
click away. Start with MAX_TRADE_SIZE_SOL at dust levels.
