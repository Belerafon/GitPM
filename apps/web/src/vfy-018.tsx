import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import type { GitPmApi } from "./api.js";
import type { DraftSnapshot, DraftStatus, EntityResult, GitPmDocument, PublicSession, WriterMode } from "./types.js";
import "./styles.css";

const session: PublicSession = { user: { id: "42", username: "vfy-developer" }, role: "Maintainer", expires_at: "2026-07-10T18:00:00.000Z" };

class BrowserAcceptanceApi implements GitPmApi {
  private drafts: DraftStatus[] = [];
  private entities: EntityResult[] = [];
  private changedPaths = new Set<string>();
  private statusConfig: EntityResult | undefined;
  private issueTypeConfig: EntityResult | undefined;
  private pollCount = 0;
  constructor(private readonly role: PublicSession["role"] = "Maintainer") {}
  async session() { return { ...session, role: this.role }; }
  async login() { return "#"; }
  async logout() { /* acceptance fixture keeps its session */ }
  async listDrafts() { return this.drafts; }
  async createDraft(draftId: string) {
    const now = new Date().toISOString();
    const created: DraftStatus = { draft_id: draftId, owner_gitlab_user_id: "42", branch: `gitpm/42/${draftId}`, base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: now, updated_at: now };
    this.drafts = [created]; return created;
  }
  async snapshot(draftId: string): Promise<DraftSnapshot> {
    this.pollCount += 1;
    document.documentElement.dataset.pollCount = String(this.pollCount);
    const draft = this.drafts.find((item) => item.draft_id === draftId);
    if (draft === undefined) throw new Error("draft not found");
    return { draft, changes: { changed_files_count: this.changedPaths.size || 2 }, validation: { valid: true, error_count: 0, warning_count: 0, document_count: 14 + this.entities.length } };
  }
  async setWriterMode(draftId: string, writer_mode: WriterMode) { return this.replace(draftId, { writer_mode }); }
  async closeDraft(draftId: string) { return this.replace(draftId, { state: "closed" }); }
  async reopenDraft(draftId: string) { return this.replace(draftId, { state: "open" }); }
  async cleanupDraft(draftId: string) { this.drafts = this.drafts.filter((draft) => draft.draft_id !== draftId); }
  async listEntities(_draftId: string, entityType: string, project?: string) { const names: Record<string, string> = { people: "person", calendars: "calendar", teams: "team" }; const schema = `gitpm/${names[entityType] ?? entityType.slice(0, -1)}@1`; return this.entities.filter((item) => item.document.schema === schema && (project === undefined || item.document.project === project)); }
  async createEntity(_draftId: string, _entityType: string, _fingerprint: string, document: GitPmDocument): Promise<EntityResult> { const result = this.entityResult(document); this.entities.push(result); this.capture(result.path); return result; }
  async updateEntity(_draftId: string, _entityType: string, entity: EntityResult, _fingerprint: string, document: GitPmDocument): Promise<EntityResult> { const result = this.entityResult(document); this.entities = this.entities.map((item) => item.document.id === entity.document.id ? result : item); this.capture(result.path); return result; }
  async archiveEntity(draftId: string, entityType: string, entity: EntityResult, fingerprint: string): Promise<EntityResult> { return await this.updateEntity(draftId, entityType, entity, fingerprint, { ...entity.document, lifecycle: "archived" }); }
  async deleteEntity(_draftId: string, _entityType: string, entity: EntityResult) { this.entities = this.entities.filter((item) => item.document.id !== entity.document.id); this.capture(entity.path); }
  async getConfiguration(_draftId: string, kind: "statuses" | "issue-types"): Promise<EntityResult> { const existing = kind === "statuses" ? this.statusConfig : this.issueTypeConfig; if (existing !== undefined) return existing; const document = (kind === "statuses" ? { schema: "gitpm/statuses@1", id: "CONFIG-STATUSES", lifecycle: "active", statuses: [{ slug: "backlog", title: "Backlog", color: "gray", active: true }, { slug: "in-progress", title: "In progress", color: "blue", active: true }, { slug: "done", title: "Done", color: "green", active: true }] } : { schema: "gitpm/issue-types@1", id: "CONFIG-TYPES", lifecycle: "active", issue_types: [{ slug: "task", title: "Task", color: "blue", active: true }] }) as GitPmDocument; const created = { document, path: `.gitpm/${kind}.yaml`, blob_id: "e".repeat(40), draft_fingerprint: "d".repeat(64) }; if (kind === "statuses") this.statusConfig = created; else this.issueTypeConfig = created; return created; }
  async updateConfiguration(_draftId: string, kind: "statuses" | "issue-types", entity: EntityResult, _fingerprint: string, document: GitPmDocument): Promise<EntityResult> { const result = { ...entity, document, blob_id: "f".repeat(40), draft_fingerprint: "d".repeat(64) }; if (kind === "statuses") this.statusConfig = result; else this.issueTypeConfig = result; this.capture(result.path); return result; }
  private entityResult(document: GitPmDocument): EntityResult { const project = String(document.project ?? ""); const paths: Record<string, string> = { "gitpm/calendar@1": `calendars/${document.id}.yaml`, "gitpm/person@1": `people/${document.id}.yaml`, "gitpm/team@1": `teams/${document.id}.yaml` }; const path = document.schema === "gitpm/project@1" ? `projects/${document.id}/project.yaml` : document.schema === "gitpm/task@1" ? `projects/${project}/tasks/${document.id}.yaml` : document.schema === "gitpm/milestone@1" ? `projects/${project}/milestones/${document.id}.yaml` : paths[document.schema] ?? `${document.id}.yaml`; return { document, path, blob_id: "c".repeat(40), draft_fingerprint: "d".repeat(64) }; }
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
