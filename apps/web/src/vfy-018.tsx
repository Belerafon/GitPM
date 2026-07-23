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
  private externalFingerprint: string | undefined;
  constructor(private readonly role: PublicSession["role"] = "Maintainer") {}
  async session() { return { ...session, role: this.role }; }
  async login() { return "#"; }
  async logout() { /* acceptance fixture keeps its session */ }
  async repositoryConnection() { return { repository_path: "D:/portfolio", repository_mode: "worktree" as const, default_branch: "main", remote_source: "none" as const, remote_editable: true, gitlab_editable: true, gitlab: { configured: false } }; }
  async updateRepositoryConnection() { return await this.repositoryConnection(); }
  async testRepositoryConnection() { return { ok: true as const, branch: "main", commit: "a".repeat(40) }; }
  async listDrafts() { return this.drafts; }
  async createDraft(draftId: string) {
    const now = new Date().toISOString();
    const created: DraftStatus = { draft_id: draftId, owner_gitlab_user_id: "42", branch: `gitpm/42/${draftId}`, base_commit: "a".repeat(40), writer_mode: window.location.pathname.endsWith("vfy-029.html") ? "external" : "ui", state: "open", fingerprint: "b".repeat(64), external_fingerprint: "b".repeat(64), created_at: now, updated_at: now };
    this.drafts = [created];
    this.changedFiles = [
      { path: "projects/P-26-A1PHA1/project.yaml", kind: "Modified", diff_token: "mod-token", diff: "@@ -2,2 +2,2 @@\n-name: Alpha\n+name: Alpha launch\n lifecycle: active\n", hunks: [{ old_start: 2, old_count: 2, new_start: 2, new_count: 2, lines: ["-name: Alpha", "+name: Alpha launch", " lifecycle: active"] }] },
      { path: "projects/P-26-A1PHA1/tasks/T-26-DE1ETE.yaml", kind: "Deleted", diff_token: "delete-token", diff: "@@ -1,2 +0,0 @@\n-schema: gitpm/task@1\n-id: T-26-DE1ETE\n", hunks: [{ old_start: 1, old_count: 2, new_start: 0, new_count: 0, lines: ["-schema: gitpm/task@1", "-id: T-26-DE1ETE"] }] },
      { path: "projects/P-26-A1PHA1/tasks/T-26-CREATD.yaml", kind: "Added", diff_token: "add-token", diff: "@@ -0,0 +1,2 @@\n+schema: gitpm/task@1\n+id: T-26-CREATD\n", hunks: [{ old_start: 0, old_count: 0, new_start: 1, new_count: 2, lines: ["+schema: gitpm/task@1", "+id: T-26-CREATD"] }] },
      { path: "projects/P-26-A1PHA1/tasks/T-26-ARCH1V.yaml", kind: "Modified", diff_token: "archive-token", diff: "@@ -6,1 +6,1 @@\n-lifecycle: active\n+lifecycle: archived\n", hunks: [{ old_start: 6, old_count: 1, new_start: 6, new_count: 1, lines: ["-lifecycle: active", "+lifecycle: archived"] }] },
    ];
    if (window.location.pathname.endsWith("vfy-026.html")) {
      const project = "P-26-111111";
      this.entities = [
        this.entityResult({ schema: "gitpm/project@1", id: project, name: "Beta portfolio", status: "backlog", lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/task@1", id: "T-26-222222", project, title: "Prepare beta", type: "task", status: "backlog", lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/task@1", id: "T-26-333333", project, title: "Review Board", type: "task", status: "in-progress", lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/task@1", id: "T-26-444444", project, title: "Alpha accepted", type: "task", status: "done", lifecycle: "active" }),
      ];
      this.changedFiles = [];
    }
    if (window.location.pathname.endsWith("vfy-027.html")) {
      const project = "P-26-111111"; const milestone = "M-26-888888";
      const ids = ["2", "3", "4", "5", "6"].map((value) => `T-26-${value.repeat(6)}`);
      this.entities = [
        this.entityResult({ schema: "gitpm/project@1", id: project, name: "Beta portfolio", status: "backlog", lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/milestone@1", id: milestone, project, name: "Beta release", due: "2026-07-08", lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/task@1", id: ids[0]!, project, title: "Plan release", type: "task", status: "done", lifecycle: "active", start: "2026-07-01", due: "2026-07-05" }),
        this.entityResult({ schema: "gitpm/task@1", id: ids[1]!, project, title: "Build API", type: "task", status: "done", lifecycle: "active", start: "2026-07-02", due: "2026-07-03", parent: ids[0], milestone }),
        this.entityResult({ schema: "gitpm/task@1", id: ids[2]!, project, title: "Ship UI", type: "task", status: "in-progress", lifecycle: "active", start: "2026-07-04", due: "2026-07-06", depends_on: [ids[1]!] }),
        this.entityResult({ schema: "gitpm/task@1", id: ids[3]!, project, title: "Review", type: "task", status: "backlog", lifecycle: "active", start: "2026-07-06", due: "2026-07-07", depends_on: [ids[2]!] }),
        this.entityResult({ schema: "gitpm/task@1", id: ids[4]!, project, title: "Launch", type: "task", status: "backlog", lifecycle: "active", start: "2026-07-08", due: "2026-07-08", depends_on: [ids[3]!] }),
        this.entityResult({ schema: "gitpm/task@1", id: "T-26-777777", project, title: "Undated hidden", type: "task", status: "backlog", lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/task@1", id: "T-26-999999", project, title: "Archived hidden", type: "task", status: "done", lifecycle: "archived", start: "2026-07-01", due: "2026-07-02" }),
      ];
      this.changedFiles = [];
    }
    if (window.location.pathname.endsWith("vfy-028.html") || window.location.pathname.endsWith("vfy-032.html")) {
      const project = "P-26-111111"; const calendar = "C-26-444444"; const ada = "U-26-222222"; const linus = "U-26-333333";
      this.entities = [
        this.entityResult({ schema: "gitpm/project@1", id: project, name: "Beta portfolio", status: "backlog", lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/calendar@1", id: calendar, name: "Engineering", working_weekdays: [1, 2, 3, 4, 5], holidays: ["2026-07-08"], lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/person@1", id: ada, name: "Ada", weekly_capacity_hours: 40, calendar, lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/person@1", id: linus, name: "Linus", weekly_capacity_hours: 32, calendar, lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/task@1", id: "T-26-555555", project, title: "Shared delivery", type: "task", status: "in-progress", lifecycle: "active", estimate_hours: 40, start: "2026-07-06", due: "2026-07-10", assignees: [ada, linus] }),
        this.entityResult({ schema: "gitpm/task@1", id: "T-26-666666", project, title: "Ada follow-up", type: "task", status: "backlog", lifecycle: "active", estimate_hours: 30, start: "2026-07-09", due: "2026-07-15", assignees: [ada] }),
        this.entityResult({ schema: "gitpm/task@1", id: "T-26-777777", project, title: "Undated excluded", type: "task", status: "backlog", lifecycle: "active", estimate_hours: 10, assignees: [ada] }),
        this.entityResult({ schema: "gitpm/task@1", id: "T-26-888888", project, title: "Archived excluded", type: "task", status: "done", lifecycle: "archived", estimate_hours: 10, start: "2026-07-06", due: "2026-07-10", assignees: [ada] }),
      ];
      this.changedFiles = [];
    }
    if (window.location.pathname.endsWith("vfy-029.html")) {
      const project = "P-26-111111"; const task = "T-26-222222";
      this.entities = [
        this.entityResult({ schema: "gitpm/project@1", id: project, name: "Agent portfolio", status: "backlog", lifecycle: "active" }),
        this.entityResult({ schema: "gitpm/task@1", id: task, project, title: "Before agent write", type: "task", status: "backlog", lifecycle: "active", description_markdown: "Initial value" }),
      ];
      this.externalFingerprint = "b".repeat(64); this.changedFiles = [];
    }
    return created;
  }
  async snapshot(draftId: string): Promise<DraftSnapshot> {
    this.pollCount += 1;
    document.documentElement.dataset.pollCount = String(this.pollCount);
    if (window.location.pathname.endsWith("vfy-029.html") && this.pollCount === 2) {
      const current = this.entities.find((item) => item.document.schema === "gitpm/task@1");
      if (current !== undefined) {
        const first = this.entityResult({ ...current.document, title: "Agent write one", status: "in-progress" });
        const second = this.entityResult({ ...first.document, title: "Agent write two", description_markdown: "Two quick writes coalesced" });
        this.entities = this.entities.map((item) => item.document.id === current.document.id ? second : item);
        this.externalFingerprint = "e".repeat(64); document.documentElement.dataset.agentWrites = "2";
      }
    }
    const draft = this.drafts.find((item) => item.draft_id === draftId);
    if (draft === undefined) throw new Error("draft not found");
    const localizationAcceptance = window.location.pathname.endsWith("vfy-032.html");
    return { draft: { ...draft, ...(this.externalFingerprint === undefined ? {} : { external_fingerprint: this.externalFingerprint, changed_externally: this.externalFingerprint !== draft.fingerprint }) }, changes: { changed_files_count: this.changedFiles.length + this.changedPaths.size }, validation: { valid: !localizationAcceptance, error_count: localizationAcceptance ? 2 : 0, warning_count: 0, document_count: 14 + this.entities.length }, ...(this.mr === undefined ? {} : { mergeRequest: this.mr }) };
  }
  async setWriterMode(draftId: string, writer_mode: WriterMode) { return this.replace(draftId, { writer_mode }); }
  async acknowledgeExternalChanges(draftId: string) { return this.replace(draftId, { changed_externally: false, external_fingerprint: undefined }); }
  async closeDraft(draftId: string) { return this.replace(draftId, { state: "closed" }); }
  async reopenDraft(draftId: string) { return this.replace(draftId, { state: "open" }); }
  async cleanupDraft(draftId: string) { this.drafts = this.drafts.filter((draft) => draft.draft_id !== draftId); }
  async listEntities(_draftId: string, entityType: string, project?: string) { const names: Record<string, string> = { people: "person", calendars: "calendar", teams: "team", views: "saved-view" }; const schema = `gitpm/${names[entityType] ?? entityType.slice(0, -1)}@1`; return this.entities.filter((item) => item.document.schema === schema && (project === undefined || item.document.project === project)); }
  async projectWorkspace(draftId: string, projectId: string) { const project = (await this.listEntities(draftId, "projects")).find((item) => item.document.id === projectId); if (project === undefined) throw new Error("project not found"); return { project, milestones: await this.listEntities(draftId, "milestones", projectId), tasks: await this.listEntities(draftId, "tasks", projectId), draft_fingerprint: project.draft_fingerprint }; }
  async createEntity(_draftId: string, _entityType: string, _fingerprint: string, document: GitPmDocument): Promise<EntityResult> { const result = this.entityResult(document); this.entities.push(result); this.capture(result.path); return result; }
  async updateEntity(_draftId: string, _entityType: string, entity: EntityResult, _fingerprint: string, document: GitPmDocument): Promise<EntityResult> { const result = this.entityResult(document); this.entities = this.entities.map((item) => item.document.id === entity.document.id ? result : item); this.capture(result.path); return result; }
  async moveTask(_draftId: string, entity: EntityResult, _fingerprint: string, targetProject: string, targetMilestone?: string): Promise<EntityResult> { const document = { ...entity.document, project: targetProject, milestone: targetMilestone }; const result = this.entityResult(document); this.entities = this.entities.map((item) => item.document.id === entity.document.id ? result : item); this.capture(entity.path); this.capture(result.path); return result; }
  async archiveEntity(draftId: string, entityType: string, entity: EntityResult, fingerprint: string): Promise<EntityResult> { return await this.updateEntity(draftId, entityType, entity, fingerprint, { ...entity.document, lifecycle: "archived" }); }
  async deleteEntity(_draftId: string, _entityType: string, entity: EntityResult) { this.entities = this.entities.filter((item) => item.document.id !== entity.document.id); this.capture(entity.path); }
  async getConfiguration(_draftId: string, kind: "statuses" | "issue-types"): Promise<EntityResult> { const existing = kind === "statuses" ? this.statusConfig : this.issueTypeConfig; if (existing !== undefined) return existing; const document = (kind === "statuses" ? { schema: "gitpm/statuses@1", id: "CONFIG-STATUSES", lifecycle: "active", statuses: [{ slug: "backlog", title: "Backlog", color: "gray", active: true }, { slug: "in-progress", title: "In progress", color: "blue", active: true }, { slug: "done", title: "Done", color: "green", active: true }] } : { schema: "gitpm/issue-types@1", id: "CONFIG-TYPES", lifecycle: "active", issue_types: [{ slug: "task", title: "Task", color: "blue", active: true }] }) as GitPmDocument; const created = { document, path: `.gitpm/${kind}.yaml`, blob_id: "e".repeat(40), draft_fingerprint: "d".repeat(64) }; if (kind === "statuses") this.statusConfig = created; else this.issueTypeConfig = created; return created; }
  async updateConfiguration(_draftId: string, kind: "statuses" | "issue-types", entity: EntityResult, _fingerprint: string, document: GitPmDocument): Promise<EntityResult> { const result = { ...entity, document, blob_id: "f".repeat(40), draft_fingerprint: "d".repeat(64) }; if (kind === "statuses") this.statusConfig = result; else this.issueTypeConfig = result; this.capture(result.path); return result; }
  async listChanges(): Promise<ChangesList> { if (new URLSearchParams(window.location.search).get("git_error") === "1") throw new Error("Git diff недоступен: рабочее дерево изменилось"); return { files: this.changedFiles, changed_files_count: this.changedFiles.length, affected_projects: this.changedFiles.length === 0 ? [] : ["P-26-A1PHA1"] }; }
  async listWorktree(_draftId: string, path?: string) {
    const current = path ?? "";
    if (current === "docs") return { path: current, entries: [{ name: "architecture.md", path: "docs/architecture.md", type: "file" as const, size: 18432 }, { name: "release-notes.md", path: "docs/release-notes.md", type: "file" as const, size: 7680 }] };
    return { path: current, entries: [
      { name: "docs", path: "docs", type: "directory" as const },
      { name: "projects", path: "projects", type: "directory" as const },
      { name: "uploads", path: "uploads", type: "directory" as const },
      { name: "AGENTS.md", path: "AGENTS.md", type: "file" as const, size: 4260 },
      { name: "README.md", path: "README.md", type: "file" as const, size: 2194 },
      { name: "portfolio-with-a-very-long-name.yaml", path: "portfolio-with-a-very-long-name.yaml", type: "file" as const, size: 128640 },
    ] };
  }
  async readWorktreeFile(_draftId: string, path: string) { return { path, size: 2194, content: `# ${path}\n\nGitPM working-copy preview.\n\nThis fixture intentionally includes long file names and mixed entry sizes for responsive UI checks.` }; }
  async deleteWorktreeEntry(): Promise<string> { return "f".repeat(64); }
  async createWorktreeDirectory(): Promise<string> { return "f".repeat(64); }
  async uploadWorktreeFile(): Promise<string> { return "f".repeat(64); }
  async moveWorktreeEntry(): Promise<string> { return "f".repeat(64); }
  async semanticChanges(): Promise<SemanticDiff> {
    const paths = new Set(this.changedFiles.map((file) => file.path));
    const item = (id: string, path: string, field: string, before: unknown, after: unknown) => ({ id, path, schema: id === "P-26-A1PHA1" ? "gitpm/project@1" : "gitpm/task@1", project: "P-26-A1PHA1", fields: [{ field, before, after }] });
    const created = paths.has("projects/P-26-A1PHA1/tasks/T-26-CREATD.yaml") ? [item("T-26-CREATD", "projects/P-26-A1PHA1/tasks/T-26-CREATD.yaml", "title", undefined, "Created task")] : [];
    const updated = paths.has("projects/P-26-A1PHA1/project.yaml") ? [item("P-26-A1PHA1", "projects/P-26-A1PHA1/project.yaml", "name", "Alpha", "Alpha launch")] : [];
    const archived = paths.has("projects/P-26-A1PHA1/tasks/T-26-ARCH1V.yaml") ? [item("T-26-ARCH1V", "projects/P-26-A1PHA1/tasks/T-26-ARCH1V.yaml", "lifecycle", "active", "archived")] : [];
    const deleted = paths.has("projects/P-26-A1PHA1/tasks/T-26-DE1ETE.yaml") ? [item("T-26-DE1ETE", "projects/P-26-A1PHA1/tasks/T-26-DE1ETE.yaml", "title", "Deleted task", undefined)] : [];
    return { created, updated, archived, deleted, counts: { created: created.length, updated: updated.length, archived: archived.length, deleted: deleted.length }, affected_projects: this.changedFiles.length === 0 ? [] : ["P-26-A1PHA1"], unclassified_files: [] };
  }
  async restoreFile(_draftId: string, _fingerprint: string, path: string) { document.documentElement.dataset.restoredFile = path; if (path.includes("T-26-DE1ETE")) { document.documentElement.dataset.redeletedFile = path; return; } this.changedFiles = this.changedFiles.filter((file) => file.path !== path); }
  async restoreHunk(_draftId: string, _fingerprint: string, path: string) { document.documentElement.dataset.restoredHunk = path; this.changedFiles = this.changedFiles.filter((file) => file.path !== path); }
  async discardAll() { this.changedFiles = []; }
  async commitAll(draftId: string, message: string) { document.documentElement.dataset.committedPaths = JSON.stringify(this.changedFiles.map((file) => file.path).sort()); document.documentElement.dataset.commitMessage = message; this.changedFiles = []; const commit = "1".repeat(40); this.replace(draftId, { fingerprint: "2".repeat(64) }); return { commit, branch: `gitpm/42/${draftId}`, draft_fingerprint: "2".repeat(64) }; }
  async push(draftId: string) { document.documentElement.dataset.pushed = "true"; return { branch: `gitpm/42/${draftId}`, commit: "1".repeat(40) }; }
  async createMergeRequest(draftId: string, title: string, description?: string) { document.documentElement.dataset.mrPayload = JSON.stringify({ source_branch: `gitpm/42/${draftId}`, target_branch: "main", title, description }); this.mr = { iid: 17, state: "opened", web_url: "https://gitlab.example.test/group/project/-/merge_requests/17" }; this.replace(draftId, { state: "published", merge_request_iid: 17 }); return this.mr; }
  async pollMergeRequest() { this.mrPollCount += 1; document.documentElement.dataset.mrPollCount = String(this.mrPollCount); if (this.mr === undefined) throw new Error("merge request not created"); return this.mr; }
  async history() { const commit = "9".repeat(40); return [{ commit, parents: ["8".repeat(40)], author_name: "GitPM QA", author_email: "qa@example.test", authored_at: "2026-07-10T12:00:00.000Z", subject: "Merged task update", semantic_summary: { created: 0, updated: 1, deleted: 0, affected_projects: ["P-26-A1PHA1"] } }]; }
  async commitDetail(_draftId: string, commit: string) { return { ...(await this.history())[0]!, commit, body: "", files: [{ path: "projects/P-26-A1PHA1/tasks/T-26-H1ST0R.yaml", status: "Modified" as const, additions: 1, deletions: 1 }] }; }
  async commitFileDiff() { return { diff: "@@ -1 +1 @@\n-title: Before\n+title: After\n", oversized: false }; }
  async fileHistory() { return await this.history(); }
  async createRevertDraft(_draftId: string, commit: string, newDraftId: string) { const draft = await this.createDraft(newDraftId); this.changedFiles = [{ path: "projects/P-26-A1PHA1/tasks/T-26-H1ST0R.yaml", kind: "Modified", diff_token: "revert-token", diff: "@@ -1 +1 @@\n-title: After\n+title: Before\n", hunks: [{ old_start: 1, old_count: 1, new_start: 1, new_count: 1, lines: ["-title: After", "+title: Before"] }] }]; document.documentElement.dataset.revertedCommit = commit; return { draft, reverted_commit: commit, conflicted: false, conflicted_files: [] }; }
  async listComments() { return []; }
  async createComment(): Promise<never> { throw new Error("not used in acceptance fixture"); }
  async updateComment(): Promise<never> { throw new Error("not used in acceptance fixture"); }
  async deleteComment(): Promise<never> { throw new Error("not used in acceptance fixture"); }
  async notifications() { return { items: [] }; }
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
