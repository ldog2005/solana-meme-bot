import type { ExecutionProvider, ExecutionRequest, ExecutionResult } from "../core/types";
import { num, type SettingsMap } from "../config/settings";
import { estimatePriceImpactPct } from "../engine/impact";

// ---------------------------------------------------------------------------
// PaperExecutionProvider — simulates realistic fills:
//   • price impact from pool maths (constant product approximation)
//   • random adverse slippage proportional to recent volatility
//   • execution latency with price drift during the delay
//   • fixed network + priority fee
//   • probabilistic failures (congestion / slippage exceeded)
//   • partial fills for large sells relative to liquidity
// It NEVER fills better than the max-slippage gate would allow; if the
// simulated slippage exceeds the limit the order FAILS, as it would on-chain.
// ---------------------------------------------------------------------------

export interface PaperContext {
  settings: SettingsMap;
  /** 5-minute % change, used as a volatility proxy for drift. */
  volatility5mPct: number | null;
  rng?: () => number;
}

export class PaperExecutionProvider implements ExecutionProvider {
  readonly name = "paper";
  readonly mode = "PAPER" as const;
  constructor(private ctx: PaperContext) {}
  isConfigured() {
    return true;
  }

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    const s = this.ctx.settings;
    const rng = this.ctx.rng ?? Math.random;
    const started = Date.now();
    const latency = Math.max(0, Math.round(num(s, "PAPER_LATENCY_MS") * (0.5 + rng())));
    const fee = num(s, "PAPER_FEE_SOL");

    const tradeSol = req.side === "BUY" ? req.amount : req.amount * req.expectedPriceSol;
    const tradeUsd = tradeSol * req.solPriceUsd;
    const impact = estimatePriceImpactPct(tradeUsd, req.liquidityUsd);

    // Random adverse slippage: baseline 0.1-0.6%, scaled by volatility.
    const vol = Math.min(Math.abs(this.ctx.volatility5mPct ?? 2), 40);
    const randomSlip = (0.1 + rng() * 0.5) * (1 + vol / 10);
    // Price drift during latency: volatility-scaled, direction random but biased against us.
    const drift = (vol / 5) * (latency / 1000) * (rng() * 1.2 - 0.4);

    // Same rule as the live provider: refuse when the (quoted) impact exceeds the
    // caller's max. Emergency exits pass wider caps; beyond those we fail + alert.
    if (impact > req.maxPriceImpactPct) {
      return { status: "FAILED", executedPriceSol: req.expectedPriceSol, tokenAmount: 0, solAmount: 0, slippagePct: 0, priceImpactPct: impact, feeSol: 0, latencyMs: 0, reason: `Price impact ${impact.toFixed(2)}% exceeds max ${req.maxPriceImpactPct}%`, mode: "PAPER" };
    }

    // Failure model: base rate + higher when impact approaches the max.
    const failBase = num(s, "PAPER_FAIL_RATE_PCT") / 100;
    const failProb = failBase + Math.max(0, impact - req.maxPriceImpactPct * 0.6) / 50;
    if (rng() < failProb) {
      return { status: "FAILED", executedPriceSol: req.expectedPriceSol, tokenAmount: 0, solAmount: 0, slippagePct: 0, priceImpactPct: impact, feeSol: fee * 0.3, latencyMs: latency, reason: "Simulated transaction failure (congestion / slippage exceeded)", mode: "PAPER" };
    }

    const adversePct = impact + randomSlip + (req.side === "BUY" ? Math.max(drift, -vol) : -Math.min(drift, vol));
    // On-chain semantics: the router quote already includes price impact; the
    // slippage tolerance applies on top of the quoted amount. So the tx fails
    // when the *extra* adverse move (beyond impact) exceeds maxSlippage.
    if (adversePct - impact > req.maxSlippagePct) {
      return { status: "FAILED", executedPriceSol: req.expectedPriceSol, tokenAmount: 0, solAmount: 0, slippagePct: adversePct, priceImpactPct: impact, feeSol: fee * 0.3, latencyMs: latency, reason: `Simulated fill outside slippage tolerance (${adversePct.toFixed(2)}%)`, mode: "PAPER" };
    }

    const executedPrice = req.side === "BUY" ? req.expectedPriceSol * (1 + adversePct / 100) : req.expectedPriceSol * (1 - adversePct / 100);

    if (req.side === "BUY") {
      const solSpent = req.amount;
      const tokens = solSpent / executedPrice;
      return { status: "FILLED", executedPriceSol: executedPrice, tokenAmount: tokens, solAmount: solSpent, slippagePct: adversePct, priceImpactPct: impact, feeSol: fee, latencyMs: latency + (Date.now() - started), mode: "PAPER" };
    }
    // SELL: partial fill when trade is > 3% of liquidity (realistic for thin pools).
    let tokens = req.amount;
    let status: ExecutionResult["status"] = "FILLED";
    const liqSol = req.solPriceUsd > 0 ? req.liquidityUsd / req.solPriceUsd : Infinity;
    if (tradeSol > liqSol * 0.03) {
      tokens = tokens * 0.6;
      status = "PARTIAL";
    }
    const solOut = tokens * executedPrice;
    return { status, executedPriceSol: executedPrice, tokenAmount: tokens, solAmount: solOut, slippagePct: adversePct, priceImpactPct: impact, feeSol: fee, latencyMs: latency + (Date.now() - started), reason: status === "PARTIAL" ? "Partial fill: order large relative to pool" : undefined, mode: "PAPER" };
  }
}
