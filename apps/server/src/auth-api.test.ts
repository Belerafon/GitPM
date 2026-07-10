import type { DraftManager } from "@gitpm/drafts";
import { AuthService, GitLabProtocolTestDouble } from "@gitpm/gitlab";
import type { PublishingService } from "@gitpm/publishing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => Promise.all(apps.splice(0).map(async (app) => app.close())));

describe("OAuth and publishing HTTP contract", () => {
  it("sets a secure memory-session cookie and forwards it to publishing", async () => {
    const gitlab = new GitLabProtocolTestDouble();
    const auth = new AuthService({
      authorizeUrl: "https://gitlab.example.test/oauth/authorize",
      clientId: "gitpm",
      redirectUri: "https://gitpm.example.test/auth/callback",
      protocol: gitlab,
    });
    const publishing = {
      commitAll: vi.fn(async () => ({ commit: "a".repeat(40), branch: "gitpm/42/DRF-API" })),
    } as unknown as PublishingService;
    const app = buildApp({
      authService: auth,
      draftManager: {} as DraftManager,
      publishingService: publishing,
    });
    apps.push(app);

    const login = await app.inject({ method: "GET", url: "/api/auth/login" });
    const started = login.json<{ state: string; authorization_url: string }>();
    expect(new URL(started.authorization_url).searchParams.get("code_challenge_method")).toBe("S256");
    const callback = await app.inject({
      method: "GET",
      url: `/api/auth/callback?state=${encodeURIComponent(started.state)}&code=authorization-code`,
    });
    expect(callback.statusCode).toBe(200);
    const setCookie = String(callback.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    const sessionCookie = setCookie.split(";")[0]!;

    const currentSession = await app.inject({
      headers: { cookie: sessionCookie },
      method: "GET",
      url: "/api/auth/session",
    });
    expect(currentSession.statusCode).toBe(200);
    expect(currentSession.json()).toMatchObject({ user: { id: "42" }, role: "Developer" });

    const committed = await app.inject({
      headers: { cookie: sessionCookie },
      method: "POST",
      url: "/api/drafts/DRF-API/commit",
      payload: { message: "Commit all" },
    });
    expect(committed.statusCode).toBe(200);
    expect(publishing.commitAll).toHaveBeenCalledWith(expect.any(String), "DRF-API", "Commit all");
  });
});
