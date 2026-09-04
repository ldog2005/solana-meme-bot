import { fetchJson, markNotConfigured } from "./http";
import type { QuoteResult, SwapQuoteProvider } from "../core/types";

// Jupiter Swap API (2026): https://api.jup.ag/swap/v1/{quote,swap}
// All api.jup.ag endpoints require an API key (free tier via portal.jup.ag).
// Without JUPITER_API_KEY the provider reports NOT_CONFIGURED; quotes then
// fall back to a pool-maths *estimate* that is clearly flagged `estimated`.
const BASE = process.env.JUPITER_API_BASE || "https://api.jup.ag";
const NAME = "jupiter";

interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string | number;
  routePlan?: unknown[];
  slippageBps?: number;
}

export class JupiterProvider implements SwapQuoteProvider {
  readonly name = NAME;
  private apiKey = process.env.JUPITER_API_KEY;

  isConfigured() {
    return Boolean(this.apiKey);
  }

  private headers(): Record<string, string> {
    return this.apiKey ? { "x-api-key": this.apiKey } : {};
  }

  async quote(params: { inputMint: string; outputMint: string; amountBaseUnits: number; slippageBps: number }): Promise<QuoteResult | null> {
    if (!this.apiKey) {
      markNotConfigured(NAME);
      return null;
    }
    const q = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: String(Math.floor(params.amountBaseUnits)),
      slippageBps: String(params.slippageBps),
      restrictIntermediateTokens: "true",
    });
    try {
      const r = await fetchJson<JupQuote>(`${BASE}/swap/v1/quote?${q}`, { provider: NAME, ratePerMinute: 55, headers: this.headers(), timeoutMs: 8000, retries: 1 });
      if (!r?.outAmount) return null;
      return {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        inAmount: Number(r.inAmount),
        outAmount: Number(r.outAmount),
        priceImpactPct: Math.abs(Number(r.priceImpactPct)) * 100,
        routeAvailable: Array.isArray(r.routePlan) ? r.routePlan.length > 0 : true,
        source: NAME,
        estimated: false,
      };
    } catch {
      return null;
    }
  }

  /** Raw quote object needed by /swap. Returns null if not configured. */
  async rawQuote(params: { inputMint: string; outputMint: string; amountBaseUnits: number; slippageBps: number }): Promise<JupQuote | null> {
    if (!this.apiKey) return null;
    const q = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: String(Math.floor(params.amountBaseUnits)),
      slippageBps: String(params.slippageBps),
      restrictIntermediateTokens: "true",
    });
    try {
      return await fetchJson<JupQuote>(`${BASE}/swap/v1/quote?${q}`, { provider: NAME, ratePerMinute: 55, headers: this.headers(), timeoutMs: 8000, retries: 1 });
    } catch {
      return null;
    }
  }

  /** Build an unsigned swap transaction (base64). Only used by the live provider. */
  async buildSwapTransaction(quoteResponse: JupQuote, userPublicKey: string): Promise<{ swapTransaction: string; lastValidBlockHeight: number } | null> {
    if (!this.apiKey) return null;
    try {
      return await fetchJson<{ swapTransaction: string; lastValidBlockHeight: number }>(`${BASE}/swap/v1/swap`, {
        provider: NAME,
        ratePerMinute: 55,
        method: "POST",
        headers: this.headers(),
        body: {
          quoteResponse,
          userPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          dynamicSlippage: false, // never let the router widen slippage for us
          prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "high" } },
        },
        timeoutMs: 10_000,
        retries: 0,
      });
    } catch {
      return null;
    }
  }
}

export { estimatePriceImpactPct } from "../engine/impact";
