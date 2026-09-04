import { fetchJson, markNotConfigured } from "./http";
import type { AuthorityStatus, OnChainDataProvider, OnChainInfo } from "../core/types";

// Solana JSON-RPC via plain fetch (no heavy SDK needed for read paths).
// Use SOLANA_RPC_URL (Helius / QuickNode / Triton recommended). Falls back to
// the public mainnet endpoint which is heavily rate-limited — that is why
// on-chain verification is only performed for tokens that pass pre-filters.
const NAME = "solana-rpc";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

let idCounter = 1;

export class SolanaRpcProvider implements OnChainDataProvider {
  readonly name = NAME;
  private url = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  private isPublic = !process.env.SOLANA_RPC_URL;

  isConfigured() {
    return true;
  }
  describe() {
    return this.isPublic ? "public mainnet-beta (rate-limited)" : new URL(this.url).host;
  }

  private async rpc<T>(method: string, params: unknown[], cacheTtlMs = 0): Promise<T> {
    const body = { jsonrpc: "2.0", id: idCounter++, method, params };
    const res = await fetchJson<{ result?: T; error?: { message: string } }>(this.url, {
      provider: NAME,
      ratePerMinute: this.isPublic ? 40 : 300,
      method: "POST",
      body,
      cacheTtlMs,
      cacheKey: cacheTtlMs ? `rpc:${method}:${JSON.stringify(params)}` : undefined,
      timeoutMs: 10_000,
      retries: this.isPublic ? 0 : 1, // public RPC 429s aggressively; do not stall the scan
    });
    if (res.error) throw new Error(`RPC ${method}: ${res.error.message}`);
    return res.result as T;
  }

  async getOnChainInfo(mint: string): Promise<OnChainInfo | null> {
    try {
      const acct = await this.rpc<{
        value: { owner: string; data: { parsed?: { info?: { mintAuthority?: string | null; freezeAuthority?: string | null; decimals?: number; supply?: string } } } } | null;
      }>("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }], 120_000);
      if (!acct?.value) return null;
      const info = acct.value.data?.parsed?.info;
      const owner = acct.value.owner;
      const program = owner === TOKEN_PROGRAM ? "spl-token" : owner === TOKEN_2022 ? "token-2022" : "unknown";
      const auth = (v: string | null | undefined): AuthorityStatus => (v === undefined ? "UNKNOWN" : v ? "ACTIVE" : "REVOKED");
      const decimals = typeof info?.decimals === "number" ? info.decimals : null;
      const supplyRaw = info?.supply ? Number(info.supply) : null;
      const supply = supplyRaw !== null && decimals !== null ? supplyRaw / 10 ** decimals : null;

      let largestHolders: OnChainInfo["largestHolders"] = null;
      // Holder distribution normally comes from RugCheck; only spend RPC quota
      // on it when a dedicated RPC is configured.
      if (!this.isPublic) try {
        const largest = await this.rpc<{ value: { address: string; uiAmount: number | null }[] }>("getTokenLargestAccounts", [mint, { commitment: "confirmed" }], 60_000);
        if (largest?.value && supply) {
          largestHolders = largest.value
            .map((v) => ({ address: v.address, amount: v.uiAmount ?? 0, pct: ((v.uiAmount ?? 0) / supply) * 100 }))
            .filter((h) => Number.isFinite(h.pct));
        }
      } catch {
        largestHolders = null; // partial info is still useful; caller treats null as unknown
      }
      return { mint, mintAuthority: auth(info?.mintAuthority), freezeAuthority: auth(info?.freezeAuthority), decimals, supply, tokenProgram: program, largestHolders, fetchedAt: new Date(), source: NAME };
    } catch {
      return null;
    }
  }

  async getSolBalance(owner: string): Promise<number | null> {
    try {
      const r = await this.rpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }]);
      return typeof r?.value === "number" ? r.value / 1e9 : null;
    } catch {
      return null;
    }
  }

  async getWalletTokenBalances(owner: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
      try {
        const r = await this.rpc<{ value: { account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null } } } } } }[] }>(
          "getTokenAccountsByOwner",
          [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }],
        );
        for (const a of r?.value ?? []) {
          const info = a.account.data.parsed.info;
          const amt = info.tokenAmount.uiAmount ?? 0;
          if (amt > 0) out.set(info.mint, (out.get(info.mint) ?? 0) + amt);
        }
      } catch {
        /* skip program */
      }
    }
    return out;
  }

  async sendRawTransaction(base64Tx: string): Promise<string> {
    return this.rpc<string>("sendTransaction", [base64Tx, { encoding: "base64", skipPreflight: false, maxRetries: 2 }]);
  }

  async getSignatureStatus(sig: string): Promise<"confirmed" | "finalized" | "failed" | "pending"> {
    const r = await this.rpc<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>("getSignatureStatuses", [[sig], { searchTransactionHistory: true }]);
    const s = r?.value?.[0];
    if (!s) return "pending";
    if (s.err) return "failed";
    if (s.confirmationStatus === "finalized") return "finalized";
    if (s.confirmationStatus === "confirmed") return "confirmed";
    return "pending";
  }
}

export { markNotConfigured };
