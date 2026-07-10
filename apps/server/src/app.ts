import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createLogger } from "@gitpm/logging";
import type { HealthPayload } from "@gitpm/shared";
import Fastify, { LogController, type FastifyBaseLogger } from "fastify";

const MAX_CORRELATION_ID_LENGTH = 128;
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]+$/u;

export interface AppOptions {
  isReady?: () => boolean | Promise<boolean>;
  logger?: FastifyBaseLogger;
}

function requestId(request: IncomingMessage): string {
  const value = request.headers["x-correlation-id"];
  const candidate = Array.isArray(value) ? value[0] : value;

  if (
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= MAX_CORRELATION_ID_LENGTH &&
    SAFE_CORRELATION_ID.test(candidate)
  ) {
    return candidate;
  }

  return randomUUID();
}

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({
    genReqId: requestId,
    logController: new LogController({ disableRequestLogging: true }),
    loggerInstance: options.logger ?? createLogger(),
  });
  const isReady = options.isReady ?? (() => true);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-correlation-id", request.id);
    request.log.info(
      { correlation_id: request.id, method: request.method, path: request.url },
      "request started",
    );
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        correlation_id: request.id,
        duration_ms: reply.elapsedTime,
        method: request.method,
        path: request.url,
        status_code: reply.statusCode,
      },
      "request completed",
    );
  });

  app.get("/health/live", async (request): Promise<HealthPayload> => ({
    correlation_id: request.id,
    status: "ok",
  }));

  app.get("/health/ready", async (request, reply): Promise<HealthPayload> => {
    if (!(await isReady())) {
      reply.code(503);
      return { correlation_id: request.id, status: "not_ready" };
    }

    return { correlation_id: request.id, status: "ok" };
  });

  return app;
}
