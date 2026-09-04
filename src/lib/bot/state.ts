import { db } from "@/db";
import { botState, positions, portfolioSnapshots, settings as settingsTable, strategyVersions, trades, blacklist, tokens } from "@/db/schema";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { SETTING_DEFS, STRATEGY_KEYS, defaultSettings, validateSetting, type SettingsMap } from "../config/settings";
import type { PortfolioState } from "../engine/risk";
import { logger } from "../core/logger";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
let settingsCache: { value: SettingsMap; at: number } | null = null;

export async function loadSettings(force = false): Promise<SettingsMap> {
  if (!force && settingsCache && Date.now() - settingsCache.at < 10_000) return settingsCache.value;
  const rows = await db.select().from(settingsTable);
  const out = defaultSettings();
  for (const r of rows) {
    const v = validateSetting(r.key, r.value);
    if (v.ok) out[r.key] = v.value;
  }
  settingsCache = { value: out, at: Date.now() };
  return out;
}

function bumpVersion(v: string): string {
  const m = /^(.*?)(\d+)\.(\d+)$/.exec(v);
  if (!m) return "strategy_v0.2";
  return `${m[1]}${m[2]}.${Number(m[3]) + 1}`;
}

/** Validates and persists settings. Strategy-affecting changes bump STRATEGY_VERSION. */
export async function updateSettings(patch: Record<string, unknown>, actor: string): Promise<{ ok: boolean; errors: string[]; settings: SettingsMap; versionBumped?: string }> {
  const current = await loadSettings(true);
  const errors: string[] = [];
  const accepted: Record<string, number | boolean | string> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === "STRATEGY_VERSION") continue; // managed automatically
    const r = validateSetting(k, v);
    if (!r.ok) errors.push(r.error);
    else if (current[k] !== r.value) accepted[k] = r.value;
  }
  if (errors.length) return { ok: false, errors, settings: current };
  const strategyChanged = Object.keys(accepted).some((k) => STRATEGY_KEYS.includes(k));
  let versionBumped: string | undefined;
  if (strategyChanged) {
    versionBumped = bumpVersion(String(current.STRATEGY_VERSION));
    accepted.STRATEGY_VERSION = versionBumped;
  }
  for (const [key, value] of Object.entries(accepted)) {
    await db.insert(settingsTable).values({ key, value, updatedAt: new Date() }).onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
  }
  const next = await loadSettings(true);
  if (versionBumped) {
    const params = Object.fromEntries(STRATEGY_KEYS.map((k) => [k, next[k]]));
    await db.insert(strategyVersions).values({ version: versionBumped, parameters: params, description: `Changed: ${Object.keys(accepted).filter((k) => k !== "STRATEGY_VERSION").join(", ")} by ${actor}` }).onConflictDoNothing();
  }
  await logger.info("settings", `Settings updated by ${actor}`, { changed: Object.keys(accepted), versionBumped });
  return { ok: true, errors: [], settings: next, versionBumped };
}

export async function ensureStrategyVersionRecorded(s: SettingsMap) {
  const version = String(s.STRATEGY_VERSION);
  const params = Object.fromEntries(STRATEGY_KEYS.map((k) => [k, s[k]]));
  await db.insert(strategyVersions).values({ version, parameters: params, description: "Research baseline strategy" }).onConflictDoNothing();
}

export function settingDefs() {
  return SETTING_DEFS;
}

// ---------------------------------------------------------------------------
// Bot state
// ---------------------------------------------------------------------------
export type BotStateRow = typeof botState.$inferSelect;

export async function getBotState(): Promise<BotStateRow> {
  const rows = await db.select().from(botState).where(eq(botState.id, 1));
  if (rows[0]) return rows[0];
  const s = await loadSettings();
  const starting = Number(s.PAPER_STARTING_SOL);
  await db.insert(botState).values({ id: 1, paperCashSol: starting, paperStartingSol: starting, startedAt: new Date() }).onConflictDoNothing();
  return (await db.select().from(botState).where(eq(botState.id, 1)))[0];
}

export async function patchBotState(patch: Partial<Omit<BotStateRow, "id">>) {
  await getBotState();
  await db.update(botState).set({ ...patch, updatedAt: new Date() }).where(eq(botState.id, 1));
}

// ---------------------------------------------------------------------------
// Portfolio maths
// ---------------------------------------------------------------------------
export type PositionRow = typeof positions.$inferSelect;

export async function openPositions(): Promise<PositionRow[]> {
  return db.select().from(positions).where(eq(positions.status, "OPEN")).orderBy(desc(positions.openedAt));
}

