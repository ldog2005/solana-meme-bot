"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

// ---------------------------------------------------------------------------
// Glossary — every technical term gets a tooltip for non-expert users.
// ---------------------------------------------------------------------------
export const GLOSSARY: Record<string, string> = {
  Liquidity: "The approximate amount of money in the token's trading pool. Low liquidity makes it hard to buy or sell without moving the price a lot.",
  "Market Cap": "Current price × circulating supply. A rough measure of the token's total value.",
  FDV: "Fully diluted valuation: price × total supply including tokens not yet circulating.",
  Slippage: "The difference between the price you expected and the price you actually got. Higher in thin or fast-moving markets.",
  "Price Impact": "How much your own order moves the price. Large orders in small pools have high impact.",
  "Holder Concentration": "How much of the supply is held by the biggest wallets. High concentration means a few wallets can crash the price.",
  "Mint Authority": "If active, the deployer can create unlimited new tokens, diluting holders. Should be REVOKED.",
  "Freeze Authority": "If active, the deployer can freeze wallets so they cannot sell. Should be REVOKED.",
  "LP Locked": "Share of the liquidity pool tokens that are burned or time-locked. Unlocked LP can be withdrawn (a 'rug pull').",
  Score: "0–100 opportunity score combining safety, liquidity, holders, structure, momentum, volume, participants and market context. Higher is better according to current rules — not a prediction.",
  Safety: "0–30 portion of the score from risk checks. Any CRITICAL flag forces a REJECT regardless of other factors.",
  Momentum: "Recent volume acceleration and buy pressure. Deliberately low-weight because it is easy to fake.",
  Regime: "Overall meme-coin market condition (HOT / NORMAL / WEAK / EXTREMELY RISKY). Weaker regimes raise the entry bar.",
  Drawdown: "How far equity has fallen from its peak.",
  Expectancy: "Average profit or loss per trade, in SOL. Positive over a large sample is what matters — not win rate.",
  "Profit Factor": "Gross profits ÷ gross losses. Above 1 means winners outweigh losers.",
  "Trailing Stop": "A stop that follows the price up. Locks in gains if the price reverses by the configured percentage.",
  Age: "Time since the trading pair was created.",
  Classification: "EARLY / DEVELOPING = constructive setups. OVEREXTENDED = moved too far, too fast. DETERIORATING = losing momentum.",
  "Paper Trade": "A simulated trade using pretend money and modelled slippage, fees and failures. No real transaction happens.",
  Idempotency: "Protection that makes sure the same order cannot be sent twice.",
};

