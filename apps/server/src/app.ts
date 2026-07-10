import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createLogger } from "@gitpm/logging";
import type { HealthPayload } from "@gitpm/shared";
import type { DraftManager } from "@gitpm/drafts";
import type { EntityStore } from "@gitpm/domain";
import Fastify, { LogController, type FastifyBaseLogger } from "fastify";
import { registerDraftApi, registerEntityApi } from "./draft-api.js";
import type { Authenticate } from "./draft-api.js";

const MAX_CORRELATION_ID_LENGTH = 128;
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]+$/u;

export interface AppOptions {
  authenticate?: Authenticate;
  draftManager?: DraftManager;
  entityStore?: EntityStore;
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
    bodyLimit: 1_048_576,
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

  if (options.draftManager) {
    const authenticate = options.authenticate ?? (() => {
      throw new Error("Authentication adapter is not configured");
    });
    registerDraftApi(app, options.draftManager, authenticate);
    if (options.entityStore) registerEntityApi(app, options.draftManager, options.entityStore, authenticate);
  }

  return app;
}
