// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { HistoryWorkspace } from "./history-ui.js";
import type { CommitHistoryDetail, CommitHistoryItem, DraftStatus } from "./types.js";

const commit = "a".repeat(40);
const item: CommitHistoryItem = { commit, parents: ["b".repeat(40)], author_name: "QA", author_email: "qa@example.test", authored_at: "2026-07-10T12:00:00.000Z", subject: "Merged task update", semantic_summary: { created: 0, updated: 1, deleted: 0, affected_projects: ["P-26-111111"] } };
const detail: CommitHistoryDetail = { ...item, body: "Accepted change", files: [{ path: "projects/P-26-111111/tasks/T-26-111111.yaml", additions: 1, deletions: 1 }], diff: "@@ -1 +1 @@\n-old\n+new\n" };
const draft: DraftStatus = { draft_id: "DRF-HISTORY", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-HISTORY", base_commit: commit, writer_mode: "ui", state: "open", fingerprint: "f".repeat(64), created_at: "2026-07-10T12:00:00.000Z", updated_at: "2026-07-10T12:00:00.000Z" };

afterEach(cleanup);
describe("History workspace", () => {
  it("restores a commit deep link and publishes later selections to navigation", async () => {
    const olderCommit = "c".repeat(40);
    const olderItem = { ...item, commit: olderCommit, subject: "Older change" };
    const onNavigate = vi.fn();
    const api = {
      history: async () => [item, olderItem],
      commitDetail: async (_draftId: string, selectedCommit: string) => ({ ...detail, ...(selectedCommit === olderCommit ? olderItem : item) }),
    } as unknown as GitPmApi;

    render(<HistoryWorkspace api={api} draft={draft} locale="en" canRevert={false} initialCommit={olderCommit} onNavigate={onNavigate} onDraftCreated={vi.fn(async () => undefined)} />);
    expect(await screen.findByRole("heading", { name: "Older change" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Merged task update/u }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("history", { commit }));
  });

  it("shows commit and file history and creates a separate revert draft without a rebase action", async () => {
    const createRevertDraft = vi.fn(async () => ({ draft: { ...draft, draft_id: "REVERT-AAAAAAAA", branch: "gitpm/42/REVERT-AAAAAAAA" }, reverted_commit: commit, conflicted: false, conflicted_files: [] }));
    const select = vi.fn(async () => undefined);
    const api = { history: async () => [item], commitDetail: async () => detail, fileHistory: async () => [item], createRevertDraft } as unknown as GitPmApi;
    render(<HistoryWorkspace api={api} draft={draft} locale="en" canRevert={true} onDraftCreated={select} />);
    expect(await screen.findByRole("heading", { name: "Merged task update" })).toBeTruthy();
    expect(screen.queryByText(/rebase/iu)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /projects\/P-26-111111\/tasks\/T-26-111111.yaml/u }));
    expect(await screen.findByRole("heading", { name: "File history" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create revert working copy" }));
    await waitFor(() => expect(createRevertDraft).toHaveBeenCalledWith("DRF-HISTORY", commit, "REVERT-AAAAAAAA"));
    expect(select).toHaveBeenCalledWith("REVERT-AAAAAAAA");
  });
});
