import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateDelete, validateRepository } from "./index.js";

const roots: string[] = [];
const demo = path.join(process.cwd(), "fixtures", "schema-v1", "demo");
const project = "P-26-MGP84K";
const taskOne = "T-26-P9G3P8";
const taskTwo = "T-26-RHBNH8";
const otherTask = "T-26-G2TG9R";

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

  it("rejects an empty directory and missing required repository layout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-validation-empty-"));
    roots.push(root);
    const report = await validateRepository(root);
    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REPOSITORY_DIRECTORY_REQUIRED", path: ".gitpm" }),
      expect.objectContaining({ code: "REPOSITORY_DIRECTORY_REQUIRED", path: "projects" }),
      expect.objectContaining({ code: "REPOSITORY_DOCUMENT_REQUIRED", path: ".gitpm/repository.yaml" }),
      expect.objectContaining({ code: "REPOSITORY_DOCUMENT_REQUIRED", path: ".gitpm/statuses.yaml" }),
      expect.objectContaining({ code: "REPOSITORY_DOCUMENT_REQUIRED", path: ".gitpm/issue-types.yaml" }),
    ]));
  });

  it("accepts an optional non-empty Project group and rejects invalid group values", async () => {
    const valid = await fixture();
    await replace(valid, `projects/${project}/project.yaml`, "lifecycle: active", "lifecycle: active\ngroup: Внутренняя платформа");
    expect(await validateRepository(valid)).toMatchObject({ valid: true, errors: [] });

    const invalidGroups = [
      "group: 42",
      'group: ""',
      'group: "   "',
      `group: ${"x".repeat(101)}`,
    ];
    for (const invalidGroup of invalidGroups) {
      const root = await fixture();
      await replace(root, `projects/${project}/project.yaml`, "lifecycle: active", `lifecycle: active\n${invalidGroup}`);
      expect((await validateRepository(root)).errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "SCHEMA_INVALID", field: "group" }),
      ]));
    }
  });

  it("accepts reserved agent guidance paths", async () => {
    const root = await fixture();
    await mkdir(path.join(root, ".agents", "skills", "gitpm"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Agent instructions\n", "utf8");
    await writeFile(path.join(root, ".agents", "skills", "gitpm", "SKILL.md"), "---\nname: gitpm\ndescription: Use GitPM CLI.\n---\n", "utf8");
    expect(await validateRepository(root)).toMatchObject({ valid: true, errors: [] });
  });

  it("accepts ignored input files in an allowed non-domain directory", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "uploads", "incoming-report.pdf"), "opaque user input", "utf8");
    await writeFile(path.join(root, "uploads", "source.yaml"), "customer: Acme\n", "utf8");
    expect(await validateRepository(root)).toMatchObject({ valid: true, errors: [] });
  });

  it("rejects symlinks inside domain directories without following them", async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "gitpm-validation-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "external.yaml"), "schema: gitpm/project@1\n", "utf8");
    await symlink(outside, path.join(root, "projects", "linked"), process.platform === "win32" ? "junction" : "dir");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "FS_SYMLINK", path: "projects/linked" }),
    ]));
    expect(report.documentCount).toBe(14);
  });

  it("accepts saved milestone and task order", async () => {
    const root = await fixture();
    await replace(root, `projects/${project}/project.yaml`, "labels:", "milestone_order:\n  - M-26-461GDJ\nlabels:");
    await replace(root, `projects/${project}/milestones/M-26-461GDJ.yaml`, "due: 2026-08-31", `due: 2026-08-31\ntask_order:\n  - ${taskTwo}\n  - ${taskOne}`);
    const report = await validateRepository(root);
    expect(report).toMatchObject({ valid: true, errors: [] });
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
    await replace(root, `projects/${project}/tasks/${taskOne}.yaml`, "U-26-5EBAE3", "U-26-KB9RXB");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_INVALID" }),
      expect.objectContaining({ code: "REF_MISSING" }),
    ]));
  });

  it("reports schema fields and rejects invalid or duplicate Person email", async () => {
    const missingCalendar = await fixture();
    await replace(missingCalendar, "people/U-26-15QJP8.yaml", "calendar: C-26-QD7FJ4 # calendar: Standard work week\n", "");
    let report = await validateRepository(missingCalendar);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_INVALID", field: "calendar", schema_keyword: "required", expected: expect.stringContaining("Calendar ID") }),
    ]));

    const duplicate = await fixture();
    await replace(duplicate, "people/U-26-15QJP8.yaml", "lifecycle: active", "lifecycle: active\nemail: ANNA@example.test");
    report = await validateRepository(duplicate);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PERSON_EMAIL_DUPLICATE", field: "email" })]));

    const invalid = await fixture();
    await replace(invalid, "people/U-26-5EBAE3.yaml", "anna@example.test", "not-an-email");
    report = await validateRepository(invalid);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SCHEMA_INVALID", field: "email", expected: "email address" })]));
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
    await replace(root, "calendars/C-26-QD7FJ4.yaml", "2026-01-01", "2026-02-30");
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
    await replace(root, "people/U-26-5EBAE3.yaml", "lifecycle: active", "lifecycle: archived");
    const report = await validateRepository(root);
    expect(report.valid).toBe(true);
    expect(report.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "REF_ARCHIVED" })]));
  });

  it("enforces delete restrict for direct references", async () => {
    const issues = await validateDelete(demo, "U-26-5EBAE3");
    expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DELETE_RESTRICTED" })]));
  });
});
