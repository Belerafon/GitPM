import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import {
  ApiContractError,
  DOCUMENT_SCHEMA_DEFINITIONS,
  type ActorSnapshot,
  type CommentDocument,
  type ConfigurationDocument,
  type Decoder,
  type EntityDocument,
} from "./documents.js";

export type GitPmRole = "Reporter" | "Developer" | "Maintainer";
export type WriterMode = "ui" | "external";
export type DraftState = "open" | "closed" | "published" | "abandoned";

export interface EntityResult<Document extends EntityDocument | ConfigurationDocument = EntityDocument> {
  readonly document: Document;
  readonly path: string;
  readonly blob_id: string;
  readonly draft_fingerprint: string;
}

export type ConfigurationResult = EntityResult<ConfigurationDocument>;

export interface PublicSession {
  readonly user: { readonly id: string; readonly username: string };
  readonly role: GitPmRole;
  readonly mode?: "repository";
  readonly repository_mode?: "direct" | "worktree";
  readonly repository?: { readonly name: string; readonly path: string; readonly has_remote: boolean; readonly branch?: string };
  readonly gitlab?: {
    readonly configured: boolean;
    readonly user?: { readonly id: string; readonly username: string };
    readonly role?: GitPmRole;
  };
  readonly expires_at: string;
}

export interface DraftStatus {
  readonly draft_id: string;
  readonly owner_gitlab_user_id: string;
  readonly branch: string;
  readonly base_commit: string;
  readonly writer_mode: WriterMode;
  readonly state: DraftState;
  readonly merge_request_iid?: number;
  readonly fingerprint: string;
  readonly external_fingerprint?: string;
  readonly changed_externally?: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ChangesSummary {
  readonly changed_files_count: number;
}

export interface WorktreeEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "directory" | "file" | "symlink" | "other";
  readonly size?: number;
}

export interface WorktreeDirectory {
  readonly path: string;
  readonly entries: readonly WorktreeEntry[];
}

export interface WorktreeFile {
  readonly path: string;
  readonly size: number;
  readonly content: string;
}

export type ChangeKind = "Added" | "Modified" | "Deleted";

export interface DiffHunk {
  readonly old_start: number;
  readonly old_count: number;
  readonly new_start: number;
  readonly new_count: number;
  readonly lines: readonly string[];
}

export interface FileChange {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly diff: string;
  readonly diff_token: string;
  readonly hunks: readonly DiffHunk[];
  readonly oversized?: boolean;
}

export interface ChangesList extends ChangesSummary {
  readonly files: readonly FileChange[];
  readonly affected_projects: readonly string[];
}

