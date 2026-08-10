import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { run } from "./command.js";
import { DirectCliRuntime } from "./direct-runtime.js";
import type { AgentWorkflow } from "@gitpm/agent";
import type { GitPmDocument } from "@gitpm/repository-format";

const execFileAsync = promisify(execFile);
const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");
let directTemplateRoot: string;
let directTemplateSource: string;

function removeAfterTest(root: string): void {
  onTestFinished(async () => rm(root, { recursive: true, force: true }));
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-cli-"));
  removeAfterTest(root);
  await cp(demo, root, { recursive: true });
  return root;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return stdout.trim();
}

beforeAll(async () => {
  directTemplateRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-cli-direct-template-"));
  directTemplateSource = path.join(directTemplateRoot, "source");
  await cp(demo, directTemplateSource, { recursive: true });
  await git(directTemplateSource, "init", "-b", "main");
  await git(directTemplateSource, "add", ".");
  await git(directTemplateSource, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "initial portfolio");
});

afterAll(async () => rm(directTemplateRoot, { recursive: true, force: true }));

async function directFixture(options: { withRemote?: boolean } = {}): Promise<{
  root: string;
  checkout: string;
  remote?: string;
  data: string;
  direct: DirectCliRuntime;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-cli-direct-"));
  removeAfterTest(root);
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  const data = path.join(root, "data");
  await cp(directTemplateSource, source, { recursive: true });
  if (options.withRemote === true) {
    await git(root, "init", "--bare", remote);
    await git(source, "remote", "add", "origin", remote);
    await git(source, "push", "-u", "origin", "main");
  }
  const direct = new DirectCliRuntime({
    dataDirectory: data,
    checkoutPath: source,
    defaultBranch: "main",
    authorName: "GitPM Direct CLI",
    authorEmail: "direct@example.test",
    allowLocalRepository: true,
    allowLocalTestRemote: true,
    askPassPath: path.resolve("scripts", "git-askpass.mjs"),
    pushAccessToken: "unused-local-token",
  });
  return {
    root,
    checkout: source,
    ...(options.withRemote === true ? { remote } : {}),
    data,
    direct,
  };
}

