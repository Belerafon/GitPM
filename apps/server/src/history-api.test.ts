import { describe, expect, it, vi } from "vitest";
import type { DraftManager, DraftMetadata } from "@gitpm/drafts";
import type { HistoryService } from "@gitpm/history";
import { buildApp } from "./app.js";

const metadata: DraftMetadata = { version: 1, draft_id: "DRF-HISTORY", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-HISTORY", base_commit: "a".repeat(40), worktree_path: "C:/private/worktree", writer_mode: "ui", state: "open", fingerprint: "f".repeat(64), created_at: "2026-07-10T12:00:00.000Z", updated_at: "2026-07-10T12:00:00.000Z" };

describe("history API", () => {
  it("returns detail and creates a public revert draft contract", async () => {
    const manager = { getDraft: vi.fn(async () => metadata) } as unknown as DraftManager;
    const commit = "a".repeat(40);
    const history = {
      list: vi.fn(async () => []),
      detail: vi.fn(async () => ({ commit, parents: [], author_name: "QA", author_email: "qa@example.test", authored_at: "2026-07-10T12:00:00.000Z", subject: "Change", body: "", files: [], diff: "", semantic_summary: { created: 0, updated: 0, deleted: 0, affected_projects: [] } })),
      fileHistory: vi.fn(async () => []),
      createRevertDraft: vi.fn(async () => ({ draft: { ...metadata, draft_id: "DRF-REVERT", branch: "gitpm/42/DRF-REVERT" }, reverted_commit: commit, conflicted: false, conflicted_files: [] })),
    } as unknown as HistoryService;
    const app = buildApp({ draftManager: manager, historyService: history, authenticate: () => ({ userId: "42", role: "Developer" }) });
    const detail = await app.inject({ method: "GET", url: `/api/drafts/DRF-HISTORY/history/${commit}` });
    expect(detail.statusCode).toBe(200);
    const reverted = await app.inject({ method: "POST", url: `/api/drafts/DRF-HISTORY/history/${commit}/revert`, payload: { draft_id: "DRF-REVERT" } });
    expect(reverted.statusCode).toBe(201);
    expect(reverted.body).not.toContain("worktree_path");
    expect(history.createRevertDraft).toHaveBeenCalledWith("DRF-HISTORY", commit, "DRF-REVERT", "42");
    await app.close();
  });
});
