import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DraftManager } from "@gitpm/drafts";
import { GitClient } from "@gitpm/git-client";
import { HistoryService } from "./index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true })).stdout.trim();
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("history and revert drafts", () => {
  it("shows exact commit detail and leaves the inverse diff in a new draft without rebase", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-history-")); roots.push(root);
    const source = path.join(root, "source"); const remote = path.join(root, "remote.git"); const data = path.join(root, "data");
    await mkdir(path.join(source, "projects", "P-26-H1ST0R"), { recursive: true });
    await git(source, "init", "-b", "main");
    const file = path.join(source, "projects", "P-26-H1ST0R", "project.yaml");
    await writeFile(file, "schema: gitpm/project@1\nid: P-26-H1ST0R\nname: Before\nlifecycle: active\n", "utf8");
    await git(source, "add", "."); await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "Initial project");
    await writeFile(file, "schema: gitpm/project@1\nid: P-26-H1ST0R\nname: After\nlifecycle: active\n", "utf8");
    await git(source, "add", "."); await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "Merged project update");
    const revertedCommit = await git(source, "rev-parse", "HEAD");
    await git(root, "init", "--bare", remote); await git(source, "remote", "add", "origin", remote); await git(source, "push", "origin", "main");
    const client = new GitClient({ dataDirectory: data, remoteUrl: remote, defaultBranch: "main", allowLocalTestRemote: true });
    const drafts = new DraftManager(client, data); const service = new HistoryService(drafts, client);
    await drafts.createDraft("DRF-SOURCE", "42");
    const history = await service.list("DRF-SOURCE");
    expect(history.map((item) => item.subject)).toEqual(["Merged project update", "Initial project"]);
    const detail = await service.detail("DRF-SOURCE", revertedCommit);
    expect(detail).toMatchObject({ commit: revertedCommit, files: [{ path: "projects/P-26-H1ST0R/project.yaml", additions: 1, deletions: 1 }], semantic_summary: { updated: 1, affected_projects: ["P-26-H1ST0R"] } });
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
});
