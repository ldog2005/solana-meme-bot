import { num, type SettingsMap } from "../config/settings";

// ---------------------------------------------------------------------------
// Exit engine — pure. Given a position's state and the latest market data it
// returns the action to take. Evaluated in strict priority order:
//   emergency → hard stop → max hold → trailing stop → liquidity/dev warnings
//   → partial take-profits → momentum deterioration.
// ---------------------------------------------------------------------------

export interface PositionView {
  entryPrice: number;
  highestPrice: number;
  remainingTokens: number;
  initialTokens: number;
  takenLevels: number[]; // e.g. [1,2] for TP1 and TP2 already executed
  openedAt: Date;
  entryLiquidityUsd: number | null;
  trailingStopPrice: number | null;
}

export interface MarketView {
  price: number;
  liquidityUsd: number | null;
  priceChange5m: number | null;
  buys5m: number;
  sells5m: number;
  dataAgeSec: number;
  now: Date;
  newCriticalFlag?: string | null; // e.g. developer wallet warning surfaced by re-check
}

export type ExitKind =
  | "EMERGENCY_PRICE_COLLAPSE"
  | "EMERGENCY_LIQUIDITY"
  | "EMERGENCY_RISK_FLAG"
  | "HARD_STOP"
  | "MAX_HOLD_TIME"
  | "TRAILING_STOP"
  | "TAKE_PROFIT"
  | "MOMENTUM_DETERIORATION";

export interface ExitAction {
  action: "HOLD" | "SELL";
  kind?: ExitKind;
  sellFraction?: number; // of REMAINING tokens
  tpLevel?: number;
  reason?: string;
  newTrailingStop?: number | null;
  urgent?: boolean;
}

export function evaluateExit(p: PositionView, m: MarketView, s: SettingsMap): ExitAction {
  const gainPct = ((m.price - p.entryPrice) / p.entryPrice) * 100;
  const peak = Math.max(p.highestPrice, m.price);
  const peakGainPct = ((peak - p.entryPrice) / p.entryPrice) * 100;

  // Trailing stop maintenance (armed once gain ≥ TRAILING_ARM_PCT).
  let trailing = p.trailingStopPrice;
  if (peakGainPct >= num(s, "TRAILING_ARM_PCT")) {
    const candidate = peak * (1 - num(s, "TRAILING_STOP_PCT") / 100);
    if (trailing === null || candidate > trailing) trailing = candidate;
  }

  // 1. Emergencies ---------------------------------------------------------
  if (m.newCriticalFlag) return { action: "SELL", kind: "EMERGENCY_RISK_FLAG", sellFraction: 1, reason: `New critical risk flag: ${m.newCriticalFlag}`, urgent: true, newTrailingStop: trailing };
  if (m.liquidityUsd !== null && p.entryLiquidityUsd && p.entryLiquidityUsd > 0) {
    const drop = (1 - m.liquidityUsd / p.entryLiquidityUsd) * 100;
    if (drop >= num(s, "LIQUIDITY_DROP_EXIT_PCT")) return { action: "SELL", kind: "EMERGENCY_LIQUIDITY", sellFraction: 1, reason: `Liquidity fell ${drop.toFixed(0)}% since entry`, urgent: true, newTrailingStop: trailing };
  }
  if ((m.priceChange5m ?? 0) <= -num(s, "EMERGENCY_PRICE_DROP_5M_PCT")) return { action: "SELL", kind: "EMERGENCY_PRICE_COLLAPSE", sellFraction: 1, reason: `Price collapsed ${m.priceChange5m!.toFixed(0)}% in 5 minutes`, urgent: true, newTrailingStop: trailing };

  // 2. Hard stop -----------------------------------------------------------
  if (gainPct <= -num(s, "STOP_LOSS_PCT")) return { action: "SELL", kind: "HARD_STOP", sellFraction: 1, reason: `Hard stop: ${gainPct.toFixed(1)}% ≤ -${num(s, "STOP_LOSS_PCT")}%`, newTrailingStop: trailing };

  // 3. Max hold time ---------------------------------------------------------
  const heldMin = (m.now.getTime() - p.openedAt.getTime()) / 60000;
  if (heldMin >= num(s, "MAX_HOLD_TIME_MIN")) return { action: "SELL", kind: "MAX_HOLD_TIME", sellFraction: 1, reason: `Max hold time ${num(s, "MAX_HOLD_TIME_MIN")} min reached (${gainPct.toFixed(1)}%)`, newTrailingStop: trailing };

  // 4. Trailing stop -----------------------------------------------------------
  if (trailing !== null && m.price <= trailing) return { action: "SELL", kind: "TRAILING_STOP", sellFraction: 1, reason: `Trailing stop hit at ${(((trailing - p.entryPrice) / p.entryPrice) * 100).toFixed(1)}% (peak +${peakGainPct.toFixed(0)}%)`, newTrailingStop: trailing };

  // 5. Partial take-profits (based on ORIGINAL size) -----------------------------
  const levels: [number, number, number][] = [
    [1, num(s, "TP1_PCT"), num(s, "TP1_SELL_PCT")],
    [2, num(s, "TP2_PCT"), num(s, "TP2_SELL_PCT")],
    [3, num(s, "TP3_PCT"), num(s, "TP3_SELL_PCT")],
  ];
  for (const [lvl, trigger, sellPctOfInitial] of levels) {
    if (p.takenLevels.includes(lvl) || sellPctOfInitial <= 0) continue;
    if (gainPct >= trigger) {
      const tokensToSell = (p.initialTokens * sellPctOfInitial) / 100;
      const fraction = Math.min(1, tokensToSell / Math.max(p.remainingTokens, 1e-12));
      return { action: "SELL", kind: "TAKE_PROFIT", tpLevel: lvl, sellFraction: fraction, reason: `Take-profit ${lvl}: +${gainPct.toFixed(1)}% ≥ +${trigger}% → sell ${sellPctOfInitial}% of original`, newTrailingStop: trailing };
    }
  }

  // 6. Momentum deterioration while in profit ----------------------------------
  if (gainPct > 5 && m.buys5m + m.sells5m >= 10) {
    const ratio = m.sells5m / Math.max(m.buys5m, 1);
    if (ratio >= num(s, "MOMENTUM_EXIT_SELL_RATIO") && (m.priceChange5m ?? 0) < -5) {
      return { action: "SELL", kind: "MOMENTUM_DETERIORATION", sellFraction: 1, reason: `Sell pressure ${ratio.toFixed(1)}× buys with price falling; locking +${gainPct.toFixed(1)}%`, newTrailingStop: trailing };
    }
  }

  return { action: "HOLD", newTrailingStop: trailing };
}

export function describeExitPlan(s: SettingsMap): string {
  return `stop -${num(s, "STOP_LOSS_PCT")}% · +${num(s, "TP1_PCT")}% sell ${num(s, "TP1_SELL_PCT")}% · +${num(s, "TP2_PCT")}% sell ${num(s, "TP2_SELL_PCT")}% · +${num(s, "TP3_PCT")}% sell ${num(s, "TP3_SELL_PCT")}% · trailing ${num(s, "TRAILING_STOP_PCT")}% after +${num(s, "TRAILING_ARM_PCT")}% · max hold ${num(s, "MAX_HOLD_TIME_MIN")}m`;
}
