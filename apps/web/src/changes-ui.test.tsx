// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { ChangesWorkspace, safeExternalUrl } from "./changes-ui.js";
import type { ChangesList, DraftStatus, SemanticDiff } from "./types.js";

const draft: DraftStatus = { draft_id: "DRF-CHANGES", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-CHANGES", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-10T10:00:00Z", updated_at: "2026-07-10T10:00:00Z" };

class ChangesApi {
  committed = false;
  restored: string[] = [];
  changes: ChangesList = { changed_files_count: 3, affected_projects: ["P-26-111111"], files: [
    { path: "projects/P-26-111111/project.yaml", kind: "Modified", diff_token: "one", diff: "@@ -1,1 +1,1 @@\n-old\n+new\n", hunks: [{ old_start: 1, old_count: 1, new_start: 1, new_count: 1, lines: ["-old", "+new"] }] },
    { path: "projects/P-26-111111/tasks/T-26-111111.yaml", kind: "Added", diff_token: "two", diff: "@@ -0,0 +1,1 @@\n+new\n", hunks: [{ old_start: 0, old_count: 0, new_start: 1, new_count: 1, lines: ["+new"] }] },
    { path: "projects/P-26-111111/tasks/T-26-222222.yaml", kind: "Deleted", diff_token: "three", diff: "@@ -1,1 +0,0 @@\n-old\n", hunks: [{ old_start: 1, old_count: 1, new_start: 0, new_count: 0, lines: ["-old"] }] },
  ] };
  semantic: SemanticDiff = {
    created: [{ id: "T-26-111111", path: "projects/P-26-111111/tasks/T-26-111111.yaml", schema: "gitpm/task@1", project: "P-26-111111", fields: [{ field: "title", after: "New" }] }],
    updated: [{ id: "P-26-111111", path: "projects/P-26-111111/project.yaml", schema: "gitpm/project@1", project: "P-26-111111", fields: [{ field: "name", before: "Old", after: "New" }] }],
    archived: [], deleted: [{ id: "T-26-222222", path: "projects/P-26-111111/tasks/T-26-222222.yaml", schema: "gitpm/task@1", project: "P-26-111111", fields: [{ field: "title", before: "Old" }] }],
    counts: { created: 1, updated: 1, archived: 0, deleted: 1 }, affected_projects: ["P-26-111111"], unclassified_files: [],
  };
  listChanges = vi.fn(async () => this.committed ? { changed_files_count: 0, affected_projects: [], files: [] } : this.changes);
  semanticChanges = vi.fn(async () => this.committed ? { created: [], updated: [], archived: [], deleted: [], counts: { created: 0, updated: 0, archived: 0, deleted: 0 }, affected_projects: [], unclassified_files: [] } : this.semantic);
  restoreFile = vi.fn(async (_draftId: string, _fingerprint: string, path: string) => { this.restored.push(path); });
  restoreHunk = vi.fn(async (_draftId: string, _fingerprint: string, path: string) => { this.restored.push(path); });
  discardAll = vi.fn(async () => undefined);
  commitAll = vi.fn(async () => { this.committed = true; return { commit: "c".repeat(40), branch: draft.branch, draft_fingerprint: "d".repeat(64) }; });
  push = vi.fn(async () => ({ branch: draft.branch, commit: "c".repeat(40) }));
  createMergeRequest = vi.fn(async () => ({ iid: 7, state: "opened" as const, web_url: "https://gitlab.example.test/mr/7" }));
  pollMergeRequest = vi.fn(async () => ({ iid: 7, state: "opened" as const, web_url: "https://gitlab.example.test/mr/7" }));
}

afterEach(cleanup);

