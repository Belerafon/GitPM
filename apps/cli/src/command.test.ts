import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./command.js";
import type { AgentWorkflow } from "@gitpm/agent";
import type { GitPmDocument } from "@gitpm/repository-format";

const roots: string[] = [];
const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-cli-"));
  roots.push(root);
  await cp(demo, root, { recursive: true });
  return root;
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
    const calendar = path.join(root, "calendars", "CAL-01J2C01M9QHPMQ2ZK5F7N8S4VA.yaml");
    await writeFile(calendar, (await readFile(calendar, "utf8")).replace("2026-01-01", "2026-02-30"), "utf8");
    const invalid = await run(["validate", "--json", "--root", root]);
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.output).errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DATE_INVALID" })]));
  });

  it("preserves UTF-8 Cyrillic content independently of the Windows code page", async () => {
    const root = await fixture();
    const file = path.join(root, "projects", "PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYQ", "project.yaml");
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
      semanticDiff: async () => ({ created: [], updated: [{ id: "PRJ-1", schema: "gitpm/project@1", path: "project.yaml", fields: [{ field: "name", before: "Old", after: "New" }] }], archived: [], deleted: [], counts: { created: 0, updated: 1, archived: 0, deleted: 0 }, affected_projects: ["PRJ-1"], unclassified_files: [] }),
      commitAll: async () => ({ commit: "c".repeat(40), branch: metadata.branch, draft_fingerprint: "d".repeat(64) }),
      push: async () => ({ branch: metadata.branch, commit: "c".repeat(40) }),
      createMergeRequest: async () => ({ iid: 7, state: "opened" as const, source_branch: metadata.branch, target_branch: "main", web_url: "https://gitlab.example.test/mr/7" }),
    } as unknown as AgentWorkflow;
    const inputRoot = await mkdtemp(path.join(os.tmpdir(), "gitpm-cli-entity-"));
    roots.push(inputRoot);
    const entityFile = path.join(inputRoot, "person.yaml");
    await writeFile(entityFile, [
      "schema: gitpm/person@1",
      "id: PER-01J2C01M9QHPMQ2ZK5F7N8S4VC",
      "name: Елена Соколова",
      "weekly_capacity_hours: 40",
      "calendar: CAL-01J2C01M9QHPMQ2ZK5F7N8S4VA",
      "lifecycle: active",
      "email: elena.sokolova@example.test",
      "",
    ].join("\n"), "utf8");
    expect(JSON.parse((await run(["draft", "open", "--draft", "DRF-AGENT", "--owner", "42", "--json"], process.cwd(), { agent })).output)).toMatchObject({ ok: true, draft: { writer_mode: "external" } });
    expect(JSON.parse((await run(["entity", "create", "--draft", "DRF-AGENT", "--file", entityFile, "--json"], process.cwd(), { agent })).output)).toMatchObject({
      ok: true,
      path: "people/PER-01J2C01M9QHPMQ2ZK5F7N8S4VC.yaml",
      document: { schema: "gitpm/person@1", name: "Елена Соколова" },
    });
    expect(JSON.parse((await run(["diff", "--semantic", "--draft", "DRF-AGENT", "--project", "PRJ-1", "--json"], process.cwd(), { agent })).output)).toMatchObject({ ok: true, counts: { updated: 1 } });
    expect(JSON.parse((await run(["commit", "--all", "-m", "Agent update", "--draft", "DRF-AGENT", "--project", "PRJ-1", "--json"], process.cwd(), { agent })).output)).toMatchObject({ ok: true, commit: "c".repeat(40) });
    expect(JSON.parse((await run(["push", "--draft", "DRF-AGENT", "--json"], process.cwd(), { agent })).output)).toMatchObject({ ok: true, branch: metadata.branch });
    expect(JSON.parse((await run(["mr", "create", "--draft", "DRF-AGENT", "--owner", "42", "--title", "Agent update", "--json"], process.cwd(), { agent })).output)).toMatchObject({ ok: true, merge_request: { iid: 7 } });
  });

  it("requires explicit commit-all and configured agent runtime", async () => {
    expect(JSON.parse((await run(["commit", "-m", "partial", "--json"])).output)).toMatchObject({ code: "CLI_USAGE" });
    expect(JSON.parse((await run(["entity", "create", "--draft", "DRF-X", "--file", "missing.yaml", "--json"])).output)).toMatchObject({ code: "CLI_AGENT_CONFIGURATION_REQUIRED" });
    expect(JSON.parse((await run(["draft", "status", "--draft", "DRF-X", "--json"])).output)).toMatchObject({ code: "CLI_AGENT_CONFIGURATION_REQUIRED" });
  });
});
