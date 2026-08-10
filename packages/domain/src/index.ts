import { lstat, mkdir, readFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type { DraftManager, RepositoryMutationMode, RepositoryWorkspace } from "@gitpm/drafts";
import { formatYamlDocument, parseYamlDocument, referenceLabelForDocument, referenceLabelsForDocuments } from "@gitpm/repository-format";
import type { GitPmDocument } from "@gitpm/repository-format";
import { atomicWriteDomainFile, resolveDomainPath } from "@gitpm/security";
import { ENTITY_ID_PREFIX, isEntityId, newUniqueEntityId, type EntityIdPrefix } from "@gitpm/shared";
import { buildTaskHierarchy } from "@gitpm/task-hierarchy";
import { discoverRepositoryFiles, validateDelete, validateRepository } from "@gitpm/validation";
import { ENTITY_TYPE_SCHEMAS } from "@gitpm/contracts";

export * from "./comments.js";
export * from "./time-entries.js";
export { ENTITY_TYPE_SCHEMAS } from "@gitpm/contracts";

const entityTypeSchemas: Readonly<Record<string, string>> = ENTITY_TYPE_SCHEMAS;

export class DomainOperationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainOperationError";
  }
}

export interface EntityResult {
  readonly document: GitPmDocument;
  readonly path: string;
  readonly blob_id: string;
  readonly draft_fingerprint: string;
}

export interface LifecycleTransitionOptions {
  readonly includeTasks?: boolean;
  readonly restoreMilestone?: boolean;
}

export interface EntityCreateBatchResult {
  readonly items: readonly { readonly document: GitPmDocument; readonly path: string; readonly source_index: number }[];
  readonly draft_fingerprint: string;
  readonly dry_run: boolean;
}

export interface ProjectWorkspaceResult {
  readonly project: EntityResult;
  readonly milestones: readonly EntityResult[];
  readonly tasks: readonly EntityResult[];
  readonly draft_fingerprint: string;
}

interface IndexedEntity {
  readonly absolute: string;
  readonly relative: string;
  readonly document: GitPmDocument;
}

interface RepositoryIndex {
  readonly fingerprint: string;
  readonly entities: readonly IndexedEntity[];
  readonly bySchemaAndId: ReadonlyMap<string, IndexedEntity>;
}

export type ConfigurationKind = "statuses" | "issue-types" | "work-categories" | "schedule-tracks";

export interface ConfigurationImpactIssue {
  readonly code: string;
  readonly path: string;
  readonly field?: string;
  readonly message: string;
}

export interface ConfigurationImpact {
  readonly blocking: boolean;
  readonly issues: readonly ConfigurationImpactIssue[];
}

const CONFIGURATION_FILES: Readonly<Record<ConfigurationKind, { readonly path: string; readonly schema: string; readonly list: string }>> = {
  statuses: { path: ".gitpm/statuses.yaml", schema: "gitpm/statuses@2", list: "statuses" },
  "issue-types": { path: ".gitpm/issue-types.yaml", schema: "gitpm/issue-types@1", list: "issue_types" },
  "work-categories": { path: ".gitpm/work-categories.yaml", schema: "gitpm/work-categories@1", list: "categories" },
  "schedule-tracks": { path: ".gitpm/schedule-tracks.yaml", schema: "gitpm/schedule-tracks@1", list: "tracks" },
};

const records = (value: unknown): readonly Record<string, unknown>[] => Array.isArray(value)
  ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object" && !Array.isArray(item))
  : [];
const stringValues = (value: unknown): readonly string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === "string")
  : [];
const objectValue = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

function configurationImpact(
  kind: ConfigurationKind,
  current: GitPmDocument,
  next: GitPmDocument,
  entities: readonly IndexedEntity[],
): ConfigurationImpact {
  const issues: ConfigurationImpactIssue[] = [];
  const issueKeys = new Set<string>();
  const add = (issue: ConfigurationImpactIssue): void => {
    const key = `${issue.code}\n${issue.path}\n${issue.field ?? ""}\n${issue.message}`;
    if (!issueKeys.has(key)) { issueKeys.add(key); issues.push(issue); }
  };
  const metadata = CONFIGURATION_FILES[kind];
  const currentSlugs = new Set(records(current[metadata.list]).flatMap((item) => typeof item.slug === "string" ? [item.slug] : []));
  const nextSlugs = new Set(records(next[metadata.list]).flatMap((item) => typeof item.slug === "string" ? [item.slug] : []));
  const removed = new Set([...currentSlugs].filter((slug) => !nextSlugs.has(slug)));

  if (kind === "statuses" || kind === "issue-types" || kind === "work-categories") {
    for (const entity of entities) {
      const document = entity.document;
      if (kind === "statuses" && (document.schema === "gitpm/project@2" || document.schema === "gitpm/task@2") && typeof document.status === "string" && removed.has(document.status)) {
        add({ code: "CONFIG_REFERENCE", path: entity.relative, field: "status", message: `Status ${document.status} is still in use` });
      }
      if (kind === "issue-types" && document.schema === "gitpm/task@2" && typeof document.type === "string" && removed.has(document.type)) {
        add({ code: "CONFIG_REFERENCE", path: entity.relative, field: "type", message: `Issue type ${document.type} is still in use` });
      }
      if (kind === "work-categories" && document.schema === "gitpm/time-entry@1" && typeof document.category === "string" && removed.has(document.category)) {
        add({ code: "CONFIG_REFERENCE", path: entity.relative, field: "category", message: `Work category ${document.category} is still in use` });
      }
      if (document.schema === "gitpm/saved-view@1") {
        const filters = objectValue(document.filters);
        const field = kind === "statuses" ? "statuses" : kind === "issue-types" ? "types" : undefined;
        if (field !== undefined) for (const slug of stringValues(filters[field])) if (removed.has(slug)) {
          add({ code: "CONFIG_REFERENCE", path: entity.relative, field: `filters.${field}`, message: `${slug} is still used by this saved view` });
        }
      }
    }
  }

  if (kind === "schedule-tracks") {
    const definitions = records(next.tracks);
    const tracks = new Map(definitions.flatMap((track) => typeof track.slug === "string" ? [[track.slug, track] as const] : []));
    const actualTracks = definitions.filter((track) => track.kind === "actual");
    if (actualTracks.length > 1) {
      add({ code: "TRACK_ACTUAL_COUNT", path: metadata.path, field: "tracks", message: `At most one actual track is allowed (found ${actualTracks.length})` });
    }
    const defaults = objectValue(next.defaults);
    const manualSlugs = definitions.filter((track) => track.kind === "manual" && typeof track.slug === "string").map((track) => String(track.slug));
    const resolvePlanning = (planningValue: unknown) => {
      const planning = objectValue(planningValue);
      const enabled = Array.isArray(planning.enabled_tracks) ? stringValues(planning.enabled_tracks)
        : Array.isArray(defaults.enabled_tracks) ? stringValues(defaults.enabled_tracks)
          : manualSlugs;
      return {
        enabled,
        primary: typeof planning.primary_track === "string" ? planning.primary_track : typeof defaults.primary_track === "string" ? defaults.primary_track : enabled[0] ?? "",
        workload: typeof planning.workload_track === "string" ? planning.workload_track : typeof defaults.workload_track === "string" ? defaults.workload_track : (typeof planning.primary_track === "string" ? planning.primary_track : typeof defaults.primary_track === "string" ? defaults.primary_track : enabled[0] ?? ""),
        comparison: typeof planning.comparison_track === "string" ? planning.comparison_track : typeof defaults.comparison_track === "string" ? defaults.comparison_track : undefined,
        dashboard: Array.isArray(planning.dashboard_tracks) ? stringValues(planning.dashboard_tracks) : Array.isArray(defaults.dashboard_tracks) ? stringValues(defaults.dashboard_tracks) : enabled,
      };
    };
    const checkPlanning = (pathValue: string, prefix: string, planningValue: unknown): ReturnType<typeof resolvePlanning> => {
      const resolved = resolvePlanning(planningValue);
      for (const [field, slugs] of [
        ["enabled_tracks", resolved.enabled],
        ["primary_track", [resolved.primary]],
        ["workload_track", [resolved.workload]],
        ["comparison_track", resolved.comparison === undefined ? [] : [resolved.comparison]],
        ["dashboard_tracks", resolved.dashboard],
      ] as const) for (const slug of slugs) if (slug !== "" && !tracks.has(slug)) {
        add({ code: "PLANNING_UNKNOWN_TRACK", path: pathValue, field: `${prefix}.${field}`, message: `Unknown track ${slug}` });
      }
      return resolved;
    };
    checkPlanning(metadata.path, "defaults", defaults);
    const projects = new Map(entities
      .filter((entity) => entity.document.schema === "gitpm/project@2" && typeof entity.document.id === "string")
      .map((entity) => [String(entity.document.id), entity]));
    const projectPlanning = new Map<string, ReturnType<typeof resolvePlanning>>();
    for (const [projectId, project] of projects) projectPlanning.set(projectId, checkPlanning(project.relative, "planning", project.document.planning));
    for (const entity of entities) {
      const schedules = objectValue(entity.document.schedules);
      if (Object.keys(schedules).length === 0) continue;
      const projectId = entity.document.schema === "gitpm/project@2" ? String(entity.document.id) : typeof entity.document.project === "string" ? entity.document.project : undefined;
      const enabled = projectId === undefined ? undefined : new Set(projectPlanning.get(projectId)?.enabled ?? []);
      for (const [slug, rawWindow] of Object.entries(schedules)) {
        const window = objectValue(rawWindow);
        const track = tracks.get(slug);
        const field = `schedules.${slug}`;
        if (track === undefined) {
          add({ code: "SCHEDULE_TRACK_UNKNOWN", path: entity.relative, field, message: `Schedule track ${slug} is still in use` });
          continue;
        }
        if (track.kind === "actual") add({ code: "SCHEDULE_ACTUAL_NOT_EDITABLE", path: entity.relative, field, message: `Track ${slug} has stored schedule data and cannot become actual` });
        if (enabled !== undefined && !enabled.has(slug)) add({ code: "SCHEDULE_TRACK_NOT_ENABLED", path: entity.relative, field, message: `Track ${slug} has stored schedule data but would not be enabled` });
        const capabilities = new Set(stringValues(track.capabilities));
        if ((window.start !== undefined || window.finish !== undefined) && !capabilities.has("dates")) add({ code: "CAPABILITY_DATES_NOT_ALLOWED", path: entity.relative, field, message: `Track ${slug} has stored dates` });
        if (window.effort_hours !== undefined && !capabilities.has("effort")) add({ code: "CAPABILITY_EFFORT_NOT_ALLOWED", path: entity.relative, field: `${field}.effort_hours`, message: `Track ${slug} has stored effort` });
        if (stringValues(window.depends_on).length > 0 && !capabilities.has("dependencies")) add({ code: "CAPABILITY_DEPENDENCIES_NOT_ALLOWED", path: entity.relative, field: `${field}.depends_on`, message: `Track ${slug} has stored dependencies` });
      }
    }
  }

  issues.sort((left, right) => left.path.localeCompare(right.path) || (left.field ?? "").localeCompare(right.field ?? "") || left.code.localeCompare(right.code));
  return { blocking: issues.length > 0, issues };
}

