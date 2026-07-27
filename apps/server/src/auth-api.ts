import type { FastifyInstance, FastifyRequest } from "fastify";
import { HTTP_REQUEST_BODY_SCHEMAS } from "@gitpm/contracts";
import { AuthError } from "@gitpm/gitlab";
import type { ProtectedOperation, PublicSession } from "@gitpm/gitlab";
import type { CommitPublicationContext, PublicationService, RemotePublicationContext } from "@gitpm/publishing";
import type { RepositoryConnectionManager, RepositoryConnectionUpdate } from "./repository-connection.js";

const COOKIE_NAME = "gitpm_gitlab_session";

function sessionCookieFlags(): string {
  const secure = process.env.GITPM_COOKIE_SECURE?.trim().toLowerCase() !== "false";
  return `Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax`;
}

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

export function requiredRepositorySession(request: FastifyRequest): string {
  const session = cookie(request);
  if (!session) throw new AuthError("SESSION_INVALID", "Sign in to GitLab before using the remote");
  return session;
}

export interface RepositorySession {
  readonly session_id: "repository-session";
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly name?: string;
    readonly email?: string;
  };
  readonly role: "Reporter" | "Developer" | "Maintainer";
  readonly mode: "repository";
  readonly repository_mode?: "direct" | "worktree";
  readonly repository: { readonly name: string; readonly path: string; readonly has_remote: boolean; readonly branch?: string };
  readonly gitlab: {
    readonly configured: boolean;
    readonly user?: {
      readonly id: string;
      readonly username: string;
      readonly name?: string;
      readonly email?: string;
    };
    readonly role?: "Reporter" | "Developer" | "Maintainer";
  };
  readonly expires_at: string;
}

