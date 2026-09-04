// ---------------------------------------------------------------------------
// Central configuration. Every setting has a description, default, min, max.
// Settings persist to the `settings` table; defaults below apply otherwise.
//
// Settings in the "HARD_RISK" group are enforced by deterministic code and can
// only be modified through the authenticated settings endpoint — never by an
// LLM, the strategy engine, or any automatic process.
// ---------------------------------------------------------------------------

export type SettingGroup = "HARD_RISK" | "ENTRY" | "EXIT" | "SCANNER" | "PAPER" | "GENERAL";

export interface SettingDef {
  key: string;
  group: SettingGroup;
  label: string;
  description: string;
  default: number | boolean | string;
  min?: number;
  max?: number;
  unit?: string;
  type: "number" | "boolean" | "string";
}

export const SETTING_DEFS: SettingDef[] = [
  // ---------------- HARD RISK LIMITS (deterministic, non-overridable) -----
  { key: "MAX_TRADE_SIZE_SOL", group: "HARD_RISK", label: "Max trade size", unit: "SOL", type: "number", default: 0.25, min: 0.01, max: 50,
    description: "Absolute cap on SOL committed to any single entry. Position sizing can only go below this, never above." },
  { key: "MAX_PORTFOLIO_EXPOSURE_PCT", group: "HARD_RISK", label: "Max portfolio exposure", unit: "%", type: "number", default: 40, min: 1, max: 100,
    description: "Maximum share of total equity that may be held in open token positions at once." },
  { key: "MAX_OPEN_POSITIONS", group: "HARD_RISK", label: "Max open positions", type: "number", default: 4, min: 1, max: 25,
    description: "Maximum number of simultaneously open positions." },
  { key: "MAX_POSITION_PCT", group: "HARD_RISK", label: "Max single position", unit: "% of equity", type: "number", default: 10, min: 0.5, max: 50,
    description: "Maximum percentage of equity in one token." },
  { key: "MAX_DAILY_LOSS_PCT", group: "HARD_RISK", label: "Max daily loss", unit: "% of equity", type: "number", default: 5, min: 0.5, max: 50,
    description: "When realized + unrealized losses today reach this level, new entries are disabled until the next UTC day." },
  { key: "MAX_WEEKLY_LOSS_PCT", group: "HARD_RISK", label: "Max weekly loss", unit: "% of equity", type: "number", default: 12, min: 1, max: 80,
    description: "Rolling 7-day loss lockout for new entries." },
  { key: "MAX_ACCEPTABLE_SLIPPAGE_PCT", group: "HARD_RISK", label: "Max slippage", unit: "%", type: "number", default: 3, min: 0.1, max: 25,
    description: "Orders whose expected slippage exceeds this are refused. Slippage tolerance is never raised automatically to force a fill." },
  { key: "MAX_PRICE_IMPACT_PCT", group: "HARD_RISK", label: "Max price impact", unit: "%", type: "number", default: 2, min: 0.1, max: 25,
    description: "Maximum acceptable price impact of our own order on the pool." },
  { key: "MAX_HOLD_TIME_MIN", group: "HARD_RISK", label: "Max hold time", unit: "minutes", type: "number", default: 240, min: 5, max: 10080,
    description: "Positions older than this are closed regardless of P&L." },
  { key: "MAX_TRADE_LIQUIDITY_PCT", group: "HARD_RISK", label: "Max trade vs liquidity", unit: "%", type: "number", default: 1, min: 0.05, max: 10,
    description: "Trade size may not exceed this fraction of pool liquidity (controls our own price impact)." },

  // ---------------- ENTRY / STRATEGY ---------------------------------------
  { key: "MIN_LIQUIDITY_USD", group: "ENTRY", label: "Min liquidity", unit: "USD", type: "number", default: 25000, min: 1000, max: 5_000_000,
    description: "Minimum pool liquidity. Thin pools make exits expensive and are easier to manipulate." },
  { key: "MIN_VOLUME_1H_USD", group: "ENTRY", label: "Min 1h volume", unit: "USD", type: "number", default: 15000, min: 100, max: 50_000_000,
    description: "Minimum trailing one-hour traded volume." },
  { key: "MIN_TXNS_1H", group: "ENTRY", label: "Min 1h transactions", type: "number", default: 150, min: 1, max: 100000,
    description: "Minimum number of trades in the last hour (evidence of activity)." },
  { key: "MIN_SCORE", group: "ENTRY", label: "Min overall score", type: "number", default: 70, min: 0, max: 100,
    description: "Minimum 0-100 opportunity score required for an entry." },
  { key: "MIN_TOKEN_AGE_MIN", group: "ENTRY", label: "Min token age", unit: "minutes", type: "number", default: 20, min: 0, max: 100000,
    description: "Ignore tokens younger than this. The first minutes after launch are dominated by snipers and bundles." },
  { key: "MAX_TOKEN_AGE_MIN", group: "ENTRY", label: "Max token age", unit: "minutes", type: "number", default: 4320, min: 5, max: 1_000_000,
    description: "Ignore tokens older than this (default 3 days) so the strategy focuses on fresh markets." },
  { key: "MAX_TOP10_HOLDER_PCT", group: "ENTRY", label: "Max top-10 holders", unit: "%", type: "number", default: 35, min: 5, max: 100,
    description: "Reject if the ten largest non-pool wallets hold more than this share of supply." },
  { key: "MAX_SINGLE_HOLDER_PCT", group: "ENTRY", label: "Max single holder", unit: "%", type: "number", default: 10, min: 1, max: 100,
    description: "Reject if any single non-pool wallet holds more than this share." },
  { key: "MAX_CREATOR_PCT", group: "ENTRY", label: "Max creator holdings", unit: "%", type: "number", default: 5, min: 0, max: 100,
    description: "Reject if the deployer still holds more than this share." },
  { key: "MIN_LP_LOCKED_PCT", group: "ENTRY", label: "Min LP locked/burned", unit: "%", type: "number", default: 80, min: 0, max: 100,
    description: "Minimum share of liquidity that is locked or burned. Unlocked LP can be pulled at any moment." },
  { key: "MAX_PRICE_CHANGE_1H_PCT", group: "ENTRY", label: "Max 1h price change (overextension)", unit: "%", type: "number", default: 120, min: 5, max: 10000,
    description: "Tokens that have risen more than this in an hour are classified OVEREXTENDED and not bought." },
  { key: "MIN_BUY_SELL_RATIO", group: "ENTRY", label: "Min buy/sell ratio (1h)", type: "number", default: 1.05, min: 0.1, max: 10,
    description: "Buy pressure requirement." },
  { key: "TOKEN_COOLDOWN_MIN", group: "ENTRY", label: "Re-entry cooldown", unit: "minutes", type: "number", default: 180, min: 0, max: 100000,
    description: "After a position closes, the same token cannot be re-entered for this long." },
  { key: "MAX_DATA_AGE_SEC", group: "ENTRY", label: "Max data age", unit: "seconds", type: "number", default: 90, min: 5, max: 3600,
    description: "Market data older than this is stale and blocks entries." },

  // ---------------- EXIT ---------------------------------------------------
  { key: "STOP_LOSS_PCT", group: "EXIT", label: "Hard stop loss", unit: "%", type: "number", default: 20, min: 1, max: 90,
    description: "Close the whole position when price falls this far below entry." },
  { key: "TP1_PCT", group: "EXIT", label: "Take-profit 1 trigger", unit: "%", type: "number", default: 30, min: 1, max: 10000, description: "First partial profit trigger." },
  { key: "TP1_SELL_PCT", group: "EXIT", label: "Take-profit 1 sell", unit: "% of position", type: "number", default: 25, min: 0, max: 100, description: "Fraction of the original position sold at TP1." },
  { key: "TP2_PCT", group: "EXIT", label: "Take-profit 2 trigger", unit: "%", type: "number", default: 60, min: 1, max: 10000, description: "Second partial profit trigger." },
  { key: "TP2_SELL_PCT", group: "EXIT", label: "Take-profit 2 sell", unit: "% of position", type: "number", default: 25, min: 0, max: 100, description: "Fraction sold at TP2." },
  { key: "TP3_PCT", group: "EXIT", label: "Take-profit 3 trigger", unit: "%", type: "number", default: 100, min: 1, max: 10000, description: "Third partial profit trigger." },
  { key: "TP3_SELL_PCT", group: "EXIT", label: "Take-profit 3 sell", unit: "% of position", type: "number", default: 25, min: 0, max: 100, description: "Fraction sold at TP3." },
  { key: "TRAILING_STOP_PCT", group: "EXIT", label: "Trailing stop", unit: "%", type: "number", default: 20, min: 1, max: 90,
    description: "Once armed, the position closes if price falls this far from its peak." },
  { key: "TRAILING_ARM_PCT", group: "EXIT", label: "Trailing stop arms at", unit: "% gain", type: "number", default: 20, min: 0, max: 10000,
    description: "Trailing stop activates once unrealized gain reaches this level." },
  { key: "LIQUIDITY_DROP_EXIT_PCT", group: "EXIT", label: "Liquidity drop exit", unit: "%", type: "number", default: 40, min: 5, max: 95,
    description: "Emergency exit if pool liquidity falls this much versus entry." },
  { key: "MOMENTUM_EXIT_SELL_RATIO", group: "EXIT", label: "Momentum exit sell ratio", type: "number", default: 1.8, min: 1, max: 20,
    description: "Exit when 5-minute sells exceed buys by this ratio while the position is in profit." },
  { key: "EMERGENCY_PRICE_DROP_5M_PCT", group: "EXIT", label: "Emergency 5m price collapse", unit: "%", type: "number", default: 35, min: 5, max: 95,
    description: "A 5-minute drop of this size triggers an emergency exit." },

  // ---------------- SCANNER ------------------------------------------------
  { key: "SCAN_INTERVAL_SEC", group: "SCANNER", label: "Scan interval", unit: "seconds", type: "number", default: 60, min: 20, max: 3600,
    description: "How often the discovery scan runs. Lower values consume more API quota." },
  { key: "POSITION_CHECK_INTERVAL_SEC", group: "SCANNER", label: "Position check interval", unit: "seconds", type: "number", default: 20, min: 5, max: 600,
    description: "How often open positions are re-priced and exit rules evaluated." },
  { key: "MAX_CANDIDATES_PER_SCAN", group: "SCANNER", label: "Max candidates per scan", type: "number", default: 60, min: 5, max: 300,
    description: "Upper bound on tokens enriched per scan (rate-limit protection)." },
  { key: "MAX_DEEP_CHECKS_PER_SCAN", group: "SCANNER", label: "Max deep safety checks per scan", type: "number", default: 12, min: 1, max: 100,
    description: "Tokens that pass pre-filters and receive full RugCheck + RPC verification per scan." },

  // ---------------- PAPER --------------------------------------------------
  { key: "PAPER_STARTING_SOL", group: "PAPER", label: "Paper starting balance", unit: "SOL", type: "number", default: 10, min: 0.1, max: 10000,
    description: "Simulated starting balance (applied on reset)." },
  { key: "PAPER_FEE_SOL", group: "PAPER", label: "Simulated network + priority fee", unit: "SOL", type: "number", default: 0.0015, min: 0, max: 1,
    description: "Fixed per-transaction fee charged in simulation." },
  { key: "PAPER_FAIL_RATE_PCT", group: "PAPER", label: "Simulated tx failure rate", unit: "%", type: "number", default: 4, min: 0, max: 50,
    description: "Probability a simulated transaction fails (congestion, slippage exceeded)." },
  { key: "PAPER_LATENCY_MS", group: "PAPER", label: "Simulated execution latency", unit: "ms", type: "number", default: 1500, min: 0, max: 30000,
    description: "Average simulated delay between decision and fill; price drift is applied over this window." },

  // ---------------- GENERAL ------------------------------------------------
  { key: "STRATEGY_VERSION", group: "GENERAL", label: "Strategy version", type: "string", default: "strategy_v0.1",
    description: "Auto-incremented whenever strategy parameters change. Every decision and trade records it." },
  { key: "AUTO_TRADE_ENABLED", group: "GENERAL", label: "Automated paper entries", type: "boolean", default: true,
    description: "When off, the bot scans and journals decisions but does not open paper positions." },
];

