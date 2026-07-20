import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DraftManager } from "@gitpm/drafts";
import { GitClient } from "@gitpm/git-client";
import { atomicWriteDomainFile } from "@gitpm/security";
import { ChangesService, parseUnifiedDiff } from "./index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");
const projectFile = "projects/P-26-MGP84K/project.yaml";
const deletedTask = "projects/P-26-MGP84K/tasks/T-26-RHBNH8.yaml";

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

async function runtime() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-changes-"));
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
  const draft = await manager.createDraft("DRF-CHANGES", "42");
  return { client, draft, manager, service: new ChangesService(manager, client) };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("changes and restore service", () => {
  it("restores one of two Unicode hunks and rejects a stale diff token", async () => {
    const { draft, manager, service } = await runtime();
    const absolute = path.join(draft.worktree_path, ...projectFile.split("/"));
    const original = await readFile(absolute, "utf8");
    const modified = original
      .replace("name: GitPM launch", "name: GitPM запуск")
      .replace("  - product", "  - продукт");
    await atomicWriteDomainFile(draft.worktree_path, projectFile, modified);
    const accepted = await manager.setWriterMode("DRF-CHANGES", "42", "ui");
    const listed = await service.list("DRF-CHANGES");
    const change = listed.files.find((file) => file.path === projectFile)!;
    expect(change.kind).toBe("Modified");
    expect(change.hunks.length).toBeGreaterThanOrEqual(2);

    const restored = await service.restoreHunk("DRF-CHANGES", "42", accepted.fingerprint, projectFile, change.diff_token, 0);
    const after = await readFile(absolute, "utf8");
    expect(after).toContain("name: GitPM launch");
    expect(after).toContain("продукт");
    expect(restored.result.validation.valid).toBe(true);
    await expect(service.restoreHunk("DRF-CHANGES", "42", restored.metadata.fingerprint, projectFile, change.diff_token, 0))
      .rejects.toMatchObject({ code: "STALE_DIFF" });

    const current = await manager.getDraft("DRF-CHANGES");
    const whole = await service.restoreFile("DRF-CHANGES", "42", current.fingerprint, projectFile);
    expect(whole.result.validation.valid).toBe(true);
    expect(await readFile(absolute, "utf8")).toBe(original);
  });

  it("restores a deleted file byte-for-byte and keeps other changes", async () => {
    const { draft, manager, service } = await runtime();
    const deletedAbsolute = path.join(draft.worktree_path, ...deletedTask.split("/"));
    const projectAbsolute = path.join(draft.worktree_path, ...projectFile.split("/"));
    const deletedOriginal = await readFile(deletedAbsolute, "utf8");
    await rm(deletedAbsolute);
    await writeFile(projectAbsolute, (await readFile(projectAbsolute, "utf8")).replace("name: GitPM launch", "name: Other change"), "utf8");
    const accepted = await manager.setWriterMode("DRF-CHANGES", "42", "ui");
    const listed = await service.list("DRF-CHANGES");
    expect(listed.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: deletedTask, kind: "Deleted" }),
      expect.objectContaining({ path: projectFile, kind: "Modified" }),
    ]));
    const restored = await service.restoreFile("DRF-CHANGES", "42", accepted.fingerprint, deletedTask);
    expect(await readFile(deletedAbsolute, "utf8")).toBe(deletedOriginal);
    expect(await readFile(projectAbsolute, "utf8")).toContain("Other change");
    expect(restored.result.validation.valid).toBe(true);
  });

  it("parses CRLF unified diff text", () => {
    const diff = "@@ -1,2 +1,2 @@\r\n-old\r\n+новый\r\n context\r\n";
    expect(parseUnifiedDiff(diff)).toEqual([expect.objectContaining({ old_start: 1, new_start: 1, old_count: 2, new_count: 2 })]);
  });

  it("describes created, updated, archived and deleted domain documents", async () => {
    const { draft, service } = await runtime();
    const projectAbsolute = path.join(draft.worktree_path, ...projectFile.split("/"));
    const deletedAbsolute = path.join(draft.worktree_path, ...deletedTask.split("/"));
    const archivedTask = "projects/P-26-MGP84K/tasks/T-26-P9G3P8.yaml";
    const archivedAbsolute = path.join(draft.worktree_path, ...archivedTask.split("/"));
    const createdTask = "projects/P-26-MGP84K/tasks/T-26-9NJTEF.yaml";
    await writeFile(projectAbsolute, (await readFile(projectAbsolute, "utf8")).replace("name: GitPM launch", "name: GitPM alpha"), "utf8");
    await writeFile(archivedAbsolute, (await readFile(archivedAbsolute, "utf8")).replace("lifecycle: active", "lifecycle: archived"), "utf8");
    await rm(deletedAbsolute);
    await writeFile(path.join(draft.worktree_path, ...createdTask.split("/")), [
      "schema: gitpm/task@1", "id: T-26-9NJTEF", "project: P-26-MGP84K",
      "title: New task", "type: task", "status: todo", "lifecycle: active", "description_markdown: New", "acceptance_criteria_markdown: Done", "assignees: []", "depends_on: []", "labels: []", "",
    ].join("\n"), "utf8");

    const semantic = await service.semantic("DRF-CHANGES");
    expect(semantic.counts).toEqual({ created: 1, updated: 1, archived: 1, deleted: 1 });
    expect(semantic.updated[0]).toMatchObject({ id: "P-26-MGP84K", fields: expect.arrayContaining([expect.objectContaining({ field: "name", before: "GitPM launch", after: "GitPM alpha" })]) });
    expect(semantic.archived[0]).toMatchObject({ fields: expect.arrayContaining([expect.objectContaining({ field: "lifecycle", before: "active", after: "archived" })]) });
    expect(semantic.affected_projects).toEqual(["P-26-MGP84K"]);
    expect((await service.list("DRF-CHANGES")).files.find((file) => file.kind === "Added")?.diff).toContain("--- /dev/null");
  });

  it("describes a task relocation as one semantic update", async () => {
    const { draft, service } = await runtime();
    const source = "projects/P-26-8S9HQQ/tasks/T-26-G2TG9R.yaml";
    const target = "projects/P-26-MGP84K/tasks/T-26-G2TG9R.yaml";
    const sourceAbsolute = path.join(draft.worktree_path, ...source.split("/"));
    const targetAbsolute = path.join(draft.worktree_path, ...target.split("/"));
    const moved = (await readFile(sourceAbsolute, "utf8")).replace("project: P-26-8S9HQQ", "project: P-26-MGP84K");
    await writeFile(targetAbsolute, moved, "utf8");
    await rm(sourceAbsolute);

    const semantic = await service.semantic("DRF-CHANGES");
    expect(semantic.counts).toEqual({ created: 0, updated: 1, archived: 0, deleted: 0 });
    expect(semantic.updated[0]).toMatchObject({ id: "T-26-G2TG9R", path: target, fields: [expect.objectContaining({ field: "project", before: "P-26-8S9HQQ", after: "P-26-MGP84K" })] });
    expect(semantic.affected_projects).toEqual(["P-26-8S9HQQ", "P-26-MGP84K"]);
  });
});
