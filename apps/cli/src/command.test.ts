import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./command.js";
import { DirectCliRuntime } from "./direct-runtime.js";
import type { AgentWorkflow } from "@gitpm/agent";
import type { GitPmDocument } from "@gitpm/repository-format";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-cli-"));
  roots.push(root);
  await cp(demo, root, { recursive: true });
  return root;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return stdout.trim();
}

async function directFixture(): Promise<{ root: string; remote: string; data: string; direct: DirectCliRuntime }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-cli-direct-"));
  roots.push(root);
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const data = path.join(root, "data");
  await cp(demo, source, { recursive: true });
  await git(source, "init", "-b", "main");
  await git(source, "add", ".");
  await git(source, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "initial portfolio");
  await git(root, "init", "--bare", remote);
  await git(source, "remote", "add", "origin", remote);
  await git(source, "push", "-u", "origin", "main");
  const direct = new DirectCliRuntime({
    dataDirectory: data,
    remoteUrl: remote,
    defaultBranch: "main",
    authorName: "GitPM Direct CLI",
    authorEmail: "direct@example.test",
    allowLocalRepository: true,
    askPassPath: path.resolve("scripts", "git-askpass.mjs"),
    pushAccessToken: "unused-local-token",
  });
  return { root, remote, data, direct };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("CLI P02 commands", () => {
  it("prints a stable version", async () => {
    expect(await run(["--version"])).toEqual({ exitCode: 0, output: "0.1.0" });
  });

  it("checks and applies canonical formatting", async () => {
    const root = await fixture();
    const file = path.join(root, ".gitpm", "repository.yaml");
    await writeFile(file, `# comment\n${await readFile(file, "utf8")}`, "utf8");
    const check = await run(["format", "--check", "--json", "--root", root]);
    expect(check.exitCode).toBe(1);
    expect(JSON.parse(check.output)).toMatchObject({ code: "FORMAT_REQUIRED", changed_files: [".gitpm/repository.yaml"] });
    expect((await run(["format", "--root", root])).exitCode).toBe(0);
    expect((await run(["format", "--check", "--root", root])).exitCode).toBe(0);
    expect(await readFile(file, "utf8")).not.toContain("# comment");
  });

  it("returns a neutral JSON validation report with stable codes", async () => {
    const valid = await run(["validate", "--json", "--root", demo]);
    expect(valid.exitCode).toBe(0);
    expect(JSON.parse(valid.output)).toMatchObject({ ok: true, code: "OK", documentCount: 14 });

    const root = await fixture();
    const calendar = path.join(root, "calendars", "C-26-QD7FJ4.yaml");
    await writeFile(calendar, (await readFile(calendar, "utf8")).replace("2026-01-01", "2026-02-30"), "utf8");
    const invalid = await run(["validate", "--json", "--root", root]);
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.output).errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DATE_INVALID" })]));
  });

  it("preserves UTF-8 Cyrillic content independently of the Windows code page", async () => {
    const root = await fixture();
    const file = path.join(root, "projects", "P-26-8S9HQQ", "project.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("name: Operations", "name: Локальный проект"), "utf8");

    expect((await run(["format", "--root", root])).exitCode).toBe(0);
    expect(await readFile(file, "utf8")).toContain("name: Локальный проект");
    expect(JSON.parse((await run(["validate", "--json", "--root", root])).output)).toMatchObject({ ok: true, code: "OK" });
  });

  it("provides semantic diff skeleton and doctor output", async () => {
    const diff = await run(["diff", "--semantic", "--json", "--root", demo]);
    expect(JSON.parse(diff.output)).toMatchObject({ ok: true, changed_files_count: 0, affected_projects: [] });
    const doctor = await run(["doctor", "--json", "--root", demo]);
    expect(JSON.parse(doctor.output)).toMatchObject({ ok: true, checks: { node_20: true, repository_valid: true, schemas_loaded: true } });
  });
});

