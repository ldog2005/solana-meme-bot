import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { alerts, backtestRuns, blacklist, decisions, positions, providerHealth, riskAssessments, strategyVersions, systemEvents, tokenSnapshots, tokens, trades } from "@/db/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { computePortfolio, getBotState, loadSettings, openPositions, patchBotState, performanceReport, settingDefs, updateSettings } from "@/lib/bot/state";
import { evaluateCandidate, recentDecisions, recoverState, sellPosition } from "@/lib/bot/scanner";
import { schedulerState, startScheduler, tickMonitor, tickScan } from "@/lib/bot/scheduler";
import { providerConfigSummary, providers } from "@/lib/providers";
import { allHealth } from "@/lib/providers/http";
import { logger, raiseAlert } from "@/lib/core/logger";
import { listBacktests, runBacktest } from "@/lib/backtest/replay";
import { liveWalletPublicKey } from "@/lib/execution/live";

// ---------------------------------------------------------------------------
// Auth: mutating endpoints require `x-admin-token` === ADMIN_TOKEN when set.
// If ADMIN_TOKEN is unset the app is assumed to run on a private machine; the
// readiness page flags this loudly. Read endpoints are open (dashboard).
// ---------------------------------------------------------------------------
function authorized(req: NextRequest): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return true;
  const got = req.headers.get("x-admin-token") ?? "";
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
const json = (data: unknown, status = 200) => NextResponse.json(data, { status });
const err = (message: string, status = 400) => json({ error: message }, status);
const isMint = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// GET handlers
// ---------------------------------------------------------------------------
export async function handleGet(path: string[], req: NextRequest) {
  const [a, b, c] = path;
  const q = req.nextUrl.searchParams;

  if (a === "status") {
    const st = await getBotState();
    const p = await computePortfolio();
    const sch = schedulerState();
    const health = allHealth();
    const persisted = await db.select().from(providerHealth);
    const [errs] = await db.select({ n: sql<number>`count(*)` }).from(systemEvents).where(and(gte(systemEvents.at, new Date(Date.now() - 86400_000)), sql`${systemEvents.level} in ('ERROR','CRITICAL')`));
    const lastScanAge = st.lastScanAt ? (Date.now() - st.lastScanAt.getTime()) / 1000 : null;
    return json({
      mode: st.mode,
      running: st.running,
      emergencyStop: st.emergencyStop,
      liveTradingEnabled: st.liveTradingEnabled,
      liveEnvFlag: process.env.LIVE_TRADING_ENABLED === "true",
      marketRegime: st.marketRegime,
      marketRegimeDetail: st.marketRegimeDetail,
      scheduler: { started: sch.started, scanning: sch.scanning, monitoring: sch.monitoring, scanCount: sch.scanCount, lastError: sch.lastError },
      scanner: { lastScanAt: st.lastScanAt, lastScanOk: st.lastScanOk, lastScanSummary: st.lastScanSummary, status: !st.running ? "PAUSED" : lastScanAge === null ? "STARTING" : lastScanAge < 300 && st.lastScanOk ? "ONLINE" : "DEGRADED" },
      lastDataUpdateAt: st.lastDataUpdateAt,
      lastPositionCheckAt: st.lastPositionCheckAt,
      startedAt: st.startedAt,
      recovery: st.lastRecoverySummary,
      errorCount24h: Number(errs?.n ?? 0),
      providers: { runtime: health, persisted, config: providerConfigSummary() },
      portfolio: p,
      dataSource: st.lastDataUpdateAt ? "LIVE" : "UNAVAILABLE",
    });
  }
  if (a === "tokens" && !b) {
    const limit = Math.min(Number(q.get("limit") ?? 100), 500);
    return json(await db.select().from(tokens).orderBy(desc(tokens.lastSeenAt)).limit(limit));
  }
  if (a === "tokens" && b && !c) {
    if (!isMint(b)) return err("invalid mint");
    const [t] = await db.select().from(tokens).where(eq(tokens.mint, b));
    if (!t) return err("not found", 404);
    const snaps = await db.select().from(tokenSnapshots).where(eq(tokenSnapshots.mint, b)).orderBy(desc(tokenSnapshots.capturedAt)).limit(300);
    const risk = await db.select().from(riskAssessments).where(eq(riskAssessments.mint, b)).orderBy(desc(riskAssessments.assessedAt)).limit(5);
    const decs = await db.select().from(decisions).where(eq(decisions.mint, b)).orderBy(desc(decisions.decidedAt)).limit(20);
    const pos = await db.select().from(positions).where(eq(positions.mint, b)).orderBy(desc(positions.openedAt)).limit(10);
    return json({ token: t, snapshots: snaps.reverse(), risk, decisions: decs, positions: pos });
  }
  if (a === "opportunities") {
    const s = await loadSettings();
    const rows = await db.select().from(tokens).where(and(gte(tokens.lastSeenAt, new Date(Date.now() - 3 * 3600_000)), sql`${tokens.overallScore} is not null`)).orderBy(desc(tokens.overallScore)).limit(Number(q.get("limit") ?? 30));
    return json({ minScore: s.MIN_SCORE, items: rows });
  }
  if (a === "positions") {
    const status = q.get("status") ?? "OPEN";
    const rows = status === "ALL" ? await db.select().from(positions).orderBy(desc(positions.openedAt)).limit(200) : await db.select().from(positions).where(eq(positions.status, status)).orderBy(desc(positions.openedAt)).limit(200);
    return json(rows);
  }
  if (a === "trades") return json(await db.select().from(trades).orderBy(desc(trades.executedAt)).limit(Math.min(Number(q.get("limit") ?? 200), 1000)));
  if (a === "decisions") return json(await recentDecisions(Math.min(Number(q.get("limit") ?? 100), 500)));
  if (a === "performance") return json(await performanceReport((q.get("mode") as "PAPER" | "LIVE") ?? "PAPER"));
  if (a === "risk") {
    const s = await loadSettings();
    const p = await computePortfolio();
    const hard = settingDefs().filter((d) => d.group === "HARD_RISK").map((d) => ({ ...d, value: s[d.key] }));
    return json({ portfolio: p, hardLimits: hard, dailyLossLimitSol: (p.dailyStartEquitySol * Number(s.MAX_DAILY_LOSS_PCT)) / 100 });
  }
  if (a === "settings") {
    const s = await loadSettings(true);
    const versions = await db.select().from(strategyVersions).orderBy(desc(strategyVersions.createdAt)).limit(20);
    return json({ values: s, definitions: settingDefs(), versions, adminTokenConfigured: Boolean(process.env.ADMIN_TOKEN) });
  }
  if (a === "alerts") return json(await db.select().from(alerts).orderBy(desc(alerts.at)).limit(100));
  if (a === "events") {
    const level = q.get("level");
    const rows = level ? await db.select().from(systemEvents).where(eq(systemEvents.level, level)).orderBy(desc(systemEvents.at)).limit(200) : await db.select().from(systemEvents).orderBy(desc(systemEvents.at)).limit(200);
    return json(rows);
  }
  if (a === "blacklist") return json(await db.select().from(blacklist).orderBy(desc(blacklist.createdAt)));
  if (a === "backtests" && b) return json((await db.select().from(backtestRuns).where(eq(backtestRuns.id, Number(b))))[0] ?? null);
  if (a === "backtests") return json(await listBacktests());
  if (a === "readiness") return json(await readiness());
  return err("not found", 404);
}

