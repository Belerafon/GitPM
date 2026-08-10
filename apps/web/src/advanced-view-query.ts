export type ViewFieldType = "text" | "number" | "date" | "select" | "multi-select" | "boolean";
export type ViewScalar = string | number | boolean;
export type ViewValue = ViewScalar | readonly string[] | null | undefined;

export interface ViewFieldOption {
  readonly value: string;
  readonly label: string;
}

export interface ViewField<Row> {
  readonly id: string;
  readonly label: string;
  readonly type: ViewFieldType;
  readonly options?: readonly ViewFieldOption[];
  readonly read: (row: Row) => ViewValue;
  readonly sortable?: boolean;
}

export type ViewFilterOperator =
  | "equals" | "not-equals" | "contains" | "not-contains"
  | "includes" | "not-includes"
  | "before" | "on-or-before" | "after" | "on-or-after" | "between"
  | "less-than" | "less-than-or-equal" | "greater-than" | "greater-than-or-equal"
  | "is-empty" | "is-not-empty" | "is-true" | "is-false";

export interface ViewFilterCondition {
  readonly kind: "condition";
  readonly id: string;
  readonly field: string;
  readonly operator: ViewFilterOperator;
  readonly value?: string;
  readonly valueTo?: string;
}

export interface ViewFilterGroup {
  readonly kind: "group";
  readonly id: string;
  readonly combinator: "and" | "or";
  readonly children: readonly ViewFilterNode[];
}

export type ViewFilterNode = ViewFilterCondition | ViewFilterGroup;

export interface ViewSortRule {
  readonly id: string;
  readonly field: string;
  readonly direction: "asc" | "desc";
}

export interface AdvancedViewQuery {
  readonly filter: ViewFilterGroup;
  readonly sort: readonly ViewSortRule[];
}

let nextId = 0;
export const newViewNodeId = (prefix: "condition" | "group" | "sort"): string => `${prefix}-${++nextId}`;
export const emptyViewQuery = (): AdvancedViewQuery => ({
  filter: { kind: "group", id: newViewNodeId("group"), combinator: "and", children: [] },
  sort: [],
});
export const defaultLifecycleViewQuery = (): AdvancedViewQuery => ({
  filter: { kind: "group", id: newViewNodeId("group"), combinator: "and", children: [{ kind: "condition", id: newViewNodeId("condition"), field: "lifecycle", operator: "equals", value: "active" }] },
  sort: [],
});

export function operatorsFor(type: ViewFieldType): readonly ViewFilterOperator[] {
  if (type === "boolean") return ["is-true", "is-false"];
  if (type === "date") return ["equals", "not-equals", "before", "on-or-before", "after", "on-or-after", "between", "is-empty", "is-not-empty"];
  if (type === "number") return ["equals", "not-equals", "less-than", "less-than-or-equal", "greater-than", "greater-than-or-equal", "between", "is-empty", "is-not-empty"];
  if (type === "multi-select") return ["includes", "not-includes", "is-empty", "is-not-empty"];
  if (type === "select") return ["equals", "not-equals", "is-empty", "is-not-empty"];
  return ["contains", "not-contains", "equals", "not-equals", "is-empty", "is-not-empty"];
}

const empty = (value: ViewValue): boolean => value === null || value === undefined || value === "" || Array.isArray(value) && value.length === 0;
const normalizedText = (value: ViewValue, locale: string): string => String(value ?? "").trim().toLocaleLowerCase(locale);

function matchesCondition<Row>(row: Row, condition: ViewFilterCondition, field: ViewField<Row>, locale: string): boolean {
  const actual = field.read(row);
  if (condition.operator === "is-empty") return empty(actual);
  if (condition.operator === "is-not-empty") return !empty(actual);
  if (condition.operator === "is-true") return actual === true;
  if (condition.operator === "is-false") return actual === false;
  if (condition.operator === "includes" || condition.operator === "not-includes") {
    const present = Array.isArray(actual) && actual.map(String).includes(condition.value ?? "");
    return condition.operator === "includes" ? present : !present;
  }
  if (field.type === "number") {
    const left = typeof actual === "number" ? actual : Number(actual);
    const right = Number(condition.value);
    const rightTo = Number(condition.valueTo);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    if (condition.operator === "equals") return left === right;
    if (condition.operator === "not-equals") return left !== right;
    if (condition.operator === "less-than") return left < right;
    if (condition.operator === "less-than-or-equal") return left <= right;
    if (condition.operator === "greater-than") return left > right;
    if (condition.operator === "greater-than-or-equal") return left >= right;
    return condition.operator === "between" && Number.isFinite(rightTo) && left >= right && left <= rightTo;
  }
  const left = normalizedText(actual, locale);
  const right = normalizedText(condition.value, locale);
  const rightTo = normalizedText(condition.valueTo, locale);
  if (condition.operator === "equals") return left === right;
  if (condition.operator === "not-equals") return left !== right;
  if (condition.operator === "contains") return left.includes(right);
  if (condition.operator === "not-contains") return !left.includes(right);
  if (condition.operator === "before") return left < right;
  if (condition.operator === "on-or-before") return left <= right;
  if (condition.operator === "after") return left > right;
  if (condition.operator === "on-or-after") return left >= right;
  return condition.operator === "between" && left >= right && left <= rightTo;
}

