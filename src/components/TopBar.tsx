"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { apiPost, Badge, Button, useApi, type Row } from "./ui";

const NAV = [
  ["/", "Dashboard"],
  ["/journal", "Journal"],
  ["/performance", "Performance"],
  ["/settings", "Settings"],
  ["/system", "System & Readiness"],
];

export default function TopBar() {
  const path = usePathname();
  const { data: st, reload } = useApi<Row>("status", 10000);
  const [msg, setMsg] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); setMsg(null); reload(); } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1500px] items-center gap-4 px-4 py-2">
        <Link href="/" className="text-sm font-bold tracking-tight text-slate-900">SOL Meme Scanner</Link>
        <nav className="flex gap-1">
          {NAV.map(([href, label]) => (
            <Link key={href} href={href} className={`rounded px-2.5 py-1 text-sm ${path === href ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>{label}</Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {st && (
            <>
              <Badge v={st.mode} className="text-xs" />
              {st.emergencyStop && <Badge v="EMERGENCY STOP" className="bg-red-600 text-white" />}
              {!st.running && <Badge v="PAUSED" />}
              <Badge v={st.scanner?.status} />
              <Badge v={st.marketRegime} />
            </>
          )}
          {st?.running ? (
            <Button small onClick={() => act(() => apiPost("paper/stop"))}>Pause</Button>
          ) : (
            <Button small tone="primary" onClick={() => act(() => apiPost("paper/start"))}>Resume</Button>
          )}
          {st?.emergencyStop ? (
            <Button small tone="warn" onClick={() => act(() => apiPost("emergency-stop-clear"))}>Clear E-Stop</Button>
          ) : (
            <Button small tone="danger" onClick={() => { if (confirm("EMERGENCY STOP: halt all new entries and automated buying? Open positions keep following exit rules.")) return act(() => apiPost("emergency-stop")); }}>
              EMERGENCY STOP
            </Button>
          )}
        </div>
      </div>
      {msg && <div className="bg-red-50 px-4 py-1 text-xs text-red-700">{msg}</div>}
      {st?.mode === "PAPER" && (
        <div className="bg-indigo-50 px-4 py-0.5 text-center text-[11px] font-medium text-indigo-800">PAPER TRADING MODE — all trades are simulated. Live trading is disabled.</div>
      )}
      {st?.mode === "LIVE" && <div className="bg-red-600 px-4 py-0.5 text-center text-[11px] font-bold text-white">LIVE TRADING MODE — REAL FUNDS AT RISK</div>}
    </header>
  );
}
