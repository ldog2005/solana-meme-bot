import type { AuthorityStatus, Candidate, RiskLevel, SafetyAssessment, SafetyFlag } from "../core/types";
import { num, type SettingsMap } from "../config/settings";

// ---------------------------------------------------------------------------
// TokenSafetyEngine — deterministic, pure. Runs BEFORE any scoring.
//
// Philosophy: we never call a token "safe". We classify risk and treat
// UNKNOWN conservatively. Any CRITICAL flag, or missing critical data, fails
// the mandatory gate. No later component (scoring, strategy, LLM) can undo it.
// ---------------------------------------------------------------------------

const KNOWN_POOL_PROGRAMS = new Set<string>([
  // Common AMM/program-owned vault authorities show up as top holders; RugCheck
  // marks pool accounts as insider=false with owner = AMM. We cannot enumerate
  // every pool, so instead we discount the single largest holder when it is
  // consistent with pool liquidity (see isLikelyPool).
]);

function mergeAuthority(a: AuthorityStatus, b: AuthorityStatus): { status: AuthorityStatus; conflict: boolean } {
  if (a === "UNKNOWN") return { status: b, conflict: false };
  if (b === "UNKNOWN") return { status: a, conflict: false };
  if (a !== b) return { status: "ACTIVE", conflict: true }; // disagree → assume the worse case
  return { status: a, conflict: false };
}

/** Heuristic: the largest holder is probably the liquidity pool if its USD value ≈ pool liquidity. */
function isLikelyPool(pct: number, marketCap: number | null, liquidityUsd: number | null): boolean {
  if (!marketCap || !liquidityUsd || marketCap <= 0) return false;
  const holderUsd = (pct / 100) * marketCap;
  // one side of the pool ≈ liquidity/2; allow generous tolerance
  return holderUsd > liquidityUsd * 0.25 && holderUsd < liquidityUsd * 1.2;
}

