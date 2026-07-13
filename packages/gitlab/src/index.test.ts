import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AuthError, AuthService, GitLabHttpProtocol, mapAccessLevel } from "./index.js";
import type { GitLabProtocol } from "./index.js";

function protocol(level: number | null = 30) {
  const captured: Array<Record<string, unknown>> = [];
  const implementation: GitLabProtocol = {
    exchangeAuthorizationCode: vi.fn(async (input) => {
      captured.push({ kind: "token", code: input.code, redirect_uri: input.redirectUri, verifier_hash: createHash("sha256").update(input.codeVerifier).digest("hex") });
      return { access_token: "test-access-token-secret", refresh_token: "discarded", expires_in: 7200 };
    }),
    currentUser: vi.fn(async () => ({ id: "42", username: "developer" })),
    projectAccessLevel: vi.fn(async () => level),
  };
  return { captured, implementation };
}

function service(implementation: GitLabProtocol, now = () => Date.parse("2026-07-10T00:00:00Z")) {
  return new AuthService({
    authorizeUrl: "https://gitlab.example.test/oauth/authorize",
    clientId: "gitpm-client",
    redirectUri: "https://gitpm.example.test/auth/callback",
    protocol: implementation,
    now,
  });
}

describe("OAuth PKCE and memory-only sessions", () => {
  it("validates state, exchanges PKCE and creates a capped memory session", async () => {
    const testDouble = protocol(30);
    const auth = service(testDouble.implementation);
    const started = auth.startLogin();
    const url = new URL(started.authorization_url);
    expect(url.searchParams.get("scope")).toBe("api write_repository");
    expect(url.searchParams.get("state")).toBe(started.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("nonce")).toBe(false);
    const session = await auth.completeLogin(started.state, "authorization-code");
    expect(session).toMatchObject({ user: { id: "42" }, role: "Developer" });
    expect(auth.sessionCount()).toBe(1);
    expect(JSON.stringify(testDouble.captured)).not.toContain("test-access-token-secret");
  });

  it("rejects missing state and non-members", async () => {
    const member = protocol(30);
    await expect(service(member.implementation).completeLogin("missing", "code"))
      .rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    const guest = protocol(10);
    const auth = service(guest.implementation);
    const started = auth.startLogin();
    await expect(auth.completeLogin(started.state, "code"))
      .rejects.toMatchObject({ code: "PROJECT_MEMBERSHIP_REQUIRED" });
  });

  it("refreshes role before every mutation/commit/push/MR and loses sessions on restart", async () => {
    const testDouble = protocol(30);
    const auth = service(testDouble.implementation);
    const started = auth.startLogin();
    const session = await auth.completeLogin(started.state, "code");
    for (const operation of ["mutation", "commit", "push", "mr"] as const) await auth.authorize(session.session_id, operation);
    expect(testDouble.implementation.projectAccessLevel).toHaveBeenCalledTimes(5);
    const restarted = service(testDouble.implementation);
    await expect(restarted.authorize(session.session_id, "read")).rejects.toBeInstanceOf(AuthError);
  });

  it("invalidates expired sessions, rejects replayed state and applies role revocation immediately", async () => {
    let now = Date.parse("2026-07-10T00:00:00Z");
    let level = 30;
    const testDouble = protocol(30);
    vi.mocked(testDouble.implementation.projectAccessLevel).mockImplementation(async () => level);
    const auth = service(testDouble.implementation, () => now);
    const started = auth.startLogin();
    const session = await auth.completeLogin(started.state, "code");
    await expect(auth.completeLogin(started.state, "replayed-code")).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });

    level = 20;
    await expect(auth.authorize(session.session_id, "mutation")).rejects.toMatchObject({ code: "ROLE_READ_ONLY" });
    expect((await auth.authorize(session.session_id, "read")).session.role).toBe("Reporter");

    now += 2 * 60 * 60 * 1000 + 1;
    await expect(auth.authorize(session.session_id, "read")).rejects.toMatchObject({ code: "SESSION_INVALID" });
    expect(auth.sessionCount()).toBe(0);
  });

  it("maps GitLab levels exactly", () => {
    expect(mapAccessLevel(20)).toBe("Reporter");
    expect(mapAccessLevel(30)).toBe("Developer");
    expect(mapAccessLevel(40)).toBe("Maintainer");
    expect(() => mapAccessLevel(null)).toThrowError(expect.objectContaining({ code: "PROJECT_MEMBERSHIP_REQUIRED" }));
  });
});

describe("GitLab HTTP protocol", () => {
  it("uses bearer auth, encoded project paths and PKCE token exchange", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/oauth/token")) return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }), { status: 200 });
      if (url.endsWith("/api/v4/user")) return new Response(JSON.stringify({ id: 42, username: "developer" }), { status: 200 });
      if (url.includes("/members/all/42")) return new Response(JSON.stringify({ access_level: 30 }), { status: 200 });
      if (url.endsWith("/merge_requests")) return new Response(JSON.stringify({ iid: 7, state: "opened", source_branch: "feature", target_branch: "main", web_url: "https://gitlab.example.test/group/project/-/merge_requests/7" }), { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    });
    const protocol = new GitLabHttpProtocol({
      baseUrl: "https://gitlab.example.test",
      clientId: "gitpm-client",
      project: "group/project",
      fetch: fetchImplementation as typeof fetch,
    });

    await protocol.exchangeAuthorizationCode({ code: "code", codeVerifier: "verifier", redirectUri: "http://127.0.0.1:3000/api/auth/callback" });
    expect(await protocol.projectAccessLevel("secret-token")).toBe(30);
    expect((await protocol.createMergeRequest("secret-token", { source_branch: "feature", target_branch: "main", title: "Feature" })).iid).toBe(7);
    expect(requests.some((request) => request.url.includes("projects/group%2Fproject/members/all/42"))).toBe(true);
    const authenticated = requests.find((request) => request.url.endsWith("/api/v4/user"));
    expect(new Headers(authenticated?.init?.headers).get("authorization")).toBe("Bearer secret-token");
    const tokenBody = String(requests[0]?.init?.body);
    expect(tokenBody).toContain("code_verifier=verifier");
    expect(requests.map((request) => request.url).join(" ")).not.toContain("secret-token");
  });

  it("maps a missing membership to no access and rejects insecure remote instances", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/api/v4/user")
      ? new Response(JSON.stringify({ id: 42, username: "developer" }), { status: 200 })
      : new Response("not found", { status: 404 }));
    const protocol = new GitLabHttpProtocol({ baseUrl: "https://gitlab.example.test", clientId: "client", project: "group/project", fetch: fetchImplementation as typeof fetch });
    expect(await protocol.projectAccessLevel("token")).toBeNull();
    expect(() => new GitLabHttpProtocol({ baseUrl: "http://gitlab.example.test", clientId: "client", project: "group/project" }))
      .toThrowError(expect.objectContaining({ code: "GITLAB_URL_INVALID" }));
  });
});
