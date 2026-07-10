import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import type { GitPmApi } from "./api.js";
import type { DraftSnapshot, DraftStatus, PublicSession, WriterMode } from "./types.js";
import "./styles.css";

const session: PublicSession = { user: { id: "42", username: "vfy-developer" }, role: "Maintainer", expires_at: "2026-07-10T18:00:00.000Z" };

class BrowserAcceptanceApi implements GitPmApi {
  private drafts: DraftStatus[] = [];
  private pollCount = 0;
  async session() { return session; }
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
    return { draft, changes: { changed_files_count: 2 }, validation: { valid: true, error_count: 0, warning_count: 0, document_count: 14 } };
  }
  async setWriterMode(draftId: string, writer_mode: WriterMode) { return this.replace(draftId, { writer_mode }); }
  async closeDraft(draftId: string) { return this.replace(draftId, { state: "closed" }); }
  async reopenDraft(draftId: string) { return this.replace(draftId, { state: "open" }); }
  async cleanupDraft(draftId: string) { this.drafts = this.drafts.filter((draft) => draft.draft_id !== draftId); }
  private replace(draftId: string, values: Partial<DraftStatus>) {
    const current = this.drafts.find((draft) => draft.draft_id === draftId);
    if (current === undefined) throw new Error("draft not found");
    const next = { ...current, ...values, updated_at: new Date().toISOString() };
    this.drafts = [next]; return next;
  }
}

const root = document.querySelector<HTMLElement>("#app");
if (root !== null) createRoot(root).render(<App api={new BrowserAcceptanceApi()} confirmAction={() => true} />);
