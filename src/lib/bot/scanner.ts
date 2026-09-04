import { db } from "@/db";
import { decisions, positions, riskAssessments, tokenSnapshots, tokens, trades } from "@/db/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { providers } from "../providers";
import { evictCache, getHealth } from "../providers/http";
import type { Candidate, ExecutionProvider, MarketSnapshot, OpportunityScore, SafetyAssessment } from "../core/types";
import { logger, raiseAlert } from "../core/logger";
import { assessSafety } from "../engine/safety";
import { scoreOpportunity } from "../engine/scoring";
import { classify, computeRegime, decide, explain, type StrategyContext } from "../engine/strategy";
import { checkExecutionQuality, computePositionSize } from "../engine/risk";
import { describeExitPlan, evaluateExit } from "../engine/exits";
import { PaperExecutionProvider } from "../execution/paper";
import { JupiterExecutionProvider } from "../execution/live";
import { bool, num, str, type SettingsMap } from "../config/settings";
import { computePortfolio, ensureStrategyVersionRecorded, getBotState, isBlacklisted, loadSettings, openPositions, patchBotState, snapshotPortfolio, type PositionRow } from "./state";

const C = "scanner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ageMinutes(m: MarketSnapshot): number | null {
  return m.pairCreatedAt ? (Date.now() - m.pairCreatedAt.getTime()) / 60000 : null;
}

async function upsertToken(m: MarketSnapshot, source: string, extra: Partial<typeof tokens.$inferInsert> = {}) {
  await db
    .insert(tokens)
    .values({ mint: m.mint, name: m.name, symbol: m.symbol, pairAddress: m.pairAddress, dexId: m.dexId, launchTime: m.pairCreatedAt, discoverySource: source, price: m.priceNative, marketCap: m.marketCap ?? m.fdv, liquidity: m.liquidityUsd, volume1h: m.volume.h1, volume24h: m.volume.h24, lastSeenAt: new Date(), ...extra })
    .onConflictDoUpdate({ target: tokens.mint, set: { name: m.name, symbol: m.symbol, pairAddress: m.pairAddress, dexId: m.dexId, launchTime: m.pairCreatedAt, price: m.priceNative, marketCap: m.marketCap ?? m.fdv, liquidity: m.liquidityUsd, volume1h: m.volume.h1, volume24h: m.volume.h24, lastSeenAt: new Date(), ...extra } });
}

async function recordSnapshot(m: MarketSnapshot, sa?: SafetyAssessment, score?: OpportunityScore, holderCount?: number | null) {
  await db.insert(tokenSnapshots).values({
    mint: m.mint, price: m.priceNative, marketCap: m.marketCap ?? m.fdv, liquidity: m.liquidityUsd,
    volume5m: m.volume.m5, volume1h: m.volume.h1, volume6h: m.volume.h6, volume24h: m.volume.h24,
    buys5m: m.txns.m5.buys, sells5m: m.txns.m5.sells, buys1h: m.txns.h1.buys, sells1h: m.txns.h1.sells,
    priceChange5m: m.priceChange.m5, priceChange1h: m.priceChange.h1, priceChange6h: m.priceChange.h6, priceChange24h: m.priceChange.h24,
    holderCount: holderCount ?? null, topHolderPct: sa?.topHolderPct ?? null, top10Pct: sa?.top10Pct ?? null,
    overallScore: score?.overall ?? null, safetyScore: sa?.safetyScore ?? null, riskLevel: sa?.riskLevel ?? null,
    scores: score ? score.components : null,
  });
}

async function recordDecision(c: Candidate, sa: SafetyAssessment, score: OpportunityScore, d: ReturnType<typeof decide>, regime: string, version: string, explanation: string, manual = false) {
  await db.insert(decisions).values({
    mint: c.mint, symbol: c.symbol, decision: d.decision, classification: d.classification, overallScore: score.overall, safetyScore: sa.safetyScore, riskLevel: sa.riskLevel,
    primaryReason: d.primaryReason, reasons: d.reasons, positives: d.positives, marketRegime: regime, strategyVersion: version, explanation, manual, scores: score.components,
  });
  await db.update(tokens).set({ overallScore: score.overall, safetyScore: sa.safetyScore, riskLevel: sa.riskLevel, tradeStatus: d.decision === "BUY" ? "POSITION" : d.decision, lastDecision: d.decision, lastDecisionReason: d.primaryReason, holderCount: c.risk?.totalHolders ?? null, creator: c.risk?.creator ?? null }).where(eq(tokens.mint, c.mint));
}

