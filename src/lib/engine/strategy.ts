import type { Candidate, Classification, Decision, MarketRegime, OpportunityScore, SafetyAssessment } from "../core/types";
import { num, type SettingsMap } from "../config/settings";
import type { PortfolioState } from "./risk";
import { checkPortfolioLimits } from "./risk";

// ---------------------------------------------------------------------------
// Strategy engine — RESEARCH BASELINE STRATEGY (strategy_v0.x)
//
// Deterministic. Produces BUY / WATCH / NO_TRADE / REJECTED with explicit
// reasons. It runs only AFTER the safety gate. It cannot un-reject a token.
// ---------------------------------------------------------------------------

export interface StrategyContext {
  settings: SettingsMap;
  regime: MarketRegime;
  portfolio: PortfolioState;
  hasOpenPosition: boolean;
  inCooldown: boolean;
  blacklisted: boolean;
  dataAgeSec: number;
  autoTradeEnabled: boolean;
  emergencyStop: boolean;
}

export interface StrategyDecision {
  decision: Decision;
  classification: Classification;
  primaryReason: string;
  reasons: string[]; // blocking or negative reasons
  positives: string[];
  mandatoryFailures: string[];
}

/** Classify where the token is in its lifecycle from price/volume structure. */
export function classify(c: Candidate, s: SettingsMap): Classification {
  const pc = c.market.priceChange;
  const p1h = pc.h1 ?? 0, p5m = pc.m5 ?? 0, p6h = pc.h6 ?? 0;
  const v5 = c.market.volume.m5 ?? 0, v1 = c.market.volume.h1 ?? 0;
  const tx5 = c.market.txns.m5;
  const sellRatio5 = tx5.buys > 0 ? tx5.sells / tx5.buys : tx5.sells > 0 ? 3 : 1;
  if (p1h > num(s, "MAX_PRICE_CHANGE_1H_PCT") || p5m > 25) return "OVEREXTENDED";
  if ((p5m < -12 && sellRatio5 > 1.5) || (p1h < -30 && v5 * 12 < v1 * 0.5) || p6h < -45) return "DETERIORATING";
  const age = c.ageMinutes ?? Infinity;
  if (age <= 180 && p1h >= -10) return "EARLY_OPPORTUNITY";
  return "DEVELOPING_OPPORTUNITY";
}

