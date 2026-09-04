"use client";
import { useState } from "react";
import { apiPost, Button, Card, Empty, fmtPct, fmtSol, Stat, Term, useApi, type Row } from "@/components/ui";

function BucketTable({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase text-slate-500">{title}</div>
      {!rows?.length ? <div className="text-xs text-slate-400">no data</div> : (
        <table className="w-full text-xs"><thead className="text-left text-slate-500"><tr><th>Bucket</th><th>Trades</th><th>Win %</th><th>P&L</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.bucket} className="border-t border-slate-100 tabular-nums"><td>{r.bucket}</td><td>{r.trades}</td><td>{r.winRate.toFixed(0)}%</td><td className={r.pnlSol >= 0 ? "text-emerald-700" : "text-red-700"}>{fmtSol(r.pnlSol)}</td></tr>)}</tbody></table>
      )}
    </div>
  );
}

export default function Performance() {
  const { data: perf } = useApi<Row>("performance", 30000);
  const { data: bts, reload } = useApi<Row[]>("backtests", 0);
  const [minScore, setMinScore] = useState(70);
  const [minLiq, setMinLiq] = useState(25000);
  const [trail, setTrail] = useState(20);
  const [stop, setStop] = useState(20);
  const [hours, setHours] = useState(72);
  const [name, setName] = useState("");
  const [result, setResult] = useState<Row | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const n = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? (v === Infinity ? "∞" : "—") : v.toFixed(d));
  const S = (s: Row | undefined) => !s ? null : (
    <div className="grid grid-cols-2 gap-1 text-xs md:grid-cols-5">
      <div>Trades <b>{s.trades}</b></div><div>Win <b>{n(s.winRate, 0)}%</b></div><div>Avg ret <b>{n(s.avgReturnPct, 1)}%</b></div><div>Expect. <b>{n(s.expectancySol, 4)}</b></div><div>PF <b>{n(s.profitFactor)}</b></div>
      <div>Max DD <b>{n(s.maxDrawdownSol, 4)}</b></div><div>Worst <b>{n(s.worstTradePct, 0)}%</b></div><div>Best <b>{n(s.bestTradePct, 0)}%</b></div><div>Avg hold <b>{n(s.avgHoldMin, 0)}m</b></div><div>Total <b>{n(s.totalPnlSol, 4)}</b></div>
      {!s.sufficient && <div className="col-span-full font-semibold text-amber-700">INSUFFICIENT DATA ({s.trades} trades)</div>}
    </div>
  );

  return (
    <div className="space-y-4">
      <Card title="Paper Trading Performance">
        {!perf ? <Empty>Loading…</Empty> : (
          <>
            <div className={`mb-3 rounded p-2 text-sm font-medium ${perf.sufficient ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{perf.sufficiencyNote}</div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
              <Stat label="Closed trades" value={perf.sampleSize} />
              <Stat label="Win rate" value={perf.winRate !== null ? `${perf.winRate.toFixed(0)}%` : "—"} sub="not the goal — see expectancy" />
              <Stat label={<Term t="Expectancy">Expectancy</Term>} value={fmtSol(perf.expectancySol)} tone={perf.expectancySol > 0 ? "pos" : perf.expectancySol < 0 ? "neg" : "neutral"} />
              <Stat label={<Term t="Profit Factor">Profit factor</Term>} value={perf.profitFactor === null ? "—" : perf.profitFactor === Infinity ? "∞" : perf.profitFactor.toFixed(2)} />
              <Stat label="Avg win / loss" value={`${fmtSol(perf.avgWinSol, 3)} / ${fmtSol(perf.avgLossSol, 3)}`} />
              <Stat label="Max drawdown" value={fmtSol(perf.maxDrawdownSol)} tone="neg" />
              <Stat label="Total P&L (net)" value={fmtSol(perf.totalPnlSol)} tone={perf.totalPnlSol > 0 ? "pos" : perf.totalPnlSol < 0 ? "neg" : "neutral"} />
              <Stat label="Largest win / loss" value={`${fmtSol(perf.largestWinSol, 3)} / ${fmtSol(perf.largestLossSol, 3)}`} />
              <Stat label="Max consecutive losses" value={perf.maxConsecutiveLosses} />
              <Stat label="Avg hold" value={perf.avgHoldMin !== null ? `${perf.avgHoldMin.toFixed(0)} min` : "—"} />
              <Stat label="Avg return / trade" value={fmtPct(perf.avgReturnPct)} />
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-3 xl:grid-cols-7">
              <BucketTable title="By day" rows={perf.byDay} /><BucketTable title="By entry score" rows={perf.byScore} /><BucketTable title="By token age" rows={perf.byAge} /><BucketTable title="By market cap" rows={perf.byMcap} /><BucketTable title="By liquidity" rows={perf.byLiq} /><BucketTable title="By strategy version" rows={perf.byVersion} /><BucketTable title="By exit type" rows={perf.byExit} />
            </div>
          </>
        )}
      </Card>

      <Card title="Backtest / Replay Experiments" right={<span className="text-xs text-slate-500">Replays recorded snapshots with no look-ahead; walk-forward split in-sample / out-of-sample</span>}>
        <div className="grid gap-2 md:grid-cols-6">
          <label className="text-xs">Name<input className="mt-0.5 w-full rounded border px-2 py-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Experiment #1" /></label>
          <label className="text-xs">MIN_SCORE<input type="number" className="mt-0.5 w-full rounded border px-2 py-1" value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} /></label>
          <label className="text-xs">MIN_LIQUIDITY_USD<input type="number" className="mt-0.5 w-full rounded border px-2 py-1" value={minLiq} onChange={(e) => setMinLiq(Number(e.target.value))} /></label>
          <label className="text-xs">STOP_LOSS_PCT<input type="number" className="mt-0.5 w-full rounded border px-2 py-1" value={stop} onChange={(e) => setStop(Number(e.target.value))} /></label>
          <label className="text-xs">TRAILING_STOP_PCT<input type="number" className="mt-0.5 w-full rounded border px-2 py-1" value={trail} onChange={(e) => setTrail(Number(e.target.value))} /></label>
          <label className="text-xs">Lookback hours<input type="number" className="mt-0.5 w-full rounded border px-2 py-1" value={hours} onChange={(e) => setHours(Number(e.target.value))} /></label>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button tone="primary" onClick={async () => { setErr(null); try { setResult(await apiPost("backtest", { name: name || undefined, sinceHours: hours, overrides: { MIN_SCORE: minScore, MIN_LIQUIDITY_USD: minLiq, STOP_LOSS_PCT: stop, TRAILING_STOP_PCT: trail } })); reload(); } catch (e) { setErr((e as Error).message); } }}>Run experiment</Button>
          {err && <span className="text-xs text-red-700">{err}</span>}
        </div>
        {result && (
          <div className="mt-3 space-y-2 rounded border border-slate-200 p-3">
            <div className="text-sm font-semibold">Result #{result.id} — {result.tokensCovered} tokens · {result.snapshots} snapshots · {result.candidatesSeen} candidate-snapshots · {result.entriesAttempted} entries</div>
            <div className="text-xs font-semibold text-slate-600">Overall</div>{S(result.overall)}
            <div className="text-xs font-semibold text-slate-600">In-sample (train) → {result.range?.split?.slice(0, 16)}</div>{S(result.inSample)}
            <div className="text-xs font-semibold text-slate-600">Out-of-sample (test)</div>{S(result.outOfSample)}
            <div className="rounded bg-amber-50 p-2 text-xs text-amber-900"><b>Limitations:</b><ul className="ml-4 list-disc">{(result.limitations as string[]).map((l, i) => <li key={i}>{l}</li>)}</ul></div>
          </div>
        )}
        <div className="mt-4">
          <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Previous experiments (never overwritten)</div>
          {!bts?.length ? <div className="text-xs text-slate-400">none yet</div> : (
            <table className="w-full text-xs"><thead className="text-left text-slate-500"><tr><th>#</th><th>When</th><th>Name</th><th>Overrides</th><th>Trades</th><th>Win %</th><th>Expectancy</th><th>PF</th><th>OOS trades</th><th>OOS expectancy</th></tr></thead>
              <tbody>{bts.map((b) => <tr key={b.id} className="border-t border-slate-100 tabular-nums"><td>{b.id}</td><td>{new Date(b.createdAt).toLocaleString()}</td><td>{b.name}</td><td className="max-w-[240px] truncate">{JSON.stringify(b.parameters?.overrides)}</td><td>{b.sampleSize}{b.sampleSize < 30 && <span className="text-amber-700"> (insufficient)</span>}</td><td>{n(b.results?.overall?.winRate, 0)}</td><td>{n(b.results?.overall?.expectancySol, 4)}</td><td>{n(b.results?.overall?.profitFactor)}</td><td>{b.results?.outOfSample?.trades}</td><td>{n(b.results?.outOfSample?.expectancySol, 4)}</td></tr>)}</tbody></table>
          )}
        </div>
      </Card>
    </div>
  );
}
