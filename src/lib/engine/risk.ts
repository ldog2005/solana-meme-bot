import { num, type SettingsMap } from "../config/settings";
import { estimatePriceImpactPct } from "./impact";

// ---------------------------------------------------------------------------
// Hard risk limits + position sizing. Pure functions, deterministic.
// Hard limits ALWAYS override any calculated size. Nothing here consults an
// LLM or any adaptive component.
// ---------------------------------------------------------------------------

export interface PortfolioState {
  equitySol: number; // cash + market value of open positions
  cashSol: number;
  openPositions: number;
  exposureSol: number; // value of open positions
  dailyPnlSol: number; // realized + unrealized today
  weeklyPnlSol: number;
  dailyStartEquitySol: number;
  weeklyStartEquitySol: number;
}

export interface LimitCheck { ok: boolean; reason?: string }

export function dailyLossLimitHit(p: PortfolioState, s: SettingsMap): boolean {
  const base = p.dailyStartEquitySol > 0 ? p.dailyStartEquitySol : p.equitySol;
  return p.dailyPnlSol <= -(base * num(s, "MAX_DAILY_LOSS_PCT")) / 100;
}
export function weeklyLossLimitHit(p: PortfolioState, s: SettingsMap): boolean {
  const base = p.weeklyStartEquitySol > 0 ? p.weeklyStartEquitySol : p.equitySol;
  return p.weeklyPnlSol <= -(base * num(s, "MAX_WEEKLY_LOSS_PCT")) / 100;
}

/** Can the portfolio accept another entry? (position count, loss lockouts, exposure) */
export function checkPortfolioLimits(p: PortfolioState, s: SettingsMap): LimitCheck {
  if (dailyLossLimitHit(p, s)) return { ok: false, reason: `Daily loss limit reached (${num(s, "MAX_DAILY_LOSS_PCT")}% of equity). New entries disabled until next UTC day.` };
  if (weeklyLossLimitHit(p, s)) return { ok: false, reason: `Weekly loss limit reached (${num(s, "MAX_WEEKLY_LOSS_PCT")}% of equity).` };
  if (p.openPositions >= num(s, "MAX_OPEN_POSITIONS")) return { ok: false, reason: `Max open positions (${num(s, "MAX_OPEN_POSITIONS")}) reached.` };
  const maxExposure = (p.equitySol * num(s, "MAX_PORTFOLIO_EXPOSURE_PCT")) / 100;
  if (p.exposureSol >= maxExposure) return { ok: false, reason: `Portfolio exposure ${p.exposureSol.toFixed(3)} SOL at cap ${maxExposure.toFixed(3)} SOL.` };
  return { ok: true };
}

export interface SizingInput {
  portfolio: PortfolioState;
  liquidityUsd: number;
  solPriceUsd: number;
  score: number; // 0-100
  stopLossPct: number;
}

export interface SizingResult {
  sizeSol: number;
  reasons: string[];
  estimatedPriceImpactPct: number;
  capBy: string;
}

/**
 * Position sizing: risk a fixed fraction of equity per trade, scaled by
 * confidence, then apply every hard cap. The smallest cap wins.
 */
export function computePositionSize(inp: SizingInput, s: SettingsMap): SizingResult {
  const reasons: string[] = [];
  const p = inp.portfolio;
  const equity = Math.max(p.equitySol, 0);

  // 1. Risk-based size: lose at most riskPct of equity if stop is hit.
  //    riskPct scales 0.5% → 1.5% with score 70 → 95.
  const riskPct = 0.5 + Math.max(0, Math.min(1, (inp.score - 70) / 25)) * 1.0;
  const riskSol = (equity * riskPct) / 100;
  let size = riskSol / (inp.stopLossPct / 100);
  reasons.push(`Risk budget ${riskPct.toFixed(2)}% of equity (${riskSol.toFixed(4)} SOL) at ${inp.stopLossPct}% stop → ${size.toFixed(4)} SOL`);
  let capBy = "risk-budget";

  const caps: [string, number][] = [
    ["MAX_TRADE_SIZE_SOL", num(s, "MAX_TRADE_SIZE_SOL")],
    ["MAX_POSITION_PCT", (equity * num(s, "MAX_POSITION_PCT")) / 100],
    ["MAX_PORTFOLIO_EXPOSURE_PCT (remaining)", Math.max(0, (equity * num(s, "MAX_PORTFOLIO_EXPOSURE_PCT")) / 100 - p.exposureSol)],
    ["available cash", Math.max(0, p.cashSol - 0.02)],
    ["MAX_TRADE_LIQUIDITY_PCT", inp.solPriceUsd > 0 ? (inp.liquidityUsd * num(s, "MAX_TRADE_LIQUIDITY_PCT")) / 100 / inp.solPriceUsd : 0],
  ];
  for (const [name, cap] of caps) {
    if (size > cap) {
      size = cap;
      capBy = name;
      reasons.push(`Capped by ${name}: ${cap.toFixed(4)} SOL`);
    }
  }
  // 2. Price-impact cap: shrink until estimated impact fits.
  const maxImpact = num(s, "MAX_PRICE_IMPACT_PCT");
  let impact = estimatePriceImpactPct(size * inp.solPriceUsd, inp.liquidityUsd);
  let guard = 0;
  while (impact > maxImpact && size > 0.001 && guard++ < 20) {
    size *= 0.8;
    impact = estimatePriceImpactPct(size * inp.solPriceUsd, inp.liquidityUsd);
    capBy = "MAX_PRICE_IMPACT_PCT";
  }
  if (guard > 0) reasons.push(`Reduced for price impact → ${size.toFixed(4)} SOL (~${impact.toFixed(2)}% est. impact)`);
  size = Math.floor(size * 1e4) / 1e4;
  if (size < 0.01) {
    reasons.push("Resulting size below 0.01 SOL minimum — no trade");
    size = 0;
  }
  return { sizeSol: size, reasons, estimatedPriceImpactPct: impact, capBy };
}

/** Execution-quality gate. Never raise tolerance to force a fill. */
export function checkExecutionQuality(args: { slippagePct: number; priceImpactPct: number }, s: SettingsMap): LimitCheck {
  if (args.priceImpactPct > num(s, "MAX_PRICE_IMPACT_PCT")) return { ok: false, reason: `Price impact ${args.priceImpactPct.toFixed(2)}% exceeds max ${num(s, "MAX_PRICE_IMPACT_PCT")}%.` };
  if (args.slippagePct > num(s, "MAX_ACCEPTABLE_SLIPPAGE_PCT")) return { ok: false, reason: `Expected slippage ${args.slippagePct.toFixed(2)}% exceeds max ${num(s, "MAX_ACCEPTABLE_SLIPPAGE_PCT")}%.` };
  return { ok: true };
}
