import { createPrivateKey, sign as edSign } from "node:crypto";
import type { ExecutionProvider, ExecutionRequest, ExecutionResult } from "../core/types";
import { LAMPORTS_PER_SOL, SOL_MINT } from "../core/types";
import { providers } from "../providers";
import { num, type SettingsMap } from "../config/settings";
import { logger, raiseAlert } from "../core/logger";

// ---------------------------------------------------------------------------
// JupiterExecutionProvider — LIVE execution. FAIL-CLOSED BY DESIGN.
//
// Every call re-validates ALL of the following independently of the caller:
//   1. LIVE_TRADING_ENABLED env var === "true"      (deployment-level switch)
//   2. bot_state.liveTradingEnabled === true         (dashboard-level switch,
//      set only by the authenticated /api/live/enable endpoint with a typed
//      confirmation phrase)
//   3. liveArmed flag passed by the orchestrator      (runtime confirmation)
//   4. JUPITER_API_KEY configured and provider healthy
//   5. TRADING_WALLET_SECRET present (base58 64-byte keypair or 32-byte seed,
//      read from env only, never logged, never returned)
//   6. Slippage / price-impact from the REAL router quote within hard limits
// If anything is missing → status FAILED with reason. No exceptions.
//
// STATUS: implemented and unit-tested for the gating logic; the signing +
// broadcast path has NOT been exercised with real funds in this build. See
// docs/LIVE_TRADING.md before ever enabling.
// ---------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(str: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of str) {
    let carry = B58.indexOf(ch);
    if (carry < 0) throw new Error("invalid base58");
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let k = 0; k < str.length && str[k] === "1"; k++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}
function b58encode(buf: Uint8Array): string {
  const digits = [0];
  for (const byte of buf) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let k = 0; k < buf.length && buf[k] === 0; k++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

/** Derive the public key (base58) from a secret without exposing the secret. */
function loadWallet(): { publicKey: string; sign: (msg: Uint8Array) => Uint8Array } | null {
  const secret = process.env.TRADING_WALLET_SECRET;
  if (!secret) return null;
  let raw: Uint8Array;
  try {
    raw = secret.trim().startsWith("[") ? Uint8Array.from(JSON.parse(secret) as number[]) : b58decode(secret.trim());
  } catch {
    return null;
  }
  if (raw.length !== 64 && raw.length !== 32) return null;
  const seed = raw.slice(0, 32);
  const pub = raw.length === 64 ? raw.slice(32) : null;
  // PKCS8 DER prefix for Ed25519 private keys.
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]);
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const derivedPub = key.export({ format: "der", type: "spki" }) as Buffer;
  const pubBytes = pub ?? Uint8Array.from(derivedPub.subarray(derivedPub.length - 32));
  return { publicKey: b58encode(pubBytes), sign: (msg) => Uint8Array.from(edSign(null, Buffer.from(msg), key)) };
}

export function liveWalletPublicKey(): string | null {
  try {
    return loadWallet()?.publicKey ?? null;
  } catch {
    return null;
  }
}

