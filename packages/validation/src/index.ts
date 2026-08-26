import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { CalendarError, parseDateOnly, validateCalendar } from "@gitpm/calendar";
import { parseYamlDocument, RepositoryFormatError } from "@gitpm/repository-format";
import type { GitPmDocument } from "@gitpm/repository-format";
import { DOCUMENT_SCHEMA_DEFINITIONS, DOCUMENT_SCHEMA_IDS } from "@gitpm/contracts";
import { resolvePlanning, validatePlanning, type PlanningIssue, type PlanningSettings, type ScheduleTracksConfig } from "@gitpm/scheduling";
import { projectFileNameComparisonKey, projectFileNameInvalidReason } from "./project-files.js";

export {
  MAX_PROJECT_FILE_NAME_UTF16_LENGTH,
  projectFileNameComparisonKey,
  projectFileNameInvalidReason,
  type ProjectFileNameInvalidReason,
} from "./project-files.js";

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
  if (field === "annual_vacation_extra_days") return "positive whole number paired with annual_vacation_extra_days_reason";
  if (field === "annual_vacation_extra_days_reason") return "nonempty reason paired with annual_vacation_extra_days";
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

const MAX_CACHED_REPOSITORIES = 32;
const documentCache = new Map<string, Map<string, CachedDocument>>();

const normalize = (value: string) => value.split(path.sep).join("/");

const DOMAIN_DIRECTORIES = [".gitpm", "people", "teams", "calendars", "projects"] as const;
const OPTIONAL_DOMAIN_DIRECTORIES = ["availability"] as const;
const REQUIRED_DOCUMENTS = [
  ".gitpm/repository.yaml",
  ".gitpm/statuses.yaml",
  ".gitpm/issue-types.yaml",
  ".gitpm/schedule-tracks.yaml",
  ".gitpm/work-categories.yaml",
] as const;

export interface RepositoryFileDiscovery {
  readonly files: readonly string[];
  readonly issues: readonly ValidationIssue[];
}

async function filesUnder(
  root: string,
  directory: string,
  issues: ValidationIssue[],
): Promise<string[]> {
  const relativeDirectory = normalize(path.relative(root, directory));
  if (isProjectFilesDirectory(relativeDirectory)) {
    await validateProjectFilesDirectory(root, directory, issues);
    return [];
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    const relative = normalize(path.relative(root, absolute));
    if (entry.isSymbolicLink()) {
      issues.push({ severity: "error", code: "FS_SYMLINK", path: relative, message: "Repository domain paths must not contain symlinks" });
      return [];
    }
    if (entry.isDirectory()) {
      if (!isAllowedDomainDirectory(relative)) {
        issues.push({ severity: "error", code: "REPOSITORY_UNKNOWN_PATH", path: relative, message: "Unknown directory in repository domain layout" });
        return [];
      }
      return await filesUnder(root, absolute, issues);
    }
    if (!entry.isFile()) {
      issues.push({ severity: "error", code: "REPOSITORY_UNKNOWN_PATH", path: relative, message: "Unsupported repository domain entry" });
      return [];
    }
    if (isAllowedDomainKeeper(relative)) return [];
    if (!relative.endsWith(".yaml")) {
      issues.push({ severity: "error", code: "REPOSITORY_UNKNOWN_PATH", path: relative, message: "Unknown file in repository domain layout" });
      return [];
    }
    if (!isAllowedYamlContainer(relative)) {
      issues.push({ severity: "error", code: "REPOSITORY_UNKNOWN_PATH", path: relative, message: "YAML file is outside a supported repository domain path" });
    }
    return [absolute];
  }));
  return nested.flat();
}

function isProjectFilesDirectory(relative: string): boolean {
  return /^projects\/P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}\/files$/u.test(relative);
}