export interface SemanticFieldChange {
  readonly field: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface SemanticChange {
  readonly path: string;
  readonly id: string;
  readonly schema: string;
  readonly project?: string;
  readonly fields: readonly SemanticFieldChange[];
}

export interface SemanticDiff {
  readonly created: readonly SemanticChange[];
  readonly updated: readonly SemanticChange[];
  readonly archived: readonly SemanticChange[];
  readonly deleted: readonly SemanticChange[];
  readonly counts: Readonly<Record<"created" | "updated" | "archived" | "deleted", number>>;
  readonly affected_projects: readonly string[];
  readonly unclassified_files: readonly string[];
}

export interface CommitResult {
  readonly commit: string;
  readonly branch: string;
  readonly draft_fingerprint: string;
}

export interface PushResult {
  readonly branch: string;
  readonly commit: string;
}

export interface RepositoryConnectionStatus {
  readonly repository_path: string;
  readonly repository_mode: "direct" | "worktree";
  readonly default_branch: string;
  readonly repository_url?: string;
  readonly remote_source: "environment" | "config" | "origin" | "none";
  readonly remote_editable: boolean;
  readonly gitlab_editable: boolean;
  readonly gitlab: {
    readonly configured: boolean;
    readonly base_url?: string;
    readonly project?: string;
    readonly client_id?: string;
  };
}

export interface RepositoryConnectionUpdate {
  readonly repository_url?: string | null;
  readonly gitlab?: {
    readonly base_url?: string | null;
    readonly project?: string | null;
    readonly client_id?: string | null;
  } | null;
  readonly confirmation?: string;
}

export interface RepositoryConnectionTest {
  readonly ok: true;
  readonly branch: string;
  readonly commit: string;
}

export interface ValidationSummary {
  readonly valid: boolean;
  readonly error_count: number;
  readonly warning_count: number;
  readonly document_count: number;
}

export interface MergeRequestStatus {
  readonly iid: number;
  readonly state: "opened" | "merged" | "closed";
  readonly web_url: string;
}

export interface DraftSnapshot {
  readonly draft: DraftStatus;
  readonly changes: ChangesSummary;
  readonly validation: ValidationSummary;
  readonly mergeRequest?: MergeRequestStatus;
}

export interface HistorySemanticSummary {
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  readonly affected_projects: readonly string[];
}

export interface CommitHistoryItem {
  readonly commit: string;
  readonly parents: readonly string[];
  readonly author_name: string;
  readonly author_email: string;
  readonly authored_at: string;
  readonly subject: string;
  readonly semantic_summary: HistorySemanticSummary;
}

export interface CommitHistoryDetail extends CommitHistoryItem {
  readonly body: string;
  readonly files: readonly {
    readonly path: string;
    readonly status: ChangeKind;
    readonly additions: number | null;
    readonly deletions: number | null;
  }[];
}

export interface CommitFileDiff {
  readonly diff: string;
  readonly oversized: boolean;
}

export interface RevertDraftResult {
  readonly draft: DraftStatus;
  readonly reverted_commit: string;
  readonly conflicted: boolean;
  readonly conflicted_files: readonly string[];
}

export interface ProjectWorkspaceResult {
  readonly project: EntityResult;
  readonly milestones: readonly EntityResult[];
  readonly tasks: readonly EntityResult[];
  readonly draft_fingerprint: string;
}

export interface CommentResult {
  readonly document: CommentDocument;
  readonly path: string;
  readonly blob_id: string;
  readonly draft_fingerprint: string;
  readonly can_edit: boolean;
  readonly can_delete: boolean;
}

export interface MentionNotification {
  readonly key: string;
  readonly person_id: string;
  readonly mentioned_at: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly task_title: string;
  readonly comment_id: string;
  readonly author: ActorSnapshot;
  readonly excerpt: string;
}

export interface NotificationsResult {
  readonly recipient_person_id?: string;
  readonly items: readonly MentionNotification[];
}

const stringSchema = { type: "string" } as const;
const integerSchema = { type: "integer" } as const;
const booleanSchema = { type: "boolean" } as const;
const unknownSchema = {} as const;
const stringArraySchema = { type: "array", items: stringSchema } as const;
const nullableStringSchema = { type: ["string", "null"] } as const;

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = Object.keys(properties),
  additionalProperties = false,
): Readonly<Record<string, unknown>> {
  return { type: "object", additionalProperties, required, properties };
}

function arraySchema(items: unknown): Readonly<Record<string, unknown>> {
  return { type: "array", items };
}

const actorSchema = objectSchema({
  provider: { enum: ["gitlab", "git"] },
  instance: stringSchema,
  subject: stringSchema,
  display_name: stringSchema,
}, ["provider", "subject", "display_name"]);

const draftStatusSchema = objectSchema({
  draft_id: stringSchema,
  owner_gitlab_user_id: stringSchema,
  branch: stringSchema,
  base_commit: stringSchema,
  writer_mode: { enum: ["ui", "external"] },
  state: { enum: ["open", "closed", "published", "abandoned"] },
  merge_request_iid: integerSchema,
  fingerprint: stringSchema,
  external_fingerprint: stringSchema,
  changed_externally: booleanSchema,
  created_at: stringSchema,
  updated_at: stringSchema,
}, ["draft_id", "owner_gitlab_user_id", "branch", "base_commit", "writer_mode", "state", "fingerprint", "created_at", "updated_at"]);

const entityDocumentSchema = {
  oneOf: [
    { $ref: "https://gitpm.dev/schemas/v1/project.schema.json" },
    { $ref: "https://gitpm.dev/schemas/v1/task.schema.json" },
    { $ref: "https://gitpm.dev/schemas/v1/milestone.schema.json" },
    { $ref: "https://gitpm.dev/schemas/v1/person.schema.json" },
    { $ref: "https://gitpm.dev/schemas/v1/team.schema.json" },
    { $ref: "https://gitpm.dev/schemas/v1/calendar.schema.json" },
    { $ref: "https://gitpm.dev/schemas/v1/saved-view.schema.json" },
  ],
} as const;

