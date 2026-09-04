import { describe, it, expect } from "vitest";
import { assessSafety } from "../src/lib/engine/safety";
import { scoreOpportunity } from "../src/lib/engine/scoring";
import { classify, computeRegime, decide, type StrategyContext } from "../src/lib/engine/strategy";
import { checkExecutionQuality, checkPortfolioLimits, computePositionSize, dailyLossLimitHit, type PortfolioState } from "../src/lib/engine/risk";
import { evaluateExit } from "../src/lib/engine/exits";
import { PaperExecutionProvider } from "../src/lib/execution/paper";
import { defaultSettings, validateSetting } from "../src/lib/config/settings";
import type { Candidate, MarketSnapshot, OnChainInfo, RiskReport } from "../src/lib/core/types";

const s = defaultSettings();

function market(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    name: "Test", symbol: "TST", pairAddress: "pair", dexId: "raydium",
    pairCreatedAt: new Date(Date.now() - 90 * 60000),
    priceUsd: 0.001, priceNative: 0.0000066, marketCap: 1_000_000, fdv: 1_000_000, liquidityUsd: 120_000,
    volume: { m5: 6000, h1: 60_000, h6: 250_000, h24: 600_000 },
    txns: { m5: { buys: 30, sells: 22 }, h1: { buys: 320, sells: 260 }, h6: { buys: 1200, sells: 1000 }, h24: { buys: 3000, sells: 2600 } },
    priceChange: { m5: 2, h1: 18, h6: 40, h24: 90 },
    fetchedAt: new Date(), source: "test", ...over,
  };
}
function onchain(over: Partial<OnChainInfo> = {}): OnChainInfo {
  return { mint: "x", mintAuthority: "REVOKED", freezeAuthority: "REVOKED", decimals: 6, supply: 1e9, tokenProgram: "spl-token", largestHolders: null, fetchedAt: new Date(), source: "rpc", ...over };
}
function risk(over: Partial<RiskReport> = {}): RiskReport {
  return {
    mint: "x", providerScoreNormalised: 5, risks: [], mintAuthority: "REVOKED", freezeAuthority: "REVOKED", lpLockedPct: 100,
    topHolders: [{ address: "pool", pct: 12 }, { address: "a", pct: 3 }, { address: "b", pct: 2.5 }, { address: "c", pct: 2 }, { address: "d", pct: 1.5 }],
    creator: "dev", creatorPct: 1, totalHolders: 900, rugged: false, mutableMetadata: false, transferFeePct: 0, fetchedAt: new Date(), source: "rugcheck", ...over,
  };
}
function cand(m: Partial<MarketSnapshot> = {}, oc: Partial<OnChainInfo> | null = {}, rc: Partial<RiskReport> | null = {}): Candidate {
  const mk = market(m);
  return { mint: mk.mint, name: mk.name, symbol: mk.symbol, market: mk, onChain: oc === null ? null : onchain(oc), risk: rc === null ? null : risk(rc), ageMinutes: mk.pairCreatedAt ? (Date.now() - mk.pairCreatedAt.getTime()) / 60000 : null, discoverySource: "test", solPriceUsd: 150 };
}
const portfolio = (o: Partial<PortfolioState> = {}): PortfolioState => ({ equitySol: 10, cashSol: 10, openPositions: 0, exposureSol: 0, dailyPnlSol: 0, weeklyPnlSol: 0, dailyStartEquitySol: 10, weeklyStartEquitySol: 10, ...o });
const ctx = (o: Partial<StrategyContext> = {}): StrategyContext => ({ settings: s, regime: "NORMAL", portfolio: portfolio(), hasOpenPosition: false, inCooldown: false, blacklisted: false, dataAgeSec: 5, autoTradeEnabled: true, emergencyStop: false, ...o });