describe("CLI P02 commands", () => {
  it("reports workload consistently and excludes Tasks after their Project is archived", async () => {
    const { direct } = await directFixture();
    const before = JSON.parse((await run(["workload", "report", "--json"], process.cwd(), { direct })).output);
    expect(before).toMatchObject({ ok: true, report: { included_tasks: 1, exclusions: { archived: 0 } } });

    const archived = await run(["entity", "archive", "--type", "projects", "--id", "P-26-MGP84K", "--json"], process.cwd(), { direct });
    expect(archived.exitCode).toBe(0);
    const after = JSON.parse((await run(["workload", "report", "--json"], process.cwd(), { direct })).output);
    expect(after).toMatchObject({ report: { included_tasks: 0, weeks: [], rows: [], exclusions: { archived: 2 } } });
  }, 120_000);

  it("archives and restores a Milestone with its Tasks through lifecycle flags", async () => {
    const { direct } = await directFixture();
    const invoke = async (args: string[]) => JSON.parse((await run([...args, "--json"], process.cwd(), { direct })).output);

    expect(await invoke(["entity", "archive", "--type", "milestones", "--id", "M-26-461GDJ", "--include-tasks"])).toMatchObject({
      ok: true,
      document: { lifecycle: "archived" },
    });
    expect(await invoke(["entity", "show", "--type", "tasks", "--id", "T-26-P9G3P8"])).toMatchObject({
      document: { lifecycle: "archived" },
    });
    expect(await invoke(["entity", "restore", "--type", "milestones", "--id", "M-26-461GDJ", "--include-tasks"])).toMatchObject({
      ok: true,
      document: { lifecycle: "active" },
    });
    expect(await invoke(["entity", "show", "--type", "tasks", "--id", "T-26-P9G3P8"])).toMatchObject({
      document: { lifecycle: "active" },
    });
  }, 120_000);

  it("prints a stable version", async () => {
    expect(await run(["--version"])).toEqual({ exitCode: 0, output: "0.1.0" });
    expect(JSON.parse((await run(["--version", "--json"])).output)).toMatchObject({ ok: true, version: "0.1.0", repository_schema: 1, schema_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) });
  });

  it("provides command help and inspectable schemas without runtime configuration", async () => {
    const help = await run(["entity", "create", "--help", "--json"]);
    expect(help.exitCode).toBe(0);
    const entityHelp = JSON.parse(help.output);
    expect(entityHelp).toMatchObject({ ok: true, command: "entity", help: expect.stringContaining("default_calendar") });
    for (const action of ["create", "update", "import", "archive"]) {
      expect(entityHelp.help).toMatch(new RegExp(`entity ${action}.*--allow-delete`, "u"));
    }
    const configHelp = JSON.parse((await run(["config", "--help", "--json"])).output) as { help: string };
    expect(configHelp.help).toMatch(/config update.*--allow-delete/u);
    expect(configHelp.help).toContain("repository|statuses|issue-types|work-categories|schedule-tracks");
    for (const command of ["format", "validate", "diff", "commit"]) {
      const commandHelp = JSON.parse((await run([command, "--help", "--json"])).output) as { help: string };
      expect(commandHelp.help).toContain("--allow-delete");
    }
    const schema = await run(["schema", "show", "person", "--json"]);
    expect(JSON.parse(schema.output)).toMatchObject({ ok: true, name: "person", required: expect.arrayContaining(["calendar", "weekly_capacity_hours"]), optional: expect.arrayContaining(["email"]) });
    expect((await run(["schema", "show", "person", "--example"])).output).toContain("schema: gitpm/person@1");
  });

  it("checks and applies canonical formatting", async () => {
    const root = await fixture();
    const file = path.join(root, ".gitpm", "repository.yaml");
    const source = path.join(root, "uploads", "source.yaml");
    await writeFile(file, `# comment\n${await readFile(file, "utf8")}`, "utf8");
    await writeFile(source, "customer:  Acme\n", "utf8");
    const check = await run(["format", "--check", "--json", "--root", root]);
    expect(check.exitCode).toBe(1);
    expect(JSON.parse(check.output)).toMatchObject({ code: "FORMAT_REQUIRED", changed_files: [".gitpm/repository.yaml"] });
    expect((await run(["format", "--root", root])).exitCode).toBe(0);
    expect((await run(["format", "--check", "--root", root])).exitCode).toBe(0);
    expect(await readFile(file, "utf8")).not.toContain("# comment");
    expect(await readFile(source, "utf8")).toBe("customer:  Acme\n");
  });

  it("returns a neutral JSON validation report with stable codes", async () => {
    const valid = await run(["validate", "--json", "--root", demo]);
    expect(valid.exitCode).toBe(0);
    expect(JSON.parse(valid.output)).toMatchObject({ ok: true, code: "OK", documentCount: 18 });

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

  it("rejects semantic diff without a configured runtime and provides doctor output", async () => {
    const root = await fixture();
    const project = path.join(root, "projects", "P-26-MGP84K", "project.yaml");
    await writeFile(project, (await readFile(project, "utf8")).replace("name: GitPM launch", "name: Changed without runtime"), "utf8");
    const diff = await run(["diff", "--semantic", "--json", "--root", root]);
    expect(diff.exitCode).toBe(1);
    expect(JSON.parse(diff.output)).toMatchObject({ ok: false, code: "CLI_DIRECT_CONFIGURATION_REQUIRED" });
    const doctor = await run(["doctor", "--json", "--root", demo]);
    expect(JSON.parse(doctor.output)).toMatchObject({ ok: true, checks: { node_20: true, repository_valid: true, schemas_loaded: true } });
  });

  it("rejects unknown and duplicate options instead of silently ignoring them", async () => {
    const unknown = await run(["schema", "list", "--definitely-not-a-real-flag", "--json"]);
    expect(unknown.exitCode).toBe(1);
    expect(JSON.parse(unknown.output)).toMatchObject({ ok: false, code: "CLI_USAGE" });

    const duplicate = await run(["validate", "--root", demo, "--root", demo, "--json"]);
    expect(duplicate.exitCode).toBe(1);
    expect(JSON.parse(duplicate.output)).toMatchObject({ ok: false, code: "CLI_USAGE" });

    const disguised = await run(["validate", "--root", "--definitely-not-a-real-flag", "--json"]);
    expect(disguised.exitCode).toBe(1);
    expect(JSON.parse(disguised.output)).toMatchObject({ ok: false, code: "CLI_USAGE" });

    const initRoot = await run(["init", "--root", demo, "--json"]);
    expect(initRoot.exitCode).toBe(1);
    expect(JSON.parse(initRoot.output)).toMatchObject({ ok: false, code: "CLI_USAGE" });

    const positional = await run(["schema", "list", "ignored", "--json"]);
    expect(positional.exitCode).toBe(1);
    expect(JSON.parse(positional.output)).toMatchObject({ ok: false, code: "CLI_USAGE" });

    const version = await run(["--version", "--definitely-not-a-real-flag", "--json"]);
    expect(version.exitCode).toBe(2);
    expect(JSON.parse(version.output)).toMatchObject({ ok: false, code: "CLI_USAGE" });

    const help = await run(["help", "nonsense", "--json"]);
    expect(help.exitCode).toBe(2);
    expect(JSON.parse(help.output)).toMatchObject({ ok: false, code: "CLI_USAGE" });

    const conflictingRestore = await run(["entity", "restore", "--type", "tasks", "--id", "T-26-P9G3P8", "--include-tasks", "--restore-milestone", "--json"]);
    expect(conflictingRestore.exitCode).toBe(1);
    expect(JSON.parse(conflictingRestore.output)).toMatchObject({ ok: false, code: "CLI_USAGE" });
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
      semanticDiff: async () => ({ created: [], updated: [{ id: "P-26-111111", schema: "gitpm/project@2", path: "project.yaml", fields: [{ field: "name", before: "Old", after: "New" }] }], archived: [], deleted: [], counts: { created: 0, updated: 1, archived: 0, deleted: 0 }, affected_projects: ["P-26-111111"], unclassified_files: [] }),
      commitAll: async () => ({ commit: "c".repeat(40), branch: metadata.branch, draft_fingerprint: "d".repeat(64) }),
      push: async () => ({ branch: metadata.branch, commit: "c".repeat(40) }),
      createMergeRequest: async () => ({ iid: 7, state: "opened" as const, source_branch: metadata.branch, target_branch: "main", web_url: "https://gitlab.example.test/mr/7" }),
    } as unknown as AgentWorkflow;
    const inputRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-cli-entity-"));
    removeAfterTest(inputRoot);
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

  it("routes GUI-parity workflow and domain commands through the draft agent runtime", async () => {
    const metadata = { version: 1 as const, draft_id: "DRF-PARITY", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-PARITY", base_commit: "a".repeat(40), worktree_path: demo, writer_mode: "external" as const, state: "open" as const, fingerprint: "b".repeat(64), created_at: "2026-07-11T00:00:00.000Z", updated_at: "2026-07-11T00:00:00.000Z" };
    const cleaned: string[] = [];
    const task = { schema: "gitpm/task@2", id: "T-26-P9G3P8", project: "P-26-MGP84K", title: "Parity", type: "task", status: "backlog", lifecycle: "active" } as GitPmDocument;
    const project = { schema: "gitpm/project@2", id: "P-26-MGP84K", name: "Parity", lifecycle: "active", planning: { primary_track: "plan" } } as GitPmDocument;
    const configuration = { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "plan", title: "Plan", kind: "manual" }], defaults: { primary_track: "plan" } };
    const historyItem = { commit: "c".repeat(40), parents: [], author_name: "GitPM", author_email: "gitpm@example.test", authored_at: "2026-07-11T00:00:00.000Z", subject: "Initial" };
    const agent = {
      createDraft: async () => metadata, openDraft: async () => metadata, status: async () => metadata, setWriterMode: async () => metadata,
      assertScope: async () => ({ affected_projects: [], changed_files: [] }), semanticDiff: async () => ({ created: [], updated: [], archived: [], deleted: [], counts: { created: 0, updated: 0, archived: 0, deleted: 0 }, affected_projects: [], unclassified_files: [] }),
      commitAll: async () => ({ commit: "c".repeat(40), branch: metadata.branch, draft_fingerprint: metadata.fingerprint }), push: async () => ({ branch: metadata.branch, commit: "c".repeat(40) }),
      createMergeRequest: async () => ({ iid: 9, state: "opened" as const, source_branch: metadata.branch, target_branch: "main", web_url: "https://gitlab.example.test/mr/9" }),
      listDrafts: async () => [metadata], acknowledgeExternalChanges: async () => metadata, closeDraft: async () => ({ ...metadata, state: "closed" as const }), reopenDraft: async () => metadata,
      cleanupDraft: async (draftId: string) => { cleaned.push(draftId); },
      getConfiguration: async () => ({ document: configuration, path: ".gitpm/schedule-tracks.yaml", blob_id: "d".repeat(40), draft_fingerprint: metadata.fingerprint }),
      updateConfiguration: async (_draft: string, _kind: string, document: GitPmDocument) => ({ document, path: ".gitpm/schedule-tracks.yaml", blob_id: "d".repeat(40), draft_fingerprint: metadata.fingerprint }),
      getEntity: async (_draft: string, type: string) => ({ document: type === "projects" ? project : task, path: type === "projects" ? "projects/P-26-MGP84K/project.yaml" : "projects/P-26-MGP84K/tasks/T-26-P9G3P8.yaml", draft_fingerprint: metadata.fingerprint }),
      updateEntity: async (_draft: string, document: GitPmDocument, type: string) => ({ document, path: type === "projects" ? "projects/P-26-MGP84K/project.yaml" : "projects/P-26-MGP84K/tasks/T-26-P9G3P8.yaml", draft_fingerprint: metadata.fingerprint }),
      listComments: async () => [], createComment: async () => ({ document: { id: "N-26-AAAAAA", state: "active" }, path: "comment.yaml" }), updateComment: async () => ({ document: { id: "N-26-AAAAAA", state: "active" }, path: "comment.yaml" }), deleteComment: async () => ({ document: { id: "N-26-AAAAAA", state: "deleted" }, path: "comment.yaml" }),
      notifications: async () => ({ recipient_person_id: "U-26-5EBAE3", items: [] }),
      listProjectTimeEntries: async () => ({ items: [], total: 0, offset: 0, limit: 100 }), createTimeEntry: async () => ({ document: { id: "E-26-AAAAAA", state: "active" }, path: "entry.yaml" }), voidTimeEntry: async () => ({ document: { id: "E-26-AAAAAA", state: "voided" }, path: "entry.yaml" }),
      listChanges: async () => ({ files: [], changed_files_count: 0, affected_projects: [] }),
      historyList: async () => [historyItem], historyDetail: async () => ({ ...historyItem, body: "", files: [], semantic_summary: { created: 0, updated: 0, deleted: 0, affected_projects: [] } }), historyFileDiff: async () => ({ diff: "diff", oversized: false }), fileHistory: async () => [historyItem],
      createRevertDraft: async () => ({ draft: { ...metadata, draft_id: "DRF-REVERT" }, reverted_commit: historyItem.commit, conflicted: false, conflicted_files: [] }),
      mergeRequestStatus: async () => ({ iid: 9, state: "merged" as const, source_branch: metadata.branch, target_branch: "main", web_url: "https://gitlab.example.test/mr/9" }),
    } as unknown as AgentWorkflow;
    const invoke = async (args: string[]) => JSON.parse((await run([...args, "--json"], process.cwd(), { agent })).output);

    expect(await invoke(["draft", "list", "--owner", "42"])).toMatchObject({ ok: true, items: [{ draft_id: "DRF-PARITY" }] });
    expect(await invoke(["draft", "close", "--draft", "DRF-PARITY", "--owner", "42"])).toMatchObject({ draft: { state: "closed" } });
    expect(await invoke(["draft", "cleanup", "--draft", "DRF-PARITY", "--owner", "42", "--confirm", "DRF-PARITY"])).toMatchObject({ deleted: true });
    expect(cleaned).toEqual(["DRF-PARITY"]);
    expect(await invoke(["config", "show", "--draft", "DRF-PARITY", "--kind", "schedule-tracks"])).toMatchObject({ document: { schema: "gitpm/schedule-tracks@1" } });
    expect(await invoke(["comment", "list", "--draft", "DRF-PARITY", "--project", "P-26-MGP84K", "--task", "T-26-P9G3P8"])).toMatchObject({ items: [] });
    expect(await invoke(["notification", "list", "--draft", "DRF-PARITY", "--person", "U-26-5EBAE3"])).toMatchObject({ recipient_person_id: "U-26-5EBAE3" });
    expect(await invoke(["time-entry", "list", "--draft", "DRF-PARITY", "--project", "P-26-MGP84K"])).toMatchObject({ total: 0, items: [] });
    expect(await invoke(["schedule", "set", "--draft", "DRF-PARITY", "--type", "task", "--id", "T-26-P9G3P8", "--track", "plan", "--finish", "2026-09-01"])).toMatchObject({ document: { schedules: { plan: { finish: "2026-09-01" } } } });
    expect(await invoke(["planning", "set", "--draft", "DRF-PARITY", "--project", "P-26-MGP84K", "--workload-track", "plan"])).toMatchObject({ document: { planning: { workload_track: "plan" } } });
    expect(await invoke(["changes", "list", "--draft", "DRF-PARITY"])).toMatchObject({ changed_files_count: 0 });
    expect(await invoke(["history", "list", "--draft", "DRF-PARITY"])).toMatchObject({ items: [{ subject: "Initial" }] });
    expect(await invoke(["history", "revert", "--draft", "DRF-PARITY", "--commit", historyItem.commit, "--new-draft", "DRF-REVERT", "--owner", "42"])).toMatchObject({ draft: { draft_id: "DRF-REVERT" }, conflicted: false });
    expect(await invoke(["mr", "status", "--draft", "DRF-PARITY", "--owner", "42"])).toMatchObject({ merge_request: { iid: 9, state: "merged" } });
  });
});

describe("CLI init command", () => {
  it("creates a valid schema v1 skeleton in an empty directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-init-"));
    removeAfterTest(root);
    const target = path.join(root, "portfolio");
    const init = await run(["init", target, "--json"], root, {
      init: { now: () => new Date("2027-01-02T03:04:05Z"), randomIndex: () => 19 },
    });
    expect(init.exitCode).toBe(0);
    const initPayload = JSON.parse(init.output);
    expect(initPayload).toMatchObject({ ok: true, code: "OK" });
    expect(initPayload.commit).toMatch(/^[0-9a-f]{40}$/u);

    const validate = await run(["validate", "--json", "--root", target]);
    expect(validate.exitCode).toBe(0);
    expect(JSON.parse(validate.output)).toMatchObject({ ok: true, code: "OK", documentCount: 6 });

    const doctor = await run(["doctor", "--json", "--root", target]);
    expect(JSON.parse(doctor.output)).toMatchObject({ ok: true, checks: { repository_valid: true, schemas_loaded: true } });

    expect(await readFile(path.join(target, ".gitignore"), "utf8")).toContain("/uploads/*");
    expect(await readFile(path.join(target, ".ignore"), "utf8")).toBe(
      ["# Keep uploads searchable by ripgrep-based agent tools even though Git ignores them.", "!uploads/", "!uploads/**", ""].join("\n"),
    );
    expect(await readFile(path.join(target, "uploads", ".gitkeep"), "utf8")).toBe("");
    const trackedFiles = (await git(target, "ls-files")).split(/\r?\n/u);
    expect(trackedFiles).toEqual(expect.arrayContaining([".gitignore", ".ignore", "uploads/.gitkeep"]));
    expect(await git(target, "check-ignore", "uploads/incoming-report.pdf")).toBe("uploads/incoming-report.pdf");
    expect(await git(target, "status", "--porcelain")).toBe("");
    expect(await readFile(path.join(target, ".gitpm", "repository.yaml"), "utf8")).toContain("- .ignore");
    expect(await readFile(path.join(target, ".gitpm", "repository.yaml"), "utf8")).toContain("default_calendar: C-27-KKKKKK");
    expect(await readFile(path.join(target, "calendars", "C-27-KKKKKK.yaml"), "utf8")).toContain("id: C-27-KKKKKK");
    await expect(readFile(path.join(target, "calendars", "C-26-WRKDAY.yaml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("lets ripgrep discover uploads/ via .ignore when rg is available", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-init-rg-"));
    removeAfterTest(root);
    const target = path.join(root, "portfolio");
    const init = await run(["init", target, "--json"], root, {
      init: { now: () => new Date("2027-01-02T03:04:05Z"), randomIndex: () => 19 },
    });
    expect(init.exitCode).toBe(0);
    try {
      await execFileAsync("rg", ["--version"]);
    } catch {
      // ripgrep is not guaranteed in every CI image; the .ignore content is
      // asserted exactly in the skeleton test above.
      return;
    }
    const marker = "gitpmrgmarker9f3c7a";
    await writeFile(path.join(target, "uploads", "example.txt"), `${marker}\n`, "utf8");
    const { stdout } = await execFileAsync("rg", ["-F", marker, "."], { cwd: target, encoding: "utf8" });
    expect(stdout).toContain(marker);
  });

  it("rejects a non-empty target directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-init-busy-"));
    removeAfterTest(root);
    await writeFile(path.join(root, "leftover.txt"), "noise", "utf8");
    const result = await run(["init", root, "--json"], root);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, code: "INIT_TARGET_NOT_EMPTY" });
  });
});

