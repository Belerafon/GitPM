import type { DraftManager, DraftMetadata } from "@gitpm/drafts";
import { DraftRuntimeError } from "@gitpm/drafts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type { RequestActor } from "./draft-api.js";

const apps: ReturnType<typeof buildApp>[] = [];
const metadata: DraftMetadata = {
  version: 1,
  draft_id: "DRF-API",
  owner_gitlab_user_id: "42",
  branch: "gitpm/42/DRF-API",
  base_commit: "a".repeat(40),
  worktree_path: "C:/secret/server/worktree",
  writer_mode: "ui",
  state: "open",
  fingerprint: "b".repeat(64),
  created_at: "2026-07-10T00:00:00.000Z",
  updated_at: "2026-07-10T00:00:00.000Z",
};

function manager(overrides: Partial<DraftManager> = {}): DraftManager {
  return {
    createDraft: vi.fn(async () => metadata),
    poll: vi.fn(async () => ({ metadata, currentFingerprint: metadata.fingerprint, changedExternally: false })),
    setWriterMode: vi.fn(async () => ({ ...metadata, writer_mode: "external" })),
    closeDraft: vi.fn(async () => ({ ...metadata, state: "closed" })),
    reopenDraft: vi.fn(async () => metadata),
    cleanupDraft: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as DraftManager;
}

function appFor(actor: RequestActor, draftManager = manager()) {
  const app = buildApp({ authenticate: () => actor, draftManager });
  apps.push(app);
  return app;
}

afterEach(async () => Promise.all(apps.splice(0).map(async (app) => app.close())));

describe("draft lifecycle API", () => {
  it("creates a draft without exposing an absolute worktree path", async () => {
    const app = appFor({ userId: "42", role: "Developer" });
    const response = await app.inject({ method: "POST", url: "/api/drafts", payload: { draft_id: "DRF-API" } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ draft_id: "DRF-API", branch: "gitpm/42/DRF-API" });
    expect(response.body).not.toContain("secret/server/worktree");
  });

  it("rejects mutation for a read-only role with a stable error", async () => {
    const app = appFor({ userId: "42", role: "Reporter" });
    const response = await app.inject({
      headers: { "x-correlation-id": "api-role-test" },
      method: "POST",
      url: "/api/drafts",
      payload: { draft_id: "DRF-API" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: "DRAFT_FORBIDDEN", message: "Project role is read-only", correlation_id: "api-role-test" },
    });
  });

  it("maps runtime conflicts to HTTP 409", async () => {
    const draftManager = manager({
      setWriterMode: vi.fn(async () => { throw new DraftRuntimeError("DRAFT_CHANGED_EXTERNALLY", "changed"); }),
    });
    const app = appFor({ userId: "42", role: "Developer" }, draftManager);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/drafts/DRF-API/writer-mode",
      payload: { writer_mode: "external" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "DRAFT_CHANGED_EXTERNALLY" } });
  });

  it("enforces the static request body limit without quota state", async () => {
    const app = appFor({ userId: "42", role: "Developer" });
    const response = await app.inject({
      method: "POST",
      url: "/api/drafts",
      payload: { draft_id: "x".repeat(1_100_000) },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: "REQUEST_TOO_LARGE" } });
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
  });
});
