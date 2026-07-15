export type GitPmRole = "Reporter" | "Developer" | "Maintainer";
export type WriterMode = "ui" | "external";
export type DraftState = "open" | "closed" | "published" | "abandoned";

export interface PublicSession {
  readonly user: { readonly id: string; readonly username: string };
  readonly role: GitPmRole;
  readonly mode?: "repository";
  readonly repository?: { readonly name: string; readonly path: string; readonly has_remote: boolean };
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

export interface CommitResult { readonly commit: string; readonly branch: string; readonly draft_fingerprint: string }
export interface PushResult { readonly branch: string; readonly commit: string }

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
  readonly files: readonly { readonly path: string; readonly additions: number | null; readonly deletions: number | null }[];
  readonly diff: string;
}

export interface RevertDraftResult {
  readonly draft: DraftStatus;
  readonly reverted_commit: string;
  readonly conflicted: boolean;
  readonly conflicted_files: readonly string[];
}

export type GitPmDocument = Readonly<Record<string, unknown>> & { readonly schema: string; readonly id: string; readonly lifecycle: "active" | "archived" };

export interface EntityResult {
  readonly document: GitPmDocument;
  readonly path: string;
  readonly blob_id: string;
  readonly draft_fingerprint: string;
}

export interface ProjectWorkspaceResult {
  readonly project: EntityResult;
  readonly milestones: readonly EntityResult[];
  readonly tasks: readonly EntityResult[];
  readonly draft_fingerprint: string;
}
