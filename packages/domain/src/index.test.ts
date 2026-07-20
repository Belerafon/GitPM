import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DraftManager } from "@gitpm/drafts";
import { GitClient } from "@gitpm/git-client";
import type { GitPmDocument } from "@gitpm/repository-format";
import { DomainOperationError, EntityStore } from "./index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function runtime(): Promise<{ manager: DraftManager; store: EntityStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-domain-"));
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
  return { manager, store: new EntityStore(manager) };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("domain entity store", () => {
  it("returns a project-scoped workspace snapshot", async () => {
    const { manager, store } = await runtime();
    await manager.createDraft("DRF-WORKSPACE", "42");
    const workspace = await store.projectWorkspace("DRF-WORKSPACE", "P-26-MGP84K");

    expect(workspace.project.document).toMatchObject({ id: "P-26-MGP84K", schema: "gitpm/project@1" });
    expect(workspace.milestones.every((item) => item.document.project === "P-26-MGP84K")).toBe(true);
    expect(workspace.tasks.every((item) => item.document.project === "P-26-MGP84K")).toBe(true);
    expect(workspace.draft_fingerprint).toBe(workspace.project.draft_fingerprint);
  });

  it("invalidates the repository index when an external writer changes content", async () => {
    const { manager, store } = await runtime();
    const draft = await manager.createDraft("DRF-INDEX", "42");
    const before = await store.projectWorkspace("DRF-INDEX", "P-26-MGP84K");
    const task = before.tasks.find((item) => item.document.id === "T-26-P9G3P8")!;
    const absolute = path.join(draft.worktree_path, ...task.path.split("/"));
    await writeFile(absolute, (await readFile(absolute, "utf8")).replace("title: Approve schema v1", "title: Externally changed"), "utf8");

    const after = await store.projectWorkspace("DRF-INDEX", "P-26-MGP84K");
    expect(after.tasks.find((item) => item.document.id === task.document.id)?.document.title).toBe("Externally changed");
  });

  it("moves a task between projects and rejects moves that break project-local references", async () => {
    const { manager, store } = await runtime();
    const draft = await manager.createDraft("DRF-MOVE", "42");
    const task = await store.get("DRF-MOVE", "tasks", "T-26-G2TG9R");
    const moved = await store.moveTask("DRF-MOVE", "42", String(task.document.id), draft.fingerprint, task.blob_id, "P-26-MGP84K", "M-26-461GDJ");

    expect(moved.document).toMatchObject({ project: "P-26-MGP84K", milestone: "M-26-461GDJ" });
    expect(moved.path).toBe("projects/P-26-MGP84K/tasks/T-26-G2TG9R.yaml");
    const dependent = await store.get("DRF-MOVE", "tasks", "T-26-P9G3P8");
    await expect(store.moveTask("DRF-MOVE", "42", String(dependent.document.id), moved.draft_fingerprint, dependent.blob_id, "P-26-8S9HQQ"))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await store.get("DRF-MOVE", "tasks", String(dependent.document.id))).path).toBe(dependent.path);
  });

  it("creates all editable entity types, updates, archives and deletes with restrict", async () => {
    const { manager, store } = await runtime();
    const draft = await manager.createDraft("DRF-DOMAIN", "42");
    let fingerprint = draft.fingerprint;
    const documents: GitPmDocument[] = [
      { schema: "gitpm/calendar@1", id: "C-26-7GQW87", name: "Second calendar", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" },
      { schema: "gitpm/person@1", id: "U-26-KB9RXB", name: "New person", weekly_capacity_hours: 40, calendar: "C-26-7GQW87", lifecycle: "active" },
      { schema: "gitpm/team@1", id: "G-26-22K88P", name: "New team", members: ["U-26-KB9RXB"], lifecycle: "active" },
      { schema: "gitpm/project@1", id: "P-26-Y9S1D8", name: "New project", status: "backlog", lifecycle: "active" },
      { schema: "gitpm/milestone@1", id: "M-26-KK4VXH", project: "P-26-Y9S1D8", name: "New milestone", lifecycle: "active" },
      { schema: "gitpm/task@1", id: "T-26-FM5Q4W", project: "P-26-Y9S1D8", title: "New task", type: "task", status: "backlog", lifecycle: "active" },
      { schema: "gitpm/saved-view@1", id: "V-26-B0C5A1", project: "P-26-Y9S1D8", name: "New view", kind: "list", filters: {}, lifecycle: "active" },
    ];
    const paths: string[] = [];
    for (const document of documents) {
      const created = await store.create("DRF-DOMAIN", "42", fingerprint, document);
      fingerprint = created.draft_fingerprint;
      paths.push(created.path);
    }
    expect(paths).toHaveLength(7);
    expect(await readFile(path.join(draft.worktree_path, "teams", "G-26-22K88P.yaml"), "utf8"))
      .toContain("U-26-KB9RXB # person: New person");

    const project = await store.get("DRF-DOMAIN", "projects", "P-26-Y9S1D8");
    const updated = await store.update("DRF-DOMAIN", "42", "projects", String(project.document.id), fingerprint, project.blob_id, { ...project.document, name: "Updated project" });
    fingerprint = updated.draft_fingerprint;
    expect(updated.document.name).toBe("Updated project");
    expect(await readFile(path.join(draft.worktree_path, "projects", "P-26-Y9S1D8", "milestones", "M-26-KK4VXH.yaml"), "utf8"))
      .toContain("P-26-Y9S1D8 # project: Updated project");
    await expect(store.update("DRF-DOMAIN", "42", "projects", String(project.document.id), fingerprint, project.blob_id, updated.document))
      .rejects.toMatchObject({ code: "FILE_VERSION_MISMATCH" });
    fingerprint = (await manager.getDraft("DRF-DOMAIN")).fingerprint;

    const task = await store.get("DRF-DOMAIN", "tasks", "T-26-FM5Q4W");
    const archived = await store.archive("DRF-DOMAIN", "42", "tasks", String(task.document.id), fingerprint, task.blob_id);
    fingerprint = archived.draft_fingerprint;
    expect(archived.document.lifecycle).toBe("archived");
    const deleted = await store.delete("DRF-DOMAIN", "42", "tasks", String(task.document.id), fingerprint, archived.blob_id);
    fingerprint = deleted.draft_fingerprint;
    expect(deleted.deleted).toBe(true);

    const person = await store.get("DRF-DOMAIN", "people", "U-26-KB9RXB");
    await expect(store.delete("DRF-DOMAIN", "42", "people", String(person.document.id), fingerprint, person.blob_id))
      .rejects.toBeInstanceOf(DomainOperationError);
    await expect(store.delete("DRF-DOMAIN", "42", "people", String(person.document.id), fingerprint, person.blob_id))
      .rejects.toMatchObject({ code: "DELETE_RESTRICTED" });

    fingerprint = (await manager.getDraft("DRF-DOMAIN")).fingerprint;
    const statuses = await store.getConfiguration("DRF-DOMAIN", "statuses");
    const statusValues = statuses.document.statuses as Array<Record<string, unknown>>;
    const configuration = await store.updateConfiguration(
      "DRF-DOMAIN",
      "42",
      "statuses",
      fingerprint,
      statuses.blob_id,
      { ...statuses.document, statuses: statusValues.map((value) => value.slug === "backlog" ? { ...value, title: "Queue" } : value) },
    );
    expect((configuration.document.statuses as Array<Record<string, unknown>>)[0]?.title).toBe("Queue");
  });
});