const configurationDocumentSchema = {
  oneOf: [
    { $ref: "https://gitpm.dev/schemas/v1/statuses.schema.json" },
    { $ref: "https://gitpm.dev/schemas/v1/issue-types.schema.json" },
  ],
} as const;

const entityResultSchema = objectSchema({
  document: entityDocumentSchema,
  path: stringSchema,
  blob_id: stringSchema,
  draft_fingerprint: stringSchema,
});

const configurationResultSchema = objectSchema({
  document: configurationDocumentSchema,
  path: stringSchema,
  blob_id: stringSchema,
  draft_fingerprint: stringSchema,
});

const publicSessionSchema = objectSchema({
  user: objectSchema({ id: stringSchema, username: stringSchema }),
  role: { enum: ["Reporter", "Developer", "Maintainer"] },
  mode: { const: "repository" },
  repository_mode: { enum: ["direct", "worktree"] },
  repository: objectSchema({
    name: stringSchema,
    path: stringSchema,
    has_remote: booleanSchema,
    branch: stringSchema,
  }, ["name", "path", "has_remote"]),
  gitlab: objectSchema({
    configured: booleanSchema,
    user: objectSchema({ id: stringSchema, username: stringSchema }),
    role: { enum: ["Reporter", "Developer", "Maintainer"] },
  }, ["configured"]),
  expires_at: stringSchema,
}, ["user", "role", "expires_at"]);

const changesSummarySchema = objectSchema({ changed_files_count: integerSchema });
const validationSummarySchema = objectSchema({
  valid: booleanSchema,
  error_count: integerSchema,
  warning_count: integerSchema,
  document_count: integerSchema,
});
const mergeRequestStatusSchema = objectSchema({
  iid: integerSchema,
  state: { enum: ["opened", "merged", "closed"] },
  web_url: stringSchema,
});

const diffHunkSchema = objectSchema({
  old_start: integerSchema,
  old_count: integerSchema,
  new_start: integerSchema,
  new_count: integerSchema,
  lines: stringArraySchema,
});
const fileChangeSchema = objectSchema({
  path: stringSchema,
  kind: { enum: ["Added", "Modified", "Deleted"] },
  diff: stringSchema,
  diff_token: stringSchema,
  hunks: arraySchema(diffHunkSchema),
  oversized: booleanSchema,
}, ["path", "kind", "diff", "diff_token", "hunks"]);
const changesListSchema = objectSchema({
  changed_files_count: integerSchema,
  files: arraySchema(fileChangeSchema),
  affected_projects: stringArraySchema,
});

const semanticFieldChangeSchema = objectSchema({
  field: stringSchema,
  before: unknownSchema,
  after: unknownSchema,
}, ["field"]);
const semanticChangeSchema = objectSchema({
  path: stringSchema,
  id: stringSchema,
  schema: stringSchema,
  project: stringSchema,
  fields: arraySchema(semanticFieldChangeSchema),
}, ["path", "id", "schema", "fields"]);
const semanticDiffSchema = objectSchema({
  created: arraySchema(semanticChangeSchema),
  updated: arraySchema(semanticChangeSchema),
  archived: arraySchema(semanticChangeSchema),
  deleted: arraySchema(semanticChangeSchema),
  counts: objectSchema({
    created: integerSchema,
    updated: integerSchema,
    archived: integerSchema,
    deleted: integerSchema,
  }),
  affected_projects: stringArraySchema,
  unclassified_files: stringArraySchema,
});

const historySemanticSummarySchema = objectSchema({
  created: integerSchema,
  updated: integerSchema,
  deleted: integerSchema,
  affected_projects: stringArraySchema,
});
const commitHistoryItemSchema = objectSchema({
  commit: stringSchema,
  parents: stringArraySchema,
  author_name: stringSchema,
  author_email: stringSchema,
  authored_at: stringSchema,
  subject: stringSchema,
  semantic_summary: historySemanticSummarySchema,
});
const commitHistoryDetailSchema = objectSchema({
  commit: stringSchema,
  parents: stringArraySchema,
  author_name: stringSchema,
  author_email: stringSchema,
  authored_at: stringSchema,
  subject: stringSchema,
  semantic_summary: historySemanticSummarySchema,
  body: stringSchema,
  files: arraySchema(objectSchema({
    path: stringSchema,
    status: { enum: ["Added", "Modified", "Deleted"] },
    additions: { type: ["number", "null"] },
    deletions: { type: ["number", "null"] },
  })),
});

