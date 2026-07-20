import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitClient } from "@gitpm/git-client";
import { atomicWriteDomainFile } from "@gitpm/security";
import { DraftManager, DraftRuntimeError } from "./index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");
const projectFile = "projects/P-26-MGP84K/project.yaml";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.stdout.trim();
}

async function fixture(): Promise<{ root: string; source: string; remote: string; data: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-drafts-"));
  roots.push(root);
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const data = path.join(root, "data");
  await mkdir(source);
  await cp(demo, source, { recursive: true });
  await git(source, "init", "-b", "main");
  await git(source, "add", ".");
  await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "initial portfolio");
  await git(root, "init", "--bare", remote);
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "-u", "origin", "main");
  return { root, source, remote, data };
}

function runtime(remote: string, data: string): { gitClient: GitClient; manager: DraftManager } {
  const gitClient = new GitClient({
    dataDirectory: data,
    remoteUrl: remote,
    defaultBranch: "main",
    allowLocalTestRemote: true,
  });
  return { gitClient, manager: new DraftManager(gitClient, data) };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("draft manager", () => {
  it("creates persisted metadata from exact fetched main and recovers after restart", async () => {
    const test = await fixture();
    await writeFile(path.join(test.source, "second.txt"), "second\n", "utf8");
    await git(test.source, "add", ".");
    await git(test.source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "advance main");
    await git(test.source, "push", "origin", "main");
    const remoteHead = await git(test.source, "rev-parse", "HEAD");
    const firstRuntime = runtime(test.remote, test.data);
    const draft = await firstRuntime.manager.createDraft("DRF-001", "42");
    expect(draft).toMatchObject({
      branch: "gitpm/42/DRF-001",
      base_commit: remoteHead,
      writer_mode: "ui",
      state: "open",
    });
    expect(await firstRuntime.gitClient.headCommit(draft.worktree_path)).toBe(remoteHead);

    const restarted = runtime(test.remote, test.data);
    const recovery = await restarted.manager.recover();
    expect(recovery).toMatchObject({ drafts: [expect.objectContaining({ draft_id: "DRF-001" })], orphaned_worktrees: [], missing_worktrees: [] });
  });

  it("invalidates UI mutation after an external edit and enforces writer mode", async () => {
    const test = await fixture();
    const { manager } = runtime(test.remote, test.data);
    const draft = await manager.createDraft("DRF-002", "42");
    const absolute = path.join(draft.worktree_path, ...projectFile.split("/"));
    await writeFile(absolute, `${await readFile(absolute, "utf8")}\n`, "utf8");
    await expect(manager.withUiMutation("DRF-002", "42", draft.fingerprint, async () => undefined))
      .rejects.toMatchObject({ code: "DRAFT_CHANGED_EXTERNALLY" });

    const external = await manager.setWriterMode("DRF-002", "42", "external");
    await expect(manager.withUiMutation("DRF-002", "42", external.fingerprint, async () => undefined))
      .rejects.toMatchObject({ code: "DRAFT_READ_ONLY" });
    expect((await manager.poll("DRF-002")).changedExternally).toBe(false);
  });

  it("tracks UI writes and rejects a stale file blob revision", async () => {
    const test = await fixture();
    const { manager } = runtime(test.remote, test.data);
    const draft = await manager.createDraft("DRF-003", "42");
    const beforeBlob = await manager.fileBlobId("DRF-003", projectFile);
    const mutation = await manager.withUiMutation("DRF-003", "42", draft.fingerprint, async (metadata) => {
      const absolute = path.join(metadata.worktree_path, ...projectFile.split("/"));
      const updated = (await readFile(absolute, "utf8")).replace("name: GitPM launch", "name: GitPM launch updated");
      await atomicWriteDomainFile(metadata.worktree_path, projectFile, updated);
      return "written";
    });
    expect(mutation.result).toBe("written");
    await expect(manager.assertFileBlobId("DRF-003", projectFile, beforeBlob))
      .rejects.toBeInstanceOf(DraftRuntimeError);
    await expect(manager.assertFileBlobId("DRF-003", projectFile, beforeBlob))
      .rejects.toMatchObject({ code: "FILE_VERSION_MISMATCH" });
    expect((await manager.poll("DRF-003")).changedExternally).toBe(false);
  });

  it("reports an orphaned worktree left before metadata persistence", async () => {
    const test = await fixture();
    const { gitClient, manager } = runtime(test.remote, test.data);
    await gitClient.initialize();
    const commit = await gitClient.fetch();
    await gitClient.addWorktree("gitpm/42/DRF-ORPHAN", "DRF-ORPHAN", commit);
    expect((await manager.recover()).orphaned_worktrees).toEqual(["DRF-ORPHAN"]);
  });

  it("keeps close reversible and requires explicit destructive cleanup", async () => {
    const test = await fixture();
    const { manager } = runtime(test.remote, test.data);
    const draft = await manager.createDraft("DRF-004", "42");
    expect((await manager.closeDraft("DRF-004", "42")).state).toBe("closed");
    expect((await manager.reopenDraft("DRF-004", "42")).state).toBe("open");
    await manager.closeDraft("DRF-004", "42");
    await writeFile(path.join(draft.worktree_path, "dirty.txt"), "dirty\n", "utf8");
    await expect(manager.cleanupDraft("DRF-004", "wrong")).rejects.toMatchObject({ code: "CLEANUP_CONFIRMATION_REQUIRED" });
    await manager.cleanupDraft("DRF-004", "DRF-004");
    await expect(manager.getDraft("DRF-004")).rejects.toMatchObject({ code: "DRAFT_NOT_FOUND" });
    expect((await manager.recover()).drafts).toEqual([]);
  });

  it("serializes shared bare-repository mutations during concurrent draft creation", async () => {
    const test = await fixture();
    const sharedOperations: string[] = [];
    const gitClient = new GitClient({
      dataDirectory: test.data,
      remoteUrl: test.remote,
      defaultBranch: "main",
      allowLocalTestRemote: true,
      onCommand: (record) => {
        if (record.args.includes("fetch")) sharedOperations.push("fetch");
        if (record.args.includes("worktree")) sharedOperations.push("worktree");
      },
    });
    const manager = new DraftManager(gitClient, test.data);
    await Promise.all([
      manager.createDraft("DRF-005", "42"),
      manager.createDraft("DRF-006", "42"),
    ]);
    expect(sharedOperations).toEqual(["fetch", "worktree", "fetch", "worktree"]);
  });

  it("serializes UI mutations so a concurrent stale revision cannot overwrite", async () => {
    const test = await fixture();
    const { manager } = runtime(test.remote, test.data);
    const draft = await manager.createDraft("DRF-007", "42");
    const mutation = (name: string) => manager.withUiMutation("DRF-007", "42", draft.fingerprint, async (metadata) => {
      const absolute = path.join(metadata.worktree_path, ...projectFile.split("/"));
      const updated = (await readFile(absolute, "utf8")).replace("name: GitPM launch", `name: ${name}`);
      await atomicWriteDomainFile(metadata.worktree_path, projectFile, updated);
      return name;
    });
    const results = await Promise.allSettled([mutation("First writer"), mutation("Second writer")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "DRAFT_CHANGED_EXTERNALLY" });
  });
});
