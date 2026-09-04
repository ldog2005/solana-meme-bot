# Risk Model

## Risk levels
LOW · MODERATE · HIGH · CRITICAL · UNKNOWN. We never say "safe". UNKNOWN fails the gate.

## Critical flags (immediate REJECT, score capped at 30)
Mint authority active · freeze authority active · provider reports rugged · transfer fee > 5 % ·
LP locked < 40 % · largest non-pool wallet > 25 % · top-10 > 60 % · insiders > 25 % ·
creator > 20 % · liquidity unknown · liquidity < ⅓ minimum · many buys and zero sells (honeypot
pattern) · RugCheck `danger` risks matching freeze/mint/honeypot/rug/copycat/fee/delegate.

## High/medium flags (reduce score; two HIGH → gate fails)
Authority unverifiable · providers disagree (assume worst) · LP lock unknown/low · concentration
above settings · insiders > 10 % · thin liquidity vs mcap · few sells · volume ≫ liquidity
(wash) · dust trades · few holders · Token-2022 · risk provider unavailable.

## Hard limits (deterministic, never overridable)
MAX_TRADE_SIZE_SOL 0.25 · MAX_PORTFOLIO_EXPOSURE 40 % · MAX_OPEN_POSITIONS 4 · MAX_POSITION 10 % ·
MAX_DAILY_LOSS 5 % (entries disabled until next UTC day) · MAX_WEEKLY_LOSS 12 % ·
MAX_SLIPPAGE 3 % · MAX_PRICE_IMPACT 2 % · MAX_HOLD 240 min · trade ≤ 1 % of pool liquidity.

## Position sizing
size = (equity × riskPct) / stopDistance, riskPct 0.5–1.5 % scaled by score 70→95; then the
smallest of every hard cap; then shrink until estimated impact ≤ MAX_PRICE_IMPACT; < 0.01 SOL → no
trade. Emergency sells may use up to 2× slippage (cap 15 %) and 3× impact (cap 20 %) — never more.

## Data quality
Stale (> 90 s), missing price, missing liquidity, or provider failure → no entry. Position monitor
raises an alert after 10 min without a price.
