# Architecture

```
src/
  app/                      Next.js App Router (dashboard pages + /api/[...path] catch-all)
  components/               UI primitives, glossary tooltips, data hooks
  db/schema.ts              Drizzle schema (PostgreSQL)
  instrumentation.ts        Boots the in-process scheduler once per server process
  lib/
    config/settings.ts      Central config: description/default/min/max/validation per setting
    core/types.ts           Domain types + provider interfaces
    core/logger.ts          Structured logging → system_events; alert sink with pluggable channels
    providers/http.ts       Rate limiting, retries/backoff, 429 handling, cache, dedup, provider health
    providers/dexscreener.ts  TokenDiscoveryProvider + MarketDataProvider
    providers/rugcheck.ts     RiskAnalysisProvider
    providers/solana-rpc.ts   OnChainDataProvider (+ tx broadcast/status for live)
    providers/jupiter.ts      SwapQuoteProvider (+ swap tx builder for live)
    providers/index.ts        Registry (swap/fallback providers here)
    engine/safety.ts        TokenSafetyEngine (pure)
    engine/scoring.ts       0–100 scoring (pure)
    engine/strategy.ts      Entry classification, decision engine, market regime (pure)
    engine/risk.ts          Hard limits + position sizing + execution-quality gate (pure)
    engine/exits.ts         Exit engine (pure)
    engine/impact.ts        Pool-maths price impact estimate (pure)
    execution/paper.ts      PaperExecutionProvider
    execution/live.ts       JupiterExecutionProvider (fail-closed)
    bot/state.ts            Settings, bot state, portfolio maths, performance analytics
    bot/scanner.ts          Orchestration: discover → enrich → safety → score → decide → confirm → execute → monitor → recover
    bot/scheduler.ts        Two guarded loops (scan / monitor), graceful shutdown
    backtest/replay.ts      Look-ahead-free replay + walk-forward split
    api/router.ts           All API handlers + auth + readiness checklist
tests/                      Vitest (engines + resilience)
docs/
```

## Decision flow
```
DISCOVER (multi-feed) → MARKET DATA (batched) → PREFILTER (cheap) → DEEP CHECK (RugCheck + RPC)
 → SAFETY GATE (any CRITICAL / UNKNOWN → REJECTED) → SCORE → STRATEGY (mandatory list + entry quality)
 → CONFIRMATION (fresh data, re-run gate, price/liquidity drift, sizing, impact/slippage, dedup)
 → EXECUTION PROVIDER (paper | live) → POSITION → MONITOR (exit engine every 20s) → JOURNAL
```
Engines are pure functions; all I/O lives in providers and the scanner. That is what makes the
tests deterministic and the LLM boundary enforceable: there is simply no code path where free text
reaches `decide()` or `evaluateExit()`.

## Process model
Next.js server process hosts both the dashboard/API and the bot loops (`instrumentation.ts`).
State that must be process-wide (provider registry, rate buckets, health, scheduler flags) lives
on `globalThis` because Next bundles route handlers and instrumentation separately. Durable state
is always in PostgreSQL; on boot `recoverState()` reconciles positions and the paper ledger.

## Extending
- New chain: implement the provider interfaces for it and add a `chain` dimension to the registry.
- New alert channel: `registerAlertChannel()` in `core/logger.ts`.
- New data provider: implement the interface, register in `providers/index.ts`.
- LLM summaries: may read `decisions.explanation` and write to a separate column — never to `decision`.
