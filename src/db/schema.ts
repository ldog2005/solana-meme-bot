import {
  pgTable,
  serial,
  text,
  varchar,
  doublePrecision,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Tokens & snapshots
// ---------------------------------------------------------------------------

export const tokens = pgTable(
  "tokens",
  {
    mint: varchar("mint", { length: 64 }).primaryKey(),
    chain: varchar("chain", { length: 16 }).notNull().default("solana"),
    name: text("name"),
    symbol: text("symbol"),
    pairAddress: varchar("pair_address", { length: 64 }),
    dexId: text("dex_id"),
    launchTime: timestamp("launch_time", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    discoverySource: text("discovery_source"),
    creator: varchar("creator", { length: 64 }),
    // latest cached values (denormalised for fast dashboard queries)
    price: doublePrecision("price"),
    marketCap: doublePrecision("market_cap"),
    liquidity: doublePrecision("liquidity"),
    volume1h: doublePrecision("volume_1h"),
    volume24h: doublePrecision("volume_24h"),
    holderCount: integer("holder_count"),
    overallScore: doublePrecision("overall_score"),
    safetyScore: doublePrecision("safety_score"),
    riskLevel: varchar("risk_level", { length: 16 }),
    tradeStatus: varchar("trade_status", { length: 32 }).notNull().default("DISCOVERED"),
    lastDecision: varchar("last_decision", { length: 16 }),
    lastDecisionReason: text("last_decision_reason"),
    blacklisted: boolean("blacklisted").notNull().default(false),
    whitelisted: boolean("whitelisted").notNull().default(false),
    dataSource: varchar("data_source", { length: 32 }).notNull().default("LIVE"),
  },
  (t) => [index("tokens_score_idx").on(t.overallScore), index("tokens_last_seen_idx").on(t.lastSeenAt)],
);

export const tokenSnapshots = pgTable(
  "token_snapshots",
  {
    id: serial("id").primaryKey(),
    mint: varchar("mint", { length: 64 }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    price: doublePrecision("price"),
    marketCap: doublePrecision("market_cap"),
    liquidity: doublePrecision("liquidity"),
    volume5m: doublePrecision("volume_5m"),
    volume1h: doublePrecision("volume_1h"),
    volume6h: doublePrecision("volume_6h"),
    volume24h: doublePrecision("volume_24h"),
    buys5m: integer("buys_5m"),
    sells5m: integer("sells_5m"),
    buys1h: integer("buys_1h"),
    sells1h: integer("sells_1h"),
    priceChange5m: doublePrecision("price_change_5m"),
    priceChange1h: doublePrecision("price_change_1h"),
    priceChange6h: doublePrecision("price_change_6h"),
    priceChange24h: doublePrecision("price_change_24h"),
    holderCount: integer("holder_count"),
    topHolderPct: doublePrecision("top_holder_pct"),
    top10Pct: doublePrecision("top10_pct"),
    overallScore: doublePrecision("overall_score"),
    safetyScore: doublePrecision("safety_score"),
    riskLevel: varchar("risk_level", { length: 16 }),
    scores: jsonb("scores"),
    raw: jsonb("raw"),
  },
  (t) => [index("snap_mint_time_idx").on(t.mint, t.capturedAt)],
);

export const riskAssessments = pgTable(
  "risk_assessments",
  {
    id: serial("id").primaryKey(),
    mint: varchar("mint", { length: 64 }).notNull(),
    assessedAt: timestamp("assessed_at", { withTimezone: true }).notNull().defaultNow(),
    riskLevel: varchar("risk_level", { length: 16 }).notNull(),
    safetyScore: doublePrecision("safety_score").notNull(),
    passed: boolean("passed").notNull(),
    mintAuthority: varchar("mint_authority", { length: 16 }),
    freezeAuthority: varchar("freeze_authority", { length: 16 }),
    lpLockedPct: doublePrecision("lp_locked_pct"),
    topHolderPct: doublePrecision("top_holder_pct"),
    top10Pct: doublePrecision("top10_pct"),
    creatorPct: doublePrecision("creator_pct"),
    flags: jsonb("flags").notNull(),
    providers: jsonb("providers"),
  },
  (t) => [index("risk_mint_idx").on(t.mint, t.assessedAt)],
);

// ---------------------------------------------------------------------------
// Decisions / journal
// ---------------------------------------------------------------------------

export const decisions = pgTable(
  "decisions",
  {
    id: serial("id").primaryKey(),
    mint: varchar("mint", { length: 64 }).notNull(),
    symbol: text("symbol"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    decision: varchar("decision", { length: 16 }).notNull(), // BUY | NO_TRADE | REJECTED | WATCH | SELL
    classification: varchar("classification", { length: 32 }),
    overallScore: doublePrecision("overall_score"),
    safetyScore: doublePrecision("safety_score"),
    riskLevel: varchar("risk_level", { length: 16 }),
    primaryReason: text("primary_reason"),
    reasons: jsonb("reasons"),
    positives: jsonb("positives"),
    marketRegime: varchar("market_regime", { length: 24 }),
    strategyVersion: varchar("strategy_version", { length: 32 }),
    explanation: text("explanation"),
    manual: boolean("manual").notNull().default(false),
    scores: jsonb("scores"),
  },
  (t) => [index("decisions_time_idx").on(t.decidedAt), index("decisions_mint_idx").on(t.mint)],
);

// ---------------------------------------------------------------------------
// Positions & trades
// ---------------------------------------------------------------------------

export const positions = pgTable(
  "positions",
  {
    id: serial("id").primaryKey(),
    mint: varchar("mint", { length: 64 }).notNull(),
    symbol: text("symbol"),
    mode: varchar("mode", { length: 8 }).notNull().default("PAPER"), // PAPER | LIVE
    status: varchar("status", { length: 16 }).notNull().default("OPEN"), // OPEN | CLOSED
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    entryPrice: doublePrecision("entry_price").notNull(),
    entryScore: doublePrecision("entry_score"),
    entryLiquidity: doublePrecision("entry_liquidity"),
    entryMarketCap: doublePrecision("entry_market_cap"),
    tokenAgeMinutes: doublePrecision("token_age_minutes"),
    sizeSol: doublePrecision("size_sol").notNull(),
    initialTokens: doublePrecision("initial_tokens").notNull(),
    remainingTokens: doublePrecision("remaining_tokens").notNull(),
    costBasisSol: doublePrecision("cost_basis_sol").notNull(),
    realizedPnlSol: doublePrecision("realized_pnl_sol").notNull().default(0),
    feesSol: doublePrecision("fees_sol").notNull().default(0),
    stopPrice: doublePrecision("stop_price").notNull(),
    trailingStopPrice: doublePrecision("trailing_stop_price"),
    highestPrice: doublePrecision("highest_price").notNull(),
    lowestPrice: doublePrecision("lowest_price").notNull(),
    currentPrice: doublePrecision("current_price"),
    takenProfitLevels: jsonb("taken_profit_levels").notNull().default([]),
    exitReason: text("exit_reason"),
    strategyVersion: varchar("strategy_version", { length: 32 }).notNull(),
    lastPriceAt: timestamp("last_price_at", { withTimezone: true }),
    reconciliation: varchar("reconciliation", { length: 24 }).notNull().default("OK"),
    notes: text("notes"),
  },
  (t) => [index("positions_status_idx").on(t.status), index("positions_mint_idx").on(t.mint)],
);

export const trades = pgTable(
  "trades",
  {
    id: serial("id").primaryKey(),
    positionId: integer("position_id"),
    mint: varchar("mint", { length: 64 }).notNull(),
    symbol: text("symbol"),
    mode: varchar("mode", { length: 8 }).notNull().default("PAPER"),
    side: varchar("side", { length: 4 }).notNull(), // BUY | SELL
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull().defaultNow(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    expectedPrice: doublePrecision("expected_price").notNull(),
    executedPrice: doublePrecision("executed_price").notNull(),
    tokenAmount: doublePrecision("token_amount").notNull(),
    solAmount: doublePrecision("sol_amount").notNull(),
    slippagePct: doublePrecision("slippage_pct").notNull(),
    priceImpactPct: doublePrecision("price_impact_pct").notNull(),
    feeSol: doublePrecision("fee_sol").notNull(),
    latencyMs: integer("latency_ms"),
    status: varchar("status", { length: 16 }).notNull(), // FILLED | PARTIAL | FAILED
    reason: text("reason"),
    realizedPnlSol: doublePrecision("realized_pnl_sol"),
    txSignature: text("tx_signature"),
    strategyVersion: varchar("strategy_version", { length: 32 }),
    manual: boolean("manual").notNull().default(false),
  },
  (t) => [uniqueIndex("trades_idem_idx").on(t.idempotencyKey), index("trades_time_idx").on(t.executedAt)],
);

export const portfolioSnapshots = pgTable("portfolio_snapshots", {
  id: serial("id").primaryKey(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  mode: varchar("mode", { length: 8 }).notNull().default("PAPER"),
  cashSol: doublePrecision("cash_sol").notNull(),
  positionsValueSol: doublePrecision("positions_value_sol").notNull(),
  equitySol: doublePrecision("equity_sol").notNull(),
  realizedPnlSol: doublePrecision("realized_pnl_sol").notNull(),
  unrealizedPnlSol: doublePrecision("unrealized_pnl_sol").notNull(),
  openPositions: integer("open_positions").notNull(),
});

// ---------------------------------------------------------------------------
// Strategy, settings, system
// ---------------------------------------------------------------------------

export const strategyVersions = pgTable("strategy_versions", {
  id: serial("id").primaryKey(),
  version: varchar("version", { length: 32 }).notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  parameters: jsonb("parameters").notNull(),
  description: text("description"),
});

export const settings = pgTable("settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const botState = pgTable("bot_state", {
  id: integer("id").primaryKey().default(1),
  mode: varchar("mode", { length: 8 }).notNull().default("PAPER"),
  running: boolean("running").notNull().default(true),
  emergencyStop: boolean("emergency_stop").notNull().default(false),
  liveTradingEnabled: boolean("live_trading_enabled").notNull().default(false),
  liveConfirmedAt: timestamp("live_confirmed_at", { withTimezone: true }),
  paperCashSol: doublePrecision("paper_cash_sol").notNull().default(10),
  paperStartingSol: doublePrecision("paper_starting_sol").notNull().default(10),
  lastScanAt: timestamp("last_scan_at", { withTimezone: true }),
  lastScanOk: boolean("last_scan_ok"),
  lastScanSummary: jsonb("last_scan_summary"),
  lastDataUpdateAt: timestamp("last_data_update_at", { withTimezone: true }),
  lastPositionCheckAt: timestamp("last_position_check_at", { withTimezone: true }),
  errorCount24h: integer("error_count_24h").notNull().default(0),
  marketRegime: varchar("market_regime", { length: 24 }).notNull().default("UNKNOWN"),
  marketRegimeDetail: jsonb("market_regime_detail"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  lastRecoveryAt: timestamp("last_recovery_at", { withTimezone: true }),
  lastRecoverySummary: jsonb("last_recovery_summary"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const systemEvents = pgTable(
  "system_events",
  {
    id: serial("id").primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    level: varchar("level", { length: 10 }).notNull(),
    component: varchar("component", { length: 32 }).notNull(),
    message: text("message").notNull(),
    mint: varchar("mint", { length: 64 }),
    data: jsonb("data"),
  },
  (t) => [index("events_time_idx").on(t.at), index("events_level_idx").on(t.level)],
);

export const alerts = pgTable("alerts", {
  id: serial("id").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  severity: varchar("severity", { length: 10 }).notNull(), // INFO | WARNING | CRITICAL
  kind: varchar("kind", { length: 32 }).notNull(),
  title: text("title").notNull(),
  body: text("body"),
  mint: varchar("mint", { length: 64 }),
  acknowledged: boolean("acknowledged").notNull().default(false),
});

export const providerHealth = pgTable("provider_health", {
  name: varchar("name", { length: 32 }).primaryKey(),
  status: varchar("status", { length: 16 }).notNull().default("UNKNOWN"), // ONLINE | DEGRADED | OFFLINE | NOT_CONFIGURED
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  requests24h: integer("requests_24h").notNull().default(0),
  avgLatencyMs: integer("avg_latency_ms"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const blacklist = pgTable("blacklist", {
  id: serial("id").primaryKey(),
  kind: varchar("kind", { length: 16 }).notNull(), // TOKEN | DEVELOPER
  address: varchar("address", { length: 64 }).notNull().unique(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const backtestRuns = pgTable("backtest_runs", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  name: text("name").notNull(),
  parameters: jsonb("parameters").notNull(),
  results: jsonb("results").notNull(),
  limitations: jsonb("limitations"),
  sampleSize: integer("sample_size").notNull(),
});
