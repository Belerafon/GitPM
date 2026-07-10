import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateDelete, validateRepository } from "./index.js";

const roots: string[] = [];
const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");
const project = "PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYP";
const taskOne = "TSK-01J2BZ7G4VJ57PX9K2Q0C6C5XP";
const taskTwo = "TSK-01J2BZ7G4VJ57PX9K2Q0C6C5XQ";
const otherTask = "TSK-01J2BZ7G4VJ57PX9K2Q0C6C5XR";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-validation-"));
  roots.push(root);
  await cp(demo, root, { recursive: true });
  return root;
}

async function replace(root: string, relative: string, before: string, after: string): Promise<void> {
  const file = path.join(root, relative);
  const text = await readFile(file, "utf8");
  await writeFile(file, text.replace(before, after), "utf8");
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("repository validation", () => {
  it("accepts the deterministic demo", async () => {
    const report = await validateRepository(demo);
    expect(report).toMatchObject({ valid: true, documentCount: 14, errors: [], warnings: [] });
  });

  it("rejects cross-project references", async () => {
    const root = await fixture();
    await replace(root, `projects/${project}/tasks/${taskTwo}.yaml`, taskOne, otherTask);
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "REF_CROSS_PROJECT" })]));
  });

  it("rejects schema violations and missing references", async () => {
    const root = await fixture();
    await replace(root, `projects/${project}/tasks/${taskTwo}.yaml`, "estimate_hours: 24.25", "estimate_hours: 1.1");
    await replace(root, `projects/${project}/tasks/${taskOne}.yaml`, "PER-01J2C01M9QHPMQ2ZK5F7N8S4VA", "PER-01J2C01M9QHPMQ2ZK5F7N8S4VC");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_INVALID" }),
      expect.objectContaining({ code: "REF_MISSING" }),
    ]));
  });

  it("detects dependency cycles", async () => {
    const root = await fixture();
    await replace(root, `projects/${project}/tasks/${taskOne}.yaml`, "labels:\n  - architecture", `depends_on:\n  - ${taskTwo}\nlabels:\n  - architecture`);
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TASK_DEPENDENCY_CYCLE" })]));
  });

  it("detects parent cycles", async () => {
    const root = await fixture();
    await replace(root, `projects/${project}/tasks/${taskOne}.yaml`, "milestone:", `parent: ${taskTwo}\nmilestone:`);
    await replace(root, `projects/${project}/tasks/${taskTwo}.yaml`, "milestone:", `parent: ${taskOne}\nmilestone:`);
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TASK_PARENT_CYCLE" })]));
  });

  it("rejects impossible calendar dates", async () => {
    const root = await fixture();
    await replace(root, "calendars/CAL-01J2C01M9QHPMQ2ZK5F7N8S4VA.yaml", "2026-01-01", "2026-02-30");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DATE_INVALID" })]));
  });

  it("rejects inverted entity date ranges", async () => {
    const root = await fixture();
    await replace(root, `projects/${project}/project.yaml`, "start: 2026-07-01", "start: 2026-10-01");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DATE_RANGE" })]));
  });

  it("warns for archived references without making the repository invalid", async () => {
    const root = await fixture();
    await replace(root, "people/PER-01J2C01M9QHPMQ2ZK5F7N8S4VA.yaml", "lifecycle: active", "lifecycle: archived");
    const report = await validateRepository(root);
    expect(report.valid).toBe(true);
    expect(report.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "REF_ARCHIVED" })]));
  });

  it("enforces delete restrict for direct references", async () => {
    const issues = await validateDelete(demo, "PER-01J2C01M9QHPMQ2ZK5F7N8S4VA");
    expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DELETE_RESTRICTED" })]));
  });
});