describe("CLI P12 agent commands", () => {
  it("routes external draft, scoped diff, commit-all, push and MR with stable JSON", async () => {
    const metadata = { version: 1 as const, draft_id: "DRF-AGENT", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-AGENT", base_commit: "a".repeat(40), worktree_path: demo, writer_mode: "external" as const, state: "open" as const, fingerprint: "b".repeat(64), created_at: "2026-07-11T00:00:00.000Z", updated_at: "2026-07-11T00:00:00.000Z" };
    const agent = {
      createDraft: async () => metadata, openDraft: async () => metadata, status: async () => metadata, setWriterMode: async () => metadata,
      createEntity: async (_draftId: string, document: GitPmDocument) => ({ path: `people/${String(document.id)}.yaml`, draft_fingerprint: "f".repeat(64), document }),
      assertScope: async () => ({ affected_projects: [metadata.draft_id], changed_files: [] }),
      semanticDiff: async () => ({ created: [], updated: [{ id: "P-26-111111", schema: "gitpm/project@1", path: "project.yaml", fields: [{ field: "name", before: "Old", after: "New" }] }], archived: [], deleted: [], counts: { created: 0, updated: 1, archived: 0, deleted: 0 }, affected_projects: ["P-26-111111"], unclassified_files: [] }),
      commitAll: async () => ({ commit: "c".repeat(40), branch: metadata.branch, draft_fingerprint: "d".repeat(64) }),
      push: async () => ({ branch: metadata.branch, commit: "c".repeat(40) }),
      createMergeRequest: async () => ({ iid: 7, state: "opened" as const, source_branch: metadata.branch, target_branch: "main", web_url: "https://gitlab.example.test/mr/7" }),
    } as unknown as AgentWorkflow;
    const inputRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-cli-entity-"));
    roots.push(inputRoot);
    const entityFile = path.join(inputRoot, "person.yaml");
    await writeFile(entityFile, [
      "schema: gitpm/person@1",
      "id: U-26-KB9RXB",
      "name: Елена Соколова",
      "weekly_capacity_hours: 40",
      "calendar: C-26-QD7FJ4",
      "lifecycle: active",
      "email: elena.sokolova@example.test",
      "",
    ].join("\n"), "utf8");
    expect(JSON.parse((await run(["draft", "open", "--draft", "DRF-AGENT", "--owner", "42", "--json"], process.cwd(), { agent })).output)).toMatchObject({ ok: true, draft: { writer_mode: "external" } });
    expect(JSON.parse((await run(["entity", "create", "--draft", "DRF-AGENT", "--file", entityFile, "--json"], process.cwd(), { agent })).output)).toMatchObject({
      ok: true,
      path: "people/U-26-KB9RXB.yaml",
      document: { schema: "gitpm/person@1", name: "Елена Соколова" },
    });
    expect(JSON.parse((await run(["diff", "--semantic", "--draft", "DRF-AGENT", "--project", "P-26-111111", "--json"], process.cwd(), { agent })).output)).toMatchObject({ ok: true, counts: { updated: 1 } });
    expect(JSON.parse((await run(["commit", "--all", "-m", "Agent update", "--draft", "DRF-AGENT", "--project", "P-26-111111", "--json"], process.cwd(), { agent })).output)).toMatchObject({ ok: true, commit: "c".repeat(40) });
    expect(JSON.parse((await run(["push", "--draft", "DRF-AGENT", "--json"], process.cwd(), { agent })).output)).toMatchObject({ ok: true, branch: metadata.branch });
    expect(JSON.parse((await run(["mr", "create", "--draft", "DRF-AGENT", "--owner", "42", "--title", "Agent update", "--json"], process.cwd(), { agent })).output)).toMatchObject({ ok: true, merge_request: { iid: 7 } });
  });

  it("requires explicit commit-all and configured agent runtime", async () => {
    expect(JSON.parse((await run(["commit", "-m", "partial", "--json"])).output)).toMatchObject({ code: "CLI_USAGE" });
    expect(JSON.parse((await run(["entity", "create", "--draft", "DRF-X", "--file", "missing.yaml", "--json"])).output)).toMatchObject({ code: "CLI_AGENT_CONFIGURATION_REQUIRED" });
    expect(JSON.parse((await run(["draft", "status", "--draft", "DRF-X", "--json"])).output)).toMatchObject({ code: "CLI_AGENT_CONFIGURATION_REQUIRED" });
  });
});

describe("CLI init command", () => {
  it("creates a valid schema v1 skeleton in an empty directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-init-"));
    roots.push(root);
    const target = path.join(root, "portfolio");
    const init = await run(["init", target, "--json"], root);
    expect(init.exitCode).toBe(0);
    const initPayload = JSON.parse(init.output);
    expect(initPayload).toMatchObject({ ok: true, code: "OK" });
    expect(initPayload.commit).toMatch(/^[0-9a-f]{40}$/u);

    const validate = await run(["validate", "--json", "--root", target]);
    expect(validate.exitCode).toBe(0);
    expect(JSON.parse(validate.output)).toMatchObject({ ok: true, code: "OK", documentCount: 4 });

    const doctor = await run(["doctor", "--json", "--root", target]);
    expect(JSON.parse(doctor.output)).toMatchObject({ ok: true, checks: { repository_valid: true, schemas_loaded: true } });
  });

  it("rejects a non-empty target directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-init-busy-"));
    roots.push(root);
    await writeFile(path.join(root, "leftover.txt"), "noise", "utf8");
    const result = await run(["init", root, "--json"], root);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, code: "INIT_TARGET_NOT_EMPTY" });
  });
});

