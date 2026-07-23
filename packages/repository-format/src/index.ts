import { Document, isAlias, parseDocument, visit } from "yaml";

const MAX_BYTES = 1_048_576;
const MAX_LINE_LENGTH = 20_000;
const MAX_NODES = 20_000;
const MAX_DEPTH = 64;

export class RepositoryFormatError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly source?: string,
  ) {
    super(message);
    this.name = "RepositoryFormatError";
  }
}

export interface GitPmDocument {
  readonly schema: string;
  readonly [key: string]: unknown;
}

export type ReferenceLabels = ReadonlyMap<string, string>;

function fail(code: string, message: string, source?: string): never {
  throw new RepositoryFormatError(code, message, source);
}

export function parseYamlValue(text: string, source?: string): unknown {
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) fail("YAML_SIZE_LIMIT", "YAML file exceeds the byte limit", source);
  if (text.includes("\r")) fail("YAML_LINE_ENDING", "YAML must use LF line endings", source);
  if (text.includes("\0")) fail("YAML_NUL", "YAML must not contain NUL", source);
  if (text.split("\n").some((line) => line.length > MAX_LINE_LENGTH)) {
    fail("YAML_LINE_LIMIT", "YAML line exceeds the length limit", source);
  }

  const parsed = parseDocument(text, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (parsed.errors.length > 0) {
    const duplicate = parsed.errors.some((error) => error.code === "DUPLICATE_KEY");
    fail(duplicate ? "YAML_DUPLICATE_KEY" : "YAML_SYNTAX", parsed.errors[0]?.message ?? "Invalid YAML", source);
  }

  let nodeCount = 0;
  visit(parsed, (_key, node, path) => {
    nodeCount += 1;
    if (nodeCount > MAX_NODES) fail("YAML_NODE_LIMIT", "YAML exceeds the node limit", source);
    if (path.length > MAX_DEPTH) fail("YAML_DEPTH_LIMIT", "YAML exceeds the depth limit", source);
    if (isAlias(node)) fail("YAML_ALIAS", "YAML aliases are not supported", source);
    if (typeof node === "object" && node !== null && "anchor" in node && typeof node.anchor === "string") {
      fail("YAML_ANCHOR", "YAML anchors are not supported", source);
    }
    if (typeof node === "object" && node !== null && "tag" in node && typeof node.tag === "string" && node.tag.startsWith("!")) {
      fail("YAML_CUSTOM_TAG", "YAML custom tags are not supported", source);
    }
  });

  return parsed.toJS({ maxAliasCount: 0, mapAsMap: false });
}

export function parseYamlMapping(text: string, source?: string): Record<string, unknown> {
  const value = parseYamlValue(text, source);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("YAML_ROOT_TYPE", "YAML root must be a mapping", source);
  }
  return value as Record<string, unknown>;
}

export function parseYamlDocument(text: string, source?: string): GitPmDocument {
  const record = parseYamlMapping(text, source);
  if (typeof record.schema !== "string") fail("SCHEMA_MISSING", "YAML document must contain schema", source);
  return record as GitPmDocument;
}

const fieldOrder: Record<string, readonly string[]> = {
  "gitpm/project@1": ["schema", "id", "name", "status", "lifecycle", "group", "description_markdown", "owner", "start", "due", "milestone_order", "labels"],
  "gitpm/task@1": ["schema", "id", "project", "title", "type", "status", "lifecycle", "description_markdown", "acceptance_criteria_markdown", "parent", "milestone", "assignees", "estimate_hours", "start", "due", "depends_on", "labels"],
  "gitpm/milestone@1": ["schema", "id", "project", "name", "lifecycle", "description_markdown", "due", "task_order"],
  "gitpm/person@1": ["schema", "id", "name", "weekly_capacity_hours", "calendar", "lifecycle", "email"],
  "gitpm/team@1": ["schema", "id", "name", "members", "lifecycle"],
  "gitpm/calendar@1": ["schema", "id", "name", "working_weekdays", "holidays", "lifecycle"],
  "gitpm/saved-view@1": ["schema", "id", "project", "name", "kind", "filters", "group_by", "lifecycle"],
  "gitpm/comment@1": ["schema", "id", "project", "task", "author", "created_at", "updated_at", "state", "body_markdown", "mentions", "deleted_at", "deleted_by"],
  "gitpm/repository@1": ["schema", "default_branch", "default_calendar", "allowed_top_level_files", "allowed_top_level_directories", "ui_poll_interval_seconds"],
  "gitpm/statuses@1": ["schema", "statuses"],
  "gitpm/issue-types@1": ["schema", "issue_types"],
};

