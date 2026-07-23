import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GitClient } from "@gitpm/git-client";
import { atomicWriteDomainFile } from "@gitpm/security";
import { DraftManager, DraftRuntimeError } from "./index.js";
import { DirectDraftBackend, directPushStrategy } from "./draft-backend.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");
const projectFile = "projects/P-26-MGP84K/project.yaml";
let templateRoot: string;
let templateSource: string;
let templateRemote: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.stdout.trim();
}

beforeAll(async () => {
  templateRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-drafts-template-"));
  templateSource = path.join(templateRoot, "source");
  templateRemote = path.join(templateRoot, "remote.git");
  await mkdir(templateSource);
  await cp(demo, templateSource, { recursive: true });
  await git(templateSource, "init", "-b", "main");
  await git(templateSource, "add", ".");
  await git(templateSource, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "initial portfolio");
  await git(templateRoot, "init", "--bare", templateRemote);
  await git(templateSource, "remote", "add", "origin", templateRemote);
  await git(templateSource, "push", "-u", "origin", "main");
});

afterAll(async () => rm(templateRoot, { recursive: true, force: true }));

async function fixture(): Promise<{ root: string; source: string; remote: string; data: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-drafts-"));
  roots.push(root);
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const data = path.join(root, "data");
  await Promise.all([
    cp(templateSource, source, { recursive: true }),
    cp(templateRemote, remote, { recursive: true }),
  ]);
  await git(source, "remote", "set-url", "origin", remote);
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
    expect(await readFile(path.join(draft.worktree_path, "AGENTS.md"), "utf8")).toContain("gitpm entity update --draft DRF-001 --type <type> --id <entity-id>");
    const initialSkill = await readFile(path.join(draft.worktree_path, ".agents", "skills", "gitpm", "SKILL.md"), "utf8");
    expect(initialSkill).toContain("name: gitpm");
    expect(initialSkill).toContain("gitpm entity update --draft <id> --type <type> --id <entity-id>");
    expect(initialSkill).toContain("gitpm validate --changed --draft <draft-id> [--project <project-id>] [--allow-delete] --json");
    expect(initialSkill).toContain("gitpm commit --all --draft <draft-id> -m <message> [--project <project-id>] [--allow-delete] --json");
    expect(initialSkill).not.toContain("lacks an entity update command");

    await rm(path.join(draft.worktree_path, "AGENTS.md"));
    await rm(path.join(draft.worktree_path, ".agents", "skills", "gitpm", "SKILL.md"));

    const restarted = runtime(test.remote, test.data);
    const recovery = await restarted.manager.recover();
    expect(recovery).toMatchObject({ drafts: [expect.objectContaining({ draft_id: "DRF-001" })], orphaned_worktrees: [], missing_worktrees: [] });
    expect(await readFile(path.join(draft.worktree_path, "AGENTS.md"), "utf8")).toContain("GitPM draft `DRF-001`");
    expect(await readFile(path.join(draft.worktree_path, ".agents", "skills", "gitpm", "SKILL.md"), "utf8")).toContain("name: gitpm");
    expect((await restarted.manager.poll("DRF-001")).changedExternally).toBe(false);
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

  it("computes file revisions as one batch", async () => {
    const test = await fixture();
    const { manager } = runtime(test.remote, test.data);
    await manager.createDraft("DRF-BLOBS", "42");
    const paths = [projectFile, "people/U-26-5EBAE3.yaml"];

    const blobs = await manager.fileBlobIds("DRF-BLOBS", paths);

    expect(blobs.size).toBe(2);
    expect(blobs.get(projectFile)).toMatch(/^[0-9a-f]{40}$/u);
    expect(blobs.get(paths[1]!)).toMatch(/^[0-9a-f]{40}$/u);
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

describe("direct mode draft manager", () => {
  function directRuntime(checkout: string, remote: string, data: string): { gitClient: GitClient; manager: DraftManager } {
    const gitClient = new GitClient({
      dataDirectory: data,
      remoteUrl: checkout,
      pushRemoteUrl: remote,
      defaultBranch: "main",
      allowLocalTestRemote: true,
      askPassPath: path.resolve("scripts", "git-askpass.mjs"),
    });
    const manager = new DraftManager(gitClient, data, {
      backend: new DirectDraftBackend(gitClient, checkout),
      push: directPushStrategy(gitClient),
    });
    return { gitClient, manager };
  }

  it("uses the selected checkout in place and commits straight onto main", async () => {
    const test = await fixture();
    const { gitClient, manager } = directRuntime(test.source, test.remote, test.data);
    const draft = await manager.createDraft("DRF-LOCAL", "local-user");
    expect(manager.repositoryMode).toBe("direct");
    expect(draft.branch).toBe("main");
    expect(draft.worktree_path).toBe(path.resolve(test.source));
    expect(await git(draft.worktree_path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await readFile(path.join(draft.worktree_path, "AGENTS.md"), "utf8"))
      .toContain("gitpm entity create --type <type> --file <temporary-yaml> [--project <project-id>] --json");
    expect(await readFile(path.join(draft.worktree_path, "AGENTS.md"), "utf8"))
      .toContain("gitpm entity update --type <type> --id <entity-id> --set <field>=<yaml-value>");
    const skill = await readFile(path.join(draft.worktree_path, ".agents", "skills", "gitpm", "SKILL.md"), "utf8");
    expect(skill).toContain("Direct-mode commands do not take `--draft`");
    expect(skill).toContain("gitpm diff --semantic [--project <id>] [--allow-delete]");
    expect(skill).toContain("gitpm format [--project <project-id>] [--allow-delete] --json");
    expect(skill).toContain("gitpm commit --all -m <message> [--project <project-id>] [--allow-delete] --json");
    expect(skill).toContain("gitpm entity update --type <type> --id <entity-id>");
    // No bare repository and no worktrees directory contents are created in direct mode.
    await expect(stat(path.join(test.data, "repository.git"))).rejects.toMatchObject({ code: "ENOENT" });

    await atomicWriteDomainFile(draft.worktree_path, projectFile, (await readFile(path.join(draft.worktree_path, ...projectFile.split("/")), "utf8")).replace("name: GitPM launch", "name: Direct rename"));
    const commit = await gitClient.commitAll(draft.worktree_path, "direct edit", "Direct", "direct@example.test", []);
    expect(commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(await git(draft.worktree_path, "log", "-1", "--format=%s")).toBe("direct edit");
  });

  it("does not open a direct workspace on a non-default branch", async () => {
    const test = await fixture();
    await git(test.source, "checkout", "-b", "feature/not-main");
    const { manager } = directRuntime(test.source, test.remote, test.data);

    await expect(manager.createDraft("DRF-WRONG-BRANCH", "local-user"))
      .rejects.toMatchObject({ code: "GIT_WRONG_BRANCH" });
  });

  it("does not destroy the selected checkout on cleanup and preserves local commits", async () => {
    const test = await fixture();
    const { gitClient, manager } = directRuntime(test.source, test.remote, test.data);
    const draft = await manager.createDraft("DRF-LOCAL", "local-user");
    await atomicWriteDomainFile(draft.worktree_path, "local.txt", "local\n");
    await gitClient.commitAll(draft.worktree_path, "local keep", "Direct", "direct@example.test", []);
    const localHead = await git(draft.worktree_path, "rev-parse", "HEAD");

    await manager.closeDraft("DRF-LOCAL", "local-user");
    await manager.cleanupDraft("DRF-LOCAL", "DRF-LOCAL");
    // The selected checkout must survive cleanup in direct mode.
    expect(await git(draft.worktree_path, "rev-parse", "HEAD")).toBe(localHead);
    expect(await readFile(path.join(draft.worktree_path, "local.txt"), "utf8")).toBe("local\n");
  });

  it("push fast-forwards main to origin/main", async () => {
    const test = await fixture();
    const { gitClient, manager } = directRuntime(test.source, test.remote, test.data);
    const draft = await manager.createDraft("DRF-LOCAL", "local-user");
    await atomicWriteDomainFile(draft.worktree_path, projectFile, (await readFile(path.join(draft.worktree_path, ...projectFile.split("/")), "utf8")).replace("name: GitPM launch", "name: Direct push"));
    await gitClient.commitAll(draft.worktree_path, "direct push commit", "Direct", "direct@example.test", []);
    const result = await manager.push("DRF-LOCAL", "unused-local-token");
    expect(result.branch).toBe("main");
    expect(await git(test.remote, "rev-parse", "main")).toBe(result.commit);
  });

  it("reports no orphaned worktrees in direct mode", async () => {
    const test = await fixture();
    const { manager } = directRuntime(test.source, test.remote, test.data);
    await manager.createDraft("DRF-LOCAL", "local-user");
    const report = await manager.recover();
    expect(report.orphaned_worktrees).toEqual([]);
  });

  it("keeps worktree metadata separate and restores each mode's canonical workspace", async () => {
    const test = await fixture();
    const worktreeRuntime = runtime(test.remote, test.data);
    const worktreeDraft = await worktreeRuntime.manager.createDraft("DRF-LOCAL", "local-user");
    expect(worktreeDraft.worktree_path).toContain(`${path.sep}worktrees${path.sep}`);

    const direct = directRuntime(test.source, test.remote, test.data);
    const directWorkspace = await direct.manager.ensureDirectWorkspace("DRF-LOCAL", "local-user");
    expect(directWorkspace).toMatchObject({
      worktree_path: path.resolve(test.source),
      branch: "main",
      writer_mode: "ui",
      state: "open",
    });
    expect(await readFile(path.join(test.data, "drafts", "DRF-LOCAL.json"), "utf8")).toContain(worktreeDraft.worktree_path.replaceAll("\\", "\\\\"));
    expect(await readFile(path.join(test.data, "drafts", "direct", "DRF-LOCAL.json"), "utf8")).toContain(path.resolve(test.source).replaceAll("\\", "\\\\"));

    const restoredWorktree = runtime(test.remote, test.data);
    const recovery = await restoredWorktree.manager.recover();
    expect(recovery.drafts).toEqual([expect.objectContaining({ worktree_path: worktreeDraft.worktree_path })]);
  });

  it("migrates legacy direct metadata and normalizes its hidden draft state", async () => {
    const test = await fixture();
    const first = directRuntime(test.source, test.remote, test.data);
    const workspace = await first.manager.ensureDirectWorkspace("DRF-LOCAL", "local-user");
    const directMetadata = path.join(test.data, "drafts", "direct", "DRF-LOCAL.json");
    const legacyMetadata = path.join(test.data, "drafts", "DRF-LOCAL.json");
    const legacy = { ...workspace, writer_mode: "external", state: "closed" };
    await writeFile(legacyMetadata, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    await rm(directMetadata);

    const restarted = directRuntime(test.source, test.remote, test.data);
    const reconciled = await restarted.manager.ensureDirectWorkspace("DRF-LOCAL", "local-user");
    expect(reconciled).toMatchObject({ writer_mode: "ui", state: "open", worktree_path: path.resolve(test.source) });
    await expect(stat(legacyMetadata)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(directMetadata)).resolves.toBeDefined();
    expect((await restarted.manager.poll("DRF-LOCAL")).changedExternally).toBe(false);
  });

  it("acknowledges an external edit without changing repository content", async () => {
    const test = await fixture();
    const { manager } = directRuntime(test.source, test.remote, test.data);
    const workspace = await manager.ensureDirectWorkspace("DRF-LOCAL", "local-user");
    const absolute = path.join(workspace.worktree_path, ...projectFile.split("/"));
    const edited = (await readFile(absolute, "utf8")).replace("name: GitPM launch", "name: Externally edited");
    await writeFile(absolute, edited, "utf8");
    expect((await manager.poll("DRF-LOCAL")).changedExternally).toBe(true);

    await manager.acknowledgeExternalChanges("DRF-LOCAL", "local-user");

    expect(await readFile(absolute, "utf8")).toBe(edited);
    expect((await manager.poll("DRF-LOCAL")).changedExternally).toBe(false);
  });
});