const entityTypeAliases: Readonly<Record<string, string>> = {
  project: "projects",
  task: "tasks",
  milestone: "milestones",
  person: "people",
  team: "teams",
  calendar: "calendars",
  view: "views",
  "saved-view": "views",
};

const schemaIdPrefixes = {
  "gitpm/project@2": ENTITY_ID_PREFIX.project,
  "gitpm/task@2": ENTITY_ID_PREFIX.task,
  "gitpm/milestone@2": ENTITY_ID_PREFIX.milestone,
  "gitpm/person@1": ENTITY_ID_PREFIX.person,
  "gitpm/team@1": ENTITY_ID_PREFIX.team,
  "gitpm/calendar@1": ENTITY_ID_PREFIX.calendar,
  "gitpm/saved-view@1": ENTITY_ID_PREFIX.view,
  "gitpm/comment@1": ENTITY_ID_PREFIX.comment,
  "gitpm/time-entry@1": ENTITY_ID_PREFIX.entry,
} as const;

export interface EntityCreatePlanItem {
  readonly document: GitPmDocument;
  readonly path: string;
  readonly source_index: number;
}

export interface EntityUpdatePlan {
  readonly entityType: string;
  readonly id: string;
  readonly before: GitPmDocument;
  readonly document: GitPmDocument;
  readonly path: string;
}

export interface DeleteRestriction {
  readonly path: string;
  readonly entity_id?: string;
  readonly schema?: string;
  readonly label?: string;
}

export interface DeletePlan {
  readonly entityType: string;
  readonly id: string;
  readonly schema: string;
  readonly path: string;
  readonly supports_unlink: boolean;
  readonly supports_cascade: boolean;
  readonly cascaded_comments: readonly { readonly path: string; readonly id: string }[];
  readonly cascaded_entities: readonly DeleteRestriction[];
  readonly restrictions: readonly DeleteRestriction[];
  readonly would_unlink: readonly DeleteRestriction[];
}

export function canonicalEntityType(value: string): string {
  const normalized = entityTypeAliases[value] ?? value;
  if (entityTypeSchemas[normalized] === undefined) {
    throw new DomainOperationError("ENTITY_TYPE_INVALID", `Unknown entity type ${value}`);
  }
  return normalized;
}

function entityTypeForInputs(inputs: readonly Readonly<Record<string, unknown>>[], requestedType?: string): string {
  if (requestedType !== undefined) return canonicalEntityType(requestedType);
  const schemas = new Set(inputs.map((input) => input.schema).filter((schema): schema is string => typeof schema === "string"));
  if (schemas.size !== 1) {
    throw new DomainOperationError("ENTITY_TYPE_REQUIRED", "--type is required when input schema is absent or mixed");
  }
  const schema = [...schemas][0]!;
  const found = Object.entries(entityTypeSchemas).find(([, candidate]) => candidate === schema)?.[0];
  if (found === undefined) throw new DomainOperationError("ENTITY_TYPE_INVALID", `Unsupported entity schema ${schema}`);
  return found;
}

export function planEntityCreation(
  inputs: readonly Readonly<Record<string, unknown>>[],
  existingDocuments: readonly GitPmDocument[],
  requestedType?: string,
): readonly EntityCreatePlanItem[] {
  if (inputs.length === 0) throw new DomainOperationError("IMPORT_EMPTY", "Entity input is empty");
  const entityType = entityTypeForInputs(inputs, requestedType);
  const schema = entityTypeSchemas[entityType]!;
  const prefix = schemaIdPrefixes[schema as keyof typeof schemaIdPrefixes] as EntityIdPrefix | undefined;
  if (prefix === undefined) throw new DomainOperationError("ENTITY_TYPE_INVALID", `Unsupported entity schema ${schema}`);
  const reservedIds = new Set(existingDocuments.flatMap((document) => typeof document.id === "string" ? [document.id] : []));
  const repository = existingDocuments.find((document) => document.schema === "gitpm/repository@1");
  const defaultCalendar = typeof repository?.default_calendar === "string" ? repository.default_calendar : undefined;
  const calendars = new Map(existingDocuments
    .filter((document) => document.schema === "gitpm/calendar@1" && typeof document.id === "string")
    .map((document) => [String(document.id), document]));

  return inputs.map((input, sourceIndex) => {
    if (input.schema !== undefined && input.schema !== schema) {
      throw new DomainOperationError("ENTITY_TYPE_INVALID", `Input ${sourceIndex + 1} schema ${String(input.schema)} does not match ${schema}`, { source_index: sourceIndex });
    }
    let id: string;
    if (input.id === undefined) {
      id = newUniqueEntityId(prefix, reservedIds);
    } else if (typeof input.id !== "string" || !isEntityId(input.id, prefix)) {
      throw new DomainOperationError("ENTITY_ID_INVALID", `Input ${sourceIndex + 1} entity ID is invalid`, { source_index: sourceIndex, expected_prefix: prefix });
    } else {
      id = input.id;
    }
    if (reservedIds.has(id)) {
      throw new DomainOperationError("ENTITY_EXISTS", `Input ${sourceIndex + 1} entity ID ${id} already exists`, { source_index: sourceIndex, id });
    }
    reservedIds.add(id);

    const lifecycle = input.lifecycle ?? "active";
    let calendar = input.calendar;
    if (schema === "gitpm/person@1" && calendar === undefined) {
      if (defaultCalendar === undefined) {
        throw new DomainOperationError("DEFAULT_CALENDAR_UNAVAILABLE", "Person input omits calendar but repository default_calendar is unavailable", { source_index: sourceIndex });
      }
      calendar = defaultCalendar;
    }
    if (schema === "gitpm/person@1" && lifecycle === "active" && typeof calendar === "string" && calendars.get(calendar)?.lifecycle !== "active") {
      throw new DomainOperationError("ENTITY_CALENDAR_INACTIVE", `Person input ${sourceIndex + 1} requires an active Calendar`, { source_index: sourceIndex, calendar });
    }
    const email = typeof input.email === "string" ? input.email.trim() : input.email;
    const document = {
      ...input,
      schema,
      id,
      lifecycle,
      ...(calendar === undefined ? {} : { calendar }),
      ...(email === undefined ? {} : { email }),
    } as GitPmDocument;
    return { document, path: entityPathForDocument(document), source_index: sourceIndex };
  });
}

