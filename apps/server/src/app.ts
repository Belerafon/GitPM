import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createLogger } from "@gitpm/logging";
import type { HealthPayload } from "@gitpm/shared";
import type { DraftManager } from "@gitpm/drafts";
import type { CommentStore, EntityStore } from "@gitpm/domain";
import type { ChangesService } from "@gitpm/changes";
import type { AuthService } from "@gitpm/gitlab";
import type { PublishingService } from "@gitpm/publishing";
import type { HistoryService } from "@gitpm/history";
import Fastify, { LogController, type FastifyBaseLogger } from "fastify";
import { registerChangesApi, registerCommentApi, registerDraftApi, registerEntityApi, registerHistoryApi } from "./draft-api.js";
import type { Authenticate } from "./draft-api.js";
import { registerAuthAndPublishingApi } from "./auth-api.js";
import { registerWorktreeApi, type WorktreeApiOptions } from "./worktree-api.js";

const MAX_CORRELATION_ID_LENGTH = 128;
const REQUEST_BODY_LIMIT = 1_048_576;
const UPLOAD_BODY_LIMIT = 15 * 1024 * 1024;
const UPLOAD_PATH = /\/api\/drafts\/[^/]+\/worktree\/file$/u;
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]+$/u;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
].join("; ");

export interface AppOptions {
  authenticate?: Authenticate;
  authService?: AuthService;
  changesService?: ChangesService;
  commentStore?: CommentStore;
  draftManager?: DraftManager;
  entityStore?: EntityStore;
  isReady?: () => boolean | Promise<boolean>;
  historyService?: HistoryService;
  logger?: FastifyBaseLogger;
  publishingService?: PublishingService;
  worktreeApiOptions?: WorktreeApiOptions;
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

function requestPath(url: string): string {
  return url.split("?", 1)[0] ?? "/";
}

function requestHost(request: { headers: IncomingMessage["headers"] }): string | undefined {
  const forwarded = request.headers["x-forwarded-host"];
  const candidate = Array.isArray(forwarded) ? forwarded[0] : forwarded ?? request.headers.host;
  return candidate?.toLowerCase();
}

function isCrossSiteMutation(request: { method: string; headers: IncomingMessage["headers"] }): boolean {
  if (SAFE_METHODS.has(request.method)) return false;
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") return true;
  const origin = request.headers.origin;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host.toLowerCase() !== requestHost(request);
  } catch {
    return true;
  }
}

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({
    bodyLimit: REQUEST_BODY_LIMIT,
    genReqId: requestId,
    logController: new LogController({ disableRequestLogging: true }),
    loggerInstance: options.logger ?? createLogger(),
  });
  const isReady = options.isReady ?? (() => true);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-correlation-id", request.id);
    reply.header("content-security-policy", CONTENT_SECURITY_POLICY);
    reply.header("permissions-policy", "camera=(), geolocation=(), microphone=()");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    const contentLength = Number(request.headers["content-length"]);
    const bodyLimit = UPLOAD_PATH.test(requestPath(request.url)) ? UPLOAD_BODY_LIMIT : REQUEST_BODY_LIMIT;
    if (Number.isFinite(contentLength) && contentLength > bodyLimit) {
      // Keep draining the socket so clients receive a stable 413 instead of ECONNRESET
      // while they are still transmitting the rejected body.
      request.raw.resume();
      await reply.code(413).send({
        error: {
          code: "REQUEST_TOO_LARGE",
          message: "Request body exceeds the static limit",
          correlation_id: request.id,
        },
      });
      return;
    }
    if (isCrossSiteMutation(request)) {
      await reply.code(403).send({
        error: {
          code: "CSRF_ORIGIN_FORBIDDEN",
          message: "Cross-site mutation is forbidden",
          correlation_id: request.id,
        },
      });
      return;
    }
    request.log.info(
      { correlation_id: request.id, method: request.method, path: requestPath(request.url) },
      "request started",
    );
  });

  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        correlation_id: request.id,
        duration_ms: reply.elapsedTime,
        method: request.method,
        path: requestPath(request.url),
        status_code: reply.statusCode,
      },
      "request completed",
    );
  });

  app.addHook("onError", async (request, reply, error) => {
    request.log.error(
      {
        correlation_id: request.id,
        err: error,
        method: request.method,
        path: requestPath(request.url),
        status_code: reply.statusCode,
      },
      "request failed",
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
    registerWorktreeApi(app, options.draftManager, authenticate, options.worktreeApiOptions);
    if (options.entityStore) registerEntityApi(app, options.draftManager, options.entityStore, authenticate);
    if (options.commentStore) registerCommentApi(app, options.draftManager, options.commentStore, authenticate);
    if (options.changesService) registerChangesApi(app, options.draftManager, options.changesService, authenticate);
    if (options.historyService) registerHistoryApi(app, options.draftManager, options.historyService, authenticate);
  }
  if (options.authService) registerAuthAndPublishingApi(app, options.authService, options.publishingService);

  return app;
}
