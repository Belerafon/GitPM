import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AuthError, AuthService, mapAccessLevel } from "./index.js";
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

  it("maps GitLab levels exactly", () => {
    expect(mapAccessLevel(20)).toBe("Reporter");
    expect(mapAccessLevel(30)).toBe("Developer");
    expect(mapAccessLevel(40)).toBe("Maintainer");
    expect(() => mapAccessLevel(null)).toThrowError(expect.objectContaining({ code: "PROJECT_MEMBERSHIP_REQUIRED" }));
  });
});
