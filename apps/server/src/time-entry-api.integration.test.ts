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
  const app = buildApp({
    authenticate: () => ({ userId: "42", role: "Maintainer" }),
    draftManager: manager,
    entityStore: new EntityStore(manager),
    timeEntryStore: new TimeEntryStore(manager),
  });
  apps.push(app);
  return { app, manager };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("time entry API integration", () => {
  it("lists the fixture entry, creates, voids and rejects invalid entries", async () => {
    const { app, manager } = await runtime();
    const draft = await manager.createDraft("DRF-TIME", "42");
    const project = "P-26-MGP84K";
    const task = "T-26-P9G3P8";

    const initial = await app.inject({ method: "GET", url: `/api/drafts/DRF-TIME/projects/${project}/tasks/${task}/time-entries` });
    expect(initial.statusCode).toBe(200);
    const initialEntries = (JSON.parse(initial.body) as readonly { readonly document: { readonly id: string } }[]).map((entry) => entry.document.id);
    expect(initialEntries).toContain("E-26-AAAAAA");

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

    const voided = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-TIME/projects/${project}/tasks/${task}/time-entries/${createdBody.document.id}/void`,
      payload: { expected_fingerprint: fingerprint, expected_blob_id: createdBody.blob_id },
    });
    expect(voided.statusCode).toBe(200);
    const voidedBody = JSON.parse(voided.body) as { readonly document: { readonly state: string }; readonly draft_fingerprint: string };
    expect(voidedBody.document.state).toBe("voided");
    fingerprint = voidedBody.draft_fingerprint;

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
  }, 120_000);
});