const repositoryConnectionStatusSchema = objectSchema({
  repository_path: stringSchema,
  repository_mode: { enum: ["direct", "worktree"] },
  default_branch: stringSchema,
  repository_url: stringSchema,
  remote_source: { enum: ["environment", "config", "origin", "none"] },
  remote_editable: booleanSchema,
  gitlab_editable: booleanSchema,
  gitlab: objectSchema({
    configured: booleanSchema,
    base_url: stringSchema,
    project: stringSchema,
    client_id: stringSchema,
  }, ["configured"]),
}, ["repository_path", "repository_mode", "default_branch", "remote_source", "remote_editable", "gitlab_editable", "gitlab"]);

const worktreeEntrySchema = objectSchema({
  name: stringSchema,
  path: stringSchema,
  type: { enum: ["directory", "file", "symlink", "other"] },
  size: integerSchema,
}, ["name", "path", "type"]);
const worktreeDirectorySchema = objectSchema({ path: stringSchema, entries: arraySchema(worktreeEntrySchema) });
const worktreeFileSchema = objectSchema({ path: stringSchema, size: integerSchema, content: stringSchema });

const commentResultSchema = objectSchema({
  document: { $ref: "https://gitpm.dev/schemas/v1/comment.schema.json" },
  path: stringSchema,
  blob_id: stringSchema,
  draft_fingerprint: stringSchema,
  can_edit: booleanSchema,
  can_delete: booleanSchema,
});
const notificationSchema = objectSchema({
  key: stringSchema,
  person_id: stringSchema,
  mentioned_at: stringSchema,
  project_id: stringSchema,
  task_id: stringSchema,
  task_title: stringSchema,
  comment_id: stringSchema,
  author: actorSchema,
  excerpt: stringSchema,
});

export const HTTP_RESPONSE_SCHEMAS = {
  authorization: objectSchema({ authorization_url: stringSchema, state: stringSchema }),
  publicSession: publicSessionSchema,
  repositoryConnectionStatus: repositoryConnectionStatusSchema,
  repositoryConnectionTest: objectSchema({ ok: { const: true }, branch: stringSchema, commit: stringSchema }),
  draftStatus: draftStatusSchema,
  draftStatuses: arraySchema(draftStatusSchema),
  changesSummary: changesSummarySchema,
  validationSummary: validationSummarySchema,
  entityResult: entityResultSchema,
  entityResults: arraySchema(entityResultSchema),
  configurationResult: configurationResultSchema,
  projectWorkspace: objectSchema({
    project: entityResultSchema,
    milestones: arraySchema(entityResultSchema),
    tasks: arraySchema(entityResultSchema),
    draft_fingerprint: stringSchema,
  }),
  changesList: changesListSchema,
  semanticDiff: semanticDiffSchema,
  commitResult: objectSchema({ commit: stringSchema, branch: stringSchema, draft_fingerprint: stringSchema }),
  pushResult: objectSchema({ branch: stringSchema, commit: stringSchema }),
  mergeRequestStatus: mergeRequestStatusSchema,
  commitHistoryItems: arraySchema(commitHistoryItemSchema),
  commitHistoryDetail: commitHistoryDetailSchema,
  commitFileDiff: objectSchema({ diff: stringSchema, oversized: booleanSchema }),
  revertDraftResult: objectSchema({
    draft: draftStatusSchema,
    reverted_commit: stringSchema,
    conflicted: booleanSchema,
    conflicted_files: stringArraySchema,
  }),
  worktreeDirectory: worktreeDirectorySchema,
  worktreeFile: worktreeFileSchema,
  worktreeEntryMutation: objectSchema({ path: stringSchema, draft_fingerprint: stringSchema }),
  worktreeFileMutation: objectSchema({ path: stringSchema, size: integerSchema, draft_fingerprint: stringSchema }),
  worktreeMoveMutation: objectSchema({ from: stringSchema, to: stringSchema, draft_fingerprint: stringSchema }),
  commentResults: arraySchema(commentResultSchema),
  commentResult: commentResultSchema,
  notifications: objectSchema({
    recipient_person_id: stringSchema,
    items: arraySchema(notificationSchema),
  }, ["items"]),
} as const;

