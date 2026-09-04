"use client";
import { useState } from "react";
import { apiPost, Badge, Button, Card, Empty, fmtTime, useApi, type Row } from "@/components/ui";

export default function SystemPage() {
  const { data: st, reload } = useApi<Row>("status", 10000);
  const { data: rd } = useApi<Row>("readiness", 30000);
  const [level, setLevel] = useState("");
  const { data: events } = useApi<Row[]>(`events${level ? `?level=${level}` : ""}`, 10000);
  const { data: alerts } = useApi<Row[]>("alerts", 15000);
  const cfg = st?.providers?.config ?? {};
  const rt = st?.providers?.runtime ?? {};
  const persisted: Row[] = st?.providers?.persisted ?? [];
  const names = Array.from(new Set([...Object.keys(cfg), ...Object.keys(rt), ...persisted.map((p) => p.name)]));

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="System Health" right={<Button small onClick={async () => { await apiPost("recover"); reload(); }}>Run reconciliation</Button>}>
          {!st ? <Empty>Loading…</Empty> : (
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>Scheduler</div><div><Badge v={st.scheduler?.started ? "ONLINE" : "OFFLINE"} /> scans run: {st.scheduler?.scanCount} {st.scheduler?.lastError && <span className="text-red-600">last error: {st.scheduler.lastError}</span>}</div>
              <div>Scanner</div><div><Badge v={st.scanner?.status} /> last {fmtTime(st.scanner?.lastScanAt)}</div>
              <div>Database</div><div><Badge v="ONLINE" /> (status endpoint answered)</div>
              <div>Execution</div><div><Badge v={st.mode} /> {st.mode === "PAPER" ? "simulated" : "LIVE"}</div>
              <div>Last successful data update</div><div>{fmtTime(st.lastDataUpdateAt)}</div>
              <div>Last position check</div><div>{fmtTime(st.lastPositionCheckAt)}</div>
              <div>Open positions</div><div>{st.portfolio?.openPositions}</div>
              <div>Errors / criticals (24h)</div><div className={st.errorCount24h ? "text-red-700" : ""}>{st.errorCount24h}</div>
              <div>Process started</div><div>{st.startedAt ? new Date(st.startedAt).toLocaleString() : "—"}</div>
              <div>Emergency stop</div><div>{st.emergencyStop ? <Badge v="CRITICAL" className="bg-red-600 text-white" /> : "inactive"}</div>
              <div>Startup recovery</div><div className="text-xs">{st.recovery ? `${st.recovery.openPositions} open positions checked · ${(st.recovery.issues ?? []).length} issues` : "not run"}{(st.recovery?.issues ?? []).map((i: string, k: number) => <div key={k} className="text-amber-700">{i}</div>)}</div>
            </div>
          )}
        </Card>

        <Card title="Provider Health">
          <table className="w-full text-xs"><thead className="text-left text-slate-500"><tr><th>Provider</th><th>Status</th><th>Failures</th><th>Requests</th><th>Avg latency</th><th>Last success</th><th>Note / last error</th></tr></thead>
            <tbody>{names.map((n) => { const h = rt[n] ?? persisted.find((p) => p.name === n) ?? {}; const c = cfg[n]; return <tr key={n} className="border-t border-slate-100"><td className="font-medium">{n}</td><td><Badge v={c && c.configured === false ? "NOT_CONFIGURED" : (h.status ?? "UNKNOWN")} /></td><td>{h.consecutiveFailures ?? 0}</td><td>{h.requests ?? h.requests24h ?? 0}</td><td>{h.avgLatencyMs ?? (h.latencies?.length ? Math.round(h.latencies.reduce((a: number, b: number) => a + b, 0) / h.latencies.length) : "—")}ms</td><td>{fmtTime(h.lastSuccessAt)}</td><td className="max-w-[260px] text-slate-500">{c?.note}{h.lastError && <div className="text-red-600">{h.lastError}</div>}</td></tr>; })}</tbody></table>
        </Card>
      </div>

      <Card title="Live Trading Readiness">
        {!rd ? <Empty>Loading…</Empty> : (
          <>
            <div className={`mb-3 rounded p-2 text-sm font-semibold ${rd.passed === rd.total ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`}>{rd.message} ({rd.passed}/{rd.total})</div>
            <div className="grid gap-1 md:grid-cols-2">{rd.items.map((i: Row) => <div key={i.key} className="flex items-start gap-2 rounded border border-slate-100 p-2 text-sm"><span className={`mt-0.5 inline-block h-4 w-4 rounded-sm border text-center text-[10px] leading-4 ${i.ok ? "border-emerald-600 bg-emerald-600 text-white" : "border-slate-400"}`}>{i.ok ? "✓" : ""}</span><div><div>{i.label}</div><div className="text-xs text-slate-500">{i.detail}</div></div></div>)}</div>
            <div className="mt-2 text-xs text-amber-800">{rd.liveExecutionNote}</div>
          </>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Alerts">
          {!alerts?.length ? <Empty>No alerts.</Empty> : <div className="max-h-96 space-y-1 overflow-y-auto">{alerts.map((a) => <div key={a.id} className="flex items-start gap-2 text-xs"><span className="w-16 text-slate-400">{fmtTime(a.at)}</span><Badge v={a.severity} /><div><b>{a.title}</b> <span className="text-slate-500">{a.kind}</span><div className="whitespace-pre-wrap text-slate-600">{a.body}</div></div></div>)}</div>}
        </Card>
        <Card title="Event Log" right={<select value={level} onChange={(e) => setLevel(e.target.value)} className="rounded border px-1 text-xs"><option value="">all levels</option><option>INFO</option><option>WARNING</option><option>ERROR</option><option>CRITICAL</option></select>}>
          {!events?.length ? <Empty>No events.</Empty> : <div className="max-h-96 overflow-y-auto font-mono text-[11px]">{events.map((e) => <div key={e.id} className={`border-t border-slate-50 py-0.5 ${e.level === "ERROR" || e.level === "CRITICAL" ? "text-red-700" : e.level === "WARNING" ? "text-amber-700" : "text-slate-700"}`}>[{fmtTime(e.at)}] {e.level.padEnd(8)} {e.component.padEnd(10)} {e.message}{e.mint ? ` (${e.mint.slice(0, 6)}…)` : ""}</div>)}</div>}
        </Card>
      </div>
    </div>
  );
}
