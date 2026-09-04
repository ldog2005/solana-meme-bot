import { logger, raiseAlert } from "../core/logger";
import { loadSettings, getBotState, patchBotState } from "./state";
import { monitorPositions, recoverState, runScan } from "./scanner";
import { num } from "../config/settings";

// ---------------------------------------------------------------------------
// In-process scheduler. Started once per server process (instrumentation.ts).
// Uses globalThis so that Next.js module re-evaluation cannot spawn a second
// loop. Two independent loops: scan (slow) and position monitor (fast). Both
// are guarded against overlapping runs. Graceful shutdown on SIGTERM/SIGINT.
// ---------------------------------------------------------------------------

interface SchedulerState {
  started: boolean;
  scanning: boolean;
  monitoring: boolean;
  scanTimer: NodeJS.Timeout | null;
  monitorTimer: NodeJS.Timeout | null;
  stopping: boolean;
  lastError: string | null;
  scanCount: number;
}

const g = globalThis as typeof globalThis & { __memeBotScheduler?: SchedulerState };

export function schedulerState(): SchedulerState {
  if (!g.__memeBotScheduler) g.__memeBotScheduler = { started: false, scanning: false, monitoring: false, scanTimer: null, monitorTimer: null, stopping: false, lastError: null, scanCount: 0 };
  return g.__memeBotScheduler;
}

export async function tickScan(force = false) {
  const st = schedulerState();
  if (st.scanning) return { skipped: "scan already running" };
  const bot = await getBotState();
  if (!bot.running && !force) return { skipped: "bot paused" };
  st.scanning = true;
  try {
    const r = await runScan();
    st.scanCount++;
    return r;
  } catch (e) {
    st.lastError = (e as Error).message;
    await logger.error("scheduler", `scan tick crashed: ${st.lastError}`);
    return { error: st.lastError };
  } finally {
    st.scanning = false;
  }
}

export async function tickMonitor() {
  const st = schedulerState();
  if (st.monitoring) return { skipped: "monitor already running" };
  st.monitoring = true;
  try {
    return await monitorPositions();
  } catch (e) {
    st.lastError = (e as Error).message;
    await logger.error("scheduler", `monitor tick crashed: ${st.lastError}`);
    return { error: st.lastError };
  } finally {
    st.monitoring = false;
  }
}

async function loop(kind: "scan" | "monitor") {
  const st = schedulerState();
  if (st.stopping) return;
  const s = await loadSettings().catch(() => null);
  const interval = kind === "scan" ? (s ? num(s, "SCAN_INTERVAL_SEC") : 60) * 1000 : (s ? num(s, "POSITION_CHECK_INTERVAL_SEC") : 20) * 1000;
  try {
    if (kind === "scan") await tickScan();
    else await tickMonitor();
  } catch {
    /* ticks never throw, but be defensive */
  }
  if (st.stopping) return;
  const t = setTimeout(() => void loop(kind), interval);
  if (kind === "scan") st.scanTimer = t;
  else st.monitorTimer = t;
}

export async function startScheduler() {
  const st = schedulerState();
  if (st.started) return;
  st.started = true;
  try {
    await recoverState();
    await patchBotState({ startedAt: new Date() });
    await logger.info("scheduler", "Bot scheduler started (PAPER mode by default; live trading disabled)");
  } catch (e) {
    await logger.error("scheduler", `startup recovery failed: ${(e as Error).message}`);
  }
  // Stagger: monitor immediately, scan after 5s.
  setTimeout(() => void loop("monitor"), 1000);
  setTimeout(() => void loop("scan"), 5000);

  const shutdown = async (sig: string) => {
    if (st.stopping) return;
    st.stopping = true;
    if (st.scanTimer) clearTimeout(st.scanTimer);
    if (st.monitorTimer) clearTimeout(st.monitorTimer);
    await logger.warn("scheduler", `Graceful shutdown on ${sig}; open positions persist in DB and are recovered on restart`);
    await raiseAlert("WARNING", "BOT_STOPPED", `Process received ${sig}`, "Bot stopped. Positions will be reconciled on restart.");
    // give in-flight ticks a moment
    const deadline = Date.now() + 8000;
    while ((st.scanning || st.monitoring) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