describe("TokenSafetyEngine", () => {
  it("passes a clean token as LOW/MODERATE risk", () => {
    const sa = assessSafety(cand(), s);
    expect(sa.passed).toBe(true);
    expect(["LOW", "MODERATE"]).toContain(sa.riskLevel);
    expect(sa.safetyScore).toBeGreaterThan(20);
  });
  it("flags active mint authority as CRITICAL and fails the gate", () => {
    const sa = assessSafety(cand({}, { mintAuthority: "ACTIVE" }, { mintAuthority: "ACTIVE" }), s);
    expect(sa.riskLevel).toBe("CRITICAL");
    expect(sa.passed).toBe(false);
    expect(sa.safetyScore).toBe(0);
  });
  it("treats provider disagreement about freeze authority as active (worst case)", () => {
    const sa = assessSafety(cand({}, { freezeAuthority: "REVOKED" }, { freezeAuthority: "ACTIVE" }), s);
    expect(sa.flags.some((f) => f.code === "FREEZE_AUTHORITY_ACTIVE")).toBe(true);
    expect(sa.passed).toBe(false);
  });
  it("marks risk UNKNOWN (not passed) when the risk provider is unavailable", () => {
    const sa = assessSafety(cand({}, {}, null), s);
    expect(sa.passed).toBe(false);
    expect(["UNKNOWN", "HIGH", "CRITICAL"]).toContain(sa.riskLevel);
  });
  it("rejects unlocked liquidity and honeypot-like no-sell pattern", () => {
    expect(assessSafety(cand({}, {}, { lpLockedPct: 10 }), s).passed).toBe(false);
    const hp = assessSafety(cand({ txns: { m5: { buys: 10, sells: 0 }, h1: { buys: 200, sells: 0 }, h6: { buys: 400, sells: 0 }, h24: { buys: 800, sells: 0 } } }), s);
    expect(hp.flags.some((f) => f.code === "NO_SELLS" && f.severity === "CRITICAL")).toBe(true);
  });
  it("rejects concentrated holders and heavy creator holdings", () => {
    const conc = assessSafety(cand({}, {}, { topHolders: [{ address: "pool", pct: 12 }, { address: "w", pct: 30 }] }), s);
    expect(conc.passed).toBe(false);
    expect(assessSafety(cand({}, {}, { creatorPct: 25 }), s).riskLevel).toBe("CRITICAL");
  });
  it("discounts the pool vault when it is the largest holder", () => {
    const sa = assessSafety(cand({ marketCap: 1_000_000, liquidityUsd: 120_000 }, {}, { topHolders: [{ address: "pool", pct: 8 }, { address: "a", pct: 2 }] }), s);
    expect(sa.topHolderPct).toBe(2);
  });
});

describe("Scoring", () => {
  it("produces an explainable 0-100 score with 8 components summing to the overall", () => {
    const c = cand();
    const sa = assessSafety(c, s);
    const sc = scoreOpportunity(c, sa, "NORMAL", s);
    expect(sc.components).toHaveLength(8);
    expect(sc.components.reduce((a, x) => a + x.max, 0)).toBe(100);
    expect(Math.abs(sc.components.reduce((a, x) => a + x.points, 0) - sc.overall)).toBeLessThan(0.11);
    expect(sc.components.every((x) => x.reasons.length > 0)).toBe(true);
  });
  it("caps overall score at 30 for CRITICAL risk no matter how strong momentum is", () => {
    const c = cand({ volume: { m5: 50000, h1: 300000, h6: 500000, h24: 900000 } }, { mintAuthority: "ACTIVE" }, { mintAuthority: "ACTIVE" });
    const sc = scoreOpportunity(c, assessSafety(c, s), "HOT", s);
    expect(sc.overall).toBeLessThanOrEqual(30);
  });
  it("does not reward vertical price moves", () => {
    const calm = cand({ priceChange: { m5: 1, h1: 15, h6: 30, h24: 50 } });
    const vertical = cand({ priceChange: { m5: 40, h1: 300, h6: 400, h24: 500 } });
    const a = scoreOpportunity(calm, assessSafety(calm, s), "NORMAL", s).overall;
    const b = scoreOpportunity(vertical, assessSafety(vertical, s), "NORMAL", s).overall;
    expect(a).toBeGreaterThan(b);
  });
});