export function positionValueSol(p: PositionRow): number {
  const px = p.currentPrice ?? p.entryPrice;
  return p.remainingTokens * px;
}
export function positionUnrealizedSol(p: PositionRow): number {
  const remainingCost = p.costBasisSol * (p.remainingTokens / Math.max(p.initialTokens, 1e-12));
  return positionValueSol(p) - remainingCost;
}

export async function computePortfolio(): Promise<PortfolioState & { realizedTotalSol: number; unrealizedSol: number; startingSol: number; drawdownPct: number; peakEquitySol: number }> {
  const st = await getBotState();
  const open = await openPositions();
  const exposure = open.reduce((a, p) => a + positionValueSol(p), 0);
  const unrealized = open.reduce((a, p) => a + positionUnrealizedSol(p), 0);
  const equity = st.paperCashSol + exposure;

  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekStart = new Date(now.getTime() - 7 * 86400_000);

  const realizedAll = await db.select({ v: sql<number>`coalesce(sum(${trades.realizedPnlSol}),0)`, fees: sql<number>`coalesce(sum(${trades.feeSol}),0)` }).from(trades).where(eq(trades.mode, st.mode));
  const realizedDay = await db.select({ v: sql<number>`coalesce(sum(${trades.realizedPnlSol}),0) - coalesce(sum(${trades.feeSol}),0)` }).from(trades).where(and(eq(trades.mode, st.mode), gte(trades.executedAt, dayStart)));
  const realizedWeek = await db.select({ v: sql<number>`coalesce(sum(${trades.realizedPnlSol}),0) - coalesce(sum(${trades.feeSol}),0)` }).from(trades).where(and(eq(trades.mode, st.mode), gte(trades.executedAt, weekStart)));

  const [dayBase] = await db.select().from(portfolioSnapshots).where(and(eq(portfolioSnapshots.mode, st.mode), gte(portfolioSnapshots.capturedAt, dayStart))).orderBy(portfolioSnapshots.capturedAt).limit(1);
  const [weekBase] = await db.select().from(portfolioSnapshots).where(and(eq(portfolioSnapshots.mode, st.mode), gte(portfolioSnapshots.capturedAt, weekStart))).orderBy(portfolioSnapshots.capturedAt).limit(1);
  const [peak] = await db.select({ v: sql<number>`coalesce(max(${portfolioSnapshots.equitySol}),0)` }).from(portfolioSnapshots).where(eq(portfolioSnapshots.mode, st.mode));
  const peakEquity = Math.max(Number(peak?.v ?? 0), st.paperStartingSol, equity);

  // Daily P&L = realized today + current unrealized (conservative: includes open losses).
  const dailyPnl = Number(realizedDay[0]?.v ?? 0) + unrealized;
  const weeklyPnl = Number(realizedWeek[0]?.v ?? 0) + unrealized;
  return {
    equitySol: equity,
    cashSol: st.paperCashSol,
    openPositions: open.length,
    exposureSol: exposure,
    dailyPnlSol: dailyPnl,
    weeklyPnlSol: weeklyPnl,
    dailyStartEquitySol: dayBase?.equitySol ?? st.paperStartingSol,
    weeklyStartEquitySol: weekBase?.equitySol ?? st.paperStartingSol,
    realizedTotalSol: Number(realizedAll[0]?.v ?? 0) - Number(realizedAll[0]?.fees ?? 0),
    unrealizedSol: unrealized,
    startingSol: st.paperStartingSol,
    drawdownPct: peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0,
    peakEquitySol: peakEquity,
  };
}

export async function snapshotPortfolio() {
  const p = await computePortfolio();
  const st = await getBotState();
  await db.insert(portfolioSnapshots).values({ mode: st.mode, cashSol: p.cashSol, positionsValueSol: p.exposureSol, equitySol: p.equitySol, realizedPnlSol: p.realizedTotalSol, unrealizedPnlSol: p.unrealizedSol, openPositions: p.openPositions });
  return p;
}

// ---------------------------------------------------------------------------
// Blacklist helpers
// ---------------------------------------------------------------------------
export async function isBlacklisted(mint: string, creator: string | null): Promise<boolean> {
  const addrs = creator ? [mint, creator] : [mint];
  const rows = await db.select({ a: blacklist.address }).from(blacklist).where(inArray(blacklist.address, addrs));
  if (rows.length) return true;
  const t = await db.select({ b: tokens.blacklisted }).from(tokens).where(eq(tokens.mint, mint));
  return Boolean(t[0]?.b);
}

