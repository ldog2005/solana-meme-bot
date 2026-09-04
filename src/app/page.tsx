"use client";
import { useState } from "react";
import { apiPost, Badge, Button, Card, Empty, Explanation, fmtAge, fmtPct, fmtPrice, fmtSol, fmtTime, fmtUsd, ScoreBar, Stat, Term, TokenLink, useApi, type Row } from "@/components/ui";

export default function Dashboard() {
  const { data: st } = useApi<Row>("status", 10000);
  const { data: opps } = useApi<{ minScore: number; items: Row[] }>("opportunities?limit=25", 20000);
  const { data: pos, reload: reloadPos } = useApi<Row[]>("positions", 10000);
  const { data: decs } = useApi<Row[]>("decisions?limit=40", 15000);
  const { data: alerts } = useApi<Row[]>("alerts", 20000);
  const [expanded, setExpanded] = useState<number | null>(null);
  const p = st?.portfolio;
  const rt = st?.providers?.runtime ?? {};
  const pstat = (n: string) => rt[n]?.status ?? st?.providers?.persisted?.find((x: Row) => x.name === n)?.status ?? "UNKNOWN";
  const dailyLimitHit = p && p.dailyPnlSol <= -(p.dailyStartEquitySol * 0.05);

  return (
    <div className="space-y-4">
      {/* STATUS + PORTFOLIO */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Bot Status">
          {!st ? <Empty>Loading…</Empty> : (
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between"><span>Mode</span><Badge v={st.mode} /></div>
              <div className="flex justify-between"><span>Scanner</span><Badge v={st.scanner?.status} /></div>
              <div className="flex justify-between"><span>Market data (DexScreener)</span><Badge v={pstat("dexscreener")} /></div>
              <div className="flex justify-between"><span>Risk engine (RugCheck + RPC)</span><Badge v={pstat("rugcheck") === "UNKNOWN" ? "STARTING" : pstat("rugcheck")} /></div>
              <div className="flex justify-between"><span>On-chain RPC</span><Badge v={pstat("solana-rpc") === "UNKNOWN" ? "STARTING" : pstat("solana-rpc")} /></div>
              <div className="flex justify-between"><span>Execution</span><Badge v={st.mode === "PAPER" ? "PAPER" : "LIVE"} /></div>
              <div className="flex justify-between"><span>Router quotes (Jupiter)</span><Badge v={st.providers?.config?.jupiter?.configured ? pstat("jupiter") : "NOT_CONFIGURED"} /></div>
              <div className="flex justify-between"><span><Term t="Regime">Market regime</Term></span><Badge v={st.marketRegime} /></div>
              <div className="flex justify-between text-xs text-slate-500"><span>Last scan</span><span>{fmtTime(st.scanner?.lastScanAt)} {st.scanner?.lastScanOk === false && <span className="text-red-600">(failed)</span>}</span></div>
              <div className="flex justify-between text-xs text-slate-500"><span>Last data update</span><span>{fmtTime(st.lastDataUpdateAt)}</span></div>
              <div className="flex justify-between text-xs text-slate-500"><span>Errors (24h)</span><span className={st.errorCount24h > 0 ? "text-red-600" : ""}>{st.errorCount24h}</span></div>
              {st.scanner?.lastScanSummary && (
                <div className="mt-2 rounded bg-slate-50 p-2 text-[11px] text-slate-600">
                  Last scan: {st.scanner.lastScanSummary.discovered ?? 0} discovered · {st.scanner.lastScanSummary.withMarketData ?? 0} with data · {st.scanner.lastScanSummary.prefiltered ?? 0} pre-filtered · {st.scanner.lastScanSummary.deepChecked ?? 0} deep-checked
                  {st.scanner.lastScanSummary.decisions && <> · {Object.entries(st.scanner.lastScanSummary.decisions as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(" · ")}</>}
                  {st.scanner.lastScanSummary.error && <div className="text-red-600">Error: {String(st.scanner.lastScanSummary.error)}</div>}
                </div>
              )}
              {!st.scheduler?.started && (
                <div className="mt-2 flex items-center justify-between rounded bg-amber-50 p-2 text-xs text-amber-800">
                  Scheduler not running in this process.
                  <Button small tone="primary" onClick={async () => { await apiPost("bot/start"); }}>Start</Button>
                </div>
              )}
              <div className="pt-1 text-right">
                <Button small onClick={async () => { await apiPost("bot/tick"); }}>Run scan now</Button>
              </div>
            </div>
          )}
        </Card>

        <Card title={<>Portfolio <Badge v={st?.mode ?? "PAPER"} /></>} className="lg:col-span-2">
          {!p ? <Empty>Loading…</Empty> : (
            <>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Stat label="Equity" value={fmtSol(p.equitySol, 3)} sub={`cash ${fmtSol(p.cashSol, 3)} · start ${fmtSol(p.startingSol, 1)}`} />
                <Stat label="Open positions" value={`${p.openPositions}`} sub={`exposure ${fmtSol(p.exposureSol, 3)}`} />
                <Stat label="Unrealized P&L" value={fmtSol(p.unrealizedSol, 4)} tone={p.unrealizedSol > 0 ? "pos" : p.unrealizedSol < 0 ? "neg" : "neutral"} />
                <Stat label="Realized P&L (net of fees)" value={fmtSol(p.realizedTotalSol, 4)} tone={p.realizedTotalSol > 0 ? "pos" : p.realizedTotalSol < 0 ? "neg" : "neutral"} />
                <Stat label="Daily P&L" value={fmtSol(p.dailyPnlSol, 4)} tone={p.dailyPnlSol > 0 ? "pos" : p.dailyPnlSol < 0 ? "neg" : "neutral"} sub={dailyLimitHit ? "DAILY LOSS LIMIT — entries disabled" : `limit −${(p.dailyStartEquitySol * 0.05).toFixed(3)} SOL (5%)`} />
                <Stat label="Weekly P&L" value={fmtSol(p.weeklyPnlSol, 4)} tone={p.weeklyPnlSol > 0 ? "pos" : p.weeklyPnlSol < 0 ? "neg" : "neutral"} />
                <Stat label={<Term t="Drawdown">Drawdown</Term>} value={`${p.drawdownPct.toFixed(2)}%`} sub={`peak ${fmtSol(p.peakEquitySol, 3)}`} tone={p.drawdownPct > 5 ? "neg" : "neutral"} />
                <Stat label="Total return" value={fmtPct(((p.equitySol - p.startingSol) / p.startingSol) * 100, 2)} tone={p.equitySol >= p.startingSol ? "pos" : "neg"} />
              </div>
              {alerts && alerts.filter((a) => !a.acknowledged).length > 0 && (
                <div className="mt-3 space-y-1">
                  {alerts.filter((a) => !a.acknowledged).slice(0, 4).map((a) => (
                    <div key={a.id} className={`flex items-start gap-2 rounded px-2 py-1 text-xs ${a.severity === "CRITICAL" ? "bg-red-50 text-red-800" : a.severity === "WARNING" ? "bg-amber-50 text-amber-800" : "bg-sky-50 text-sky-800"}`}>
                      <Badge v={a.severity} /> <span className="font-medium">{a.title}</span> <span className="text-slate-500">{a.body?.slice(0, 120)}</span><span className="ml-auto whitespace-nowrap text-slate-400">{fmtTime(a.at)}</span>
                    </div>
                  ))}
                  <div className="text-right"><Button small onClick={async () => { await apiPost("alerts/ack"); }}>Acknowledge all</Button></div>
                </div>
              )}
            </>
          )}
        </Card>
      </div>

      {/* OPEN POSITIONS */}
      <Card title={<>Open Positions <span className="ml-1 text-xs font-normal text-slate-500">({pos?.length ?? 0}) — {st?.mode === "LIVE" ? "LIVE TRADES" : "PAPER TRADES"}</span></>}
        right={pos && pos.length > 0 ? <Button small tone="danger" onClick={async () => { if (confirm("SELL ALL open positions at market (simulated)? Type-confirm follows.")) { const c = prompt('Type SELL ALL to confirm'); if (c === "SELL ALL") { await apiPost("sell-all", { confirm: "SELL ALL" }); reloadPos(); } } }}>SELL ALL</Button> : undefined}>
        {!pos?.length ? <Empty>No open positions. NO TRADE is a valid outcome — the bot only enters when every gate passes.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-1">Token</th><th>Entry</th><th>Current</th><th>P&L</th><th>Stop</th><th><Term t="Trailing Stop">Trail</Term></th><th>Targets hit</th><th>Size</th><th>Hold</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {pos.map((x) => {
                  const cur = x.currentPrice ?? x.entryPrice;
                  const pnlPct = ((cur - x.entryPrice) / x.entryPrice) * 100;
                  const unreal = x.remainingTokens * cur - x.costBasisSol * (x.remainingTokens / x.initialTokens);
                  return (
                    <tr key={x.id} className="border-t border-slate-100">
                      <td className="py-1.5"><TokenLink mint={x.mint} symbol={x.symbol} /> <Badge v={x.mode} /></td>
                      <td className="tabular-nums">{fmtPrice(x.entryPrice)}</td>
                      <td className="tabular-nums">{fmtPrice(cur)}</td>
                      <td className={`tabular-nums font-medium ${pnlPct >= 0 ? "text-emerald-700" : "text-red-700"}`}>{fmtPct(pnlPct)}<div className="text-[11px] font-normal text-slate-500">{fmtSol(unreal + x.realizedPnlSol, 4)}</div></td>
                      <td className="tabular-nums text-xs">{fmtPrice(x.stopPrice)}</td>
                      <td className="tabular-nums text-xs">{x.trailingStopPrice ? fmtPrice(x.trailingStopPrice) : "not armed"}</td>
                      <td className="text-xs">{(x.takenProfitLevels as number[]).length ? `TP${(x.takenProfitLevels as number[]).join(", TP")}` : "—"}</td>
                      <td className="tabular-nums text-xs">{fmtSol(x.sizeSol, 3)}<div className="text-[11px] text-slate-500">{((x.remainingTokens / x.initialTokens) * 100).toFixed(0)}% left</div></td>
                      <td className="text-xs">{fmtAge(x.openedAt)}</td>
                      <td><Badge v={x.reconciliation === "OK" ? "OPEN" : x.reconciliation} /></td>
                      <td><Button small onClick={async () => { if (confirm(`Close ${x.symbol} at market (simulated)?`)) { await apiPost(`positions/${x.id}/close`); reloadPos(); } }}>Close</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-5">
        {/* TOP OPPORTUNITIES */}
        <Card title={<>Top Candidates <span className="ml-1 text-xs font-normal text-slate-500">(last 3h · min score {opps?.minScore ?? 70})</span></>} className="xl:col-span-3">
          {!opps?.items?.length ? <Empty>{st?.dataSource === "UNAVAILABLE" ? "DATA SOURCE UNAVAILABLE — no scan has completed yet." : "No scored candidates yet. Wait for the next scan."}</Empty> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-slate-500"><tr><th className="py-1">Token</th><th><Term t="Age">Age</Term></th><th><Term t="Market Cap">Mcap</Term></th><th><Term t="Liquidity">Liq</Term></th><th>Vol 1h</th><th><Term t="Safety">Risk</Term></th><th><Term t="Score">Score</Term></th><th>Status</th></tr></thead>
                <tbody>
                  {opps.items.map((t) => (
                    <tr key={t.mint} className="border-t border-slate-100">
                      <td className="py-1.5"><TokenLink mint={t.mint} symbol={t.symbol} /><div className="text-[11px] text-slate-400">{t.name?.slice(0, 24)}</div></td>
                      <td className="text-xs">{fmtAge(t.launchTime)}</td>
                      <td className="text-xs tabular-nums">{fmtUsd(t.marketCap)}</td>
                      <td className="text-xs tabular-nums">{fmtUsd(t.liquidity)}</td>
                      <td className="text-xs tabular-nums">{fmtUsd(t.volume1h)}</td>
                      <td><Badge v={t.riskLevel} /></td>
                      <td><ScoreBar points={t.overallScore ?? 0} max={100} /></td>
                      <td><Badge v={t.lastDecision ?? t.tradeStatus} /><div className="max-w-[220px] truncate text-[11px] text-slate-500" title={t.lastDecisionReason}>{t.lastDecisionReason}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* RECENT DECISIONS */}
        <Card title="Recent Decisions" className="xl:col-span-2">
          {!decs?.length ? <Empty>No decisions yet.</Empty> : (
            <div className="max-h-[560px] space-y-1 overflow-y-auto pr-1">
              {decs.map((d) => (
                <div key={d.id} className="rounded border border-slate-100 p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <Badge v={d.decision} />
                    <TokenLink mint={d.mint} symbol={d.symbol} />
                    {d.overallScore !== null && <span className="text-slate-500">score {d.overallScore}</span>}
                    {d.riskLevel && <Badge v={d.riskLevel} />}
                    {d.manual && <Badge v="MANUAL" />}
                    <span className="ml-auto text-slate-400">{fmtTime(d.decidedAt)}</span>
                  </div>
                  <div className="mt-1 text-slate-700">{d.primaryReason}</div>
                  <button className="mt-1 text-indigo-600 hover:underline" onClick={() => setExpanded(expanded === d.id ? null : d.id)}>{expanded === d.id ? "hide" : "explain"}</button>
                  {expanded === d.id && <Explanation text={d.explanation} />}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
