import type { FastifyInstance, FastifyRequest } from "fastify";
import { AuthError } from "@gitpm/gitlab";
import type { AuthService } from "@gitpm/gitlab";
import type { PublishingService } from "@gitpm/publishing";

function cookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function sessionId(request: FastifyRequest): string {
  const session = cookie(request, "gitpm_session");
  if (!session) throw new AuthError("SESSION_INVALID", "Session cookie is missing");
  return session;
}

export function registerAuthAndPublishingApi(
  app: FastifyInstance,
  auth: AuthService,
  publishing?: PublishingService,
): void {
  app.get("/api/auth/login", async () => auth.startLogin());

  app.get("/api/auth/session", async (request) => {
    const authorization = await auth.authorize(sessionId(request), "read");
    return authorization.session;
  });

  app.get<{ Querystring: { state: string; code: string } }>("/api/auth/callback", async (request, reply) => {
    const session = await auth.completeLogin(request.query.state, request.query.code);
    const maxAge = Math.max(0, Math.floor((Date.parse(session.expires_at) - Date.now()) / 1000));
    reply.header(
      "set-cookie",
      `gitpm_session=${encodeURIComponent(session.session_id)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
    );
    return session;
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const session = cookie(request, "gitpm_session");
    if (session) auth.logout(session);
    reply.header("set-cookie", "gitpm_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
    await reply.code(204).send();
  });

  if (!publishing) return;
  app.post<{ Params: { draftId: string }; Body: { message: string } }>("/api/drafts/:draftId/commit", async (request) =>
    await publishing.commitAll(sessionId(request), request.params.draftId, request.body.message));
  app.post<{ Params: { draftId: string } }>("/api/drafts/:draftId/push", async (request) =>
    await publishing.push(sessionId(request), request.params.draftId));
  app.post<{ Params: { draftId: string }; Body: { title: string; description?: string } }>("/api/drafts/:draftId/merge-request", async (request) =>
    await publishing.createMergeRequest(sessionId(request), request.params.draftId, request.body.title, request.body.description));
  app.get<{ Params: { draftId: string } }>("/api/drafts/:draftId/merge-request", async (request) =>
    await publishing.pollMergeRequest(sessionId(request), request.params.draftId));
}
