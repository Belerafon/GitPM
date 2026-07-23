import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { FromSchema } from "json-schema-to-ts";
import {
  DOCUMENT_SCHEMA_DEFINITIONS,
  DOCUMENT_SCHEMA_FILES,
  DOCUMENT_SCHEMA_IDS,
  DOCUMENT_SCHEMAS,
} from "./generated-document-schemas.js";
import type {
  calendarSchema,
  commonSchema,
  issueTypesSchema,
  milestoneSchema,
  personSchema,
  projectSchema,
  savedViewSchema,
  statusesSchema,
  taskSchema,
  teamSchema,
} from "./generated-document-schemas.js";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonRecord = { readonly [key: string]: JsonValue };
export type Lifecycle = "active" | "archived";
export type EntityDocumentSchema =
  | typeof projectSchema.properties.schema.const
  | typeof taskSchema.properties.schema.const
  | typeof milestoneSchema.properties.schema.const
  | typeof personSchema.properties.schema.const
  | typeof teamSchema.properties.schema.const
  | typeof calendarSchema.properties.schema.const
  | typeof savedViewSchema.properties.schema.const;

export interface EntityDocument extends Readonly<Record<string, unknown>> {
  readonly schema: EntityDocumentSchema;
  readonly id: string;
  readonly lifecycle: Lifecycle;
  readonly name?: string;
  readonly title?: string;
  readonly status?: string;
  readonly type?: string;
  readonly project?: string;
  readonly group?: string;
  readonly description_markdown?: string;
  readonly acceptance_criteria_markdown?: readonly string[];
  readonly owner?: string;
  readonly parent?: string;
  readonly milestone?: string;
  readonly assignees?: readonly string[];
  readonly estimate_hours?: number;
  readonly start?: string;
  readonly due?: string;
  readonly depends_on?: readonly string[];
  readonly milestone_order?: readonly string[];
  readonly task_order?: readonly string[];
  readonly labels?: readonly string[];
  readonly weekly_capacity_hours?: number;
  readonly calendar?: string;
  readonly email?: string;
  readonly members?: readonly string[];
  readonly working_weekdays?: readonly number[];
  readonly holidays?: readonly string[];
  readonly kind?: "list" | "board";
  readonly filters?: SavedViewFilters;
  readonly group_by?: "status";
}

type SchemaReferences = { readonly references: [typeof commonSchema] };

export type ProjectDocument = FromSchema<typeof projectSchema, SchemaReferences> & EntityDocument;
export type TaskDocument = FromSchema<typeof taskSchema, SchemaReferences> & EntityDocument;
export type MilestoneDocument = FromSchema<typeof milestoneSchema, SchemaReferences> & EntityDocument;
export type PersonDocument = FromSchema<typeof personSchema, SchemaReferences> & EntityDocument;
export type TeamDocument = FromSchema<typeof teamSchema, SchemaReferences> & EntityDocument;
export type CalendarDocument = FromSchema<typeof calendarSchema, SchemaReferences> & EntityDocument;

export interface SavedViewFilters {
  readonly statuses?: readonly string[];
  readonly types?: readonly string[];
  readonly assignees?: readonly string[];
  readonly milestones?: readonly string[];
  readonly labels?: readonly string[];
}

export type SavedViewDocument = FromSchema<typeof savedViewSchema, SchemaReferences> & EntityDocument;

export type StrictEntityDocument =
  | ProjectDocument
  | TaskDocument
  | MilestoneDocument
  | PersonDocument
  | TeamDocument
  | CalendarDocument
  | SavedViewDocument;

export type EntityDocumentFor<Schema extends EntityDocumentSchema> = Extract<StrictEntityDocument, { readonly schema: Schema }>;

export interface ConfigValue {
  readonly slug: string;
  readonly title: string;
  readonly color?: string;
  readonly active: boolean;
}

export interface StrictConfigValue extends ConfigValue {
  readonly color: string;
}

export interface ConfigurationDocument extends Readonly<Record<string, unknown>> {
  readonly schema: "gitpm/statuses@1" | "gitpm/issue-types@1";
  readonly statuses?: readonly ConfigValue[];
  readonly issue_types?: readonly ConfigValue[];
}

export type StatusesDocument = FromSchema<typeof statusesSchema, SchemaReferences> & ConfigurationDocument;
export type IssueTypesDocument = FromSchema<typeof issueTypesSchema, SchemaReferences> & ConfigurationDocument;

export type StatusValue = ConfigValue;
export type IssueTypeValue = ConfigValue;
export type StrictConfigurationDocument = StatusesDocument | IssueTypesDocument;

export interface ActorSnapshot {
  readonly provider: "gitlab" | "git";
  readonly instance?: string;
  readonly subject: string;
  readonly display_name: string;
}

