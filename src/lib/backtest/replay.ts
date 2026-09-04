import { db } from "@/db";
import { backtestRuns, riskAssessments, tokenSnapshots, tokens } from "@/db/schema";
import { and, asc, gte, inArray, sql } from "drizzle-orm";
import { defaultSettings, num, type SettingsMap } from "../config/settings";
import { evaluateExit } from "../engine/exits";
import { estimatePriceImpactPct } from "../engine/impact";

// ---------------------------------------------------------------------------
// Replay / backtest over recorded token_snapshots.
//
// LOOK-AHEAD PROTECTION: the simulation walks snapshots strictly in time
// order; the entry decision at time t only uses the snapshot at t and the
// most recent risk assessment with assessed_at <= t. Exit logic only sees
// snapshots after entry, one at a time.
//
// LIMITATIONS (always reported with results):
//  • Only tokens the live scanner recorded are available — survivorship and
//    selection bias relative to the whole market.
//  • Snapshot cadence (~60s) is coarse; intra-minute moves are invisible, so
//    stops/targets fill at the next snapshot price (pessimistic for TPs,
//    optimistic for gaps through stops — we apply extra slippage to mitigate).
//  • Holder / risk data is only as fresh as the last assessment before t.
// ---------------------------------------------------------------------------

export interface BacktestParams {
  name: string;
  overrides: Partial<Record<string, number>>;
  sinceHours: number;
  /** Walk-forward split: fraction of the time range used as in-sample. */
  inSampleFraction: number;
}

interface SimTrade { mint: string; symbol: string; entryAt: Date; exitAt: Date; entryScore: number; retPct: number; pnlSol: number; holdMin: number; exitReason: string; segment: "IN_SAMPLE" | "OUT_OF_SAMPLE" }

