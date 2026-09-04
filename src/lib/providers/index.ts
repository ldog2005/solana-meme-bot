import { DexScreenerProvider } from "./dexscreener";
import { RugCheckProvider } from "./rugcheck";
import { SolanaRpcProvider } from "./solana-rpc";
import { JupiterProvider } from "./jupiter";
import type { MarketDataProvider, OnChainDataProvider, RiskAnalysisProvider, SwapQuoteProvider, TokenDiscoveryProvider } from "../core/types";

/**
 * Provider registry. Each role can be swapped or given fallbacks without
 * touching engine code. Instances are cached on globalThis so Next.js hot
 * reload / route isolation does not create duplicate rate-limit buckets.
 */
interface Registry {
  discovery: TokenDiscoveryProvider[];
  market: MarketDataProvider;
  onchain: OnChainDataProvider & SolanaRpcProvider;
  risk: RiskAnalysisProvider;
  quotes: SwapQuoteProvider & JupiterProvider;
}

const g = globalThis as typeof globalThis & { __memeBotProviders?: Registry };

export function providers(): Registry {
  if (!g.__memeBotProviders) {
    const dex = new DexScreenerProvider();
    g.__memeBotProviders = {
      discovery: [dex],
      market: dex,
      onchain: new SolanaRpcProvider(),
      risk: new RugCheckProvider(),
      quotes: new JupiterProvider(),
    };
  }
  return g.__memeBotProviders;
}

export function providerConfigSummary() {
  const p = providers();
  return {
    dexscreener: { configured: true, note: "Public API, no key. Discovery + market data." },
    rugcheck: { configured: true, note: process.env.RUGCHECK_API_KEY ? "API key set" : "Public access (optional RUGCHECK_API_KEY raises limits)" },
    "solana-rpc": { configured: true, note: p.onchain.describe() },
    jupiter: { configured: p.quotes.isConfigured(), note: p.quotes.isConfigured() ? "API key set — real router quotes" : "JUPITER_API_KEY missing — price impact is ESTIMATED from pool maths; live execution impossible" },
    birdeye: { configured: Boolean(process.env.BIRDEYE_API_KEY), note: "Optional. Not wired in v1 (paid tiers required for useful limits)." },
  };
}
