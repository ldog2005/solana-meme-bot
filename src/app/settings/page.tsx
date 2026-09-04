"use client";
import { useEffect, useState } from "react";
import { apiPost, Badge, Button, Card, Empty, getAdminToken, useApi, type Row } from "@/components/ui";

const GROUPS: [string, string, string][] = [
  ["HARD_RISK", "Hard Risk Limits", "Enforced by deterministic code on every decision. Nothing — including any AI component — can override these."],
  ["ENTRY", "Entry Strategy", "Changing any of these creates a new strategy version so results can be compared."],
  ["EXIT", "Exit Strategy", "Partial take-profits, trailing stop, emergency exits. Also versioned."],
  ["SCANNER", "Scanner", "Polling cadence and API-quota protection."],
  ["PAPER", "Paper Trading Simulation", "Realism knobs for the simulator."],
  ["GENERAL", "General", ""],
];

export default function Settings() {
  const { data, reload } = useApi<{ values: Row; definitions: Row[]; versions: Row[]; adminTokenConfigured: boolean }>("settings", 0);
  const { data: bl, reload: reloadBl } = useApi<Row[]>("blacklist", 0);
  const { data: st, reload: reloadSt } = useApi<Row>("status", 0);
  const [draft, setDraft] = useState<Row>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [blAddr, setBlAddr] = useState("");
  const [blKind, setBlKind] = useState("TOKEN");
  useEffect(() => { if (data) setDraft(data.values); }, [data]);
  useEffect(() => { setToken(getAdminToken()); }, []);
  if (!data) return <Empty>Loading…</Empty>;
  const dirty = Object.keys(draft).filter((k) => draft[k] !== data.values[k]);
  const save = async () => {
    setMsg(null);
    const patch: Row = {};
    for (const k of dirty) patch[k] = draft[k];
    try { const r = await apiPost("settings", patch); setMsg(r.versionBumped ? `Saved. Strategy version bumped to ${r.versionBumped}.` : "Saved."); reload(); } catch (e) { setMsg(`Error: ${(e as Error).message}`); }
  };

  return (
    <div className="space-y-4">
      <Card title="Dashboard Access Token">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-600">{data.adminTokenConfigured ? "Server requires ADMIN_TOKEN for changes. Enter it here (stored in this browser only)." : <span className="text-amber-700">ADMIN_TOKEN is not set on the server — controls are unprotected. Set it before exposing this dashboard beyond localhost.</span>}</span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} className="rounded border px-2 py-1" placeholder="admin token" />
          <Button small onClick={() => { localStorage.setItem("ADMIN_TOKEN", token); setMsg("Token stored locally."); }}>Save token</Button>
        </div>
      </Card>

      <Card title="Trading Mode & Live Controls">
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">Current mode: <Badge v={st?.mode ?? "PAPER"} /> {st?.liveTradingEnabled ? <span className="text-red-700">live enabled in dashboard</span> : <span className="text-slate-600">live disabled (default)</span>} · env LIVE_TRADING_ENABLED = <code>{String(st?.liveEnvFlag ?? false)}</code></div>
          <p className="text-xs text-slate-600">Enabling live trading requires ALL of: the server env var <code>LIVE_TRADING_ENABLED=true</code>, <code>ADMIN_TOKEN</code>, <code>JUPITER_API_KEY</code>, <code>TRADING_WALLET_SECRET</code> (a dedicated wallet holding only what you can afford to lose), every readiness check passing, and typing the confirmation phrase. No automated process can enable it.</p>
          <div className="flex gap-2">
            <Button tone="danger" onClick={async () => { const c = prompt("Type exactly: I UNDERSTAND THIS USES REAL FUNDS"); if (!c) return; try { await apiPost("live/enable", { confirm: c }); setMsg("Live trading enabled."); } catch (e) { setMsg(`Refused: ${(e as Error).message}`); } reloadSt(); }}>Enable LIVE trading…</Button>
            <Button onClick={async () => { await apiPost("live/disable"); setMsg("Back to PAPER."); reloadSt(); }}>Disable live / back to PAPER</Button>
            <Button onClick={async () => { if (confirm("Reset paper balance to PAPER_STARTING_SOL? History is retained. Requires no open positions.")) { try { await apiPost("paper/reset"); setMsg("Paper balance reset."); } catch (e) { setMsg((e as Error).message); } } }}>Reset paper balance</Button>
          </div>
        </div>
      </Card>

      {msg && <div className={`rounded p-2 text-sm ${msg.startsWith("Error") || msg.startsWith("Refused") ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-800"}`}>{msg}</div>}

      {GROUPS.map(([g, title, blurb]) => (
        <Card key={g} title={title} right={<span className="text-xs text-slate-500">{blurb}</span>}>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.definitions.filter((d) => d.group === g).map((d) => (
              <label key={d.key} className="block rounded border border-slate-100 p-2 text-sm">
                <div className="flex items-center justify-between"><span className="font-medium">{d.label}</span><code className="text-[10px] text-slate-400">{d.key}</code></div>
                <div className="my-1 text-xs text-slate-600">{d.description}</div>
                {d.type === "boolean" ? (
                  <input type="checkbox" checked={Boolean(draft[d.key])} onChange={(e) => setDraft({ ...draft, [d.key]: e.target.checked })} />
                ) : d.type === "string" ? (
                  <input value={String(draft[d.key] ?? "")} disabled={d.key === "STRATEGY_VERSION"} className="w-full rounded border px-2 py-1 disabled:bg-slate-100" onChange={(e) => setDraft({ ...draft, [d.key]: e.target.value })} />
                ) : (
                  <div className="flex items-center gap-2"><input type="number" step="any" min={d.min} max={d.max} value={Number(draft[d.key] ?? 0)} className="w-32 rounded border px-2 py-1" onChange={(e) => setDraft({ ...draft, [d.key]: Number(e.target.value) })} /><span className="text-xs text-slate-500">{d.unit} · {d.min}–{d.max} · default {d.default}</span></div>
                )}
              </label>
            ))}
          </div>
        </Card>
      ))}
      <div className="sticky bottom-2 flex items-center gap-2 rounded border border-slate-200 bg-white p-2 shadow"><Button tone="primary" disabled={!dirty.length} onClick={save}>Save {dirty.length ? `(${dirty.length} changed)` : ""}</Button><Button onClick={() => setDraft(data.values)}>Discard</Button><span className="text-xs text-slate-500">Strategy version: {String(data.values.STRATEGY_VERSION)}</span></div>

      <Card title="Blacklist (never auto-traded) — whitelist does NOT bypass safety checks">
        <div className="mb-2 flex flex-wrap gap-2 text-sm"><input value={blAddr} onChange={(e) => setBlAddr(e.target.value)} className="w-96 rounded border px-2 py-1 font-mono text-xs" placeholder="mint or developer wallet address" /><select value={blKind} onChange={(e) => setBlKind(e.target.value)} className="rounded border px-2 py-1"><option>TOKEN</option><option>DEVELOPER</option></select><Button small tone="danger" onClick={async () => { try { await apiPost("blacklist", { address: blAddr, kind: blKind, reason: "manual (settings)" }); setBlAddr(""); reloadBl(); } catch (e) { setMsg(`Error: ${(e as Error).message}`); } }}>Add</Button></div>
        {!bl?.length ? <div className="text-xs text-slate-400">empty</div> : <table className="w-full text-xs"><tbody>{bl.map((b) => <tr key={b.id} className="border-t border-slate-100"><td><Badge v={b.kind} /></td><td className="font-mono">{b.address}</td><td>{b.reason}</td><td>{new Date(b.createdAt).toLocaleString()}</td><td><Button small onClick={async () => { await apiPost("blacklist-remove", { address: b.address }); reloadBl(); }}>remove</Button></td></tr>)}</tbody></table>}
      </Card>

      <Card title="Strategy Versions">
        <table className="w-full text-xs"><thead className="text-left text-slate-500"><tr><th>Version</th><th>Created</th><th>Description</th><th>Parameters</th></tr></thead><tbody>{data.versions.map((v) => <tr key={v.id} className="border-t border-slate-100 align-top"><td className="font-mono">{v.version}</td><td>{new Date(v.createdAt).toLocaleString()}</td><td>{v.description}</td><td className="max-w-[500px] break-all font-mono text-[10px] text-slate-500">{JSON.stringify(v.parameters)}</td></tr>)}</tbody></table>
      </Card>
    </div>
  );
}