/** Sign a base64 VersionedTransaction produced by Jupiter (single fee-payer signature). */
function signVersionedTx(base64Tx: string, signer: (msg: Uint8Array) => Uint8Array): string {
  const tx = Buffer.from(base64Tx, "base64");
  // compact-u16 signature count
  let numSigs = 0, shift = 0, offset = 0;
  for (;;) {
    const b = tx[offset++];
    numSigs |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  if (numSigs < 1) throw new Error("transaction has no signature slots");
  const sigStart = offset;
  const msgStart = sigStart + numSigs * 64;
  const message = tx.subarray(msgStart);
  const sig = signer(message);
  sig.forEach((v, i) => (tx[sigStart + i] = v));
  return tx.toString("base64");
}

export class JupiterExecutionProvider implements ExecutionProvider {
  readonly name = "jupiter-live";
  readonly mode = "LIVE" as const;
  constructor(private settings: SettingsMap, private gates: { dbLiveEnabled: boolean; liveArmed: boolean }) {}

  isConfigured() {
    return process.env.LIVE_TRADING_ENABLED === "true" && providers().quotes.isConfigured() && Boolean(process.env.TRADING_WALLET_SECRET);
  }

  private fail(req: ExecutionRequest, reason: string, latency = 0): ExecutionResult {
    void logger.warn("live-exec", `LIVE order refused: ${reason}`, { side: req.side, key: req.idempotencyKey }, req.mint);
    return { status: "FAILED", executedPriceSol: req.expectedPriceSol, tokenAmount: 0, solAmount: 0, slippagePct: 0, priceImpactPct: 0, feeSol: 0, latencyMs: latency, reason, mode: "LIVE" };
  }

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    const started = Date.now();
    // ---- Gates (all independent; any failure → refuse) ---------------------
    if (process.env.LIVE_TRADING_ENABLED !== "true") return this.fail(req, "LIVE_TRADING_ENABLED env var is not 'true'");
    if (!this.gates.dbLiveEnabled) return this.fail(req, "Live trading not enabled in bot state (dashboard confirmation missing)");
    if (!this.gates.liveArmed) return this.fail(req, "Runtime live-arm flag not set");
    const jup = providers().quotes;
    if (!jup.isConfigured()) return this.fail(req, "JUPITER_API_KEY not configured");
    const wallet = (() => { try { return loadWallet(); } catch { return null; } })();
    if (!wallet) return this.fail(req, "TRADING_WALLET_SECRET missing or invalid");
    const maxSlipBps = Math.round(Math.min(req.maxSlippagePct, num(this.settings, "MAX_ACCEPTABLE_SLIPPAGE_PCT")) * 100);

    // ---- Quote --------------------------------------------------------------
    const inputMint = req.side === "BUY" ? SOL_MINT : req.mint;
    const outputMint = req.side === "BUY" ? req.mint : SOL_MINT;
    let amountBase: number;
    if (req.side === "BUY") amountBase = Math.floor(req.amount * LAMPORTS_PER_SOL);
    else {
      const oc = await providers().onchain.getOnChainInfo(req.mint);
      if (!oc || oc.decimals === null) return this.fail(req, "Could not determine token decimals for sell");
      amountBase = Math.floor(req.amount * 10 ** oc.decimals);
    }
    const quote = await jup.rawQuote({ inputMint, outputMint, amountBaseUnits: amountBase, slippageBps: maxSlipBps });
    if (!quote) return this.fail(req, "No route / quote unavailable", Date.now() - started);
    const impactPct = Math.abs(Number(quote.priceImpactPct)) * 100;
    if (impactPct > req.maxPriceImpactPct) return this.fail(req, `Router price impact ${impactPct.toFixed(2)}% exceeds max ${req.maxPriceImpactPct}%`, Date.now() - started);

    // ---- Build + sign + send -------------------------------------------------
    const built = await jup.buildSwapTransaction(quote, wallet.publicKey);
    if (!built?.swapTransaction) return this.fail(req, "Swap transaction build failed", Date.now() - started);
    let signed: string;
    try {
      signed = signVersionedTx(built.swapTransaction, wallet.sign);
    } catch (e) {
      return this.fail(req, `Signing failed: ${(e as Error).message}`, Date.now() - started);
    }
    let sig: string;
    try {
      sig = await providers().onchain.sendRawTransaction(signed);
    } catch (e) {
      return this.fail(req, `Broadcast failed: ${(e as Error).message}`, Date.now() - started);
    }
    // ---- Confirm (timeout 45s) ------------------------------------------------
    const deadline = Date.now() + 45_000;
    let status: "confirmed" | "finalized" | "failed" | "pending" = "pending";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try { status = await providers().onchain.getSignatureStatus(sig); } catch { /* keep polling */ }
      if (status !== "pending") break;
    }
    if (status === "failed") return { ...this.fail(req, `Transaction ${sig} failed on-chain`, Date.now() - started), txSignature: sig };
    if (status === "pending") {
      await raiseAlert("CRITICAL", "EXECUTION_UNCONFIRMED", `Live tx ${sig} unconfirmed after 45s`, "Reconcile wallet before next action.", req.mint);
      return { ...this.fail(req, `Transaction ${sig} unconfirmed after timeout — reconciliation required`, Date.now() - started), txSignature: sig };
    }
    const inAmt = Number(quote.inAmount), outAmt = Number(quote.outAmount);
    // Executed price in SOL per token (approximate: uses quoted amounts; reconciliation refines from balances).
    let executedPrice = req.expectedPriceSol, tokenAmount = 0, solAmount = 0;
    if (req.side === "BUY") {
      solAmount = inAmt / LAMPORTS_PER_SOL;
      const oc = await providers().onchain.getOnChainInfo(req.mint);
      tokenAmount = outAmt / 10 ** (oc?.decimals ?? 6);
      executedPrice = tokenAmount > 0 ? solAmount / tokenAmount : req.expectedPriceSol;
    } else {
      tokenAmount = req.amount;
      solAmount = outAmt / LAMPORTS_PER_SOL;
      executedPrice = tokenAmount > 0 ? solAmount / tokenAmount : req.expectedPriceSol;
    }
    const slippage = Math.abs((executedPrice - req.expectedPriceSol) / req.expectedPriceSol) * 100;
    await logger.info("live-exec", `LIVE ${req.side} confirmed ${sig}`, { solAmount, tokenAmount, slippage }, req.mint);
    return { status: "FILLED", executedPriceSol: executedPrice, tokenAmount, solAmount, slippagePct: slippage, priceImpactPct: impactPct, feeSol: 0.0005, latencyMs: Date.now() - started, txSignature: sig, mode: "LIVE" };
  }
}
