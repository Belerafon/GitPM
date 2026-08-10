import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DraftManager } from "@gitpm/drafts";
import { EntityStore } from "@gitpm/domain";
import { GitClient } from "@gitpm/git-client";
import type { GitPmDocument } from "@gitpm/repository-format";
import { buildApp } from "./app.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];
const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");
let templateRoot: string;
let templateSource: string;
let templateRemote: string;

interface ApiEntityResult {
  readonly document: GitPmDocument;
  readonly path: string;
  readonly blob_id: string;
  readonly draft_fingerprint: string;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

beforeAll(async () => {
  templateRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-domain-api-template-"));
  templateSource = path.join(templateRoot, "source");
  templateRemote = path.join(templateRoot, "remote.git");
  await mkdir(templateSource);
  await cp(demo, templateSource, { recursive: true });
  await git(templateSource, "init", "-b", "main");
  await git(templateSource, "add", ".");
  await git(templateSource, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "fixture");
  await git(templateRoot, "init", "--bare", templateRemote);
  await git(templateSource, "remote", "add", "origin", templateRemote);
  await git(templateSource, "push", "origin", "main");
});

afterAll(async () => rm(templateRoot, { recursive: true, force: true }));

async function runtime() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-domain-api-"));
  roots.push(root);
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const data = path.join(root, "data");
  await Promise.all([
    cp(templateSource, source, { recursive: true }),
    cp(templateRemote, remote, { recursive: true }),
  ]);
  await git(source, "remote", "set-url", "origin", remote);
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
  it("searches the authenticated current draft and validates query bounds", async () => {
    const { app, manager } = await runtime();
    await manager.createDraft("DRF-SEARCH", "42");

    const response = await app.inject({ method: "GET", url: "/api/drafts/DRF-SEARCH/search?q=approve&limit=10" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      query: "approve",
      total: 1,
      items: [{ entity_type: "task", id: "T-26-P9G3P8", title: "Approve schema v1", context: "GitPM launch", project_id: "P-26-MGP84K", lifecycle: "active" }],
    });
    expect((await app.inject({ method: "GET", url: "/api/drafts/DRF-SEARCH/search" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/drafts/DRF-SEARCH/search?q=x&limit=51" })).statusCode).toBe(400);
  }, 120_000);

  it("excludes active Tasks owned by an archived Project from the workload endpoint", async () => {
    const { app, manager } = await runtime();
    const draft = await manager.createDraft("DRF-WORKLOAD-PROJECT", "42");
    const before = await app.inject({ method: "GET", url: "/api/drafts/DRF-WORKLOAD-PROJECT/workload" });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ included_tasks: 1, exclusions: { archived: 0 } });

    const projectResponse = await app.inject({ method: "GET", url: "/api/drafts/DRF-WORKLOAD-PROJECT/entities/projects/P-26-MGP84K" });
    const project = projectResponse.json<ApiEntityResult>();
    const archived = await app.inject({
      method: "POST",
      url: "/api/drafts/DRF-WORKLOAD-PROJECT/entities/projects/P-26-MGP84K/archive",
      payload: { expected_fingerprint: draft.fingerprint, expected_blob_id: project.blob_id },
    });
    expect(archived.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/drafts/DRF-WORKLOAD-PROJECT/workload" });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toMatchObject({ included_tasks: 0, weeks: [], rows: [], exclusions: { archived: 2 } });
  }, 120_000);

  it("returns project references and cascades them only after explicit confirmation", async () => {
    const { app, manager } = await runtime();
    const draft = await manager.createDraft("DRF-PROJECT-CASCADE", "42");
    const projectId = "P-26-8S9HQQ";
    const projectResponse = await app.inject({ method: "GET", url: `/api/drafts/DRF-PROJECT-CASCADE/entities/projects/${projectId}` });
    const project = projectResponse.json<ApiEntityResult>();

    const restricted = await app.inject({
      method: "DELETE",
      url: `/api/drafts/DRF-PROJECT-CASCADE/entities/projects/${projectId}`,
      payload: { expected_fingerprint: draft.fingerprint, expected_blob_id: project.blob_id },
    });
    expect(restricted.statusCode).toBe(409);
    expect(restricted.json()).toMatchObject({
      error: {
        code: "DELETE_RESTRICTED",
        details: [expect.objectContaining({
          path: "projects/P-26-8S9HQQ/tasks/T-26-G2TG9R.yaml",
          label: "Prepare operations",
        })],
      },
    });

    const confirmed = await app.inject({
      method: "DELETE",
      url: `/api/drafts/DRF-PROJECT-CASCADE/entities/projects/${projectId}`,
      payload: { expected_fingerprint: draft.fingerprint, expected_blob_id: project.blob_id, cascade_references: true },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      deleted: true,
      path: `projects/${projectId}/project.yaml`,
      unlinked_paths: [],
      cascaded_paths: ["projects/P-26-8S9HQQ/tasks/T-26-G2TG9R.yaml"],
    });
    expect((await app.inject({ method: "GET", url: `/api/drafts/DRF-PROJECT-CASCADE/entities/projects/${projectId}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/drafts/DRF-PROJECT-CASCADE/entities/projects/P-26-MGP84K" })).statusCode).toBe(200);
  }, 120_000);

  it("creates and updates all editable types, archives, deletes and restricts references", async () => {
    const { app, client, manager } = await runtime();
    const draft = await manager.createDraft("DRF-HTTP", "42");
    let fingerprint = draft.fingerprint;
    const entities: Array<{ type: string; document: GitPmDocument }> = [
      { type: "calendars", document: { schema: "gitpm/calendar@1", id: "C-26-7GQW87", name: "HTTP calendar", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" } },
      { type: "people", document: { schema: "gitpm/person@1", id: "U-26-KB9RXB", name: "HTTP person", weekly_capacity_hours: 40, calendar: "C-26-7GQW87", lifecycle: "active" } },
      { type: "teams", document: { schema: "gitpm/team@1", id: "G-26-22K88P", name: "HTTP team", members: ["U-26-KB9RXB"], lifecycle: "active" } },
      { type: "projects", document: { schema: "gitpm/project@2", id: "P-26-Y9S1D8", name: "HTTP project", status: "backlog", lifecycle: "active" } },
      { type: "milestones", document: { schema: "gitpm/milestone@2", id: "M-26-KK4VXH", project: "P-26-Y9S1D8", name: "HTTP milestone", lifecycle: "active" } },
      { type: "tasks", document: { schema: "gitpm/task@2", id: "T-26-FM5Q4W", project: "P-26-Y9S1D8", title: "HTTP task", type: "task", status: "backlog", lifecycle: "active" } },
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
      const known = current.get(entity.type)!;
      const latestResponse = await app.inject({ method: "GET", url: `/api/drafts/DRF-HTTP/entities/${entity.type}/${String(known.document.id)}` });
      expect(latestResponse.statusCode).toBe(200);
      const previous = latestResponse.json<ApiEntityResult>();
      const key = entity.type === "tasks" ? "title" : "name";
      const document = {
        ...previous.document,
        [key]: `${String(previous.document[key])} updated`,
        ...(entity.type === "projects" ? { group: "Operations" } : {}),
      } as GitPmDocument;
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
    expect(current.get("projects")?.document.group).toBe("Operations");

    let task = current.get("tasks")!;
    const moveResponse = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-HTTP/entities/tasks/${String(task.document.id)}/move`,
      payload: { expected_fingerprint: fingerprint, expected_blob_id: task.blob_id, target_project: "P-26-8S9HQQ" },
    });
    expect(moveResponse.statusCode).toBe(200);
    task = moveResponse.json<ApiEntityResult>();
    expect(task).toMatchObject({ path: "projects/P-26-8S9HQQ/tasks/T-26-FM5Q4W.yaml", document: { project: "P-26-8S9HQQ" } });
    fingerprint = task.draft_fingerprint;
    const archivedResponse = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-HTTP/entities/tasks/${String(task.document.id)}/archive`,
      payload: { expected_fingerprint: fingerprint, expected_blob_id: task.blob_id },
    });
    expect(archivedResponse.statusCode).toBe(200);
    const archived = archivedResponse.json<ApiEntityResult>();
    expect(archived.document.lifecycle).toBe("archived");
    fingerprint = archived.draft_fingerprint;

    const restoreResponse = await app.inject({
      method: "POST",
      url: `/api/drafts/DRF-HTTP/entities/tasks/${String(task.document.id)}/restore`,
      payload: { expected_fingerprint: fingerprint, expected_blob_id: archived.blob_id },
    });
    expect(restoreResponse.statusCode).toBe(200);
    const restored = restoreResponse.json<ApiEntityResult>();
    expect(restored.document.lifecycle).toBe("active");
    fingerprint = restored.draft_fingerprint;

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/drafts/DRF-HTTP/entities/tasks/${String(task.document.id)}`,
      payload: { expected_fingerprint: fingerprint, expected_blob_id: restored.blob_id },
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
    expect(restricted.json()).toMatchObject({
      error: {
        code: "DELETE_RESTRICTED",
        details: expect.arrayContaining([expect.objectContaining({ path: "teams/G-26-22K88P.yaml", label: "HTTP team updated" })]),
      },
    });

    const confirmed = await app.inject({
      method: "DELETE",
      url: `/api/drafts/DRF-HTTP/entities/people/${String(person.document.id)}`,
      payload: { expected_fingerprint: fingerprint, expected_blob_id: person.blob_id, unlink_references: true },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ deleted: true, unlinked_paths: ["teams/G-26-22K88P.yaml"] });
    expect((await app.inject({ method: "GET", url: `/api/drafts/DRF-HTTP/entities/people/${String(person.document.id)}` })).statusCode).toBe(404);
    expect(await readFile(path.join(draft.worktree_path, "teams", "G-26-22K88P.yaml"), "utf8")).not.toContain(String(person.document.id));

    const changed = await client.statusPorcelain(draft.worktree_path);
    const expectedPaths = [
      "calendars/C-26-7GQW87.yaml",
      "teams/G-26-22K88P.yaml",
      "projects/P-26-Y9S1D8/project.yaml",
      "projects/P-26-Y9S1D8/milestones/M-26-KK4VXH.yaml",
      "projects/P-26-Y9S1D8/views/V-26-B0C5A1.yaml",
    ];
    for (const expected of expectedPaths) expect(changed).toContain(expected);
    expect(changed).not.toContain("people/U-26-KB9RXB.yaml");
    expect(changed).not.toContain("T-26-FM5Q4W.yaml");
  }, 120_000);

  it("accepts atomic Milestone lifecycle options over HTTP", async () => {
    const { app, manager } = await runtime();
    const draft = await manager.createDraft("DRF-HTTP-ARCHIVE", "42");
    const milestone = (await app.inject({ method: "GET", url: "/api/drafts/DRF-HTTP-ARCHIVE/entities/milestones/M-26-461GDJ" })).json<ApiEntityResult>();
    const archivedResponse = await app.inject({
      method: "POST",
      url: "/api/drafts/DRF-HTTP-ARCHIVE/entities/milestones/M-26-461GDJ/archive",
      payload: { expected_fingerprint: draft.fingerprint, expected_blob_id: milestone.blob_id, include_tasks: true },
    });
    expect(archivedResponse.statusCode).toBe(200);
    const archived = archivedResponse.json<ApiEntityResult>();
    expect(archived.document.lifecycle).toBe("archived");
    const task = (await app.inject({ method: "GET", url: "/api/drafts/DRF-HTTP-ARCHIVE/entities/tasks/T-26-P9G3P8" })).json<ApiEntityResult>();
    expect(task.document.lifecycle).toBe("archived");

    const restoredResponse = await app.inject({
      method: "POST",
      url: "/api/drafts/DRF-HTTP-ARCHIVE/entities/tasks/T-26-P9G3P8/restore",
      payload: { expected_fingerprint: archived.draft_fingerprint, expected_blob_id: task.blob_id, restore_milestone: true },
    });
    expect(restoredResponse.statusCode).toBe(200);
    expect(restoredResponse.json<ApiEntityResult>().document.lifecycle).toBe("active");
    expect((await app.inject({ method: "GET", url: "/api/drafts/DRF-HTTP-ARCHIVE/entities/milestones/M-26-461GDJ" })).json<ApiEntityResult>().document.lifecycle).toBe("active");
  }, 120_000);
});