export function planEntityUpdate(
  patch: Readonly<Record<string, unknown>>,
  existingDocuments: readonly GitPmDocument[],
  requestedType: string,
  requestedId: string,
): EntityUpdatePlan {
  const entityType = canonicalEntityType(requestedType);
  const schema = entityTypeSchemas[entityType]!;
  const prefix = schemaIdPrefixes[schema as keyof typeof schemaIdPrefixes];
  if (prefix === undefined || !isEntityId(requestedId, prefix)) {
    throw new DomainOperationError("ENTITY_ID_INVALID", `Entity ID ${requestedId} is invalid for ${entityType}`);
  }
  const before = existingDocuments.find((document) => document.schema === schema && document.id === requestedId);
  if (before === undefined) throw new DomainOperationError("ENTITY_NOT_FOUND", `${entityType}/${requestedId} not found`);
  if ((patch.schema !== undefined && patch.schema !== schema) || (patch.id !== undefined && patch.id !== requestedId)) {
    throw new DomainOperationError("ENTITY_IDENTITY_IMMUTABLE", "Entity ID and schema are immutable");
  }
  if (typeof before.project === "string" && patch.project !== undefined && patch.project !== before.project) {
    throw new DomainOperationError("ENTITY_IDENTITY_IMMUTABLE", "Entity ID, schema and owning project are immutable");
  }
  const next: Record<string, unknown> = { ...before };
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete next[field];
    else next[field] = value;
  }
  next.schema = schema;
  next.id = requestedId;
  const document = next as GitPmDocument;
  const path = entityPathForDocument(before);
  if (entityPathForDocument(document) !== path) {
    throw new DomainOperationError("ENTITY_IDENTITY_IMMUTABLE", "Entity ID, schema and owning project are immutable");
  }
  return { entityType, id: requestedId, before, document, path };
}

export function assertEntityType(entityType: string, document: GitPmDocument): void {
  const schema = entityTypeSchemas[entityType];
  if (!schema || schema !== document.schema) {
    throw new DomainOperationError("ENTITY_TYPE_INVALID", `Entity type ${entityType} does not match ${document.schema}`);
  }
}

