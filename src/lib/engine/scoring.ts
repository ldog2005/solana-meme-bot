import type { Candidate, MarketRegime, OpportunityScore, SafetyAssessment, ScoreComponent } from "../core/types";
import { num, type SettingsMap } from "../config/settings";

// ---------------------------------------------------------------------------
// Transparent 0-100 opportunity score.
//
// Weights (research baseline, see docs/TRADING_STRATEGY.md for rationale):
//   Safety 30 · Liquidity 15 · Holders 10 · Market structure 15 · Momentum 10
//   Volume quality 10 · Participant behaviour 5 · Market context 5
//
// Safety carries the most weight because in meme-coin markets the dominant
// loss mode is total loss (rug / freeze / mint), not adverse price movement.
// Liquidity and structure come next because they determine whether the
// exit rules can actually be executed. Momentum is deliberately small: it is
// the easiest signal to manufacture and the one most likely to be chased late.
// Every component returns human-readable reasons for the dashboard.
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const lerp = (v: number, from: [number, number], to: [number, number]) => {
  if (v <= from[0]) return to[0];
  if (v >= from[1]) return to[1];
  return to[0] + ((v - from[0]) / (from[1] - from[0])) * (to[1] - to[0]);
};

function liquidityScore(c: Candidate, s: SettingsMap): ScoreComponent {
  const reasons: string[] = [];
  const L = c.market.liquidityUsd ?? 0;
  const minL = num(s, "MIN_LIQUIDITY_USD");
  let pts = lerp(L, [minL, minL * 8], [4, 12]);
  reasons.push(`Liquidity $${Math.round(L).toLocaleString()} (${(L / minL).toFixed(1)}× minimum)`);
  const mc = c.market.marketCap ?? c.market.fdv ?? 0;
  if (mc > 0) {
    const ratio = L / mc;
    if (ratio >= 0.1) { pts += 3; reasons.push(`Liquidity/market-cap ratio ${(ratio * 100).toFixed(0)}% is healthy`); }
    else if (ratio >= 0.05) { pts += 1.5; reasons.push(`Liquidity/market-cap ratio ${(ratio * 100).toFixed(0)}% acceptable`); }
    else reasons.push(`Liquidity is thin relative to market cap (${(ratio * 100).toFixed(1)}%)`);
  }
  return { key: "liquidity", label: "Liquidity", points: clamp(Math.round(pts * 10) / 10, 0, 15), max: 15, reasons };
}

function holderScore(sa: SafetyAssessment, c: Candidate): ScoreComponent {
  const reasons: string[] = [];
  let pts = 0;
  if (sa.top10Pct === null) reasons.push("Holder distribution unknown");
  else {
    pts += lerp(sa.top10Pct, [15, 35], [6, 1]);
    reasons.push(`Top-10 wallets hold ${sa.top10Pct.toFixed(1)}%`);
  }
  if (sa.topHolderPct !== null) {
    pts += lerp(sa.topHolderPct, [2, 10], [2, 0]);
    reasons.push(`Largest wallet ${sa.topHolderPct.toFixed(1)}%`);
  }
  const th = c.risk?.totalHolders ?? null;
  if (th !== null) {
    pts += lerp(th, [100, 1500], [0, 2]);
    reasons.push(`${th.toLocaleString()} holders`);
  }
  return { key: "holders", label: "Holder Distribution", points: clamp(Math.round(pts * 10) / 10, 0, 10), max: 10, reasons };
}

