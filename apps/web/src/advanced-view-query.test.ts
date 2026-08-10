import { describe, expect, it } from "vitest";
import {
  applyAdvancedViewQuery, emptyViewQuery, parseAdvancedViewQuery, removeViewFilterNode, serializeAdvancedViewQuery,
  type AdvancedViewQuery, type ViewField,
} from "./advanced-view-query.js";

interface Row { readonly id: string; readonly status: string; readonly owner: string; readonly due?: string; readonly assignees: readonly string[]; readonly effort: number; readonly overdue: boolean }
const rows: readonly Row[] = [
  { id: "P-3", status: "active", owner: "ivanov", due: "2026-09-01", assignees: ["ivanov"], effort: 20, overdue: true },
  { id: "P-1", status: "done", owner: "petrov", due: "2026-02-10", assignees: ["petrov"], effort: 8, overdue: false },
  { id: "P-2", status: "active", owner: "sidorov", due: "2026-04-15", assignees: ["ivanov", "sidorov"], effort: 13, overdue: false },
  { id: "P-4", status: "active", owner: "petrov", assignees: [], effort: 3, overdue: true },
];
const fields: readonly ViewField<Row>[] = [
  { id: "id", label: "ID", type: "text", read: (row) => row.id },
  { id: "status", label: "Status", type: "select", read: (row) => row.status },
  { id: "owner", label: "Owner", type: "select", read: (row) => row.owner },
  { id: "due", label: "Due", type: "date", read: (row) => row.due },
  { id: "assignees", label: "Assignees", type: "multi-select", read: (row) => row.assignees },
  { id: "effort", label: "Effort", type: "number", read: (row) => row.effort },
  { id: "overdue", label: "Overdue", type: "boolean", read: (row) => row.overdue },
];

describe("advanced view query", () => {
  it("evaluates freely nested AND/OR groups", () => {
    const query: AdvancedViewQuery = { filter: { kind: "group", id: "root", combinator: "or", children: [
      { kind: "group", id: "g1", combinator: "and", children: [
        { kind: "condition", id: "f1", field: "status", operator: "equals", value: "active" },
        { kind: "group", id: "g2", combinator: "or", children: [
          { kind: "condition", id: "f2", field: "overdue", operator: "is-true" },
          { kind: "condition", id: "f3", field: "assignees", operator: "includes", value: "ivanov" },
        ] },
      ] },
      { kind: "group", id: "g3", combinator: "and", children: [
        { kind: "condition", id: "f4", field: "due", operator: "between", value: "2026-01-01", valueTo: "2026-12-31" },
        { kind: "condition", id: "f5", field: "status", operator: "equals", value: "done" },
      ] },
    ] }, sort: [] };
    expect(applyAdvancedViewQuery(rows, fields, query, "en").map((row) => row.id)).toEqual(["P-3", "P-1", "P-2", "P-4"]);
  });

  it("supports multi-column direction-aware sorting and puts empty values last", () => {
    const query: AdvancedViewQuery = { ...emptyViewQuery(), sort: [
      { id: "s1", field: "status", direction: "asc" },
      { id: "s2", field: "due", direction: "desc" },
    ] };
    expect(applyAdvancedViewQuery(rows, fields, query, "en").map((row) => row.id)).toEqual(["P-3", "P-2", "P-4", "P-1"]);
  });

  it("round-trips a validated URL value and rejects unknown fields", () => {
    const query: AdvancedViewQuery = { filter: { kind: "group", id: "root", combinator: "and", children: [{ kind: "condition", id: "f1", field: "effort", operator: "greater-than", value: "10" }] }, sort: [{ id: "s1", field: "id", direction: "desc" }] };
    expect(parseAdvancedViewQuery(serializeAdvancedViewQuery(query), fields)).toEqual(query);
    expect(parseAdvancedViewQuery('{"filter":{"kind":"group","id":"r","combinator":"and","children":[{"kind":"condition","id":"x","field":"secret","operator":"equals","value":"x"}]},"sort":[]}', fields).filter.children).toHaveLength(0);
  });

  it("removes one chip condition without changing sibling groups", () => {
    const filter = { kind: "group", id: "root", combinator: "and", children: [{ kind: "condition", id: "one", field: "status", operator: "equals", value: "active" }, { kind: "group", id: "nested", combinator: "or", children: [{ kind: "condition", id: "two", field: "owner", operator: "equals", value: "ivanov" }] }] } as const;
    expect(removeViewFilterNode(filter, "two")).toEqual({ ...filter, children: [filter.children[0], { ...filter.children[1], children: [] }] });
  });
});
