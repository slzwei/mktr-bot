import type { Server } from "node:http";
import type { Logger } from "pino";

export function installShutdown(options: { server: Server; calls: { shutdown(): Promise<void> }; closeSseStreams(): void; beforeDrain?(): Promise<void>; closeStore?(): Promise<void>; logger: Logger; deadlineMs?: number }) {
  let operation: Promise<void> | undefined;
  const shutdown = (signal: string) => {
    if (operation) return operation;
    operation = (async () => {
      options.logger.info({ signal }, "Stopping API and terminating active provider channels");
      const deadline = setTimeout(() => {
        options.logger.fatal("Shutdown deadline exceeded; provider scheduled hangup remains the final bound");
        process.exit(1);
      }, options.deadlineMs ?? 15_000);
      deadline.unref();
      const closed = new Promise<void>((resolve) => options.server.close(() => resolve()));
      options.server.closeIdleConnections();
      options.closeSseStreams();
      try {
        await options.beforeDrain?.();
        await options.calls.shutdown();
        await options.closeStore?.();
        options.server.closeAllConnections();
        await closed;
      } catch (error) {
        options.logger.error({ err: error }, "Shutdown completed with unconfirmed cleanup");
        process.exitCode = 1;
        options.server.closeAllConnections();
      } finally {
        clearTimeout(deadline);
        process.off("SIGTERM", term); process.off("SIGINT", interrupt);
      }
    })();
    return operation;
  };
  const term = () => { void shutdown("SIGTERM"); };
  const interrupt = () => { void shutdown("SIGINT"); };
  process.on("SIGTERM", term); process.on("SIGINT", interrupt);
  return shutdown;
}
