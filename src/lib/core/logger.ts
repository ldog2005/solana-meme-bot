import { db } from "@/db";
import { systemEvents, alerts } from "@/db/schema";

export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";
const ORDER: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3, CRITICAL: 4 };
const MIN_PERSIST: LogLevel = "INFO";
const MIN_CONSOLE: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "INFO";

function safeJson(data: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  } catch {
    return { unserializable: true };
  }
}

/** Structured logger. Persists INFO+ to the database; never throws. */
export async function log(level: LogLevel, component: string, message: string, data?: Record<string, unknown>, mint?: string) {
  const ts = new Date().toISOString();
  if (ORDER[level] >= ORDER[MIN_CONSOLE]) {
    const line = `[${ts}] ${level.padEnd(8)} ${component.padEnd(12)} ${message}${mint ? ` (${mint.slice(0, 8)}…)` : ""}`;
    if (level === "ERROR" || level === "CRITICAL") console.error(line, data ?? "");
    else if (level === "WARNING") console.warn(line, data ?? "");
    else console.log(line);
  }
  if (ORDER[level] >= ORDER[MIN_PERSIST]) {
    try {
      await db.insert(systemEvents).values({ level, component, message, mint: mint ?? null, data: data ? safeJson(data) : null });
    } catch (e) {
      console.error("logger persistence failed", (e as Error).message);
    }
  }
}

export const logger = {
  debug: (c: string, m: string, d?: Record<string, unknown>, mint?: string) => log("DEBUG", c, m, d, mint),
  info: (c: string, m: string, d?: Record<string, unknown>, mint?: string) => log("INFO", c, m, d, mint),
  warn: (c: string, m: string, d?: Record<string, unknown>, mint?: string) => log("WARNING", c, m, d, mint),
  error: (c: string, m: string, d?: Record<string, unknown>, mint?: string) => log("ERROR", c, m, d, mint),
  critical: (c: string, m: string, d?: Record<string, unknown>, mint?: string) => log("CRITICAL", c, m, d, mint),
};

export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

/**
 * Alert sink. Currently persists to the dashboard `alerts` table. Additional
 * channels (Telegram/Discord/email) can be registered here without touching
 * callers.
 */
type AlertChannel = (a: { severity: AlertSeverity; kind: string; title: string; body?: string; mint?: string }) => Promise<void>;
const channels: AlertChannel[] = [];
export function registerAlertChannel(ch: AlertChannel) {
  channels.push(ch);
}

export async function raiseAlert(severity: AlertSeverity, kind: string, title: string, body?: string, mint?: string) {
  try {
    await db.insert(alerts).values({ severity, kind, title, body: body ?? null, mint: mint ?? null });
  } catch (e) {
    console.error("alert persistence failed", (e as Error).message);
  }
  await log(severity === "CRITICAL" ? "CRITICAL" : severity === "WARNING" ? "WARNING" : "INFO", "alerts", `${kind}: ${title}`, body ? { body } : undefined, mint);
  for (const ch of channels) {
    try {
      await ch({ severity, kind, title, body, mint });
    } catch (e) {
      console.error("alert channel failed", (e as Error).message);
    }
  }
}