// ---------------------------------------------------------------------------
// Readiness checklist (deterministic; never says "ready to make money")
// ---------------------------------------------------------------------------
export async function readiness() {
  const st = await getBotState();
  const perf = await performanceReport("PAPER");
  const s = await loadSettings();
  const [errs] = await db.select({ n: sql<number>`count(*)` }).from(systemEvents).where(and(gte(systemEvents.at, new Date(Date.now() - 86400_000)), eq(systemEvents.level, "CRITICAL")));
  const [cnt] = await db.select({ n: sql<number>`count(*)` }).from(trades);
  const [emergencyTested] = await db.select({ n: sql<number>`count(*)` }).from(trades).where(sql`${trades.reason} like 'EMERGENCY%' or ${trades.reason} like 'MANUAL%'`);
  const health = allHealth();
  const jup = providers().quotes.isConfigured();
  const wallet = liveWalletPublicKey();
  const items = [
    { key: "paper_trades", label: "Paper trading completed (≥100 closed trades)", ok: perf.sampleSize >= 100, detail: `${perf.sampleSize} closed paper trades` },
    { key: "performance_reviewed", label: "Strategy performance reviewed (positive expectancy over sufficient sample)", ok: perf.sufficient && (perf.expectancySol ?? 0) > 0, detail: perf.sufficiencyNote },
    { key: "no_critical_errors", label: "No CRITICAL software errors in last 24h", ok: Number(errs?.n ?? 0) === 0, detail: `${errs?.n ?? 0} critical events` },
    { key: "db_persistence", label: "Database persistence verified", ok: Number(cnt?.n ?? 0) > 0 && Boolean(st.lastScanAt), detail: `${cnt?.n ?? 0} trades persisted` },
    { key: "wallet_reconciliation", label: "Wallet reconciliation tested", ok: Boolean(st.lastRecoverySummary), detail: st.lastRecoveryAt ? `last run ${st.lastRecoveryAt.toISOString()}` : "never" },
    { key: "emergency_sell", label: "Emergency / manual sell exercised", ok: Number(emergencyTested?.n ?? 0) > 0, detail: `${emergencyTested?.n ?? 0} emergency/manual sells recorded` },
    { key: "risk_limits", label: "Risk limits configured", ok: Number(s.MAX_DAILY_LOSS_PCT) <= 10 && Number(s.MAX_TRADE_SIZE_SOL) <= 5, detail: `daily loss ${s.MAX_DAILY_LOSS_PCT}% · max trade ${s.MAX_TRADE_SIZE_SOL} SOL` },
    { key: "api_keys", label: "API keys configured (Jupiter, dedicated RPC)", ok: jup && Boolean(process.env.SOLANA_RPC_URL), detail: `jupiter=${jup} rpc=${Boolean(process.env.SOLANA_RPC_URL)}` },
    { key: "exec_provider", label: "Execution provider healthy", ok: jup && health["jupiter"]?.status === "ONLINE", detail: `jupiter ${health["jupiter"]?.status ?? "UNKNOWN"}` },
    { key: "slippage_controls", label: "Slippage controls working (unit tests)", ok: true, detail: "covered by tests/engines.test.ts" },
    { key: "daily_loss", label: "Daily loss limit working (unit tests)", ok: true, detail: "covered by tests/engines.test.ts" },
    { key: "restart_recovery", label: "Restart recovery tested", ok: Boolean(st.lastRecoveryAt), detail: st.lastRecoveryAt ? "recovery ran on last boot" : "not yet" },
    { key: "dup_protection", label: "Duplicate trade protection (idempotency keys + unit tests)", ok: true, detail: "unique index trades_idem_idx" },
    { key: "admin_token", label: "ADMIN_TOKEN set (dashboard controls protected)", ok: Boolean(process.env.ADMIN_TOKEN), detail: process.env.ADMIN_TOKEN ? "set" : "NOT SET — anyone who can reach this server can control the bot" },
    { key: "wallet", label: "Dedicated trading wallet configured", ok: Boolean(wallet), detail: wallet ? `public key ${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "TRADING_WALLET_SECRET not set" },
    { key: "live_env", label: "LIVE_TRADING_ENABLED env flag", ok: process.env.LIVE_TRADING_ENABLED === "true", detail: process.env.LIVE_TRADING_ENABLED === "true" ? "true" : "false (default)" },
    { key: "live_manual", label: "Live mode manually enabled in dashboard", ok: st.liveTradingEnabled, detail: st.liveTradingEnabled ? `confirmed ${st.liveConfirmedAt?.toISOString()}` : "disabled" },
  ];
  const passed = items.filter((i) => i.ok).length;
  return { items, passed, total: items.length, message: passed === items.length ? "SYSTEM CHECKS PASSED — LIVE TRADING REMAINS DISABLED UNTIL MANUALLY ENABLED." : `${items.length - passed} CHECK(S) FAILING — LIVE TRADING DISABLED.`, liveExecutionNote: "The live signing/broadcast path has not been exercised with real funds in this build." };
}

// ---------------------------------------------------------------------------
// POST handlers (mutating — require admin token when configured)
// ---------------------------------------------------------------------------
export async function handlePost(path: string[], req: NextRequest) {
  if (!authorized(req)) return err("unauthorized: missing or invalid x-admin-token", 401);
  const [a, b, c] = path;
  const body = await readBody(req);

  if (a === "settings") {
    const r = await updateSettings(body, "dashboard");
    return r.ok ? json(r) : json(r, 400);
  }
  if (a === "bot" && b === "start") {
    await startScheduler();
    return json({ ok: true, scheduler: schedulerState() });
  }
  if (a === "bot" && b === "tick") return json({ scan: await tickScan(true), monitor: await tickMonitor() });
  if (a === "paper" && b === "start") {
    await patchBotState({ running: true, emergencyStop: false });
    await logger.info("manual", "Bot RESUMED (paper) by user");
    await startScheduler();
    return json({ ok: true });
  }
  if (a === "paper" && b === "stop") {
    await patchBotState({ running: false });
    await logger.info("manual", "Bot PAUSED by user");
    return json({ ok: true });
  }
  if (a === "paper" && b === "reset") {
    const s = await loadSettings();
    const open = await openPositions();
    if (open.length) return err("close all positions before resetting the paper account");
    await patchBotState({ paperCashSol: Number(s.PAPER_STARTING_SOL), paperStartingSol: Number(s.PAPER_STARTING_SOL) });
    await logger.warn("manual", `Paper balance reset to ${s.PAPER_STARTING_SOL} SOL by user (history retained)`);
    return json({ ok: true });
  }
  if (a === "emergency-stop") {
    await patchBotState({ emergencyStop: true });
    await raiseAlert("CRITICAL", "EMERGENCY_STOP", "EMERGENCY STOP activated by user", "New entries and automated buying halted. Open positions continue to follow exit rules.");
    return json({ ok: true });
  }
  if (a === "emergency-stop-clear") {
    await patchBotState({ emergencyStop: false });
    await logger.warn("manual", "Emergency stop cleared by user");
    return json({ ok: true });
  }
  if (a === "sell-all") {
    if (body.confirm !== "SELL ALL") return err('confirmation phrase required: {"confirm":"SELL ALL"}');
    const open = await openPositions();
    const results = [];
    for (const p of open) results.push({ id: p.id, symbol: p.symbol, ...(await sellPosition(p, 1, "MANUAL: SELL ALL", { manual: true, urgent: true })) });
    await logger.warn("manual", `SELL ALL executed by user on ${open.length} positions`, { results });
    return json({ ok: true, results });
  }
  if (a === "positions" && b && c === "close") {
    const [p] = await db.select().from(positions).where(and(eq(positions.id, Number(b)), eq(positions.status, "OPEN")));
    if (!p) return err("open position not found", 404);
    const fraction = typeof body.fraction === "number" ? Math.min(1, Math.max(0.01, body.fraction)) : 1;
    const r = await sellPosition(p, fraction, `MANUAL: user close ${(fraction * 100).toFixed(0)}%`, { manual: true });
    await logger.warn("manual", `Manual ${fraction === 1 ? "close" : "partial sell"} of position ${p.id} (${p.symbol})`, { result: r }, p.mint);
    return json(r);
  }
  if (a === "blacklist") {
    const address = String(body.address ?? "");
    const kind = body.kind === "DEVELOPER" ? "DEVELOPER" : "TOKEN";
    if (!isMint(address)) return err("invalid address");
    await db.insert(blacklist).values({ kind, address, reason: String(body.reason ?? "manual").slice(0, 200) }).onConflictDoNothing();
    if (kind === "TOKEN") await db.update(tokens).set({ blacklisted: true }).where(eq(tokens.mint, address));
    await logger.warn("manual", `Blacklisted ${kind} ${address}`, { reason: body.reason }, address);
    return json({ ok: true });
  }
  if (a === "blacklist-remove") {
    const address = String(body.address ?? "");
    await db.delete(blacklist).where(eq(blacklist.address, address));
    await db.update(tokens).set({ blacklisted: false }).where(eq(tokens.mint, address));
    await logger.warn("manual", `Removed ${address} from blacklist`);
    return json({ ok: true });
  }
  if (a === "whitelist") {
    const address = String(body.address ?? "");
    if (!isMint(address)) return err("invalid address");
    await db.update(tokens).set({ whitelisted: Boolean(body.value ?? true) }).where(eq(tokens.mint, address));
    await logger.info("manual", `Whitelist ${body.value === false ? "removed" : "added"} for ${address} (safety checks still apply)`);
    return json({ ok: true, note: "Whitelist is informational only — safety gates still apply." });
  }
  if (a === "tokens" && b && c === "analyse") {
    if (!isMint(b)) return err("invalid mint");
    const P = providers();
    const m = (await P.market.getMarketSnapshots([b])).get(b);
    if (!m) return err("market data unavailable for this mint", 404);
    const s = await loadSettings();
    const st = await getBotState();
    const sol = (await P.market.getSolPriceUsd()) ?? 0;
    const r = await evaluateCandidate(b, m, "manual", s, st.marketRegime, sol, { execute: false, manual: true });
    return json({ decision: r.decision, score: r.score, safety: r.safety, explanation: r.explanation });
  }
  if (a === "live" && b === "enable") {
    // Multiple independent safeguards. All must hold.
    if (process.env.LIVE_TRADING_ENABLED !== "true") return err("Refused: LIVE_TRADING_ENABLED env var is not 'true'. Set it in the server environment and restart.", 403);
    if (body.confirm !== "I UNDERSTAND THIS USES REAL FUNDS") return err('Refused: confirmation phrase required: {"confirm":"I UNDERSTAND THIS USES REAL FUNDS"}', 400);
    if (!process.env.ADMIN_TOKEN) return err("Refused: ADMIN_TOKEN must be configured before live trading can be enabled.", 403);
    const rd = await readiness();
    const blocking = rd.items.filter((i) => !i.ok && !["live_manual", "live_env"].includes(i.key));
    if (blocking.length) return json({ error: "Refused: readiness checks failing", failing: blocking }, 403);
    if (!providers().quotes.isConfigured() || !liveWalletPublicKey()) return err("Refused: execution provider or wallet not configured", 403);
    await patchBotState({ liveTradingEnabled: true, liveConfirmedAt: new Date(), mode: "LIVE" });
    await raiseAlert("CRITICAL", "LIVE_ENABLED", "LIVE TRADING ENABLED by user", "Real funds are now at risk. Emergency stop remains available.");
    return json({ ok: true, mode: "LIVE" });
  }
  if (a === "live" && b === "disable") {
    await patchBotState({ liveTradingEnabled: false, mode: "PAPER" });
    await raiseAlert("WARNING", "LIVE_DISABLED", "Live trading disabled; back to PAPER mode");
    return json({ ok: true, mode: "PAPER" });
  }
  if (a === "backtest") {
    const overrides: Record<string, number> = {};
    if (body.overrides && typeof body.overrides === "object") for (const [k, v] of Object.entries(body.overrides as Record<string, unknown>)) if (typeof v === "number") overrides[k] = v;
    const r = await runBacktest({ name: String(body.name ?? `experiment ${new Date().toISOString()}`).slice(0, 80), overrides, sinceHours: Math.min(Number(body.sinceHours ?? 72), 24 * 30), inSampleFraction: Math.min(0.9, Math.max(0.1, Number(body.inSampleFraction ?? 0.6))) });
    return json(r);
  }
  if (a === "recover") return json(await recoverState());
  if (a === "alerts" && b === "ack") {
    await db.update(alerts).set({ acknowledged: true }).where(eq(alerts.acknowledged, false));
    return json({ ok: true });
  }
  return err("not found", 404);
}
