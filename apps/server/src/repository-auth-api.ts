import type { FastifyInstance, FastifyRequest } from "fastify";
import { AuthError } from "@gitpm/gitlab";
import type { ProtectedOperation, PublicSession } from "@gitpm/gitlab";
import type { RepositoryPublishingService } from "./repository-publishing.js";
import type { RepositoryConnectionManager, RepositoryConnectionUpdate } from "./repository-connection.js";

const COOKIE_NAME = "gitpm_gitlab_session";

interface RepositoryAuthentication {
  startLogin(): { authorization_url: string; state: string };
  completeLogin(state: string, code: string): Promise<PublicSession>;
  authorize(sessionId: string, operation: ProtectedOperation): Promise<{ session: PublicSession; accessToken: string }>;
  logout(sessionId: string): void;
}

function cookie(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === COOKIE_NAME) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function requiredSession(request: FastifyRequest): string {
  const session = cookie(request);
  if (!session) throw new AuthError("SESSION_INVALID", "Sign in to GitLab before using the remote");
  return session;
}

export interface RepositorySession {
  readonly session_id: "repository-session";
  readonly user: { readonly id: string; readonly username: string };
  readonly role: "Maintainer";
  readonly mode: "repository";
  readonly repository_mode?: "direct" | "worktree";
  readonly repository: { readonly name: string; readonly path: string; readonly has_remote: boolean; readonly branch?: string };
  readonly gitlab: {
    readonly configured: boolean;
    readonly user?: { readonly id: string; readonly username: string };
    readonly role?: "Reporter" | "Developer" | "Maintainer";
  };
  readonly expires_at: string;
}

export function registerRepositoryAuthApi(
  app: FastifyInstance,
  baseSession: Omit<RepositorySession, "gitlab">,
  publishing: RepositoryPublishingService,
  auth: RepositoryAuthentication | undefined,
  webUrl: string,
  connection?: RepositoryConnectionManager,
): void {
  app.get("/api/auth/session", async (request): Promise<RepositorySession> => {
    const session = cookie(request);
    if (auth !== undefined && session !== undefined) {
      try {
        const authorized = await auth.authorize(session, "read");
        const repository = connection === undefined ? baseSession.repository : {
          ...baseSession.repository,
          has_remote: connection.status().repository_url !== undefined,
        };
        return { ...baseSession, repository, gitlab: { configured: true, user: authorized.session.user, role: authorized.session.role } };
      } catch (error) {
        if (!(error instanceof AuthError) || error.code !== "SESSION_INVALID") throw error;
      }
    }
    const repository = connection === undefined ? baseSession.repository : {
      ...baseSession.repository,
      has_remote: connection.status().repository_url !== undefined,
    };
    return { ...baseSession, repository, gitlab: { configured: auth !== undefined && (connection?.status().gitlab.configured ?? true) } };
  });

  app.get("/api/auth/login", async () => {
    if (auth === undefined) throw new AuthError("GITLAB_NOT_CONFIGURED", "GitLab login is not configured for this repository");
    return auth.startLogin();
  });

  app.get<{ Querystring: { state: string; code: string } }>("/api/auth/callback", async (request, reply) => {
    if (auth === undefined) throw new AuthError("GITLAB_NOT_CONFIGURED", "GitLab login is not configured for this repository");
    const session = await auth.completeLogin(request.query.state, request.query.code);
    const maxAge = Math.max(0, Math.floor((Date.parse(session.expires_at) - Date.now()) / 1000));
    reply.header("set-cookie", `${COOKIE_NAME}=${encodeURIComponent(session.session_id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
    return await reply.redirect(webUrl);
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const session = cookie(request);
    if (auth !== undefined && session !== undefined) auth.logout(session);
    reply.header("set-cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    await reply.code(204).send();
  });

  if (connection !== undefined) {
    app.get("/api/repository/connection", async () => connection.status());
    app.put<{ Body: RepositoryConnectionUpdate }>("/api/repository/connection", async (request) => await connection.update(request.body));
    app.post("/api/repository/connection/test", async (request) => await connection.test(requiredSession(request)));
  }

  app.post<{ Params: { draftId: string }; Body: { message: string } }>("/api/drafts/:draftId/commit", async (request) =>
    await publishing.commitAll(request.params.draftId, request.body.message));
  app.post<{ Params: { draftId: string } }>("/api/drafts/:draftId/push", async (request) =>
    await publishing.push(requiredSession(request), request.params.draftId));
  app.post<{ Params: { draftId: string }; Body: { title: string; description?: string } }>("/api/drafts/:draftId/merge-request", async (request) =>
    await publishing.createMergeRequest(requiredSession(request), request.params.draftId, request.body.title, request.body.description));
  app.get<{ Params: { draftId: string } }>("/api/drafts/:draftId/merge-request", async (request) =>
    await publishing.pollMergeRequest(requiredSession(request), request.params.draftId));
}
