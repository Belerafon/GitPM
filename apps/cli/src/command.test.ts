import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./command.js";

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

  it("provides semantic diff skeleton and doctor output", async () => {
    const diff = await run(["diff", "--semantic", "--json", "--root", demo]);
    expect(JSON.parse(diff.output)).toMatchObject({ ok: true, changed_files_count: 0, affected_projects: [] });
    const doctor = await run(["doctor", "--json", "--root", demo]);
    expect(JSON.parse(doctor.output)).toMatchObject({ ok: true, checks: { node_20: true, repository_valid: true, schemas_loaded: true } });
  });
});
