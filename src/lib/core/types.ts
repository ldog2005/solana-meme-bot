// ---------------------------------------------------------------------------
// Core domain types shared across scanner, engines, execution and UI.
// ---------------------------------------------------------------------------

export type RiskLevel = "LOW" | "MODERATE" | "HIGH" | "CRITICAL" | "UNKNOWN";
export type Decision = "BUY" | "NO_TRADE" | "REJECTED" | "WATCH" | "SELL";
export type Classification =
  | "EARLY_OPPORTUNITY"
  | "DEVELOPING_OPPORTUNITY"
  | "OVEREXTENDED"
  | "DETERIORATING"
  | "REJECTED";
export type MarketRegime = "HOT" | "NORMAL" | "WEAK" | "EXTREMELY_RISKY" | "UNKNOWN";
export type TradingMode = "PAPER" | "LIVE";
export type AuthorityStatus = "REVOKED" | "ACTIVE" | "UNKNOWN";
export type DataSource = "LIVE" | "DEMO" | "UNAVAILABLE";

/** Market snapshot for a token as returned by a MarketDataProvider. */
export interface MarketSnapshot {
  mint: string;
  name: string;
  symbol: string;
  pairAddress: string | null;
  dexId: string | null;
  pairCreatedAt: Date | null;
  priceUsd: number | null;
  priceNative: number | null; // price in SOL
  marketCap: number | null;
  fdv: number | null;
  liquidityUsd: number | null;
  volume: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  priceChange: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  fetchedAt: Date;
  source: string;
}

/** Discovery candidate (minimal info before enrichment). */
export interface DiscoveredToken {
  mint: string;
  source: string;
  hint?: string;
}

/** On-chain facts, ideally independently verified via RPC. */
export interface OnChainInfo {
  mint: string;
  mintAuthority: AuthorityStatus;
  freezeAuthority: AuthorityStatus;
  decimals: number | null;
  supply: number | null;
  tokenProgram: "spl-token" | "token-2022" | "unknown";
  largestHolders: { address: string; amount: number; pct: number }[] | null;
  fetchedAt: Date;
  source: string;
}

/** Third-party risk analysis (e.g. RugCheck). */
export interface RiskReport {
  mint: string;
  providerScoreNormalised: number | null; // 0-100, higher = riskier (RugCheck semantics)
  risks: { name: string; level: "danger" | "warn" | "info"; description: string; value?: string }[];
  mintAuthority: AuthorityStatus;
  freezeAuthority: AuthorityStatus;
  lpLockedPct: number | null;
  topHolders: { address: string; pct: number; insider?: boolean }[] | null;
  poolAddresses?: string[];
  creator: string | null;
  creatorPct: number | null;
  totalHolders: number | null;
  rugged: boolean | null;
  mutableMetadata: boolean | null;
  transferFeePct: number | null;
  fetchedAt: Date;
  source: string;
}

export interface SafetyFlag {
  code: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  message: string;
}

export interface SafetyAssessment {
  riskLevel: RiskLevel;
  safetyScore: number; // 0-30 contribution
  passed: boolean; // passes mandatory gate
  flags: SafetyFlag[];
  mintAuthority: AuthorityStatus;
  freezeAuthority: AuthorityStatus;
  lpLockedPct: number | null;
  topHolderPct: number | null;
  top10Pct: number | null;
  creatorPct: number | null;
  dataComplete: boolean;
  providersUsed: string[];
}

export interface ScoreComponent {
  key: string;
  label: string;
  points: number;
  max: number;
  reasons: string[];
}

export interface OpportunityScore {
  overall: number;
  components: ScoreComponent[];
}

export interface QuoteResult {
  inputMint: string;
  outputMint: string;
  inAmount: number; // in base units of input
  outAmount: number;
  priceImpactPct: number; // 0.5 = 0.5%
  routeAvailable: boolean;
  source: string;
  estimated: boolean; // true when derived from pool maths rather than a real router quote
}

export interface ExecutionRequest {
  idempotencyKey: string;
  mint: string;
  symbol: string;
  side: "BUY" | "SELL";
  /** For BUY: SOL to spend. For SELL: token amount to sell. */
  amount: number;
  expectedPriceSol: number; // token price in SOL
  liquidityUsd: number;
  solPriceUsd: number;
  maxSlippagePct: number;
  maxPriceImpactPct: number;
  reason: string;
}

export interface ExecutionResult {
  status: "FILLED" | "PARTIAL" | "FAILED";
  executedPriceSol: number;
  tokenAmount: number;
  solAmount: number;
  slippagePct: number;
  priceImpactPct: number;
  feeSol: number;
  latencyMs: number;
  reason?: string;
  txSignature?: string;
  mode: TradingMode;
}

// ---------------------------------------------------------------------------
// Provider interfaces
// ---------------------------------------------------------------------------

export interface ProviderBase {
  readonly name: string;
  isConfigured(): boolean;
}

export interface TokenDiscoveryProvider extends ProviderBase {
  discover(): Promise<DiscoveredToken[]>;
}

export interface MarketDataProvider extends ProviderBase {
  getMarketSnapshots(mints: string[]): Promise<Map<string, MarketSnapshot>>;
  getSolPriceUsd(): Promise<number | null>;
}

export interface OnChainDataProvider extends ProviderBase {
  getOnChainInfo(mint: string): Promise<OnChainInfo | null>;
  getWalletTokenBalances?(owner: string): Promise<Map<string, number>>;
  getSolBalance?(owner: string): Promise<number | null>;
}

export interface RiskAnalysisProvider extends ProviderBase {
  getRiskReport(mint: string): Promise<RiskReport | null>;
}

export interface WalletAnalysisProvider extends ProviderBase {
  // Reserved for smart-money / wallet cluster providers. No reliable free
  // provider was identified during research; interface kept for extension.
  analyseParticipants(mint: string): Promise<{ suspiciousClusterScore: number | null; notes: string[] }>;
}

export interface SwapQuoteProvider extends ProviderBase {
  quote(params: {
    inputMint: string;
    outputMint: string;
    amountBaseUnits: number;
    slippageBps: number;
  }): Promise<QuoteResult | null>;
}

export interface ExecutionProvider extends ProviderBase {
  readonly mode: TradingMode;
  execute(req: ExecutionRequest): Promise<ExecutionResult>;
}

// ---------------------------------------------------------------------------
// Aggregate candidate used through the pipeline
// ---------------------------------------------------------------------------

export interface Candidate {
  mint: string;
  name: string;
  symbol: string;
  market: MarketSnapshot;
  onChain: OnChainInfo | null;
  risk: RiskReport | null;
  ageMinutes: number | null;
  discoverySource: string;
  solPriceUsd: number;
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const LAMPORTS_PER_SOL = 1_000_000_000;
