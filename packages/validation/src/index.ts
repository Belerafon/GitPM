import { readdir, readFile, realpath, stat } from "node:fs/promises";
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
  readonly field?: string;
  readonly schema_keyword?: string;
  readonly schema_params?: Readonly<Record<string, unknown>>;
  readonly expected?: string;
}

function schemaField(instancePath: string, params: Readonly<Record<string, unknown>>): string | undefined {
  if (typeof params.missingProperty === "string") return params.missingProperty;
  const segments = instancePath.split("/").filter(Boolean);
  return segments.length === 0 ? undefined : segments.map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~")).join(".");
}

function schemaExpectation(field: string | undefined): string | undefined {
  if (field === "calendar") return "existing Calendar ID matching C-YY-XXXXXX";
  if (field === "id") return "entity ID matching <type>-<UTC YY>-<6 Crockford Base32>";
  if (field === "lifecycle") return "active or archived";
  if (field === "weekly_capacity_hours") return "nonnegative number";
  if (field === "email") return "email address";
  return undefined;
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

interface CachedDocument {
  readonly cacheKey: string;
  readonly document?: LoadedDocument;
  readonly issues: readonly ValidationIssue[];
  readonly structurallyValid: boolean;
}

const documentCache = new Map<string, Map<string, CachedDocument>>();

const schemaIds = new Map([
  ["gitpm/project@1", "https://gitpm.dev/schemas/v1/project.schema.json"],
  ["gitpm/task@1", "https://gitpm.dev/schemas/v1/task.schema.json"],
  ["gitpm/milestone@1", "https://gitpm.dev/schemas/v1/milestone.schema.json"],
  ["gitpm/person@1", "https://gitpm.dev/schemas/v1/person.schema.json"],
  ["gitpm/team@1", "https://gitpm.dev/schemas/v1/team.schema.json"],
  ["gitpm/calendar@1", "https://gitpm.dev/schemas/v1/calendar.schema.json"],
  ["gitpm/saved-view@1", "https://gitpm.dev/schemas/v1/saved-view.schema.json"],
  ["gitpm/comment@1", "https://gitpm.dev/schemas/v1/comment.schema.json"],
  ["gitpm/repository@1", "https://gitpm.dev/schemas/v1/repository.schema.json"],
  ["gitpm/statuses@1", "https://gitpm.dev/schemas/v1/statuses.schema.json"],
  ["gitpm/issue-types@1", "https://gitpm.dev/schemas/v1/issue-types.schema.json"],
]);

const normalize = (value: string) => value.split(path.sep).join("/");

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return await filesUnder(absolute);
    return entry.name.endsWith(".yaml") ? [absolute] : [];
  }));
  return nested.flat().sort();
}

let validatorsPromise: Promise<Map<string, ValidateFunction>> | undefined;