/** Pre-filter using market data only (cheap) before spending RPC/RugCheck quota. */
function passesPrefilter(m: MarketSnapshot, s: SettingsMap): { ok: boolean; reason?: string } {
  const L = m.liquidityUsd ?? 0, v1 = m.volume.h1 ?? 0, tx1 = m.txns.h1.buys + m.txns.h1.sells;
  const age = ageMinutes(m);
  if (!m.priceNative || m.priceNative <= 0) return { ok: false, reason: "No price" };
  if (L < num(s, "MIN_LIQUIDITY_USD")) return { ok: false, reason: `Liquidity $${Math.round(L).toLocaleString()} below minimum` };
  if (v1 < num(s, "MIN_VOLUME_1H_USD") * 0.5) return { ok: false, reason: `1h volume $${Math.round(v1).toLocaleString()} too low` };
  if (tx1 < num(s, "MIN_TXNS_1H") * 0.5) return { ok: false, reason: `Only ${tx1} trades in 1h` };
  if (age !== null && age < num(s, "MIN_TOKEN_AGE_MIN")) return { ok: false, reason: `Too young (${Math.round(age)} min)` };
  if (age !== null && age > num(s, "MAX_TOKEN_AGE_MIN")) return { ok: false, reason: `Too old (${(age / 60).toFixed(1)}h)` };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Full evaluation of one candidate (used by scan and by manual re-analyse)
// ---------------------------------------------------------------------------
export async function evaluateCandidate(mint: string, market: MarketSnapshot, source: string, s: SettingsMap, regime: string, solPrice: number, opts: { execute: boolean; manual?: boolean }) {
  const P = providers();
  const [risk, onChain] = await Promise.all([P.risk.getRiskReport(mint), P.onchain.getOnChainInfo(mint)]);
  const c: Candidate = { mint, name: market.name, symbol: market.symbol, market, onChain, risk, ageMinutes: ageMinutes(market), discoverySource: source, solPriceUsd: solPrice };
  const sa = assessSafety(c, s);
  const score = scoreOpportunity(c, sa, regime as StrategyContext["regime"], s);
  const st = await getBotState();
  const portfolio = await computePortfolio();
  const open = await openPositions();
  const cooldownSince = new Date(Date.now() - num(s, "TOKEN_COOLDOWN_MIN") * 60000);
  const recent = await db.select({ id: positions.id }).from(positions).where(and(eq(positions.mint, mint), eq(positions.status, "CLOSED"), gte(positions.closedAt, cooldownSince))).limit(1);
  const ctx: StrategyContext = {
    settings: s,
    regime: regime as StrategyContext["regime"],
    portfolio,
    hasOpenPosition: open.some((p) => p.mint === mint),
    inCooldown: recent.length > 0,
    blacklisted: await isBlacklisted(mint, risk?.creator ?? null),
    dataAgeSec: (Date.now() - market.fetchedAt.getTime()) / 1000,
    autoTradeEnabled: bool(s, "AUTO_TRADE_ENABLED") && st.running,
    emergencyStop: st.emergencyStop,
  };
  const d = decide(c, sa, score, ctx);
  const version = str(s, "STRATEGY_VERSION");

  await upsertToken(market, source, { dataSource: "LIVE" });
  await db.insert(riskAssessments).values({ mint, riskLevel: sa.riskLevel, safetyScore: sa.safetyScore, passed: sa.passed, mintAuthority: sa.mintAuthority, freezeAuthority: sa.freezeAuthority, lpLockedPct: sa.lpLockedPct, topHolderPct: sa.topHolderPct, top10Pct: sa.top10Pct, creatorPct: sa.creatorPct, flags: sa.flags, providers: sa.providersUsed });
  await recordSnapshot(market, sa, score, risk?.totalHolders ?? null);

  let explanation = explain(d, score, sa);
  if (d.decision === "BUY" && opts.execute) {
    const result = await attemptEntry(c, sa, score, d, s, portfolio, version);
    explanation = result.explanation;
    if (!result.entered) {
      d.decision = "NO_TRADE";
      d.primaryReason = result.reason;
      d.reasons = [result.reason];
    }
  } else if (d.decision === "BUY") {
    explanation = explain(d, score, sa, { exitPlan: describeExitPlan(s) });
  }
  await recordDecision(c, sa, score, d, regime, version, explanation, opts.manual);
  await logger.info(C, `${d.decision} ${c.symbol} score=${score.overall} risk=${sa.riskLevel}: ${d.primaryReason}`, { classification: d.classification }, mint);
  if (d.decision === "WATCH" && score.overall >= num(s, "MIN_SCORE") + 10) await raiseAlert("INFO", "HIGH_QUALITY_CANDIDATE", `${c.symbol} scored ${score.overall} (WATCH)`, d.primaryReason, mint);
  return { candidate: c, safety: sa, score, decision: d, explanation };
}

// ---------------------------------------------------------------------------
// Entry: final confirmation + sizing + execution + persistence
// ---------------------------------------------------------------------------
async function attemptEntry(c: Candidate, sa: SafetyAssessment, score: OpportunityScore, d: ReturnType<typeof decide>, s: SettingsMap, portfolio: Awaited<ReturnType<typeof computePortfolio>>, version: string): Promise<{ entered: boolean; reason: string; explanation: string }> {
  const st = await getBotState();
  const mode = st.mode;
  // Duplicate protection: idempotency key per token per 10-minute bucket.
  const bucket = Math.floor(Date.now() / 600_000);
  const idem = `${mode}:BUY:${c.mint}:${bucket}`;
  const dup = await db.select({ id: trades.id }).from(trades).where(eq(trades.idempotencyKey, idem)).limit(1);
  if (dup.length) return { entered: false, reason: "Duplicate order blocked (idempotency key exists).", explanation: explain({ ...d, decision: "NO_TRADE", primaryReason: "Duplicate order blocked" }, score, sa) };
  const already = await db.select({ id: positions.id }).from(positions).where(and(eq(positions.mint, c.mint), eq(positions.status, "OPEN"))).limit(1);
  if (already.length) return { entered: false, reason: "Open position already exists.", explanation: explain({ ...d, decision: "NO_TRADE", primaryReason: "Open position already exists" }, score, sa) };

  // Final confirmation: re-fetch fresh market data and re-run the gate chain.
  const fresh = (await providers().market.getMarketSnapshots([c.mint])).get(c.mint);
  if (!fresh || !fresh.priceNative) return { entered: false, reason: "Confirmation failed: fresh market data unavailable.", explanation: "NO TRADE\nConfirmation failed: fresh market data unavailable." };
  const c2: Candidate = { ...c, market: fresh };
  const sa2 = assessSafety(c2, s);
  const score2 = scoreOpportunity(c2, sa2, "NORMAL", s);
  const d2 = decide(c2, sa2, score2, { settings: s, regime: "NORMAL", portfolio, hasOpenPosition: false, inCooldown: false, blacklisted: false, dataAgeSec: 0, autoTradeEnabled: true, emergencyStop: st.emergencyStop });
  const priceMove = Math.abs((fresh.priceNative - (c.market.priceNative ?? fresh.priceNative)) / fresh.priceNative) * 100;
  if (d2.decision !== "BUY") return { entered: false, reason: `Confirmation failed: ${d2.primaryReason}`, explanation: explain(d2, score2, sa2) };
  if (priceMove > 8) return { entered: false, reason: `Confirmation failed: price moved ${priceMove.toFixed(1)}% since analysis.`, explanation: `NO TRADE\nPrice moved ${priceMove.toFixed(1)}% between analysis and confirmation.` };
  if ((fresh.liquidityUsd ?? 0) < (c.market.liquidityUsd ?? 0) * 0.8) return { entered: false, reason: "Confirmation failed: liquidity dropped >20% since analysis.", explanation: "NO TRADE\nLiquidity withdrawal detected during confirmation." };

  const sizing = computePositionSize({ portfolio, liquidityUsd: fresh.liquidityUsd ?? 0, solPriceUsd: c.solPriceUsd, score: score2.overall, stopLossPct: num(s, "STOP_LOSS_PCT") }, s);
  if (sizing.sizeSol <= 0) return { entered: false, reason: `Position size zero: ${sizing.reasons.at(-1)}`, explanation: `NO TRADE\n${sizing.reasons.join("\n")}` };

  // Execution quality pre-check: real router quote if available, else estimate.
  const q = await providers().quotes.quote({ inputMint: "So11111111111111111111111111111111111111112", outputMint: c.mint, amountBaseUnits: sizing.sizeSol * 1e9, slippageBps: Math.round(num(s, "MAX_ACCEPTABLE_SLIPPAGE_PCT") * 100) });
  const impact = q ? q.priceImpactPct : sizing.estimatedPriceImpactPct;
  const execQ = checkExecutionQuality({ slippagePct: 0, priceImpactPct: impact }, s);
  if (!execQ.ok) return { entered: false, reason: `Execution quality: ${execQ.reason}`, explanation: `NO TRADE\n${execQ.reason}` };
  if (q && !q.routeAvailable) return { entered: false, reason: "No swap route available.", explanation: "NO TRADE\nNo swap route available." };

  const exec: ExecutionProvider = mode === "LIVE" ? new JupiterExecutionProvider(s, { dbLiveEnabled: st.liveTradingEnabled, liveArmed: process.env.LIVE_TRADING_ENABLED === "true" && st.liveTradingEnabled }) : new PaperExecutionProvider({ settings: s, volatility5mPct: fresh.priceChange.m5 });
  const res = await exec.execute({ idempotencyKey: idem, mint: c.mint, symbol: c.symbol, side: "BUY", amount: sizing.sizeSol, expectedPriceSol: fresh.priceNative, liquidityUsd: fresh.liquidityUsd ?? 0, solPriceUsd: c.solPriceUsd, maxSlippagePct: num(s, "MAX_ACCEPTABLE_SLIPPAGE_PCT"), maxPriceImpactPct: num(s, "MAX_PRICE_IMPACT_PCT"), reason: "strategy entry" });

  await db.insert(trades).values({ mint: c.mint, symbol: c.symbol, mode, side: "BUY", idempotencyKey: idem, expectedPrice: fresh.priceNative, executedPrice: res.executedPriceSol, tokenAmount: res.tokenAmount, solAmount: res.solAmount, slippagePct: res.slippagePct, priceImpactPct: res.priceImpactPct, feeSol: res.feeSol, latencyMs: res.latencyMs, status: res.status, reason: res.reason ?? "strategy entry", txSignature: res.txSignature ?? null, strategyVersion: version }).onConflictDoNothing();
  if (res.status === "FAILED") {
    await patchBotState({ paperCashSol: mode === "PAPER" ? st.paperCashSol - res.feeSol : st.paperCashSol });
    await logger.warn(C, `${mode} BUY failed for ${c.symbol}: ${res.reason}`, {}, c.mint);
    return { entered: false, reason: `Execution failed: ${res.reason}`, explanation: `NO TRADE\nExecution failed: ${res.reason}` };
  }
  const stop = res.executedPriceSol * (1 - num(s, "STOP_LOSS_PCT") / 100);
  const [pos] = await db.insert(positions).values({
    mint: c.mint, symbol: c.symbol, mode, entryPrice: res.executedPriceSol, entryScore: score2.overall, entryLiquidity: fresh.liquidityUsd, entryMarketCap: fresh.marketCap ?? fresh.fdv, tokenAgeMinutes: c.ageMinutes,
    sizeSol: res.solAmount, initialTokens: res.tokenAmount, remainingTokens: res.tokenAmount, costBasisSol: res.solAmount, feesSol: res.feeSol, stopPrice: stop, highestPrice: res.executedPriceSol, lowestPrice: res.executedPriceSol, currentPrice: res.executedPriceSol, strategyVersion: version, lastPriceAt: new Date(),
  }).returning();
  await db.update(trades).set({ positionId: pos.id }).where(eq(trades.idempotencyKey, idem));
  if (mode === "PAPER") await patchBotState({ paperCashSol: st.paperCashSol - res.solAmount - res.feeSol });
  const risks = sa2.flags.filter((f) => f.severity !== "INFO").slice(0, 4).map((f) => f.message);
  if (c.ageMinutes !== null && c.ageMinutes < 60) risks.push(`Token is only ${Math.round(c.ageMinutes)} minutes old`);
  if (Math.abs(fresh.priceChange.m5 ?? 0) > 5) risks.push("Short-term volatility elevated");
  const explanation = explain(d2, score2, sa2, { sizeSol: res.solAmount, stopPrice: stop, exitPlan: describeExitPlan(s), risks: [...risks, ...sizing.reasons.slice(-1)] });
  await logger.info(C, `${mode} BUY EXECUTED ${c.symbol} ${res.solAmount.toFixed(4)} SOL @ ${res.executedPriceSol.toExponential(4)} (slip ${res.slippagePct.toFixed(2)}%)`, { positionId: pos.id }, c.mint);
  await raiseAlert("INFO", "TRADE_ENTERED", `${mode} BUY ${c.symbol} ${res.solAmount.toFixed(3)} SOL`, `Score ${score2.overall} · ${sizing.capBy}`, c.mint);
  return { entered: true, reason: "entered", explanation };
}

// ---------------------------------------------------------------------------
// Sell / close (used by exit engine and manual actions)
// ---------------------------------------------------------------------------
export async function sellPosition(p: PositionRow, fraction: number, reason: string, opts: { manual?: boolean; urgent?: boolean; tpLevel?: number; trailing?: number | null } = {}) {
  const s = await loadSettings();
  const st = await getBotState();
  const P = providers();
  const m = (await P.market.getMarketSnapshots([p.mint])).get(p.mint);
  const solPrice = (await P.market.getSolPriceUsd()) ?? 0;
  const price = m?.priceNative ?? p.currentPrice ?? p.entryPrice;
  const tokensToSell = Math.min(p.remainingTokens, p.remainingTokens * fraction);
  if (tokensToSell <= 0) return { ok: false, reason: "nothing to sell" };
  const idem = `${p.mode}:SELL:${p.id}:${(p.takenProfitLevels as number[]).length}:${Math.floor(Date.now() / 60_000)}:${reason.slice(0, 20)}`;
  const dup = await db.select({ id: trades.id }).from(trades).where(eq(trades.idempotencyKey, idem)).limit(1);
  if (dup.length) return { ok: false, reason: "duplicate sell blocked" };
  const exec: ExecutionProvider = p.mode === "LIVE" ? new JupiterExecutionProvider(s, { dbLiveEnabled: st.liveTradingEnabled, liveArmed: process.env.LIVE_TRADING_ENABLED === "true" && st.liveTradingEnabled }) : new PaperExecutionProvider({ settings: s, volatility5mPct: m?.priceChange.m5 ?? null });
  // Emergencies may use a wider (but still capped) slippage: 2× normal, max 15%.
  const maxSlip = opts.urgent ? Math.min(num(s, "MAX_ACCEPTABLE_SLIPPAGE_PCT") * 2, 15) : num(s, "MAX_ACCEPTABLE_SLIPPAGE_PCT");
  const res = await exec.execute({ idempotencyKey: idem, mint: p.mint, symbol: p.symbol ?? "", side: "SELL", amount: tokensToSell, expectedPriceSol: price, liquidityUsd: m?.liquidityUsd ?? p.entryLiquidity ?? 0, solPriceUsd: solPrice, maxSlippagePct: maxSlip, maxPriceImpactPct: opts.urgent ? Math.min(num(s, "MAX_PRICE_IMPACT_PCT") * 3, 20) : num(s, "MAX_PRICE_IMPACT_PCT"), reason });
  const costPerToken = p.costBasisSol / Math.max(p.initialTokens, 1e-12);
  const realized = res.status === "FAILED" ? 0 : res.solAmount - res.tokenAmount * costPerToken;
  await db.insert(trades).values({ positionId: p.id, mint: p.mint, symbol: p.symbol, mode: p.mode, side: "SELL", idempotencyKey: idem, expectedPrice: price, executedPrice: res.executedPriceSol, tokenAmount: res.tokenAmount, solAmount: res.solAmount, slippagePct: res.slippagePct, priceImpactPct: res.priceImpactPct, feeSol: res.feeSol, latencyMs: res.latencyMs, status: res.status, reason, realizedPnlSol: realized, txSignature: res.txSignature ?? null, strategyVersion: p.strategyVersion, manual: opts.manual ?? false }).onConflictDoNothing();
  if (res.status === "FAILED") {
    await logger.warn("exit", `SELL failed for ${p.symbol}: ${res.reason}`, { positionId: p.id }, p.mint);
    if (opts.urgent) await raiseAlert("CRITICAL", "EXECUTION_FAILURE", `Emergency exit failed for ${p.symbol}`, res.reason, p.mint);
    if (p.mode === "PAPER") await patchBotState({ paperCashSol: st.paperCashSol - res.feeSol });
    return { ok: false, reason: res.reason };
  }
  const remaining = Math.max(0, p.remainingTokens - res.tokenAmount);
  const closed = remaining <= p.initialTokens * 0.001;
  const levels = [...(p.takenProfitLevels as number[])];
  if (opts.tpLevel) levels.push(opts.tpLevel);
  await db.update(positions).set({
    remainingTokens: closed ? 0 : remaining, realizedPnlSol: p.realizedPnlSol + realized, feesSol: p.feesSol + res.feeSol, takenProfitLevels: levels,
    status: closed ? "CLOSED" : "OPEN", closedAt: closed ? new Date() : null, exitReason: closed ? reason : p.exitReason, currentPrice: res.executedPriceSol, lastPriceAt: new Date(),
    trailingStopPrice: opts.trailing === undefined ? p.trailingStopPrice : opts.trailing,
  }).where(eq(positions.id, p.id));
  if (p.mode === "PAPER") await patchBotState({ paperCashSol: st.paperCashSol + res.solAmount - res.feeSol });
  if (closed) await db.update(tokens).set({ tradeStatus: "CLOSED" }).where(eq(tokens.mint, p.mint));
  const pnlPct = ((res.executedPriceSol - p.entryPrice) / p.entryPrice) * 100;
  await db.insert(decisions).values({ mint: p.mint, symbol: p.symbol, decision: "SELL", primaryReason: reason, reasons: [reason], positives: [], strategyVersion: p.strategyVersion, manual: opts.manual ?? false, explanation: `SELL ${closed ? "(position closed)" : `(${(fraction * 100).toFixed(0)}% of remaining)`}\n${reason}\nExecuted ${res.tokenAmount.toFixed(2)} tokens @ ${res.executedPriceSol.toExponential(4)} SOL (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% vs entry)\nRealized ${realized >= 0 ? "+" : ""}${realized.toFixed(4)} SOL · slippage ${res.slippagePct.toFixed(2)}%${res.status === "PARTIAL" ? " · PARTIAL FILL" : ""}` });
  await logger.info("exit", `${p.mode} SELL ${p.symbol} ${reason} realized ${realized.toFixed(4)} SOL${closed ? " — CLOSED" : ""}`, { positionId: p.id, pnlPct }, p.mint);
  await raiseAlert(realized < 0 && closed ? "WARNING" : "INFO", closed ? "TRADE_EXITED" : "PARTIAL_EXIT", `${p.mode} SELL ${p.symbol}: ${reason}`, `${realized >= 0 ? "+" : ""}${realized.toFixed(4)} SOL`, p.mint);
  return { ok: true, closed, realized };
}

// ---------------------------------------------------------------------------
// Position monitoring
// ---------------------------------------------------------------------------
export async function monitorPositions() {
  const s = await loadSettings();
  const open = await openPositions();
  if (!open.length) {
    await patchBotState({ lastPositionCheckAt: new Date() });
    return { checked: 0 };
  }
  const P = providers();
  const snaps = await P.market.getMarketSnapshots(open.map((p) => p.mint));
  let acted = 0;
  for (const p of open) {
    try {
      const m = snaps.get(p.mint);
      if (!m || !m.priceNative) {
        const stale = p.lastPriceAt ? (Date.now() - p.lastPriceAt.getTime()) / 1000 : Infinity;
        await logger.warn("monitor", `No fresh price for ${p.symbol} (stale ${Math.round(stale)}s)`, {}, p.mint);
        if (stale > 600) await raiseAlert("WARNING", "STALE_POSITION_DATA", `${p.symbol}: no price for ${Math.round(stale / 60)} min`, "Pool may have been removed. Manual review required.", p.mint);
        continue;
      }
      const price = m.priceNative;
      // Re-check for new critical risk (cheap cached RugCheck call every ~2 min)
      let newFlag: string | null = null;
      const rc = await P.risk.getRiskReport(p.mint);
      if (rc?.rugged) newFlag = "provider reports token rugged";
      else if (rc?.freezeAuthority === "ACTIVE") newFlag = "freeze authority active";
      const action = evaluateExit(
        { entryPrice: p.entryPrice, highestPrice: p.highestPrice, remainingTokens: p.remainingTokens, initialTokens: p.initialTokens, takenLevels: p.takenProfitLevels as number[], openedAt: p.openedAt, entryLiquidityUsd: p.entryLiquidity, trailingStopPrice: p.trailingStopPrice },
        { price, liquidityUsd: m.liquidityUsd, priceChange5m: m.priceChange.m5, buys5m: m.txns.m5.buys, sells5m: m.txns.m5.sells, dataAgeSec: 0, now: new Date(), newCriticalFlag: newFlag },
        s,
      );
      await db.update(positions).set({ currentPrice: price, highestPrice: Math.max(p.highestPrice, price), lowestPrice: Math.min(p.lowestPrice, price), lastPriceAt: new Date(), trailingStopPrice: action.newTrailingStop ?? p.trailingStopPrice }).where(eq(positions.id, p.id));
      if (action.newTrailingStop && !p.trailingStopPrice) await logger.info("exit", `TRAILING STOP ARMED ${p.symbol} @ ${action.newTrailingStop.toExponential(4)}`, {}, p.mint);
      await recordSnapshot(m);
      if (action.action === "SELL") {
        acted++;
        const fresh = (await db.select().from(positions).where(eq(positions.id, p.id)))[0];
        await sellPosition(fresh, action.sellFraction ?? 1, `${action.kind}: ${action.reason}`, { urgent: action.urgent, tpLevel: action.tpLevel, trailing: action.newTrailingStop });
      }
    } catch (e) {
      await logger.error("monitor", `Position ${p.id} check failed: ${(e as Error).message}`, {}, p.mint);
    }
  }
  await patchBotState({ lastPositionCheckAt: new Date() });
  await snapshotPortfolio();
  return { checked: open.length, acted };
}

// ---------------------------------------------------------------------------
// Scan cycle
// ---------------------------------------------------------------------------
export async function runScan(): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const s = await loadSettings();
  await ensureStrategyVersionRecorded(s);
  const st = await getBotState();
  const P = providers();
  const summary: Record<string, unknown> = { startedAt: new Date(startedAt).toISOString() };
  try {
    // 1. Discover
    const discovered = new Map<string, string>();
    for (const d of P.discovery) {
      try {
        for (const t of await d.discover()) if (!discovered.has(t.mint)) discovered.set(t.mint, t.source);
      } catch (e) {
        await logger.warn(C, `Discovery provider ${d.name} failed: ${(e as Error).message}`);
      }
    }
    // Include recently WATCHed tokens for re-evaluation.
    const watched = await db.select({ mint: tokens.mint }).from(tokens).where(and(eq(tokens.lastDecision, "WATCH"), gte(tokens.lastSeenAt, new Date(Date.now() - 6 * 3600_000)))).limit(30);
    for (const w of watched) if (!discovered.has(w.mint)) discovered.set(w.mint, "rewatch");
    summary.discovered = discovered.size;

    // 2. Market data (batched)
    const mints = [...discovered.keys()].slice(0, num(s, "MAX_CANDIDATES_PER_SCAN") * 2);
    const snaps = await P.market.getMarketSnapshots(mints);
    const solPrice = (await P.market.getSolPriceUsd()) ?? 0;
    summary.withMarketData = snaps.size;
    if (snaps.size === 0) {
      const h = getHealth("dexscreener");
      throw new Error(`Market data provider returned nothing (dexscreener ${h.status}: ${h.lastError ?? "no error"})`);
    }
    await patchBotState({ lastDataUpdateAt: new Date() });

    // 3. Market regime (from SOL trend + aggregate candidate activity)
    const solSnap = (await P.market.getMarketSnapshots(["So11111111111111111111111111111111111111112"])).get("So11111111111111111111111111111111111111112");
    const ratios = [...snaps.values()].map((m) => (m.txns.h1.sells > 0 ? m.txns.h1.buys / m.txns.h1.sells : 1)).sort((a, b) => a - b);
    const regimeRes = computeRegime({ solChange24h: solSnap?.priceChange.h24 ?? null, solChange1h: solSnap?.priceChange.h1 ?? null, aggregateVolume1h: [...snaps.values()].reduce((a, m) => a + (m.volume.h1 ?? 0), 0), candidateCount: snaps.size, medianBuySellRatio: ratios.length ? ratios[Math.floor(ratios.length / 2)] : null });
    await patchBotState({ marketRegime: regimeRes.regime, marketRegimeDetail: { ...regimeRes.detail, solPriceUsd: solPrice } });
    summary.regime = regimeRes.regime;

    // 4. Pre-filter and persist all seen tokens
    const deep: { mint: string; m: MarketSnapshot; source: string }[] = [];
    let prefiltered = 0;
    for (const [mint, m] of snaps) {
      try {
        const pf = passesPrefilter(m, s);
        if (pf.ok) deep.push({ mint, m, source: discovered.get(mint) ?? "unknown" });
        else {
          prefiltered++;
          await upsertToken(m, discovered.get(mint) ?? "unknown", { tradeStatus: "PREFILTERED", lastDecision: "NO_TRADE", lastDecisionReason: pf.reason, dataSource: "LIVE" });
        }
      } catch (e) {
        await logger.warn(C, `Malformed token skipped: ${(e as Error).message}`, {}, mint);
      }
    }
    summary.prefiltered = prefiltered;
    // Prioritise by activity (volume × buy ratio) and cap deep checks per scan.
    deep.sort((a, b) => (b.m.volume.h1 ?? 0) - (a.m.volume.h1 ?? 0));
    const toCheck = deep.slice(0, num(s, "MAX_DEEP_CHECKS_PER_SCAN"));
    summary.deepChecked = toCheck.length;

    // 5. Full evaluation (sequential to respect RPC/RugCheck limits)
    const counts: Record<string, number> = { BUY: 0, WATCH: 0, NO_TRADE: 0, REJECTED: 0 };
    for (const t of toCheck) {
      try {
        const r = await evaluateCandidate(t.mint, t.m, t.source, s, regimeRes.regime, solPrice, { execute: true });
        counts[r.decision.decision] = (counts[r.decision.decision] ?? 0) + 1;
        void classify;
      } catch (e) {
        await logger.error(C, `Evaluation failed: ${(e as Error).message}`, {}, t.mint);
      }
    }
    summary.decisions = counts;
    summary.durationMs = Date.now() - startedAt;
    await patchBotState({ lastScanAt: new Date(), lastScanOk: true, lastScanSummary: summary });
    await logger.info(C, `Scan complete: ${discovered.size} discovered, ${toCheck.length} deep-checked, decisions ${JSON.stringify(counts)} in ${summary.durationMs}ms`);
    evictCache();
    return summary;
  } catch (e) {
    summary.error = (e as Error).message;
    await patchBotState({ lastScanAt: new Date(), lastScanOk: false, lastScanSummary: summary });
    await logger.error(C, `Scan failed: ${(e as Error).message}`);
    if (!st.lastScanOk) await raiseAlert("WARNING", "PROVIDER_OUTAGE", "Consecutive scan failures", (e as Error).message);
    return summary;
  }
}

