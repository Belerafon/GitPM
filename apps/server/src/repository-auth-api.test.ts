import type { DraftManager } from "@gitpm/drafts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { registerRepositoryAuthApi } from "./repository-auth-api.js";
import type { RepositoryPublishingService } from "./repository-publishing.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => Promise.all(apps.splice(0).map(async (app) => app.close())));

describe("optional GitLab repository session", () => {
  it("keeps local access and commit available without a GitLab cookie", async () => {
    const publishing = {
      commitAll: vi.fn(async () => ({ commit: "a".repeat(40), branch: "gitpm/local/DRF-LOCAL" })),
      push: vi.fn(),
    } as unknown as RepositoryPublishingService;
    const app = buildApp({ draftManager: {} as DraftManager, authenticate: () => ({ userId: "local-user", role: "Maintainer" }) });
    apps.push(app);
    registerRepositoryAuthApi(app, {
      session_id: "repository-session",
      user: { id: "local-user", username: "local" },
      role: "Maintainer",
      mode: "repository",
      repository: { name: "portfolio", path: "D:/portfolio", has_remote: false },
      expires_at: "9999-12-31T23:59:59.999Z",
    }, publishing, undefined, "http://127.0.0.1:5173");

    const session = await app.inject({ method: "GET", url: "/api/auth/session" });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ mode: "repository", gitlab: { configured: false } });

    const committed = await app.inject({ method: "POST", url: "/api/drafts/DRF-LOCAL/commit", payload: { message: "Local commit" } });
    expect(committed.statusCode).toBe(200);
    expect(publishing.commitAll).toHaveBeenCalledWith("DRF-LOCAL", "Local commit");

    const push = await app.inject({ method: "POST", url: "/api/drafts/DRF-LOCAL/push" });
    expect(push.statusCode).toBe(401);
    expect(push.json()).toMatchObject({ error: { code: "SESSION_INVALID" } });
    expect(publishing.push).not.toHaveBeenCalled();
  });
});