describe("CLI direct mode", () => {
  it("status reports direct mode, checkout path, branch, HEAD and clean state without --draft", async () => {
    const { direct } = await directFixture();
    const result = await run(["status", "--json"], process.cwd(), { direct });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.output);
    expect(payload).toMatchObject({ ok: true, code: "OK", status: { mode: "direct", branch: "main", dirty: false, ahead: 0, behind: 0 } });
    expect(payload.status.head).toMatch(/^[0-9a-f]{40}$/u);
    expect(payload.status.path).toBe(path.resolve(direct.checkoutPath));
  });

  it("commit --all validates and commits onto main without --draft", async () => {
    const { direct, data } = await directFixture();
    await run(["status", "--json"], process.cwd(), { direct });
    const projectFile = path.join(data, "repository", "projects", "P-26-MGP84K", "project.yaml");
    await writeFile(projectFile, (await readFile(projectFile, "utf8")).replace("name: GitPM launch", "name: CLI direct"), "utf8");
    const result = await run(["commit", "--all", "-m", "cli direct commit", "--json"], process.cwd(), { direct });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, code: "OK", branch: "main" });
    expect(await git(path.join(data, "repository"), "log", "-1", "--format=%s")).toBe("cli direct commit");
  });

  it("push publishes main to origin without --draft and refuses force push", async () => {
    const { direct, data, remote } = await directFixture();
    await run(["status", "--json"], process.cwd(), { direct });
    const projectFile = path.join(data, "repository", "projects", "P-26-MGP84K", "project.yaml");
    await writeFile(projectFile, (await readFile(projectFile, "utf8")).replace("name: GitPM launch", "name: Pushed"), "utf8");
    await run(["commit", "--all", "-m", "push me", "--json"], process.cwd(), { direct });
    const push = await run(["push", "--json"], process.cwd(), { direct });
    expect(push.exitCode).toBe(0);
    const payload = JSON.parse(push.output);
    expect(payload).toMatchObject({ ok: true, code: "OK", branch: "main" });
    expect(await git(remote, "rev-parse", "main")).toBe(payload.commit);
  });

  it("format/validate/diff operate on the managed checkout by default without --draft", async () => {
    const { direct } = await directFixture();
    await run(["status", "--json"], process.cwd(), { direct });
    const format = await run(["format", "--json"], process.cwd(), { direct });
    expect(format.exitCode).toBe(0);
    expect(JSON.parse(format.output)).toMatchObject({ ok: true, code: "OK" });
    const validate = await run(["validate", "--json"], process.cwd(), { direct });
    expect(validate.exitCode).toBe(0);
    expect(JSON.parse(validate.output)).toMatchObject({ ok: true, code: "OK" });
    const diff = await run(["diff", "--semantic", "--json"], process.cwd(), { direct });
    expect(diff.exitCode).toBe(0);
  });

  it("requires direct runtime configuration for direct commands", async () => {
    expect(JSON.parse((await run(["status", "--json"])).output)).toMatchObject({ code: "CLI_DIRECT_CONFIGURATION_REQUIRED" });
    expect(JSON.parse((await run(["commit", "--all", "-m", "x", "--json"])).output)).toMatchObject({ code: "CLI_DIRECT_CONFIGURATION_REQUIRED" });
    expect(JSON.parse((await run(["push", "--json"])).output)).toMatchObject({ code: "CLI_DIRECT_CONFIGURATION_REQUIRED" });
  });
});
