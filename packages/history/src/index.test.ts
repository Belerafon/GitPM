import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DirectRepositoryBackend, directPushStrategy, DraftManager } from "@gitpm/drafts";
import { GitClient, GitCommandError } from "@gitpm/git-client";
import { HistoryService } from "./index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true })).stdout.trim();
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("history and revert drafts", () => {
  it("restores selected historical files and creates validated reverse commits in direct mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-history-direct-")); roots.push(root);
    const source = path.join(root, "source"); const data = path.join(root, "data");
    await cp(path.resolve("fixtures", "schema-v1", "demo"), source, { recursive: true });
    await git(source, "init", "-b", "main");
    await git(source, "add", "."); await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "Initial portfolio");
    const projectPath = "projects/P-26-MGP84K/project.yaml";
    const projectFile = path.join(source, ...projectPath.split("/"));
    const initialProject = await readFile(projectFile, "utf8");
    await writeFile(projectFile, initialProject.replace("name: GitPM launch", "name: Historical GitPM plan"), "utf8");
    await git(source, "add", "."); await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "Rename plan");
    const historical = await git(source, "rev-parse", "HEAD");
    await writeFile(projectFile, (await readFile(projectFile, "utf8")).replace("P-26-MGP84K", "P-26-INVALID"), "utf8");
    await git(source, "add", "."); await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "Invalid historical state");
    const invalid = await git(source, "rev-parse", "HEAD");
    await writeFile(projectFile, initialProject.replace("name: GitPM launch", "name: Current GitPM plan"), "utf8");
    await git(source, "add", "."); await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "Repair current state");
    const repairCommit = await git(source, "rev-parse", "HEAD");
    const readmeFile = path.join(source, "README.md");
    await writeFile(readmeFile, `${await readFile(readmeFile, "utf8")}\ntemporary history note\n`, "utf8");
    await git(source, "add", "README.md"); await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "Add history note");
    const noteCommit = await git(source, "rev-parse", "HEAD");

    const client = new GitClient({ dataDirectory: data, remoteUrl: source, defaultBranch: "main", allowLocalRepository: true });
    const backend = new DirectRepositoryBackend(client, source);
    const drafts = new DraftManager(client, data, { backend, push: directPushStrategy(client) });
    await drafts.ensureDirectWorkspace("DRF-LOCAL", "local-user");
    const service = new HistoryService(drafts, client);

    let metadata = await drafts.getDraft("DRF-LOCAL");
    const restored = await service.restoreCommitFiles("DRF-LOCAL", historical, [projectPath], "local-user", metadata.fingerprint);
    expect(restored).toMatchObject({ restored_commit: historical, restored_paths: [projectPath] });
    expect(await readFile(projectFile, "utf8")).toContain("Historical GitPM plan");
    await git(source, "restore", "--worktree", "--source=HEAD", "--", projectPath);
    metadata = await drafts.refreshFingerprint("DRF-LOCAL");

    await expect(service.restoreCommitFiles("DRF-LOCAL", invalid, [projectPath], "local-user", metadata.fingerprint)).rejects.toMatchObject({ code: "HISTORY_VALIDATION_FAILED" });
    expect(await readFile(projectFile, "utf8")).toContain("Current GitPM plan");
    expect(await git(source, "status", "--porcelain", "--", projectPath)).toBe("");

    metadata = await drafts.getDraft("DRF-LOCAL");
    await expect(service.revertDirect("DRF-LOCAL", repairCommit, "Reintroduce invalid state", "local-user", metadata.fingerprint, "GitPM Test", "gitpm@example.test")).rejects.toMatchObject({ code: "HISTORY_VALIDATION_FAILED" });
    expect(await client.headCommit(source)).toBe(noteCommit);
    expect((await client.statusPorcelain(source, ["AGENTS.md", ".agents/skills/gitpm/SKILL.md"])).trim()).toBe("");

    metadata = await drafts.getDraft("DRF-LOCAL");
    const reversed = await service.revertDirect("DRF-LOCAL", noteCommit, "Remove temporary history note", "local-user", metadata.fingerprint, "GitPM Test", "gitpm@example.test");
    expect(reversed).toMatchObject({ reverted_commit: noteCommit, branch: "main" });
    expect(await readFile(readmeFile, "utf8")).not.toContain("temporary history note");
    expect(await git(source, "log", "-1", "--format=%s")).toBe("Remove temporary history note");
    metadata = await drafts.getDraft("DRF-LOCAL");
    await service.restoreCommitFiles("DRF-LOCAL", noteCommit, ["README.md"], "local-user", metadata.fingerprint);
    expect(await readFile(readmeFile, "utf8")).toContain("temporary history note");
  });

  it("shows exact commit detail and leaves the inverse diff in a new draft without rebase", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-history-")); roots.push(root);
    const source = path.join(root, "source"); const remote = path.join(root, "remote.git"); const data = path.join(root, "data");
    await mkdir(path.join(source, "projects", "P-26-H1ST0R"), { recursive: true });
    await git(source, "init", "-b", "main");
    const file = path.join(source, "projects", "P-26-H1ST0R", "project.yaml");
    await writeFile(file, "schema: gitpm/project@2\nid: P-26-H1ST0R\nname: Before\nlifecycle: active\n", "utf8");
    await git(source, "add", "."); await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "Initial project");
    await writeFile(file, "schema: gitpm/project@2\nid: P-26-H1ST0R\nname: After\nlifecycle: active\n", "utf8");
    await git(source, "add", "."); await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "Merged project update");
    const revertedCommit = await git(source, "rev-parse", "HEAD");
    await git(root, "init", "--bare", remote); await git(source, "remote", "add", "origin", remote); await git(source, "push", "origin", "main");
    const client = new GitClient({ dataDirectory: data, remoteUrl: remote, defaultBranch: "main", allowLocalTestRemote: true });
    const drafts = new DraftManager(client, data); const service = new HistoryService(drafts, client);
    await drafts.createDraft("DRF-SOURCE", "42");
    const history = await service.list("DRF-SOURCE");
    expect(history.map((item) => item.subject)).toEqual(["Merged project update", "Initial project"]);
    expect(history.map((item) => item.semantic_summary)).toEqual([
      { created: 0, updated: 1, deleted: 0, affected_projects: ["P-26-H1ST0R"] },
      { created: 1, updated: 0, deleted: 0, affected_projects: ["P-26-H1ST0R"] },
    ]);
    const detail = await service.detail("DRF-SOURCE", revertedCommit);
    expect(detail).toMatchObject({ commit: revertedCommit, files: [{ path: "projects/P-26-H1ST0R/project.yaml", status: "Modified", additions: 1, deletions: 1 }], semantic_summary: { updated: 1, affected_projects: ["P-26-H1ST0R"] } });
    expect("diff" in detail).toBe(false);
    const fileDiff = await service.fileDiff("DRF-SOURCE", revertedCommit, "projects/P-26-H1ST0R/project.yaml");
    expect(fileDiff.oversized).toBe(false);
    expect(fileDiff.diff).toContain("-name: Before");
    expect(fileDiff.diff).toContain("+name: After");
    await expect(service.detail("DRF-SOURCE", history[1]!.commit)).resolves.toMatchObject({
      files: [{ path: "projects/P-26-H1ST0R/project.yaml", status: "Added" }],
      semantic_summary: { created: 1, updated: 0, deleted: 0, affected_projects: ["P-26-H1ST0R"] },
    });
    const result = await service.createRevertDraft("DRF-SOURCE", revertedCommit, "DRF-REVERT", "42");
    expect(result).toMatchObject({ reverted_commit: revertedCommit, conflicted: false, draft: { base_commit: revertedCommit, branch: "gitpm/42/DRF-REVERT" } });
    expect(await readFile(path.join(result.draft.worktree_path, "projects", "P-26-H1ST0R", "project.yaml"), "utf8")).toContain("name: Before");
    expect(await client.statusPorcelain(result.draft.worktree_path)).toContain("projects/P-26-H1ST0R/project.yaml");
    expect(await client.headCommit(result.draft.worktree_path)).toBe(revertedCommit);
    const conflicted = await service.createRevertDraft("DRF-SOURCE", history[1]!.commit, "DRF-CONFLICT", "42");
    expect(conflicted).toMatchObject({ conflicted: true, conflicted_files: ["projects/P-26-H1ST0R/project.yaml"], draft: { writer_mode: "external" } });
  });

  it("rejects traversal in file history", async () => {
    const service = new HistoryService({} as DraftManager, {} as GitClient);
    await expect(service.fileHistory("DRF", "../secret")).rejects.toMatchObject({ code: "HISTORY_PATH_INVALID" });
  });

  it("returns an oversized marker instead of failing when a single-file diff exceeds the output limit", async () => {
    const drafts = { getWorkspace: async () => ({ worktree_path: "C:/private/worktree" }) } as unknown as DraftManager;
    const git = {
      commitFileDiff: async () => { throw new GitCommandError("GIT_OUTPUT_LIMIT", "too big"); },
    } as unknown as GitClient;
    const service = new HistoryService(drafts, git);
    await expect(service.fileDiff("DRF", "a".repeat(40), "../escape")).rejects.toMatchObject({ code: "HISTORY_PATH_INVALID" });
    const oversized = await service.fileDiff("DRF", "a".repeat(40), "projects/P-26-BIG/project.yaml");
    expect(oversized).toMatchObject({ diff: "", oversized: true });
  });
});