describe("Changes workspace", () => {
  it("allows only credential-free HTTPS links for untrusted Merge Request metadata", () => {
    expect(safeExternalUrl("https://gitlab.example.test/group/project/-/merge_requests/7")).toBe("https://gitlab.example.test/group/project/-/merge_requests/7");
    expect(safeExternalUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeExternalUrl("https://token@gitlab.example.test/mr/7")).toBeUndefined();
  });

  it("shows only Git change categories, an exact diff, restore controls and semantic before/after values", async () => {
    const fixture = new ChangesApi();
    render(<ChangesWorkspace api={fixture as unknown as GitPmApi} draft={draft} role="Developer" locale="en" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} />);
    expect((await screen.findAllByText("projects/P-26-111111/project.yaml")).length).toBeGreaterThan(0);
    expect(screen.getByText("Added")).toBeTruthy(); expect(screen.getAllByText("Modified").length).toBeGreaterThan(0); expect(screen.getAllByText("Deleted").length).toBeGreaterThan(0);
    expect(screen.getByText("-old")).toBeTruthy(); expect(screen.getByText("+new")).toBeTruthy();
    expect(screen.getAllByText("Old").length).toBeGreaterThan(0); expect(screen.getAllByText("New").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Restore hunk" }));
    await waitFor(() => expect(fixture.restoreHunk).toHaveBeenCalledWith("DRF-CHANGES", draft.fingerprint, "projects/P-26-111111/project.yaml", "one", 0));
  });

  it("shows a localized notice instead of the diff for an oversized change", async () => {
    const fixture = new ChangesApi();
    fixture.changes = { changed_files_count: 1, affected_projects: [], files: [
      { path: "projects/P-26-111111/project.yaml", kind: "Modified", diff_token: "big", diff: "diff --git\n", hunks: [], oversized: true },
    ] };
    render(<ChangesWorkspace api={fixture as unknown as GitPmApi} draft={draft} role="Developer" locale="en" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} />);
    await screen.findAllByText("projects/P-26-111111/project.yaml");
    expect(screen.getByText(/This change is too large to display/u)).toBeTruthy();
    expect(screen.queryByText("-old")).toBeNull();
  });

  it("commits every file without staging selection, then pushes and creates a merge request", async () => {
    const fixture = new ChangesApi();
    render(<ChangesWorkspace api={fixture as unknown as GitPmApi} draft={draft} role="Developer" locale="en" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} />);
    await screen.findAllByText("projects/P-26-111111/project.yaml");
    fireEvent.click(screen.getByRole("button", { name: "Prepare commit" }));
    expect(screen.getByText("All 3 changed files will be committed.")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "Publish Alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit all" }));
    await waitFor(() => expect(fixture.commitAll).toHaveBeenCalledWith("DRF-CHANGES", "Publish Alpha"));
    fireEvent.click(await screen.findByRole("button", { name: "Push branch" }));
    await waitFor(() => expect(fixture.push).toHaveBeenCalledWith("DRF-CHANGES"));
    fireEvent.change(await screen.findByLabelText("Merge request title"), { target: { value: "Alpha delivery" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Acceptance" } });
    fireEvent.click(screen.getByRole("button", { name: "Create merge request" }));
    await waitFor(() => expect(fixture.createMergeRequest).toHaveBeenCalledWith("DRF-CHANGES", "Alpha delivery", "Acceptance"));
    expect(await screen.findByText("Merge request !7: opened")).toBeTruthy();
  });

  it("direct mode commits and pushes without offering a Merge Request", async () => {
    const fixture = new ChangesApi();
    render(<ChangesWorkspace api={fixture as unknown as GitPmApi} draft={{ ...draft, branch: "main" }} role="Developer" locale="en" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} directMode />);
    await screen.findAllByText("projects/P-26-111111/project.yaml");
    fireEvent.click(screen.getByRole("button", { name: "Prepare commit" }));
    fireEvent.change(screen.getByLabelText("Commit message"), { target: { value: "Direct publish" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit all" }));
    await waitFor(() => expect(fixture.commitAll).toHaveBeenCalledWith("DRF-CHANGES", "Direct publish"));
    fireEvent.click(await screen.findByRole("button", { name: "Push branch" }));
    await waitFor(() => expect(fixture.push).toHaveBeenCalledWith("DRF-CHANGES"));
    expect(await screen.findByText("Pushed to main")).toBeTruthy();
    expect(screen.queryByLabelText("Merge request title")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create merge request" })).toBeNull();
  });
});
