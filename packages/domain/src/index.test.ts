import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
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
  it("creates all editable entity types, updates, archives and deletes with restrict", async () => {
    const { manager, store } = await runtime();
    const draft = await manager.createDraft("DRF-DOMAIN", "42");
    let fingerprint = draft.fingerprint;
    const documents: GitPmDocument[] = [
      { schema: "gitpm/calendar@1", id: "CAL-01J2C01M9QHPMQ2ZK5F7N8S4VB", name: "Second calendar", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" },
      { schema: "gitpm/person@1", id: "PER-01J2C01M9QHPMQ2ZK5F7N8S4VC", name: "New person", weekly_capacity_hours: 40, calendar: "CAL-01J2C01M9QHPMQ2ZK5F7N8S4VB", lifecycle: "active" },
      { schema: "gitpm/team@1", id: "TEM-01J2C01M9QHPMQ2ZK5F7N8S4VB", name: "New team", members: ["PER-01J2C01M9QHPMQ2ZK5F7N8S4VC"], lifecycle: "active" },
      { schema: "gitpm/project@1", id: "PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYR", name: "New project", status: "backlog", lifecycle: "active" },
      { schema: "gitpm/milestone@1", id: "MLS-01J2C01M9QHPMQ2ZK5F7N8S4VB", project: "PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYR", name: "New milestone", lifecycle: "active" },
      { schema: "gitpm/task@1", id: "TSK-01J2BZ7G4VJ57PX9K2Q0C6C5XS", project: "PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYR", title: "New task", type: "task", status: "backlog", lifecycle: "active" },
      { schema: "gitpm/saved-view@1", id: "VIW-01J2C01M9QHPMQ2ZK5F7N8S4VB", project: "PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYR", name: "New view", kind: "list", filters: {}, lifecycle: "active" },
    ];
    const paths: string[] = [];
    for (const document of documents) {
      const created = await store.create("DRF-DOMAIN", "42", fingerprint, document);
      fingerprint = created.draft_fingerprint;
      paths.push(created.path);
    }
    expect(paths).toHaveLength(7);

    const project = await store.get("DRF-DOMAIN", "projects", "PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYR");
    const updated = await store.update("DRF-DOMAIN", "42", "projects", String(project.document.id), fingerprint, project.blob_id, { ...project.document, name: "Updated project" });
    fingerprint = updated.draft_fingerprint;
    expect(updated.document.name).toBe("Updated project");
    await expect(store.update("DRF-DOMAIN", "42", "projects", String(project.document.id), fingerprint, project.blob_id, updated.document))
      .rejects.toMatchObject({ code: "FILE_VERSION_MISMATCH" });
    fingerprint = (await manager.getDraft("DRF-DOMAIN")).fingerprint;

    const task = await store.get("DRF-DOMAIN", "tasks", "TSK-01J2BZ7G4VJ57PX9K2Q0C6C5XS");
    const archived = await store.archive("DRF-DOMAIN", "42", "tasks", String(task.document.id), fingerprint, task.blob_id);
    fingerprint = archived.draft_fingerprint;
    expect(archived.document.lifecycle).toBe("archived");
    const deleted = await store.delete("DRF-DOMAIN", "42", "tasks", String(task.document.id), fingerprint, archived.blob_id);
    fingerprint = deleted.draft_fingerprint;
    expect(deleted.deleted).toBe(true);

    const person = await store.get("DRF-DOMAIN", "people", "PER-01J2C01M9QHPMQ2ZK5F7N8S4VC");
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