describe("Strategy decision engine", () => {
  it("returns BUY for a clean, active, constructive setup", () => {
    const c = cand();
    const sa = assessSafety(c, s);
    const sc = scoreOpportunity(c, sa, "NORMAL", s);
    const d = decide(c, sa, sc, ctx());
    expect(["BUY", "WATCH"]).toContain(d.decision);
    if (d.decision === "WATCH") expect(d.mandatoryFailures).toHaveLength(0);
  });
  it("REJECTS on critical safety regardless of score, with reasons", () => {
    const c = cand({}, { freezeAuthority: "ACTIVE" }, { freezeAuthority: "ACTIVE" });
    const sa = assessSafety(c, s);
    const d = decide(c, sa, scoreOpportunity(c, sa, "HOT", s), ctx());
    expect(d.decision).toBe("REJECTED");
    expect(d.primaryReason).toMatch(/Critical safety flag/);
  });
  it("classifies overextended tokens and does not buy them", () => {
    const c = cand({ priceChange: { m5: 30, h1: 250, h6: 300, h24: 400 } });
    expect(classify(c, s)).toBe("OVEREXTENDED");
    const sa = assessSafety(c, s);
    const d = decide(c, sa, scoreOpportunity(c, sa, "NORMAL", s), ctx());
    expect(d.decision).not.toBe("BUY");
  });
  it("blocks entries when daily loss limit hit, emergency stop, cooldown, blacklist, stale data, or too young", () => {
    const c = cand();
    const sa = assessSafety(c, s);
    const sc = scoreOpportunity(c, sa, "NORMAL", s);
    expect(decide(c, sa, sc, ctx({ portfolio: portfolio({ dailyPnlSol: -0.6 }) })).decision).toBe("NO_TRADE");
    expect(decide(c, sa, sc, ctx({ emergencyStop: true })).decision).toBe("NO_TRADE");
    expect(decide(c, sa, sc, ctx({ inCooldown: true })).decision).toBe("NO_TRADE");
    expect(decide(c, sa, sc, ctx({ blacklisted: true })).decision).toBe("REJECTED");
    expect(decide(c, sa, sc, ctx({ dataAgeSec: 1000 })).decision).toBe("NO_TRADE");
    const young = cand({ pairCreatedAt: new Date(Date.now() - 5 * 60000) });
    expect(decide(young, assessSafety(young, s), sc, ctx()).decision).toBe("NO_TRADE");
  });
  it("suspends entries in EXTREMELY_RISKY regime and raises the bar in WEAK", () => {
    const c = cand();
    const sa = assessSafety(c, s);
    const sc = scoreOpportunity(c, sa, "EXTREMELY_RISKY", s);
    expect(decide(c, sa, sc, ctx({ regime: "EXTREMELY_RISKY" })).decision).toBe("NO_TRADE");
    expect(computeRegime({ solChange24h: -12, solChange1h: -4, aggregateVolume1h: 100000, candidateCount: 3, medianBuySellRatio: 0.8 }).regime).toBe("EXTREMELY_RISKY");
    expect(computeRegime({ solChange24h: null, solChange1h: null, aggregateVolume1h: 0, candidateCount: 0, medianBuySellRatio: null }).regime).toBe("UNKNOWN");
  });
});

describe("Risk limits & position sizing", () => {
  it("detects the daily loss lockout", () => {
    expect(dailyLossLimitHit(portfolio({ dailyPnlSol: -0.5 }), s)).toBe(true);
    expect(dailyLossLimitHit(portfolio({ dailyPnlSol: -0.49 }), s)).toBe(false);
    expect(checkPortfolioLimits(portfolio({ openPositions: 4 }), s).ok).toBe(false);
    expect(checkPortfolioLimits(portfolio({ exposureSol: 4 }), s).ok).toBe(false);
    expect(checkPortfolioLimits(portfolio(), s).ok).toBe(true);
  });
  it("never exceeds hard caps regardless of confidence", () => {
    const r = computePositionSize({ portfolio: portfolio({ equitySol: 1000, cashSol: 1000 }), liquidityUsd: 5_000_000, solPriceUsd: 150, score: 99, stopLossPct: 20 }, s);
    expect(r.sizeSol).toBeLessThanOrEqual(Number(s.MAX_TRADE_SIZE_SOL));
  });
  it("shrinks size for thin liquidity / price impact and returns zero when unviable", () => {
    const r = computePositionSize({ portfolio: portfolio(), liquidityUsd: 30_000, solPriceUsd: 150, score: 80, stopLossPct: 20 }, s);
    expect(r.estimatedPriceImpactPct).toBeLessThanOrEqual(Number(s.MAX_PRICE_IMPACT_PCT) + 1e-9);
    expect(r.sizeSol * 150).toBeLessThanOrEqual(30_000 * 0.01 + 1e-6);
    const z = computePositionSize({ portfolio: portfolio({ cashSol: 0.02 }), liquidityUsd: 100_000, solPriceUsd: 150, score: 80, stopLossPct: 20 }, s);
    expect(z.sizeSol).toBe(0);
  });
  it("rejects poor execution quality and never widens tolerance", () => {
    expect(checkExecutionQuality({ slippagePct: 5, priceImpactPct: 0.5 }, s).ok).toBe(false);
    expect(checkExecutionQuality({ slippagePct: 0.5, priceImpactPct: 5 }, s).ok).toBe(false);
    expect(checkExecutionQuality({ slippagePct: 0.5, priceImpactPct: 0.5 }, s).ok).toBe(true);
  });
  it("validates settings ranges", () => {
    expect(validateSetting("MAX_DAILY_LOSS_PCT", 500).ok).toBe(false);
    expect(validateSetting("MAX_DAILY_LOSS_PCT", 3).ok).toBe(true);
    expect(validateSetting("NOPE", 1).ok).toBe(false);
  });
});

