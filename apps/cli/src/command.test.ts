import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

async function directFixture(): Promise<{ root: string; checkout: string; remote: string; data: string; direct: DirectCliRuntime }> {
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
    remoteUrl: source,
    defaultBranch: "main",
    authorName: "GitPM Direct CLI",
    authorEmail: "direct@example.test",
    allowLocalRepository: true,
    allowLocalTestRemote: true,
    askPassPath: path.resolve("scripts", "git-askpass.mjs"),
    pushAccessToken: "unused-local-token",
  });
  return { root, checkout: source, remote, data, direct };
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("CLI P02 commands", () => {
  it("prints a stable version", async () => {
    expect(await run(["--version"])).toEqual({ exitCode: 0, output: "0.1.0" });
    expect(JSON.parse((await run(["--version", "--json"])).output)).toMatchObject({ ok: true, version: "0.1.0", repository_schema: 1, schema_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) });
  });

  it("provides command help and inspectable schemas without runtime configuration", async () => {
    const help = await run(["entity", "create", "--help", "--json"]);
    expect(help.exitCode).toBe(0);
    expect(JSON.parse(help.output)).toMatchObject({ ok: true, command: "entity", help: expect.stringContaining("default_calendar") });
    const schema = await run(["schema", "show", "person", "--json"]);
    expect(JSON.parse(schema.output)).toMatchObject({ ok: true, name: "person", required: expect.arrayContaining(["calendar", "weekly_capacity_hours"]), optional: expect.arrayContaining(["email"]) });
    expect((await run(["schema", "show", "person", "--example"])).output).toContain("schema: gitpm/person@1");
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
      updateEntity: async (_draftId: string, patch: GitPmDocument, type: string, id: string) => ({ path: `${type}/${id}.yaml`, draft_fingerprint: "e".repeat(64), document: { ...patch, id } }),
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
    expect(JSON.parse((await run(["entity", "update", "--draft", "DRF-AGENT", "--type", "person", "--id", "U-26-KB9RXB", "--set", "email=new-elena@example.test", "--set", "weekly_capacity_hours=36", "--set", "labels=[backend, urgent]", "--json"], process.cwd(), { agent })).output)).toMatchObject({
      ok: true,
      code: "OK",
      path: "person/U-26-KB9RXB.yaml",
      document: { id: "U-26-KB9RXB", email: "new-elena@example.test", weekly_capacity_hours: 36, labels: ["backend", "urgent"] },
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

    expect(await readFile(path.join(target, ".gitignore"), "utf8")).toContain("/uploads/*");
    expect(await readFile(path.join(target, "uploads", ".gitkeep"), "utf8")).toBe("");
    expect((await git(target, "ls-files")).split(/\r?\n/u)).toEqual(expect.arrayContaining([".gitignore", "uploads/.gitkeep"]));
    expect(await git(target, "check-ignore", "uploads/incoming-report.pdf")).toBe("uploads/incoming-report.pdf");
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
  it("generates Person identity, applies defaults and imports CSV atomically", async () => {
    const { direct, checkout } = await directFixture();
    const inputRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-cli-import-"));
    roots.push(inputRoot);
    const personFile = path.join(inputRoot, "person.yaml");
    await writeFile(personFile, "name: Generated Person\nweekly_capacity_hours: 35\nemail: generated@example.test\n", "utf8");
    const created = await run(["entity", "create", "--type", "person", "--file", personFile, "--json"], process.cwd(), { direct });
    expect(created.exitCode).toBe(0);
    const createdPayload = JSON.parse(created.output);
    expect(createdPayload.document).toMatchObject({ schema: "gitpm/person@1", name: "Generated Person", calendar: "C-26-QD7FJ4", lifecycle: "active" });
    expect(createdPayload.document.id).toMatch(/^U-\d{2}-[0-9A-HJKMNP-TV-Z]{6}$/u);

    const peopleDirectory = path.join(checkout, "people");
    const baseline = (await readdir(peopleDirectory)).length;
    const dryFile = path.join(inputRoot, "dry.csv");
    await writeFile(dryFile, "name,email,weekly_capacity_hours\nDry One,dry1@example.test,40\nDry Two,dry2@example.test,32\n", "utf8");
    const dry = await run(["entity", "import", "--type", "person", "--format", "csv", "--file", dryFile, "--dry-run", "--json"], process.cwd(), { direct });
    expect(JSON.parse(dry.output)).toMatchObject({ ok: true, dry_run: true, items: [{ row: 2 }, { row: 3 }] });
    expect(await readdir(peopleDirectory)).toHaveLength(baseline);

    const invalidFile = path.join(inputRoot, "invalid.csv");
    await writeFile(invalidFile, "name,email,weekly_capacity_hours\nDuplicate One,duplicate@example.test,40\nDuplicate Two,DUPLICATE@example.test,40\n", "utf8");
    const invalid = await run(["entity", "import", "--type", "person", "--format", "csv", "--file", invalidFile, "--json"], process.cwd(), { direct });
    expect(JSON.parse(invalid.output)).toMatchObject({ ok: false, code: "VALIDATION_FAILED", details: expect.arrayContaining([expect.objectContaining({ code: "PERSON_EMAIL_DUPLICATE" })]) });
    expect(await readdir(peopleDirectory)).toHaveLength(baseline);

    const imported = await run(["entity", "bulk-import", "--schema", "person", "--format", "csv", "--path", dryFile, "--json"], process.cwd(), { direct });
    expect(JSON.parse(imported.output)).toMatchObject({ ok: true, dry_run: false, items: [{ row: 2 }, { row: 3 }] });
    expect(await readdir(peopleDirectory)).toHaveLength(baseline + 2);
  });

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
    const { direct, checkout } = await directFixture();
    await run(["status", "--json"], process.cwd(), { direct });
    const projectFile = path.join(checkout, "projects", "P-26-MGP84K", "project.yaml");
    await writeFile(projectFile, (await readFile(projectFile, "utf8")).replace("name: GitPM launch", "name: CLI direct"), "utf8");
    const result = await run(["commit", "--all", "-m", "cli direct commit", "--json"], process.cwd(), { direct });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, code: "OK", branch: "main" });
    expect(await git(checkout, "log", "-1", "--format=%s")).toBe("cli direct commit");
  });

  it("push publishes main to origin without --draft and refuses force push", async () => {
    const { direct, checkout, remote } = await directFixture();
    await run(["status", "--json"], process.cwd(), { direct });
    const projectFile = path.join(checkout, "projects", "P-26-MGP84K", "project.yaml");
    await writeFile(projectFile, (await readFile(projectFile, "utf8")).replace("name: GitPM launch", "name: Pushed"), "utf8");
    await run(["commit", "--all", "-m", "push me", "--json"], process.cwd(), { direct });
    const push = await run(["push", "--json"], process.cwd(), { direct });
    expect(push.exitCode).toBe(0);
    const payload = JSON.parse(push.output);
    expect(payload).toMatchObject({ ok: true, code: "OK", branch: "main" });
    expect(await git(remote, "rev-parse", "main")).toBe(payload.commit);
  });

  it("format/validate/diff operate on the selected checkout by default without --draft", async () => {
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

  it("creates an entity, reports its semantic diff and commits it without --draft", async () => {
    const { direct, checkout } = await directFixture();
    const inputRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-cli-direct-entity-"));
    roots.push(inputRoot);
    const entityFile = path.join(inputRoot, "task.yaml");
    await writeFile(entityFile, [
      "schema: gitpm/task@1",
      "id: T-26-FM5Q4W",
      "project: P-26-MGP84K",
      "title: Direct CLI task",
      "type: task",
      "status: backlog",
      "lifecycle: active",
      "",
    ].join("\n"), "utf8");

    const created = await run(["entity", "create", "--file", entityFile, "--project", "P-26-MGP84K", "--json"], process.cwd(), { direct });
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.output)).toMatchObject({
      ok: true,
      code: "OK",
      path: "projects/P-26-MGP84K/tasks/T-26-FM5Q4W.yaml",
      document: { id: "T-26-FM5Q4W", title: "Direct CLI task" },
    });
    await expect(readFile(path.join(checkout, "projects", "P-26-MGP84K", "tasks", "T-26-FM5Q4W.yaml"), "utf8"))
      .resolves.toContain("title: Direct CLI task");

    const diff = await run(["diff", "--semantic", "--project", "P-26-MGP84K", "--json"], process.cwd(), { direct });
    expect(JSON.parse(diff.output)).toMatchObject({
      ok: true,
      code: "OK",
      counts: { created: 1, updated: 0, archived: 0, deleted: 0 },
      affected_projects: ["P-26-MGP84K"],
      created: [expect.objectContaining({ id: "T-26-FM5Q4W" })],
    });

    const commit = await run(["commit", "--all", "-m", "direct entity", "--project", "P-26-MGP84K", "--json"], process.cwd(), { direct });
    expect(commit.exitCode).toBe(0);
    expect(await git(checkout, "log", "-1", "--format=%s")).toBe("direct entity");
  });

  it("updates entity fields inline, preserves other fields and rolls back invalid patches", async () => {
    const { direct, checkout } = await directFixture();
    const personPath = path.join(checkout, "people", "U-26-5EBAE3.yaml");
    const updated = await run([
      "entity", "update", "--type", "person", "--id", "U-26-5EBAE3",
      "--set", "name=Анна Петрова", "--set", "email=anna.new@example.test", "--set", "weekly_capacity_hours=36", "--json",
    ], process.cwd(), { direct });
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(updated.output)).toMatchObject({
      ok: true,
      code: "OK",
      path: "people/U-26-5EBAE3.yaml",
      document: { id: "U-26-5EBAE3", name: "Анна Петрова", email: "anna.new@example.test", weekly_capacity_hours: 36, calendar: "C-26-QD7FJ4", lifecycle: "active" },
    });
    await expect(readFile(personPath, "utf8")).resolves.toContain("email: anna.new@example.test");

    const removed = await run(["entity", "update", "--type", "person", "--id", "U-26-5EBAE3", "--unset", "email", "--json"], process.cwd(), { direct });
    expect(JSON.parse(removed.output).document).not.toHaveProperty("email");
    await expect(readFile(personPath, "utf8")).resolves.not.toContain("email:");

    const beforeInvalid = await readFile(personPath, "utf8");
    const invalid = await run(["entity", "update", "--type", "person", "--id", "U-26-5EBAE3", "--set", "weekly_capacity_hours=-1", "--json"], process.cwd(), { direct });
    expect(JSON.parse(invalid.output)).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    expect(await readFile(personPath, "utf8")).toBe(beforeInvalid);

    const scoped = await run(["entity", "update", "--type", "person", "--id", "U-26-5EBAE3", "--set", "email=scoped@example.test", "--project", "P-26-MGP84K", "--json"], process.cwd(), { direct });
    expect(JSON.parse(scoped.output)).toMatchObject({ ok: false, code: "AGENT_SCOPE_VIOLATION" });
    expect(await readFile(personPath, "utf8")).toBe(beforeInvalid);
  });

  it("enforces Project scope and rolls back invalid direct entity creation", async () => {
    const { direct, checkout } = await directFixture();
    const inputRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-cli-direct-invalid-"));
    roots.push(inputRoot);
    const globalEntity = path.join(inputRoot, "person.yaml");
    await writeFile(globalEntity, [
      "schema: gitpm/person@1",
      "id: U-26-KB9RXB",
      "name: Outside project scope",
      "weekly_capacity_hours: 40",
      "calendar: C-26-QD7FJ4",
      "lifecycle: active",
      "",
    ].join("\n"), "utf8");
    const scoped = await run(["entity", "create", "--file", globalEntity, "--project", "P-26-MGP84K", "--json"], process.cwd(), { direct });
    expect(JSON.parse(scoped.output)).toMatchObject({ ok: false, code: "AGENT_SCOPE_VIOLATION" });
    await expect(readFile(path.join(checkout, "people", "U-26-KB9RXB.yaml"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const invalidEntity = path.join(inputRoot, "invalid-task.yaml");
    await writeFile(invalidEntity, [
      "schema: gitpm/task@1",
      "id: T-26-FM5Q4W",
      "project: P-26-MGP84K",
      "title: Invalid direct task",
      "type: task",
      "status: missing-status",
      "lifecycle: active",
      "",
    ].join("\n"), "utf8");
    const invalid = await run(["entity", "create", "--file", invalidEntity, "--project", "P-26-MGP84K", "--json"], process.cwd(), { direct });
    expect(JSON.parse(invalid.output)).toMatchObject({ ok: false, code: "VALIDATION_FAILED" });
    await expect(readFile(path.join(checkout, "projects", "P-26-MGP84K", "tasks", "T-26-FM5Q4W.yaml"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks out-of-scope changes and requires explicit deletion confirmation", async () => {
    const { direct, checkout } = await directFixture();
    await direct.prepare();
    const otherProject = path.join(checkout, "projects", "P-26-8S9HQQ", "project.yaml");
    const otherProjectOriginal = await readFile(otherProject, "utf8");
    await writeFile(otherProject, otherProjectOriginal.replace("name: Operations", "name: Outside scope"), "utf8");
    const scoped = await run(["diff", "--semantic", "--project", "P-26-MGP84K", "--json"], process.cwd(), { direct });
    expect(JSON.parse(scoped.output)).toMatchObject({ ok: false, code: "AGENT_SCOPE_VIOLATION" });
    const commit = await run(["commit", "--all", "-m", "must not commit", "--project", "P-26-MGP84K", "--json"], process.cwd(), { direct });
    expect(JSON.parse(commit.output)).toMatchObject({ ok: false, code: "AGENT_SCOPE_VIOLATION" });
    expect(await git(checkout, "log", "-1", "--format=%s")).not.toBe("must not commit");

    await writeFile(otherProject, otherProjectOriginal, "utf8");
    const deleted = path.join(checkout, "projects", "P-26-MGP84K", "tasks", "T-26-RHBNH8.yaml");
    await rm(deleted);
    const blocked = await run(["diff", "--semantic", "--project", "P-26-MGP84K", "--json"], process.cwd(), { direct });
    expect(JSON.parse(blocked.output)).toMatchObject({ ok: false, code: "AGENT_DELETE_CONFIRMATION_REQUIRED" });
    const allowed = await run(["diff", "--semantic", "--project", "P-26-MGP84K", "--allow-delete", "--json"], process.cwd(), { direct });
    expect(JSON.parse(allowed.output)).toMatchObject({ ok: true, counts: { deleted: 1 } });
  });

  it("requires direct runtime configuration for direct commands", async () => {
    expect(JSON.parse((await run(["status", "--json"])).output)).toMatchObject({ code: "CLI_DIRECT_CONFIGURATION_REQUIRED" });
    expect(JSON.parse((await run(["commit", "--all", "-m", "x", "--json"])).output)).toMatchObject({ code: "CLI_DIRECT_CONFIGURATION_REQUIRED" });
    expect(JSON.parse((await run(["push", "--json"])).output)).toMatchObject({ code: "CLI_DIRECT_CONFIGURATION_REQUIRED" });
  });
});