export function registerAuthApi(
  app: FastifyInstance,
  baseSession: Omit<RepositorySession, "gitlab">,
  publishing: PublicationService,
  localContext: CommitPublicationContext,
  auth: RepositoryAuthentication | undefined,
  webUrl: string,
  connection?: RepositoryConnectionManager,
): void {
  const identityProjectTokenMode = connection?.authMode === "oauth-identity-project-token";
  const publicBaseSession: Omit<RepositorySession, "session_id" | "gitlab"> = {
    user: baseSession.user,
    role: baseSession.role,
    mode: baseSession.mode,
    ...(baseSession.repository_mode === undefined ? {} : { repository_mode: baseSession.repository_mode }),
    repository: baseSession.repository,
    expires_at: baseSession.expires_at,
  };
  const remoteContext = async (
    request: FastifyRequest,
    operation: ProtectedOperation,
  ): Promise<{ context: RemotePublicationContext; user?: PublicSession["user"] }> => {
    if (auth === undefined) {
      // Non-GitLab transport (SSH key or HTTP(S) token): the credential is provisioned
      // at the process boundary, so publication uses the local maintainer identity
      // without an OAuth session.
      const envToken = process.env.GITPM_REMOTE_TOKEN?.trim() || undefined;
      return { context: { ownerId: localContext.ownerId, accessToken: () => envToken } };
    }
    const session = requiredRepositorySession(request);
    const authorized = await auth.authorize(session, operation);
    return {
      context: {
        ownerId: identityProjectTokenMode ? authorized.session.user.id : localContext.ownerId,
        accessToken: () => authorized.accessToken,
      },
      ...(identityProjectTokenMode ? { user: authorized.session.user } : {}),
    };
  };

  const commitContext = async (
    request: FastifyRequest,
  ): Promise<{ context: CommitPublicationContext; user?: PublicSession["user"] }> => {
    if (!identityProjectTokenMode || auth === undefined) return { context: localContext };
    const authorized = await auth.authorize(requiredRepositorySession(request), "commit");
    const user = authorized.session.user;
    if (!user.email) {
      throw new AuthError(
        "GITLAB_PUBLIC_EMAIL_REQUIRED",
        "Configure a Public email in your GitLab profile before creating a commit",
      );
    }
    if (!user.name.trim()) {
      throw new AuthError("GITLAB_PROFILE_NAME_REQUIRED", "GitLab profile name is required before creating a commit");
    }
    return {
      context: {
        ownerId: user.id,
        authorName: user.name,
        authorEmail: user.email,
      },
      user,
    };
  };

  const audit = (
    request: FastifyRequest,
    operation: string,
    user: PublicSession["user"] | undefined,
    result: "succeeded" | "failed",
    details: Record<string, unknown> = {},
  ): void => {
    request.log.info({
      audit: true,
      operation,
      result,
      ...(user === undefined ? {} : { gitlab_user_id: user.id, gitlab_username: user.username }),
      ...details,
    }, "GitPM publication audit");
  };

  app.get("/api/auth/session", async (request): Promise<Omit<RepositorySession, "session_id">> => {
    const session = cookie(request);
    if (auth !== undefined && session !== undefined) {
      try {
        const authorized = await auth.authorize(session, "read");
        const repository = connection === undefined ? baseSession.repository : {
          ...baseSession.repository,
          has_remote: connection.status().repository_url !== undefined,
        };
        return {
          ...publicBaseSession,
          ...(identityProjectTokenMode ? { user: authorized.session.user, role: authorized.session.role } : {}),
          repository,
          gitlab: { configured: true, user: authorized.session.user, role: authorized.session.role },
        };
      } catch (error) {
        if (!(error instanceof AuthError) || error.code !== "SESSION_INVALID") throw error;
      }
    }
    const repository = connection === undefined ? baseSession.repository : {
      ...baseSession.repository,
      has_remote: connection.status().repository_url !== undefined,
    };
    return { ...publicBaseSession, repository, gitlab: { configured: auth !== undefined && (connection?.status().gitlab.configured ?? true) } };
  });

  app.get("/api/auth/login", async () => {
    if (auth === undefined) throw new AuthError("GITLAB_NOT_CONFIGURED", "GitLab login is not configured for this repository");
    return auth.startLogin();
  });

  app.get<{ Querystring: { state: string; code: string } }>("/api/auth/callback", async (request, reply) => {
    if (auth === undefined) throw new AuthError("GITLAB_NOT_CONFIGURED", "GitLab login is not configured for this repository");
    const session = await auth.completeLogin(request.query.state, request.query.code);
    const maxAge = Math.max(0, Math.floor((Date.parse(session.expires_at) - Date.now()) / 1000));
    reply.header("set-cookie", `${COOKIE_NAME}=${encodeURIComponent(session.session_id)}; ${sessionCookieFlags()}; Max-Age=${maxAge}`);
    return await reply.redirect(webUrl);
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const session = cookie(request);
    if (auth !== undefined && session !== undefined) auth.logout(session);
    reply.header("set-cookie", `${COOKIE_NAME}=; ${sessionCookieFlags()}; Max-Age=0`);
    await reply.code(204).send();
  });

  if (connection !== undefined) {
    app.get("/api/repository/connection", async () => connection.status());
    app.put<{ Body: RepositoryConnectionUpdate }>("/api/repository/connection", { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.repositoryConnectionUpdate } }, async (request) => {
      if (identityProjectTokenMode && auth !== undefined) {
        await auth.authorize(requiredRepositorySession(request), "mutation");
      }
      return await connection.update(request.body);
    });
    app.post("/api/repository/connection/test", async (request) => await connection.test(cookie(request)));
  }

  app.post<{ Params: { draftId: string }; Body: { message: string } }>("/api/drafts/:draftId/commit", { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.commit } }, async (request) => {
    const { context, user } = await commitContext(request);
    try {
      const result = await publishing.commit(context, { draftId: request.params.draftId }, request.body.message);
      audit(request, "commit", user, "succeeded", { commit_sha: result.commit, branch: result.branch });
      return result;
    } catch (error) {
      audit(request, "commit", user, "failed");
      throw error;
    }
  });
  app.post<{ Params: { draftId: string } }>("/api/drafts/:draftId/push", async (request) => {
    const { context, user } = await remoteContext(request, "push");
    try {
      const result = await publishing.push(context, { draftId: request.params.draftId });
      audit(request, "push", user, "succeeded", { commit_sha: result.commit, branch: result.branch });
      return result;
    } catch (error) {
      audit(request, "push", user, "failed");
      throw error;
    }
  });
  app.post<{ Params: { draftId: string }; Body: { title: string; description?: string } }>("/api/drafts/:draftId/merge-request", { schema: { body: HTTP_REQUEST_BODY_SCHEMAS.mergeRequest } }, async (request) => {
    const { context, user } = await remoteContext(request, "mr");
    const initiatedBy = user === undefined ? undefined : `Initiated in GitPM by @${user.username}`;
    const suppliedDescription = request.body.description?.trim();
    const description = initiatedBy === undefined
      ? suppliedDescription
      : suppliedDescription ? `${suppliedDescription}\n\n${initiatedBy}` : initiatedBy;
    try {
      const result = await publishing.createMergeRequest(
        context,
        { draftId: request.params.draftId },
        { title: request.body.title, ...(description === undefined ? {} : { description }) },
      );
      audit(request, "merge-request", user, "succeeded", { merge_request_iid: result.iid });
      return result;
    } catch (error) {
      audit(request, "merge-request", user, "failed");
      throw error;
    }
  });
  app.get<{ Params: { draftId: string } }>("/api/drafts/:draftId/merge-request", async (request) =>
    await publishing.pollMergeRequest((await remoteContext(request, "read")).context, { draftId: request.params.draftId }));
}
