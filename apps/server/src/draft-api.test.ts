import type { DraftManager, DraftMetadata } from "@gitpm/drafts";
import { DraftRuntimeError } from "@gitpm/drafts";
import type { EntityStore } from "@gitpm/domain";
import { DomainOperationError } from "@gitpm/domain";
import type { ChangesService } from "@gitpm/changes";
import { ChangesError } from "@gitpm/changes";
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
    listDrafts: vi.fn(async () => [metadata]),
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

  it("lists only drafts visible to the current user", async () => {
    const other = { ...metadata, draft_id: "DRF-OTHER", owner_gitlab_user_id: "99" };
    const draftManager = manager({ listDrafts: vi.fn(async () => [metadata, other]) });
    const app = appFor({ userId: "42", role: "Developer" }, draftManager);
    const response = await app.inject({ method: "GET", url: "/api/drafts" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([expect.objectContaining({ draft_id: "DRF-API" })]);
    expect(response.body).not.toContain("worktree");
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
  it("denies administrative entity mutation to Developer", async () => {
    const entityStore = { create: vi.fn() } as unknown as EntityStore;
    const app = buildApp({ authenticate: () => ({ userId: "42", role: "Developer" }), draftManager: manager(), entityStore });
    apps.push(app);
    const response = await app.inject({
      method: "POST", url: "/api/drafts/DRF-API/entities/people",
      payload: { expected_fingerprint: metadata.fingerprint, document: { schema: "gitpm/person@1", id: "U-26-5EBAE3", name: "Denied", weekly_capacity_hours: 40, calendar: "C-26-QD7FJ4", lifecycle: "active" } },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "DRAFT_FORBIDDEN", message: "Administrative mutation requires Maintainer" } });
    expect(entityStore.create).not.toHaveBeenCalled();
  });

  it("lists entities through an owner-checked read model", async () => {
    const entityStore = {
      list: vi.fn(async () => [{ document: { schema: "gitpm/project@1", id: "P-26-MGP84K" }, path: "projects/P-26-MGP84K/project.yaml", blob_id: "a".repeat(40), draft_fingerprint: metadata.fingerprint }]),
    } as unknown as EntityStore;
    const app = buildApp({ authenticate: () => ({ userId: "42", role: "Developer" }), draftManager: manager(), entityStore });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/drafts/DRF-API/entities/projects" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    expect(entityStore.list).toHaveBeenCalledWith("DRF-API", "projects", undefined);
  });

  it("creates an entity through the domain store", async () => {
    const entityStore = {
      create: vi.fn(async () => ({
        document: { schema: "gitpm/project@1", id: "P-26-MGP84K" },
        path: "projects/P-26-MGP84K/project.yaml",
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
        document: { schema: "gitpm/project@1", id: "P-26-MGP84K" },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ path: "projects/P-26-MGP84K/project.yaml" });
  });

  it("maps delete restrict to a stable conflict response", async () => {
    const entityStore = {
      delete: vi.fn(async () => { throw new DomainOperationError("DELETE_RESTRICTED", "referenced"); }),
    } as unknown as EntityStore;
    const app = buildApp({
      authenticate: () => ({ userId: "42", role: "Maintainer" }),
      draftManager: manager(),
      entityStore,
    });
    apps.push(app);
    const response = await app.inject({
      method: "DELETE",
      url: "/api/drafts/DRF-API/entities/people/U-26-5EBAE3",
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

describe("changes API contract", () => {
  it("returns change summaries and maps stale hunk tokens", async () => {
    const changesService = {
      list: vi.fn(async () => ({ files: [], changed_files_count: 0, affected_projects: [] })),
      semantic: vi.fn(async () => ({ created: [], updated: [], archived: [], deleted: [], counts: { created: 0, updated: 0, archived: 0, deleted: 0 }, affected_projects: [], unclassified_files: [] })),
      restoreHunk: vi.fn(async () => { throw new ChangesError("STALE_DIFF", "stale"); }),
    } as unknown as ChangesService;
    const app = buildApp({
      authenticate: () => ({ userId: "42", role: "Developer" }),
      changesService,
      draftManager: manager(),
    });
    apps.push(app);
    const listed = await app.inject({ method: "GET", url: "/api/drafts/DRF-API/changes" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ changed_files_count: 0 });
    const semantic = await app.inject({ method: "GET", url: "/api/drafts/DRF-API/changes/semantic" });
    expect(semantic.statusCode).toBe(200);
    expect(semantic.json()).toMatchObject({ counts: { created: 0, updated: 0, archived: 0, deleted: 0 } });
    const stale = await app.inject({
      method: "POST",
      url: "/api/drafts/DRF-API/changes/restore-hunk",
      payload: { expected_fingerprint: metadata.fingerprint, path: "project.yaml", diff_token: "old", hunk_index: 0 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "STALE_DIFF" } });
  });
});
