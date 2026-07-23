import { expect, test } from "@playwright/test";
import {
  E2E_TASK_ID,
  FIXTURE_PROJECT_ID,
  cleanupDrafts,
  createDraft,
  taskDocument,
  type EntityResult,
} from "./helpers.js";

test.describe("GitPM API through the Vite proxy", () => {
  test.beforeEach(async ({ request }) => await cleanupDrafts(request, "DRF-API-"));
  test.afterEach(async ({ request }) => await cleanupDrafts(request, "DRF-API-"));

  test("returns the isolated repository session and security headers", async ({ request }) => {
    const response = await request.get("/api/auth/session");
    expect(response.status()).toBe(200);
    await expect.poll(() => response.headers()["x-correlation-id"]).toBeTruthy();
    expect(response.headers()["content-security-policy"]).toContain("default-src 'self'");
    expect(await response.json()).toMatchObject({
      user: { id: "local-user" },
      role: "Maintainer",
      mode: "repository",
      repository: { name: "source", has_remote: false },
    });
  });

  test("creates a draft from the fixture and validates it", async ({ request }) => {
    await createDraft(request, "DRF-API-VALID");
    const validation = await request.get("/api/drafts/DRF-API-VALID/validation");
    expect(validation.status()).toBe(200);
    expect(await validation.json()).toMatchObject({ valid: true, error_count: 0 });

    const projects = await request.get("/api/drafts/DRF-API-VALID/entities/projects");
    expect(projects.status()).toBe(200);
    expect(await projects.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ document: expect.objectContaining({ id: FIXTURE_PROJECT_ID, name: "GitPM launch" }) }),
    ]));
  });

  test("rejects duplicate and malformed draft IDs with stable errors", async ({ request }) => {
    await createDraft(request, "DRF-API-DUPLICATE");
    const duplicate = await request.post("/api/drafts", { data: { draft_id: "DRF-API-DUPLICATE" } });
    expect(duplicate.status()).toBe(409);
    expect(await duplicate.json()).toMatchObject({ error: { code: "DRAFT_EXISTS" } });

    const malformed = await request.post("/api/drafts", { data: { draft_id: "../escape" } });
    expect(malformed.status()).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: "DRAFT_IDENTITY_INVALID" } });
  });

  test("returns a stable not-found error for an unknown draft", async ({ request }) => {
    const response = await request.get("/api/drafts/DRF-DOES-NOT-EXIST");
    expect(response.status()).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "DRAFT_NOT_FOUND" } });
  });

  test("blocks cross-site mutations before they reach the draft API", async ({ request }) => {
    const response = await request.post("/api/drafts", {
      data: { draft_id: "DRF-CSRF" },
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "CSRF_ORIGIN_FORBIDDEN" } });
  });

  test("enforces the static request body limit", async ({ request }) => {
    const response = await request.post("http://127.0.0.1:3100/api/drafts", {
      data: { draft_id: "A".repeat(1_100_000) },
    });
    expect(response.status()).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "REQUEST_TOO_LARGE" } });
    expect((await request.get("/api/auth/session")).status()).toBe(200);
  });

  test("creates a task, exposes semantic changes and discards them", async ({ request }) => {
    const draft = await createDraft(request, "DRF-API-CHANGES");
    const createdResponse = await request.post("/api/drafts/DRF-API-CHANGES/entities/tasks", {
      data: { expected_fingerprint: draft.fingerprint, document: taskDocument() },
    });
    expect(createdResponse.status(), await createdResponse.text()).toBe(201);
    const created = await createdResponse.json() as EntityResult;

    const changes = await request.get("/api/drafts/DRF-API-CHANGES/changes");
    expect(await changes.json()).toMatchObject({ changed_files_count: 1 });
    const semantic = await request.get("/api/drafts/DRF-API-CHANGES/changes/semantic");
    expect(await semantic.json()).toMatchObject({
      counts: { created: 1, updated: 0, archived: 0, deleted: 0 },
      created: [expect.objectContaining({ id: E2E_TASK_ID, project: FIXTURE_PROJECT_ID })],
    });

    const discarded = await request.post("/api/drafts/DRF-API-CHANGES/changes/discard-all", {
      data: { expected_fingerprint: created.draft_fingerprint },
    });
    expect(discarded.status(), await discarded.text()).toBe(200);
    const clean = await request.get("/api/drafts/DRF-API-CHANGES/changes");
    expect(await clean.json()).toMatchObject({ changed_files_count: 0 });
  });

  test("commits locally without GitLab and requires login only for push", async ({ request }) => {
    const draft = await createDraft(request, "DRF-API-LOCAL-COMMIT");
    const created = await request.post("/api/drafts/DRF-API-LOCAL-COMMIT/entities/tasks", {
      data: { expected_fingerprint: draft.fingerprint, document: taskDocument() },
    });
    expect(created.status(), await created.text()).toBe(201);

    const committed = await request.post("/api/drafts/DRF-API-LOCAL-COMMIT/commit", {
      data: { message: "Commit without GitLab login" },
    });
    expect(committed.status(), await committed.text()).toBe(200);
    expect(await committed.json()).toMatchObject({ branch: "gitpm/local-user/DRF-API-LOCAL-COMMIT" });
    expect(await (await request.get("/api/drafts/DRF-API-LOCAL-COMMIT/changes")).json()).toMatchObject({ changed_files_count: 0 });

    const push = await request.post("/api/drafts/DRF-API-LOCAL-COMMIT/push");
    expect(push.status()).toBe(401);
    expect(await push.json()).toMatchObject({ error: { code: "SESSION_INVALID" } });
  });

  test("archives and physically deletes a newly created task", async ({ request }) => {
    const draft = await createDraft(request, "DRF-API-DELETE");
    const createdResponse = await request.post("/api/drafts/DRF-API-DELETE/entities/tasks", {
      data: { expected_fingerprint: draft.fingerprint, document: taskDocument() },
    });
    const created = await createdResponse.json() as EntityResult;
    const archivedResponse = await request.post(`/api/drafts/DRF-API-DELETE/entities/tasks/${E2E_TASK_ID}/archive`, {
      data: { expected_fingerprint: created.draft_fingerprint, expected_blob_id: created.blob_id },
    });
    expect(archivedResponse.status(), await archivedResponse.text()).toBe(200);
    const archived = await archivedResponse.json() as EntityResult;
    expect(archived.document.lifecycle).toBe("archived");

    const deleted = await request.delete(`/api/drafts/DRF-API-DELETE/entities/tasks/${E2E_TASK_ID}`, {
      data: { expected_fingerprint: archived.draft_fingerprint, expected_blob_id: archived.blob_id },
    });
    expect(deleted.status(), await deleted.text()).toBe(200);
    const tasks = await request.get(`/api/drafts/DRF-API-DELETE/entities/tasks?project=${FIXTURE_PROJECT_ID}`);
    expect((await tasks.json() as EntityResult[]).some((item) => item.document.id === E2E_TASK_ID)).toBe(false);
  });

  test("rejects stale fingerprints and external writer mutations", async ({ request }) => {
    const draft = await createDraft(request, "DRF-API-CONCURRENCY");
    const stale = await request.post("/api/drafts/DRF-API-CONCURRENCY/entities/tasks", {
      data: { expected_fingerprint: "stale", document: taskDocument() },
    });
    expect(stale.status()).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "DRAFT_CHANGED_EXTERNALLY" } });

    const mode = await request.patch("/api/drafts/DRF-API-CONCURRENCY/writer-mode", {
      data: { writer_mode: "external" },
    });
    expect(mode.status()).toBe(200);
    const readOnly = await request.post("/api/drafts/DRF-API-CONCURRENCY/entities/tasks", {
      data: { expected_fingerprint: draft.fingerprint, document: taskDocument() },
    });
    expect(readOnly.status()).toBe(409);
    expect(await readOnly.json()).toMatchObject({ error: { code: "DRAFT_READ_ONLY" } });
  });

  test("serves repository configuration and Git history", async ({ request }) => {
    await createDraft(request, "DRF-API-HISTORY");
    for (const kind of ["statuses", "issue-types"] as const) {
      const configuration = await request.get(`/api/drafts/DRF-API-HISTORY/config/${kind}`);
      expect(configuration.status(), await configuration.text()).toBe(200);
      expect(await configuration.json()).toMatchObject({
        document: { schema: kind === "statuses" ? "gitpm/statuses@1" : "gitpm/issue-types@1" },
      });
    }

    const historyResponse = await request.get("/api/drafts/DRF-API-HISTORY/history");
    expect(historyResponse.status()).toBe(200);
    const history = await historyResponse.json() as Array<{ commit: string }>;
    expect(history).toHaveLength(1);
    expect(history[0]!.commit).toMatch(/^[0-9a-f]{40}$/u);

    const detail = await request.get(`/api/drafts/DRF-API-HISTORY/history/${history[0]!.commit}`);
    expect(detail.status(), await detail.text()).toBe(200);
    expect(await detail.json()).toMatchObject({ subject: "Initialize E2E fixture" });

    const fileHistory = await request.get(
      `/api/drafts/DRF-API-HISTORY/file-history?path=${encodeURIComponent(`projects/${FIXTURE_PROJECT_ID}/project.yaml`)}`,
    );
    expect(fileHistory.status(), await fileHistory.text()).toBe(200);
    expect(await fileHistory.json()).toHaveLength(1);
  });
});
