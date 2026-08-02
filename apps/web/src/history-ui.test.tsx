// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { HistoryWorkspace } from "./history-ui.js";
import type { CommitFileDiff, CommitHistoryDetail, CommitHistoryItem, DraftStatus } from "./types.js";

const commit = "a".repeat(40);
const item: CommitHistoryItem = { commit, parents: ["b".repeat(40)], author_name: "QA", author_email: "qa@example.test", authored_at: "2026-07-10T12:00:00.000Z", subject: "Merged task update", semantic_summary: { created: 0, updated: 1, deleted: 0, affected_projects: ["P-26-111111"] } };
const detail: CommitHistoryDetail = { ...item, body: "Accepted change", files: [{ path: "projects/P-26-111111/tasks/T-26-111111.yaml", status: "Modified", additions: 1, deletions: 1 }] };
const draft: DraftStatus = { draft_id: "DRF-HISTORY", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-HISTORY", base_commit: commit, writer_mode: "ui", state: "open", fingerprint: "f".repeat(64), created_at: "2026-07-10T12:00:00.000Z", updated_at: "2026-07-10T12:00:00.000Z" };

afterEach(cleanup);
describe("History workspace", () => {
  it("restores a commit deep link and publishes later selections to navigation", async () => {
    const olderCommit = "c".repeat(40);
    const lookedUpCommit = "d".repeat(40);
    const olderItem = { ...item, commit: olderCommit, subject: "Older change", author_name: "Dev", authored_at: "2026-07-09T12:00:00.000Z", semantic_summary: { ...item.semantic_summary, affected_projects: ["P-26-222222"] } };
    const lookedUpItem = { ...olderItem, commit: lookedUpCommit, subject: "Deep history change" };
    const onNavigate = vi.fn();
    const api = {
      history: async () => [item],
      commitDetail: async (_draftId: string, selectedCommit: string) => ({ ...detail, ...(selectedCommit === olderCommit ? olderItem : selectedCommit === lookedUpCommit ? lookedUpItem : item) }),
      commitFileDiff: async (): Promise<CommitFileDiff> => ({ diff: "", oversized: false }),
    } as unknown as GitPmApi;

    render(<HistoryWorkspace api={api} draft={draft} locale="en" canRevert={false} initialCommit={olderCommit} onNavigate={onNavigate} onDraftCreated={vi.fn(async () => undefined)} />);
    expect(await screen.findByRole("heading", { name: "Older change" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Author"), { target: { value: "Dev" } });
    expect(screen.queryByRole("button", { name: /Merged task update/u })).toBeNull();
    fireEvent.change(screen.getByLabelText("Author"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Affected project"), { target: { value: "P-26-111111" } });
    expect(screen.queryByRole("button", { name: /Older change/u })).toBeNull();
    fireEvent.change(screen.getByLabelText("Affected project"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-07-10" } });

    fireEvent.click(screen.getByRole("button", { name: /Merged task update/u }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("history", { commit }));

    fireEvent.change(screen.getByLabelText("Commit SHA"), { target: { value: lookedUpCommit } });
    fireEvent.click(screen.getByRole("button", { name: "Open commit" }));
    expect(await screen.findByRole("heading", { name: "Deep history change" })).toBeTruthy();
    expect(onNavigate).toHaveBeenCalledWith("history", { commit: lookedUpCommit });
  });

  it("shows the selected file diff and file history and creates a separate revert draft without a rebase action", async () => {
    const createRevertDraft = vi.fn(async () => ({ draft: { ...draft, draft_id: "REVERT-AAAAAAAA", branch: "gitpm/42/REVERT-AAAAAAAA" }, reverted_commit: commit, conflicted: false, conflicted_files: [] }));
    const select = vi.fn(async () => undefined);
    const api = { history: async () => [item], commitDetail: async () => detail, commitFileDiff: async () => ({ diff: "@@ -1 +1 @@\n-old\n+new\n", oversized: false }), fileHistory: async () => [item], createRevertDraft } as unknown as GitPmApi;
    render(<HistoryWorkspace api={api} draft={draft} locale="en" canRevert={true} onDraftCreated={select} />);
    expect(await screen.findByRole("heading", { name: "Merged task update" })).toBeTruthy();
    expect(screen.queryByText(/rebase/iu)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /projects\/P-26-111111\/tasks\/T-26-111111.yaml/u }));
    expect(await screen.findByRole("heading", { name: "File history" })).toBeTruthy();
    expect(await screen.findByText("-old")).toBeTruthy();
    expect(screen.getByText("+new")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create revert working copy" }));
    await waitFor(() => expect(createRevertDraft).toHaveBeenCalledWith("DRF-HISTORY", commit, "REVERT-AAAAAAAA"));
    expect(select).toHaveBeenCalledWith("REVERT-AAAAAAAA");
  });

  it("restores historical files and creates a reverse commit in direct mode", async () => {
    const restoreCommitFiles = vi.fn(async () => ({ restored_commit: commit, restored_paths: [detail.files[0]!.path], draft_fingerprint: "e".repeat(64) }));
    const revertDirect = vi.fn(async () => ({ commit: "d".repeat(40), reverted_commit: commit, branch: "main", draft_fingerprint: "e".repeat(64) }));
    const onNavigate = vi.fn();
    const onChanged = vi.fn(async () => undefined);
    const confirmAction = vi.fn(() => true);
    const api = { history: async () => [item], commitDetail: async () => detail, commitFileDiff: async () => ({ diff: "", oversized: false }), restoreCommitFiles, revertDirect } as unknown as GitPmApi;
    render(<HistoryWorkspace api={api} confirmAction={confirmAction} directMode draft={draft} locale="en" canRevert onChanged={onChanged} onNavigate={onNavigate} />);
    expect(await screen.findByRole("heading", { name: "Merged task update" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Restore selected file" }));
    await waitFor(() => expect(restoreCommitFiles).toHaveBeenCalledWith("DRF-HISTORY", commit, draft.fingerprint, [detail.files[0]!.path]));
    expect(onNavigate).toHaveBeenCalledWith("changes");

    fireEvent.change(screen.getByLabelText("Reverse commit message"), { target: { value: "Reverse merged task update" } });
    fireEvent.click(screen.getByRole("button", { name: "Create reverse commit" }));
    await waitFor(() => expect(revertDirect).toHaveBeenCalledWith("DRF-HISTORY", commit, draft.fingerprint, "Reverse merged task update"));
    expect(onNavigate).toHaveBeenCalledWith("history", { commit: "d".repeat(40) });
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("keeps long file lists in the file pane and filters them on demand", async () => {
    const files = Array.from({ length: 11 }, (_, index) => ({ path: `projects/P-26-111111/tasks/T-${String(index).padStart(2, "0")}.yaml`, status: "Added" as const, additions: 1, deletions: 0 }));
    const api = { history: async () => [item], commitDetail: async () => ({ ...detail, files }), commitFileDiff: async () => ({ diff: "", oversized: false }) } as unknown as GitPmApi;
    render(<HistoryWorkspace api={api} draft={draft} locale="en" canRevert={false} onDraftCreated={vi.fn(async () => undefined)} />);
    expect(await screen.findByText("Changed files: 11")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search changed files"), { target: { value: "T-07" } });
    expect(screen.getByRole("button", { name: /T-07\.yaml/u })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /T-06\.yaml/u })).toBeNull();
  });

  it("loads each file's diff on demand from the per-file endpoint", async () => {
    const firstPath = "projects/P-26-111111/project.yaml";
    const secondPath = "projects/P-26-111111/tasks/T-26-222222.yaml";
    const files = [{ path: firstPath, status: "Modified" as const, additions: 1, deletions: 1 }, { path: secondPath, status: "Modified" as const, additions: 1, deletions: 1 }];
    const diffs = new Map<string, string>([
      [firstPath, "@@ -1 +1 @@\n-old project\n+new project\n"],
      [secondPath, "@@ -3 +3 @@\n-old task\n+new task\n"],
    ]);
    const api = {
      history: async () => [item],
      commitDetail: async () => ({ ...detail, files }),
      commitFileDiff: async (_draftId: string, _commit: string, path: string): Promise<CommitFileDiff> => ({ diff: diffs.get(path) ?? "", oversized: false }),
      fileHistory: async () => [],
    } as unknown as GitPmApi;
    render(<HistoryWorkspace api={api} draft={draft} locale="en" canRevert={false} onDraftCreated={vi.fn(async () => undefined)} />);

    expect(await screen.findByText("-old project")).toBeTruthy();
    expect(screen.queryByText("-old task")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(secondPath.replaceAll("/", "\\/"), "u") }));
    expect(await screen.findByText("-old task")).toBeTruthy();
    expect(screen.queryByText("-old project")).toBeNull();
  });

  it("shows a too-large notice instead of a diff when a single file exceeds the output limit", async () => {
    const api = {
      history: async () => [item],
      commitDetail: async () => detail,
      commitFileDiff: async (): Promise<CommitFileDiff> => ({ diff: "", oversized: true }),
      fileHistory: async () => [],
    } as unknown as GitPmApi;
    render(<HistoryWorkspace api={api} draft={draft} locale="en" canRevert={false} onDraftCreated={vi.fn(async () => undefined)} />);
    expect(await screen.findByText(/too large to display/iu)).toBeTruthy();
    expect(screen.queryByText("-old")).toBeNull();
  });
});
