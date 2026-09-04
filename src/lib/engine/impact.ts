/**
 * Constant-product estimate of price impact when no router quote exists.
 * For a pool with liquidity L (USD, both sides), a trade of size S (USD)
 * against one side of depth L/2 moves price by roughly S / (L/2 + S).
 * Conservative approximation used ONLY for gating & simulation; flagged
 * `estimated=true` wherever displayed. Pure function — no I/O.
 */
export function estimatePriceImpactPct(tradeUsd: number, liquidityUsd: number): number {
  if (!Number.isFinite(liquidityUsd) || liquidityUsd <= 0) return 100;
  const side = liquidityUsd / 2;
  return (tradeUsd / (side + tradeUsd)) * 100;
}
