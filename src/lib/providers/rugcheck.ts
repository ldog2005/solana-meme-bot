import { fetchJson } from "./http";
import type { AuthorityStatus, RiskAnalysisProvider, RiskReport } from "../core/types";

// RugCheck public API. Full report: /v1/tokens/{mint}/report (heavier),
// summary: /v1/tokens/{mint}/report/summary. Optional X-API-KEY raises limits.
const BASE = "https://api.rugcheck.xyz/v1";
const NAME = "rugcheck";

interface RcRisk { name: string; level: string; description: string; value?: string; score?: number }
interface RcReport {
  mint?: string;
  token?: { mintAuthority?: string | null; freezeAuthority?: string | null; supply?: number; decimals?: number };
  tokenMeta?: { mutable?: boolean };
  tokenProgram?: string;
  tokenType?: string;
  transferFee?: { pct?: number; maxAmount?: number; authority?: string };
  creator?: string | null;
  creatorBalance?: number;
  risks?: RcRisk[];
  score?: number;
  score_normalised?: number;
  topHolders?: { address: string; owner?: string; pct: number; insider?: boolean; uiAmount?: number }[];
  markets?: { pubkey?: string; lp?: { lpLockedPct?: number; lpLockedUSD?: number; quoteUSD?: number; baseUSD?: number }; marketType?: string }[];
  totalHolders?: number;
  totalMarketLiquidity?: number;
  totalLPProviders?: number;
  rugged?: boolean;
  lockers?: Record<string, unknown>;
}

const authority = (v: string | null | undefined): AuthorityStatus => (v === undefined ? "UNKNOWN" : v === null || v === "" ? "REVOKED" : "ACTIVE");

export class RugCheckProvider implements RiskAnalysisProvider {
  readonly name = NAME;
  private apiKey = process.env.RUGCHECK_API_KEY;
  isConfigured() {
    return true; // public endpoints work without key; key is optional
  }

  async getRiskReport(mint: string): Promise<RiskReport | null> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return null;
    let r: RcReport;
    try {
      r = await fetchJson<RcReport>(`${BASE}/tokens/${mint}/report`, {
        provider: NAME,
        ratePerMinute: this.apiKey ? 120 : 30,
        cacheTtlMs: 120_000,
        timeoutMs: 12_000,
        retries: 1,
        headers: this.apiKey ? { "X-API-KEY": this.apiKey } : undefined,
      });
    } catch {
      return null;
    }
    if (!r || typeof r !== "object") return null;

    const risks = (Array.isArray(r.risks) ? r.risks : [])
      .filter((x) => x && typeof x.name === "string")
      .map((x) => ({
        name: x.name,
        level: (x.level === "danger" ? "danger" : x.level === "warn" ? "warn" : "info") as "danger" | "warn" | "info",
        description: String(x.description ?? ""),
        value: x.value ? String(x.value) : undefined,
      }));

    // LP locked: liquidity-WEIGHTED across markets. A dust secondary pool with
    // 0% locked must not override a fully-burned main pool (observed in
    // production: PumpSwap 100% locked $32k + Meteora 0% locked $8).
    let lpLockedPct: number | null = null;
    const poolAddresses: string[] = [];
    if (Array.isArray(r.markets) && r.markets.length) {
      let lockedUsd = 0, totalUsd = 0, fallback: number | null = null, fallbackLiq = -1;
      for (const m of r.markets) {
        if (m.pubkey) poolAddresses.push(m.pubkey);
        const liq = (m.lp?.quoteUSD ?? 0) + (m.lp?.baseUSD ?? 0);
        if (typeof m.lp?.lpLockedUSD === "number" && liq > 0) { lockedUsd += m.lp.lpLockedUSD; totalUsd += liq; }
        if (typeof m.lp?.lpLockedPct === "number" && liq > fallbackLiq) { fallback = m.lp.lpLockedPct; fallbackLiq = liq; }
      }
      if (totalUsd > 0) lpLockedPct = Math.max(0, Math.min(100, (lockedUsd / totalUsd) * 100));
      else lpLockedPct = fallback;
    }

    const supply = r.token?.supply ?? null;
    const decimals = r.token?.decimals ?? 0;
    let creatorPct: number | null = null;
    if (typeof r.creatorBalance === "number" && supply && supply > 0) creatorPct = (r.creatorBalance / supply) * 100;
    void decimals;

    return {
      mint,
      providerScoreNormalised: typeof r.score_normalised === "number" ? r.score_normalised : null,
      risks,
      mintAuthority: authority(r.token?.mintAuthority),
      freezeAuthority: authority(r.token?.freezeAuthority),
      lpLockedPct,
      topHolders: Array.isArray(r.topHolders)
        ? r.topHolders
            .filter((h) => h && typeof h.pct === "number")
            .filter((h) => !poolAddresses.includes(h.owner ?? "") && !poolAddresses.includes(h.address))
            .map((h) => ({ address: h.owner ?? h.address, pct: h.pct, insider: h.insider }))
        : null,
      poolAddresses,
      creator: r.creator ?? null,
      creatorPct,
      totalHolders: typeof r.totalHolders === "number" ? r.totalHolders : null,
      rugged: typeof r.rugged === "boolean" ? r.rugged : null,
      mutableMetadata: typeof r.tokenMeta?.mutable === "boolean" ? r.tokenMeta.mutable : null,
      transferFeePct: typeof r.transferFee?.pct === "number" ? r.transferFee.pct : null,
      fetchedAt: new Date(),
      source: NAME,
    };
  }
}
