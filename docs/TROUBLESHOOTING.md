# Troubleshooting

**Scanner shows STARTING/DEGRADED** — first scan takes 1–3 min (sequential deep checks respect
RugCheck/RPC limits). Check System page → provider health and the event log.

**solana-rpc DEGRADED "rate limited (429)"** — expected on the public endpoint. Set
`SOLANA_RPC_URL`. The bot continues using RugCheck for authority data.

**No BUY decisions for hours** — normal. Most tokens fail the safety gate (unlocked LP, rugger
creators, concentration). NO TRADE is the designed default. Look at the Journal → REJECTED/WATCH
reasons before loosening settings, and prefer running an experiment on the Performance page.

**Every token REJECTED for LP lock** — v1 used `min` across pools and false-flagged tokens whose
dust secondary pool was unlocked; fixed to liquidity-weighted. If it recurs, inspect the RugCheck
report link on the token page.

**Paper cash differs from expectations** — startup reconciliation recomputes cash from the trade
ledger and logs a RECONCILIATION alert if it corrected anything.

**"scan already running"** — scans are guarded; wait for the current one.

**Dashboard controls return 401** — set the token on Settings → Dashboard Access Token.
