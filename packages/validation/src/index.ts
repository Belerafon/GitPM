import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { CalendarError, parseDateOnly, validateCalendar } from "@gitpm/calendar";
import { parseYamlDocument, RepositoryFormatError } from "@gitpm/repository-format";
import type { GitPmDocument } from "@gitpm/repository-format";

export interface ValidationIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ValidationReport {
  readonly valid: boolean;
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
  readonly documentCount: number;
}

interface LoadedDocument {
  readonly path: string;
  readonly value: GitPmDocument;
}

const schemaIds = new Map([
  ["gitpm/project@1", "https://gitpm.dev/schemas/v1/project.schema.json"],
  ["gitpm/task@1", "https://gitpm.dev/schemas/v1/task.schema.json"],
  ["gitpm/milestone@1", "https://gitpm.dev/schemas/v1/milestone.schema.json"],
  ["gitpm/person@1", "https://gitpm.dev/schemas/v1/person.schema.json"],
  ["gitpm/team@1", "https://gitpm.dev/schemas/v1/team.schema.json"],
  ["gitpm/calendar@1", "https://gitpm.dev/schemas/v1/calendar.schema.json"],
  ["gitpm/saved-view@1", "https://gitpm.dev/schemas/v1/saved-view.schema.json"],
  ["gitpm/repository@1", "https://gitpm.dev/schemas/v1/repository.schema.json"],
  ["gitpm/statuses@1", "https://gitpm.dev/schemas/v1/statuses.schema.json"],
  ["gitpm/issue-types@1", "https://gitpm.dev/schemas/v1/issue-types.schema.json"],
]);

const normalize = (value: string) => value.split(path.sep).join("/");

async function filesUnder(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(absolute));
    else if (entry.name.endsWith(".yaml")) result.push(absolute);
  }
  return result.sort();
}

async function schemaValidators(): Promise<Map<string, ValidateFunction>> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const schemaDirectory = path.resolve(moduleDirectory, "../../../schemas/v1");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const entry of await readdir(schemaDirectory)) {
    if (entry.endsWith(".schema.json")) {
      ajv.addSchema(JSON.parse(await readFile(path.join(schemaDirectory, entry), "utf8")));
    }
  }
  const result = new Map<string, ValidateFunction>();
  for (const [schema, id] of schemaIds) {
    const validator = ajv.getSchema(id);
    if (!validator) throw new Error(`Schema validator unavailable: ${id}`);
    result.set(schema, validator);
  }
  return result;
}

function expectedPath(document: GitPmDocument): string | undefined {
  const id = String(document.id ?? "");
  const project = String(document.project ?? "");
  switch (document.schema) {
    case "gitpm/project@1": return `projects/${id}/project.yaml`;
    case "gitpm/task@1": return `projects/${project}/tasks/${id}.yaml`;
    case "gitpm/milestone@1": return `projects/${project}/milestones/${id}.yaml`;
    case "gitpm/saved-view@1": return `projects/${project}/views/${id}.yaml`;
    case "gitpm/person@1": return `people/${id}.yaml`;
    case "gitpm/team@1": return `teams/${id}.yaml`;
    case "gitpm/calendar@1": return `calendars/${id}.yaml`;
    case "gitpm/repository@1": return ".gitpm/repository.yaml";
    case "gitpm/statuses@1": return ".gitpm/statuses.yaml";
    case "gitpm/issue-types@1": return ".gitpm/issue-types.yaml";
    default: return undefined;
  }
}