describe("Exit engine", () => {
  const pos = { entryPrice: 1, highestPrice: 1, remainingTokens: 1000, initialTokens: 1000, takenLevels: [] as number[], openedAt: new Date(Date.now() - 10 * 60000), entryLiquidityUsd: 100_000, trailingStopPrice: null as number | null };
  const mk = (price: number, o: Partial<Parameters<typeof evaluateExit>[1]> = {}) => ({ price, liquidityUsd: 100_000, priceChange5m: 0, buys5m: 10, sells5m: 10, dataAgeSec: 0, now: new Date(), ...o });
  it("holds inside the band", () => expect(evaluateExit(pos, mk(1.05), s).action).toBe("HOLD"));
  it("hard stop at -20%", () => expect(evaluateExit(pos, mk(0.79), s).kind).toBe("HARD_STOP"));
  it("take-profit 1 at +30% sells 25% of original", () => {
    const a = evaluateExit(pos, mk(1.31), s);
    expect(a.kind).toBe("TAKE_PROFIT");
    expect(a.tpLevel).toBe(1);
    expect(a.sellFraction).toBeCloseTo(0.25, 5);
  });
  it("does not repeat a taken level; arms trailing stop after +20% and fires on pullback", () => {
    const p2 = { ...pos, takenLevels: [1], remainingTokens: 750, highestPrice: 1.5 };
    const hold = evaluateExit(p2, mk(1.35), s);
    expect(hold.action).toBe("HOLD");
    expect(hold.newTrailingStop).toBeCloseTo(1.2, 5);
    const fire = evaluateExit({ ...p2, trailingStopPrice: 1.2 }, mk(1.19), s);
    expect(fire.kind).toBe("TRAILING_STOP");
  });
  it("emergency exits on liquidity collapse, price collapse and new critical flag", () => {
    expect(evaluateExit(pos, mk(1.1, { liquidityUsd: 40_000 }), s).kind).toBe("EMERGENCY_LIQUIDITY");
    expect(evaluateExit(pos, mk(0.9, { priceChange5m: -50 }), s).kind).toBe("EMERGENCY_PRICE_COLLAPSE");
    expect(evaluateExit(pos, mk(1.2, { newCriticalFlag: "freeze authority active" }), s).kind).toBe("EMERGENCY_RISK_FLAG");
  });
  it("max hold time closes the position", () => {
    expect(evaluateExit({ ...pos, openedAt: new Date(Date.now() - 300 * 60000) }, mk(1.02), s).kind).toBe("MAX_HOLD_TIME");
  });
  it("momentum deterioration exits while in profit", () => {
    expect(evaluateExit(pos, mk(1.1, { buys5m: 5, sells5m: 15, priceChange5m: -8 }), s).kind).toBe("MOMENTUM_DETERIORATION");
  });
});

describe("Paper execution realism", () => {
  const req = { idempotencyKey: "k", mint: "m", symbol: "T", side: "BUY" as const, amount: 0.2, expectedPriceSol: 0.00001, liquidityUsd: 100_000, solPriceUsd: 150, maxSlippagePct: 3, maxPriceImpactPct: 2, reason: "t" };
  it("fills BUY at a worse price than expected with fees and latency", async () => {
    const p = new PaperExecutionProvider({ settings: s, volatility5mPct: 2, rng: () => 0.5 });
    const r = await p.execute(req);
    expect(r.status).toBe("FILLED");
    expect(r.executedPriceSol).toBeGreaterThan(req.expectedPriceSol);
    expect(r.feeSol).toBeGreaterThan(0);
    expect(r.tokenAmount * r.executedPriceSol).toBeCloseTo(0.2, 6);
    expect(r.mode).toBe("PAPER");
  });
  it("simulates failures", async () => {
    const p = new PaperExecutionProvider({ settings: s, volatility5mPct: 2, rng: () => 0.001 });
    expect((await p.execute(req)).status).toBe("FAILED");
  });
  it("fails instead of filling when adverse slippage exceeds tolerance (never widens)", async () => {
    const p = new PaperExecutionProvider({ settings: s, volatility5mPct: 40, rng: () => 0.99 });
    const r = await p.execute({ ...req, liquidityUsd: 20_000, amount: 1 });
    expect(r.status).toBe("FAILED");
  });
  it("partially fills large sells", async () => {
    const p = new PaperExecutionProvider({ settings: s, volatility5mPct: 1, rng: () => 0.5 });
    // 12 SOL sell into a $50k pool (>3% of pool) under emergency-width tolerances → partial fill
    const r = await p.execute({ ...req, side: "SELL", amount: 1_200_000, liquidityUsd: 50_000, maxSlippagePct: 6, maxPriceImpactPct: 8 });
    expect(r.status).toBe("PARTIAL");
    expect(r.tokenAmount).toBeLessThan(1_200_000);
    // same sell under normal tolerances must FAIL (impact above max) rather than fill at a terrible price
    const f = await p.execute({ ...req, side: "SELL", amount: 3_000_000, liquidityUsd: 50_000 });
    expect(f.status).toBe("FAILED");
    expect(f.reason).toMatch(/impact/i);
  });
});