export function Term({ t, children }: { t: string; children?: ReactNode }) {
  const text = GLOSSARY[t];
  return (
    <span className="group relative inline-flex cursor-help items-center gap-1 border-b border-dotted border-slate-400">
      {children ?? t}
      {text && (
        <span className="pointer-events-none absolute left-0 top-full z-50 mt-1 hidden w-64 rounded-md border border-slate-700 bg-slate-900 p-2 text-xs font-normal leading-snug text-slate-100 shadow-xl group-hover:block">
          <b className="block text-slate-300">{t}</b>
          {text}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
export const fmtUsd = (v: number | null | undefined, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `$${v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(d === 0 ? 1 : d) + "k" : v.toFixed(d)}`);
export const fmtSol = (v: number | null | undefined, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v >= 0 ? "" : "-"}${Math.abs(v).toFixed(d)} SOL`);
export const fmtPct = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
export const fmtPrice = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v < 0.0001 ? v.toExponential(3) : v.toFixed(v < 1 ? 7 : 4));
export const fmtAge = (from: string | Date | null | undefined, to: Date = new Date()) => {
  if (!from) return "—";
  const m = (to.getTime() - new Date(from).getTime()) / 60000;
  if (m < 1) return "<1m";
  if (m < 60) return `${Math.round(m)}m`;
  if (m < 1440) return `${(m / 60).toFixed(1)}h`;
  return `${(m / 1440).toFixed(1)}d`;
};
export const fmtTime = (d: string | Date | null | undefined) => (d ? new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
export const shortMint = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;

// ---------------------------------------------------------------------------
// Visual primitives
// ---------------------------------------------------------------------------
const tone: Record<string, string> = {
  LOW: "bg-emerald-100 text-emerald-800 border-emerald-200",
  MODERATE: "bg-amber-100 text-amber-800 border-amber-200",
  HIGH: "bg-orange-100 text-orange-800 border-orange-200",
  CRITICAL: "bg-red-100 text-red-800 border-red-200",
  UNKNOWN: "bg-slate-100 text-slate-700 border-slate-200",
  BUY: "bg-emerald-600 text-white border-emerald-700",
  SELL: "bg-sky-600 text-white border-sky-700",
  WATCH: "bg-amber-100 text-amber-900 border-amber-300",
  NO_TRADE: "bg-slate-100 text-slate-700 border-slate-300",
  REJECTED: "bg-red-100 text-red-800 border-red-300",
  ONLINE: "bg-emerald-100 text-emerald-800 border-emerald-200",
  DEGRADED: "bg-amber-100 text-amber-800 border-amber-200",
  OFFLINE: "bg-red-100 text-red-800 border-red-200",
  NOT_CONFIGURED: "bg-slate-100 text-slate-600 border-slate-200",
  PAUSED: "bg-slate-200 text-slate-800 border-slate-300",
  STARTING: "bg-sky-100 text-sky-800 border-sky-200",
  PAPER: "bg-indigo-100 text-indigo-800 border-indigo-300",
  LIVE: "bg-red-600 text-white border-red-700",
  HOT: "bg-rose-100 text-rose-800 border-rose-200",
  NORMAL: "bg-emerald-100 text-emerald-800 border-emerald-200",
  WEAK: "bg-amber-100 text-amber-800 border-amber-200",
  EXTREMELY_RISKY: "bg-red-600 text-white border-red-700",
  OPEN: "bg-emerald-100 text-emerald-800 border-emerald-200",
  CLOSED: "bg-slate-100 text-slate-700 border-slate-200",
  FILLED: "bg-emerald-100 text-emerald-800 border-emerald-200",
  PARTIAL: "bg-amber-100 text-amber-800 border-amber-200",
  FAILED: "bg-red-100 text-red-800 border-red-200",
  INFO: "bg-sky-100 text-sky-800 border-sky-200",
  WARNING: "bg-amber-100 text-amber-800 border-amber-200",
  ERROR: "bg-red-100 text-red-800 border-red-200",
};
export function Badge({ v, className = "" }: { v: string | null | undefined; className?: string }) {
  const k = v ?? "UNKNOWN";
  return <span className={`inline-block rounded border px-1.5 py-0.5 text-[11px] font-semibold tracking-wide ${tone[k] ?? "bg-slate-100 text-slate-700 border-slate-200"} ${className}`}>{k.replace(/_/g, " ")}</span>;
}

export function Card({ title, children, right, className = "" }: { title?: ReactNode; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-slate-200 bg-white shadow-sm ${className}`}>
      {title && (
        <header className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          {right}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone: t }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "pos" | "neg" | "neutral" }) {
  const color = t === "pos" ? "text-emerald-700" : t === "neg" ? "text-red-700" : "text-slate-900";
  return (
    <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export function ScoreBar({ points, max }: { points: number; max: number }) {
  const pct = Math.max(0, Math.min(100, (points / max) * 100));
  const color = pct >= 75 ? "bg-emerald-500" : pct >= 45 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 rounded bg-slate-200">
        <div className={`h-2 rounded ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-slate-700">{points}/{max}</span>
    </div>
  );
}

export function TokenLink({ mint, symbol }: { mint: string; symbol?: string | null }) {
  return (
    <Link href={`/tokens/${mint}`} className="font-medium text-indigo-700 hover:underline" title={mint}>
      {symbol || shortMint(mint)}
    </Link>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">{children}</div>;
}

// ---------------------------------------------------------------------------
// Data hooks
// ---------------------------------------------------------------------------
export function getAdminToken() {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem("ADMIN_TOKEN") ?? "";
}

export async function apiPost<T = Row>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-admin-token": getAdminToken() }, body: JSON.stringify(body ?? {}) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export function useApi<T = Row>(path: string, intervalMs = 15000): { data: T | null; error: string | null; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const r = await fetch(`/api/${path}`, { cache: "no-store" });
        const j = await r.json();
        if (!alive) return;
        if (!r.ok) setError(j.error ?? `HTTP ${r.status}`);
        else { setData(j as T); setError(null); }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void run();
    const id = intervalMs > 0 ? setInterval(run, intervalMs) : null;
    return () => { alive = false; if (id) clearInterval(id); };
  }, [path, intervalMs, tick]);
  return { data, error, reload, loading };
}

export function Button({ children, onClick, tone: t = "default", disabled, small }: { children: ReactNode; onClick?: () => void | Promise<void>; tone?: "default" | "danger" | "primary" | "warn"; disabled?: boolean; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const cls = t === "danger" ? "bg-red-600 text-white hover:bg-red-700 border-red-700" : t === "primary" ? "bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-700" : t === "warn" ? "bg-amber-500 text-white hover:bg-amber-600 border-amber-600" : "bg-white text-slate-800 hover:bg-slate-50 border-slate-300";
  return (
    <button
      disabled={disabled || busy}
      onClick={async () => { if (!onClick) return; setBusy(true); try { await onClick(); } finally { setBusy(false); } }}
      className={`rounded border font-medium shadow-sm disabled:opacity-50 ${small ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm"} ${cls}`}
    >
      {busy ? "…" : children}
    </button>
  );
}

export function Explanation({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return <pre className="whitespace-pre-wrap rounded bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800">{text}</pre>;
}
