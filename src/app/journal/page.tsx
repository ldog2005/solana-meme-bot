"use client";
import { useState } from "react";
import { Badge, Card, Empty, Explanation, fmtAge, fmtPct, fmtPrice, fmtSol, fmtTime, TokenLink, useApi, type Row } from "@/components/ui";

export default function Journal() {
  const [filter, setFilter] = useState<string>("ALL");
  const { data: decs } = useApi<Row[]>("decisions?limit=300", 20000);
  const { data: trades } = useApi<Row[]>("trades?limit=300", 20000);
  const { data: closed } = useApi<Row[]>("positions?status=CLOSED", 30000);
  const [open, setOpen] = useState<number | null>(null);
  const shown = (decs ?? []).filter((d) => filter === "ALL" || d.decision === filter);
  const counts = (decs ?? []).reduce<Record<string, number>>((a, d) => { a[d.decision] = (a[d.decision] ?? 0) + 1; return a; }, {});

  return (
    <div className="space-y-4">
      <Card title="Trade Journal — closed positions (PAPER unless marked LIVE)">
        {!closed?.length ? <Empty>No closed positions yet.</Empty> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500"><tr><th>Token</th><th>Mode</th><th>Opened</th><th>Hold</th><th>Entry</th><th>Score</th><th>Size</th><th>Realized (net)</th><th>Return</th><th>MFE / MAE</th><th>Exit reason</th><th>Strategy</th></tr></thead>
            <tbody>{closed.map((p) => {
              const net = p.realizedPnlSol - p.feesSol;
              const mfe = ((p.highestPrice - p.entryPrice) / p.entryPrice) * 100, mae = ((p.lowestPrice - p.entryPrice) / p.entryPrice) * 100;
              return <tr key={p.id} className="border-t border-slate-100">
                <td className="py-1"><TokenLink mint={p.mint} symbol={p.symbol} /></td><td><Badge v={p.mode} /></td>
                <td className="text-xs">{new Date(p.openedAt).toLocaleString()}</td><td className="text-xs">{fmtAge(p.openedAt, new Date(p.closedAt))}</td>
                <td className="tabular-nums text-xs">{fmtPrice(p.entryPrice)}</td><td>{p.entryScore}</td><td>{fmtSol(p.sizeSol, 3)}</td>
                <td className={`font-medium tabular-nums ${net >= 0 ? "text-emerald-700" : "text-red-700"}`}>{fmtSol(net)}</td>
                <td className={`tabular-nums ${net >= 0 ? "text-emerald-700" : "text-red-700"}`}>{fmtPct((net / p.costBasisSol) * 100)}</td>
                <td className="text-xs tabular-nums"><span className="text-emerald-700">{fmtPct(mfe, 0)}</span> / <span className="text-red-700">{fmtPct(mae, 0)}</span></td>
                <td className="max-w-[260px] truncate text-xs" title={p.exitReason}>{p.exitReason}</td><td className="text-xs">{p.strategyVersion}</td>
              </tr>;
            })}</tbody></table></div>
        )}
      </Card>

      <Card title="Executions" >
        {!trades?.length ? <Empty>No executions yet.</Empty> : (
          <div className="max-h-96 overflow-auto"><table className="w-full text-xs">
            <thead className="sticky top-0 bg-white text-left uppercase text-slate-500"><tr><th>Time</th><th>Mode</th><th>Side</th><th>Token</th><th>Status</th><th>Expected</th><th>Executed</th><th>Slippage</th><th>Impact</th><th>SOL</th><th>Fee</th><th>Latency</th><th>Realized</th><th>Reason</th></tr></thead>
            <tbody>{trades.map((t) => <tr key={t.id} className="border-t border-slate-100 tabular-nums">
              <td>{fmtTime(t.executedAt)}</td><td><Badge v={t.mode} /></td><td><Badge v={t.side} /></td><td><TokenLink mint={t.mint} symbol={t.symbol} /></td><td><Badge v={t.status} /></td>
              <td>{fmtPrice(t.expectedPrice)}</td><td>{fmtPrice(t.executedPrice)}</td><td>{t.slippagePct?.toFixed(2)}%</td><td>{t.priceImpactPct?.toFixed(2)}%</td><td>{t.solAmount?.toFixed(4)}</td><td>{t.feeSol?.toFixed(4)}</td><td>{t.latencyMs}ms</td>
              <td className={t.realizedPnlSol > 0 ? "text-emerald-700" : t.realizedPnlSol < 0 ? "text-red-700" : ""}>{t.realizedPnlSol !== null ? fmtSol(t.realizedPnlSol) : ""}</td><td className="max-w-[240px] truncate" title={t.reason}>{t.manual && <Badge v="MANUAL" />} {t.reason}</td>
            </tr>)}</tbody></table></div>
        )}
      </Card>

      <Card title="Decision Log (including NO-TRADE and REJECTED)" right={
        <div className="flex gap-1">{["ALL", "BUY", "SELL", "WATCH", "NO_TRADE", "REJECTED"].map((k) => <button key={k} onClick={() => setFilter(k)} className={`rounded px-2 py-0.5 text-xs ${filter === k ? "bg-slate-900 text-white" : "bg-slate-100"}`}>{k.replace("_", " ")} {counts[k] !== undefined && <span className="opacity-60">{counts[k]}</span>}{k === "ALL" && <span className="opacity-60">{decs?.length ?? 0}</span>}</button>)}</div>}>
        {!shown.length ? <Empty>Nothing here yet.</Empty> : (
          <div className="max-h-[700px] space-y-1 overflow-y-auto">
            {shown.map((d) => <div key={d.id} className="rounded border border-slate-100 p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2"><span className="text-slate-400">{new Date(d.decidedAt).toLocaleString()}</span><Badge v={d.decision} /><TokenLink mint={d.mint} symbol={d.symbol} />{d.classification && <Badge v={d.classification} />}{d.riskLevel && <Badge v={d.riskLevel} />}{d.overallScore !== null && <span>score {d.overallScore}</span>}<span className="text-slate-400">{d.strategyVersion}</span>{d.manual && <Badge v="MANUAL" />}
                <button className="ml-auto text-indigo-600 hover:underline" onClick={() => setOpen(open === d.id ? null : d.id)}>{open === d.id ? "hide" : "details"}</button></div>
              <div className="mt-1 font-medium text-slate-800">{d.primaryReason}</div>
              {open === d.id && <Explanation text={d.explanation} />}
            </div>)}
          </div>
        )}
      </Card>
    </div>
  );
}