export function decide(c: Candidate, sa: SafetyAssessment, score: OpportunityScore, ctx: StrategyContext): StrategyDecision {
  const s = ctx.settings;
  const mandatory: string[] = [];
  const negatives: string[] = [];
  const positives: string[] = [];

  // ---- Absolute blockers -------------------------------------------------
  if (ctx.blacklisted) mandatory.push("Token or its developer is blacklisted.");
  if (!sa.passed) {
    const crit = sa.flags.filter((f) => f.severity === "CRITICAL");
    if (crit.length) mandatory.push(`Critical safety flag: ${crit[0].message}`);
    else if (sa.riskLevel === "UNKNOWN") mandatory.push("Critical safety data could not be verified (risk UNKNOWN).");
    else mandatory.push(`Safety gate failed: risk ${sa.riskLevel}.`);
  }
  if (mandatory.length) {
    return { decision: "REJECTED", classification: "REJECTED", primaryReason: mandatory[0], reasons: [...mandatory, ...sa.flags.filter((f) => f.severity === "HIGH").map((f) => f.message)], positives, mandatoryFailures: mandatory };
  }

  // ---- Data freshness ----------------------------------------------------
  if (ctx.dataAgeSec > num(s, "MAX_DATA_AGE_SEC")) mandatory.push(`Market data is stale (${Math.round(ctx.dataAgeSec)}s old).`);
  if (c.market.priceNative === null || c.market.priceNative <= 0) mandatory.push("No valid price available.");

  // ---- Liquidity / activity minimums ------------------------------------
  const L = c.market.liquidityUsd ?? 0;
  const v1 = c.market.volume.h1 ?? 0;
  const tx1 = c.market.txns.h1.buys + c.market.txns.h1.sells;
  if (L < num(s, "MIN_LIQUIDITY_USD")) mandatory.push(`Liquidity $${Math.round(L).toLocaleString()} below minimum.`);
  else positives.push(`Liquidity $${Math.round(L).toLocaleString()} meets minimum`);
  if (v1 < num(s, "MIN_VOLUME_1H_USD")) mandatory.push(`1h volume $${Math.round(v1).toLocaleString()} below minimum $${num(s, "MIN_VOLUME_1H_USD").toLocaleString()}.`);
  else positives.push(`1h volume $${Math.round(v1).toLocaleString()} adequate`);
  if (tx1 < num(s, "MIN_TXNS_1H")) mandatory.push(`Only ${tx1} trades in the last hour (min ${num(s, "MIN_TXNS_1H")}).`);

  // ---- Age window --------------------------------------------------------
  if (c.ageMinutes === null) negatives.push("Launch time unknown.");
  else if (c.ageMinutes < num(s, "MIN_TOKEN_AGE_MIN")) mandatory.push(`Token is ${Math.round(c.ageMinutes)} min old — below minimum age (sniper/bundle window).`);
  else if (c.ageMinutes > num(s, "MAX_TOKEN_AGE_MIN")) mandatory.push(`Token is ${(c.ageMinutes / 60).toFixed(1)}h old — outside the fresh-market window.`);

  // ---- Holder / developer gates (post-safety, stricter thresholds) --------
  if (sa.top10Pct !== null && sa.top10Pct > num(s, "MAX_TOP10_HOLDER_PCT")) mandatory.push(`Top-10 concentration ${sa.top10Pct.toFixed(1)}% too high.`);
  else if (sa.top10Pct !== null) positives.push(`Top-10 holders ${sa.top10Pct.toFixed(1)}% acceptable`);
  if (sa.creatorPct !== null && sa.creatorPct > num(s, "MAX_CREATOR_PCT")) mandatory.push(`Developer holds ${sa.creatorPct.toFixed(1)}%.`);
  if (sa.lpLockedPct !== null && sa.lpLockedPct < num(s, "MIN_LP_LOCKED_PCT")) mandatory.push(`Only ${sa.lpLockedPct.toFixed(0)}% LP locked.`);
  else if (sa.lpLockedPct !== null) positives.push(`${sa.lpLockedPct.toFixed(0)}% of liquidity locked/burned`);

  // ---- Market regime -------------------------------------------------------
  let minScore = num(s, "MIN_SCORE");
  if (ctx.regime === "EXTREMELY_RISKY") mandatory.push("Market regime EXTREMELY RISKY — entries suspended.");
  else if (ctx.regime === "WEAK") { minScore += 8; negatives.push(`Market regime WEAK — minimum score raised to ${minScore}.`); }
  else if (ctx.regime === "HOT") positives.push("Market regime HOT");

  // ---- Entry quality -------------------------------------------------------
  const cls = classify(c, s);
  if (cls === "OVEREXTENDED") negatives.push("Price is vertically extended — waiting for consolidation/retest.");
  if (cls === "DETERIORATING") negatives.push("Structure deteriorating (sell pressure / fading volume).");
  const ratio1h = c.market.txns.h1.sells > 0 ? c.market.txns.h1.buys / c.market.txns.h1.sells : 2;
  if (ratio1h < num(s, "MIN_BUY_SELL_RATIO")) negatives.push(`Buy/sell ratio ${ratio1h.toFixed(2)} below ${num(s, "MIN_BUY_SELL_RATIO")}.`);
  else positives.push(`Buy pressure present (ratio ${ratio1h.toFixed(2)})`);
  const v5pace = (c.market.volume.m5 ?? 0) * 12;
  if (v5pace < v1 * 0.5) negatives.push("Volume fading over the last 5 minutes.");
  else positives.push("Volume holding or improving");
  if ((c.market.priceChange.m5 ?? 0) > 12) negatives.push(`Price +${(c.market.priceChange.m5 ?? 0).toFixed(0)}% in 5m — entry would chase.`);
  if (score.overall < minScore) negatives.push(`Score ${score.overall} below minimum ${minScore}.`);
  else positives.push(`Score ${score.overall}/100 ≥ ${minScore}`);

  // ---- Portfolio / operational -------------------------------------------
  if (ctx.hasOpenPosition) mandatory.push("Already holding this token.");
  if (ctx.inCooldown) mandatory.push("Token in re-entry cooldown.");
  if (ctx.emergencyStop) mandatory.push("EMERGENCY STOP active — no new entries.");
  const pl = checkPortfolioLimits(ctx.portfolio, s);
  if (!pl.ok) mandatory.push(pl.reason!);

  // ---- Final deterministic decision ---------------------------------------
  if (mandatory.length) {
    return { decision: "NO_TRADE", classification: cls, primaryReason: mandatory[0], reasons: [...mandatory, ...negatives], positives, mandatoryFailures: mandatory };
  }
  if (negatives.length) {
    // Everything mandatory passes but entry quality does not → WATCH.
    return { decision: "WATCH", classification: cls, primaryReason: negatives[0], reasons: negatives, positives, mandatoryFailures: [] };
  }
  if (!ctx.autoTradeEnabled) {
    return { decision: "WATCH", classification: cls, primaryReason: "Entry conditions met but automated entries are disabled in settings.", reasons: ["AUTO_TRADE_ENABLED = false"], positives, mandatoryFailures: [] };
  }
  return { decision: "BUY", classification: cls, primaryReason: "All mandatory gates and entry conditions passed.", reasons: [], positives, mandatoryFailures: [] };
}

