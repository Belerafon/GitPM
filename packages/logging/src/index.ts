import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

export const REDACTED_VALUE = "[REDACTED]";

export const REDACT_PATHS = [
  "authorization",
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "token",
  "access_token",
  "refresh_token",
] as const;

export function loggingOptions(level = process.env.LOG_LEVEL ?? "info"): LoggerOptions {
  return {
    level,
    base: undefined,
    messageKey: "message",
    redact: {
      censor: REDACTED_VALUE,
      paths: [...REDACT_PATHS],
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

export function createLogger(
  options: LoggerOptions = {},
  destination?: DestinationStream,
): Logger {
  const merged: LoggerOptions = {
    ...loggingOptions(),
    ...options,
  };

  return destination === undefined ? pino(merged) : pino(merged, destination);
}
