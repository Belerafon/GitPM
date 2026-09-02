import type { DraftManager, DraftMetadata } from "@gitpm/drafts";
import { DraftRuntimeError } from "@gitpm/drafts";
import type { CommentStore, EntityStore } from "@gitpm/domain";
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

  it("does not let a Maintainer read another user's draft", async () => {
    const other = { ...metadata, draft_id: "DRF-OTHER", owner_gitlab_user_id: "99" };
    const draftManager = manager({
      listDrafts: vi.fn(async () => [metadata, other]),
      poll: vi.fn(async () => ({
        metadata: other,
        currentFingerprint: other.fingerprint,
        changedExternally: false,
      })),
    });
    const app = appFor({ userId: "42", role: "Maintainer" }, draftManager);

    const listed = await app.inject({ method: "GET", url: "/api/drafts" });
    expect(listed.json()).toEqual([expect.objectContaining({ draft_id: "DRF-API" })]);
    const read = await app.inject({ method: "GET", url: "/api/drafts/DRF-OTHER" });
    expect(read.statusCode).toBe(403);
    expect(read.json()).toMatchObject({ error: { code: "DRAFT_FORBIDDEN" } });
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
      list: vi.fn(async () => [{ document: { schema: "gitpm/project@2", id: "P-26-MGP84K" }, path: "projects/P-26-MGP84K/project.yaml", blob_id: "a".repeat(40), draft_fingerprint: metadata.fingerprint }]),
    } as unknown as EntityStore;
    const app = buildApp({ authenticate: () => ({ userId: "42", role: "Developer" }), draftManager: manager(), entityStore });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/drafts/DRF-API/entities/projects" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    expect(entityStore.list).toHaveBeenCalledWith("DRF-API", "projects", undefined);
  });

  it("returns one project workspace through the scoped read model", async () => {
    const project = { document: { schema: "gitpm/project@2", id: "P-26-MGP84K" }, path: "projects/P-26-MGP84K/project.yaml", blob_id: "a".repeat(40), draft_fingerprint: metadata.fingerprint };
    const entityStore = {
      projectWorkspace: vi.fn(async () => ({ project, milestones: [], tasks: [], draft_fingerprint: metadata.fingerprint })),
    } as unknown as EntityStore;
    const app = buildApp({ authenticate: () => ({ userId: "42", role: "Developer" }), draftManager: manager(), entityStore });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/drafts/DRF-API/projects/P-26-MGP84K/workspace" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ project: { document: { id: "P-26-MGP84K" } }, milestones: [], tasks: [] });
    expect(entityStore.projectWorkspace).toHaveBeenCalledWith("DRF-API", "P-26-MGP84K");
  });

  it("returns the repository configuration needed for canonical person creation", async () => {
    const repository = { document: { schema: "gitpm/repository@1", default_branch: "main", default_calendar: "C-26-QD7FJ4", allowed_top_level_files: ["README.md"], ui_poll_interval_seconds: 5 }, path: ".gitpm/repository.yaml", blob_id: "a".repeat(40), draft_fingerprint: metadata.fingerprint };
    const entityStore = { getRepositoryConfiguration: vi.fn(async () => repository) } as unknown as EntityStore;
    const app = buildApp({ authenticate: () => ({ userId: "42", role: "Developer" }), draftManager: manager(), entityStore });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/drafts/DRF-API/config/repository" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ document: { default_calendar: "C-26-QD7FJ4" } });
    expect(entityStore.getRepositoryConfiguration).toHaveBeenCalledWith("DRF-API");
  });

  it("returns the employee display format without calculating repository blob metadata", async () => {
    const entityStore = { getRepositoryDocument: vi.fn(async () => ({ schema: "gitpm/repository@1", default_person_name_format: "family-initials" })) } as unknown as EntityStore;
    const app = buildApp({ authenticate: () => ({ userId: "42", role: "Developer" }), draftManager: manager(), entityStore });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/drafts/DRF-API/person-name-format" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ format: "family-initials" });
    expect(entityStore.getRepositoryDocument).toHaveBeenCalledWith("DRF-API");
  });

  it("updates repository configuration through the Maintainer-only route", async () => {
    const document = { schema: "gitpm/repository@1" as const, default_branch: "main", default_calendar: "C-26-QD7FJ4", allowed_top_level_files: ["README.md"], ui_poll_interval_seconds: 7 };
    const repository = { document, path: ".gitpm/repository.yaml", blob_id: "b".repeat(40), draft_fingerprint: "c".repeat(64) };
    const entityStore = { updateRepositoryConfiguration: vi.fn(async () => repository) } as unknown as EntityStore;
    const app = buildApp({ authenticate: () => ({ userId: "42", role: "Maintainer" }), draftManager: manager(), entityStore });
    apps.push(app);
    const response = await app.inject({
      method: "PUT",
      url: "/api/drafts/DRF-API/config/repository",
      payload: { expected_fingerprint: metadata.fingerprint, expected_blob_id: "a".repeat(40), document },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ document: { ui_poll_interval_seconds: 7 } });
    expect(entityStore.updateRepositoryConfiguration).toHaveBeenCalledWith("DRF-API", "42", metadata.fingerprint, "a".repeat(40), document);
  });

  it("returns concrete configuration impact without mutating the draft", async () => {
    const document = { schema: "gitpm/statuses@2" as const, statuses: [{ slug: "backlog", title: "Backlog", color: "gray", active: true, category: "backlog" }] };
    const impact = { blocking: true, issues: [{ code: "CONFIG_REFERENCE", path: "projects/P-26-MGP84K/project.yaml", field: "status", message: "Status in-progress is still in use" }] };
    const entityStore = { getConfigurationImpact: vi.fn(async () => impact) } as unknown as EntityStore;
    const app = buildApp({ authenticate: () => ({ userId: "42", role: "Developer" }), draftManager: manager(), entityStore });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/drafts/DRF-API/config/statuses/impact", payload: { document } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(impact);
    expect(entityStore.getConfigurationImpact).toHaveBeenCalledWith("DRF-API", "statuses", document);
  });

  it("creates an entity through the domain store", async () => {
    const entityStore = {
      create: vi.fn(async () => ({
        document: { schema: "gitpm/project@2", id: "P-26-MGP84K", name: "Project", status: "active", lifecycle: "active" },
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
        document: { schema: "gitpm/project@2", id: "P-26-MGP84K", name: "Project", status: "active", lifecycle: "active" },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ path: "projects/P-26-MGP84K/project.yaml" });
  });

  it("rejects malformed entity bodies before calling the domain store", async () => {
    const create = vi.fn();
    const app = buildApp({
      authenticate: () => ({ userId: "42", role: "Developer" }),
      draftManager: manager(),
      entityStore: { create } as unknown as EntityStore,
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/drafts/DRF-API/entities/projects",
      payload: {
        expected_fingerprint: metadata.fingerprint,
        document: { schema: "gitpm/project@2", id: "P-26-MGP84K" },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "REQUEST_CONTRACT_INVALID" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("maps delete restrict to a stable conflict response", async () => {
    const entityStore = {
      delete: vi.fn(async () => { throw new DomainOperationError("DELETE_RESTRICTED", "referenced", [{ path: "teams/G-26-CORE.yaml", label: "Core" }]); }),
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
    expect(response.json()).toMatchObject({ error: { code: "DELETE_RESTRICTED", details: [{ path: "teams/G-26-CORE.yaml", label: "Core" }] } });
  });

  it("forwards explicit reference unlink confirmation to person deletion", async () => {
    const deleteEntity = vi.fn(async () => ({ deleted: true, path: "people/U-26-5EBAE3.yaml", unlinked_paths: ["teams/G-26-CORE.yaml"], draft_fingerprint: metadata.fingerprint }));
    const app = buildApp({
      authenticate: () => ({ userId: "42", role: "Maintainer" }),
      draftManager: manager(),
      entityStore: { delete: deleteEntity } as unknown as EntityStore,
    });
    apps.push(app);
    const response = await app.inject({
      method: "DELETE",
      url: "/api/drafts/DRF-API/entities/people/U-26-5EBAE3",
      payload: { expected_fingerprint: metadata.fingerprint, expected_blob_id: "a".repeat(40), unlink_references: true },
    });
    expect(response.statusCode).toBe(200);
    expect(deleteEntity).toHaveBeenCalledWith("DRF-API", "42", "people", "U-26-5EBAE3", metadata.fingerprint, "a".repeat(40), true, false);
  });

  it("forwards explicit reference cascade confirmation to project deletion", async () => {
    const deleteEntity = vi.fn(async () => ({ deleted: true, path: "projects/P-26-MGP84K/project.yaml", unlinked_paths: [], cascaded_paths: ["projects/P-26-MGP84K/tasks/T-26-P9G3P8.yaml"], draft_fingerprint: metadata.fingerprint }));
    const app = buildApp({
      authenticate: () => ({ userId: "42", role: "Maintainer" }),
      draftManager: manager(),
      entityStore: { delete: deleteEntity } as unknown as EntityStore,
    });
    apps.push(app);
    const response = await app.inject({
      method: "DELETE",
      url: "/api/drafts/DRF-API/entities/projects/P-26-MGP84K",
      payload: { expected_fingerprint: metadata.fingerprint, expected_blob_id: "a".repeat(40), cascade_references: true },
    });
    expect(response.statusCode).toBe(200);
    expect(deleteEntity).toHaveBeenCalledWith("DRF-API", "42", "projects", "P-26-MGP84K", metadata.fingerprint, "a".repeat(40), false, true);
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
        document: { schema: "gitpm/statuses@2", statuses: [{ slug: "backlog", title: "Backlog", color: "gray", active: true, category: "backlog" }] },
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "DRAFT_FORBIDDEN" } });
    expect(entityStore.updateConfiguration).not.toHaveBeenCalled();
  });
});

describe("comment API contract", () => {
  it("derives the author on the server and forwards stable mention notifications", async () => {
    const created = {
      document: { schema: "gitpm/comment@1", id: "N-26-ABC123", project: "P-26-MGP84K", task: "T-26-P9G3P8", author: { provider: "git", subject: "anna@example.test", display_name: "Anna" }, created_at: "2026-07-20T10:00:00.000Z", state: "active", body_markdown: "Hello", mentions: [] },
      path: "projects/P-26-MGP84K/comments/T-26-P9G3P8/N-26-ABC123.yaml", blob_id: "c".repeat(40), draft_fingerprint: metadata.fingerprint, can_edit: true, can_delete: true,
    };
    const notification = {
      key: "N-26-ABC123:2026-07-20T10:05:00.000Z",
      person_id: "U-26-5EBAE3",
      mentioned_at: "2026-07-20T10:05:00.000Z",
      project_id: "P-26-MGP84K",
      task_id: "T-26-P9G3P8",
      task_title: "Approve schema v1",
      comment_id: "N-26-ABC123",
      author: { provider: "git" as const, subject: "boris@example.test", display_name: "Boris" },
      excerpt: "Please review @Anna Petrova",
    };
    const commentStore = {
      create: vi.fn(async () => created),
      notifications: vi.fn(async () => ({ recipient_person_id: "U-26-5EBAE3", items: [notification] })),
    } as unknown as CommentStore;
    const app = buildApp({
      authenticate: () => ({ userId: "42", role: "Developer", provider: "git", displayName: "Anna", email: "ANNA@example.test" }),
      commentStore,
      draftManager: manager(),
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/drafts/DRF-API/projects/P-26-MGP84K/tasks/T-26-P9G3P8/comments",
      payload: { expected_fingerprint: metadata.fingerprint, body_markdown: "Hello", author: { subject: "spoofed" } },
    });
    expect(response.statusCode).toBe(201);
    expect(commentStore.create).toHaveBeenCalledWith("DRF-API", "P-26-MGP84K", "T-26-P9G3P8", metadata.fingerprint, "Hello", expect.objectContaining({
      userId: "42",
      identity: { provider: "git", subject: "anna@example.test", display_name: "Anna" },
      email: "ANNA@example.test",
    }));

    const notifications = await app.inject({ method: "GET", url: "/api/drafts/DRF-API/notifications" });
    expect(notifications.statusCode).toBe(200);
    expect(notifications.json()).toMatchObject({ recipient_person_id: "U-26-5EBAE3", items: [{ key: notification.key, read: false }] });

    const marked = await app.inject({
      method: "POST",
      url: "/api/drafts/DRF-API/notifications/read",
      payload: { keys: [notification.key, "not-visible"] },
    });
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toMatchObject({ items: [{ key: notification.key, read: true }] });
    expect((await app.inject({ method: "GET", url: "/api/drafts/DRF-API/notifications" })).json()).toMatchObject({ items: [{ key: notification.key, read: true }] });
  });
});

describe("changes API contract", () => {
  it("returns change summaries and maps stale hunk tokens", async () => {
    const changesService = {
      list: vi.fn(async () => ({ files: [], changed_files_count: 0, affected_projects: [], project_files: [] })),
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
    expect(listed.json()).toMatchObject({ changed_files_count: 0, project_files: [] });
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
