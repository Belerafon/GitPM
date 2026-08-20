import { execFile } from "node:child_process";
import { cp, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DraftManager } from "@gitpm/drafts";
import { GitClient } from "@gitpm/git-client";
import { atomicWriteDomainFile } from "@gitpm/security";
import { ChangesService, parseUnifiedDiff, type ChangesServiceOptions } from "./index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");
const projectFile = "projects/P-26-MGP84K/project.yaml";
const deletedTask = "projects/P-26-MGP84K/tasks/T-26-RHBNH8.yaml";
let templateRoot: string;
let templateRemote: string;

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, windowsHide: true });
}

beforeAll(async () => {
  templateRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-changes-template-"));
  const source = path.join(templateRoot, "source");
  templateRemote = path.join(templateRoot, "remote.git");
  await mkdir(source);
  await cp(demo, source, { recursive: true });
  const files = path.join(source, "projects", "P-26-MGP84K", "files");
  await mkdir(files);
  await writeFile(path.join(files, "ТЗ старое.txt"), "Первая строка\nВторая строка\n", "utf8");
  await writeFile(path.join(files, "scan.bin"), Buffer.from([0, 1, 2, 255, 128, 64]));
  await writeFile(path.join(files, "delete.bin"), Buffer.from([0, 7, 6, 5]));
  await writeFile(path.join(files, "rename-with-edit.txt"), "Исходный текст\n", "utf8");
  await git(source, "init", "-b", "main");
  await git(source, "add", ".");
  await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "fixture");
  await git(templateRoot, "init", "--bare", templateRemote);
  await git(source, "remote", "add", "origin", templateRemote);
  await git(source, "push", "origin", "main");
});

afterAll(async () => rm(templateRoot, { recursive: true, force: true }));