function structureScore(c: Candidate): ScoreComponent {
  const reasons: string[] = [];
  const pc = c.market.priceChange;
  let pts = 0;
  const p1h = pc.h1 ?? 0, p6h = pc.h6 ?? 0, p5m = pc.m5 ?? 0;
  // Prefer constructive trends: positive over 6h, not vertical in 1h, not collapsing in 5m.
  if (p6h > 0 && p1h > -10) { pts += 5; reasons.push(`Uptrend over 6h (+${p6h.toFixed(0)}%) without a 1h breakdown`); }
  else if (p6h > -15) { pts += 2.5; reasons.push("Sideways / consolidating structure"); }
  else reasons.push(`Downtrend over 6h (${p6h.toFixed(0)}%)`);
  if (p1h >= 0 && p1h <= 60) { pts += 5; reasons.push(`1h move +${p1h.toFixed(0)}% is constructive, not vertical`); }
  else if (p1h > 60 && p1h <= 120) { pts += 2; reasons.push(`1h move +${p1h.toFixed(0)}% is getting extended`); }
  else if (p1h > 120) reasons.push(`1h move +${p1h.toFixed(0)}% — vertical / exhaustion risk`);
  else if (p1h > -20) { pts += 3; reasons.push(`Shallow 1h pullback (${p1h.toFixed(0)}%)`); }
  else reasons.push(`Sharp 1h drop (${p1h.toFixed(0)}%)`);
  if (Math.abs(p5m) < 8) { pts += 3; reasons.push("Price stable over last 5m (no chase)"); }
  else if (p5m > 0) { pts += 1; reasons.push(`5m spike +${p5m.toFixed(0)}% — entry would be chasing`); }
  else reasons.push(`5m drop ${p5m.toFixed(0)}%`);
  const mc = c.market.marketCap ?? 0;
  if (mc >= 300_000 && mc <= 20_000_000) { pts += 2; reasons.push(`Market cap $${(mc / 1e6).toFixed(2)}M in target range`); }
  else if (mc > 0) reasons.push(`Market cap $${(mc / 1e6).toFixed(2)}M outside preferred $0.3M–$20M range`);
  return { key: "structure", label: "Market Structure", points: clamp(Math.round(pts * 10) / 10, 0, 15), max: 15, reasons };
}

function momentumScore(c: Candidate, s: SettingsMap): ScoreComponent {
  const reasons: string[] = [];
  const v = c.market.volume;
  const tx = c.market.txns;
  let pts = 0;
  // Volume acceleration: 5m volume annualised vs 1h average.
  const v5 = v.m5 ?? 0, v1 = v.h1 ?? 0, v6 = v.h6 ?? 0;
  const accel1 = v1 > 0 ? (v5 * 12) / v1 : 0;
  const accel6 = v6 > 0 ? (v1 * 6) / v6 : 0;
  if (accel1 >= 1.2 && accel1 <= 4) { pts += 3; reasons.push(`Volume accelerating (5m pace ${accel1.toFixed(1)}× the 1h rate)`); }
  else if (accel1 > 4) { pts += 1; reasons.push(`Volume spike ${accel1.toFixed(1)}× — possibly climactic`); }
  else if (accel1 >= 0.6) { pts += 2; reasons.push("Volume steady"); }
  else reasons.push("Volume fading in last 5m");
  if (accel6 >= 1.1) { pts += 2; reasons.push(`1h volume above 6h average (${accel6.toFixed(1)}×)`); }
  else if (accel6 >= 0.7) pts += 1;
  else reasons.push("1h volume below 6h average");
  const ratio1h = tx.h1.sells > 0 ? tx.h1.buys / tx.h1.sells : tx.h1.buys > 0 ? 3 : 1;
  const ratio5m = tx.m5.sells > 0 ? tx.m5.buys / tx.m5.sells : tx.m5.buys > 0 ? 3 : 1;
  const minRatio = num(s, "MIN_BUY_SELL_RATIO");
  if (ratio1h >= minRatio && ratio1h <= 2.5) { pts += 3; reasons.push(`Healthy buy/sell ratio 1h ${ratio1h.toFixed(2)}`); }
  else if (ratio1h > 2.5) { pts += 1.5; reasons.push(`Buy/sell ratio ${ratio1h.toFixed(2)} unusually one-sided`); }
  else reasons.push(`Buy pressure weak (1h ratio ${ratio1h.toFixed(2)})`);
  if (ratio5m >= 1) { pts += 2; reasons.push(`Buyers in control over last 5m (${ratio5m.toFixed(2)})`); }
  else reasons.push(`Sellers in control over last 5m (${ratio5m.toFixed(2)})`);
  const extended = (c.market.priceChange.h1 ?? 0) > num(s, "MAX_PRICE_CHANGE_1H_PCT");
  if (extended) { pts = Math.min(pts, 4); reasons.push("Momentum capped: price already overextended"); }
  return { key: "momentum", label: "Momentum", points: clamp(Math.round(pts * 10) / 10, 0, 10), max: 10, reasons };
}