function stats(trades: SimTrade[]) {
  const n = trades.length;
  const pnl = trades.map((t) => t.pnlSol);
  const wins = pnl.filter((x) => x > 0), losses = pnl.filter((x) => x <= 0);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  let peak = 0, eq = 0, dd = 0;
  for (const x of pnl) { eq += x; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return {
    trades: n,
    winRate: n ? (wins.length / n) * 100 : null,
    avgReturnPct: n ? sum(trades.map((t) => t.retPct)) / n : null,
    expectancySol: n ? sum(pnl) / n : null,
    profitFactor: losses.length && sum(losses) !== 0 ? sum(wins) / Math.abs(sum(losses)) : null,
    maxDrawdownSol: dd,
    worstTradePct: n ? Math.min(...trades.map((t) => t.retPct)) : null,
    bestTradePct: n ? Math.max(...trades.map((t) => t.retPct)) : null,
    avgHoldMin: n ? sum(trades.map((t) => t.holdMin)) / n : null,
    totalPnlSol: sum(pnl),
    sufficient: n >= 30,
  };
}

export async function runBacktest(params: BacktestParams) {
  const s: SettingsMap = { ...defaultSettings() };
  for (const [k, v] of Object.entries(params.overrides)) if (typeof v === "number" && Number.isFinite(v)) s[k] = v;
  const since = new Date(Date.now() - params.sinceHours * 3600_000);
  const snaps = await db.select().from(tokenSnapshots).where(gte(tokenSnapshots.capturedAt, since)).orderBy(asc(tokenSnapshots.capturedAt));
  const mints = [...new Set(snaps.map((x) => x.mint))];
  const risks = mints.length ? await db.select().from(riskAssessments).where(and(inArray(riskAssessments.mint, mints), gte(riskAssessments.assessedAt, new Date(since.getTime() - 3600_000)))).orderBy(asc(riskAssessments.assessedAt)) : [];
  const tokenRows = mints.length ? await db.select({ mint: tokens.mint, symbol: tokens.symbol, launch: tokens.launchTime }).from(tokens).where(inArray(tokens.mint, mints)) : [];
  const symbol = new Map(tokenRows.map((t) => [t.mint, t.symbol ?? "?"]));
  const launch = new Map(tokenRows.map((t) => [t.mint, t.launch]));
  const byMint = new Map<string, typeof snaps>();
  for (const x of snaps) { const a = byMint.get(x.mint) ?? []; a.push(x); byMint.set(x.mint, a); }
  const risksByMint = new Map<string, typeof risks>();
  for (const r of risks) { const a = risksByMint.get(r.mint) ?? []; a.push(r); risksByMint.set(r.mint, a); }

  const t0 = snaps[0]?.capturedAt.getTime() ?? Date.now();
  const t1 = snaps.at(-1)?.capturedAt.getTime() ?? Date.now();
  const split = t0 + (t1 - t0) * params.inSampleFraction;
  const sizeSol = num(s, "MAX_TRADE_SIZE_SOL");
  const fee = num(s, "PAPER_FEE_SOL");
  const trades: SimTrade[] = [];
  let candidatesSeen = 0, entriesAttempted = 0;

  for (const [mint, series] of byMint) {
    const rs = risksByMint.get(mint) ?? [];
    let i = 0;
    while (i < series.length) {
      const snap = series[i];
      // latest risk assessment known at time t (no look-ahead)
      const known = rs.filter((r) => r.assessedAt.getTime() <= snap.capturedAt.getTime()).at(-1);
      candidatesSeen++;
      const price = snap.price ?? 0;
      const L = snap.liquidity ?? 0;
      const ageMin = launch.get(mint) ? (snap.capturedAt.getTime() - launch.get(mint)!.getTime()) / 60000 : null;
      const ok =
        known?.passed &&
        price > 0 &&
        (snap.overallScore ?? 0) >= num(s, "MIN_SCORE") &&
        L >= num(s, "MIN_LIQUIDITY_USD") &&
        (snap.volume1h ?? 0) >= num(s, "MIN_VOLUME_1H_USD") &&
        (snap.priceChange1h ?? 0) <= num(s, "MAX_PRICE_CHANGE_1H_PCT") &&
        (snap.priceChange5m ?? 0) <= 12 &&
        (ageMin === null || (ageMin >= num(s, "MIN_TOKEN_AGE_MIN") && ageMin <= num(s, "MAX_TOKEN_AGE_MIN")));
      if (!ok) { i++; continue; }
      entriesAttempted++;
      // Entry with impact + slippage
      const impact = estimatePriceImpactPct(sizeSol * 150, L); // assume ~$150/SOL if unknown; conservative
      const entryPrice = price * (1 + (impact + 0.4) / 100);
      const tokensHeld = sizeSol / entryPrice;
      let remaining = tokensHeld, initial = tokensHeld, highest = entryPrice, trailing: number | null = null, realized = -fee;
      const taken: number[] = [];
      let exitReason = "END_OF_DATA", j = i + 1, exitAt = snap.capturedAt;
      for (; j < series.length; j++) {
        const cur = series[j];
        const p = cur.price ?? 0;
        if (p <= 0) continue;
        highest = Math.max(highest, p);
        const act = evaluateExit(
          { entryPrice, highestPrice: highest, remainingTokens: remaining, initialTokens: initial, takenLevels: taken, openedAt: snap.capturedAt, entryLiquidityUsd: L, trailingStopPrice: trailing },
          { price: p, liquidityUsd: cur.liquidity, priceChange5m: cur.priceChange5m, buys5m: cur.buys5m ?? 0, sells5m: cur.sells5m ?? 0, dataAgeSec: 0, now: cur.capturedAt },
          s,
        );
        trailing = act.newTrailingStop ?? trailing;
        if (act.action === "SELL") {
          const sellTokens = remaining * (act.sellFraction ?? 1);
          const slip = act.urgent ? 3 : 0.6;
          const px = p * (1 - (estimatePriceImpactPct(sellTokens * p * 150, cur.liquidity ?? L) + slip) / 100);
          realized += sellTokens * px - sellTokens * entryPrice - fee;
          remaining -= sellTokens;
          if (act.tpLevel) taken.push(act.tpLevel);
          exitAt = cur.capturedAt;
          if (remaining <= initial * 0.001) { exitReason = act.kind ?? "SELL"; break; }
        }
      }
      if (remaining > initial * 0.001) {
        const last = series.at(-1)!;
        realized += remaining * (last.price ?? entryPrice) * 0.99 - remaining * entryPrice;
        exitAt = last.capturedAt;
        remaining = 0;
      }
      trades.push({ mint, symbol: symbol.get(mint) ?? "?", entryAt: snap.capturedAt, exitAt, entryScore: snap.overallScore ?? 0, retPct: (realized / sizeSol) * 100, pnlSol: realized, holdMin: (exitAt.getTime() - snap.capturedAt.getTime()) / 60000, exitReason, segment: snap.capturedAt.getTime() <= split ? "IN_SAMPLE" : "OUT_OF_SAMPLE" });
      // cooldown: skip forward past exit
      i = Math.max(j + 1, i + 1);
      while (i < series.length && series[i].capturedAt.getTime() < exitAt.getTime() + num(s, "TOKEN_COOLDOWN_MIN") * 60000) i++;
    }
  }

  const limitations = [
    `Data covers ${mints.length} tokens / ${snaps.length} snapshots recorded by this instance since ${since.toISOString()} — not the whole market (selection bias).`,
    "Snapshot cadence ≈ scan interval; intra-interval price paths are invisible. Stops may fill worse in reality.",
    "Price impact/slippage are modelled from pool maths, not from a router; SOL price assumed ≈ $150 for impact sizing.",
    "Risk data is frozen at the last assessment before each simulated decision (no look-ahead), so late-emerging rugs may look tradeable at entry — as they would have live.",
    trades.length < 30 ? "INSUFFICIENT DATA: fewer than 30 simulated trades. Do not draw conclusions." : "Sample ≥ 30 but still small; treat as indicative only.",
  ];
  const results = {
    overall: stats(trades),
    inSample: stats(trades.filter((t) => t.segment === "IN_SAMPLE")),
    outOfSample: stats(trades.filter((t) => t.segment === "OUT_OF_SAMPLE")),
    candidatesSeen,
    entriesAttempted,
    tokensCovered: mints.length,
    snapshots: snaps.length,
    range: { from: new Date(t0).toISOString(), to: new Date(t1).toISOString(), split: new Date(split).toISOString() },
    trades: trades.slice(0, 200).map((t) => ({ ...t, entryAt: t.entryAt.toISOString(), exitAt: t.exitAt.toISOString() })),
  };
  const [row] = await db.insert(backtestRuns).values({ name: params.name, parameters: { overrides: params.overrides, sinceHours: params.sinceHours, inSampleFraction: params.inSampleFraction }, results, limitations, sampleSize: trades.length }).returning();
  return { id: row.id, ...results, limitations };
}

export async function listBacktests() {
  return db.select().from(backtestRuns).orderBy(sql`created_at desc`).limit(50);
}
