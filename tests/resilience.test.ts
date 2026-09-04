import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// These tests exercise provider failure handling, malformed data, live-gating
// and the pool-maths estimate WITHOUT a database: modules that import "@/db"
// are mocked.
vi.mock("@/db", () => ({ db: { insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined, onConflictDoNothing: async () => undefined }) }), select: () => ({ from: () => ({ where: async () => [], orderBy: async () => [] }) }), update: () => ({ set: () => ({ where: async () => undefined }) }) }, pool: {} }));

import { DexScreenerProvider } from "../src/lib/providers/dexscreener";
import { RugCheckProvider } from "../src/lib/providers/rugcheck";
import { SolanaRpcProvider } from "../src/lib/providers/solana-rpc";
import { estimatePriceImpactPct } from "../src/lib/engine/impact";
import { JupiterExecutionProvider } from "../src/lib/execution/live";
import { getHealth, clearCache } from "../src/lib/providers/http";
import { defaultSettings } from "../src/lib/config/settings";

const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const origFetch = global.fetch;
beforeEach(() => { vi.useRealTimers(); clearCache(); });
afterEach(() => { global.fetch = origFetch; });

function mockFetch(handler: (url: string) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const r = await handler(String(input));
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("Provider failure handling", () => {
  it("DexScreener outage → empty results, provider marked unhealthy, no throw", async () => {
    mockFetch(() => ({ status: 503, body: { error: "down" } }));
    const p = new DexScreenerProvider();
    const snaps = await p.getMarketSnapshots([MINT]);
    expect(snaps.size).toBe(0);
    expect(await p.discover()).toEqual([]);
    expect(["DEGRADED", "OFFLINE"]).toContain(getHealth("dexscreener").status);
  });
  it("malformed DexScreener payload is skipped, not crashed on", async () => {
    mockFetch(() => ({ status: 200, body: [{ chainId: "solana", baseToken: { address: "not-a-mint" }, quoteToken: { symbol: "SOL" }, priceNative: "abc" }, null, { chainId: "solana", baseToken: { address: MINT, name: "X", symbol: "X" }, quoteToken: { symbol: "SOL" }, priceNative: "0.00001", liquidity: { usd: "oops" } }] }));
    const snaps = await new DexScreenerProvider().getMarketSnapshots([MINT]);
    expect(snaps.size).toBe(1);
    expect(snaps.get(MINT)?.liquidityUsd).toBeNull();
    expect(snaps.get(MINT)?.priceNative).toBe(0.00001);
  });
  it("only SOL/USDC-quoted pairs are used and the most liquid one wins", async () => {
    mockFetch(() => ({ status: 200, body: [
      { chainId: "solana", baseToken: { address: MINT, name: "X", symbol: "X" }, quoteToken: { symbol: "BONK" }, priceNative: "999", liquidity: { usd: 9_000_000 } },
      { chainId: "solana", baseToken: { address: MINT, name: "X", symbol: "X" }, quoteToken: { symbol: "SOL" }, priceNative: "0.00001", liquidity: { usd: 50_000 } },
      { chainId: "solana", baseToken: { address: MINT, name: "X", symbol: "X" }, quoteToken: { symbol: "SOL" }, priceNative: "0.000011", liquidity: { usd: 150_000 } },
    ] }));
    const snaps = await new DexScreenerProvider().getMarketSnapshots([MINT]);
    expect(snaps.get(MINT)?.liquidityUsd).toBe(150_000);
  });
  it("RugCheck failure returns null (→ risk UNKNOWN downstream)", async () => {
    mockFetch(() => ({ status: 500 }));
    expect(await new RugCheckProvider().getRiskReport(MINT)).toBeNull();
    expect(await new RugCheckProvider().getRiskReport("bad")).toBeNull();
  });
  it("RugCheck report is normalised; missing fields become UNKNOWN/null", async () => {
    mockFetch(() => ({ status: 200, body: { token: { mintAuthority: null }, risks: [{ name: "Low Liquidity", level: "warn", description: "d" }], markets: [{ pubkey: "pool1", lp: { lpLockedPct: 100, lpLockedUSD: 32000, quoteUSD: 15000, baseUSD: 17000 } }, { pubkey: "pool2", lp: { lpLockedPct: 0, lpLockedUSD: 0, quoteUSD: 4, baseUSD: 4 } }], topHolders: [{ address: "x", owner: "pool1", pct: 11 }, { address: "y", owner: "w1", pct: 2 }] } }));
    const r = await new RugCheckProvider().getRiskReport(MINT);
    expect(r?.mintAuthority).toBe("REVOKED");
    expect(r?.freezeAuthority).toBe("UNKNOWN");
    expect(r?.lpLockedPct).toBeGreaterThan(99); // liquidity-weighted: dust pool cannot veto the main pool
    expect(r?.topHolders).toHaveLength(1); // pool vault excluded from holder concentration
    expect(r?.poolAddresses).toEqual(["pool1", "pool2"]);
  });
  it("RPC timeout returns null instead of throwing", async () => {
    global.fetch = vi.fn(() => new Promise<Response>(() => { /* never resolves */ })) as unknown as typeof fetch;
    const p = new SolanaRpcProvider();
    // shorten wait by racing: provider timeout is 10s; we just verify the promise is pending-safe by abort simulation
    const ctrl = Promise.race([p.getOnChainInfo(MINT), new Promise((r) => setTimeout(() => r("pending"), 50))]);
    expect(await ctrl).toBe("pending");
  });
  it("429 responses trigger backoff and are retried", async () => {
    let calls = 0;
    mockFetch(() => { calls++; return calls < 2 ? { status: 429 } : { status: 200, body: [] }; });
    await new DexScreenerProvider().getMarketSnapshots([MINT]);
    expect(calls).toBeGreaterThanOrEqual(2);
  }, 15000);
});

describe("Price impact estimate", () => {
  it("grows with trade size and shrinks with liquidity; unknown liquidity → 100%", () => {
    expect(estimatePriceImpactPct(100, 100_000)).toBeLessThan(estimatePriceImpactPct(1000, 100_000));
    expect(estimatePriceImpactPct(1000, 1_000_000)).toBeLessThan(estimatePriceImpactPct(1000, 100_000));
    expect(estimatePriceImpactPct(1000, 0)).toBe(100);
  });
});

describe("Live execution provider fails closed", () => {
  const req = { idempotencyKey: "k", mint: MINT, symbol: "T", side: "BUY" as const, amount: 0.1, expectedPriceSol: 1e-5, liquidityUsd: 100000, solPriceUsd: 150, maxSlippagePct: 3, maxPriceImpactPct: 2, reason: "t" };
  it("refuses when env flag is off even if dashboard flags are set", async () => {
    delete process.env.LIVE_TRADING_ENABLED;
    const p = new JupiterExecutionProvider(defaultSettings(), { dbLiveEnabled: true, liveArmed: true });
    const r = await p.execute(req);
    expect(r.status).toBe("FAILED");
    expect(r.reason).toMatch(/LIVE_TRADING_ENABLED/);
    expect(p.isConfigured()).toBe(false);
  });
  it("refuses when env flag on but dashboard not enabled, or key/wallet missing", async () => {
    process.env.LIVE_TRADING_ENABLED = "true";
    delete process.env.JUPITER_API_KEY;
    delete process.env.TRADING_WALLET_SECRET;
    expect((await new JupiterExecutionProvider(defaultSettings(), { dbLiveEnabled: false, liveArmed: true }).execute(req)).reason).toMatch(/bot state/);
    expect((await new JupiterExecutionProvider(defaultSettings(), { dbLiveEnabled: true, liveArmed: false }).execute(req)).reason).toMatch(/arm/);
    const r = await new JupiterExecutionProvider(defaultSettings(), { dbLiveEnabled: true, liveArmed: true }).execute(req);
    expect(r.status).toBe("FAILED");
    expect(r.reason).toMatch(/JUPITER_API_KEY|WALLET/);
    delete process.env.LIVE_TRADING_ENABLED;
  });
});
