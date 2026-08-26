import { cp, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
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
    expect(report).toMatchObject({ valid: true, documentCount: 18, errors: [], warnings: [] });
  });

  it("enforces time entry state and replacement integrity while retaining inactive-category history", async () => {
    const root = await fixture();
    const entries = path.join(root, "projects", project, "time-entries", taskOne);
    const entry = (id: string, extra: string) => `schema: gitpm/time-entry@1\nid: ${id}\nproject: ${project}\ntask: ${taskOne}\nperson: U-26-5EBAE3\nperformed_on: 2026-09-01\nhours: 1\ncategory: support\ncreated_at: 2026-09-01T12:00:00Z\n${extra}`;
    await writeFile(path.join(entries, "E-26-BBBBBB.yaml"), entry("E-26-BBBBBB", "state: voided\n"), "utf8");
    await writeFile(path.join(entries, "E-26-CCCCCC.yaml"), entry("E-26-CCCCCC", "state: active\nvoided_at: 2026-09-01T13:00:00Z\n"), "utf8");
    await writeFile(path.join(entries, "E-26-DDDDDD.yaml"), entry("E-26-DDDDDD", "state: voided\nvoided_at: 2026-09-01T13:00:00Z\nvoided_by:\n  provider: git\n  subject: author@example.test\n  display_name: Author\nreplacement: E-26-EEEEEE\n"), "utf8");
    await writeFile(path.join(entries, "E-26-GGGGGG.yaml"), entry("E-26-GGGGGG", "state: voided\nvoided_at: 2026-09-01T13:00:00Z\nvoided_by:\n  provider: git\n  subject: author@example.test\n  display_name: Author\nreplacement: E-26-HHHHHH\n"), "utf8");
    await writeFile(path.join(entries, "E-26-FFFFFF.yaml"), entry("E-26-FFFFFF", "state: voided\nvoided_at: 2026-09-01T13:00:00Z\nvoided_by:\n  provider: git\n  subject: author@example.test\n  display_name: Author\nreplacement: E-26-FFFFFF\n"), "utf8");
    const otherEntries = path.join(root, "projects", "P-26-8S9HQQ", "time-entries", otherTask);
    await mkdir(otherEntries, { recursive: true });
    await writeFile(path.join(otherEntries, "E-26-HHHHHH.yaml"), entry("E-26-HHHHHH", "state: active\n").replace(`project: ${project}`, "project: P-26-8S9HQQ").replace(`task: ${taskOne}`, `task: ${otherTask}`), "utf8");
    const invalid = await validateRepository(root);
    expect(invalid.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_INVALID" }),
      expect.objectContaining({ code: "TIME_ENTRY_VOID_METADATA_REQUIRED" }),
      expect.objectContaining({ code: "TIME_ENTRY_VOID_FIELDS_FORBIDDEN" }),
      expect.objectContaining({ code: "TIME_ENTRY_REPLACEMENT_MISSING" }),
      expect.objectContaining({ code: "TIME_ENTRY_REPLACEMENT_SELF" }),
      expect.objectContaining({ code: "TIME_ENTRY_REPLACEMENT_TASK_MISMATCH" }),
    ]));

    const historical = await fixture();
    await replace(historical, ".gitpm/work-categories.yaml", "slug: support\n    title: Support\n    active: true", "slug: support\n    title: Support\n    active: false");
    await replace(historical, `projects/${project}/time-entries/${taskOne}/E-26-AAAAAA.yaml`, "category: warranty", "category: support");
    expect(await validateRepository(historical)).toMatchObject({ valid: true, errors: [] });
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

  it("explains how to allow an unknown top-level file or directory", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "notes.txt"), "notes\n", "utf8");
    await mkdir(path.join(root, "attachments"));
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "REPOSITORY_TOP_LEVEL",
        path: "notes.txt",
        message: 'Unknown top-level file "notes.txt"; add it to allowed_top_level_files in .gitpm/repository.yaml if it belongs in the repository',
      }),
      expect.objectContaining({
        code: "REPOSITORY_TOP_LEVEL",
        path: "attachments",
        message: 'Unknown top-level directory "attachments"; add it to allowed_top_level_directories in .gitpm/repository.yaml if it belongs in the repository',
      }),
    ]));
  });

  it("rejects unknown files and directories inside the repository domain layout", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "projects", project, "payload.bin"), "opaque", "utf8");
    await mkdir(path.join(root, "people", "attachments"));
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "REPOSITORY_UNKNOWN_PATH", path: `projects/${project}/payload.bin` }),
      expect.objectContaining({ code: "REPOSITORY_UNKNOWN_PATH", path: "people/attachments" }),
    ]));
  });

  it("accepts opaque regular files of any extension in a flat Project files directory", async () => {
    const root = await fixture();
    const files = path.join(root, "projects", project, "files");
    await mkdir(files);
    await writeFile(path.join(files, "ТЗ v3.docx"), Buffer.from([0, 255, 1, 254]));
    await writeFile(path.join(files, "not-domain.yaml"), "this is not: [valid domain YAML", "utf8");
    await writeFile(path.join(files, "без расширения"), "opaque", "utf8");

    expect(await validateRepository(root)).toMatchObject({ valid: true, documentCount: 18, errors: [] });
  });

  it("rejects nested directories and symlinks in Project file storage without following them", async () => {
    const root = await fixture();
    const files = path.join(root, "projects", project, "files");
    await mkdir(path.join(files, "nested"), { recursive: true });
    await writeFile(path.join(files, "nested", "hidden.pdf"), "opaque", "utf8");
    const outside = await mkdtemp(path.join(os.tmpdir(), "gitpm-project-files-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "external.pdf"), "external", "utf8");
    await symlink(outside, path.join(files, "linked"), process.platform === "win32" ? "junction" : "dir");

    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PROJECT_FILES_NESTED_DIRECTORY", path: `projects/${project}/files/nested` }),
      expect.objectContaining({ code: "FS_SYMLINK", path: `projects/${project}/files/linked` }),
    ]));
    expect(report.errors).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: `projects/${project}/files/linked/external.pdf` }),
    ]));
  });

  it.runIf(process.platform !== "win32")("rejects Project file names that differ only by case", async () => {
    const root = await fixture();
    const files = path.join(root, "projects", project, "files");
    await mkdir(files);
    await writeFile(path.join(files, "Contract.PDF"), "first", "utf8");
    await writeFile(path.join(files, "contract.pdf"), "second", "utf8");

    expect((await validateRepository(root)).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PROJECT_FILE_NAME_CONFLICT" }),
    ]));
  });

  it("does not reuse a cached document when same-size content preserves mtime", async () => {
    const root = await fixture();
    const task = path.join(root, "projects", project, "tasks", taskOne + ".yaml");
    const fixedTime = new Date("2026-01-01T00:00:00.000Z");
    await utimes(task, fixedTime, fixedTime);
    expect(await validateRepository(root)).toMatchObject({ valid: true });

    const original = await readFile(task, "utf8");
    const invalid = original.replace("status: done", "status: nope");
    expect(invalid).not.toBe(original);
    expect(Buffer.byteLength(invalid)).toBe(Buffer.byteLength(original));
    await writeFile(task, invalid, "utf8");
    await utimes(task, fixedTime, fixedTime);

    expect((await validateRepository(root)).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "CONFIG_REFERENCE", path: `projects/${project}/tasks/${taskOne}.yaml` }),
    ]));
  });

  it("rejects symlinks inside domain directories without following them", async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), "gitpm-validation-outside-"));
    roots.push(outside);
    await writeFile(path.join(outside, "external.yaml"), "schema: gitpm/project@2\n", "utf8");
    await symlink(outside, path.join(root, "projects", "linked"), process.platform === "win32" ? "junction" : "dir");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "FS_SYMLINK", path: "projects/linked" }),
    ]));
    expect(report.documentCount).toBe(18);
  });

  it("accepts saved milestone and task order", async () => {
    const root = await fixture();
    await replace(root, `projects/${project}/project.yaml`, "labels:", "milestone_order:\n  - M-26-461GDJ\nlabels:");
    await replace(root, `projects/${project}/milestones/M-26-461GDJ.yaml`, "finish: 2026-08-31", `finish: 2026-08-31\ntask_order:\n  - ${taskTwo}\n  - ${taskOne}`);
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
    await replace(root, `projects/${project}/tasks/${taskTwo}.yaml`, "effort_hours: 24.25", "effort_hours: 1.1");
    await replace(root, `projects/${project}/tasks/${taskOne}.yaml`, "U-26-5EBAE3", "U-26-KB9RXB");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_INVALID" }),
      expect.objectContaining({ code: "REF_MISSING" }),
    ]));
  });

  it("reports schema fields and rejects invalid or duplicate Person email", async () => {
    const missingCalendar = await fixture();
    await replace(missingCalendar, "people/U-26-15QJP8.yaml", "calendar: C-26-QD7FJ4 # calendar: Standard five-day week\n", "");
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

    const missingAdjustmentReason = await fixture();
    await replace(missingAdjustmentReason, "people/U-26-5EBAE3.yaml", "annual_vacation_extra_days_reason: Overtime compensation\n", "");
    report = await validateRepository(missingAdjustmentReason);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SCHEMA_INVALID", field: "annual_vacation_extra_days_reason", schema_keyword: "dependentRequired" })]));
  });

  it("detects dependency cycles", async () => {
    const root = await fixture();
    await replace(root, `projects/${project}/tasks/${taskOne}.yaml`, "    effort_hours: 8\n  target:", `    effort_hours: 8\n    depends_on:\n      - ${taskTwo}\n  target:`);
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

  it("requires a task and its parent to belong to the same milestone", async () => {
    const root = await fixture();
    await replace(root, `projects/${project}/tasks/${taskOne}.yaml`, "milestone: M-26-461GDJ", `parent: ${taskTwo}`);
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TASK_PARENT_MILESTONE_MISMATCH", path: `projects/${project}/tasks/${taskOne}.yaml` }),
    ]));
  });

  it("rejects impossible calendar dates", async () => {
    const root = await fixture();
    await replace(root, "calendars/C-26-QD7FJ4.yaml", "holidays: []", "holidays:\n  - 2026-02-30");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DATE_INVALID" })]));
  });

  it("rejects inverted entity date ranges", async () => {
    const root = await fixture();
    await replace(root, `projects/${project}/project.yaml`, "start: 2026-07-01", "start: 2026-10-01");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DATE_RANGE" })]));
  });

  it("validates availability ranges, prevents ambiguous overlaps, and warns about affected task windows", async () => {
    const conflict = await fixture();
    await replace(conflict, "availability/A-26-VACATN.yaml", "start: 2026-08-17\nfinish: 2026-08-21", "start: 2026-07-01\nfinish: 2026-07-02");
    let report = await validateRepository(conflict);
    expect(report.valid).toBe(true);
    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TASK_AVAILABILITY_CONFLICT", path: `projects/${project}/tasks/${taskOne}.yaml`, field: "schedules.plan" }),
    ]));

    const overlap = await fixture();
    await writeFile(path.join(overlap, "availability", "A-26-DAY0FF.yaml"), "schema: gitpm/availability-event@1\nid: A-26-DAY0FF\nperson: U-26-5EBAE3\nstart: 2026-08-20\nfinish: 2026-08-25\nkind: day-off\navailability_percent: 0\nstate: planned\nlifecycle: active\n", "utf8");
    report = await validateRepository(overlap);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "AVAILABILITY_EVENT_OVERLAP", path: "availability/A-26-VACATN.yaml" })]));
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

  it("rejects duplicate schedule track slugs", async () => {
    const root = await fixture();
    await replace(root, ".gitpm/schedule-tracks.yaml", "  - slug: actual\n    title: Actual activity\n    kind: actual\n    source: time_entries", "  - slug: plan\n    title: Plan duplicate\n    kind: manual\n    capabilities:\n      - dates\n  - slug: actual\n    title: Actual activity\n    kind: actual\n    source: time_entries");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TRACK_SLUG_DUPLICATE", field: "tracks.plan" })]));
  });

  it("rejects an actual track without source via schema", async () => {
    const root = await fixture();
    await replace(root, ".gitpm/schedule-tracks.yaml", "  - slug: actual\n    title: Actual activity\n    kind: actual\n    source: time_entries", "  - slug: actual\n    title: Actual activity\n    kind: actual");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_INVALID", path: ".gitpm/schedule-tracks.yaml" }),
    ]));
  });

  it("rejects a manual track with source via schema", async () => {
    const root = await fixture();
    await replace(root, ".gitpm/schedule-tracks.yaml", "  - slug: plan\n    title: Working plan\n    kind: manual", "  - slug: plan\n    title: Working plan\n    kind: manual\n    source: time_entries");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_INVALID", path: ".gitpm/schedule-tracks.yaml" }),
    ]));
  });

  it("rejects more than one actual track", async () => {
    const root = await fixture();
    await replace(root, ".gitpm/schedule-tracks.yaml", "defaults:", "  - slug: second-actual\n    title: Second actual\n    kind: actual\n    source: time_entries\ndefaults:");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TRACK_ACTUAL_COUNT" })]));
  });

  it("rejects dates on a track without the dates capability", async () => {
    const root = await fixture();
    await replace(root, ".gitpm/schedule-tracks.yaml", "  - slug: target\n    title: Target\n    kind: manual\n    capabilities:\n      - dates\n      - effort", "  - slug: target\n    title: Target\n    kind: manual\n    capabilities:\n      - effort");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CAPABILITY_DATES_NOT_ALLOWED" })]));
  });

  it("rejects a task using a track not enabled in its owning project", async () => {
    const root = await fixture();
    await replace(root, ".gitpm/schedule-tracks.yaml", "defaults:", "  - slug: internal\n    title: Internal\n    kind: manual\n    capabilities:\n      - dates\ndefaults:");
    await replace(root, `projects/${project}/tasks/${taskOne}.yaml`, "labels:", "  internal:\n    start: 2026-07-01\n    finish: 2026-07-02\nlabels:");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SCHEDULE_TRACK_NOT_ENABLED", field: "schedules.internal" })]));
  });

  it("rejects an actual track used as primary", async () => {
    const root = await fixture();
    await replace(root, ".gitpm/schedule-tracks.yaml", "  primary_track: plan", "  primary_track: actual");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PLANNING_PRIMARY_NOT_MANUAL", field: "defaults.primary_track" })]));
  });

  it("rejects an actual track used as the repository comparison", async () => {
    const root = await fixture();
    await replace(root, ".gitpm/schedule-tracks.yaml", "  comparison_track: target", "  comparison_track: actual");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PLANNING_COMPARISON_NOT_MANUAL", path: ".gitpm/schedule-tracks.yaml", field: "defaults.comparison_track" }),
      expect.objectContaining({ code: "PLANNING_COMPARISON_MISSING_DATES", path: ".gitpm/schedule-tracks.yaml", field: "defaults.comparison_track" }),
    ]));
  });

  it("accepts a partial project planning override resolved against valid defaults", async () => {
    const root = await fixture();
    await replace(root, "projects/P-26-8S9HQQ/project.yaml", "planning:\n  enabled_tracks:\n    - plan\n    - target\n    - actual\n  primary_track: plan\n  workload_track: plan\n  dashboard_tracks:\n    - plan\n    - target\n    - actual", "planning:\n  primary_track: plan");
    const report = await validateRepository(root);
    expect(report).toMatchObject({ valid: true, errors: [] });
  });

  it("preserves an explicit empty dashboard track list", async () => {
    const root = await fixture();
    await replace(root, "projects/P-26-8S9HQQ/project.yaml", "  dashboard_tracks:\n    - plan\n    - target\n    - actual", "  dashboard_tracks: []");
    const report = await validateRepository(root);
    expect(report).toMatchObject({ valid: true, errors: [] });
  });

  it("rejects explicit empty enabled tracks instead of inheriting defaults", async () => {
    const root = await fixture();
    await replace(root, "projects/P-26-8S9HQQ/project.yaml", "  enabled_tracks:\n    - plan\n    - target\n    - actual", "  enabled_tracks: []");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PLANNING_PRIMARY_NOT_ENABLED", path: "projects/P-26-8S9HQQ/project.yaml", field: "planning.primary_track" }),
      expect.objectContaining({ code: "PLANNING_WORKLOAD_NOT_ENABLED", path: "projects/P-26-8S9HQQ/project.yaml", field: "planning.workload_track" }),
    ]));
  });

  it("rejects invalid repository schedule-tracks defaults", async () => {
    const root = await fixture();
    await replace(root, ".gitpm/schedule-tracks.yaml", "  workload_track: plan", "  workload_track: actual");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "PLANNING_WORKLOAD_NOT_MANUAL", field: "defaults.workload_track" })]));
  });

  it("rejects an empty schedule window", async () => {
    const root = await fixture();
    await replace(root, `projects/${project}/tasks/${taskTwo}.yaml`, "  plan:\n    effort_hours: 24.25\n    depends_on:\n      - T-26-P9G3P8 # task: Approve schema v1", "  plan: {}");
    const report = await validateRepository(root);
    expect(report.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SCHEMA_INVALID", path: `projects/${project}/tasks/${taskTwo}.yaml` }),
    ]));
  });
});