async function validateProjectFilesDirectory(
  root: string,
  directory: string,
  issues: ValidationIssue[],
): Promise<void> {
  const namesByComparisonKey = new Map<string, string>();
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));

  for (const entry of entries) {
    const relative = normalize(path.relative(root, path.join(directory, entry.name)));
    if (entry.isSymbolicLink()) {
      issues.push({ severity: "error", code: "FS_SYMLINK", path: relative, message: "Project files must not be symbolic links" });
      continue;
    }
    if (entry.isDirectory()) {
      issues.push({ severity: "error", code: "PROJECT_FILES_NESTED_DIRECTORY", path: relative, message: "Project file storage must be flat" });
      continue;
    }
    if (!entry.isFile()) {
      issues.push({ severity: "error", code: "REPOSITORY_UNKNOWN_PATH", path: relative, message: "Project file storage supports regular files only" });
      continue;
    }

    const invalidReason = projectFileNameInvalidReason(entry.name);
    if (invalidReason !== undefined) {
      issues.push({
        severity: "error",
        code: "PROJECT_FILE_NAME_INVALID",
        path: relative,
        message: `Project file name is not Windows-compatible (${invalidReason})`,
      });
      continue;
    }

    const comparisonKey = projectFileNameComparisonKey(entry.name);
    const existingName = namesByComparisonKey.get(comparisonKey);
    if (existingName !== undefined) {
      issues.push({
        severity: "error",
        code: "PROJECT_FILE_NAME_CONFLICT",
        path: relative,
        message: `Project file name conflicts with ${existingName} when compared without case`,
      });
    } else {
      namesByComparisonKey.set(comparisonKey, entry.name);
    }
  }
}

function isAllowedDomainDirectory(relative: string): boolean {
  return /^projects\/P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$/u.test(relative)
    || /^projects\/P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}\/(?:milestones|tasks|views|comments|time-entries|files)$/u.test(relative)
    || /^projects\/P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}\/comments\/T-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$/u.test(relative)
    || /^projects\/P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}\/time-entries\/T-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}$/u.test(relative);
}

function isAllowedDomainKeeper(relative: string): boolean {
  return ["people/.gitkeep", "teams/.gitkeep", "projects/.gitkeep", "availability/.gitkeep"].includes(relative);
}

function isAllowedYamlContainer(relative: string): boolean {
  return /^\.gitpm\/(?:repository|statuses|issue-types|schedule-tracks|work-categories)\.yaml$/u.test(relative)
    || /^(?:people|teams|calendars)\/[^/]+\.yaml$/u.test(relative)
    || /^availability\/A-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}\.yaml$/u.test(relative)
    || /^projects\/P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}\/project\.yaml$/u.test(relative)
    || /^projects\/P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}\/(?:milestones|tasks|views)\/[^/]+\.yaml$/u.test(relative)
    || /^projects\/P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}\/comments\/T-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}\/[^/]+\.yaml$/u.test(relative)
    || /^projects\/P-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}\/time-entries\/T-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}\/E-[0-9]{2}-[0-9A-HJKMNP-TV-Z]{6}\.yaml$/u.test(relative);
}

function cachedDocuments(root: string): Map<string, CachedDocument> {
  const cached = documentCache.get(root);
  if (cached === undefined) return new Map();
  documentCache.delete(root);
  documentCache.set(root, cached);
  return cached;
}

function storeCachedDocuments(root: string, documents: Map<string, CachedDocument>): void {
  documentCache.delete(root);
  documentCache.set(root, documents);
  while (documentCache.size > MAX_CACHED_REPOSITORIES) {
    const oldest = documentCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    documentCache.delete(oldest);
  }
}