const responseAjv = new Ajv2020({ allErrors: true, strict: true });
for (const schema of DOCUMENT_SCHEMA_DEFINITIONS) responseAjv.addSchema(schema);

function createDecoder<T>(contract: string, schema: object): Decoder<T> {
  const validate: ValidateFunction = responseAjv.compile(schema);
  return (input) => {
    if (!validate(input)) {
      throw new ApiContractError(contract, "response does not match the shared HTTP contract", validate.errors ?? undefined);
    }
    return input as T;
  };
}

export const decodeAuthorization = createDecoder<{ readonly authorization_url: string; readonly state: string }>("AuthorizationResponse", HTTP_RESPONSE_SCHEMAS.authorization);
export const decodePublicSession = createDecoder<PublicSession>("PublicSession", HTTP_RESPONSE_SCHEMAS.publicSession);
export const decodeRepositoryConnectionStatus = createDecoder<RepositoryConnectionStatus>("RepositoryConnectionStatus", HTTP_RESPONSE_SCHEMAS.repositoryConnectionStatus);
export const decodeRepositoryConnectionTest = createDecoder<RepositoryConnectionTest>("RepositoryConnectionTest", HTTP_RESPONSE_SCHEMAS.repositoryConnectionTest);
export const decodeDraftStatus = createDecoder<DraftStatus>("DraftStatus", HTTP_RESPONSE_SCHEMAS.draftStatus);
export const decodeDraftStatuses = createDecoder<readonly DraftStatus[]>("DraftStatus[]", HTTP_RESPONSE_SCHEMAS.draftStatuses);
export const decodeChangesSummary = createDecoder<ChangesSummary>("ChangesSummary", HTTP_RESPONSE_SCHEMAS.changesSummary);
export const decodeValidationSummary = createDecoder<ValidationSummary>("ValidationSummary", HTTP_RESPONSE_SCHEMAS.validationSummary);
export const decodeEntityResult = createDecoder<EntityResult>("EntityResult", HTTP_RESPONSE_SCHEMAS.entityResult);
export const decodeEntityResults = createDecoder<readonly EntityResult[]>("EntityResult[]", HTTP_RESPONSE_SCHEMAS.entityResults);
export const decodeConfigurationResult = createDecoder<ConfigurationResult>("ConfigurationResult", HTTP_RESPONSE_SCHEMAS.configurationResult);
export const decodeProjectWorkspace = createDecoder<ProjectWorkspaceResult>("ProjectWorkspaceResult", HTTP_RESPONSE_SCHEMAS.projectWorkspace);
export const decodeChangesList = createDecoder<ChangesList>("ChangesList", HTTP_RESPONSE_SCHEMAS.changesList);
export const decodeSemanticDiff = createDecoder<SemanticDiff>("SemanticDiff", HTTP_RESPONSE_SCHEMAS.semanticDiff);
export const decodeCommitResult = createDecoder<CommitResult>("CommitResult", HTTP_RESPONSE_SCHEMAS.commitResult);
export const decodePushResult = createDecoder<PushResult>("PushResult", HTTP_RESPONSE_SCHEMAS.pushResult);
export const decodeMergeRequestStatus = createDecoder<MergeRequestStatus>("MergeRequestStatus", HTTP_RESPONSE_SCHEMAS.mergeRequestStatus);
export const decodeCommitHistoryItems = createDecoder<readonly CommitHistoryItem[]>("CommitHistoryItem[]", HTTP_RESPONSE_SCHEMAS.commitHistoryItems);
export const decodeCommitHistoryDetail = createDecoder<CommitHistoryDetail>("CommitHistoryDetail", HTTP_RESPONSE_SCHEMAS.commitHistoryDetail);
export const decodeCommitFileDiff = createDecoder<CommitFileDiff>("CommitFileDiff", HTTP_RESPONSE_SCHEMAS.commitFileDiff);
export const decodeRevertDraftResult = createDecoder<RevertDraftResult>("RevertDraftResult", HTTP_RESPONSE_SCHEMAS.revertDraftResult);
export const decodeWorktreeDirectory = createDecoder<WorktreeDirectory>("WorktreeDirectory", HTTP_RESPONSE_SCHEMAS.worktreeDirectory);
export const decodeWorktreeFile = createDecoder<WorktreeFile>("WorktreeFile", HTTP_RESPONSE_SCHEMAS.worktreeFile);
export const decodeWorktreeEntryMutation = createDecoder<{ readonly path: string; readonly draft_fingerprint: string }>("WorktreeEntryMutation", HTTP_RESPONSE_SCHEMAS.worktreeEntryMutation);
export const decodeWorktreeFileMutation = createDecoder<{ readonly path: string; readonly size: number; readonly draft_fingerprint: string }>("WorktreeFileMutation", HTTP_RESPONSE_SCHEMAS.worktreeFileMutation);
export const decodeWorktreeMoveMutation = createDecoder<{ readonly from: string; readonly to: string; readonly draft_fingerprint: string }>("WorktreeMoveMutation", HTTP_RESPONSE_SCHEMAS.worktreeMoveMutation);
export const decodeCommentResults = createDecoder<readonly CommentResult[]>("CommentResult[]", HTTP_RESPONSE_SCHEMAS.commentResults);
export const decodeCommentResult = createDecoder<CommentResult>("CommentResult", HTTP_RESPONSE_SCHEMAS.commentResult);
export const decodeNotifications = createDecoder<NotificationsResult>("NotificationsResult", HTTP_RESPONSE_SCHEMAS.notifications);