export function assessSafety(c: Candidate, s: SettingsMap): SafetyAssessment {
  const flags: SafetyFlag[] = [];
  const providersUsed: string[] = [];
  const add = (code: string, severity: SafetyFlag["severity"], message: string) => flags.push({ code, severity, message });

  const rc = c.risk;
  const oc = c.onChain;
  if (rc) providersUsed.push(rc.source);
  if (oc) providersUsed.push(oc.source);

  // ---- Authorities (cross-checked between providers) ----------------------
  const mintA = mergeAuthority(oc?.mintAuthority ?? "UNKNOWN", rc?.mintAuthority ?? "UNKNOWN");
  const freezeA = mergeAuthority(oc?.freezeAuthority ?? "UNKNOWN", rc?.freezeAuthority ?? "UNKNOWN");
  if (mintA.conflict) add("AUTHORITY_CONFLICT", "HIGH", "Providers disagree about mint authority; assuming it is still active.");
  if (freezeA.conflict) add("AUTHORITY_CONFLICT", "HIGH", "Providers disagree about freeze authority; assuming it is still active.");
  if (mintA.status === "ACTIVE") add("MINT_AUTHORITY_ACTIVE", "CRITICAL", "Mint authority not revoked: the deployer can print unlimited new tokens.");
  if (freezeA.status === "ACTIVE") add("FREEZE_AUTHORITY_ACTIVE", "CRITICAL", "Freeze authority not revoked: the deployer can freeze your tokens (honeypot risk).");
  if (mintA.status === "UNKNOWN") add("MINT_AUTHORITY_UNKNOWN", "HIGH", "Could not verify mint authority.");
  if (freezeA.status === "UNKNOWN") add("FREEZE_AUTHORITY_UNKNOWN", "HIGH", "Could not verify freeze authority.");

  // ---- Token program / transfer fees ---------------------------------------
  if (oc?.tokenProgram === "token-2022") add("TOKEN_2022", "MEDIUM", "Token-2022 program: extensions (transfer fees, hooks) may restrict selling.");
  if (rc?.transferFeePct && rc.transferFeePct > 0) {
    add("TRANSFER_FEE", rc.transferFeePct > 5 ? "CRITICAL" : "HIGH", `Transfer fee of ${rc.transferFeePct.toFixed(1)}% on every trade.`);
  }
  if (rc?.rugged) add("RUGGED", "CRITICAL", "Risk provider reports this token as already rugged.");
  if (rc?.mutableMetadata) add("MUTABLE_METADATA", "LOW", "Metadata is mutable (name/image can change).");

  // ---- Provider-reported risks ---------------------------------------------
  for (const r of rc?.risks ?? []) {
    const name = r.name.toLowerCase();
    if (r.level === "danger") {
      // Treat every provider 'danger' as at least HIGH; some are CRITICAL.
      const critical = /freeze|mint authority|honeypot|rug|copycat|transfer fee|permanent delegate|non-transferable/.test(name);
      add(`RC_${r.name.replace(/\W+/g, "_").toUpperCase()}`, critical ? "CRITICAL" : "HIGH", `${r.name}: ${r.description}${r.value ? ` (${r.value})` : ""}`);
    } else if (r.level === "warn") {
      add(`RC_${r.name.replace(/\W+/g, "_").toUpperCase()}`, /low liquidity|large amount of lp unlocked|creator|insider|single holder/.test(name) ? "MEDIUM" : "LOW", `${r.name}: ${r.description}${r.value ? ` (${r.value})` : ""}`);
    }
  }

  // ---- Liquidity lock -------------------------------------------------------
  const lp = rc?.lpLockedPct ?? null;
  const minLp = num(s, "MIN_LP_LOCKED_PCT");
  if (lp === null) add("LP_LOCK_UNKNOWN", "HIGH", "Liquidity lock status could not be determined.");
  else if (lp < minLp) add("LP_UNLOCKED", lp < minLp / 2 ? "CRITICAL" : "HIGH", `Only ${lp.toFixed(0)}% of liquidity is locked/burned (minimum ${minLp}%). Unlocked LP can be pulled at any time.`);

  // ---- Holder concentration -------------------------------------------------
  const liquidityUsd = c.market.liquidityUsd;
  const marketCap = c.market.marketCap ?? c.market.fdv;
  let topHolderPct: number | null = null;
  let top10Pct: number | null = null;
  const holders = rc?.topHolders ?? (oc?.largestHolders ? oc.largestHolders.map((h) => ({ address: h.address, pct: h.pct, insider: false })) : null);
  if (holders && holders.length) {
    const sorted = [...holders].sort((a, b) => b.pct - a.pct);
    // Discount the largest holder when it looks like the pool vault.
    const filtered = sorted.filter((h, i) => !(i === 0 && (isLikelyPool(h.pct, marketCap, liquidityUsd) || KNOWN_POOL_PROGRAMS.has(h.address))));
    topHolderPct = filtered[0]?.pct ?? 0;
    top10Pct = filtered.slice(0, 10).reduce((a, h) => a + h.pct, 0);
    const insiders = filtered.filter((h) => h.insider).reduce((a, h) => a + h.pct, 0);
    if (topHolderPct > num(s, "MAX_SINGLE_HOLDER_PCT")) add("TOP_HOLDER_CONCENTRATION", topHolderPct > 25 ? "CRITICAL" : "HIGH", `Largest non-pool wallet holds ${topHolderPct.toFixed(1)}% of supply.`);
    if (top10Pct > num(s, "MAX_TOP10_HOLDER_PCT")) add("TOP10_CONCENTRATION", top10Pct > 60 ? "CRITICAL" : "HIGH", `Top-10 wallets hold ${top10Pct.toFixed(1)}% of supply.`);
    if (insiders > 10) add("INSIDER_CLUSTER", insiders > 25 ? "CRITICAL" : "HIGH", `Wallets flagged as insiders/connected hold ${insiders.toFixed(1)}%.`);
  } else {
    add("HOLDERS_UNKNOWN", "HIGH", "Holder distribution unavailable.");
  }

  // ---- Developer / creator ------------------------------------------------
  const creatorPct = rc?.creatorPct ?? null;
  if (creatorPct !== null && creatorPct > num(s, "MAX_CREATOR_PCT")) add("CREATOR_HOLDINGS", creatorPct > 20 ? "CRITICAL" : "HIGH", `Deployer still holds ${creatorPct.toFixed(1)}% of supply.`);

  // ---- Liquidity level & market sanity -------------------------------------
  if (liquidityUsd === null) add("LIQUIDITY_UNKNOWN", "CRITICAL", "Liquidity unknown — cannot assess exit feasibility.");
  else if (liquidityUsd < num(s, "MIN_LIQUIDITY_USD")) add("LOW_LIQUIDITY", liquidityUsd < num(s, "MIN_LIQUIDITY_USD") / 3 ? "CRITICAL" : "HIGH", `Liquidity $${Math.round(liquidityUsd).toLocaleString()} below minimum $${num(s, "MIN_LIQUIDITY_USD").toLocaleString()}.`);
  if (liquidityUsd && marketCap && marketCap > 0 && liquidityUsd / marketCap < 0.02) add("THIN_LIQUIDITY_VS_MCAP", "HIGH", `Liquidity is only ${((liquidityUsd / marketCap) * 100).toFixed(1)}% of market cap.`);
  if (liquidityUsd && marketCap && liquidityUsd > marketCap * 3) add("LIQUIDITY_MCAP_ANOMALY", "MEDIUM", "Liquidity far exceeds market cap — data anomaly or manipulated pool.");

  // ---- Sellability evidence -------------------------------------------------
  const h1 = c.market.txns.h1;
  const h24 = c.market.txns.h24;
  if (h24.sells === 0 && h24.buys > 30) add("NO_SELLS", "CRITICAL", "Many buys but zero sells in 24h — honeypot-like behaviour.");
  else if (h1.buys > 40 && h1.sells / Math.max(h1.buys, 1) < 0.08) add("FEW_SELLS", "HIGH", "Almost no sells relative to buys in the last hour.");

  // ---- Anti-manipulation heuristics ----------------------------------------
  const v1h = c.market.volume.h1 ?? 0;
  const tx1h = h1.buys + h1.sells;
  if (tx1h > 0 && liquidityUsd && v1h / liquidityUsd > 25) add("VOLUME_LIQUIDITY_ANOMALY", "HIGH", `1h volume is ${(v1h / liquidityUsd).toFixed(0)}× liquidity — possible wash trading.`);
  if (tx1h > 200 && v1h / tx1h < 5) add("DUST_TRADES", "MEDIUM", "Very high trade count with tiny average size — bot/wash activity likely.");
  if (rc?.totalHolders !== null && rc?.totalHolders !== undefined && rc.totalHolders < 100) add("FEW_HOLDERS", rc.totalHolders < 30 ? "HIGH" : "MEDIUM", `Only ${rc.totalHolders} holders.`);

  // ---- Data completeness -----------------------------------------------------
  const dataComplete = Boolean(rc) && (Boolean(oc) || rc!.mintAuthority !== "UNKNOWN") && lp !== null && holders !== null && liquidityUsd !== null;
  if (!rc) add("RISK_PROVIDER_UNAVAILABLE", "HIGH", "Risk analysis provider returned no data.");

  // ---- Aggregate -------------------------------------------------------------
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const f of flags) counts[f.severity]++;

  let riskLevel: RiskLevel;
  if (counts.CRITICAL > 0) riskLevel = "CRITICAL";
  else if (!dataComplete) riskLevel = "UNKNOWN";
  else if (counts.HIGH >= 2) riskLevel = "HIGH";
  else if (counts.HIGH === 1 || counts.MEDIUM >= 2) riskLevel = "MODERATE";
  else riskLevel = "LOW";

  // Safety score 0-30: start at 30, subtract per flag, floor 0. CRITICAL → 0.
  let score = 30;
  score -= counts.HIGH * 7 + counts.MEDIUM * 3 + counts.LOW * 1;
  if (rc?.providerScoreNormalised !== null && rc?.providerScoreNormalised !== undefined) {
    // RugCheck normalised score is 0-100, higher = riskier. Blend lightly.
    score -= Math.min(8, rc.providerScoreNormalised / 12);
  }
  if (counts.CRITICAL > 0) score = 0;
  score = Math.max(0, Math.min(30, Math.round(score * 10) / 10));

  const passed = counts.CRITICAL === 0 && dataComplete && riskLevel !== "HIGH" && riskLevel !== "UNKNOWN";

  return {
    riskLevel,
    safetyScore: score,
    passed,
    flags,
    mintAuthority: mintA.status,
    freezeAuthority: freezeA.status,
    lpLockedPct: lp,
    topHolderPct,
    top10Pct,
    creatorPct,
    dataComplete,
    providersUsed,
  };
}