// ---------------------------------------------------------------------------
// Startup recovery / reconciliation
// ---------------------------------------------------------------------------
export async function recoverState() {
  const st = await getBotState();
  const open = await openPositions();
  const summary: Record<string, unknown> = { openPositions: open.length, mode: st.mode, at: new Date().toISOString() };
  // 1. Reconcile: for each open position the last trade must exist; mark stranded ones.
  const issues: string[] = [];
  for (const p of open) {
    const t = await db.select({ id: trades.id }).from(trades).where(and(eq(trades.positionId, p.id), eq(trades.side, "BUY"), eq(trades.status, "FILLED"))).limit(1);
    if (!t.length) {
      issues.push(`Position ${p.id} (${p.symbol}) has no filled BUY trade — marked INCONSISTENT`);
      await db.update(positions).set({ reconciliation: "INCONSISTENT" }).where(eq(positions.id, p.id));
    }
  }
  // 2. Paper cash sanity: recompute from trade history and compare.
  const [agg] = await db.select({ spent: sql<number>`coalesce(sum(case when side='BUY' then sol_amount else 0 end),0)`, recv: sql<number>`coalesce(sum(case when side='SELL' then sol_amount else 0 end),0)`, fees: sql<number>`coalesce(sum(fee_sol),0)` }).from(trades).where(eq(trades.mode, "PAPER"));
  const expectedCash = st.paperStartingSol - Number(agg.spent) + Number(agg.recv) - Number(agg.fees);
  if (Math.abs(expectedCash - st.paperCashSol) > 1e-6) {
    issues.push(`Paper cash ${st.paperCashSol.toFixed(6)} differs from trade-derived ${expectedCash.toFixed(6)}; corrected from ledger`);
    await patchBotState({ paperCashSol: expectedCash });
  }
  // 3. Live wallet reconciliation (only when live mode configured).
  if (st.mode === "LIVE") {
    const { liveWalletPublicKey } = await import("../execution/live");
    const pk = liveWalletPublicKey();
    if (!pk) issues.push("LIVE mode but wallet not configured — execution impossible");
    else {
      const bal = await providers().onchain.getWalletTokenBalances?.(pk);
      for (const p of open) {
        const onchain = bal?.get(p.mint) ?? 0;
        if (Math.abs(onchain - p.remainingTokens) / Math.max(p.remainingTokens, 1e-9) > 0.02) {
          issues.push(`Wallet holds ${onchain} of ${p.symbol} but DB says ${p.remainingTokens} — marked STRANDED`);
          await db.update(positions).set({ reconciliation: "STRANDED", notes: `wallet=${onchain}` }).where(eq(positions.id, p.id));
        }
      }
    }
  }
  summary.issues = issues;
  await patchBotState({ lastRecoveryAt: new Date(), lastRecoverySummary: summary, startedAt: st.startedAt ?? new Date() });
  await logger.info("recovery", `Startup recovery: ${open.length} open positions, ${issues.length} issues`, { issues });
  if (issues.length) await raiseAlert("WARNING", "RECONCILIATION", `${issues.length} reconciliation issue(s) on startup`, issues.join("\n"));
  return summary;
}

export async function recentDecisions(limit = 50) {
  return db.select().from(decisions).orderBy(desc(decisions.decidedAt)).limit(limit);
}
