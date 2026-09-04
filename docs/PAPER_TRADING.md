# Paper Trading

Every fill is labelled PAPER. The simulator models: pool price impact (constant product), random
adverse slippage scaled by 5-minute volatility, latency (avg 1.5 s) with price drift, a fixed
network+priority fee, a 4 % base failure rate rising with impact, and partial fills for sells
> 3 % of pool. If the modelled adverse move exceeds the slippage+impact limit the order FAILS —
the simulator never widens tolerance to fill.

Read results on Performance. The page shows sample size and prints INSUFFICIENT DATA below 30
closed trades. Judge expectancy, profit factor, drawdown and consistency across strategy versions.
Aim for 100+ trades before considering any change of mode; do not manufacture trades.