interface CommentDocumentBase {
  readonly schema: "gitpm/comment@1";
  readonly id: string;
  readonly project: string;
  readonly task: string;
  readonly author: ActorSnapshot;
  readonly created_at: string;
  readonly updated_at?: string;
  readonly body_markdown?: string;
  readonly deleted_at?: string;
  readonly deleted_by?: ActorSnapshot;
}

export interface ActiveCommentDocument extends CommentDocumentBase {
  readonly state: "active";
  readonly body_markdown: string;
  readonly mentions: readonly { readonly person: string; readonly mentioned_at: string }[];
}

export interface DeletedCommentDocument extends CommentDocumentBase {
  readonly state: "deleted";
  readonly mentions: readonly [];
  readonly deleted_at: string;
  readonly deleted_by: ActorSnapshot;
}

export type CommentDocument = ActiveCommentDocument | DeletedCommentDocument;

export interface RepositoryDocument {
  readonly schema: "gitpm/repository@1";
  readonly default_branch: string;
  readonly default_calendar: string;
  readonly allowed_top_level_files: readonly string[];
  readonly allowed_top_level_directories?: readonly string[];
  readonly ui_poll_interval_seconds: number;
}

export type GitPmDocument = EntityDocument | ConfigurationDocument;
export type StrictGitPmDocument = StrictEntityDocument | StrictConfigurationDocument;
export type RepositoryGitPmDocument = GitPmDocument | CommentDocument | RepositoryDocument;
export type HttpDocument = StrictGitPmDocument;

export const ENTITY_TYPE_SCHEMAS = {
  projects: "gitpm/project@1",
  tasks: "gitpm/task@1",
  milestones: "gitpm/milestone@1",
  people: "gitpm/person@1",
  teams: "gitpm/team@1",
  calendars: "gitpm/calendar@1",
  views: "gitpm/saved-view@1",
} as const satisfies Readonly<Record<string, EntityDocumentSchema>>;

export type EntityType = keyof typeof ENTITY_TYPE_SCHEMAS;
export const ENTITY_DOCUMENT_SCHEMAS = Object.freeze(Object.values(ENTITY_TYPE_SCHEMAS)) as readonly EntityDocumentSchema[];
export const DOCUMENT_SCHEMA_NAMES = Object.freeze(Object.keys(DOCUMENT_SCHEMA_FILES));
export { DOCUMENT_SCHEMA_DEFINITIONS, DOCUMENT_SCHEMA_FILES, DOCUMENT_SCHEMA_IDS, DOCUMENT_SCHEMAS };

export type Decoder<T> = (value: unknown) => T;

export class ApiContractError extends Error {
  public readonly code = "API_RESPONSE_CONTRACT_INVALID";

  constructor(
    public readonly contract: string,
    message: string,
    public readonly details?: readonly ErrorObject[],
  ) {
    super(`${contract}: ${message}`);
    this.name = "ApiContractError";
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
for (const schema of DOCUMENT_SCHEMA_DEFINITIONS) ajv.addSchema(schema);

const validators = new Map<string, ValidateFunction>();
for (const [schema, id] of Object.entries(DOCUMENT_SCHEMA_IDS)) {
  const validate = ajv.getSchema(id);
  if (validate === undefined) throw new Error(`Contract schema validator unavailable: ${id}`);
  validators.set(schema, validate);
}

function record(value: unknown, contract: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiContractError(contract, "expected an object");
  }
  return value as Record<string, unknown>;
}

function decodeDocument(input: unknown, allowedSchemas: ReadonlySet<string>, contract: string): RepositoryGitPmDocument {
  const value = record(input, contract);
  if (typeof value.schema !== "string" || !allowedSchemas.has(value.schema)) {
    throw new ApiContractError(contract, `unsupported document schema ${String(value.schema)}`);
  }
  const validate = validators.get(value.schema);
  if (validate === undefined || !validate(value)) {
    throw new ApiContractError(contract, "document does not match its JSON Schema", validate?.errors ?? undefined);
  }
  return value as unknown as RepositoryGitPmDocument;
}

const entitySchemas = new Set<string>(ENTITY_DOCUMENT_SCHEMAS);
const configurationSchemas = new Set<string>(["gitpm/statuses@1", "gitpm/issue-types@1"]);
const commentSchemas = new Set<string>(["gitpm/comment@1"]);

export const decodeEntityDocument: Decoder<StrictEntityDocument> = (input) =>
  decodeDocument(input, entitySchemas, "EntityDocument") as StrictEntityDocument;

export const decodeConfigurationDocument: Decoder<StrictConfigurationDocument> = (input) =>
  decodeDocument(input, configurationSchemas, "ConfigurationDocument") as StrictConfigurationDocument;

export const decodeCommentDocument: Decoder<CommentDocument> = (input) =>
  decodeDocument(input, commentSchemas, "CommentDocument") as CommentDocument;