export async function discoverRepositoryFiles(repositoryRoot: string): Promise<RepositoryFileDiscovery> {
  const root = await realpath(repositoryRoot);
  const issues: ValidationIssue[] = [];
  const files: string[] = [];

  for (const directory of DOMAIN_DIRECTORIES) {
    const absolute = path.join(root, directory);
    try {
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        issues.push({ severity: "error", code: "FS_SYMLINK", path: directory, message: "Required repository directory must not be a symlink" });
      } else if (!metadata.isDirectory()) {
        issues.push({ severity: "error", code: "REPOSITORY_DIRECTORY_REQUIRED", path: directory, message: "Required repository path must be a directory" });
      } else {
        files.push(...await filesUnder(root, absolute, issues));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      issues.push({ severity: "error", code: "REPOSITORY_DIRECTORY_REQUIRED", path: directory, message: "Required repository directory is missing" });
    }
  }

  for (const directory of OPTIONAL_DOMAIN_DIRECTORIES) {
    const absolute = path.join(root, directory);
    try {
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        issues.push({ severity: "error", code: "FS_SYMLINK", path: directory, message: "Optional repository directory must not be a symlink" });
      } else if (!metadata.isDirectory()) {
        issues.push({ severity: "error", code: "REPOSITORY_DIRECTORY_REQUIRED", path: directory, message: "Repository path must be a directory" });
      } else {
        files.push(...await filesUnder(root, absolute, issues));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const relativeFiles = new Set(files.map((absolute) => normalize(path.relative(root, absolute))));
  for (const required of REQUIRED_DOCUMENTS) {
    if (!relativeFiles.has(required)) {
      issues.push({ severity: "error", code: "REPOSITORY_DOCUMENT_REQUIRED", path: required, message: "Required repository configuration document is missing" });
    }
  }

  return { files: files.sort(), issues };
}

let validatorsPromise: Promise<Map<string, ValidateFunction>> | undefined;

async function loadSchemaValidators(): Promise<Map<string, ValidateFunction>> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of DOCUMENT_SCHEMA_DEFINITIONS) ajv.addSchema(schema);
  const result = new Map<string, ValidateFunction>();
  for (const [schema, id] of Object.entries(DOCUMENT_SCHEMA_IDS)) {
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
  const task = String(document.task ?? "");
  switch (document.schema) {
    case "gitpm/project@2": return `projects/${id}/project.yaml`;
    case "gitpm/task@2": return `projects/${project}/tasks/${id}.yaml`;
    case "gitpm/milestone@2": return `projects/${project}/milestones/${id}.yaml`;
    case "gitpm/saved-view@1": return `projects/${project}/views/${id}.yaml`;
    case "gitpm/comment@1": return `projects/${project}/comments/${task}/${id}.yaml`;
    case "gitpm/time-entry@1": return `projects/${project}/time-entries/${task}/${id}.yaml`;
    case "gitpm/person@1": return `people/${id}.yaml`;
    case "gitpm/team@1": return `teams/${id}.yaml`;
    case "gitpm/calendar@1": return `calendars/${id}.yaml`;
    case "gitpm/availability-event@1": return `availability/${id}.yaml`;
    case "gitpm/repository@1": return ".gitpm/repository.yaml";
    case "gitpm/statuses@2": return ".gitpm/statuses.yaml";
    case "gitpm/issue-types@1": return ".gitpm/issue-types.yaml";
    case "gitpm/schedule-tracks@1": return ".gitpm/schedule-tracks.yaml";
    case "gitpm/work-categories@1": return ".gitpm/work-categories.yaml";
    default: return undefined;
  }
}

function values(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function scheduleWindows(document: GitPmDocument): Record<string, unknown>[] {
  const schedules = document.schedules as Record<string, unknown> | undefined;
  if (schedules === undefined || typeof schedules !== "object" || Array.isArray(schedules)) return [];
  return Object.values(schedules).filter((window): window is Record<string, unknown> => window !== null && typeof window === "object" && !Array.isArray(window));
}

function directReferences(document: GitPmDocument): string[] {
  switch (document.schema) {
    case "gitpm/repository@1": return values([document.default_calendar]);
    case "gitpm/project@2": return values([document.owner]);
    case "gitpm/person@1": return values([document.calendar]);
    case "gitpm/team@1": return values(document.members);
    case "gitpm/milestone@2": return values([document.project]);
    case "gitpm/task@2": return values([
      document.project,
      document.parent,
      document.milestone,
      ...values(document.assignees),
      ...scheduleWindows(document).flatMap((window) => values(window.depends_on)),
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
    case "gitpm/time-entry@1": return values([document.project, document.task, document.person, document.replacement]);
    case "gitpm/availability-event@1": return values([document.person]);
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

function validateScheduleTrackDefinitions(document: LoadedDocument, add: (issue: ValidationIssue) => void): void {
  const tracks = (document.value.tracks as Array<Record<string, unknown>>) ?? [];
  for (const [index, track] of tracks.entries()) {
    const slug = typeof track.slug === "string" ? track.slug : `#${index}`;
    const kind = typeof track.kind === "string" ? track.kind : "";
    const field = `tracks.${slug}`;
    if (kind === "manual") {
      if (track.source !== undefined) add({ severity: "error", code: "TRACK_KIND_SOURCE_MISMATCH", path: document.path, field: `${field}.source`, message: `Manual track ${slug} must not define source` });
      const capabilities = Array.isArray(track.capabilities) ? track.capabilities : [];
      if (capabilities.length === 0) add({ severity: "error", code: "TRACK_CAPABILITY_REQUIRED", path: document.path, field: `${field}.capabilities`, message: `Manual track ${slug} must declare at least one capability` });
    } else if (kind === "actual") {
      if (track.source !== "time_entries") add({ severity: "error", code: "TRACK_KIND_SOURCE_MISMATCH", path: document.path, field: `${field}.source`, message: `Actual track ${slug} must define source: time_entries` });
      if (track.capabilities !== undefined) add({ severity: "error", code: "TRACK_CAPABILITY_NOT_ALLOWED", path: document.path, field: `${field}.capabilities`, message: `Actual track ${slug} must not declare capabilities` });
    }
  }
}

function addPlanningIssues(
  path: string,
  fieldPrefix: string,
  issues: readonly PlanningIssue[],
  add: (issue: ValidationIssue) => void,
): void {
  for (const issue of issues) {
    add({ severity: "error", code: issue.code, path, field: `${fieldPrefix}.${issue.field}`, message: issue.message });
  }
}

export async function validateRepository(repositoryRoot: string): Promise<ValidationReport> {
  const root = await realpath(repositoryRoot);
  const validators = await schemaValidators();
  const issues: ValidationIssue[] = [];
  const add = (issue: ValidationIssue) => issues.push(issue);
  const documents: LoadedDocument[] = [];
  const structurallyValid = new Set<string>();
  const discovery = await discoverRepositoryFiles(root);
  for (const issue of discovery.issues) add(issue);

  const previousCache = cachedDocuments(root);
  const nextCache = new Map<string, CachedDocument>();
  const loaded = await Promise.all(discovery.files.map(async (absolute): Promise<CachedDocument> => {
    const relative = normalize(path.relative(root, absolute));
    const source = await readFile(absolute, "utf8");
    const cacheKey = createHash("sha256").update(source).digest("hex");
    const cached = previousCache.get(relative);
    if (cached?.cacheKey === cacheKey) {
      nextCache.set(relative, cached);
      return cached;
    }
    const loadedIssues: ValidationIssue[] = [];
    try {
      const value = parseYamlDocument(source, relative);
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
          code: value.schema === "gitpm/project@2" ? "PATH_PROJECT_DIRECTORY" : "PATH_ENTITY_FILENAME",
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
  storeCachedDocuments(root, nextCache);
  for (const item of loaded) {
    for (const issue of item.issues) add(issue);
    if (item.document) documents.push(item.document);
    if (item.document && item.structurallyValid) structurallyValid.add(item.document.path);
  }

  const validDocuments = documents.filter((document) => structurallyValid.has(document.path));
  for (const document of documents) {
    if (document.value.schema !== "gitpm/time-entry@1") continue;
    const value = document.value;
    if (value.state === "voided") {
      if (value.voided_at === undefined || value.voided_by === undefined) {
        add({ severity: "error", code: "TIME_ENTRY_VOID_METADATA_REQUIRED", path: document.path, message: "Voided time entries require voided_at and voided_by" });
      }
    } else if (value.state === "active" && (value.voided_at !== undefined || value.voided_by !== undefined || value.replacement !== undefined)) {
      add({ severity: "error", code: "TIME_ENTRY_VOID_FIELDS_FORBIDDEN", path: document.path, message: "Active time entries cannot contain voiding fields" });
    }
  }
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
  const statusDocument = validDocuments.find((document) => document.value.schema === "gitpm/statuses@2");
  const typeDocument = validDocuments.find((document) => document.value.schema === "gitpm/issue-types@1");
  const tracksDocument = validDocuments.find((document) => document.value.schema === "gitpm/schedule-tracks@1");
  const categoriesDocument = validDocuments.find((document) => document.value.schema === "gitpm/work-categories@1");
  const statuses = new Set(((statusDocument?.value.statuses as Array<{ slug: string }> | undefined) ?? []).map((item) => item.slug));
  const issueTypes = new Set(((typeDocument?.value.issue_types as Array<{ slug: string }> | undefined) ?? []).map((item) => item.slug));
  const categories = new Set(((categoriesDocument?.value.categories as Array<{ slug: string }> | undefined) ?? []).map((item) => item.slug));
  const tracks = new Map<string, { readonly kind: string; readonly capabilities: ReadonlySet<string>; readonly source?: string }>();
  let actualTrackCount = 0;
  for (const track of ((tracksDocument?.value.tracks as Array<Record<string, unknown>>) ?? [])) {
    const slug = typeof track.slug === "string" ? track.slug : "";
    if (slug === "") continue;
    if (tracks.has(slug)) {
      add({ severity: "error", code: "TRACK_SLUG_DUPLICATE", path: tracksDocument?.path ?? ".gitpm/schedule-tracks.yaml", field: `tracks.${slug}`, message: `Duplicate schedule track slug ${slug}` });
      continue;
    }
    const kind = typeof track.kind === "string" ? track.kind : "";
    if (kind === "actual") actualTrackCount += 1;
    tracks.set(slug, { kind, capabilities: new Set(Array.isArray(track.capabilities) ? track.capabilities.filter((c): c is string => typeof c === "string") : []), source: typeof track.source === "string" ? track.source : undefined });
  }
  if (actualTrackCount > 1) {
    add({ severity: "error", code: "TRACK_ACTUAL_COUNT", path: tracksDocument?.path ?? ".gitpm/schedule-tracks.yaml", field: "tracks", message: `At most one actual track is allowed (found ${actualTrackCount})` });
  }
  if (tracksDocument !== undefined) validateScheduleTrackDefinitions(tracksDocument, add);
  const schedulingConfig = tracksDocument?.value as unknown as ScheduleTracksConfig | undefined;
  const defaultPlanning = schedulingConfig === undefined ? undefined : resolvePlanning(schedulingConfig);
  if (tracksDocument !== undefined && schedulingConfig !== undefined && defaultPlanning !== undefined) {
    addPlanningIssues(tracksDocument.path, "defaults", validatePlanning(schedulingConfig, defaultPlanning), add);
  }

  const projectsById = new Map<string, LoadedDocument>();
  for (const document of validDocuments) if (document.value.schema === "gitpm/project@2" && typeof document.value.id === "string") projectsById.set(document.value.id, document);
  const projectEnabledTracks = new Map<string, ReadonlySet<string>>();
  if (schedulingConfig !== undefined) {
    for (const [projectId, document] of projectsById) {
      const planning = document.value.planning as Partial<PlanningSettings> | undefined;
      projectEnabledTracks.set(projectId, new Set(resolvePlanning(schedulingConfig, planning).enabled_tracks));
    }
  }

  const allowedTop = new Set([
    ".git",
    ".gitpm",
    ".agents",
    "AGENTS.md",
    ".gitignore",
    "people",
    "teams",
    "calendars",
    "availability",
    "projects",
    ...values(repository?.value.allowed_top_level_files),
    ...values(repository?.value.allowed_top_level_directories),
  ]);
  const discoveryIssueKeys = new Set(discovery.issues.map((issue) => `${issue.code}:${issue.path}`));
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() && !discoveryIssueKeys.has(`FS_SYMLINK:${entry.name}`)) {
      add({ severity: "error", code: "FS_SYMLINK", path: entry.name, message: "Repository top-level paths must not be symlinks" });
    } else if (!allowedTop.has(entry.name)) {
      const kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "entry";
      const allowList = entry.isDirectory() ? "allowed_top_level_directories" : "allowed_top_level_files";
      add({
        severity: "error",
        code: "REPOSITORY_TOP_LEVEL",
        path: entry.name,
        message: `Unknown top-level ${kind} "${entry.name}"; add it to ${allowList} in .gitpm/repository.yaml if it belongs in the repository`,
      });
    }
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

  const validateWindowDates = (owner: LoadedDocument, window: Record<string, unknown>, fieldPath: string): void => {
    for (const field of ["start", "finish"] as const) {
      if (typeof window[field] === "string") {
        try { parseDateOnly(window[field] as string); } catch (error) {
          add({ severity: "error", code: "DATE_INVALID", path: `${owner.path}#${fieldPath}.${field}`, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    if (typeof window.start === "string" && typeof window.finish === "string" && window.start > window.finish) {
      add({ severity: "error", code: "DATE_RANGE", path: `${owner.path}#${fieldPath}`, message: "start must not be after finish" });
    }
  };

  const validateScheduleWindows = (owner: LoadedDocument, enabledTracks?: ReadonlySet<string>): void => {
    const schedules = owner.value.schedules as Record<string, Record<string, unknown>> | undefined;
    if (schedules === undefined || typeof schedules !== "object" || Array.isArray(schedules)) return;
    for (const [trackSlug, window] of Object.entries(schedules)) {
      if (window === null || typeof window !== "object" || Array.isArray(window)) continue;
      const track = tracks.get(trackSlug);
      if (track === undefined) {
        add({ severity: "error", code: "SCHEDULE_TRACK_UNKNOWN", path: owner.path, field: `schedules.${trackSlug}`, message: `Unknown schedule track ${trackSlug}` });
        continue;
      }
      if (track.kind === "actual") {
        add({ severity: "error", code: "SCHEDULE_ACTUAL_NOT_EDITABLE", path: owner.path, field: `schedules.${trackSlug}`, message: `Actual track ${trackSlug} is computed and cannot be stored` });
      }
      if (enabledTracks !== undefined && !enabledTracks.has(trackSlug)) {
        add({ severity: "error", code: "SCHEDULE_TRACK_NOT_ENABLED", path: owner.path, field: `schedules.${trackSlug}`, message: `Schedule track ${trackSlug} is not enabled in the owning project` });
      }
      const hasContent = (window.start !== undefined && window.start !== "") || (window.finish !== undefined && window.finish !== "") || window.effort_hours !== undefined || (Array.isArray(window.depends_on) && window.depends_on.length > 0);
      if (!hasContent) {
        add({ severity: "error", code: "SCHEDULE_WINDOW_EMPTY", path: owner.path, field: `schedules.${trackSlug}`, message: `Schedule window ${trackSlug} must not be empty` });
      }
      if ((window.start !== undefined || window.finish !== undefined) && !track.capabilities.has("dates")) {
        add({ severity: "error", code: "CAPABILITY_DATES_NOT_ALLOWED", path: owner.path, field: `schedules.${trackSlug}`, message: `Track ${trackSlug} does not allow dates` });
      }
      validateWindowDates(owner, window, `schedules.${trackSlug}`);
      if (window.effort_hours !== undefined && !track.capabilities.has("effort")) {
        add({ severity: "error", code: "CAPABILITY_EFFORT_NOT_ALLOWED", path: owner.path, field: `schedules.${trackSlug}.effort_hours`, message: `Track ${trackSlug} does not allow effort` });
      }
      if (Array.isArray(window.depends_on) && window.depends_on.length > 0 && !track.capabilities.has("dependencies")) {
        add({ severity: "error", code: "CAPABILITY_DEPENDENCIES_NOT_ALLOWED", path: owner.path, field: `schedules.${trackSlug}.depends_on`, message: `Track ${trackSlug} does not allow dependencies` });
      }
    }
  };

  if (repository) reference(repository.value.default_calendar, "gitpm/calendar@1", repository);
  for (const document of validDocuments) {
    const value = document.value;
    if (value.schema === "gitpm/calendar@1") {
      try {
        validateCalendar({ working_weekdays: value.working_weekdays as number[], holidays: value.holidays as string[] });
      } catch (error) {
        const code = error instanceof CalendarError ? error.code : "CALENDAR_INVALID";
        add({ severity: "error", code, path: document.path, message: error instanceof Error ? error.message : String(error) });
      }
    } else if (value.schema === "gitpm/project@2") {
      if (!statuses.has(String(value.status))) add({ severity: "error", code: "CONFIG_REFERENCE", path: document.path, message: `Unknown status ${String(value.status)}` });
      reference(value.owner, "gitpm/person@1", document);
      if (schedulingConfig !== undefined) {
        const planning = value.planning as Partial<PlanningSettings> | undefined;
        const resolved = resolvePlanning(schedulingConfig, planning);
        validateScheduleWindows(document, new Set(resolved.enabled_tracks));
        addPlanningIssues(document.path, "planning", validatePlanning(schedulingConfig, resolved), add);
      }
    } else if (value.schema === "gitpm/person@1") {
      reference(value.calendar, "gitpm/calendar@1", document);
    } else if (value.schema === "gitpm/availability-event@1") {
      reference(value.person, "gitpm/person@1", document);
      for (const field of ["start", "finish"] as const) if (typeof value[field] === "string") {
        try { parseDateOnly(value[field] as string); } catch (error) {
          add({ severity: "error", code: "DATE_INVALID", path: document.path, field, message: error instanceof Error ? error.message : String(error) });
        }
      }
      if (typeof value.start === "string" && typeof value.finish === "string" && value.start > value.finish) {
        add({ severity: "error", code: "DATE_RANGE", path: document.path, message: "start must not be after finish" });
      }
    } else if (value.schema === "gitpm/team@1") {
      for (const member of values(value.members)) reference(member, "gitpm/person@1", document);
    } else if (value.schema === "gitpm/milestone@2") {
      reference(value.project, "gitpm/project@2", document);
      validateScheduleWindows(document, typeof value.project === "string" ? projectEnabledTracks.get(value.project) : undefined);
    } else if (value.schema === "gitpm/task@2") {
      reference(value.project, "gitpm/project@2", document);
      if (!statuses.has(String(value.status))) add({ severity: "error", code: "CONFIG_REFERENCE", path: document.path, message: `Unknown status ${String(value.status)}` });
      if (!issueTypes.has(String(value.type))) add({ severity: "error", code: "CONFIG_REFERENCE", path: document.path, message: `Unknown type ${String(value.type)}` });
      for (const assignee of values(value.assignees)) reference(assignee, "gitpm/person@1", document);
      if (typeof value.parent === "string") {
        const parent = reference(value.parent, "gitpm/task@2", document);
        if (parent && parent.value.project !== value.project) {
          add({ severity: "error", code: "REF_CROSS_PROJECT", path: document.path, message: `${value.parent} belongs to another project` });
        } else if (parent && (typeof parent.value.milestone === "string" ? parent.value.milestone : undefined) !== (typeof value.milestone === "string" ? value.milestone : undefined)) {
          add({ severity: "error", code: "TASK_PARENT_MILESTONE_MISMATCH", path: document.path, message: `${value.id} and parent ${value.parent} must belong to the same milestone` });
        }
      }
      if (typeof value.milestone === "string") {
        const target = reference(value.milestone, "gitpm/milestone@2", document);
        if (target && target.value.project !== value.project) add({ severity: "error", code: "REF_CROSS_PROJECT", path: document.path, message: `${value.milestone} belongs to another project` });
      }
      validateScheduleWindows(document, typeof value.project === "string" ? projectEnabledTracks.get(value.project) : undefined);
      for (const [trackSlug, window] of Object.entries((value.schedules as Record<string, Record<string, unknown>> | undefined) ?? {})) {
        for (const dependency of values(window?.depends_on)) {
          const target = reference(dependency, "gitpm/task@2", document);
          if (target && target.value.project !== value.project) add({ severity: "error", code: "REF_CROSS_PROJECT", path: document.path, message: `${dependency} belongs to another project` });
          void trackSlug;
        }
      }
    } else if (value.schema === "gitpm/saved-view@1") {
      reference(value.project, "gitpm/project@2", document);
      const filters = value.filters as Record<string, unknown>;
      for (const assignee of values(filters.assignees)) reference(assignee, "gitpm/person@1", document);
      for (const milestone of values(filters.milestones)) {
        const target = reference(milestone, "gitpm/milestone@2", document);
        if (target && target.value.project !== value.project) add({ severity: "error", code: "REF_CROSS_PROJECT", path: document.path, message: `${milestone} belongs to another project` });
      }
      for (const status of values(filters.statuses)) if (!statuses.has(status)) add({ severity: "error", code: "CONFIG_REFERENCE", path: document.path, message: `Unknown status ${status}` });
      for (const issueType of values(filters.types)) if (!issueTypes.has(issueType)) add({ severity: "error", code: "CONFIG_REFERENCE", path: document.path, message: `Unknown type ${issueType}` });
    } else if (value.schema === "gitpm/comment@1") {
      reference(value.project, "gitpm/project@2", document);
      const task = reference(value.task, "gitpm/task@2", document);
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
    } else if (value.schema === "gitpm/time-entry@1") {
      reference(value.project, "gitpm/project@2", document);
      const task = reference(value.task, "gitpm/task@2", document);
      if (task && task.value.project !== value.project) add({ severity: "error", code: "REF_CROSS_PROJECT", path: document.path, message: `${String(value.task)} belongs to another project` });
      reference(value.person, "gitpm/person@1", document);
      if (!categories.has(String(value.category))) add({ severity: "error", code: "CONFIG_REFERENCE", path: document.path, field: "category", message: `Unknown work category ${String(value.category)}` });
      if (typeof value.performed_on === "string") {
        try { parseDateOnly(value.performed_on); } catch (error) {
          add({ severity: "error", code: "DATE_INVALID", path: document.path, field: "performed_on", message: error instanceof Error ? error.message : String(error) });
        }
      }
      if (typeof value.voided_at === "string" && typeof value.created_at === "string" && value.voided_at < value.created_at) add({ severity: "error", code: "TIME_ENTRY_TIMESTAMP_ORDER", path: document.path, message: "voided_at must not be before created_at" });
      if (typeof value.replacement === "string") {
        if (value.replacement === value.id) {
          add({ severity: "error", code: "TIME_ENTRY_REPLACEMENT_SELF", path: document.path, field: "replacement", message: "A time entry cannot replace itself" });
        } else {
          const replacement = byId.get(value.replacement);
          if (replacement === undefined || replacement.value.schema !== "gitpm/time-entry@1") {
            add({ severity: "error", code: "TIME_ENTRY_REPLACEMENT_MISSING", path: document.path, field: "replacement", message: `${value.replacement} does not reference a time entry` });
          } else if (replacement.value.task !== value.task || replacement.value.project !== value.project) {
            add({ severity: "error", code: "TIME_ENTRY_REPLACEMENT_TASK_MISMATCH", path: document.path, field: "replacement", message: `${value.replacement} belongs to another task` });
          }
        }
      }
    }
  }

  const tasks = validDocuments.filter((document) => document.value.schema === "gitpm/task@2");
  const availabilityEvents = validDocuments
    .filter((document) => document.value.schema === "gitpm/availability-event@1" && document.value.lifecycle === "active" && document.value.state !== "cancelled")
    .sort((left, right) => left.path.localeCompare(right.path));
  for (let leftIndex = 0; leftIndex < availabilityEvents.length; leftIndex += 1) {
    const left = availabilityEvents[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < availabilityEvents.length; rightIndex += 1) {
      const right = availabilityEvents[rightIndex]!;
      if (left.value.person !== right.value.person) continue;
      if (typeof left.value.start !== "string" || typeof left.value.finish !== "string" || typeof right.value.start !== "string" || typeof right.value.finish !== "string") continue;
      if (left.value.start <= right.value.finish && right.value.start <= left.value.finish) {
        add({ severity: "error", code: "AVAILABILITY_EVENT_OVERLAP", path: right.path, message: `${String(right.value.id)} overlaps ${String(left.value.id)} for ${String(right.value.person)}` });
      }
    }
  }

  for (const task of tasks) {
    const projectId = typeof task.value.project === "string" ? task.value.project : "";
    const planning = projectsById.get(projectId)?.value.planning as Partial<PlanningSettings> | undefined;
    const track = schedulingConfig === undefined ? undefined : resolvePlanning(schedulingConfig, planning).workload_track;
    const window = track === undefined ? undefined : (task.value.schedules as Record<string, Record<string, unknown>> | undefined)?.[track];
    if (window === undefined || typeof window.start !== "string" || typeof window.finish !== "string") continue;
    for (const event of availabilityEvents) {
      if (!values(task.value.assignees).includes(String(event.value.person))) continue;
      if (typeof event.value.start !== "string" || typeof event.value.finish !== "string" || Number(event.value.availability_percent) >= 100) continue;
      if (window.start <= event.value.finish && event.value.start <= window.finish) {
        add({ severity: "warning", code: "TASK_AVAILABILITY_CONFLICT", path: task.path, field: `schedules.${track}`, message: `${String(task.value.id)} intersects availability event ${String(event.value.id)} for ${String(event.value.person)}` });
      }
    }
  }
  detectCycles(tasks, (value) => typeof value.parent === "string" ? [value.parent] : [], "TASK_PARENT_CYCLE", add);
  const dependencyTracks = new Set<string>();
  for (const task of tasks) for (const trackSlug of Object.keys((task.value.schedules as Record<string, Record<string, unknown>> | undefined) ?? {})) dependencyTracks.add(trackSlug);
  for (const track of dependencyTracks) {
    detectCycles(tasks, (value) => values((value.schedules as Record<string, Record<string, unknown>> | undefined)?.[track]?.depends_on), "TASK_DEPENDENCY_CYCLE", add);
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return { valid: errors.length === 0, errors, warnings, documentCount: documents.length };
}

export async function validateDelete(repositoryRoot: string, entityId: string): Promise<readonly ValidationIssue[]> {
  const root = await realpath(repositoryRoot);
  const issues: ValidationIssue[] = [];
  const discovery = await discoverRepositoryFiles(root);
  for (const absolute of discovery.files) {
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
