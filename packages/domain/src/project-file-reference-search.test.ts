import { describe, expect, it } from "vitest";
import type { GitPmDocument } from "@gitpm/repository-format";
import { searchProjectFileReferences } from "./project-file-reference-search.js";

const PROJECT = "P-26-ABC123";
const OTHER_PROJECT = "P-26-DEF456";
const FILE = "ТЗ [финал].docx";
const REF = "[[file:ТЗ \\[финал\\].docx]]";

function documents(): GitPmDocument[] {
  return [
    {
      schema: "gitpm/task@2",
      id: "T-26-AAA111",
      project: PROJECT,
      title: "Archived task",
      type: "task",
      status: "done",
      lifecycle: "archived",
      description_markdown: `${REF} then ${REF}`,
      acceptance_criteria_markdown: [`Accept ${REF}`, "Wrong [[file:тз [финал].docx]]", "Malformed [[file:bad\\q]]"],
    },
    {
      schema: "gitpm/project@2",
      id: OTHER_PROJECT,
      name: "Other",
      status: "active",
      lifecycle: "active",
      description_markdown: REF,
    },
    {
      schema: "gitpm/time-entry@1",
      id: "E-26-AAA111",
      project: PROJECT,
      task: "T-26-AAA111",
      person: "U-26-AAA111",
      performed_on: "2026-08-13",
      hours: 1,
      category: "regular",
      created_at: "2026-08-13T10:00:00.000Z",
      state: "voided",
      note_markdown: `Historical note ${REF}`,
      voided_at: "2026-08-13T11:00:00.000Z",
      voided_by: { provider: "git", subject: "user@example.test", display_name: "User" },
    },
    {
      schema: "gitpm/milestone@2",
      id: "M-26-AAA111",
      project: PROJECT,
      name: "Archived milestone",
      lifecycle: "archived",
      description_markdown: REF,
    },
    {
      schema: "gitpm/comment@1",
      id: "N-26-AAA111",
      project: PROJECT,
      task: "T-26-AAA111",
      author: { provider: "git", subject: "user@example.test", display_name: "User" },
      created_at: "2026-08-13T10:00:00.000Z",
      state: "active",
      body_markdown: `Comment ${REF}`,
      mentions: [],
    },
    {
      schema: "gitpm/comment@1",
      id: "N-26-BBB222",
      project: PROJECT,
      task: "T-26-AAA111",
      author: { provider: "git", subject: "user@example.test", display_name: "User" },
      created_at: "2026-08-13T10:00:00.000Z",
      state: "deleted",
      mentions: [],
      deleted_at: "2026-08-13T12:00:00.000Z",
      deleted_by: { provider: "git", subject: "user@example.test", display_name: "User" },
    },
    {
      schema: "gitpm/project@2",
      id: PROJECT,
      name: "Current",
      status: "active",
      lifecycle: "archived",
      description_markdown: `Project ${REF}`,
    },
    {
      schema: "gitpm/task@2",
      id: "T-26-BBB222",
      project: OTHER_PROJECT,
      title: "Other task",
      type: "task",
      status: "active",
      lifecycle: "active",
      description_markdown: REF,
    },
    {
      schema: "gitpm/availability-event@1",
      id: "A-26-AAA111",
      person: "U-26-AAA111",
      start: "2026-08-13",
      finish: "2026-08-14",
      kind: "leave",
      state: "active",
      lifecycle: "active",
      note_markdown: REF,
    },
  ];
}

describe("Project file reference domain search", () => {
  it("finds every repeated exact-name use in all supported current-Project fields", () => {
    const source = documents();
    const before = JSON.stringify(source);
    const result = searchProjectFileReferences({ projectId: PROJECT, fileName: FILE, documents: source });

    expect(result.count).toBe(7);
    expect(result.count).toBe(result.locations.length);
    expect(result.locations.map(({ path, field, value_index: valueIndex }) => ({ path, field, valueIndex }))).toEqual([
      { path: `projects/${PROJECT}/comments/T-26-AAA111/N-26-AAA111.yaml`, field: "body_markdown", valueIndex: undefined },
      { path: `projects/${PROJECT}/milestones/M-26-AAA111.yaml`, field: "description_markdown", valueIndex: undefined },
      { path: `projects/${PROJECT}/project.yaml`, field: "description_markdown", valueIndex: undefined },
      { path: `projects/${PROJECT}/tasks/T-26-AAA111.yaml`, field: "acceptance_criteria_markdown", valueIndex: 0 },
      { path: `projects/${PROJECT}/tasks/T-26-AAA111.yaml`, field: "description_markdown", valueIndex: undefined },
      { path: `projects/${PROJECT}/tasks/T-26-AAA111.yaml`, field: "description_markdown", valueIndex: undefined },
      { path: `projects/${PROJECT}/time-entries/T-26-AAA111/E-26-AAA111.yaml`, field: "note_markdown", valueIndex: undefined },
    ]);
    expect(result.locations[4]!.start).toBe(0);
    expect(result.locations[5]!.start).toBeGreaterThan(result.locations[4]!.start);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("is stable regardless of input order and excludes cross-Project and unsupported note fields", () => {
    const source = documents();
    const forward = searchProjectFileReferences({ projectId: PROJECT, fileName: FILE, documents: source });
    const reverse = searchProjectFileReferences({ projectId: PROJECT, fileName: FILE, documents: [...source].reverse() });
    expect(reverse).toEqual(forward);
    expect(forward.locations.every((location) => location.path.startsWith(`projects/${PROJECT}/`))).toBe(true);
    expect(forward.locations.some((location) => location.entity_type === "comment")).toBe(true);
    expect(forward.locations.some((location) => location.entity_type === "time_entry")).toBe(true);
    expect(searchProjectFileReferences({
      projectId: PROJECT,
      fileName: FILE,
      documents: [{
        schema: "gitpm/comment@1",
        id: "N-26-CCC333",
        project: PROJECT,
        task: "../../outside",
        state: "active",
        body_markdown: REF,
      }],
    }).count).toBe(0);
  });

  it("uses exact case and the complete name rather than similar prefixes or extensions", () => {
    const source: GitPmDocument[] = [{
      schema: "gitpm/project@2",
      id: PROJECT,
      name: "Current",
      status: "active",
      lifecycle: "active",
      description_markdown: [
        "[[file:Plan.xlsx]]",
        "[[file:plan.xlsx]]",
        "[[file:Plan.xls]]",
        "[[file:Plan.xlsx.bak]]",
      ].join(" "),
    }];
    const result = searchProjectFileReferences({ projectId: PROJECT, fileName: "Plan.xlsx", documents: source });
    expect(result.count).toBe(1);
    expect(result.locations[0]).toMatchObject({ entity_type: "project", field: "description_markdown", start: 0 });
  });

  it("treats hostile names as inert exact strings and malformed syntax as text", () => {
    const hostile = "<img src=x onerror=alert(1)>.png";
    const source: GitPmDocument[] = [{
      schema: "gitpm/project@2",
      id: PROJECT,
      name: "Current",
      status: "active",
      lifecycle: "active",
      description_markdown: `[[file:${hostile}]] [[file:bad\\q]] [[file:]]`,
    }];
    expect(searchProjectFileReferences({ projectId: PROJECT, fileName: hostile, documents: source }).count).toBe(1);
    expect(searchProjectFileReferences({ projectId: PROJECT, fileName: "badq", documents: source }).count).toBe(0);
  });
});