async function runtime(options: ChangesServiceOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-changes-"));
  roots.push(root);
  const remote = path.join(root, "remote.git");
  const data = path.join(root, "data");
  await cp(templateRemote, remote, { recursive: true });
  const client = new GitClient({ dataDirectory: data, remoteUrl: remote, defaultBranch: "main", allowLocalTestRemote: true });
  const manager = new DraftManager(client, data);
  const draft = await manager.createDraft("DRF-CHANGES", "42");
  return { client, draft, manager, service: new ChangesService(manager, client, options) };
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

  it("marks an oversized change instead of failing the changes view", async () => {
    const { draft, service } = await runtime();
    const absolute = path.join(draft.worktree_path, ...projectFile.split("/"));
    const block = `${Array.from({ length: 38000 }, (_, index) => `line-${index}-${"x".repeat(20)}`).join("\n")}\n`;
    await writeFile(absolute, block, "utf8");

    const listed = await service.list("DRF-CHANGES");
    const change = listed.files.find((file) => file.path === projectFile)!;
    expect(change).toMatchObject({ kind: "Modified", oversized: true });
    expect(change.hunks).toEqual([]);
    expect(listed.changed_files_count).toBeGreaterThanOrEqual(1);
  });

  it("classifies text and binary Project file changes from bounded content inspection", async () => {
    const { draft, service } = await runtime();
    const directory = path.join(draft.worktree_path, "projects", "P-26-MGP84K", "files");
    await writeFile(path.join(directory, "ТЗ старое.txt"), "Первая строка\nОбновлённая строка\n", "utf8");
    await writeFile(path.join(directory, "scan.bin"), Buffer.from([0, 9, 8, 255, 128, 64]));
    await rm(path.join(directory, "delete.bin"));
    await writeFile(path.join(directory, "новый документ.md"), "# Новый документ\nТочный текст\n", "utf8");
    await writeFile(path.join(directory, "large opaque.dat"), Buffer.alloc(2 * 1024 * 1024, 0));
    await writeFile(path.join(directory, "late binary.dat"), Buffer.concat([Buffer.alloc(9000, 65), Buffer.from([0]), Buffer.alloc(2 * 1024 * 1024, 66)]));

    const listed = await service.list("DRF-CHANGES");
    expect(listed.project_files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "ТЗ старое.txt", operation: "Modified", content_kind: "text" }),
      expect.objectContaining({ name: "scan.bin", operation: "Replaced", content_kind: "binary" }),
      expect.objectContaining({ name: "delete.bin", operation: "Deleted", content_kind: "binary" }),
      expect.objectContaining({ name: "новый документ.md", operation: "Added", content_kind: "text" }),
      expect.objectContaining({ name: "large opaque.dat", operation: "Added", content_kind: "binary" }),
      expect.objectContaining({ name: "late binary.dat", operation: "Added", content_kind: "unknown" }),
    ]));
    expect(listed.files.find((file) => file.path.endsWith("новый документ.md"))?.diff).toContain("+# Новый документ");
    const opaque = listed.files.find((file) => file.path.endsWith("large opaque.dat"))!;
    expect(opaque.diff).toContain("Binary files");
    expect(opaque.diff).not.toContain("�");
    expect(listed.files.find((file) => file.path.endsWith("late binary.dat"))).toMatchObject({ oversized: true, hunks: [] });
    const semantic = await service.semantic("DRF-CHANGES");
    expect(semantic.unclassified_files).not.toEqual(expect.arrayContaining([
      expect.stringContaining("/files/ТЗ старое.txt"),
      expect.stringContaining("/files/scan.bin"),
      expect.stringContaining("/files/новый документ.md"),
    ]));
  });

  it("reports an exact-byte external rename once and preserves Unicode names", async () => {
    const { draft, service } = await runtime();
    const directory = path.join(draft.worktree_path, "projects", "P-26-MGP84K", "files");
    await rename(path.join(directory, "ТЗ старое.txt"), path.join(directory, "ТЗ новая версия.txt"));

    const listed = await service.list("DRF-CHANGES");
    expect(listed.project_files).toEqual([
      expect.objectContaining({
        project_id: "P-26-MGP84K",
        operation: "Renamed",
        previous_name: "ТЗ старое.txt",
        name: "ТЗ новая версия.txt",
        content_kind: "text",
      }),
    ]);
    expect(listed.files.filter((file) => file.path.includes("ТЗ "))).toHaveLength(2);
    const semantic = await service.semantic("DRF-CHANGES");
    expect(semantic.unclassified_files).not.toEqual(expect.arrayContaining([expect.stringContaining("/files/")]));
  });

  it("falls back to honest delete and add when a technical rename changes content", async () => {
    const { draft, service } = await runtime();
    const directory = path.join(draft.worktree_path, "projects", "P-26-MGP84K", "files");
    await rename(path.join(directory, "rename-with-edit.txt"), path.join(directory, "edited-and-renamed.txt"));
    await writeFile(path.join(directory, "edited-and-renamed.txt"), "Совершенно другое содержимое\n", "utf8");

    const listed = await service.list("DRF-CHANGES");
    expect(listed.project_files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "rename-with-edit.txt", operation: "Deleted" }),
      expect.objectContaining({ name: "edited-and-renamed.txt", operation: "Added" }),
    ]));
    expect(listed.project_files).not.toEqual(expect.arrayContaining([expect.objectContaining({ operation: "Renamed" })]));
  });

  it("does not infer a rename when exact blob pairing is ambiguous", async () => {
    const { draft, service } = await runtime();
    const directory = path.join(draft.worktree_path, "projects", "P-26-MGP84K", "files");
    const content = "same exact bytes\n";
    await writeFile(path.join(directory, "copy-a.txt"), content, "utf8");
    await writeFile(path.join(directory, "copy-b.txt"), content, "utf8");
    await git(draft.worktree_path, "add", ".");
    await git(draft.worktree_path, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "duplicates");
    await rename(path.join(directory, "copy-a.txt"), path.join(directory, "copy-c.txt"));
    await rename(path.join(directory, "copy-b.txt"), path.join(directory, "copy-d.txt"));

    const listed = await service.list("DRF-CHANGES");
    expect(listed.project_files.filter((item) => item.name.startsWith("copy-"))).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "copy-a.txt", operation: "Deleted" }),
      expect.objectContaining({ name: "copy-b.txt", operation: "Deleted" }),
      expect.objectContaining({ name: "copy-c.txt", operation: "Added" }),
      expect.objectContaining({ name: "copy-d.txt", operation: "Added" }),
    ]));
    expect(listed.project_files).not.toEqual(expect.arrayContaining([expect.objectContaining({ operation: "Renamed", name: expect.stringMatching(/^copy-/u) })]));
  });

  it("does not infer a cross-Project rename or classify nested technical-manager content", async () => {
    const { draft, service } = await runtime();
    const source = path.join(draft.worktree_path, "projects", "P-26-MGP84K", "files", "ТЗ старое.txt");
    const targetDirectory = path.join(draft.worktree_path, "projects", "P-26-8S9HQQ", "files");
    await mkdir(targetDirectory);
    await rename(source, path.join(targetDirectory, "ТЗ старое.txt"));
    const nested = path.join(draft.worktree_path, "projects", "P-26-MGP84K", "files", "nested");
    await mkdir(nested);
    await writeFile(path.join(nested, "hidden.txt"), "technical", "utf8");

    const listed = await service.list("DRF-CHANGES");
    expect(listed.project_files).toEqual(expect.arrayContaining([
      expect.objectContaining({ project_id: "P-26-MGP84K", operation: "Deleted" }),
      expect.objectContaining({ project_id: "P-26-8S9HQQ", operation: "Added" }),
    ]));
    expect(listed.project_files).not.toEqual(expect.arrayContaining([expect.objectContaining({ operation: "Renamed" })]));
    const semantic = await service.semantic("DRF-CHANGES");
    expect(semantic.unclassified_files).toContain("projects/P-26-MGP84K/files/nested/hidden.txt");
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
      "schema: gitpm/task@2", "id: T-26-9NJTEF", "project: P-26-MGP84K",
      "title: New task", "type: task", "status: todo", "lifecycle: active", "description_markdown: New", "acceptance_criteria_markdown: Done", "assignees: []", "depends_on: []", "labels: []", "",
    ].join("\n"), "utf8");

    const semantic = await service.semantic("DRF-CHANGES");
    expect(semantic.counts).toEqual({ created: 1, updated: 1, archived: 1, deleted: 1 });
    expect(semantic.updated[0]).toMatchObject({ id: "P-26-MGP84K", fields: expect.arrayContaining([expect.objectContaining({ field: "name", before: "GitPM launch", after: "GitPM alpha" })]) });
    expect(semantic.archived[0]).toMatchObject({ fields: expect.arrayContaining([expect.objectContaining({ field: "lifecycle", before: "active", after: "archived" })]) });
    expect(semantic.file_entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: projectFile, schema: "gitpm/project@2", id: "P-26-MGP84K", display_name: "GitPM alpha" }),
      expect.objectContaining({ path: archivedTask, schema: "gitpm/task@2", display_name: expect.any(String) }),
      expect.objectContaining({ path: deletedTask, schema: "gitpm/task@2", display_name: expect.any(String) }),
    ]));
    expect(semantic.affected_projects).toEqual(["P-26-MGP84K"]);
    expect((await service.list("DRF-CHANGES")).files.find((file) => file.kind === "Added")?.diff).toContain("--- /dev/null");
  });

  it("keeps display-comment-only edits in the file diff without reporting an empty semantic update", async () => {
    const { draft, service } = await runtime();
    const taskPath = "projects/P-26-MGP84K/tasks/T-26-P9G3P8.yaml";
    const absolute = path.join(draft.worktree_path, ...taskPath.split("/"));
    const updated = (await readFile(absolute, "utf8")).replace("# project: GitPM launch", "# project: Renamed display comment");
    await writeFile(absolute, updated, "utf8");

    const listed = await service.list("DRF-CHANGES");
    expect(listed.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: taskPath, kind: "Modified" })]));

    const semantic = await service.semantic("DRF-CHANGES");
    expect(semantic.counts).toEqual({ created: 0, updated: 0, archived: 0, deleted: 0 });
    expect(semantic.updated).toEqual([]);
    expect(semantic.file_entities).toContainEqual(expect.objectContaining({ path: taskPath, id: "T-26-P9G3P8", display_name: "Approve schema v1" }));
    expect(semantic.unclassified_files).not.toContain(taskPath);
  });

  it("includes GitPM configuration changes without inventing entity IDs", async () => {
    const { draft, service } = await runtime();
    const repositoryPath = ".gitpm/repository.yaml";
    const absolute = path.join(draft.worktree_path, ...repositoryPath.split("/"));
    await writeFile(absolute, (await readFile(absolute, "utf8")).replace("ui_poll_interval_seconds: 5", "ui_poll_interval_seconds: 6"), "utf8");

    const semantic = await service.semantic("DRF-CHANGES");
    expect(semantic.counts).toEqual({ created: 0, updated: 1, archived: 0, deleted: 0 });
    expect(semantic.updated).toContainEqual(expect.objectContaining({
      path: repositoryPath,
      schema: "gitpm/repository@1",
      fields: [expect.objectContaining({ field: "ui_poll_interval_seconds", before: 5, after: 6 })],
    }));
    expect(semantic.updated[0]).not.toHaveProperty("id");
    expect(semantic.file_entities).toContainEqual({ path: repositoryPath, schema: "gitpm/repository@1" });
    expect(semantic.unclassified_files).not.toContain(repositoryPath);
  });

  it("reports schedule-track title changes by stable slug", async () => {
    const { draft, service } = await runtime();
    const tracksPath = ".gitpm/schedule-tracks.yaml";
    const absolute = path.join(draft.worktree_path, ...tracksPath.split("/"));
    const updated = (await readFile(absolute, "utf8"))
      .replace("title: Working plan", "title: Internal work plan")
      .replace("title: Target", "title: Contract commitment");
    await writeFile(absolute, updated, "utf8");

    const semantic = await service.semantic("DRF-CHANGES");
    expect(semantic.counts).toEqual({ created: 0, updated: 1, archived: 0, deleted: 0 });
    expect(semantic.updated).toContainEqual(expect.objectContaining({
      path: tracksPath,
      schema: "gitpm/schedule-tracks@1",
      fields: expect.arrayContaining([
        { field: "tracks.plan.title", before: "Working plan", after: "Internal work plan" },
        { field: "tracks.target.title", before: "Target", after: "Contract commitment" },
      ]),
    }));
    expect(semantic.updated[0]).not.toHaveProperty("id");
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
    expect(semantic.file_entities).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: source, id: "T-26-G2TG9R", display_name: expect.any(String) }),
      expect.objectContaining({ path: target, id: "T-26-G2TG9R", display_name: expect.any(String) }),
    ]));
    expect(semantic.affected_projects).toEqual(["P-26-8S9HQQ", "P-26-MGP84K"]);
  });

  it("reports nested schedule windows as dotted field-level changes", async () => {
    const { draft, service } = await runtime();
    const taskPath = "projects/P-26-MGP84K/tasks/T-26-P9G3P8.yaml";
    const absolute = path.join(draft.worktree_path, ...taskPath.split("/"));
    const updated = (await readFile(absolute, "utf8")).replace("finish: 2026-07-02", "finish: 2026-07-09");
    await writeFile(absolute, updated, "utf8");

    const semantic = await service.semantic("DRF-CHANGES");
    expect(semantic.updated[0]).toMatchObject({ id: "T-26-P9G3P8", fields: expect.arrayContaining([expect.objectContaining({ field: "schedules.plan.finish", before: "2026-07-02", after: "2026-07-09" })]) });
  });

  it("restores modified and deleted binary Project files with exact bytes", async () => {
    const { draft, manager, service } = await runtime();
    const scanPath = "projects/P-26-MGP84K/files/scan.bin";
    const deletedPath = "projects/P-26-MGP84K/files/delete.bin";
    const scanAbsolute = path.join(draft.worktree_path, ...scanPath.split("/"));
    const deletedAbsolute = path.join(draft.worktree_path, ...deletedPath.split("/"));
    const scanOriginal = await readFile(scanAbsolute);
    const deletedOriginal = await readFile(deletedAbsolute);
    await writeFile(scanAbsolute, Buffer.from([255, 0, 254, 1, 128]));
    await rm(deletedAbsolute);
    const accepted = await manager.setWriterMode("DRF-CHANGES", "42", "ui");

    const restoredScan = await service.restoreFile("DRF-CHANGES", "42", accepted.fingerprint, scanPath);
    expect(await readFile(scanAbsolute)).toEqual(scanOriginal);
    expect(restoredScan.result.validation.valid).toBe(true);
    const restoredDeleted = await service.restoreFile("DRF-CHANGES", "42", restoredScan.metadata.fingerprint, deletedPath);
    expect(await readFile(deletedAbsolute)).toEqual(deletedOriginal);
    expect(restoredDeleted.result.validation.valid).toBe(true);
  });

  it("discards a mixed change set in one repository mutation", async () => {
    const { draft, manager, service } = await runtime();
    const scanPath = "projects/P-26-MGP84K/files/scan.bin";
    const deletedPath = "projects/P-26-MGP84K/files/delete.bin";
    const addedPath = "projects/P-26-MGP84K/files/new.bin";
    const tracked = [projectFile, scanPath, deletedPath];
    const originals = new Map(await Promise.all(tracked.map(async (relative) => [relative, await readFile(path.join(draft.worktree_path, ...relative.split("/")))] as const)));
    await writeFile(path.join(draft.worktree_path, ...projectFile.split("/")), (originals.get(projectFile)!.toString("utf8")).replace("name: GitPM launch", "name: Mixed discard"));
    await writeFile(path.join(draft.worktree_path, ...scanPath.split("/")), Buffer.from([255, 0, 1]));
    await rm(path.join(draft.worktree_path, ...deletedPath.split("/")));
    await writeFile(path.join(draft.worktree_path, ...addedPath.split("/")), Buffer.from([0, 255, 7]));
    const accepted = await manager.setWriterMode("DRF-CHANGES", "42", "ui");
    const mutationSpy = vi.spyOn(manager, "withRepositoryMutation");

    const result = await service.discardAll("DRF-CHANGES", "42", accepted.fingerprint);

    expect(mutationSpy).toHaveBeenCalledTimes(1);
    expect(result.discarded).toBe(4);
    for (const relative of tracked) expect(await readFile(path.join(draft.worktree_path, ...relative.split("/")))).toEqual(originals.get(relative));
    await expect(readFile(path.join(draft.worktree_path, ...addedPath.split("/")))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await service.list("DRF-CHANGES")).changed_files_count).toBe(0);
  });

  it("rolls an exact binary restore back when repository validation fails", async () => {
    const { draft, manager, service } = await runtime();
    const scanPath = "projects/P-26-MGP84K/files/scan.bin";
    const scanAbsolute = path.join(draft.worktree_path, ...scanPath.split("/"));
    const changed = Buffer.from([255, 0, 19, 128, 7]);
    await writeFile(scanAbsolute, changed);
    await writeFile(path.join(draft.worktree_path, ...projectFile.split("/")), "not: a valid GitPM project\n");
    const accepted = await manager.setWriterMode("DRF-CHANGES", "42", "ui");

    await expect(service.restoreFile("DRF-CHANGES", "42", accepted.fingerprint, scanPath))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await readFile(scanAbsolute)).toEqual(changed);
  });

  it("rolls back already applied entries and preserves a racing external edit", async () => {
    let worktree = "";
    let racedPath = "";
    const external = Buffer.from([255, 0, 42, 128]);
    const { draft, manager, service } = await runtime({
      beforeApplyEntryForTest: async (relative, index) => {
        if (index !== 1) return;
        racedPath = relative;
        await writeFile(path.join(worktree, ...relative.split("/")), external);
      },
    });
    worktree = draft.worktree_path;
    const paths = [projectFile, "projects/P-26-MGP84K/files/scan.bin"];
    await writeFile(path.join(worktree, ...projectFile.split("/")), (await readFile(path.join(worktree, ...projectFile.split("/")), "utf8")).replace("name: GitPM launch", "name: Race prestate"));
    await writeFile(path.join(worktree, ...paths[1]!.split("/")), Buffer.from([0, 255, 8, 9]));
    const before = new Map(await Promise.all(paths.map(async (relative) => [relative, await readFile(path.join(worktree, ...relative.split("/")))] as const)));
    const accepted = await manager.setWriterMode("DRF-CHANGES", "42", "ui");

    await expect(service.discardAll("DRF-CHANGES", "42", accepted.fingerprint))
      .rejects.toMatchObject({ code: "CHANGE_CHANGED_EXTERNALLY" });
    expect(racedPath).not.toBe("");
    for (const relative of paths) {
      expect(await readFile(path.join(worktree, ...relative.split("/"))))
        .toEqual(relative === racedPath ? external : before.get(relative));
    }
  });

  it("rejects a symlink target without discarding another change", async (context) => {
    const { draft, manager, service } = await runtime();
    const scanPath = "projects/P-26-MGP84K/files/scan.bin";
    const scanAbsolute = path.join(draft.worktree_path, ...scanPath.split("/"));
    const projectAbsolute = path.join(draft.worktree_path, ...projectFile.split("/"));
    const projectChanged = (await readFile(projectAbsolute, "utf8")).replace("name: GitPM launch", "name: Symlink prestate");
    await writeFile(projectAbsolute, projectChanged);
    await rm(scanAbsolute);
    try {
      await symlink("delete.bin", scanAbsolute, "file");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        context.skip();
        return;
      }
      throw error;
    }
    const accepted = await manager.setWriterMode("DRF-CHANGES", "42", "ui");

    await expect(service.discardAll("DRF-CHANGES", "42", accepted.fingerprint))
      .rejects.toMatchObject({ code: expect.stringMatching(/FS_SYMLINK|CHANGE_TARGET_UNSAFE/u) });
    expect(await readFile(projectAbsolute, "utf8")).toBe(projectChanged);
    expect((await lstat(scanAbsolute)).isSymbolicLink()).toBe(true);
  });
});
