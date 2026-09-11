import type { Server } from "node:http";
import type { Logger } from "pino";

export function installShutdown(options: { server: Server; calls: { beginShutdown?(): void; shutdown(): Promise<void> }; closeSseStreams(): void; beforeDrain?(): Promise<void>; closeStore?(): Promise<void>; logger: Logger; deadlineMs?: number }) {
  let operation: Promise<void> | undefined;
  const shutdown = (signal: string) => {
    if (operation) return operation;
    operation = (async () => {
      options.calls.beginShutdown?.();
      options.logger.info({ signal }, "Stopping API and terminating active provider channels");
      const deadline = setTimeout(() => {
        options.logger.fatal("Shutdown deadline exceeded; provider scheduled hangup remains the final bound");
        process.exit(1);
      }, options.deadlineMs ?? 15_000);
      deadline.unref();
      const closed = new Promise<void>((resolve) => options.server.close(() => resolve()));
      options.server.closeIdleConnections();
      options.closeSseStreams();
      const failures: unknown[] = [];
      for (const cleanup of [options.beforeDrain, () => options.calls.shutdown(), options.closeStore]) {
        try { await cleanup?.(); }
        catch (error) { failures.push(error); options.logger.error({ err: error }, "Shutdown cleanup failed; attempting remaining resources"); }
      }
      options.server.closeAllConnections();
      await closed;
      if (failures.length) process.exitCode = 1;
      // Keep the hard deadline armed after an unconfirmed cleanup, in case a resource still holds the process open.
      if (!failures.length) clearTimeout(deadline);
      process.off("SIGTERM", term); process.off("SIGINT", interrupt);
    })();
    return operation;
  };
  const term = () => { void shutdown("SIGTERM"); };
  const interrupt = () => { void shutdown("SIGINT"); };
  process.on("SIGTERM", term); process.on("SIGINT", interrupt);
  return shutdown;
}
