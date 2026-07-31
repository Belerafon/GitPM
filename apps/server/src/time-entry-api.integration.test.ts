import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DraftManager } from "@gitpm/drafts";
import { EntityStore, TimeEntryStore } from "@gitpm/domain";
import { GitClient } from "@gitpm/git-client";
import { buildApp } from "./app.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];
const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function runtime() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-time-entry-api-"));
  roots.push(root);
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const data = path.join(root, "data");
  await mkdir(source);
  await cp(demo, source, { recursive: true });
  await git(source, "init", "-b", "main");
  await git(source, "add", ".");
  await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "fixture");
  await git(root, "init", "--bare", remote);
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "origin", "main");
  const client = new GitClient({ dataDirectory: data, remoteUrl: remote, defaultBranch: "main", allowLocalTestRemote: true });
  const manager = new DraftManager(client, data);
  const entityStore = new EntityStore(manager);
  const app = buildApp({
    authenticate: () => ({ userId: "42", role: "Maintainer" }),
    draftManager: manager,
    entityStore,
    timeEntryStore: new TimeEntryStore(manager),
  });
  apps.push(app);
  return { app, manager, entityStore };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("time entry API integration", () => {
  it("lists the fixture entry, creates, voids and rejects invalid entries", async () => {
    const { app, manager, entityStore } = await runtime();
    const draft = await manager.createDraft("DRF-TIME", "42");
    const project = "P-26-MGP84K";
    const task = "T-26-P9G3P8";

    const initial = await app.inject({ method: "GET", url: `/api/drafts/DRF-TIME/projects/${project}/tasks/${task}/time-entries` });
    expect(initial.statusCode).toBe(200);
    const initialEntries = (JSON.parse(initial.body) as readonly { readonly document: { readonly id: string } }[]).map((entry) => entry.document.id);
    expect(initialEntries).toContain("E-26-AAAAAA");

    const filtered = await app.inject({ method: "GET", url: `/api/drafts/DRF-TIME/projects/${project}/time-entries?task=${task}&milestone=M-26-461GDJ&person=U-26-5EBAE3&category=warranty&performed_from=2026-08-01&performed_to=2026-08-31&state=active&offset=0&limit=1` });
    expect(filtered.statusCode).toBe(200);
    expect(JSON.parse(filtered.body)).toMatchObject({ total: 1, offset: 0, limit: 1, items: [expect.objectContaining({ document: expect.objectContaining({ id: "E-26-AAAAAA" }) })] });

    let fingerprint = draft.fingerprint;
    const created = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-TIME/projects/${project}/tasks/${task}/time-entries`,
      payload: { expected_fingerprint: fingerprint, person: "U-26-5EBAE3", performed_on: "2026-09-01", hours: 2, category: "regular" },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.body) as { readonly document: { readonly id: string; readonly state: string; readonly hours: number }; readonly draft_fingerprint: string; readonly path: string; readonly blob_id: string };
    expect(createdBody.document.state).toBe("active");
    expect(createdBody.document.hours).toBe(2);
    fingerprint = createdBody.draft_fingerprint;

    const otherTaskEntry = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-TIME/projects/${project}/tasks/T-26-RHBNH8/time-entries`,
      payload: { expected_fingerprint: fingerprint, person: "U-26-5EBAE3", performed_on: "2026-09-01", hours: 1, category: "regular" },
    });
    expect(otherTaskEntry.statusCode).toBe(201);
    const otherTaskEntryBody = JSON.parse(otherTaskEntry.body) as { readonly document: { readonly id: string }; readonly draft_fingerprint: string };
    fingerprint = otherTaskEntryBody.draft_fingerprint;

    const invalidReplacement = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-TIME/projects/${project}/tasks/${task}/time-entries/${createdBody.document.id}/void`,
      payload: { expected_fingerprint: fingerprint, expected_blob_id: createdBody.blob_id, replacement: "E-26-BBBBBB" },
    });
    expect(invalidReplacement.statusCode).toBe(400);
    expect(JSON.parse(invalidReplacement.body)).toMatchObject({ error: { code: "TIME_ENTRY_REPLACEMENT_MISSING" } });

    const crossTaskReplacement = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-TIME/projects/${project}/tasks/${task}/time-entries/${createdBody.document.id}/void`,
      payload: { expected_fingerprint: fingerprint, expected_blob_id: createdBody.blob_id, replacement: otherTaskEntryBody.document.id },
    });
    expect(crossTaskReplacement.statusCode).toBe(400);
    expect(JSON.parse(crossTaskReplacement.body)).toMatchObject({ error: { code: "TIME_ENTRY_REPLACEMENT_TASK_MISMATCH" } });

    const voided = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-TIME/projects/${project}/tasks/${task}/time-entries/${createdBody.document.id}/void`,
      payload: { expected_fingerprint: fingerprint, expected_blob_id: createdBody.blob_id },
    });
    expect(voided.statusCode).toBe(200);
    const voidedBody = JSON.parse(voided.body) as { readonly document: { readonly state: string }; readonly draft_fingerprint: string };
    expect(voidedBody.document.state).toBe("voided");
    fingerprint = voidedBody.draft_fingerprint;

    const voidedOnly = await app.inject({ method: "GET", url: `/api/drafts/DRF-TIME/projects/${project}/time-entries?state=voided` });
    expect(voidedOnly.statusCode).toBe(200);
    expect(JSON.parse(voidedOnly.body)).toMatchObject({ total: 1, items: [expect.objectContaining({ document: expect.objectContaining({ id: createdBody.document.id, state: "voided" }) })] });
    const pagedActive = await app.inject({ method: "GET", url: `/api/drafts/DRF-TIME/projects/${project}/time-entries?state=active&offset=1&limit=1` });
    expect(pagedActive.statusCode).toBe(200);
    expect(JSON.parse(pagedActive.body)).toMatchObject({ total: 2, offset: 1, limit: 1, items: [expect.anything()] });

    const badCategory = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-TIME/projects/${project}/tasks/${task}/time-entries`,
      payload: { expected_fingerprint: fingerprint, person: "U-26-5EBAE3", performed_on: "2026-09-02", hours: 1, category: "ghost" },
    });
    expect(badCategory.statusCode).toBe(422);

    const badHours = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-TIME/projects/${project}/tasks/${task}/time-entries`,
      payload: { expected_fingerprint: fingerprint, person: "U-26-5EBAE3", performed_on: "2026-09-02", hours: 1.1, category: "regular" },
    });
    expect(badHours.statusCode).toBe(422);

    const categories = await entityStore.getConfiguration("DRF-TIME", "work-categories");
    const inactiveCategories = await entityStore.updateConfiguration("DRF-TIME", "42", "work-categories", fingerprint, categories.blob_id, {
      ...categories.document,
      categories: (categories.document.categories as readonly { readonly slug: string; readonly active: boolean }[]).map((category) => category.slug === "regular" ? { ...category, active: false } : category),
    });
    const inactiveCategory = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-TIME/projects/${project}/tasks/${task}/time-entries`,
      payload: { expected_fingerprint: inactiveCategories.draft_fingerprint, person: "U-26-5EBAE3", performed_on: "2026-09-02", hours: 1, category: "regular" },
    });
    expect(inactiveCategory.statusCode).toBe(409);
    expect(JSON.parse(inactiveCategory.body)).toMatchObject({ error: { code: "TIME_ENTRY_CATEGORY_INACTIVE" } });

    const doneTask = await entityStore.get("DRF-TIME", "tasks", task);
    const archived = await entityStore.archive("DRF-TIME", "42", "tasks", task, inactiveCategories.draft_fingerprint, doneTask.blob_id);
    const archivedTask = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-TIME/projects/${project}/tasks/${task}/time-entries`,
      payload: { expected_fingerprint: archived.draft_fingerprint, person: "U-26-5EBAE3", performed_on: "2026-09-03", hours: 1, category: "regular" },
    });
    expect(archivedTask.statusCode).toBe(409);
    expect(JSON.parse(archivedTask.body)).toMatchObject({ error: { code: "TIME_ENTRY_TASK_ARCHIVED" } });
  }, 120_000);
});
