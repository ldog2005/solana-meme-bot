import { db } from "@/db";
import { providerHealth } from "@/db/schema";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Resilient HTTP layer shared by all providers:
//  - per-provider token-bucket rate limiting
//  - timeouts, retries with exponential backoff + jitter
//  - 429 / Retry-After awareness
//  - in-memory TTL cache and in-flight request de-duplication
//  - provider health tracking (persisted, read by the dashboard)
// ---------------------------------------------------------------------------

export class ProviderError extends Error {
  constructor(message: string, public readonly provider: string, public readonly status?: number, public readonly retryable = true) {
    super(message);
    this.name = "ProviderError";
  }
}

interface Bucket { tokens: number; capacity: number; refillPerMs: number; last: number }
interface HttpGlobal { buckets: Map<string, Bucket>; cache: Map<string, CacheEntry>; inflight: Map<string, Promise<unknown>>; health: Map<string, HealthState> }
const gh = globalThis as typeof globalThis & { __memeBotHttp?: HttpGlobal };
if (!gh.__memeBotHttp) gh.__memeBotHttp = { buckets: new Map(), cache: new Map(), inflight: new Map(), health: new Map() };
const buckets = gh.__memeBotHttp.buckets;

function takeToken(name: string, perMinute: number): number {
  let b = buckets.get(name);
  const now = Date.now();
  if (!b) {
    b = { tokens: perMinute, capacity: perMinute, refillPerMs: perMinute / 60000, last: now };
    buckets.set(name, b);
  }
  b.tokens = Math.min(b.capacity, b.tokens + (now - b.last) * b.refillPerMs);
  b.last = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return 0;
  }
  return Math.ceil((1 - b.tokens) / b.refillPerMs);
}

interface CacheEntry { value: unknown; expires: number }
const cache = gh.__memeBotHttp.cache;
const inflight = gh.__memeBotHttp.inflight;

export interface HealthState {
  status: "ONLINE" | "DEGRADED" | "OFFLINE" | "NOT_CONFIGURED" | "UNKNOWN";
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  requests: number;
  latencies: number[];
}
const health = gh.__memeBotHttp.health;

export function getHealth(name: string): HealthState {
  let h = health.get(name);
  if (!h) {
    h = { status: "UNKNOWN", consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, lastError: null, requests: 0, latencies: [] };
    health.set(name, h);
  }
  return h;
}
export function allHealth() {
  return Object.fromEntries(health.entries());
}

export function markNotConfigured(name: string) {
  const h = getHealth(name);
  h.status = "NOT_CONFIGURED";
  void persistHealth(name);
}

let lastPersist = 0;
async function persistHealth(name: string) {
  const h = getHealth(name);
  // throttle DB writes to at most one per provider per 5s
  const now = Date.now();
  if (now - lastPersist < 5000 && h.status === "ONLINE") return;
  lastPersist = now;
  const avg = h.latencies.length ? Math.round(h.latencies.reduce((a, b) => a + b, 0) / h.latencies.length) : null;
  try {
    await db
      .insert(providerHealth)
      .values({
        name,
        status: h.status,
        lastSuccessAt: h.lastSuccessAt,
        lastFailureAt: h.lastFailureAt,
        lastError: h.lastError,
        consecutiveFailures: h.consecutiveFailures,
        requests24h: h.requests,
        avgLatencyMs: avg,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: providerHealth.name,
        set: {
          status: h.status,
          lastSuccessAt: h.lastSuccessAt,
          lastFailureAt: h.lastFailureAt,
          lastError: h.lastError,
          consecutiveFailures: h.consecutiveFailures,
          requests24h: h.requests,
          avgLatencyMs: avg,
          updatedAt: new Date(),
        },
      });
  } catch {
    /* health persistence is best-effort */
  }
}

function recordSuccess(name: string, latency: number) {
  const h = getHealth(name);
  h.consecutiveFailures = 0;
  h.lastSuccessAt = new Date();
  h.status = "ONLINE";
  h.requests++;
  h.latencies.push(latency);
  if (h.latencies.length > 50) h.latencies.shift();
  void persistHealth(name);
}
function recordFailure(name: string, err: Error) {
  const h = getHealth(name);
  h.consecutiveFailures++;
  h.lastFailureAt = new Date();
  h.lastError = err.message.slice(0, 300);
  h.requests++;
  h.status = h.consecutiveFailures >= 5 ? "OFFLINE" : "DEGRADED";
  void persistHealth(name);
}

export interface FetchOptions {
  provider: string;
  ratePerMinute: number;
  timeoutMs?: number;
  retries?: number;
  cacheTtlMs?: number;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: unknown;
  cacheKey?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** JSON fetch with all resiliency features. Throws ProviderError on failure. */
export async function fetchJson<T>(url: string, opts: FetchOptions): Promise<T> {
  const key = opts.cacheKey ?? `${opts.method ?? "GET"} ${url}`;
  if (opts.cacheTtlMs) {
    const c = cache.get(key);
    if (c && c.expires > Date.now()) return c.value as T;
  }
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const p = (async () => {
    const retries = opts.retries ?? 2;
    let attempt = 0;
    let lastErr: Error = new Error("unknown");
    while (attempt <= retries) {
      const wait = takeToken(opts.provider, opts.ratePerMinute);
      if (wait > 0) await sleep(Math.min(wait, 15000));
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
      try {
        const res = await fetch(url, {
          method: opts.method ?? "GET",
          headers: { accept: "application/json", ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: ctrl.signal,
          cache: "no-store",
        });
        clearTimeout(timer);
        if (res.status === 429) {
          const ra = Number(res.headers.get("retry-after"));
          const backoff = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt + Math.random() * 500;
          lastErr = new ProviderError(`rate limited (429)`, opts.provider, 429);
          recordFailure(opts.provider, lastErr);
          await sleep(Math.min(backoff, 20000));
          attempt++;
          continue;
        }
        if (!res.ok) {
          const retryable = res.status >= 500;
          const text = (await res.text().catch(() => "")).slice(0, 200);
          lastErr = new ProviderError(`HTTP ${res.status} ${text}`, opts.provider, res.status, retryable);
          recordFailure(opts.provider, lastErr);
          if (!retryable) throw lastErr;
        } else {
          const json = (await res.json()) as T;
          recordSuccess(opts.provider, Date.now() - started);
          if (opts.cacheTtlMs) cache.set(key, { value: json, expires: Date.now() + opts.cacheTtlMs });
          return json;
        }
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof ProviderError && !e.retryable) throw e;
        const err = e as Error;
        lastErr = new ProviderError(err.name === "AbortError" ? "timeout" : err.message, opts.provider);
        recordFailure(opts.provider, lastErr);
      }
      attempt++;
      if (attempt <= retries) await sleep(500 * 2 ** attempt + Math.random() * 300);
    }
    throw lastErr;
  })();

  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

/** Test helper / manual reset. */
export function clearCache() {
  cache.clear();
  inflight.clear();
}

/** Periodic cache eviction to bound memory. */
export function evictCache() {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expires < now) cache.delete(k);
}

/** Used by chaos tests / status page. */
export async function loadPersistedHealth() {
  return db.select().from(providerHealth).orderBy(sql`name`);
}