const entityDocumentRequestSchema = objectSchema({
  schema: stringSchema,
}, ["schema"], true);
const configurationDocumentRequestSchema = objectSchema({
  schema: stringSchema,
}, ["schema"], true);

export const HTTP_REQUEST_BODY_SCHEMAS = {
  createDraft: objectSchema({ draft_id: stringSchema }),
  writerMode: objectSchema({ writer_mode: { enum: ["ui", "external"] } }),
  cleanupDraft: objectSchema({ confirmation: stringSchema }),
  expectedFingerprint: objectSchema({ expected_fingerprint: stringSchema }),
  expectedFingerprintPath: objectSchema({ expected_fingerprint: stringSchema, path: stringSchema }),
  restoreHunk: objectSchema({
    expected_fingerprint: stringSchema,
    path: stringSchema,
    diff_token: stringSchema,
    hunk_index: integerSchema,
  }),
  createEntity: objectSchema({ expected_fingerprint: stringSchema, document: entityDocumentRequestSchema }),
  updateEntity: objectSchema({
    expected_fingerprint: stringSchema,
    expected_blob_id: stringSchema,
    document: entityDocumentRequestSchema,
  }),
  entityFingerprint: objectSchema({ expected_fingerprint: stringSchema, expected_blob_id: stringSchema }),
  moveTask: objectSchema({
    expected_fingerprint: stringSchema,
    expected_blob_id: stringSchema,
    target_project: stringSchema,
    target_milestone: stringSchema,
  }, ["expected_fingerprint", "expected_blob_id", "target_project"]),
  deleteEntity: objectSchema({
    expected_fingerprint: stringSchema,
    expected_blob_id: stringSchema,
    unlink_references: booleanSchema,
  }, ["expected_fingerprint", "expected_blob_id"]),
  updateConfiguration: objectSchema({
    expected_fingerprint: stringSchema,
    expected_blob_id: stringSchema,
    document: configurationDocumentRequestSchema,
  }),
  commit: objectSchema({ message: stringSchema }),
  mergeRequest: objectSchema({ title: stringSchema, description: stringSchema }, ["title"]),
  revertDraft: objectSchema({ draft_id: stringSchema }),
  createComment: objectSchema({ expected_fingerprint: stringSchema, body_markdown: stringSchema }),
  updateComment: objectSchema({
    expected_fingerprint: stringSchema,
    expected_blob_id: stringSchema,
    body_markdown: stringSchema,
  }),
  deleteComment: objectSchema({ expected_fingerprint: stringSchema, expected_blob_id: stringSchema }),
  uploadWorktreeFile: objectSchema({
    expected_fingerprint: stringSchema,
    path: stringSchema,
    content_base64: stringSchema,
  }),
  moveWorktreeEntry: objectSchema({ expected_fingerprint: stringSchema, from: stringSchema, to: stringSchema }),
  repositoryConnectionUpdate: objectSchema({
    repository_url: nullableStringSchema,
    gitlab: {
      anyOf: [
        { type: "null" },
        objectSchema({
          base_url: nullableStringSchema,
          project: nullableStringSchema,
          client_id: nullableStringSchema,
        }, []),
      ],
    },
    confirmation: stringSchema,
  }, []),
} as const;