// ---------------------------------------------------------------------------
// Performance analytics
// ---------------------------------------------------------------------------
export async function performanceReport(mode: "PAPER" | "LIVE" = "PAPER") {
  const closed = await db.select().from(positions).where(and(eq(positions.status, "CLOSED"), eq(positions.mode, mode))).orderBy(positions.closedAt);
  const n = closed.length;
  const pnl = closed.map((p) => p.realizedPnlSol - p.feesSol);
  const wins = pnl.filter((x) => x > 0), losses = pnl.filter((x) => x <= 0);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const grossWin = sum(wins), grossLoss = Math.abs(sum(losses));
  let peak = 0, equity = 0, maxDd = 0, consec = 0, maxConsec = 0;
  for (const x of pnl) {
    equity += x;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    if (x <= 0) { consec++; maxConsec = Math.max(maxConsec, consec); } else consec = 0;
  }
  const holdMin = closed.map((p) => (p.closedAt && p.openedAt ? (p.closedAt.getTime() - p.openedAt.getTime()) / 60000 : 0));
  const retPct = closed.map((p) => ((p.realizedPnlSol - p.feesSol) / Math.max(p.costBasisSol, 1e-9)) * 100);
  const bucket = <T>(items: typeof closed, keyFn: (p: (typeof closed)[number]) => T) => {
    const m = new Map<T, { n: number; pnl: number; wins: number }>();
    items.forEach((p, i) => {
      const k = keyFn(p);
      const b = m.get(k) ?? { n: 0, pnl: 0, wins: 0 };
      b.n++; b.pnl += pnl[i]; if (pnl[i] > 0) b.wins++;
      m.set(k, b);
    });
    return [...m.entries()].map(([k, v]) => ({ bucket: String(k), trades: v.n, pnlSol: v.pnl, winRate: v.n ? (v.wins / v.n) * 100 : 0 }));
  };
  const byDay = bucket(closed, (p) => (p.closedAt ?? p.openedAt).toISOString().slice(0, 10));
  const byScore = bucket(closed, (p) => { const s = p.entryScore ?? 0; return s >= 85 ? "85-100" : s >= 78 ? "78-85" : s >= 70 ? "70-78" : "<70"; });
  const byAge = bucket(closed, (p) => { const a = p.tokenAgeMinutes ?? 0; return a < 60 ? "<1h" : a < 360 ? "1-6h" : a < 1440 ? "6-24h" : ">24h"; });
  const byMcap = bucket(closed, (p) => { const m = p.entryMarketCap ?? 0; return m < 500_000 ? "<$0.5M" : m < 2_000_000 ? "$0.5-2M" : m < 10_000_000 ? "$2-10M" : ">$10M"; });
  const byLiq = bucket(closed, (p) => { const l = p.entryLiquidity ?? 0; return l < 50_000 ? "<$50k" : l < 150_000 ? "$50-150k" : l < 500_000 ? "$150-500k" : ">$500k"; });
  const byVersion = bucket(closed, (p) => p.strategyVersion);
  const byExit = bucket(closed, (p) => (p.exitReason ?? "UNKNOWN").split(":")[0]);
  const SUFFICIENT = 30;
  return {
    mode,
    sampleSize: n,
    sufficient: n >= SUFFICIENT,
    sufficiencyNote: n >= SUFFICIENT ? `Sample of ${n} closed trades. Treat results as indicative only.` : `INSUFFICIENT DATA — ${n} closed trades (need ≥ ${SUFFICIENT} for even preliminary conclusions).`,
    winRate: n ? (wins.length / n) * 100 : null,
    lossRate: n ? (losses.length / n) * 100 : null,
    avgWinSol: wins.length ? grossWin / wins.length : null,
    avgLossSol: losses.length ? -grossLoss / losses.length : null,
    avgReturnPct: n ? sum(retPct) / n : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : wins.length ? Infinity : null,
    expectancySol: n ? sum(pnl) / n : null,
    totalPnlSol: sum(pnl),
    maxDrawdownSol: maxDd,
    largestWinSol: wins.length ? Math.max(...wins) : null,
    largestLossSol: losses.length ? Math.min(...losses) : null,
    maxConsecutiveLosses: maxConsec,
    avgHoldMin: n ? sum(holdMin) / n : null,
    byDay, byScore, byAge, byMcap, byLiq, byVersion, byExit,
    equityCurve: pnl.reduce<{ i: number; equity: number }[]>((acc, x, i) => { acc.push({ i: i + 1, equity: (acc[i - 1]?.equity ?? 0) + x }); return acc; }, []),
  };
}