export function entityPathForDocument(document: GitPmDocument): string {
  const id = String(document.id ?? "");
  const project = String(document.project ?? "");
  const expectedPrefix = schemaIdPrefixes[document.schema as keyof typeof schemaIdPrefixes];
  if (expectedPrefix === undefined || !isEntityId(id, expectedPrefix)) {
    throw new DomainOperationError("ENTITY_ID_INVALID", "Entity ID is invalid");
  }
  const projectBound = ["gitpm/task@2", "gitpm/milestone@2", "gitpm/saved-view@1", "gitpm/comment@1", "gitpm/time-entry@1"].includes(document.schema);
  if (projectBound && !isEntityId(project, ENTITY_ID_PREFIX.project)) {
    throw new DomainOperationError("ENTITY_PROJECT_INVALID", "Owning Project ID is invalid");
  }
  switch (document.schema) {
    case "gitpm/project@2": return `projects/${id}/project.yaml`;
    case "gitpm/task@2": return `projects/${project}/tasks/${id}.yaml`;
    case "gitpm/milestone@2": return `projects/${project}/milestones/${id}.yaml`;
    case "gitpm/saved-view@1": return `projects/${project}/views/${id}.yaml`;
    case "gitpm/comment@1": {
      const task = String(document.task ?? "");
      if (!isEntityId(task, ENTITY_ID_PREFIX.task)) throw new DomainOperationError("ENTITY_ID_INVALID", "Comment task ID is invalid");
      return `projects/${project}/comments/${task}/${id}.yaml`;
    }
    case "gitpm/time-entry@1": {
      const task = String(document.task ?? "");
      if (!isEntityId(task, ENTITY_ID_PREFIX.task)) throw new DomainOperationError("ENTITY_ID_INVALID", "Time entry task ID is invalid");
      return `projects/${project}/time-entries/${task}/${id}.yaml`;
    }
    case "gitpm/person@1": return `people/${id}.yaml`;
    case "gitpm/team@1": return `teams/${id}.yaml`;
    case "gitpm/calendar@1": return `calendars/${id}.yaml`;
    default: throw new DomainOperationError("ENTITY_TYPE_INVALID", `Unsupported entity schema ${document.schema}`);
  }
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function containsEntityReference(value: unknown, id: string): boolean {
  if (value === id) return true;
  if (Array.isArray(value)) return value.some((item) => containsEntityReference(item, id));
  if (value !== null && typeof value === "object") return Object.values(value).some((item) => containsEntityReference(item, id));
  return false;
}

interface RestoreReference {
  readonly field: string;
  readonly schema: string;
  readonly id: string;
}

function restoreReferences(document: GitPmDocument): readonly RestoreReference[] {
  const references: RestoreReference[] = [];
  const add = (field: string, schema: string, value: unknown): void => {
    if (typeof value === "string") references.push({ field, schema, id: value });
  };
  const addMany = (field: string, schema: string, value: unknown): void => {
    if (Array.isArray(value)) for (const id of value) add(field, schema, id);
  };
  const schedules = objectValue(document.schedules);
  switch (document.schema) {
    case "gitpm/project@2":
      add("owner", "gitpm/person@1", document.owner);
      break;
    case "gitpm/task@2":
      add("project", "gitpm/project@2", document.project);
      add("parent", "gitpm/task@2", document.parent);
      add("milestone", "gitpm/milestone@2", document.milestone);
      addMany("assignees", "gitpm/person@1", document.assignees);
      for (const [track, rawWindow] of Object.entries(schedules)) {
        addMany(`schedules.${track}.depends_on`, "gitpm/task@2", objectValue(rawWindow).depends_on);
      }
      break;
    case "gitpm/milestone@2":
      add("project", "gitpm/project@2", document.project);
      break;
    case "gitpm/person@1":
      add("calendar", "gitpm/calendar@1", document.calendar);
      break;
    case "gitpm/team@1":
      addMany("members", "gitpm/person@1", document.members);
      break;
    case "gitpm/saved-view@1": {
      add("project", "gitpm/project@2", document.project);
      const filters = objectValue(document.filters);
      addMany("filters.assignees", "gitpm/person@1", filters.assignees);
      addMany("filters.milestones", "gitpm/milestone@2", filters.milestones);
      break;
    }
  }
  return references;
}

function assertRestoreReferencesActive(document: GitPmDocument, repository: RepositoryIndex): void {
  const inactive = restoreReferences(document).flatMap((reference) => {
    const target = repository.bySchemaAndId.get(`${reference.schema}:${reference.id}`);
    return target?.document.lifecycle === "active" ? [] : [{ field: reference.field, id: reference.id, path: target?.relative }];
  });
  if (inactive.length > 0) {
    throw new DomainOperationError(
      "ENTITY_RESTORE_REFERENCES_INACTIVE",
      `Entity ${String(document.id)} cannot be restored while ${inactive.length} referenced entit${inactive.length === 1 ? "y is" : "ies are"} unavailable`,
      inactive,
    );
  }
}

function repositoryWithDocuments(repository: RepositoryIndex, documentsByPath: ReadonlyMap<string, GitPmDocument>): RepositoryIndex {
  const entities = repository.entities.map((entity) => {
    const document = documentsByPath.get(entity.relative);
    return document === undefined ? entity : { ...entity, document };
  });
  return {
    fingerprint: repository.fingerprint,
    entities,
    bySchemaAndId: new Map(entities
      .filter((entity) => typeof entity.document.id === "string")
      .map((entity) => [`${entity.document.schema}:${String(entity.document.id)}`, entity])),
  };
}

export function entityDisplayLabel(document: GitPmDocument): string | undefined {
  if (typeof document.name === "string" && document.name.trim() !== "") return document.name;
  if (typeof document.title === "string" && document.title.trim() !== "") return document.title;
  if (typeof document.id === "string") return document.id;
  return undefined;
}

export function unlinkPersonReference(document: GitPmDocument, personId: string): GitPmDocument | undefined {
  if (document.schema === "gitpm/project@2" && document.owner === personId) {
    const project: Record<string, unknown> = { ...document };
    delete project.owner;
    return project as GitPmDocument;
  }
  if (document.schema === "gitpm/team@1" && Array.isArray(document.members) && document.members.includes(personId)) {
    return { ...document, members: document.members.filter((member) => member !== personId) };
  }
  if (document.schema === "gitpm/task@2" && Array.isArray(document.assignees) && document.assignees.includes(personId)) {
    return { ...document, assignees: document.assignees.filter((assignee) => assignee !== personId) };
  }
  if (document.schema === "gitpm/saved-view@1" && document.filters !== null && typeof document.filters === "object") {
    const filters = document.filters as Record<string, unknown>;
    if (Array.isArray(filters.assignees) && filters.assignees.includes(personId)) {
      return { ...document, filters: { ...filters, assignees: filters.assignees.filter((assignee) => assignee !== personId) } };
    }
  }
  if (document.schema === "gitpm/comment@1" && Array.isArray(document.mentions)) {
    const mentions = document.mentions as Array<Record<string, unknown>>;
    if (mentions.some((mention) => mention.person === personId)) {
      const mentionPattern = new RegExp(`@\\[([^\\]\\r\\n]{1,200})\\]\\(person:${personId}\\)`, "gu");
      return {
        ...document,
        ...(typeof document.body_markdown === "string" ? { body_markdown: document.body_markdown.replace(mentionPattern, "@$1") } : {}),
        mentions: mentions.filter((mention) => mention.person !== personId),
      };
    }
  }
  return undefined;
}

export class EntityStore {
  private readonly indexes = new Map<string, RepositoryIndex>();
  private readonly pendingIndexes = new Map<string, { readonly fingerprint: string; readonly promise: Promise<RepositoryIndex> }>();
  private readonly pendingFingerprints = new Map<string, { readonly baseline: string; readonly promise: Promise<string> }>();

  constructor(
    private readonly drafts: DraftManager,
    private readonly mutationMode: RepositoryMutationMode = "ui",
  ) {}

  private async contentFingerprint(draftId: string, metadata: RepositoryWorkspace): Promise<string> {
    const pending = this.pendingFingerprints.get(draftId);
    if (pending?.baseline === metadata.fingerprint) return await pending.promise;
    const promise = this.drafts.poll(draftId).then((result) => result.currentFingerprint);
    this.pendingFingerprints.set(draftId, { baseline: metadata.fingerprint, promise });
    try { return await promise; }
    finally {
      if (this.pendingFingerprints.get(draftId)?.promise === promise) this.pendingFingerprints.delete(draftId);
    }
  }

  private async index(draftId: string, metadata: RepositoryWorkspace): Promise<RepositoryIndex> {
    const fingerprint = await this.contentFingerprint(draftId, metadata);
    const cached = this.indexes.get(draftId);
    if (cached?.fingerprint === fingerprint) return cached;
    const pending = this.pendingIndexes.get(draftId);
    if (pending?.fingerprint === fingerprint) return await pending.promise;
    const promise = (async () => {
      const discovery = await discoverRepositoryFiles(metadata.worktree_path);
      if (discovery.issues.length > 0) {
        const issue = discovery.issues[0]!;
        throw new DomainOperationError(issue.code, issue.message, discovery.issues);
      }
      const entities = await Promise.all(discovery.files.map(async (absolute): Promise<IndexedEntity> => {
        const relative = path.relative(metadata.worktree_path, absolute).split(path.sep).join("/");
        return { absolute, relative, document: parseYamlDocument(await readFile(absolute, "utf8"), relative) };
      }));
      const next: RepositoryIndex = {
        fingerprint,
        entities,
        bySchemaAndId: new Map(entities
          .filter((entity) => typeof entity.document.id === "string")
          .map((entity) => [`${entity.document.schema}:${String(entity.document.id)}`, entity])),
      };
      this.indexes.set(draftId, next);
      return next;
    })();
    this.pendingIndexes.set(draftId, { fingerprint, promise });
    try { return await promise; }
    finally {
      if (this.pendingIndexes.get(draftId)?.promise === promise) this.pendingIndexes.delete(draftId);
    }
  }

  private async result(draftId: string, metadata: RepositoryWorkspace, entity: IndexedEntity): Promise<EntityResult> {
    return (await this.results(draftId, metadata, [entity]))[0]!;
  }

  private async results(draftId: string, metadata: RepositoryWorkspace, entities: readonly IndexedEntity[]): Promise<readonly EntityResult[]> {
    const blobIds = await this.drafts.fileBlobIds(draftId, entities.map((entity) => entity.relative));
    return entities.map((entity) => ({
      document: entity.document,
      path: entity.relative,
      blob_id: blobIds.get(entity.relative)!,
      draft_fingerprint: metadata.fingerprint,
    }));
  }

  private labels(repository: RepositoryIndex, replacement?: GitPmDocument) {
    return referenceLabelsForDocuments([
      ...repository.entities
        .filter((entity) => replacement === undefined || entity.document.id !== replacement.id)
        .map((entity) => entity.document),
      ...(replacement === undefined ? [] : [replacement]),
    ]);
  }

  async planCreate(
    draftId: string,
    inputs: readonly Readonly<Record<string, unknown>>[],
    requestedType?: string,
  ): Promise<readonly EntityCreatePlanItem[]> {
    const metadata = await this.drafts.getWorkspace(draftId);
    const repository = await this.index(draftId, metadata);
    return planEntityCreation(inputs, repository.entities.map((entity) => entity.document), requestedType);
  }

  async planUpdate(
    draftId: string,
    patch: Readonly<Record<string, unknown>>,
    requestedType: string,
    requestedId: string,
  ): Promise<EntityUpdatePlan> {
    const metadata = await this.drafts.getWorkspace(draftId);
    const repository = await this.index(draftId, metadata);
    return planEntityUpdate(patch, repository.entities.map((entity) => entity.document), requestedType, requestedId);
  }

  async list(draftId: string, entityType: string, project?: string): Promise<readonly EntityResult[]> {
    const metadata = await this.drafts.getWorkspace(draftId);
    const schema = entityTypeSchemas[canonicalEntityType(entityType)];
    if (!schema) throw new DomainOperationError("ENTITY_TYPE_INVALID", `Unknown entity type ${entityType}`);
    const matching = (await this.index(draftId, metadata)).entities
      .filter((entity) => entity.document.schema === schema && (project === undefined || entity.document.project === project));
    const result = await this.results(draftId, metadata, matching);
    return [...result].sort((left, right) => String(left.document.id).localeCompare(String(right.document.id)));
  }

  private async find(draftId: string, metadata: RepositoryWorkspace, entityType: string, id: string): Promise<IndexedEntity> {
    const schema = entityTypeSchemas[canonicalEntityType(entityType)];
    if (!schema) throw new DomainOperationError("ENTITY_TYPE_INVALID", `Unknown entity type ${entityType}`);
    const found = (await this.index(draftId, metadata)).bySchemaAndId.get(`${schema}:${id}`);
    if (found !== undefined) return found;
    throw new DomainOperationError("ENTITY_NOT_FOUND", `${entityType}/${id} not found`);
  }

  async get(draftId: string, entityType: string, id: string): Promise<EntityResult> {
    const metadata = await this.drafts.getWorkspace(draftId);
    const found = await this.find(draftId, metadata, entityType, id);
    return await this.result(draftId, metadata, found);
  }

  async projectWorkspace(draftId: string, projectId: string): Promise<ProjectWorkspaceResult> {
    const metadata = await this.drafts.getWorkspace(draftId);
    const repository = await this.index(draftId, metadata);
    const indexedProject = repository.bySchemaAndId.get(`gitpm/project@2:${projectId}`);
    if (indexedProject === undefined) throw new DomainOperationError("ENTITY_NOT_FOUND", `projects/${projectId} not found`);
    const indexedMilestones = repository.entities.filter((entity) => entity.document.schema === "gitpm/milestone@2" && entity.document.project === projectId);
    const indexedTasks = repository.entities.filter((entity) => entity.document.schema === "gitpm/task@2" && entity.document.project === projectId);
    const results = await this.results(draftId, metadata, [indexedProject, ...indexedMilestones, ...indexedTasks]);
    const project = results[0]!;
    const milestones = results.slice(1, 1 + indexedMilestones.length);
    const tasks = results.slice(1 + indexedMilestones.length);
    return { project, milestones, tasks, draft_fingerprint: project.draft_fingerprint };
  }

  async getConfiguration(draftId: string, kind: ConfigurationKind): Promise<EntityResult> {
    const metadata = await this.drafts.getWorkspace(draftId);
    const relative = CONFIGURATION_FILES[kind].path;
    const absolute = await resolveDomainPath(metadata.worktree_path, relative);
    const document = parseYamlDocument(await readFile(absolute, "utf8"), relative);
    return {
      document,
      path: relative,
      blob_id: await this.drafts.fileBlobId(draftId, relative),
      draft_fingerprint: metadata.fingerprint,
    };
  }

  async getRepositoryConfiguration(draftId: string): Promise<EntityResult> {
    const metadata = await this.drafts.getWorkspace(draftId);
    const relative = ".gitpm/repository.yaml";
    const absolute = await resolveDomainPath(metadata.worktree_path, relative);
    const document = parseYamlDocument(await readFile(absolute, "utf8"), relative);
    if (document.schema !== "gitpm/repository@1") {
      throw new DomainOperationError("SCHEMA_CONST", `${relative} must contain gitpm/repository@1`);
    }
    return {
      document,
      path: relative,
      blob_id: await this.drafts.fileBlobId(draftId, relative),
      draft_fingerprint: metadata.fingerprint,
    };
  }

  async getConfigurationImpact(draftId: string, kind: ConfigurationKind, document: GitPmDocument): Promise<ConfigurationImpact> {
    const metadata = await this.drafts.getWorkspace(draftId);
    const config = CONFIGURATION_FILES[kind];
    if (document.schema !== config.schema) throw new DomainOperationError("ENTITY_IDENTITY_IMMUTABLE", "Configuration schema is immutable");
    const repository = await this.index(draftId, metadata);
    const current = repository.entities.find((entity) => entity.relative === config.path);
    if (current === undefined) throw new DomainOperationError("ENTITY_NOT_FOUND", `${config.path} not found`);
    return configurationImpact(kind, current.document, document, repository.entities);
  }

  async updateConfiguration(
    draftId: string,
    owner: string,
    kind: ConfigurationKind,
    expectedFingerprint: string,
    expectedBlobId: string,
    document: GitPmDocument,
  ): Promise<EntityResult> {
    const config = CONFIGURATION_FILES[kind];
    const relative = config.path;
    if (document.schema !== config.schema) throw new DomainOperationError("ENTITY_IDENTITY_IMMUTABLE", "Configuration schema is immutable");
    const mutation = await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, this.mutationMode, async (metadata) => {
      const repository = await this.index(draftId, metadata);
      const current = repository.entities.find((entity) => entity.relative === relative);
      if (current === undefined) throw new DomainOperationError("ENTITY_NOT_FOUND", `${relative} not found`);
      const impact = configurationImpact(kind, current.document, document, repository.entities);
      if (impact.blocking) {
        throw new DomainOperationError("CONFIGURATION_UPDATE_BLOCKED", `Configuration update is blocked by ${impact.issues.length} repository reference${impact.issues.length === 1 ? "" : "s"}`, impact.issues);
      }
      const referenceLabels = this.labels(repository);
      await this.drafts.assertFileBlobId(draftId, relative, expectedBlobId);
      const absolute = await resolveDomainPath(metadata.worktree_path, relative);
      const original = await readFile(absolute, "utf8");
      await atomicWriteDomainFile(metadata.worktree_path, relative, formatYamlDocument(document, referenceLabels));
      try {
        await this.assertRepositoryValid(metadata.worktree_path);
      } catch (error) {
        await atomicWriteDomainFile(metadata.worktree_path, relative, original);
        throw error;
      }
      return relative;
    });
    return await this.getWithFingerprint(draftId, document, relative, mutation.metadata.fingerprint);
  }

  async updateRepositoryConfiguration(
    draftId: string,
    owner: string,
    expectedFingerprint: string,
    expectedBlobId: string,
    document: GitPmDocument,
  ): Promise<EntityResult> {
    const relative = ".gitpm/repository.yaml";
    if (document.schema !== "gitpm/repository@1") throw new DomainOperationError("ENTITY_IDENTITY_IMMUTABLE", "Repository configuration schema is immutable");
    const mutation = await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, this.mutationMode, async (metadata) => {
      const repository = await this.index(draftId, metadata);
      const defaultCalendar = typeof document.default_calendar === "string"
        ? repository.bySchemaAndId.get(`gitpm/calendar@1:${document.default_calendar}`)
        : undefined;
      if (defaultCalendar?.document.lifecycle !== "active") {
        throw new DomainOperationError("DEFAULT_CALENDAR_UNAVAILABLE", "Repository default_calendar must reference an active Calendar", { default_calendar: document.default_calendar });
      }
      await this.drafts.assertFileBlobId(draftId, relative, expectedBlobId);
      const absolute = await resolveDomainPath(metadata.worktree_path, relative);
      const original = await readFile(absolute, "utf8");
      await atomicWriteDomainFile(metadata.worktree_path, relative, formatYamlDocument(document, this.labels(repository)));
      try {
        await this.assertRepositoryValid(metadata.worktree_path);
      } catch (error) {
        await atomicWriteDomainFile(metadata.worktree_path, relative, original);
        throw error;
      }
      return relative;
    });
    return await this.getWithFingerprint(draftId, document, relative, mutation.metadata.fingerprint);
  }

  async create(
    draftId: string,
    owner: string,
    expectedFingerprint: string,
    input: Readonly<Record<string, unknown>>,
    requestedType?: string,
  ): Promise<EntityResult> {
    const document = requestedType === undefined && typeof input.schema === "string" && typeof input.id === "string"
      ? input as GitPmDocument
      : (await this.planCreate(draftId, [input], requestedType))[0]!.document;
    const relative = entityPathForDocument(document);
    const mutation = await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, this.mutationMode, async (metadata) => {
      const referenceLabels = this.labels(await this.index(draftId, metadata), document);
      const absolute = path.join(metadata.worktree_path, ...relative.split("/"));
      if (await exists(absolute)) throw new DomainOperationError("ENTITY_EXISTS", `${relative} already exists`);
      await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
      await resolveDomainPath(metadata.worktree_path, relative);
      await atomicWriteDomainFile(metadata.worktree_path, relative, formatYamlDocument(document, referenceLabels));
      try {
        await this.assertRepositoryValid(metadata.worktree_path);
      } catch (error) {
        await rm(absolute, { force: true });
        throw error;
      }
      return relative;
    });
    return await this.getWithFingerprint(draftId, document, relative, mutation.metadata.fingerprint);
  }

  async createMany(
    draftId: string,
    owner: string,
    expectedFingerprint: string,
    plan: readonly EntityCreatePlanItem[],
    dryRun = false,
  ): Promise<EntityCreateBatchResult> {
    if (plan.length === 0) throw new DomainOperationError("IMPORT_EMPTY", "Entity input is empty");
    const paths = new Set<string>();
    for (const item of plan) {
      const expected = entityPathForDocument(item.document);
      if (expected !== item.path) throw new DomainOperationError("PATH_ENTITY_FILENAME", `Expected ${expected}`);
      if (paths.has(item.path)) throw new DomainOperationError("ENTITY_EXISTS", `Duplicate batch path ${item.path}`);
      paths.add(item.path);
    }
    const mutation = await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, this.mutationMode, async (metadata) => {
      const repository = await this.index(draftId, metadata);
      const referenceLabels = referenceLabelsForDocuments([
        ...repository.entities.map((entity) => entity.document),
        ...plan.map((item) => item.document),
      ]);
      const written: string[] = [];
      const createdParents = new Set<string>();
      const cleanup = async (): Promise<void> => {
        for (const relative of written.reverse()) await rm(path.join(metadata.worktree_path, ...relative.split("/")), { force: true });
        for (const relative of [...createdParents].sort((left, right) => right.length - left.length)) {
          try { await rmdir(path.join(metadata.worktree_path, ...relative.split("/"))); }
          catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        }
      };
      try {
        for (const item of plan) {
          const absolute = path.join(metadata.worktree_path, ...item.path.split("/"));
          if (await exists(absolute)) throw new DomainOperationError("ENTITY_EXISTS", `${item.path} already exists`);
          let parent = path.posix.dirname(item.path);
          while (parent !== "." && !(await exists(path.join(metadata.worktree_path, ...parent.split("/"))))) {
            createdParents.add(parent);
            parent = path.posix.dirname(parent);
          }
          await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
          await resolveDomainPath(metadata.worktree_path, item.path);
          await atomicWriteDomainFile(metadata.worktree_path, item.path, formatYamlDocument(item.document, referenceLabels));
          written.push(item.path);
        }
        await this.assertRepositoryValid(metadata.worktree_path);
        if (dryRun) await cleanup();
      } catch (error) {
        await cleanup();
        if (error instanceof DomainOperationError && error.code === "VALIDATION_FAILED" && Array.isArray(error.details)) {
          const sources = new Map(plan.map((item) => [item.path, item.source_index]));
          throw new DomainOperationError(error.code, error.message, error.details.map((issue) => {
            if (issue === null || typeof issue !== "object" || !("path" in issue) || typeof issue.path !== "string") return issue;
            const sourceIndex = sources.get(issue.path);
            return sourceIndex === undefined ? issue : { ...issue, source_index: sourceIndex };
          }));
        }
        throw error;
      }
      return undefined;
    });
    return {
      items: plan.map((item) => ({ document: item.document, path: item.path, source_index: item.source_index })),
      draft_fingerprint: mutation.metadata.fingerprint,
      dry_run: dryRun,
    };
  }

  async update(
    draftId: string,
    owner: string,
    entityType: string,
    id: string,
    expectedFingerprint: string,
    expectedBlobId: string,
    document: GitPmDocument,
    assertChangedPaths?: (paths: readonly string[]) => void,
    lifecycleOperation?: "archive" | "restore",
  ): Promise<EntityResult> {
    const mutation = await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, this.mutationMode, async (metadata) => {
      const found = await this.find(draftId, metadata, entityType, id);
      if (document.id !== id || document.schema !== found.document.schema || entityPathForDocument(document) !== found.relative) {
        throw new DomainOperationError("ENTITY_IDENTITY_IMMUTABLE", "Entity ID, schema and owning project are immutable");
      }
      const lifecycleChanged = found.document.lifecycle !== document.lifecycle;
      if (lifecycleChanged && lifecycleOperation === undefined) {
        throw new DomainOperationError("ENTITY_LIFECYCLE_OPERATION_REQUIRED", "Use the dedicated archive or restore operation to change lifecycle");
      }
      if (lifecycleOperation === "archive" && document.lifecycle !== "archived") {
        throw new DomainOperationError("ENTITY_LIFECYCLE_OPERATION_REQUIRED", "Archive must set lifecycle to archived");
      }
      if (lifecycleOperation === "restore" && document.lifecycle !== "active") {
        throw new DomainOperationError("ENTITY_LIFECYCLE_OPERATION_REQUIRED", "Restore must set lifecycle to active");
      }
      await this.drafts.assertFileBlobId(draftId, found.relative, expectedBlobId);
      const repository = await this.index(draftId, metadata);
      if (lifecycleOperation === "restore") assertRestoreReferencesActive(document, repository);
      if (found.document.schema === "gitpm/calendar@1" && document.lifecycle === "archived") {
        const repositoryConfiguration = repository.entities.find((entity) => entity.document.schema === "gitpm/repository@1")?.document;
        if (repositoryConfiguration?.default_calendar === id) {
          throw new DomainOperationError(
            "DEFAULT_CALENDAR_ARCHIVE_RESTRICTED",
            `Calendar ${id} is the repository default; choose another default_calendar before archiving it`,
            { calendar: id, repository_path: ".gitpm/repository.yaml" },
          );
        }
      }
      const referenceLabels = this.labels(repository, document);
      const originals = new Map<string, string>();
      try {
        const original = await readFile(found.absolute, "utf8");
        originals.set(found.relative, original);
        await atomicWriteDomainFile(metadata.worktree_path, found.relative, formatYamlDocument(document, referenceLabels));
        if (referenceLabelForDocument(found.document) !== referenceLabelForDocument(document)) {
          for (const entity of repository.entities) {
            if (entity.relative === found.relative || !containsEntityReference(entity.document, id)) continue;
            const relatedOriginal = await readFile(entity.absolute, "utf8");
            const relatedFormatted = formatYamlDocument(entity.document, referenceLabels);
            if (relatedFormatted === relatedOriginal) continue;
            originals.set(entity.relative, relatedOriginal);
            await atomicWriteDomainFile(metadata.worktree_path, entity.relative, relatedFormatted);
          }
        }
        assertChangedPaths?.([...originals.keys()]);
        await this.assertRepositoryValid(metadata.worktree_path);
      } catch (error) {
        for (const [relative, original] of originals) await atomicWriteDomainFile(metadata.worktree_path, relative, original);
        throw error;
      }
      return found.relative;
    });
    return await this.getWithFingerprint(draftId, document, mutation.result, mutation.metadata.fingerprint);
  }

  async archive(
    draftId: string,
    owner: string,
    entityType: string,
    id: string,
    expectedFingerprint: string,
    expectedBlobId: string,
    options: LifecycleTransitionOptions = {},
  ): Promise<EntityResult> {
    if (options.restoreMilestone === true) {
      throw new DomainOperationError("ENTITY_LIFECYCLE_OPTION_UNSUPPORTED", "restoreMilestone is available only when restoring a Task");
    }
    if (options.includeTasks === true) {
      return await this.transitionLifecycleGroup(draftId, owner, entityType, id, expectedFingerprint, expectedBlobId, "archived", options);
    }
    const current = await this.get(draftId, entityType, id);
    return await this.update(draftId, owner, entityType, id, expectedFingerprint, expectedBlobId, {
      ...current.document,
      lifecycle: "archived",
    }, undefined, "archive");
  }

  async restore(
    draftId: string,
    owner: string,
    entityType: string,
    id: string,
    expectedFingerprint: string,
    expectedBlobId: string,
    options: LifecycleTransitionOptions = {},
  ): Promise<EntityResult> {
    const current = await this.get(draftId, entityType, id);
    if (current.document.lifecycle !== "archived") {
      throw new DomainOperationError("ENTITY_NOT_ARCHIVED", `Entity ${id} is not archived`);
    }
    if (options.includeTasks === true || options.restoreMilestone === true) {
      return await this.transitionLifecycleGroup(draftId, owner, entityType, id, expectedFingerprint, expectedBlobId, "active", options);
    }
    return await this.update(draftId, owner, entityType, id, expectedFingerprint, expectedBlobId, {
      ...current.document,
      lifecycle: "active",
    }, undefined, "restore");
  }

  private async transitionLifecycleGroup(
    draftId: string,
    owner: string,
    entityType: string,
    id: string,
    expectedFingerprint: string,
    expectedBlobId: string,
    lifecycle: "active" | "archived",
    options: LifecycleTransitionOptions,
  ): Promise<EntityResult> {
    let primaryDocument: GitPmDocument | undefined;
    const mutation = await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, this.mutationMode, async (metadata) => {
      const found = await this.find(draftId, metadata, entityType, id);
      await this.drafts.assertFileBlobId(draftId, found.relative, expectedBlobId);
      const repository = await this.index(draftId, metadata);
      const documentsByPath = new Map<string, GitPmDocument>();
      const update = (entity: IndexedEntity): void => {
        if (entity.document.lifecycle !== lifecycle) documentsByPath.set(entity.relative, { ...entity.document, lifecycle });
      };

      update(found);
      if (options.includeTasks === true) {
        if (found.document.schema !== "gitpm/milestone@2") {
          throw new DomainOperationError("ENTITY_LIFECYCLE_OPTION_UNSUPPORTED", "includeTasks is supported only for Milestones");
        }
        for (const entity of repository.entities) {
          if (entity.document.schema === "gitpm/task@2" && entity.document.milestone === id) update(entity);
        }
      }
      if (options.restoreMilestone === true) {
        if (lifecycle !== "active" || found.document.schema !== "gitpm/task@2") {
          throw new DomainOperationError("ENTITY_LIFECYCLE_OPTION_UNSUPPORTED", "restoreMilestone is supported only when restoring a Task");
        }
        const milestoneId = typeof found.document.milestone === "string" ? found.document.milestone : "";
        if (milestoneId === "") {
          throw new DomainOperationError("ENTITY_RESTORE_MILESTONE_UNAVAILABLE", `Task ${id} does not reference a Milestone`);
        }
        const milestone = repository.bySchemaAndId.get(`gitpm/milestone@2:${milestoneId}`);
        if (milestone === undefined) throw new DomainOperationError("REF_MISSING", `${milestoneId} does not reference a Milestone`);
        update(milestone);
      }

      primaryDocument = documentsByPath.get(found.relative) ?? found.document;
      const simulated = repositoryWithDocuments(repository, documentsByPath);
      if (lifecycle === "active") {
        for (const document of documentsByPath.values()) assertRestoreReferencesActive(document, simulated);
      }
      const originals = new Map<string, string>();
      try {
        const referenceLabels = this.labels(simulated);
        for (const entity of repository.entities) {
          const document = documentsByPath.get(entity.relative);
          if (document === undefined) continue;
          originals.set(entity.relative, await readFile(entity.absolute, "utf8"));
          await atomicWriteDomainFile(metadata.worktree_path, entity.relative, formatYamlDocument(document, referenceLabels));
        }
        await this.assertRepositoryValid(metadata.worktree_path);
      } catch (error) {
        for (const [relative, original] of originals) await atomicWriteDomainFile(metadata.worktree_path, relative, original);
        throw error;
      }
      return found.relative;
    });
    return await this.getWithFingerprint(draftId, primaryDocument!, mutation.result, mutation.metadata.fingerprint);
  }

  async moveTask(
    draftId: string,
    owner: string,
    id: string,
    expectedFingerprint: string,
    expectedBlobId: string,
    targetProject: string,
    targetMilestone?: string,
    targetParent?: string,
  ): Promise<EntityResult> {
    if (!isEntityId(targetProject, ENTITY_ID_PREFIX.project)) throw new DomainOperationError("ENTITY_PROJECT_INVALID", "Target Project ID is invalid");
    if (targetMilestone !== undefined && !isEntityId(targetMilestone, ENTITY_ID_PREFIX.milestone)) throw new DomainOperationError("ENTITY_ID_INVALID", "Target Milestone ID is invalid");
    if (targetParent !== undefined && !isEntityId(targetParent, ENTITY_ID_PREFIX.task)) throw new DomainOperationError("ENTITY_ID_INVALID", "Target parent Task ID is invalid");
    let movedDocument: GitPmDocument | undefined;
    const mutation = await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, this.mutationMode, async (metadata) => {
      const found = await this.find(draftId, metadata, "tasks", id);
      await this.drafts.assertFileBlobId(draftId, found.relative, expectedBlobId);
      const repository = await this.index(draftId, metadata);
      if (repository.bySchemaAndId.get(`gitpm/project@2:${targetProject}`) === undefined) throw new DomainOperationError("REF_MISSING", `${targetProject} does not reference a Project`);
      const targetMilestoneEntity = targetMilestone === undefined ? undefined : repository.bySchemaAndId.get(`gitpm/milestone@2:${targetMilestone}`);
      if (targetMilestone !== undefined && (targetMilestoneEntity === undefined || targetMilestoneEntity.document.project !== targetProject)) {
        throw new DomainOperationError("REF_CROSS_PROJECT", `${targetMilestone} does not belong to ${targetProject}`);
      }
      const taskEntities = repository.entities.filter((entity) => entity.document.schema === "gitpm/task@2");
      const sourceMilestone = typeof found.document.milestone === "string"
        ? repository.bySchemaAndId.get(`gitpm/milestone@2:${found.document.milestone}`)
        : undefined;
      const sourceOrder = Array.isArray(sourceMilestone?.document.task_order)
        ? sourceMilestone.document.task_order.filter((taskId): taskId is string => typeof taskId === "string")
        : [];
      const hierarchy = buildTaskHierarchy(taskEntities.map((entity) => ({
        id: String(entity.document.id),
        parent: typeof entity.document.parent === "string" ? entity.document.parent : undefined,
        entity,
      })), { order: sourceOrder });
      const root = hierarchy.tasks.get(id);
      if (root === undefined) throw new DomainOperationError("ENTITY_NOT_FOUND", `tasks/${id} not found`);
      const subtree = [root, ...hierarchy.descendantsOf(id)];
      const subtreeIds = new Set(subtree.map((item) => item.id));
      const targetParentEntity = targetParent === undefined ? undefined : repository.bySchemaAndId.get(`gitpm/task@2:${targetParent}`);
      if (targetParent !== undefined && targetParentEntity === undefined) throw new DomainOperationError("REF_MISSING", `${targetParent} does not reference a Task`);
      if (targetParent !== undefined && subtreeIds.has(targetParent)) throw new DomainOperationError("TASK_PARENT_CYCLE", `${targetParent} belongs to the moved subtree`);
      if (targetParentEntity !== undefined && targetParentEntity.document.project !== targetProject) throw new DomainOperationError("REF_CROSS_PROJECT", `${targetParent} does not belong to ${targetProject}`);
      if (targetParentEntity !== undefined && (typeof targetParentEntity.document.milestone === "string" ? targetParentEntity.document.milestone : undefined) !== targetMilestone) {
        throw new DomainOperationError("TASK_PARENT_MILESTONE_MISMATCH", `${targetParent} does not belong to the target milestone`);
      }
      const currentMilestone = typeof found.document.milestone === "string" ? found.document.milestone : undefined;
      const currentParent = typeof found.document.parent === "string" ? found.document.parent : undefined;
      if (found.document.project === targetProject && currentMilestone === targetMilestone && currentParent === targetParent) {
        throw new DomainOperationError("TASK_ALREADY_AT_TARGET", `${id} already has the requested project, milestone and parent`);
      }

      const movedTasks = subtree.map((item) => {
        const document = {
          ...item.entity.document,
          project: targetProject,
          milestone: targetMilestone,
          ...(item.id === id ? { parent: targetParent } : {}),
        } as GitPmDocument;
        if (targetMilestone === undefined) delete (document as Record<string, unknown>).milestone;
        if (item.id === id && targetParent === undefined) delete (document as Record<string, unknown>).parent;
        return { source: item.entity, document };
      });
      movedDocument = movedTasks[0]!.document;
      const comments = repository.entities.filter((entity) => entity.document.schema === "gitpm/comment@1" && typeof entity.document.task === "string" && subtreeIds.has(entity.document.task));
      const movedComments = comments.map((comment) => ({ source: comment, document: { ...comment.document, project: targetProject } as GitPmDocument }));
      const timeEntries = repository.entities.filter((entity) => entity.document.schema === "gitpm/time-entry@1" && typeof entity.document.task === "string" && subtreeIds.has(entity.document.task));
      const movedTimeEntries = timeEntries.map((entry) => ({ source: entry, document: { ...entry.document, project: targetProject } as GitPmDocument }));
      const orderUpdates: Array<{ source: IndexedEntity; document: GitPmDocument }> = [];
      const movedTaskDocuments = new Map(movedTasks.map((item) => [String(item.document.id), item.document]));
      const orderedTaskIds = (projectId: string, milestoneId: string, explicitOrder: string[]): string[] => {
        const tasks = taskEntities
          .map((entity) => movedTaskDocuments.get(String(entity.document.id)) ?? entity.document)
          .filter((document) => document.project === projectId && document.milestone === milestoneId)
          .map((document) => ({
            id: String(document.id),
            parent: typeof document.parent === "string" ? document.parent : undefined,
          }));
        return buildTaskHierarchy(tasks, { order: explicitOrder }).flatten().map((entry) => entry.task.id);
      };
      if (sourceMilestone?.document.id !== targetMilestoneEntity?.document.id) {
        if (sourceMilestone !== undefined) {
          orderUpdates.push({
            source: sourceMilestone,
            document: {
              ...sourceMilestone.document,
              task_order: orderedTaskIds(String(sourceMilestone.document.project), String(sourceMilestone.document.id), sourceOrder),
            } as GitPmDocument,
          });
        }
      }
      if (targetMilestoneEntity !== undefined) {
        const targetOrder = Array.isArray(targetMilestoneEntity.document.task_order)
          ? targetMilestoneEntity.document.task_order.filter((taskId): taskId is string => typeof taskId === "string")
          : [];
        orderUpdates.push({
          source: targetMilestoneEntity,
          document: {
            ...targetMilestoneEntity.document,
            task_order: orderedTaskIds(targetProject, String(targetMilestoneEntity.document.id), targetOrder),
          } as GitPmDocument,
        });
      }
      const targets = [...movedTasks, ...movedComments, ...movedTimeEntries, ...orderUpdates].map((item) => ({
        ...item,
        relative: entityPathForDocument(item.document),
      }));
      const sourceRelatives = new Set(targets.map((target) => target.source.relative));
      for (const target of targets) {
        if (target.relative !== target.source.relative
          && !sourceRelatives.has(target.relative)
          && await exists(path.join(metadata.worktree_path, ...target.relative.split("/")))) {
          throw new DomainOperationError("ENTITY_EXISTS", `${target.relative} already exists`);
        }
      }
      const originals = new Map<string, string>();
      const replacementIds = new Set(targets.map((target) => target.document.id));
      const referenceLabels = referenceLabelsForDocuments([
        ...repository.entities.filter((entity) => !replacementIds.has(entity.document.id)).map((entity) => entity.document),
        ...targets.map((target) => target.document),
      ]);
      try {
        for (const target of targets) {
          if (!originals.has(target.source.relative)) originals.set(target.source.relative, await readFile(target.source.absolute, "utf8"));
          const absolute = path.join(metadata.worktree_path, ...target.relative.split("/"));
          await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
          await resolveDomainPath(metadata.worktree_path, target.relative);
          await atomicWriteDomainFile(metadata.worktree_path, target.relative, formatYamlDocument(target.document, referenceLabels));
        }
        for (const target of targets) if (target.source.relative !== target.relative) await rm(target.source.absolute);
        await this.assertRepositoryValid(metadata.worktree_path);
      } catch (error) {
        for (const relative of new Set(targets.map((target) => target.relative))) await rm(path.join(metadata.worktree_path, ...relative.split("/")), { force: true });
        for (const [sourceRelative, original] of originals) {
          const absolute = path.join(metadata.worktree_path, ...sourceRelative.split("/"));
          await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
          await atomicWriteDomainFile(metadata.worktree_path, sourceRelative, original);
        }
        throw error;
      }
      return entityPathForDocument(movedDocument);
    });
    if (movedDocument === undefined) throw new DomainOperationError("ENTITY_NOT_FOUND", `tasks/${id} not found`);
    return await this.getWithFingerprint(draftId, movedDocument, mutation.result, mutation.metadata.fingerprint);
  }

  async planDelete(draftId: string, entityType: string, id: string): Promise<DeletePlan> {
    const metadata = await this.drafts.getWorkspace(draftId);
    const found = await this.find(draftId, metadata, entityType, id);
    const repository = await this.index(draftId, metadata);
    const cascadedComments = found.document.schema === "gitpm/task@2"
      ? repository.entities.filter((entity) => entity.document.schema === "gitpm/comment@1" && entity.document.task === id)
      : [];
    const commentPaths = new Set(cascadedComments.map((comment) => comment.relative));
    const entitiesByPath = new Map(repository.entities.map((entity) => [entity.relative, entity.document]));
    const restrictions = (await validateDelete(metadata.worktree_path, id))
      .filter((restriction) => !commentPaths.has(restriction.path))
      .map((restriction): DeleteRestriction => {
        const document = entitiesByPath.get(restriction.path);
        return document === undefined ? { path: restriction.path } : {
          path: restriction.path,
          entity_id: typeof document.id === "string" ? document.id : undefined,
          schema: document.schema,
          label: entityDisplayLabel(document),
        };
      });
    const supportsUnlink = found.document.schema === "gitpm/person@1";
    const supportsCascade = found.document.schema === "gitpm/project@2";
    const cascadedEntities: DeleteRestriction[] = supportsCascade
      ? repository.entities.flatMap((entity) => entity.relative === found.relative || entity.document.project !== id ? [] : [{
        path: entity.relative,
        entity_id: typeof entity.document.id === "string" ? entity.document.id : undefined,
        schema: entity.document.schema,
        label: entityDisplayLabel(entity.document),
      }])
      : [];
    const wouldUnlink: DeleteRestriction[] = supportsUnlink
      ? repository.entities.flatMap((entity) => {
        if (entity.relative === found.relative) return [];
        const document = unlinkPersonReference(entity.document, id);
        return document === undefined ? [] : [{
          path: entity.relative,
          entity_id: typeof entity.document.id === "string" ? entity.document.id : undefined,
          schema: entity.document.schema,
          label: entityDisplayLabel(entity.document),
        }];
      })
      : [];
    return {
      entityType,
      id,
      schema: found.document.schema,
      path: found.relative,
      supports_unlink: supportsUnlink,
      supports_cascade: supportsCascade,
      cascaded_comments: cascadedComments.map((comment) => ({ path: comment.relative, id: String(comment.document.id) })),
      cascaded_entities: cascadedEntities,
      restrictions,
      would_unlink: wouldUnlink,
    };
  }

  async delete(
    draftId: string,
    owner: string,
    entityType: string,
    id: string,
    expectedFingerprint: string,
    expectedBlobId: string,
    unlinkReferences = false,
    cascadeReferences = false,
  ): Promise<{ deleted: true; path: string; unlinked_paths: readonly string[]; cascaded_paths: readonly string[]; draft_fingerprint: string }> {
    const mutation = await this.drafts.withRepositoryMutation(draftId, owner, expectedFingerprint, this.mutationMode, async (metadata) => {
      const found = await this.find(draftId, metadata, entityType, id);
      await this.drafts.assertFileBlobId(draftId, found.relative, expectedBlobId);
      const repository = await this.index(draftId, metadata);
      if (unlinkReferences && cascadeReferences) {
        throw new DomainOperationError("DELETE_REFERENCE_MODE_CONFLICT", "Reference unlink and cascade modes cannot be combined");
      }
      if (unlinkReferences && found.document.schema !== "gitpm/person@1") {
        throw new DomainOperationError("DELETE_UNLINK_UNSUPPORTED", "Automatic reference removal is supported only for people");
      }
      if (cascadeReferences && found.document.schema !== "gitpm/project@2") {
        throw new DomainOperationError("DELETE_CASCADE_UNSUPPORTED", "Reference cascade deletion is supported only for projects");
      }
      const cascadedComments = found.document.schema === "gitpm/task@2"
        ? repository.entities.filter((entity) => entity.document.schema === "gitpm/comment@1" && entity.document.task === id)
        : [];
      const cascadedEntities = found.document.schema === "gitpm/project@2" && cascadeReferences
        ? repository.entities.filter((entity) => entity.relative !== found.relative && entity.document.project === id)
        : [];
      const commentPaths = new Set(cascadedComments.map((comment) => comment.relative));
      const restrictions = (await validateDelete(metadata.worktree_path, id)).filter((restriction) => !commentPaths.has(restriction.path));
      if (restrictions.length > 0 && !unlinkReferences && !cascadeReferences) {
        const entitiesByPath = new Map(repository.entities.map((entity) => [entity.relative, entity.document]));
        throw new DomainOperationError("DELETE_RESTRICTED", `${id} is referenced`, restrictions.map((restriction) => {
          const document = entitiesByPath.get(restriction.path);
          return document === undefined ? restriction : {
            ...restriction,
            entity_id: document.id,
            schema: document.schema,
            label: entityDisplayLabel(document),
          };
        }));
      }
      const updates = unlinkReferences
        ? repository.entities.flatMap((entity) => {
          if (entity.relative === found.relative) return [];
          const document = unlinkPersonReference(entity.document, id);
          return document === undefined ? [] : [{ entity, document }];
        })
        : [];
      const cascaded = [...cascadedComments, ...cascadedEntities];
      const removed = [found, ...cascaded];
      const originals = new Map<string, string>();
      try {
        const referenceLabels = this.labels(repository);
        for (const update of updates) {
          originals.set(update.entity.relative, await readFile(update.entity.absolute, "utf8"));
          await atomicWriteDomainFile(metadata.worktree_path, update.entity.relative, formatYamlDocument(update.document, referenceLabels));
        }
        for (const entity of removed) {
          originals.set(entity.relative, await readFile(entity.absolute, "utf8"));
          await rm(entity.absolute);
        }
        await this.assertRepositoryValid(metadata.worktree_path);
      } catch (error) {
        for (const [relative, original] of originals) {
          const absolute = path.join(metadata.worktree_path, ...relative.split("/"));
          await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
          await atomicWriteDomainFile(metadata.worktree_path, relative, original);
        }
        throw error;
      }
      return {
        path: found.relative,
        unlinked_paths: updates.map((update) => update.entity.relative),
        cascaded_paths: cascaded.map((entity) => entity.relative),
      };
    });
    return { deleted: true, ...mutation.result, draft_fingerprint: mutation.metadata.fingerprint };
  }

  private async getWithFingerprint(draftId: string, document: GitPmDocument, relative: string, fingerprint: string): Promise<EntityResult> {
    return {
      document,
      path: relative,
      blob_id: await this.drafts.fileBlobId(draftId, relative),
      draft_fingerprint: fingerprint,
    };
  }

  private async assertRepositoryValid(worktree: string): Promise<void> {
    const report = await validateRepository(worktree);
    if (!report.valid) {
      const first = report.errors[0];
      const issue = first === undefined
        ? "validation did not return an issue"
        : `[${first.code}] ${first.path}${first.field === undefined ? "" : ` (field ${first.field})`}: ${first.message}`;
      throw new DomainOperationError(
        "VALIDATION_FAILED",
        `Repository validation failed with ${report.errors.length} error${report.errors.length === 1 ? "" : "s"}: ${issue}`,
        report.errors,
      );
    }
  }
}
