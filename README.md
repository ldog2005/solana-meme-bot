# Solana Meme-Coin Discovery, Analysis & Paper-Trading Platform

An autonomous scanner that discovers actively trading Solana meme coins, runs every one through a
deterministic **safety gate**, scores survivors with a transparent 0–100 model, applies an explicit
entry strategy, and **paper-trades** the few that pass — logging every decision (including every
NO-TRADE) so the strategy can be measured honestly.

> **Mode: PAPER by default. Live trading is DISABLED and requires several independent manual steps.**
> Nothing in this system is financial advice or a guarantee. Scores describe conformity with the
> current rule set, not future returns.

## What it does (v1, Solana only)
| Stage | Component | Notes |
|---|---|---|
| Discover | `providers/dexscreener.ts` | Profiles, boosts and 4 search feeds (pump.fun graduates, Raydium, Meteora, PumpSwap) — not just "trending". |
| Market data | DexScreener (free, keyless) | Batched 30 mints/request, cached, rate-limited. |
| Safety | `engine/safety.ts` + RugCheck + Solana RPC | Mint/freeze authority (cross-checked), LP lock (liquidity-weighted), holder concentration (pool vaults excluded), creator holdings, honeypot/no-sell pattern, wash-trading heuristics, transfer fees, Token-2022. |
| Score | `engine/scoring.ts` | Safety 30 · Liquidity 15 · Holders 10 · Structure 15 · Momentum 10 · Volume quality 10 · Participants 5 · Context 5 — each with reasons. |
| Decide | `engine/strategy.ts` | BUY / WATCH / NO_TRADE / REJECTED with mandatory-gate list, classification (EARLY / DEVELOPING / OVEREXTENDED / DETERIORATING). |
| Size & limit | `engine/risk.ts` | Risk-budget sizing, then **hard caps always win**; daily/weekly loss lockouts; slippage & impact gates. |
| Execute | `execution/paper.ts` / `execution/live.ts` | Paper: impact, slippage, latency drift, fees, failures, partial fills. Live: fail-closed Jupiter provider. |
| Exit | `engine/exits.ts` | Emergency (liquidity / price collapse / new critical flag) → hard stop → max hold → trailing → partial TPs → momentum exit. |
| Journal | `decisions`, `trades`, `positions` tables | Every decision explained; MFE/MAE, slippage, fees, strategy version. |
| Backtest | `backtest/replay.ts` | Replays recorded snapshots without look-ahead; walk-forward split; limitations always shown. |
| Dashboard | Next.js App Router | Status, portfolio, candidates, positions, decisions, token detail, journal, performance, settings, readiness. |

## Quick start
```bash
npm install
cp .env.example .env            # set DATABASE_URL (Postgres). Everything else optional.
npx drizzle-kit push            # create tables
npm run build && npm start      # bot starts automatically in PAPER mode
npm test                        # 41 unit/resilience tests
```
Open http://localhost:3000. See `docs/SETUP.md` for provider keys and `docs/PAPER_TRADING.md` for
how to read the results.

## Documentation
`docs/ARCHITECTURE.md` · `docs/SETUP.md` · `docs/TRADING_STRATEGY.md` · `docs/RISK_MODEL.md` · `docs/API.md` ·
`docs/TROUBLESHOOTING.md` · `docs/SECURITY.md` · `docs/PAPER_TRADING.md` · `docs/LIVE_TRADING.md` · `docs/RESEARCH.md`

## Completion status (honest)
- [x] Real data providers connected (DexScreener, RugCheck, Solana RPC; Jupiter with key)
- [x] Tokens discovered, safety-analysed, scored, decisions journaled — verified against live data
- [x] Paper execution, position monitoring, exits, P&L, analytics, restart recovery
- [x] Hard risk limits enforced in deterministic code; emergency stop; sell-all; blacklist
- [x] Automated tests (41) incl. provider outage / malformed data / live fail-closed
- [x] Live execution architecture built and gated — **signing/broadcast path not exercised with real funds**
- [ ] 100+ paper trades accumulated (requires the bot to run for days; not manufactured)