async function loadSchemaValidators(): Promise<Map<string, ValidateFunction>> {
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

async function schemaValidators(): Promise<Map<string, ValidateFunction>> {
  validatorsPromise ??= loadSchemaValidators();
  return await validatorsPromise;
}

function expectedPath(document: GitPmDocument): string | undefined {
  const id = String(document.id ?? "");
  const project = String(document.project ?? "");
  switch (document.schema) {
    case "gitpm/project@1": return `projects/${id}/project.yaml`;
    case "gitpm/task@1": return `projects/${project}/tasks/${id}.yaml`;
    case "gitpm/milestone@1": return `projects/${project}/milestones/${id}.yaml`;
    case "gitpm/saved-view@1": return `projects/${project}/views/${id}.yaml`;
    case "gitpm/comment@1": return `projects/${project}/comments/${String(document.task ?? "")}/${id}.yaml`;
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
    case "gitpm/comment@1": return values([
      document.project,
      document.task,
      ...((document.mentions as Array<{ person?: unknown }> | undefined) ?? []).map((item) => item.person),
    ]);
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

  const previousCache = documentCache.get(root) ?? new Map<string, CachedDocument>();
  const nextCache = new Map<string, CachedDocument>();
  const loaded = await Promise.all((await filesUnder(root)).map(async (absolute): Promise<CachedDocument> => {
    const relative = normalize(path.relative(root, absolute));
    const metadata = await stat(absolute, { bigint: true });
    const cacheKey = `${metadata.size}:${metadata.mtimeNs}`;
    const cached = previousCache.get(relative);
    if (cached?.cacheKey === cacheKey) {
      nextCache.set(relative, cached);
      return cached;
    }
    const loadedIssues: ValidationIssue[] = [];
    try {
      const value = parseYamlDocument(await readFile(absolute, "utf8"), relative);
      const validator = validators.get(value.schema);
      let structurallyValid = false;
      if (!validator) {
        loadedIssues.push({ severity: "error", code: "SCHEMA_UNKNOWN", path: relative, message: `Unknown schema ${value.schema}` });
      } else if (!validator(value)) {
        for (const error of validator.errors ?? []) {
          const params = error.params as Readonly<Record<string, unknown>>;
          const field = schemaField(error.instancePath, params);
          const expected = schemaExpectation(field);
          loadedIssues.push({
            severity: "error",
            code: "SCHEMA_INVALID",
            path: relative,
            message: error.message ?? "Schema validation failed",
            ...(field === undefined ? {} : { field }),
            schema_keyword: error.keyword,
            schema_params: params,
            ...(expected === undefined ? {} : { expected }),
          });
        }
      } else {
        structurallyValid = true;
      }
      const expected = expectedPath(value);
      if (expected && expected !== relative) {
        loadedIssues.push({
          severity: "error",
          code: value.schema === "gitpm/project@1" ? "PATH_PROJECT_DIRECTORY" : "PATH_ENTITY_FILENAME",
          path: relative,
          message: `Expected ${expected}`,
        });
      }
      const result = { cacheKey, document: { path: relative, value }, issues: loadedIssues, structurallyValid };
      nextCache.set(relative, result);
      return result;
    } catch (error) {
      const code = error instanceof RepositoryFormatError ? error.code : "YAML_READ";
      loadedIssues.push({ severity: "error", code, path: relative, message: error instanceof Error ? error.message : String(error) });
      const result = { cacheKey, document: undefined, issues: loadedIssues, structurallyValid: false };
      nextCache.set(relative, result);
      return result;
    }
  }));
  documentCache.set(root, nextCache);
  for (const item of loaded) {
    for (const issue of item.issues) add(issue);
    if (item.document) documents.push(item.document);
    if (item.document && item.structurallyValid) structurallyValid.add(item.document.path);
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
  const peopleByEmail = new Map<string, LoadedDocument>();
  for (const document of validDocuments.filter((item) => item.value.schema === "gitpm/person@1" && typeof item.value.email === "string")) {
    const email = String(document.value.email).trim().toLowerCase();
    const existing = peopleByEmail.get(email);
    if (existing !== undefined) {
      add({
        severity: "error",
        code: "PERSON_EMAIL_DUPLICATE",
        path: document.path,
        field: "email",
        message: `Person email duplicates ${existing.path}`,
      });
    } else peopleByEmail.set(email, document);
  }

  const repository = validDocuments.find((document) => document.value.schema === "gitpm/repository@1");
  const statusDocument = validDocuments.find((document) => document.value.schema === "gitpm/statuses@1");
  const typeDocument = validDocuments.find((document) => document.value.schema === "gitpm/issue-types@1");
  const statuses = new Set(((statusDocument?.value.statuses as Array<{ slug: string }> | undefined) ?? []).map((item) => item.slug));
  const issueTypes = new Set(((typeDocument?.value.issue_types as Array<{ slug: string }> | undefined) ?? []).map((item) => item.slug));

  const allowedTop = new Set([
    ".git",
    ".gitpm",
    ".agents",
    "AGENTS.md",
    ".gitignore",
    "people",
    "teams",
    "calendars",
    "projects",
    ...values(repository?.value.allowed_top_level_files),
    ...values(repository?.value.allowed_top_level_directories),
  ]);
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
    } else if (value.schema === "gitpm/comment@1") {
      reference(value.project, "gitpm/project@1", document);
      const task = reference(value.task, "gitpm/task@1", document);
      if (task && task.value.project !== value.project) add({ severity: "error", code: "REF_CROSS_PROJECT", path: document.path, message: `${String(value.task)} belongs to another project` });
      const mentions = (value.mentions as Array<{ person?: unknown; mentioned_at?: unknown }> | undefined) ?? [];
      const mentionedPeople = mentions.map((mention) => mention.person).filter((person): person is string => typeof person === "string");
      if (new Set(mentionedPeople).size !== mentionedPeople.length) add({ severity: "error", code: "COMMENT_MENTION_DUPLICATE", path: document.path, message: "Comment mentions the same person more than once" });
      const embeddedPeople = typeof value.body_markdown === "string"
        ? [...value.body_markdown.matchAll(/@\[[^\]\r\n]{1,200}\]\(person:(U-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6})\)/gu)].map((match) => match[1]!)
        : [];
      const uniqueEmbeddedPeople = [...new Set(embeddedPeople)];
      if (uniqueEmbeddedPeople.length !== mentionedPeople.length || uniqueEmbeddedPeople.some((person, index) => person !== mentionedPeople[index])) add({ severity: "error", code: "COMMENT_MENTION_MISMATCH", path: document.path, message: "Comment mention metadata must match body_markdown" });
      for (const person of mentionedPeople) reference(person, "gitpm/person@1", document);
      for (const mention of mentions) if (typeof mention.mentioned_at === "string" && typeof value.created_at === "string" && mention.mentioned_at < value.created_at) add({ severity: "error", code: "COMMENT_TIMESTAMP_ORDER", path: document.path, message: "mentioned_at must not be before created_at" });
      if (typeof value.updated_at === "string" && typeof value.created_at === "string" && value.updated_at < value.created_at) add({ severity: "error", code: "COMMENT_TIMESTAMP_ORDER", path: document.path, message: "updated_at must not be before created_at" });
      if (typeof value.deleted_at === "string" && typeof value.created_at === "string" && value.deleted_at < value.created_at) add({ severity: "error", code: "COMMENT_TIMESTAMP_ORDER", path: document.path, message: "deleted_at must not be before created_at" });
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
