import { fetchJson } from "./http";
import type { DiscoveredToken, MarketDataProvider, MarketSnapshot, TokenDiscoveryProvider } from "../core/types";
import { SOL_MINT } from "../core/types";

// DexScreener public API (no key). Rate limits (docs, 2026):
//   token-profiles / token-boosts : 60 req/min
//   latest/dex/*, tokens/v1, token-pairs/v1 : 300 req/min
const BASE = "https://api.dexscreener.com";
const NAME = "dexscreener";

interface DsPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Record<string, { buys: number; sells: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

const isValidMint = (s: unknown): s is string => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

function toSnapshot(p: DsPair): MarketSnapshot | null {
  if (!p || p.chainId !== "solana" || !isValidMint(p.baseToken?.address)) return null;
  const t = (k: string) => ({ buys: p.txns?.[k]?.buys ?? 0, sells: p.txns?.[k]?.sells ?? 0 });
  return {
    mint: p.baseToken.address,
    name: String(p.baseToken.name ?? "").slice(0, 64),
    symbol: String(p.baseToken.symbol ?? "").slice(0, 24),
    pairAddress: p.pairAddress ?? null,
    dexId: p.dexId ?? null,
    pairCreatedAt: p.pairCreatedAt ? new Date(p.pairCreatedAt) : null,
    priceUsd: n(p.priceUsd),
    priceNative: n(p.priceNative),
    marketCap: n(p.marketCap),
    fdv: n(p.fdv),
    liquidityUsd: n(p.liquidity?.usd),
    volume: { m5: n(p.volume?.m5), h1: n(p.volume?.h1), h6: n(p.volume?.h6), h24: n(p.volume?.h24) },
    txns: { m5: t("m5"), h1: t("h1"), h6: t("h6"), h24: t("h24") },
    priceChange: { m5: n(p.priceChange?.m5), h1: n(p.priceChange?.h1), h6: n(p.priceChange?.h6), h24: n(p.priceChange?.h24) },
    fetchedAt: new Date(),
    source: NAME,
  };
}

/** Pick the most liquid SOL/USDC-quoted pair for each base token. */
function bestPairs(pairs: DsPair[]): Map<string, MarketSnapshot> {
  const out = new Map<string, MarketSnapshot>();
  for (const p of pairs) {
    const s = toSnapshot(p);
    if (!s) continue;
    // Only consider pairs quoted in SOL or USDC; other quotes give misleading prices.
    const q = p.quoteToken?.symbol?.toUpperCase();
    if (q !== "SOL" && q !== "WSOL" && q !== "USDC") continue;
    const prev = out.get(s.mint);
    if (!prev || (s.liquidityUsd ?? 0) > (prev.liquidityUsd ?? 0)) out.set(s.mint, s);
  }
  return out;
}

export class DexScreenerProvider implements TokenDiscoveryProvider, MarketDataProvider {
  readonly name = NAME;
  isConfigured() {
    return true;
  }

  /**
   * Discovery pulls from several independent feeds so we are not dependent on
   * "trending"/paid boosts alone:
   *  1. latest token profiles (newly listed / newly marketed tokens)
   *  2. latest boosted tokens (paid promotion — treated as a hint only)
   *  3. search feeds for recently active Solana pairs (pump.fun graduates,
   *     Raydium, Meteora) sorted by DexScreener relevance
   */
  async discover(): Promise<DiscoveredToken[]> {
    const found = new Map<string, DiscoveredToken>();
    const add = (mint: unknown, source: string) => {
      if (isValidMint(mint) && mint !== SOL_MINT && !found.has(mint)) found.set(mint, { mint, source });
    };
    const tasks: Promise<void>[] = [
      fetchJson<{ chainId: string; tokenAddress: string }[]>(`${BASE}/token-profiles/latest/v1`, { provider: NAME, ratePerMinute: 50, cacheTtlMs: 45_000 })
        .then((r) => (Array.isArray(r) ? r : []).filter((x) => x.chainId === "solana").forEach((x) => add(x.tokenAddress, "profiles")))
        .catch(() => undefined),
      fetchJson<{ chainId: string; tokenAddress: string }[]>(`${BASE}/token-boosts/latest/v1`, { provider: NAME, ratePerMinute: 50, cacheTtlMs: 45_000 })
        .then((r) => (Array.isArray(r) ? r : []).filter((x) => x.chainId === "solana").forEach((x) => add(x.tokenAddress, "boosts")))
        .catch(() => undefined),
    ];
    for (const q of ["SOL pump", "raydium SOL", "meteora SOL", "pumpswap"]) {
      tasks.push(
        fetchJson<{ pairs: DsPair[] }>(`${BASE}/latest/dex/search?q=${encodeURIComponent(q)}`, { provider: NAME, ratePerMinute: 250, cacheTtlMs: 45_000 })
          .then((r) => {
            const pairs = Array.isArray(r?.pairs) ? r.pairs : [];
            for (const p of pairs) {
              if (p.chainId !== "solana") continue;
              const h1 = p.volume?.h1 ?? 0;
              const tx = (p.txns?.h1?.buys ?? 0) + (p.txns?.h1?.sells ?? 0);
              // "newly active": meaningful volume + multiple participants, not just listed
              if (h1 >= 2000 && tx >= 20) add(p.baseToken?.address, `search:${q.split(" ")[0]}`);
            }
          })
          .catch(() => undefined),
      );
    }
    await Promise.all(tasks);
    return [...found.values()];
  }

  async getMarketSnapshots(mints: string[]): Promise<Map<string, MarketSnapshot>> {
    const out = new Map<string, MarketSnapshot>();
    const uniq = [...new Set(mints.filter(isValidMint))];
    for (let i = 0; i < uniq.length; i += 30) {
      const batch = uniq.slice(i, i + 30);
      try {
        const pairs = await fetchJson<DsPair[]>(`${BASE}/tokens/v1/solana/${batch.join(",")}`, { provider: NAME, ratePerMinute: 250, cacheTtlMs: 15_000 });
        for (const [k, v] of bestPairs(Array.isArray(pairs) ? pairs : [])) out.set(k, v);
      } catch {
        // one failed batch must not kill the scan; callers see missing entries
      }
    }
    return out;
  }

  async getSolPriceUsd(): Promise<number | null> {
    try {
      const pairs = await fetchJson<DsPair[]>(`${BASE}/tokens/v1/solana/${SOL_MINT}`, { provider: NAME, ratePerMinute: 250, cacheTtlMs: 30_000 });
      const usdc = (Array.isArray(pairs) ? pairs : []).filter((p) => p.quoteToken?.symbol === "USDC" && p.baseToken?.address === SOL_MINT);
      usdc.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      return n(usdc[0]?.priceUsd);
    } catch {
      return null;
    }
  }
}