function values(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function directReferences(document: GitPmDocument): string[] {
  switch (document.schema) {
    case "gitpm/repository@1": return values([document.default_calendar]);
    case "gitpm/project@1": return values([document.owner]);
    case "gitpm/person@1": return values([document.calendar]);
    case "gitpm/team@1": return values(document.members);
    case "gitpm/milestone@1": return values([document.project]);
    case "gitpm/task@1": return values([
      document.project,
      document.parent,
      document.milestone,
      ...values(document.assignees),
      ...values(document.depends_on),
    ]);
    case "gitpm/saved-view@1": {
      const filters = document.filters as Record<string, unknown> | undefined;
      return values([
        document.project,
        ...values(filters?.assignees),
        ...values(filters?.milestones),
      ]);
    }
    default: return [];
  }
}

function detectCycles(
  nodes: readonly LoadedDocument[],
  edges: (document: GitPmDocument) => readonly string[],
  code: string,
  add: (issue: ValidationIssue) => void,
): void {
  const byId = new Map(nodes.map((document) => [String(document.value.id), document]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): void => {
    if (visiting.has(id)) {
      add({ severity: "error", code, path: byId.get(id)?.path ?? id, message: `Cycle contains ${id}` });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const document = byId.get(id);
    if (document) for (const target of edges(document.value)) if (byId.has(target)) walk(target);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) walk(id);
}

export async function validateRepository(repositoryRoot: string): Promise<ValidationReport> {
  const root = await realpath(repositoryRoot);
  const validators = await schemaValidators();
  const issues: ValidationIssue[] = [];
  const add = (issue: ValidationIssue) => issues.push(issue);
  const documents: LoadedDocument[] = [];
  const structurallyValid = new Set<string>();

  for (const absolute of await filesUnder(root)) {
    const relative = normalize(path.relative(root, absolute));
    try {
      const value = parseYamlDocument(await readFile(absolute, "utf8"), relative);
      documents.push({ path: relative, value });
      const validator = validators.get(value.schema);
      if (!validator) {
        add({ severity: "error", code: "SCHEMA_UNKNOWN", path: relative, message: `Unknown schema ${value.schema}` });
      } else if (!validator(value)) {
        add({ severity: "error", code: "SCHEMA_INVALID", path: relative, message: validator.errors?.[0]?.message ?? "Schema validation failed" });
      } else {
        structurallyValid.add(relative);
      }
      const expected = expectedPath(value);
      if (expected && expected !== relative) {
        add({
          severity: "error",
          code: value.schema === "gitpm/project@1" ? "PATH_PROJECT_DIRECTORY" : "PATH_ENTITY_FILENAME",
          path: relative,
          message: `Expected ${expected}`,
        });
      }
    } catch (error) {
      const code = error instanceof RepositoryFormatError ? error.code : "YAML_READ";
      add({ severity: "error", code, path: relative, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const validDocuments = documents.filter((document) => structurallyValid.has(document.path));
  const byId = new Map<string, LoadedDocument>();
  for (const document of validDocuments) {
    if (typeof document.value.id !== "string") continue;
    if (byId.has(document.value.id)) {
      add({ severity: "error", code: "IDENTITY_DUPLICATE", path: document.path, message: `Duplicate ID ${document.value.id}` });
    } else {
      byId.set(document.value.id, document);
    }
  }

  const repository = validDocuments.find((document) => document.value.schema === "gitpm/repository@1");
  const statusDocument = validDocuments.find((document) => document.value.schema === "gitpm/statuses@1");
  const typeDocument = validDocuments.find((document) => document.value.schema === "gitpm/issue-types@1");
  const statuses = new Set(((statusDocument?.value.statuses as Array<{ slug: string }> | undefined) ?? []).map((item) => item.slug));
  const issueTypes = new Set(((typeDocument?.value.issue_types as Array<{ slug: string }> | undefined) ?? []).map((item) => item.slug));

  const allowedTop = new Set([".gitpm", "people", "teams", "calendars", "projects", ...values(repository?.value.allowed_top_level_files)]);
  for (const entry of await readdir(root)) {
    if (!allowedTop.has(entry)) add({ severity: "error", code: "REPOSITORY_TOP_LEVEL", path: entry, message: "Unknown top-level entry" });
  }

  const reference = (id: unknown, schema: string, owner: LoadedDocument): LoadedDocument | undefined => {
    if (typeof id !== "string") return undefined;
    const target = byId.get(id);
    if (!target || target.value.schema !== schema) {
      add({ severity: "error", code: "REF_MISSING", path: owner.path, message: `${id} does not reference ${schema}` });
      return undefined;
    }
    if (target.value.lifecycle === "archived") {
      add({ severity: "warning", code: "REF_ARCHIVED", path: owner.path, message: `${id} is archived` });
    }
    return target;
  };

  if (repository) reference(repository.value.default_calendar, "gitpm/calendar@1", repository);
  for (const document of validDocuments) {
    const value = document.value;
    const validateDate = (field: string): void => {
      if (typeof value[field] !== "string") return;
      try { parseDateOnly(value[field]); } catch (error) {
        add({ severity: "error", code: "DATE_INVALID", path: document.path, message: error instanceof Error ? error.message : String(error) });
      }
    };
    validateDate("start"); validateDate("due");
    if (typeof value.start === "string" && typeof value.due === "string" && value.start > value.due) {
      add({ severity: "error", code: "DATE_RANGE", path: document.path, message: "start must not be after due" });
    }
    if (value.schema === "gitpm/calendar@1") {
      try {
        validateCalendar({ working_weekdays: value.working_weekdays as number[], holidays: value.holidays as string[] });
      } catch (error) {
        const code = error instanceof CalendarError ? error.code : "CALENDAR_INVALID";
        add({ severity: "error", code, path: document.path, message: error instanceof Error ? error.message : String(error) });
      }
    } else if (value.schema === "gitpm/project@1") {
      if (!statuses.has(String(value.status))) add({ severity: "error", code: "CONFIG_REFERENCE", path: document.path, message: `Unknown status ${String(value.status)}` });
      reference(value.owner, "gitpm/person@1", document);
    } else if (value.schema === "gitpm/person@1") {
      reference(value.calendar, "gitpm/calendar@1", document);
    } else if (value.schema === "gitpm/team@1") {
      for (const member of values(value.members)) reference(member, "gitpm/person@1", document);
    } else if (value.schema === "gitpm/milestone@1") {
      reference(value.project, "gitpm/project@1", document);
    } else if (value.schema === "gitpm/task@1") {
      reference(value.project, "gitpm/project@1", document);
      if (!statuses.has(String(value.status))) add({ severity: "error", code: "CONFIG_REFERENCE", path: document.path, message: `Unknown status ${String(value.status)}` });
      if (!issueTypes.has(String(value.type))) add({ severity: "error", code: "CONFIG_REFERENCE", path: document.path, message: `Unknown type ${String(value.type)}` });
      for (const assignee of values(value.assignees)) reference(assignee, "gitpm/person@1", document);
      for (const [id, schema] of [
        ...(typeof value.parent === "string" ? [[value.parent, "gitpm/task@1"]] : []),
        ...(typeof value.milestone === "string" ? [[value.milestone, "gitpm/milestone@1"]] : []),
        ...values(value.depends_on).map((id) => [id, "gitpm/task@1"]),
      ] as Array<[string, string]>) {
        const target = reference(id, schema, document);
        if (target && target.value.project !== value.project) add({ severity: "error", code: "REF_CROSS_PROJECT", path: document.path, message: `${id} belongs to another project` });
      }
    } else if (value.schema === "gitpm/saved-view@1") {
      reference(value.project, "gitpm/project@1", document);
      const filters = value.filters as Record<string, unknown>;
      for (const assignee of values(filters.assignees)) reference(assignee, "gitpm/person@1", document);
      for (const milestone of values(filters.milestones)) {
        const target = reference(milestone, "gitpm/milestone@1", document);
        if (target && target.value.project !== value.project) add({ severity: "error", code: "REF_CROSS_PROJECT", path: document.path, message: `${milestone} belongs to another project` });
      }
      for (const status of values(filters.statuses)) if (!statuses.has(status)) add({ severity: "error", code: "CONFIG_REFERENCE", path: document.path, message: `Unknown status ${status}` });
      for (const issueType of values(filters.types)) if (!issueTypes.has(issueType)) add({ severity: "error", code: "CONFIG_REFERENCE", path: document.path, message: `Unknown type ${issueType}` });
    }
  }

  const tasks = validDocuments.filter((document) => document.value.schema === "gitpm/task@1");
  detectCycles(tasks, (value) => typeof value.parent === "string" ? [value.parent] : [], "TASK_PARENT_CYCLE", add);
  detectCycles(tasks, (value) => values(value.depends_on), "TASK_DEPENDENCY_CYCLE", add);

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return { valid: errors.length === 0, errors, warnings, documentCount: documents.length };
}

export async function validateDelete(repositoryRoot: string, entityId: string): Promise<readonly ValidationIssue[]> {
  const root = await realpath(repositoryRoot);
  const issues: ValidationIssue[] = [];
  for (const absolute of await filesUnder(root)) {
    const relative = normalize(path.relative(root, absolute));
    try {
      const document = parseYamlDocument(await readFile(absolute, "utf8"), relative);
      if (directReferences(document).includes(entityId)) {
        issues.push({ severity: "error", code: "DELETE_RESTRICTED", path: relative, message: `${entityId} is still referenced` });
      }
    } catch {
      // Repository validation reports malformed documents separately.
    }
  }
  return issues;
}