describe.concurrent("CLI direct mode", () => {
  it.sequential("generates Person identity, applies defaults and imports CSV atomically", async () => {
    const { direct, checkout } = await directFixture();
    const inputRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-cli-import-"));
    removeAfterTest(inputRoot);
    const personFile = path.join(inputRoot, "person.yaml");
    await writeFile(personFile, "name: Generated Person\nweekly_capacity_hours: 35\nemail: generated@example.test\n", "utf8");
    const created = await run(["entity", "create", "--type", "person", "--file", personFile, "--json"], process.cwd(), { direct });
    expect(created.exitCode, created.output).toBe(0);
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

  it("rechecks the default branch after the direct runtime is already prepared", async () => {
    const { direct, checkout } = await directFixture();
    expect(JSON.parse((await run(["status", "--json"], process.cwd(), { direct })).output))
      .toMatchObject({ ok: true });
    await git(checkout, "checkout", "-b", "feature/not-main");

    const result = await run(["status", "--json"], process.cwd(), { direct });
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, code: "GIT_WRONG_BRANCH" });
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

  it("restores files from history and creates a reverse commit without moving main", async () => {
    const { direct, checkout } = await directFixture();
    const relativeProject = "projects/P-26-MGP84K/project.yaml";
    const projectFile = path.join(checkout, ...relativeProject.split("/"));
    await writeFile(projectFile, (await readFile(projectFile, "utf8")).replace("name: GitPM launch", "name: Historical CLI state"), "utf8");
    await git(checkout, "add", relativeProject);
    await git(checkout, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "historical CLI state");
    const historical = await git(checkout, "rev-parse", "HEAD");
    await writeFile(projectFile, (await readFile(projectFile, "utf8")).replace("name: Historical CLI state", "name: Current CLI state"), "utf8");
    await git(checkout, "add", relativeProject);
    await git(checkout, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "current CLI state");

    const restored = await run(["history", "restore", "--commit", historical, "--path", relativeProject, "--json"], process.cwd(), { direct });
    expect(JSON.parse(restored.output)).toMatchObject({ ok: true, restored_commit: historical, restored_paths: [relativeProject] });
    expect(await readFile(projectFile, "utf8")).toContain("name: Historical CLI state");
    await git(checkout, "restore", "--source=HEAD", "--worktree", "--", relativeProject);

    const notePath = "README.md";
    await writeFile(path.join(checkout, notePath), `${await readFile(path.join(checkout, notePath), "utf8")}\ntemporary direct note\n`, "utf8");
    await git(checkout, "add", notePath);
    await git(checkout, "-c", "user.name=GitPM Test", "-c", "user.email=gitpm@example.test", "commit", "-m", "temporary direct note");
    const noteCommit = await git(checkout, "rev-parse", "HEAD");
    const reversed = await run(["history", "revert", "--commit", noteCommit, "--message", "remove direct note", "--json"], process.cwd(), { direct });
    expect(reversed.exitCode, reversed.output).toBe(0);
    expect(JSON.parse(reversed.output)).toMatchObject({ ok: true, reverted_commit: noteCommit, branch: "main" });
    expect(await git(checkout, "log", "-1", "--format=%s")).toBe("remove direct note");
  }, 120_000);

  it("blocks commit when an unknown file is placed inside the domain layout", async () => {
    const { direct, checkout } = await directFixture();
    const unknown = path.join(checkout, "people", "payload.bin");
    await writeFile(unknown, "not domain data\n", "utf8");

    const result = await run(["commit", "--all", "-m", "must not commit", "--json"], process.cwd(), { direct });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      code: "VALIDATION_FAILED",
      details: expect.arrayContaining([
        expect.objectContaining({ code: "REPOSITORY_UNKNOWN_PATH", path: "people/payload.bin" }),
      ]),
    });
    expect(await git(checkout, "status", "--short", "--", "people/payload.bin")).toContain("??");
  });

  it("push publishes main to origin without --draft and refuses force push", async () => {
    const { direct, checkout, remote } = await directFixture({ withRemote: true });
    if (remote === undefined) throw new Error("remote fixture was not created");
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

  it("lists, creates, atomically replaces and voids a time entry through the CLI", async () => {
    const { direct } = await directFixture();
    const listBefore = await run(["time-entry", "list", "--project", "P-26-MGP84K", "--task", "T-26-P9G3P8", "--json"], process.cwd(), { direct });
    expect(listBefore.exitCode).toBe(0);
    expect(JSON.parse(listBefore.output).items.map((item: { id: string }) => item.id)).toContain("E-26-AAAAAA");

    const created = await run([
      "time-entry", "create", "--project", "P-26-MGP84K", "--task", "T-26-P9G3P8",
      "--person", "U-26-5EBAE3", "--date", "2026-09-01", "--hours", "2", "--category", "regular", "--json",
    ], process.cwd(), { direct });
    expect(created.exitCode).toBe(0);
    const createdId = JSON.parse(created.output).document.id as string;

    const replaced = await run([
      "time-entry", "replace", "--project", "P-26-MGP84K", "--task", "T-26-P9G3P8", "--id", createdId,
      "--person", "U-26-5EBAE3", "--date", "2026-09-01", "--hours", "2.5", "--category", "regular", "--note", "corrected", "--json",
    ], process.cwd(), { direct });
    expect(replaced.exitCode).toBe(0);
    const replacedPayload = JSON.parse(replaced.output) as { voided: { document: { state: string; replacement: string } }; created: { document: { id: string; state: string; hours: number } } };
    expect(replacedPayload.voided.document).toMatchObject({ state: "voided", replacement: replacedPayload.created.document.id });
    expect(replacedPayload.created.document).toMatchObject({ state: "active", hours: 2.5 });

    const voided = await run(["time-entry", "void", "--project", "P-26-MGP84K", "--task", "T-26-P9G3P8", "--id", replacedPayload.created.document.id, "--json"], process.cwd(), { direct });
    expect(voided.exitCode).toBe(0);
    expect(JSON.parse(voided.output).document.state).toBe("voided");

    const summary = await run(["time-entry", "summary", "--project", "P-26-MGP84K", "--task", "T-26-P9G3P8", "--after", "2026-09-01", "--json"], process.cwd(), { direct });
    expect(summary.exitCode).toBe(0);
    const payload = JSON.parse(summary.output).summary as { total_hours: number; hours_after: number; by_category: readonly (readonly [string, number])[] };
    expect(payload.total_hours).toBeGreaterThan(0);
    expect(payload.hours_after).toBeGreaterThanOrEqual(0);
    expect(payload.by_category.map(([slug]) => slug)).toContain("warranty");
  });

  it("updates one track, preserves neighboring windows, exposes project planning and lists project actuals", async () => {
    const { direct } = await directFixture();
    const scheduled = await run([
      "schedule", "set", "--type", "task", "--id", "T-26-P9G3P8", "--track", "plan",
      "--finish", "2026-07-03", "--clear-dependencies", "--json",
    ], process.cwd(), { direct });
    expect(scheduled.exitCode).toBe(0);
    const task = JSON.parse(scheduled.output).document as { schedules: Record<string, { finish?: string; depends_on?: string[] }> };
    const plan = task.schedules.plan!;
    expect(plan).toMatchObject({ finish: "2026-07-03" });
    expect(plan.depends_on).toBeUndefined();
    expect(task.schedules.target).toMatchObject({ finish: "2026-07-05" });

    const planning = await run(["planning", "set", "--project", "P-26-MGP84K", "--primary-track", "target", "--json"], process.cwd(), { direct });
    expect(planning.exitCode).toBe(0);
    expect(JSON.parse(planning.output).document.planning).toMatchObject({ primary_track: "target", workload_track: "plan" });

    const entries = await run(["time-entry", "list", "--project", "P-26-MGP84K", "--category", "warranty", "--limit", "1", "--json"], process.cwd(), { direct });
    expect(entries.exitCode).toBe(0);
    expect(JSON.parse(entries.output)).toMatchObject({ total: 1, offset: 0, limit: 1, items: [expect.objectContaining({ category: "warranty" })] });
  });

  it("creates an entity, reports its semantic diff and commits it without --draft", async () => {
    const { direct, checkout } = await directFixture();
    const inputRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-cli-direct-entity-"));
    removeAfterTest(inputRoot);
    const entityFile = path.join(inputRoot, "task.yaml");
    await writeFile(entityFile, [
      "schema: gitpm/task@2",
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
    removeAfterTest(inputRoot);
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
      "schema: gitpm/task@2",
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

    const updateArgs = ["entity", "update", "--type", "milestone", "--id", "M-26-461GDJ", "--set", "name=Updated after deletion", "--project", "P-26-MGP84K"];
    const blockedUpdate = await run([...updateArgs, "--json"], process.cwd(), { direct });
    expect(JSON.parse(blockedUpdate.output)).toMatchObject({ ok: false, code: "AGENT_DELETE_CONFIRMATION_REQUIRED" });
    const allowedUpdate = await run([...updateArgs, "--allow-delete", "--json"], process.cwd(), { direct });
    expect(JSON.parse(allowedUpdate.output)).toMatchObject({ ok: true, document: { name: "Updated after deletion" } });

    const configArgs = ["config", "update", "--kind", "statuses", "--set", "schema=gitpm/statuses@2"];
    const blockedConfig = await run([...configArgs, "--json"], process.cwd(), { direct });
    expect(JSON.parse(blockedConfig.output)).toMatchObject({ ok: false, code: "AGENT_DELETE_CONFIRMATION_REQUIRED" });
    const allowedConfig = await run([...configArgs, "--allow-delete", "--json"], process.cwd(), { direct });
    expect(JSON.parse(allowedConfig.output)).toMatchObject({ ok: true, document: { schema: "gitpm/statuses@2" } });

    const categoriesArgs = ["config", "update", "--kind", "work-categories", "--set", "schema=gitpm/work-categories@1"];
    const updatedCategories = await run([...categoriesArgs, "--allow-delete", "--json"], process.cwd(), { direct });
    expect(JSON.parse(updatedCategories.output)).toMatchObject({ ok: true, document: { schema: "gitpm/work-categories@1" } });
  });

  it("requires direct runtime configuration for direct commands", async () => {
    expect(JSON.parse((await run(["status", "--json"])).output)).toMatchObject({ code: "CLI_DIRECT_CONFIGURATION_REQUIRED" });
    expect(JSON.parse((await run(["commit", "--all", "-m", "x", "--json"])).output)).toMatchObject({ code: "CLI_DIRECT_CONFIGURATION_REQUIRED" });
    expect(JSON.parse((await run(["push", "--json"])).output)).toMatchObject({ code: "CLI_DIRECT_CONFIGURATION_REQUIRED" });
  });

  it("lists and shows entities without --draft", async () => {
    const { direct } = await directFixture();
    const people = await run(["entity", "list", "--type", "person", "--json"], process.cwd(), { direct });
    expect(people.exitCode).toBe(0);
    const peoplePayload = JSON.parse(people.output);
    expect(peoplePayload.items.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(["U-26-15QJP8", "U-26-5EBAE3"]));

    const tasks = await run(["entity", "list", "--type", "task", "--project", "P-26-MGP84K", "--json"], process.cwd(), { direct });
    expect(tasks.exitCode).toBe(0);
    const tasksPayload = JSON.parse(tasks.output);
    expect(tasksPayload.items.every((item: { path: string }) => item.path.startsWith("projects/P-26-MGP84K/"))).toBe(true);
    expect(tasksPayload.items.length).toBeGreaterThan(0);

    const shown = await run(["entity", "show", "--type", "person", "--id", "U-26-15QJP8", "--json"], process.cwd(), { direct });
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.output)).toMatchObject({ ok: true, document: { id: "U-26-15QJP8", name: "Boris Sokolov" }, path: "people/U-26-15QJP8.yaml" });

    const missing = await run(["entity", "show", "--type", "person", "--id", "U-99-ZZZZZZ", "--json"], process.cwd(), { direct });
    expect(JSON.parse(missing.output)).toMatchObject({ ok: false, code: "ENTITY_NOT_FOUND" });
  });

  it("previews delete impact with --dry-run without writing", async () => {
    const { direct, checkout } = await directFixture();
    const preview = await run(["entity", "delete", "--type", "person", "--id", "U-26-15QJP8", "--dry-run", "--json"], process.cwd(), { direct });
    expect(preview.exitCode).toBe(0);
    const payload = JSON.parse(preview.output);
    expect(payload).toMatchObject({ ok: true, dry_run: true, supports_unlink: true, would_be_restricted: true });
    expect(payload.restrictions.length).toBeGreaterThan(0);
    expect(payload.would_unlink.length).toBeGreaterThan(0);
    expect(payload.restrictions).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Core team" })]));
    await expect(readFile(path.join(checkout, "people", "U-26-15QJP8.yaml"), "utf8")).resolves.toBeDefined();
  });

  it("delete requires --allow-delete, reports DELETE_RESTRICTED, then unlinks references on confirm", async () => {
    const { direct, checkout } = await directFixture();
    const withoutAllowDelete = await run(["entity", "delete", "--type", "person", "--id", "U-26-15QJP8", "--unlink-references", "--json"], process.cwd(), { direct });
    expect(JSON.parse(withoutAllowDelete.output)).toMatchObject({ ok: false, code: "AGENT_DELETE_CONFIRMATION_REQUIRED" });

    const restricted = await run(["entity", "delete", "--type", "person", "--id", "U-26-15QJP8", "--allow-delete", "--json"], process.cwd(), { direct });
    expect(JSON.parse(restricted.output)).toMatchObject({ ok: false, code: "DELETE_RESTRICTED" });
    expect(JSON.parse(restricted.output).details.length).toBeGreaterThan(0);

    const deleted = await run(["entity", "delete", "--type", "person", "--id", "U-26-15QJP8", "--unlink-references", "--allow-delete", "--json"], process.cwd(), { direct });
    expect(deleted.exitCode).toBe(0);
    const payload = JSON.parse(deleted.output);
    expect(payload).toMatchObject({ ok: true, code: "OK", deleted: true, path: "people/U-26-15QJP8.yaml" });
    expect(payload.unlinked_paths.length).toBeGreaterThan(0);
    await expect(readFile(path.join(checkout, "people", "U-26-15QJP8.yaml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const teamFile = await readFile(path.join(checkout, "teams", "G-26-XB86WT.yaml"), "utf8");
    expect(teamFile).not.toContain("U-26-15QJP8");
  });

  it("previews and explicitly cascades project-owned entities on confirmed project deletion", async () => {
    const { direct, checkout } = await directFixture();
    const preview = await run(["entity", "delete", "--type", "project", "--id", "P-26-8S9HQQ", "--cascade-references", "--dry-run", "--json"], process.cwd(), { direct });
    expect(JSON.parse(preview.output)).toMatchObject({
      ok: true,
      dry_run: true,
      supports_cascade: true,
      cascaded_entities: [expect.objectContaining({ path: "projects/P-26-8S9HQQ/tasks/T-26-G2TG9R.yaml" })],
    });

    const restricted = await run(["entity", "delete", "--type", "project", "--id", "P-26-8S9HQQ", "--allow-delete", "--json"], process.cwd(), { direct });
    expect(JSON.parse(restricted.output)).toMatchObject({ ok: false, code: "DELETE_RESTRICTED" });

    const deleted = await run(["entity", "delete", "--type", "project", "--id", "P-26-8S9HQQ", "--cascade-references", "--allow-delete", "--json"], process.cwd(), { direct });
    expect(JSON.parse(deleted.output)).toMatchObject({
      ok: true,
      deleted: true,
      path: "projects/P-26-8S9HQQ/project.yaml",
      cascaded_paths: ["projects/P-26-8S9HQQ/tasks/T-26-G2TG9R.yaml"],
    });
    await expect(readFile(path.join(checkout, "projects", "P-26-8S9HQQ", "project.yaml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(checkout, "projects", "P-26-8S9HQQ", "tasks", "T-26-G2TG9R.yaml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("archives an entity and moves a task between projects", async () => {
    const { direct, checkout } = await directFixture();
    const archived = await run(["entity", "archive", "--type", "milestone", "--id", "M-26-461GDJ", "--json"], process.cwd(), { direct });
    expect(archived.exitCode).toBe(0);
    expect(JSON.parse(archived.output)).toMatchObject({ ok: true, code: "OK", document: { lifecycle: "archived" } });
    await expect(readFile(path.join(checkout, "projects", "P-26-MGP84K", "milestones", "M-26-461GDJ.yaml"), "utf8")).resolves.toContain("lifecycle: archived");
    const bypass = await run(["entity", "update", "--type", "milestone", "--id", "M-26-461GDJ", "--set", "lifecycle=active", "--json"], process.cwd(), { direct });
    expect(JSON.parse(bypass.output)).toMatchObject({ ok: false, code: "ENTITY_LIFECYCLE_OPERATION_REQUIRED" });
    const restored = await run(["entity", "restore", "--type", "milestone", "--id", "M-26-461GDJ", "--json"], process.cwd(), { direct });
    expect(restored.exitCode, restored.output).toBe(0);
    expect(JSON.parse(restored.output)).toMatchObject({ ok: true, code: "OK", document: { lifecycle: "active" } });

    const moved = await run([
      "entity", "move",
      "--type", "task",
      "--id", "T-26-G2TG9R",
      "--to-project", "P-26-MGP84K",
      "--to-milestone", "M-26-461GDJ",
      "--to-parent", "T-26-P9G3P8",
      "--allow-delete",
      "--json",
    ], process.cwd(), { direct });
    expect(moved.exitCode).toBe(0);
    const movePayload = JSON.parse(moved.output);
    expect(movePayload).toMatchObject({
      ok: true,
      path: "projects/P-26-MGP84K/tasks/T-26-G2TG9R.yaml",
      document: { project: "P-26-MGP84K", milestone: "M-26-461GDJ", parent: "T-26-P9G3P8" },
    });
    await expect(readFile(path.join(checkout, "projects", "P-26-MGP84K", "tasks", "T-26-G2TG9R.yaml"), "utf8")).resolves.toContain("Prepare operations");
    await expect(readFile(path.join(checkout, "projects", "P-26-8S9HQQ", "tasks", "T-26-G2TG9R.yaml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates, lists, updates and deletes comments", async () => {
    const { direct, checkout } = await directFixture();
    const created = await run(["comment", "create", "--project", "P-26-MGP84K", "--task", "T-26-P9G3P8", "--body", "Please review @[Anna Petrova](person:U-26-5EBAE3)", "--json"], process.cwd(), { direct });
    expect(created.exitCode).toBe(0);
    const createdPayload = JSON.parse(created.output);
    expect(createdPayload.document.state).toBe("active");
    expect(createdPayload.document.mentions).toEqual(expect.arrayContaining([expect.objectContaining({ person: "U-26-5EBAE3" })]));

    const listed = await run(["comment", "list", "--project", "P-26-MGP84K", "--task", "T-26-P9G3P8", "--json"], process.cwd(), { direct });
    expect(JSON.parse(listed.output).items).toHaveLength(1);

    const commentId = createdPayload.document.id;
    const updated = await run(["comment", "update", "--project", "P-26-MGP84K", "--task", "T-26-P9G3P8", "--id", commentId, "--body", "Updated text", "--json"], process.cwd(), { direct });
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(updated.output).document.body_markdown).toBe("Updated text");

    const deleted = await run(["comment", "delete", "--project", "P-26-MGP84K", "--task", "T-26-P9G3P8", "--id", commentId, "--json"], process.cwd(), { direct });
    expect(deleted.exitCode).toBe(0);
    expect(JSON.parse(deleted.output)).toMatchObject({ ok: true });
    expect(JSON.parse(deleted.output).document.state).toBe("deleted");
    expect(JSON.parse(deleted.output).document.body_markdown).toBeUndefined();

    const commentPath = path.join(checkout, ...createdPayload.path.split("/"));
    expect(await readFile(commentPath, "utf8")).toContain("state: deleted");
  });

  it("shows and updates every repository configuration including repository.yaml", async () => {
    const { direct, checkout } = await directFixture();
    const shown = await run(["config", "show", "--kind", "statuses", "--json"], process.cwd(), { direct });
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.output)).toMatchObject({ ok: true, document: { schema: "gitpm/statuses@2" } });

    const updated = await run(["config", "update", "--kind", "issue-types", "--set", "issue_types=[{slug: task, title: Task, color: blue, active: true}, {slug: bug, title: Defect, color: red, active: true}]", "--json"], process.cwd(), { direct });
    expect(updated.exitCode).toBe(0);
    const configPath = path.join(checkout, ".gitpm", "issue-types.yaml");
    const content = await readFile(configPath, "utf8");
    expect(content).toContain("title: Defect");

    const repositoryShown = await run(["config", "show", "--kind", "repository", "--json"], process.cwd(), { direct });
    expect(JSON.parse(repositoryShown.output)).toMatchObject({ ok: true, document: { schema: "gitpm/repository@1", default_calendar: "C-26-QD7FJ4" } });
    const repositoryUpdated = await run(["config", "update", "--kind", "repository", "--set", "ui_poll_interval_seconds=7", "--json"], process.cwd(), { direct });
    expect(repositoryUpdated.exitCode).toBe(0);
    expect(JSON.parse(repositoryUpdated.output)).toMatchObject({ document: { ui_poll_interval_seconds: 7 } });
    expect(await readFile(path.join(checkout, ".gitpm", "repository.yaml"), "utf8")).toContain("ui_poll_interval_seconds: 7");
  });

  it("exports through the shared service without overwriting an existing file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-cli-export-"));
    removeAfterTest(root);
    const received: unknown[] = [];
    const exporter = {
      create: async (draftId: string, request: unknown) => {
        received.push({ draftId, request });
        return {
          content: Buffer.from("%PDF"),
          content_type: "application/pdf",
          filename: "gitpm-20260725-deadbeef-portfolio.pdf",
        };
      },
    };

    const first = await run([
      "export", "--draft", "DRF-1", "--format", "pdf", "--locale", "ru",
      "--section", "projects", "--section", "gantt", "--json",
    ], root, { exporter });
    const second = await run(["export", "--draft", "DRF-1", "--format", "pdf", "--json"], root, { exporter });

    expect(first.exitCode).toBe(0);
    expect(received[0]).toEqual({
      draftId: "DRF-1",
      request: { format: "pdf", locale: "ru", sections: ["projects", "gantt"] },
    });
    const payload = JSON.parse(first.output);
    expect(await readFile(payload.path, "utf8")).toBe("%PDF");
    expect(second.exitCode).toBe(1);
    expect(JSON.parse(second.output)).toMatchObject({ code: "EXPORT_OUTPUT_EXISTS" });
  });
});