function volumeQualityScore(c: Candidate, s: SettingsMap): ScoreComponent {
  const reasons: string[] = [];
  const v1 = c.market.volume.h1 ?? 0;
  const tx1 = c.market.txns.h1.buys + c.market.txns.h1.sells;
  const L = c.market.liquidityUsd ?? 0;
  let pts = 0;
  const minV = num(s, "MIN_VOLUME_1H_USD");
  pts += lerp(v1, [minV, minV * 10], [2, 4]);
  reasons.push(`1h volume $${Math.round(v1).toLocaleString()}`);
  const avg = tx1 > 0 ? v1 / tx1 : 0;
  if (avg >= 40 && avg <= 2500) { pts += 3; reasons.push(`Average trade $${avg.toFixed(0)} looks organic`); }
  else if (avg > 2500) { pts += 1; reasons.push(`Average trade $${avg.toFixed(0)} — few large actors`); }
  else reasons.push(`Average trade $${avg.toFixed(0)} — dust/bot-like`);
  const turnover = L > 0 ? v1 / L : 0;
  if (turnover >= 0.3 && turnover <= 6) { pts += 3; reasons.push(`1h turnover ${turnover.toFixed(1)}× liquidity — active but not washed`); }
  else if (turnover > 6) { pts += 0.5; reasons.push(`1h turnover ${turnover.toFixed(1)}× liquidity — wash-trading risk`); }
  else reasons.push(`Low turnover (${turnover.toFixed(2)}× liquidity)`);
  return { key: "volume", label: "Volume Quality", points: clamp(Math.round(pts * 10) / 10, 0, 10), max: 10, reasons };
}

function participantScore(c: Candidate, sa: SafetyAssessment): ScoreComponent {
  const reasons: string[] = [];
  let pts = 2.5; // neutral baseline — no reliable free smart-money feed identified (see RESEARCH.md)
  const insiders = (c.risk?.topHolders ?? []).filter((h) => h.insider).length;
  if (insiders === 0 && c.risk?.topHolders) { pts += 1.5; reasons.push("No insider-flagged wallets among top holders"); }
  else if (insiders > 0) { pts -= 1.5; reasons.push(`${insiders} insider-flagged wallets among top holders`); }
  const tx = c.market.txns.h1;
  if (tx.buys >= 100 && tx.sells >= 40) { pts += 1; reasons.push("Two-sided participation (many buyers and sellers)"); }
  if (sa.flags.some((f) => f.code === "DUST_TRADES" || f.code === "VOLUME_LIQUIDITY_ANOMALY")) { pts -= 1; reasons.push("Manipulation heuristics triggered — confidence reduced"); }
  if (!reasons.length) reasons.push("Wallet-behaviour data limited; neutral score");
  return { key: "participants", label: "Wallet Behaviour", points: clamp(Math.round(pts * 10) / 10, 0, 5), max: 5, reasons };
}

function contextScore(regime: MarketRegime): ScoreComponent {
  const map: Record<MarketRegime, [number, string]> = {
    HOT: [5, "Meme-coin market regime HOT: broad participation"],
    NORMAL: [3.5, "Market regime NORMAL"],
    WEAK: [1.5, "Market regime WEAK: reduced follow-through expected"],
    EXTREMELY_RISKY: [0, "Market regime EXTREMELY RISKY: entries strongly discouraged"],
    UNKNOWN: [2, "Market regime unknown (SOL data unavailable)"],
  };
  const [pts, reason] = map[regime];
  return { key: "context", label: "Market Context", points: pts, max: 5, reasons: [reason] };
}

export function scoreOpportunity(c: Candidate, sa: SafetyAssessment, regime: MarketRegime, s: SettingsMap): OpportunityScore {
  const safety: ScoreComponent = {
    key: "safety",
    label: "Safety",
    points: sa.safetyScore,
    max: 30,
    reasons: sa.flags.length ? sa.flags.slice(0, 6).map((f) => `[${f.severity}] ${f.message}`) : ["No risk flags raised by available checks"],
  };
  const components = [safety, liquidityScore(c, s), holderScore(sa, c), structureScore(c), momentumScore(c, s), volumeQualityScore(c, s), participantScore(c, sa), contextScore(regime)];
  let overall = components.reduce((a, x) => a + x.points, 0);
  // A CRITICAL safety result caps the overall score so it can never look attractive.
  if (sa.riskLevel === "CRITICAL") overall = Math.min(overall, 30);
  if (sa.riskLevel === "UNKNOWN") overall = Math.min(overall, 55);
  return { overall: Math.round(overall * 10) / 10, components };
}
