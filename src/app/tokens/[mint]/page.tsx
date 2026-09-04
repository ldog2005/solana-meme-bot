"use client";
import { use, useState } from "react";
import { apiPost, Badge, Button, Card, Empty, Explanation, fmtAge, fmtPct, fmtPrice, fmtSol, fmtTime, fmtUsd, ScoreBar, Stat, Term, useApi, type Row } from "@/components/ui";

function Spark({ points, color = "#4f46e5", height = 120 }: { points: (number | null)[]; color?: string; height?: number }) {
  const vals = points.filter((v): v is number => v !== null && Number.isFinite(v));
  if (vals.length < 2) return <div className="text-xs text-slate-400">Not enough snapshots yet.</div>;
  const min = Math.min(...vals), max = Math.max(...vals);
  const w = 600;
  const d = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${height - ((v - min) / (max - min || 1)) * (height - 8) - 4}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="h-32 w-full" preserveAspectRatio="none">
      <polyline fill="none" stroke={color} strokeWidth="2" points={d} />
    </svg>
  );
}

export default function TokenPage({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = use(params);
  const { data, error, reload } = useApi<{ token: Row; snapshots: Row[]; risk: Row[]; decisions: Row[]; positions: Row[] }>(`tokens/${mint}`, 20000);
  const [analysis, setAnalysis] = useState<Row | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <Empty>{error}</Empty>;
  if (!data) return <Empty>Loading…</Empty>;
  const { token: t, snapshots, risk, decisions, positions } = data;
  const last = snapshots.at(-1);
  const r = risk[0];
  const flags = (r?.flags ?? []) as { code: string; severity: string; message: string }[];
  const latestDecision = decisions[0];
  const scores = (latestDecision?.scores ?? last?.scores ?? []) as { key: string; label: string; points: number; max: number; reasons: string[] }[];
  const holders = flags.length ? null : null;
  void holders;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">{t.symbol} <span className="text-base font-normal text-slate-500">{t.name}</span></h1>
        <Badge v={t.riskLevel} /> <Badge v={t.lastDecision ?? t.tradeStatus} /> {t.blacklisted && <Badge v="BLACKLISTED" className="bg-red-600 text-white" />}
        <code className="rounded bg-slate-200 px-1.5 py-0.5 text-xs">{t.mint}</code>
        <a className="text-xs text-indigo-600 hover:underline" target="_blank" rel="noreferrer" href={`https://dexscreener.com/solana/${t.pairAddress ?? t.mint}`}>DexScreener ↗</a>
        <a className="text-xs text-indigo-600 hover:underline" target="_blank" rel="noreferrer" href={`https://rugcheck.xyz/tokens/${t.mint}`}>RugCheck ↗</a>
        <div className="ml-auto flex gap-2">
          <Button small onClick={async () => { try { setAnalysis(await apiPost(`tokens/${mint}/analyse`)); setMsg(null); reload(); } catch (e) { setMsg((e as Error).message); } }}>Re-analyse now</Button>
          <Button small tone="danger" onClick={async () => { if (confirm("Blacklist this token? It can never be auto-traded.")) { await apiPost("blacklist", { address: mint, kind: "TOKEN", reason: "manual from token page" }); reload(); } }}>Blacklist</Button>
        </div>
      </div>
      {msg && <div className="rounded bg-red-50 p-2 text-xs text-red-700">{msg}</div>}

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="Price (SOL)" value={fmtPrice(t.price)} />
        <Stat label={<Term t="Market Cap">Market cap</Term>} value={fmtUsd(t.marketCap)} />
        <Stat label={<Term t="Liquidity">Liquidity</Term>} value={fmtUsd(t.liquidity)} />
        <Stat label="Volume 1h" value={fmtUsd(t.volume1h)} />
        <Stat label={<Term t="Age">Age</Term>} value={fmtAge(t.launchTime)} />
        <Stat label="Holders" value={t.holderCount ?? "—"} />
        <Stat label={<Term t="Safety">Safety</Term>} value={`${t.safetyScore ?? "—"}/30`} />
        <Stat label={<Term t="Score">Score</Term>} value={`${t.overallScore ?? "—"}/100`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Price (SOL) — recorded snapshots"><Spark points={snapshots.map((s) => s.price)} /><div className="text-[11px] text-slate-500">{snapshots.length} snapshots · {fmtTime(snapshots[0]?.capturedAt)} → {fmtTime(last?.capturedAt)}</div></Card>
        <Card title="Liquidity (USD) and 5m volume">
          <Spark points={snapshots.map((s) => s.liquidity)} color="#0891b2" height={60} />
          <Spark points={snapshots.map((s) => s.volume5m)} color="#f59e0b" height={60} />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Bot Decision & Reasoning">
          {analysis ? <><Badge v={analysis.decision?.decision} /> <Explanation text={analysis.explanation} /></> : latestDecision ? <><div className="mb-2 flex items-center gap-2"><Badge v={latestDecision.decision} /><Badge v={latestDecision.classification} /><span className="text-xs text-slate-500">{fmtTime(latestDecision.decidedAt)} · {latestDecision.strategyVersion} · regime {latestDecision.marketRegime}</span></div><Explanation text={latestDecision.explanation} /></> : <Empty>Not yet deep-analysed (pre-filtered: {t.lastDecisionReason ?? "n/a"}).</Empty>}
        </Card>

        <Card title="Score Breakdown">
          {!scores.length ? <Empty>No score yet.</Empty> : (
            <div className="space-y-2">
              {scores.map((c) => (
                <div key={c.key}>
                  <div className="flex items-center justify-between text-sm"><Term t={c.label}>{c.label}</Term><ScoreBar points={c.points} max={c.max} /></div>
                  <ul className="ml-4 list-disc text-[11px] text-slate-600">{c.reasons.slice(0, 4).map((x, i) => <li key={i}>{x}</li>)}</ul>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title={<>Risk Assessment {r && <Badge v={r.riskLevel} />}</>}>
          {!r ? <Empty>No risk assessment yet.</Empty> : (
            <div className="space-y-2 text-sm">
              <div className="grid grid-cols-2 gap-1 text-xs">
                <div><Term t="Mint Authority">Mint authority</Term>: <b className={r.mintAuthority === "REVOKED" ? "text-emerald-700" : "text-red-700"}>{r.mintAuthority}</b></div>
                <div><Term t="Freeze Authority">Freeze authority</Term>: <b className={r.freezeAuthority === "REVOKED" ? "text-emerald-700" : "text-red-700"}>{r.freezeAuthority}</b></div>
                <div><Term t="LP Locked">LP locked</Term>: <b>{r.lpLockedPct !== null ? `${Number(r.lpLockedPct).toFixed(0)}%` : "UNKNOWN"}</b></div>
                <div><Term t="Holder Concentration">Top holder</Term>: <b>{r.topHolderPct !== null ? `${Number(r.topHolderPct).toFixed(1)}%` : "?"}</b> · Top-10: <b>{r.top10Pct !== null ? `${Number(r.top10Pct).toFixed(1)}%` : "?"}</b></div>
                <div>Developer holds: <b>{r.creatorPct !== null ? `${Number(r.creatorPct).toFixed(1)}%` : "unknown"}</b></div>
                <div>Gate: <b className={r.passed ? "text-emerald-700" : "text-red-700"}>{r.passed ? "PASSED" : "FAILED"}</b> · sources: {(r.providers as string[])?.join(", ")}</div>
              </div>
              {t.creator && <div className="text-[11px] text-slate-500">Deployer: <code>{t.creator}</code> <button className="text-red-600 hover:underline" onClick={async () => { if (confirm("Blacklist this developer wallet?")) await apiPost("blacklist", { address: t.creator, kind: "DEVELOPER", reason: `dev of ${t.symbol}` }); }}>blacklist dev</button></div>}
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {flags.length === 0 && <div className="text-xs text-emerald-700">No flags raised by available checks (this is not a guarantee of safety).</div>}
                {flags.map((f, i) => <div key={i} className="flex gap-2 text-xs"><Badge v={f.severity === "MEDIUM" ? "MODERATE" : f.severity} /><span>{f.message}</span></div>)}
              </div>
              <div className="text-[11px] text-slate-400">Assessed {fmtTime(r.assessedAt)}</div>
            </div>
          )}
        </Card>
      </div>

      {positions.length > 0 && (
        <Card title="Positions in this token">
          <table className="w-full text-sm"><thead className="text-left text-xs uppercase text-slate-500"><tr><th>Mode</th><th>Status</th><th>Opened</th><th>Entry</th><th>Size</th><th>Realized</th><th>Exit reason</th></tr></thead>
            <tbody>{positions.map((p) => <tr key={p.id} className="border-t border-slate-100"><td><Badge v={p.mode} /></td><td><Badge v={p.status} /></td><td className="text-xs">{new Date(p.openedAt).toLocaleString()}</td><td className="tabular-nums">{fmtPrice(p.entryPrice)}</td><td>{fmtSol(p.sizeSol, 3)}</td><td className={p.realizedPnlSol - p.feesSol >= 0 ? "text-emerald-700" : "text-red-700"}>{fmtSol(p.realizedPnlSol - p.feesSol)}</td><td className="text-xs">{p.exitReason ?? "—"}</td></tr>)}</tbody></table>
        </Card>
      )}

      <Card title={`Historical snapshots (${snapshots.length})`}>
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-xs"><thead className="sticky top-0 bg-white text-left uppercase text-slate-500"><tr><th>Time</th><th>Price</th><th>Liq</th><th>Mcap</th><th>Vol 5m</th><th>Vol 1h</th><th>B/S 5m</th><th>Δ5m</th><th>Δ1h</th><th>Score</th><th>Risk</th></tr></thead>
            <tbody>{[...snapshots].reverse().slice(0, 150).map((s) => <tr key={s.id} className="border-t border-slate-100 tabular-nums"><td>{fmtTime(s.capturedAt)}</td><td>{fmtPrice(s.price)}</td><td>{fmtUsd(s.liquidity)}</td><td>{fmtUsd(s.marketCap)}</td><td>{fmtUsd(s.volume5m)}</td><td>{fmtUsd(s.volume1h)}</td><td>{s.buys5m}/{s.sells5m}</td><td>{fmtPct(s.priceChange5m)}</td><td>{fmtPct(s.priceChange1h)}</td><td>{s.overallScore ?? ""}</td><td>{s.riskLevel && <Badge v={s.riskLevel} />}</td></tr>)}</tbody></table>
        </div>
      </Card>

      {decisions.length > 1 && (
        <Card title="Decision history">
          <div className="space-y-1">{decisions.map((d) => <div key={d.id} className="flex items-center gap-2 text-xs"><span className="w-20 text-slate-400">{fmtTime(d.decidedAt)}</span><Badge v={d.decision} /><span>{d.primaryReason}</span><span className="ml-auto text-slate-400">{d.overallScore !== null ? `score ${d.overallScore}` : ""}</span></div>)}</div>
        </Card>
      )}
    </div>
  );
}