function orderedRecord(value: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of order) {
    if (value[key] !== undefined) result[key] = value[key];
  }
  for (const key of Object.keys(value).sort()) {
    if (!(key in result)) result[key] = value[key];
  }
  return result;
}

function normalizeNested(document: GitPmDocument): Record<string, unknown> {
  const result = orderedRecord(document as Record<string, unknown>, fieldOrder[document.schema] ?? ["schema"]);
  if (document.schema === "gitpm/saved-view@1" && result.filters && typeof result.filters === "object") {
    result.filters = orderedRecord(result.filters as Record<string, unknown>, ["statuses", "types", "assignees", "milestones", "labels"]);
  }
  if (document.schema === "gitpm/comment@1") {
    if (result.author && typeof result.author === "object") result.author = orderedRecord(result.author as Record<string, unknown>, ["provider", "instance", "subject", "display_name"]);
    if (result.deleted_by && typeof result.deleted_by === "object") result.deleted_by = orderedRecord(result.deleted_by as Record<string, unknown>, ["provider", "instance", "subject", "display_name"]);
    if (Array.isArray(result.mentions)) result.mentions = (result.mentions as Record<string, unknown>[]).map((item) => orderedRecord(item, ["person", "mentioned_at"]));
  }
  const listKey = document.schema === "gitpm/statuses@1" ? "statuses" : document.schema === "gitpm/issue-types@1" ? "issue_types" : undefined;
  if (listKey && Array.isArray(result[listKey])) {
    result[listKey] = (result[listKey] as Record<string, unknown>[]).map((item) =>
      orderedRecord(item, ["slug", "title", "color", "active"]));
  }
  return result;
}

const schemaKinds: Readonly<Record<string, string>> = {
  "gitpm/project@1": "project",
  "gitpm/task@1": "task",
  "gitpm/milestone@1": "milestone",
  "gitpm/person@1": "person",
  "gitpm/team@1": "team",
  "gitpm/calendar@1": "calendar",
  "gitpm/saved-view@1": "view",
};

function singleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
}

export function referenceLabelForDocument(document: GitPmDocument): string | undefined {
  if (typeof document.id !== "string") return undefined;
  const displayValue = typeof document.title === "string" ? document.title : typeof document.name === "string" ? document.name : undefined;
  if (displayValue === undefined) return undefined;
  const display = singleLine(displayValue);
  if (display === "") return undefined;
  const kind = schemaKinds[document.schema] ?? document.schema.replace(/^gitpm\//u, "").replace(/@.*$/u, "");
  return `${kind}: ${display}`;
}

export function referenceLabelsForDocuments(documents: Iterable<GitPmDocument>): ReferenceLabels {
  const labels = new Map<string, string>();
  for (const document of documents) {
    if (typeof document.id !== "string") continue;
    const label = referenceLabelForDocument(document);
    if (label !== undefined) labels.set(document.id, label);
  }
  return labels;
}

export function formatYamlDocument(document: GitPmDocument, referenceLabels: ReferenceLabels = new Map()): string {
  const yaml = new Document(normalizeNested(document));
  visit(yaml, {
    Scalar(key, node) {
      if (key === "key" || typeof node.value !== "string") return;
      const label = referenceLabels.get(node.value);
      if (label !== undefined) node.comment = ` ${label}`;
    },
  });
  return yaml.toString({
    indent: 2,
    lineWidth: 0,
  });
}

export function formatYamlText(text: string, source?: string, referenceLabels?: ReferenceLabels): string {
  return formatYamlDocument(parseYamlDocument(text, source), referenceLabels);
}
