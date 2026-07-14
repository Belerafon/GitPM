import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DraftManager } from "@gitpm/drafts";
import { EntityStore } from "@gitpm/domain";
import { GitClient } from "@gitpm/git-client";
import type { GitPmDocument } from "@gitpm/repository-format";
import { buildApp } from "./app.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];
const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");

interface ApiEntityResult {
  readonly document: GitPmDocument;
  readonly path: string;
  readonly blob_id: string;
  readonly draft_fingerprint: string;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function runtime() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-domain-api-"));
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
  const store = new EntityStore(manager);
  const app = buildApp({
    authenticate: () => ({ userId: "42", role: "Maintainer" }),
    draftManager: manager,
    entityStore: store,
  });
  apps.push(app);
  return { app, client, manager };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("domain API integration", () => {
  it("creates and updates all editable types, archives, deletes and restricts references", async () => {
    const { app, client, manager } = await runtime();
    const draft = await manager.createDraft("DRF-HTTP", "42");
    let fingerprint = draft.fingerprint;
    const entities: Array<{ type: string; document: GitPmDocument }> = [
      { type: "calendars", document: { schema: "gitpm/calendar@1", id: "C-26-7GQW87", name: "HTTP calendar", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" } },
      { type: "people", document: { schema: "gitpm/person@1", id: "U-26-KB9RXB", name: "HTTP person", weekly_capacity_hours: 40, calendar: "C-26-7GQW87", lifecycle: "active" } },
      { type: "teams", document: { schema: "gitpm/team@1", id: "G-26-22K88P", name: "HTTP team", members: ["U-26-KB9RXB"], lifecycle: "active" } },
      { type: "projects", document: { schema: "gitpm/project@1", id: "P-26-Y9S1D8", name: "HTTP project", status: "backlog", lifecycle: "active" } },
      { type: "milestones", document: { schema: "gitpm/milestone@1", id: "M-26-KK4VXH", project: "P-26-Y9S1D8", name: "HTTP milestone", lifecycle: "active" } },
      { type: "tasks", document: { schema: "gitpm/task@1", id: "T-26-FM5Q4W", project: "P-26-Y9S1D8", title: "HTTP task", type: "task", status: "backlog", lifecycle: "active" } },
      { type: "views", document: { schema: "gitpm/saved-view@1", id: "V-26-B0C5A1", project: "P-26-Y9S1D8", name: "HTTP view", kind: "list", filters: {}, lifecycle: "active" } },
    ];
    const current = new Map<string, ApiEntityResult>();
    for (const entity of entities) {
      const response = await app.inject({
        method: "POST",
        url: `/api/drafts/DRF-HTTP/entities/${entity.type}`,
        payload: { expected_fingerprint: fingerprint, document: entity.document },
      });
      expect(response.statusCode).toBe(201);
      const result = response.json<ApiEntityResult>();
      current.set(entity.type, result);
      fingerprint = result.draft_fingerprint;
    }

    for (const entity of entities) {
      const previous = current.get(entity.type)!;
      const key = entity.type === "tasks" ? "title" : "name";
      const document = { ...previous.document, [key]: `${String(previous.document[key])} updated` };
      const response = await app.inject({
        method: "PUT",
        url: `/api/drafts/DRF-HTTP/entities/${entity.type}/${String(document.id)}`,
        payload: { expected_fingerprint: fingerprint, expected_blob_id: previous.blob_id, document },
      });
      expect(response.statusCode).toBe(200);
      const result = response.json<ApiEntityResult>();
      current.set(entity.type, result);
      fingerprint = result.draft_fingerprint;
    }

    const task = current.get("tasks")!;
    const archivedResponse = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-HTTP/entities/tasks/${String(task.document.id)}/archive`,
      payload: { expected_fingerprint: fingerprint, expected_blob_id: task.blob_id },
    });
    expect(archivedResponse.statusCode).toBe(200);
    const archived = archivedResponse.json<ApiEntityResult>();
    expect(archived.document.lifecycle).toBe("archived");
    fingerprint = archived.draft_fingerprint;

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/drafts/DRF-HTTP/entities/tasks/${String(task.document.id)}`,
      payload: { expected_fingerprint: fingerprint, expected_blob_id: archived.blob_id },
    });
    expect(deleteResponse.statusCode).toBe(200);
    fingerprint = deleteResponse.json<{ draft_fingerprint: string }>().draft_fingerprint;

    const person = current.get("people")!;
    const restricted = await app.inject({
      method: "DELETE",
      url: `/api/drafts/DRF-HTTP/entities/people/${String(person.document.id)}`,
      payload: { expected_fingerprint: fingerprint, expected_blob_id: person.blob_id },
    });
    expect(restricted.statusCode).toBe(409);
    expect(restricted.json()).toMatchObject({ error: { code: "DELETE_RESTRICTED" } });

    const changed = await client.statusPorcelain(draft.worktree_path);
    const expectedPaths = [
      "calendars/C-26-7GQW87.yaml",
      "people/U-26-KB9RXB.yaml",
      "teams/G-26-22K88P.yaml",
      "projects/P-26-Y9S1D8/project.yaml",
      "projects/P-26-Y9S1D8/milestones/M-26-KK4VXH.yaml",
      "projects/P-26-Y9S1D8/views/V-26-B0C5A1.yaml",
    ];
    for (const expected of expectedPaths) expect(changed).toContain(expected);
    expect(changed).not.toContain("T-26-FM5Q4W.yaml");
  }, 60_000);
});