/** Human-readable explanation block used by journal + dashboard. */
export function explain(d: StrategyDecision, score: OpportunityScore, sa: SafetyAssessment, extra?: { sizeSol?: number; stopPrice?: number; exitPlan?: string; risks?: string[] }): string {
  const lines: string[] = [];
  lines.push(`${d.decision.replace("_", " ")} DECISION`);
  lines.push(`Score: ${score.overall}/100 · Risk: ${sa.riskLevel} · Classification: ${d.classification.replace(/_/g, " ")}`);
  lines.push("");
  if (d.decision === "BUY") {
    lines.push("Why:");
    d.positives.forEach((p) => lines.push(`• ${p}`));
    if (extra?.risks?.length) { lines.push(""); lines.push("Risks:"); extra.risks.forEach((r) => lines.push(`• ${r}`)); }
    if (extra?.sizeSol !== undefined) { lines.push(""); lines.push(`Position: ${extra.sizeSol.toFixed(4)} SOL (PAPER)`); }
    if (extra?.stopPrice !== undefined) lines.push(`Invalidation: hard stop at ${extra.stopPrice.toExponential(4)} SOL`);
    if (extra?.exitPlan) lines.push(`Exit plan: ${extra.exitPlan}`);
  } else {
    lines.push(`Primary reason: ${d.primaryReason}`);
    if (d.reasons.length > 1) { lines.push(""); lines.push("Secondary reasons:"); d.reasons.slice(1, 6).forEach((r) => lines.push(`• ${r}`)); }
    if (d.positives.length) { lines.push(""); lines.push("Positives:"); d.positives.slice(0, 5).forEach((p) => lines.push(`• ${p}`)); }
    if (d.decision === "WATCH") { lines.push(""); lines.push("Next condition: re-evaluated each scan; becomes eligible when the reasons above clear while mandatory gates still hold."); }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Market regime
// ---------------------------------------------------------------------------
export function computeRegime(inp: { solChange24h: number | null; solChange1h: number | null; aggregateVolume1h: number; candidateCount: number; medianBuySellRatio: number | null }): { regime: MarketRegime; detail: Record<string, unknown> } {
  if (inp.solChange24h === null) return { regime: "UNKNOWN", detail: { reason: "SOL price data unavailable" } };
  let points = 0;
  if (inp.solChange24h > 3) points += 1;
  if (inp.solChange24h < -5) points -= 1;
  if (inp.solChange24h < -10) points -= 1;
  if ((inp.solChange1h ?? 0) < -3) points -= 1;
  if (inp.aggregateVolume1h > 5_000_000) points += 1;
  if (inp.aggregateVolume1h < 500_000) points -= 1;
  if (inp.candidateCount > 40) points += 1;
  if (inp.candidateCount < 8) points -= 1;
  if (inp.medianBuySellRatio !== null) {
    if (inp.medianBuySellRatio > 1.1) points += 1;
    if (inp.medianBuySellRatio < 0.9) points -= 1;
  }
  const regime: MarketRegime = points >= 2 ? "HOT" : points <= -3 ? "EXTREMELY_RISKY" : points <= -1 ? "WEAK" : "NORMAL";
  return { regime, detail: { ...inp, points } };
}
