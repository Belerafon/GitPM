export type GitPmRole = "Reporter" | "Developer" | "Maintainer";
export type WriterMode = "ui" | "external";
export type DraftState = "open" | "closed" | "published" | "abandoned";

export interface PublicSession {
  readonly user: { readonly id: string; readonly username: string };
  readonly role: GitPmRole;
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
  readonly changed_externally?: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ChangesSummary {
  readonly changed_files_count: number;
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

export type GitPmDocument = Readonly<Record<string, unknown>> & { readonly schema: string; readonly id: string; readonly lifecycle: "active" | "archived" };

export interface EntityResult {
  readonly document: GitPmDocument;
  readonly path: string;
  readonly blob_id: string;
  readonly draft_fingerprint: string;
}
