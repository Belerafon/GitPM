import type { DraftManager, DraftMetadata } from "@gitpm/drafts";
import { DraftRuntimeError } from "@gitpm/drafts";
import type { EntityStore } from "@gitpm/domain";
import { DomainOperationError } from "@gitpm/domain";
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
    getDraft: vi.fn(async () => metadata),
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

describe("entity API contract", () => {
  it("creates an entity through the domain store", async () => {
    const entityStore = {
      create: vi.fn(async () => ({
        document: { schema: "gitpm/project@1", id: "PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYP" },
        path: "projects/PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYP/project.yaml",
        blob_id: "a".repeat(40),
        draft_fingerprint: "b".repeat(64),
      })),
    } as unknown as EntityStore;
    const app = buildApp({
      authenticate: () => ({ userId: "42", role: "Developer" }),
      draftManager: manager(),
      entityStore,
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/drafts/DRF-API/entities/projects",
      payload: {
        expected_fingerprint: metadata.fingerprint,
        document: { schema: "gitpm/project@1", id: "PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYP" },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ path: "projects/PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYP/project.yaml" });
  });

  it("maps delete restrict to a stable conflict response", async () => {
    const entityStore = {
      delete: vi.fn(async () => { throw new DomainOperationError("DELETE_RESTRICTED", "referenced"); }),
    } as unknown as EntityStore;
    const app = buildApp({
      authenticate: () => ({ userId: "42", role: "Developer" }),
      draftManager: manager(),
      entityStore,
    });
    apps.push(app);
    const response = await app.inject({
      method: "DELETE",
      url: "/api/drafts/DRF-API/entities/people/PER-01J2C01M9QHPMQ2ZK5F7N8S4VA",
      payload: { expected_fingerprint: metadata.fingerprint, expected_blob_id: "a".repeat(40) },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "DELETE_RESTRICTED" } });
  });

  it("reserves repository configuration mutation for Maintainer", async () => {
    const entityStore = { updateConfiguration: vi.fn() } as unknown as EntityStore;
    const app = buildApp({
      authenticate: () => ({ userId: "42", role: "Developer" }),
      draftManager: manager(),
      entityStore,
    });
    apps.push(app);
    const response = await app.inject({
      method: "PUT",
      url: "/api/drafts/DRF-API/config/statuses",
      payload: {
        expected_fingerprint: metadata.fingerprint,
        expected_blob_id: "a".repeat(40),
        document: { schema: "gitpm/statuses@1", statuses: [] },
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "DRAFT_FORBIDDEN" } });
    expect(entityStore.updateConfiguration).not.toHaveBeenCalled();
  });
});
