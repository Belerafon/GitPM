import type { DraftManager } from "@gitpm/drafts";
import type { PublicSession } from "@gitpm/gitlab";
import type { PublicationService } from "@gitpm/publishing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { registerAuthApi } from "./auth-api.js";
import type { RepositoryConnectionManager } from "./repository-connection.js";

const apps: ReturnType<typeof buildApp>[] = [];
const originalCookieSecure = process.env.GITPM_COOKIE_SECURE;

afterEach(async () => {
  if (originalCookieSecure === undefined) delete process.env.GITPM_COOKIE_SECURE;
  else process.env.GITPM_COOKIE_SECURE = originalCookieSecure;
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function repositoryAuth() {
  const session: PublicSession = {
    session_id: "session-id",
    user: {
      id: "42",
      username: "maintainer",
      name: "GitLab Maintainer",
      email: "maintainer@example.test",
    },
    role: "Maintainer",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  return {
    startLogin: () => ({ authorization_url: "https://gitlab.example/oauth/authorize", state: "state" }),
    completeLogin: vi.fn(async () => session),
    authorize: vi.fn(async () => ({ session, accessToken: "token" })),
    logout: vi.fn(),
  };
}

function baseRepositorySession() {
  return {
    session_id: "repository-session" as const,
    user: { id: "local-user", username: "local" },
    role: "Maintainer" as const,
    mode: "repository" as const,
    repository: { name: "portfolio", path: "D:/portfolio", has_remote: true },
    expires_at: "9999-12-31T23:59:59.999Z",
  };
}

const localContext = {
  ownerId: "local-user",
  authorName: "Local User",
  authorEmail: "local@example.test",
};

function identityProjectTokenConnection(): RepositoryConnectionManager {
  return {
    authMode: "oauth-identity-project-token",
    status: () => ({
      repository_path: "D:/portfolio",
      repository_mode: "worktree",
      default_branch: "main",
      repository_url: "https://gitlab.example/group/portfolio.git",
      remote_source: "environment",
      remote_editable: false,
      gitlab_editable: false,
      gitlab: {
        configured: true,
        base_url: "https://gitlab.example",
        project: "group/portfolio",
        client_id: "app",
        auth_mode: "oauth-identity-project-token",
      },
    }),
  } as unknown as RepositoryConnectionManager;
}

describe("optional GitLab repository session", () => {
  it("sets Secure on the OAuth session cookie by default", async () => {
    delete process.env.GITPM_COOKIE_SECURE;
    const app = buildApp({ draftManager: {} as DraftManager, authenticate: () => ({ userId: "local-user", role: "Maintainer" }) });
    apps.push(app);
    registerAuthApi(
      app,
      baseRepositorySession(),
      {} as PublicationService,
      localContext,
      repositoryAuth(),
      "http://127.0.0.1:5173",
    );

    const response = await app.inject({ method: "GET", url: "/api/auth/callback?state=state&code=code" });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("http://127.0.0.1:5173");
    expect(response.headers["set-cookie"]).toMatch(/^gitpm_gitlab_session=/u);
    expect(response.headers["set-cookie"]).toContain("; Secure; SameSite=Lax;");
  });

  it("allows Secure to be disabled for an explicitly configured plain-HTTP deployment", async () => {
    process.env.GITPM_COOKIE_SECURE = "false";
    const app = buildApp({ draftManager: {} as DraftManager, authenticate: () => ({ userId: "local-user", role: "Maintainer" }) });
    apps.push(app);
    registerAuthApi(
      app,
      baseRepositorySession(),
      {} as PublicationService,
      localContext,
      repositoryAuth(),
      "http://127.0.0.1:5173",
    );

    const response = await app.inject({ method: "GET", url: "/api/auth/callback?state=state&code=code" });
    expect(response.headers["set-cookie"]).toContain("; HttpOnly; SameSite=Lax;");
    expect(response.headers["set-cookie"]).not.toContain("; Secure;");
  });

  it("keeps local access and commit available without a GitLab cookie", async () => {
    const publishing = {
      commit: vi.fn(async () => ({ commit: "a".repeat(40), branch: "gitpm/local/DRF-LOCAL" })),
      push: vi.fn(async () => ({ branch: "gitpm/local/DRF-LOCAL", commit: "a".repeat(40) })),
    } as unknown as PublicationService;
    const app = buildApp({ draftManager: {} as DraftManager, authenticate: () => ({ userId: "local-user", role: "Maintainer" }) });
    apps.push(app);
    registerAuthApi(app, {
      session_id: "repository-session",
      user: { id: "local-user", username: "local" },
      role: "Maintainer",
      mode: "repository",
      repository: { name: "portfolio", path: "D:/portfolio", has_remote: false },
      expires_at: "9999-12-31T23:59:59.999Z",
    }, publishing, localContext, undefined, "http://127.0.0.1:5173");

    const session = await app.inject({ method: "GET", url: "/api/auth/session" });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ mode: "repository", gitlab: { configured: false } });
    expect(session.json()).not.toHaveProperty("session_id");

    const committed = await app.inject({ method: "POST", url: "/api/drafts/DRF-LOCAL/commit", payload: { message: "Local commit" } });
    expect(committed.statusCode).toBe(200);
    expect(publishing.commit).toHaveBeenCalledWith(localContext, { draftId: "DRF-LOCAL" }, "Local commit");

    // Without GitLab, publication authenticates at the transport layer (SSH key or
    // HTTP(S) token) rather than an OAuth session, so push delegates to the local
    // maintainer context with the environment token accessor.
    const push = await app.inject({ method: "POST", url: "/api/drafts/DRF-LOCAL/push" });
    expect(push.statusCode).toBe(200);
    expect(publishing.push).toHaveBeenCalledWith(
      { ownerId: "local-user", accessToken: expect.any(Function) },
      { draftId: "DRF-LOCAL" },
    );
    const pushContext = vi.mocked(publishing.push).mock.calls[0]![0];
    expect(pushContext.accessToken()).toBeUndefined();
  });

  it("routes a non-GitLab HTTP(S) push through the GITPM_REMOTE_TOKEN accessor", async () => {
    const previousToken = process.env.GITPM_REMOTE_TOKEN;
    process.env.GITPM_REMOTE_TOKEN = "pat-admin-token";
    try {
      const publishing = {
        push: vi.fn(async () => ({ branch: "gitpm/local/DRF-LOCAL", commit: "a".repeat(40) })),
      } as unknown as PublicationService;
      const app = buildApp({ draftManager: {} as DraftManager, authenticate: () => ({ userId: "local-user", role: "Maintainer" }) });
      apps.push(app);
      registerAuthApi(app, baseRepositorySession(), publishing, localContext, undefined, "http://127.0.0.1:5173");

      const response = await app.inject({ method: "POST", url: "/api/drafts/DRF-LOCAL/push" });
      expect(response.statusCode).toBe(200);
      const context = vi.mocked(publishing.push).mock.calls[0]![0];
      expect(context.accessToken()).toBe("pat-admin-token");
    } finally {
      if (previousToken === undefined) delete process.env.GITPM_REMOTE_TOKEN;
      else process.env.GITPM_REMOTE_TOKEN = previousToken;
    }
  });

  it("adapts the GitLab session to an in-memory publication context", async () => {
    const auth = repositoryAuth();
    const publishing = {
      push: vi.fn(async () => ({ branch: "gitpm/local/DRF-LOCAL", commit: "a".repeat(40) })),
    } as unknown as PublicationService;
    const app = buildApp({ draftManager: {} as DraftManager, authenticate: () => ({ userId: "local-user", role: "Maintainer" }) });
    apps.push(app);
    registerAuthApi(app, baseRepositorySession(), publishing, localContext, auth, "http://127.0.0.1:5173");

    const response = await app.inject({
      headers: { cookie: "gitpm_gitlab_session=session-id" },
      method: "POST",
      url: "/api/drafts/DRF-LOCAL/push",
    });

    expect(response.statusCode).toBe(200);
    expect(auth.authorize).toHaveBeenCalledWith("session-id", "push");
    expect(publishing.push).toHaveBeenCalledWith(
      { ownerId: "local-user", accessToken: expect.any(Function) },
      { draftId: "DRF-LOCAL" },
    );
    const context = vi.mocked(publishing.push).mock.calls[0]![0];
    expect(context.accessToken()).toBe("token");
  });

  it("uses OAuth profile identity for one commit and never returns either access token", async () => {
    const auth = repositoryAuth();
    const publishing = {
      commit: vi.fn(async () => ({
        commit: "a".repeat(40),
        branch: "gitpm/42/DRF-USER",
        draft_fingerprint: "b".repeat(64),
      })),
    } as unknown as PublicationService;
    const app = buildApp({
      draftManager: {} as DraftManager,
      authenticate: () => ({ userId: "42", role: "Maintainer" }),
    });
    apps.push(app);
    registerAuthApi(
      app,
      baseRepositorySession(),
      publishing,
      localContext,
      auth,
      "http://127.0.0.1:5173",
      identityProjectTokenConnection(),
    );

    const committed = await app.inject({
      headers: { cookie: "gitpm_gitlab_session=session-id" },
      method: "POST",
      url: "/api/drafts/DRF-USER/commit",
      payload: { message: "OAuth user commit" },
    });
    expect(committed.statusCode).toBe(200);
    expect(publishing.commit).toHaveBeenCalledWith({
      ownerId: "42",
      authorName: "GitLab Maintainer",
      authorEmail: "maintainer@example.test",
    }, { draftId: "DRF-USER" }, "OAuth user commit");

    const session = await app.inject({
      headers: { cookie: "gitpm_gitlab_session=session-id" },
      method: "GET",
      url: "/api/auth/session",
    });
    expect(session.json()).toMatchObject({
      user: {
        id: "42",
        username: "maintainer",
        name: "GitLab Maintainer",
        email: "maintainer@example.test",
      },
      role: "Maintainer",
    });
    expect(session.body).not.toContain("token");
  });

  it("blocks commit when the GitLab profile has no Public email", async () => {
    const auth = repositoryAuth();
    vi.mocked(auth.authorize).mockResolvedValue({
      session: {
        session_id: "session-id",
        user: { id: "42", username: "maintainer", name: "GitLab Maintainer" },
        role: "Maintainer",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
      accessToken: "project-token",
    });
    const publishing = { commit: vi.fn() } as unknown as PublicationService;
    const app = buildApp({
      draftManager: {} as DraftManager,
      authenticate: () => ({ userId: "42", role: "Maintainer" }),
    });
    apps.push(app);
    registerAuthApi(
      app,
      baseRepositorySession(),
      publishing,
      localContext,
      auth,
      "http://127.0.0.1:5173",
      identityProjectTokenConnection(),
    );

    const response = await app.inject({
      headers: { cookie: "gitpm_gitlab_session=session-id" },
      method: "POST",
      url: "/api/drafts/DRF-USER/commit",
      payload: { message: "Blocked commit" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: "GITLAB_PUBLIC_EMAIL_REQUIRED",
        message: expect.stringContaining("Public email"),
      },
    });
    expect(publishing.commit).not.toHaveBeenCalled();
  });

  it("uses the server credential for push and annotates bot-created Merge Requests", async () => {
    const auth = repositoryAuth();
    const session = {
      session_id: "session-id",
      user: {
        id: "42",
        username: "maintainer",
        name: "GitLab Maintainer",
        email: "maintainer@example.test",
      },
      role: "Maintainer" as const,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    vi.mocked(auth.authorize).mockResolvedValue({ session, accessToken: "project-access-token" });
    const publishing = {
      push: vi.fn(async () => ({ branch: "gitpm/42/DRF-USER", commit: "a".repeat(40) })),
      createMergeRequest: vi.fn(async () => ({
        iid: 17,
        state: "opened",
        source_branch: "gitpm/42/DRF-USER",
        target_branch: "main",
        web_url: "https://gitlab.example/group/portfolio/-/merge_requests/17",
      })),
    } as unknown as PublicationService;
    const app = buildApp({
      draftManager: {} as DraftManager,
      authenticate: () => ({ userId: "42", role: "Maintainer" }),
    });
    apps.push(app);
    registerAuthApi(
      app,
      baseRepositorySession(),
      publishing,
      localContext,
      auth,
      "http://127.0.0.1:5173",
      identityProjectTokenConnection(),
    );

    await app.inject({
      headers: { cookie: "gitpm_gitlab_session=session-id" },
      method: "POST",
      url: "/api/drafts/DRF-USER/push",
    });
    const pushedContext = vi.mocked(publishing.push).mock.calls[0]![0];
    expect(pushedContext).toMatchObject({ ownerId: "42" });
    expect(pushedContext.accessToken()).toBe("project-access-token");

    await app.inject({
      headers: { cookie: "gitpm_gitlab_session=session-id" },
      method: "POST",
      url: "/api/drafts/DRF-USER/merge-request",
      payload: { title: "User change", description: "Details" },
    });
    expect(publishing.createMergeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "42" }),
      { draftId: "DRF-USER" },
      { title: "User change", description: "Details\n\nInitiated in GitPM by @maintainer" },
    );
  });
});
