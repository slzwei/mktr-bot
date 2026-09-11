import pino from "pino";
import { AsyncLocalStorage } from "node:async_hooks";

type LogContext = { requestId: string; callId?: string };
const context = new AsyncLocalStorage<LogContext>();
export const currentLogContext = (): LogContext | undefined => context.getStore();
export const withLogContext = <T>(value: LogContext, action: () => T): T => context.run(value, action);

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  // A copy: pino merges each entry's fields into the object its mixin returns, so handing it the
  // stored context would leave one entry's `err` and identifiers attached to every later entry.
  mixin: () => ({ ...currentLogContext() }),
  serializers: { err: pino.stdSerializers.err },
  redact: {
    paths: ["password", "passwordHash", "token", "authorization", "cookie", "apiKey", "transcript", "*.password", "*.passwordHash", "*.token", "*.apiKey", "req.headers.authorization", "req.headers.cookie"],
    censor: "[REDACTED]"
  }
});
