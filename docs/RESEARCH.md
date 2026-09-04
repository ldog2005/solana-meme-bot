# Research Notes (2026)

## Infrastructure / APIs verified during build
- **Jupiter**: all `api.jup.ag` endpoints require `x-api-key` (free tier via portal.jup.ag).
  Swap API v1 `/swap/v1/quote` + `/swap/v1/swap`; newer Ultra/`/swap/v2/order` also exist.
  Source: https://dev.jup.ag/api-reference , https://developers.jup.ag/docs/api-reference
- **RugCheck**: public REST `api.rugcheck.xyz/v1/tokens/{mint}/report[/summary]`; optional
  `X-API-KEY`; `score_normalised` 0–100 higher = riskier; `risks[]` with warn/danger; per-market
  `lp.lpLockedPct/lpLockedUSD`; `topHolders[].owner/insider`; `rugged`; `creator`.
  Observed live: PumpSwap main pool 100 % locked alongside a $8 Meteora pool at 0 % → weighted lock
  is required. Sources: https://solanacompass.com/projects/rugcheck , https://termo.ai/skills/rugcheck
- **DexScreener**: keyless; profiles/boosts 60 rpm, pairs/tokens/search 300 rpm; `tokens/v1/solana/{≤30}`.
  Sources: https://github.com/opensvm/dexscreener-mcp-server , https://solanab.github.io/dexscreen/api/query-api/
- **Solana RPC**: public mainnet-beta 429s at low volume; dedicated endpoint recommended
  (`SOLANA_RPC_URL`). `getAccountInfo(jsonParsed)` yields mint/freeze authority; token-2022 owner
  program identifies extension risk.
- **Birdeye / wallet-intelligence providers**: useful data behind paid tiers; interface reserved
  (`WalletAnalysisProvider`), not wired in v1. Social feeds intentionally excluded (manipulable).

## Market-structure observations encoded in the strategy
- Launch window (first minutes) is dominated by snipers and bundled buys → MIN_TOKEN_AGE 20 min.
- Dominant loss mode is structural (LP pull, freeze, mint, creator dump), hence Safety = 30 pts and
  hard REJECT on any critical flag; creator-with-rug-history flag from RugCheck observed live.
- Most pump.fun graduates trade on PumpSwap where LP is protocol-held (reported 100 % locked).
- Wash trading shows as volume ≫ liquidity and tiny average trade size → heuristics in safety/scoring.
- Vertical 1h moves mean-revert violently; entries after consolidation → OVEREXTENDED classification.

## Known limitations of public scanners (and ours)
- Bundle/sniper clusters are only partially visible (RugCheck insider graph); we downgrade
  confidence rather than claim detection.
- Holder counts from DexScreener are unavailable; we rely on RugCheck `totalHolders`.
- Backtests are limited to snapshots this instance recorded (selection bias) — stated on every run.