export function matchesViewFilter<Row>(row: Row, node: ViewFilterNode, fields: readonly ViewField<Row>[], locale: string): boolean {
  if (node.kind === "condition") {
    const field = fields.find((candidate) => candidate.id === node.field);
    return field === undefined ? false : matchesCondition(row, node, field, locale);
  }
  if (node.children.length === 0) return true;
  return node.combinator === "and"
    ? node.children.every((child) => matchesViewFilter(row, child, fields, locale))
    : node.children.some((child) => matchesViewFilter(row, child, fields, locale));
}

function compareValues(left: ViewValue, right: ViewValue, locale: string): number {
  const leftEmpty = empty(left); const rightEmpty = empty(right);
  if (leftEmpty || rightEmpty) return leftEmpty === rightEmpty ? 0 : leftEmpty ? 1 : -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return String(left).localeCompare(String(right), locale, { numeric: true, sensitivity: "base" });
}

export function applyAdvancedViewQuery<Row>(rows: readonly Row[], fields: readonly ViewField<Row>[], query: AdvancedViewQuery, locale: string): Row[] {
  const indexed = rows.filter((row) => matchesViewFilter(row, query.filter, fields, locale)).map((row, index) => ({ row, index }));
  indexed.sort((left, right) => {
    for (const rule of query.sort) {
      const field = fields.find((candidate) => candidate.id === rule.field && candidate.sortable !== false);
      if (field === undefined) continue;
      const leftValue = field.read(left.row); const rightValue = field.read(right.row);
      if (empty(leftValue) || empty(rightValue)) {
        if (empty(leftValue) !== empty(rightValue)) return empty(leftValue) ? 1 : -1;
        continue;
      }
      const comparison = compareValues(leftValue, rightValue, locale);
      if (comparison !== 0) return rule.direction === "asc" ? comparison : -comparison;
    }
    return left.index - right.index;
  });
  return indexed.map(({ row }) => row);
}

export function removeViewFilterNode(group: ViewFilterGroup, id: string): ViewFilterGroup {
  return {
    ...group,
    children: group.children.filter((child) => child.id !== id).map((child) => child.kind === "group" ? removeViewFilterNode(child, id) : child),
  };
}

export function countViewConditions(node: ViewFilterNode): number {
  return node.kind === "condition" ? 1 : node.children.reduce((total, child) => total + countViewConditions(child), 0);
}

export function serializeAdvancedViewQuery(query: AdvancedViewQuery): string {
  return JSON.stringify(query);
}

const FILTER_OPERATORS = new Set<ViewFilterOperator>([
  "equals", "not-equals", "contains", "not-contains", "includes", "not-includes", "before", "on-or-before", "after", "on-or-after", "between", "less-than", "less-than-or-equal", "greater-than", "greater-than-or-equal", "is-empty", "is-not-empty", "is-true", "is-false",
]);

export function parseAdvancedViewQuery(value: string | undefined, fields: readonly Pick<ViewField<unknown>, "id" | "type">[]): AdvancedViewQuery {
  if (value === undefined || value.length > 20_000) return emptyViewQuery();
  try {
    const input = JSON.parse(value) as unknown;
    const fieldMap = new Map(fields.map((field) => [field.id, field]));
    let nodes = 0;
    const node = (candidate: unknown, depth: number): ViewFilterNode | null => {
      if (depth > 8 || ++nodes > 100 || candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return null;
      const record = candidate as Record<string, unknown>;
      if (record.kind === "condition" && typeof record.id === "string" && typeof record.field === "string" && typeof record.operator === "string" && FILTER_OPERATORS.has(record.operator as ViewFilterOperator)) {
        const field = fieldMap.get(record.field); const operator = record.operator as ViewFilterOperator;
        if (field === undefined || !operatorsFor(field.type).includes(operator)) return null;
        return { kind: "condition", id: record.id, field: record.field, operator, ...(typeof record.value === "string" ? { value: record.value } : {}), ...(typeof record.valueTo === "string" ? { valueTo: record.valueTo } : {}) };
      }
      if (record.kind === "group" && typeof record.id === "string" && (record.combinator === "and" || record.combinator === "or") && Array.isArray(record.children)) {
        const children = record.children.map((child) => node(child, depth + 1));
        if (children.some((child) => child === null)) return null;
        return { kind: "group", id: record.id, combinator: record.combinator, children: children as ViewFilterNode[] };
      }
      return null;
    };
    if (input === null || typeof input !== "object" || Array.isArray(input)) return emptyViewQuery();
    const record = input as Record<string, unknown>;
    const filter = node(record.filter, 0);
    if (filter?.kind !== "group" || !Array.isArray(record.sort) || record.sort.length > 10) return emptyViewQuery();
    const sort = record.sort.flatMap((candidate): ViewSortRule[] => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const rule = candidate as Record<string, unknown>;
      return typeof rule.id === "string" && typeof rule.field === "string" && fieldMap.has(rule.field) && (rule.direction === "asc" || rule.direction === "desc")
        ? [{ id: rule.id, field: rule.field, direction: rule.direction }]
        : [];
    });
    return { filter, sort };
  } catch { return emptyViewQuery(); }
}
