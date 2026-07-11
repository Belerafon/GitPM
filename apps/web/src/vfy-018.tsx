import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import type { GitPmApi } from "./api.js";
import type { ChangesList, DraftSnapshot, DraftStatus, EntityResult, GitPmDocument, MergeRequestStatus, PublicSession, SemanticDiff, WriterMode } from "./types.js";
import "./styles.css";

const session: PublicSession = { user: { id: "42", username: "vfy-developer" }, role: "Maintainer", expires_at: "2026-07-10T18:00:00.000Z" };

class BrowserAcceptanceApi implements GitPmApi {
  private drafts: DraftStatus[] = [];
  private entities: EntityResult[] = [];
  private changedPaths = new Set<string>();
  private statusConfig: EntityResult | undefined;
  private issueTypeConfig: EntityResult | undefined;
  private pollCount = 0;
  private changedFiles: ChangesList["files"] = [];
  private mr: MergeRequestStatus | undefined;
  private mrPollCount = 0;
  constructor(private readonly role: PublicSession["role"] = "Maintainer") {}
  async session() { return { ...session, role: this.role }; }
  async login() { return "#"; }
  async logout() { /* acceptance fixture keeps its session */ }
  async listDrafts() { return this.drafts; }
  async createDraft(draftId: string) {
    const now = new Date().toISOString();
    const created: DraftStatus = { draft_id: draftId, owner_gitlab_user_id: "42", branch: `gitpm/42/${draftId}`, base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: now, updated_at: now };
    this.drafts = [created];
    this.changedFiles = [
      { path: "projects/PRJ-ALPHA/project.yaml", kind: "Modified", diff_token: "mod-token", diff: "@@ -2,2 +2,2 @@\n-name: Alpha\n+name: Alpha launch\n lifecycle: active\n", hunks: [{ old_start: 2, old_count: 2, new_start: 2, new_count: 2, lines: ["-name: Alpha", "+name: Alpha launch", " lifecycle: active"] }] },
      { path: "projects/PRJ-ALPHA/tasks/TSK-DELETED.yaml", kind: "Deleted", diff_token: "delete-token", diff: "@@ -1,2 +0,0 @@\n-schema: gitpm/task@1\n-id: TSK-DELETED\n", hunks: [{ old_start: 1, old_count: 2, new_start: 0, new_count: 0, lines: ["-schema: gitpm/task@1", "-id: TSK-DELETED"] }] },
      { path: "projects/PRJ-ALPHA/tasks/TSK-CREATED.yaml", kind: "Added", diff_token: "add-token", diff: "@@ -0,0 +1,2 @@\n+schema: gitpm/task@1\n+id: TSK-CREATED\n", hunks: [{ old_start: 0, old_count: 0, new_start: 1, new_count: 2, lines: ["+schema: gitpm/task@1", "+id: TSK-CREATED"] }] },
      { path: "projects/PRJ-ALPHA/tasks/TSK-ARCHIVED.yaml", kind: "Modified", diff_token: "archive-token", diff: "@@ -6,1 +6,1 @@\n-lifecycle: active\n+lifecycle: archived\n", hunks: [{ old_start: 6, old_count: 1, new_start: 6, new_count: 1, lines: ["-lifecycle: active", "+lifecycle: archived"] }] },
    ];
    if (window.location.pathname.endsWith("vfy-026.html")) {
      const project = `PRJ-${"1".repeat(26)}`;
      this.entities = [
        this.entityResult({ schema: "gitpm/project@1", id: project, name: "Beta portfolio", status: "backlog", lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/task@1", id: `TSK-${"2".repeat(26)}`, project, title: "Prepare beta", type: "task", status: "backlog", lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/task@1", id: `TSK-${"3".repeat(26)}`, project, title: "Review Board", type: "task", status: "in-progress", lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/task@1", id: `TSK-${"4".repeat(26)}`, project, title: "Alpha accepted", type: "task", status: "done", lifecycle: "active" }),
      ];
      this.changedFiles = [];
    }
    if (window.location.pathname.endsWith("vfy-027.html")) {
      const project = `PRJ-${"1".repeat(26)}`; const milestone = `MLS-${"8".repeat(26)}`;
      const ids = ["2", "3", "4", "5", "6"].map((value) => `TSK-${value.repeat(26)}`);
      this.entities = [
        this.entityResult({ schema: "gitpm/project@1", id: project, name: "Beta portfolio", status: "backlog", lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/milestone@1", id: milestone, project, name: "Beta release", due: "2026-07-08", lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/task@1", id: ids[0]!, project, title: "Plan release", type: "task", status: "done", lifecycle: "active", start: "2026-07-01", due: "2026-07-05" }),
        this.entityResult({ schema: "gitpm/task@1", id: ids[1]!, project, title: "Build API", type: "task", status: "done", lifecycle: "active", start: "2026-07-02", due: "2026-07-03", parent: ids[0], milestone }),
        this.entityResult({ schema: "gitpm/task@1", id: ids[2]!, project, title: "Ship UI", type: "task", status: "in-progress", lifecycle: "active", start: "2026-07-04", due: "2026-07-06", depends_on: [ids[1]!] }),
        this.entityResult({ schema: "gitpm/task@1", id: ids[3]!, project, title: "Review", type: "task", status: "backlog", lifecycle: "active", start: "2026-07-06", due: "2026-07-07", depends_on: [ids[2]!] }),
        this.entityResult({ schema: "gitpm/task@1", id: ids[4]!, project, title: "Launch", type: "task", status: "backlog", lifecycle: "active", start: "2026-07-08", due: "2026-07-08", depends_on: [ids[3]!] }),
        this.entityResult({ schema: "gitpm/task@1", id: `TSK-${"7".repeat(26)}`, project, title: "Undated hidden", type: "task", status: "backlog", lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/task@1", id: `TSK-${"9".repeat(26)}`, project, title: "Archived hidden", type: "task", status: "done", lifecycle: "archived", start: "2026-07-01", due: "2026-07-02" }),
      ];
      this.changedFiles = [];
    }
    return created;
  }
  async snapshot(draftId: string): Promise<DraftSnapshot> {
    this.pollCount += 1;
    document.documentElement.dataset.pollCount = String(this.pollCount);
    const draft = this.drafts.find((item) => item.draft_id === draftId);
    if (draft === undefined) throw new Error("draft not found");
    return { draft, changes: { changed_files_count: this.changedFiles.length + this.changedPaths.size }, validation: { valid: true, error_count: 0, warning_count: 0, document_count: 14 + this.entities.length }, ...(this.mr === undefined ? {} : { mergeRequest: this.mr }) };
  }
  async setWriterMode(draftId: string, writer_mode: WriterMode) { return this.replace(draftId, { writer_mode }); }
  async closeDraft(draftId: string) { return this.replace(draftId, { state: "closed" }); }
  async reopenDraft(draftId: string) { return this.replace(draftId, { state: "open" }); }
  async cleanupDraft(draftId: string) { this.drafts = this.drafts.filter((draft) => draft.draft_id !== draftId); }
  async listEntities(_draftId: string, entityType: string, project?: string) { const names: Record<string, string> = { people: "person", calendars: "calendar", teams: "team", views: "saved-view" }; const schema = `gitpm/${names[entityType] ?? entityType.slice(0, -1)}@1`; return this.entities.filter((item) => item.document.schema === schema && (project === undefined || item.document.project === project)); }
  async createEntity(_draftId: string, _entityType: string, _fingerprint: string, document: GitPmDocument): Promise<EntityResult> { const result = this.entityResult(document); this.entities.push(result); this.capture(result.path); return result; }
  async updateEntity(_draftId: string, _entityType: string, entity: EntityResult, _fingerprint: string, document: GitPmDocument): Promise<EntityResult> { const result = this.entityResult(document); this.entities = this.entities.map((item) => item.document.id === entity.document.id ? result : item); this.capture(result.path); return result; }
  async archiveEntity(draftId: string, entityType: string, entity: EntityResult, fingerprint: string): Promise<EntityResult> { return await this.updateEntity(draftId, entityType, entity, fingerprint, { ...entity.document, lifecycle: "archived" }); }
  async deleteEntity(_draftId: string, _entityType: string, entity: EntityResult) { this.entities = this.entities.filter((item) => item.document.id !== entity.document.id); this.capture(entity.path); }
  async getConfiguration(_draftId: string, kind: "statuses" | "issue-types"): Promise<EntityResult> { const existing = kind === "statuses" ? this.statusConfig : this.issueTypeConfig; if (existing !== undefined) return existing; const document = (kind === "statuses" ? { schema: "gitpm/statuses@1", id: "CONFIG-STATUSES", lifecycle: "active", statuses: [{ slug: "backlog", title: "Backlog", color: "gray", active: true }, { slug: "in-progress", title: "In progress", color: "blue", active: true }, { slug: "done", title: "Done", color: "green", active: true }] } : { schema: "gitpm/issue-types@1", id: "CONFIG-TYPES", lifecycle: "active", issue_types: [{ slug: "task", title: "Task", color: "blue", active: true }] }) as GitPmDocument; const created = { document, path: `.gitpm/${kind}.yaml`, blob_id: "e".repeat(40), draft_fingerprint: "d".repeat(64) }; if (kind === "statuses") this.statusConfig = created; else this.issueTypeConfig = created; return created; }
  async updateConfiguration(_draftId: string, kind: "statuses" | "issue-types", entity: EntityResult, _fingerprint: string, document: GitPmDocument): Promise<EntityResult> { const result = { ...entity, document, blob_id: "f".repeat(40), draft_fingerprint: "d".repeat(64) }; if (kind === "statuses") this.statusConfig = result; else this.issueTypeConfig = result; this.capture(result.path); return result; }
  async listChanges(): Promise<ChangesList> { return { files: this.changedFiles, changed_files_count: this.changedFiles.length, affected_projects: this.changedFiles.length === 0 ? [] : ["PRJ-ALPHA"] }; }
  async semanticChanges(): Promise<SemanticDiff> {
    const paths = new Set(this.changedFiles.map((file) => file.path));
    const item = (id: string, path: string, field: string, before: unknown, after: unknown) => ({ id, path, schema: id === "PRJ-ALPHA" ? "gitpm/project@1" : "gitpm/task@1", project: "PRJ-ALPHA", fields: [{ field, before, after }] });
    const created = paths.has("projects/PRJ-ALPHA/tasks/TSK-CREATED.yaml") ? [item("TSK-CREATED", "projects/PRJ-ALPHA/tasks/TSK-CREATED.yaml", "title", undefined, "Created task")] : [];
    const updated = paths.has("projects/PRJ-ALPHA/project.yaml") ? [item("PRJ-ALPHA", "projects/PRJ-ALPHA/project.yaml", "name", "Alpha", "Alpha launch")] : [];
    const archived = paths.has("projects/PRJ-ALPHA/tasks/TSK-ARCHIVED.yaml") ? [item("TSK-ARCHIVED", "projects/PRJ-ALPHA/tasks/TSK-ARCHIVED.yaml", "lifecycle", "active", "archived")] : [];
    const deleted = paths.has("projects/PRJ-ALPHA/tasks/TSK-DELETED.yaml") ? [item("TSK-DELETED", "projects/PRJ-ALPHA/tasks/TSK-DELETED.yaml", "title", "Deleted task", undefined)] : [];
    return { created, updated, archived, deleted, counts: { created: created.length, updated: updated.length, archived: archived.length, deleted: deleted.length }, affected_projects: this.changedFiles.length === 0 ? [] : ["PRJ-ALPHA"], unclassified_files: [] };
  }
  async restoreFile(_draftId: string, _fingerprint: string, path: string) { document.documentElement.dataset.restoredFile = path; if (path.includes("TSK-DELETED")) { document.documentElement.dataset.redeletedFile = path; return; } this.changedFiles = this.changedFiles.filter((file) => file.path !== path); }
  async restoreHunk(_draftId: string, _fingerprint: string, path: string) { document.documentElement.dataset.restoredHunk = path; this.changedFiles = this.changedFiles.filter((file) => file.path !== path); }
  async discardAll() { this.changedFiles = []; }
  async commitAll(draftId: string, message: string) { document.documentElement.dataset.committedPaths = JSON.stringify(this.changedFiles.map((file) => file.path).sort()); document.documentElement.dataset.commitMessage = message; this.changedFiles = []; const commit = "1".repeat(40); this.replace(draftId, { fingerprint: "2".repeat(64) }); return { commit, branch: `gitpm/42/${draftId}`, draft_fingerprint: "2".repeat(64) }; }
  async push(draftId: string) { document.documentElement.dataset.pushed = "true"; return { branch: `gitpm/42/${draftId}`, commit: "1".repeat(40) }; }
  async createMergeRequest(draftId: string, title: string, description?: string) { document.documentElement.dataset.mrPayload = JSON.stringify({ source_branch: `gitpm/42/${draftId}`, target_branch: "main", title, description }); this.mr = { iid: 17, state: "opened", web_url: "https://gitlab.example.test/group/project/-/merge_requests/17" }; this.replace(draftId, { state: "published", merge_request_iid: 17 }); return this.mr; }
  async pollMergeRequest() { this.mrPollCount += 1; document.documentElement.dataset.mrPollCount = String(this.mrPollCount); if (this.mr === undefined) throw new Error("merge request not created"); return this.mr; }
  async history() { const commit = "9".repeat(40); return [{ commit, parents: ["8".repeat(40)], author_name: "GitPM QA", author_email: "qa@example.test", authored_at: "2026-07-10T12:00:00.000Z", subject: "Merged task update", semantic_summary: { created: 0, updated: 1, deleted: 0, affected_projects: ["PRJ-ALPHA"] } }]; }
  async commitDetail(_draftId: string, commit: string) { return { ...(await this.history())[0]!, commit, body: "", files: [{ path: "projects/PRJ-ALPHA/tasks/TSK-HISTORY.yaml", additions: 1, deletions: 1 }], diff: "@@ -1 +1 @@\n-title: Before\n+title: After\n" }; }
  async fileHistory() { return await this.history(); }
  async createRevertDraft(_draftId: string, commit: string, newDraftId: string) { const draft = await this.createDraft(newDraftId); this.changedFiles = [{ path: "projects/PRJ-ALPHA/tasks/TSK-HISTORY.yaml", kind: "Modified", diff_token: "revert-token", diff: "@@ -1 +1 @@\n-title: After\n+title: Before\n", hunks: [{ old_start: 1, old_count: 1, new_start: 1, new_count: 1, lines: ["-title: After", "+title: Before"] }] }]; document.documentElement.dataset.revertedCommit = commit; return { draft, reverted_commit: commit, conflicted: false, conflicted_files: [] }; }
  private entityResult(document: GitPmDocument): EntityResult { const project = String(document.project ?? ""); const paths: Record<string, string> = { "gitpm/calendar@1": `calendars/${document.id}.yaml`, "gitpm/person@1": `people/${document.id}.yaml`, "gitpm/team@1": `teams/${document.id}.yaml`, "gitpm/saved-view@1": `projects/${project}/views/${document.id}.yaml` }; const path = document.schema === "gitpm/project@1" ? `projects/${document.id}/project.yaml` : document.schema === "gitpm/task@1" ? `projects/${project}/tasks/${document.id}.yaml` : document.schema === "gitpm/milestone@1" ? `projects/${project}/milestones/${document.id}.yaml` : paths[document.schema] ?? `${document.id}.yaml`; return { document, path, blob_id: "c".repeat(40), draft_fingerprint: "d".repeat(64) }; }
  private capture(path: string) { this.changedPaths.add(path); document.documentElement.dataset.gitDiff = JSON.stringify([...this.changedPaths].sort()); }
  private replace(draftId: string, values: Partial<DraftStatus>) {
    const current = this.drafts.find((draft) => draft.draft_id === draftId);
    if (current === undefined) throw new Error("draft not found");
    const next = { ...current, ...values, updated_at: new Date().toISOString() };
    this.drafts = [next]; return next;
  }
}

const root = document.querySelector<HTMLElement>("#app");
if (root !== null) { const requestedRole = new URLSearchParams(window.location.search).get("role"); const role = requestedRole === "Developer" ? "Developer" : "Maintainer"; createRoot(root).render(<App api={new BrowserAcceptanceApi(role)} confirmAction={() => true} />); }