export type SettingsMap = Record<string, number | boolean | string>;

export function defaultSettings(): SettingsMap {
  const out: SettingsMap = {};
  for (const d of SETTING_DEFS) out[d.key] = d.default;
  return out;
}

export function validateSetting(key: string, value: unknown): { ok: true; value: number | boolean | string } | { ok: false; error: string } {
  const def = SETTING_DEFS.find((d) => d.key === key);
  if (!def) return { ok: false, error: `Unknown setting ${key}` };
  if (def.type === "number") {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: `${key} must be a number` };
    if (def.min !== undefined && n < def.min) return { ok: false, error: `${key} must be >= ${def.min}` };
    if (def.max !== undefined && n > def.max) return { ok: false, error: `${key} must be <= ${def.max}` };
    return { ok: true, value: n };
  }
  if (def.type === "boolean") {
    if (typeof value === "boolean") return { ok: true, value };
    if (value === "true" || value === "false") return { ok: true, value: value === "true" };
    return { ok: false, error: `${key} must be boolean` };
  }
  if (typeof value !== "string" || value.length > 64) return { ok: false, error: `${key} must be a short string` };
  return { ok: true, value };
}

/** Keys that define a strategy version (a change bumps STRATEGY_VERSION). */
export const STRATEGY_KEYS = SETTING_DEFS.filter((d) => d.group === "ENTRY" || d.group === "EXIT").map((d) => d.key);

export function num(s: SettingsMap, key: string): number {
  const v = s[key];
  if (typeof v === "number") return v;
  const def = SETTING_DEFS.find((d) => d.key === key);
  return typeof def?.default === "number" ? def.default : 0;
}
export function bool(s: SettingsMap, key: string): boolean {
  const v = s[key];
  if (typeof v === "boolean") return v;
  const def = SETTING_DEFS.find((d) => d.key === key);
  return typeof def?.default === "boolean" ? def.default : false;
}
export function str(s: SettingsMap, key: string): string {
  const v = s[key];
  if (typeof v === "string") return v;
  const def = SETTING_DEFS.find((d) => d.key === key);
  return typeof def?.default === "string" ? def.default : "";
}
