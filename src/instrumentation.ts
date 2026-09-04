/**
 * Next.js instrumentation hook — runs once when the server process boots.
 * Starts the bot scheduler in the Node.js runtime only (never in the Edge
 * runtime or during `next build`). Set BOT_AUTOSTART=false to disable.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.BOT_AUTOSTART === "false") return;
  const { startScheduler } = await import("./lib/bot/scheduler");
  // Delay slightly so the DB pool and server are ready.
  setTimeout(() => void startScheduler(), 3000);
}
