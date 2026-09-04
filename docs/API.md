# API

All routes under `/api/`. GET routes are open; POST routes require header `x-admin-token` when
`ADMIN_TOKEN` is set. JSON in/out.

| Method | Path | Purpose |
|---|---|---|
| GET | /health | DB liveness |
| GET | /status | Mode, scheduler, scanner, providers, portfolio, regime |
| GET | /tokens?limit= | Recently seen tokens |
| GET | /tokens/:mint | Token, snapshots, risk assessments, decisions, positions |
| POST | /tokens/:mint/analyse | Re-run full analysis now (never executes) |
| GET | /opportunities | Scored tokens from last 3h |
| GET | /positions?status=OPEN|CLOSED|ALL | Positions |
| POST | /positions/:id/close {fraction?} | Manual (partial) close — logged as MANUAL |
| GET | /trades · /decisions · /events?level= · /alerts | Journals |
| GET | /performance?mode=PAPER | Analytics with sample-size guard |
| GET | /risk | Portfolio state + hard limits |
| GET/POST | /settings | Validated settings; strategy version auto-bumps |
| POST | /paper/start · /paper/stop · /paper/reset | Resume / pause / reset balance |
| POST | /bot/start · /bot/tick | Start scheduler / run one scan+monitor cycle |
| POST | /emergency-stop · /emergency-stop-clear | Halt new entries |
| POST | /sell-all {confirm:"SELL ALL"} | Close everything (urgent tolerances) |
| POST | /blacklist {address,kind,reason} · /blacklist-remove · /whitelist | Lists |
| POST | /live/enable {confirm:"I UNDERSTAND THIS USES REAL FUNDS"} · /live/disable | Gated |
| POST | /backtest {name,sinceHours,overrides,inSampleFraction} · GET /backtests | Replay |
| GET | /readiness | Live-trading checklist |
| POST | /recover | Run reconciliation |
