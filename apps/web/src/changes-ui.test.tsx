// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitPmApi } from "./test-gitpm-api.js";
import { ChangesWorkspace, safeExternalUrl } from "./changes-ui.js";
import type { ChangesList, DraftStatus, EntityResult, SemanticDiff } from "./types.js";

const draft: DraftStatus = { draft_id: "DRF-CHANGES", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-CHANGES", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-10T10:00:00Z", updated_at: "2026-07-10T10:00:00Z" };

class ChangesApi {
  committed = false;
  restored: string[] = [];
  changes: ChangesList = { changed_files_count: 3, affected_projects: ["P-26-111111"], project_files: [], files: [
    { path: "projects/P-26-111111/project.yaml", kind: "Modified", diff_token: "one", diff: "@@ -1,1 +1,1 @@\n-old\n+new\n", hunks: [{ old_start: 1, old_count: 1, new_start: 1, new_count: 1, lines: ["-old", "+new"] }] },
    { path: "projects/P-26-111111/tasks/T-26-111111.yaml", kind: "Added", diff_token: "two", diff: "@@ -0,0 +1,1 @@\n+new\n", hunks: [{ old_start: 0, old_count: 0, new_start: 1, new_count: 1, lines: ["+new"] }] },
    { path: "projects/P-26-111111/tasks/T-26-222222.yaml", kind: "Deleted", diff_token: "three", diff: "@@ -1,1 +0,0 @@\n-old\n", hunks: [{ old_start: 1, old_count: 1, new_start: 0, new_count: 0, lines: ["-old"] }] },
  ] };
  semantic: SemanticDiff = {
    created: [{ id: "T-26-111111", path: "projects/P-26-111111/tasks/T-26-111111.yaml", schema: "gitpm/task@2", project: "P-26-111111", fields: [{ field: "title", after: "New task" }, { field: "parent", after: "T-26-222222" }] }],
    updated: [{ id: "P-26-111111", path: "projects/P-26-111111/project.yaml", schema: "gitpm/project@2", project: "P-26-111111", fields: [{ field: "status", before: "backlog", after: "active" }] }],
    archived: [], deleted: [{ id: "T-26-222222", path: "projects/P-26-111111/tasks/T-26-222222.yaml", schema: "gitpm/task@2", project: "P-26-111111", fields: [{ field: "title", before: "Old task" }] }],
    counts: { created: 1, updated: 1, archived: 0, deleted: 1 }, affected_projects: ["P-26-111111"], unclassified_files: [],
    file_entities: [
      { path: "projects/P-26-111111/project.yaml", schema: "gitpm/project@2", id: "P-26-111111", display_name: "Alpha project" },
      { path: "projects/P-26-111111/tasks/T-26-111111.yaml", schema: "gitpm/task@2", id: "T-26-111111", display_name: "New task" },
      { path: "projects/P-26-111111/tasks/T-26-222222.yaml", schema: "gitpm/task@2", id: "T-26-222222", display_name: "Old task" },
    ],
  };
  projects: EntityResult[] = [
    { document: { schema: "gitpm/project@2", id: "P-26-111111", name: "Alpha project", lifecycle: "active" }, path: "projects/P-26-111111/project.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) },
    { document: { schema: "gitpm/project@2", id: "P-26-222222", name: "Бета", lifecycle: "active" }, path: "projects/P-26-222222/project.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) },
  ];
  listChanges = vi.fn(async () => this.committed ? { changed_files_count: 0, affected_projects: [], files: [], project_files: [] } : this.changes);
  semanticChanges = vi.fn(async () => this.committed ? { created: [], updated: [], archived: [], deleted: [], counts: { created: 0, updated: 0, archived: 0, deleted: 0 }, affected_projects: [], file_entities: [], unclassified_files: [] } : this.semantic);
  listEntities = vi.fn(async (_draftId: string, type: string) => type === "projects" ? this.projects : []);
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
  it("allows only credential-free HTTP(S) links for untrusted Merge Request metadata", () => {
    expect(safeExternalUrl("http://gitlab.local/group/project/-/merge_requests/7")).toBe("http://gitlab.local/group/project/-/merge_requests/7");
    expect(safeExternalUrl("https://gitlab.example.test/group/project/-/merge_requests/7")).toBe("https://gitlab.example.test/group/project/-/merge_requests/7");
    expect(safeExternalUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeExternalUrl("http://token@gitlab.local/mr/7")).toBeUndefined();
    expect(safeExternalUrl("https://token@gitlab.example.test/mr/7")).toBeUndefined();
  });

  it("leads with named entities, hides empty groups and keeps the exact Git diff collapsed", async () => {
    const fixture = new ChangesApi();
    render(<ChangesWorkspace api={gitPmApi(fixture)} draft={draft} role="Developer" locale="en" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} />);
    expect(await screen.findByRole("heading", { name: "What changed" })).toBeTruthy();
    expect(screen.getAllByText("Alpha project").length).toBeGreaterThan(0);
    expect(screen.getByText("T-26-111111")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Archived" })).toBeNull();
    const technicalChanges = screen.getByText("Technical file changes").closest("details");
    expect(technicalChanges?.open).toBe(false);
    fireEvent.click(screen.getByText("Technical file changes"));
    expect(technicalChanges?.open).toBe(true);
    expect(screen.getByText("Added")).toBeTruthy(); expect(screen.getAllByText("Modified").length).toBeGreaterThan(0); expect(screen.getAllByText("Deleted").length).toBeGreaterThan(0);
    expect(screen.getByText("-old")).toBeTruthy(); expect(screen.getByText("+new")).toBeTruthy();
    fireEvent.click(screen.getAllByText("Alpha project")[0]!);
    expect(screen.getByText("Status")).toBeTruthy();
    expect(screen.getByText("backlog")).toBeTruthy(); expect(screen.getByText("active")).toBeTruthy();
    expect(screen.queryByText("Technical details")).toBeNull();
    fireEvent.click(screen.getAllByText("New task")[0]!);
    expect(screen.getByText("Old task (T-26-222222)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore hunk" }));
    await waitFor(() => expect(fixture.restoreHunk).toHaveBeenCalledWith("DRF-CHANGES", draft.fingerprint, "projects/P-26-111111/project.yaml", "one", 0));
  });

  it("localizes entity types on file cards", async () => {
    const fixture = new ChangesApi();
    render(<ChangesWorkspace api={gitPmApi(fixture)} draft={draft} role="Developer" locale="ru" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} />);
    expect(await screen.findByText("Что изменилось")).toBeTruthy();
    expect(screen.getAllByText("Проект").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Alpha project").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Задача").length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getAllByText("Alpha project")[0]!);
    expect(screen.getByText("Статус")).toBeTruthy();
  });

  it("shows localized field-level changes for configuration documents without IDs", async () => {
    const fixture = new ChangesApi();
    fixture.changes = { changed_files_count: 1, affected_projects: [], project_files: [], files: [
      { path: ".gitpm/schedule-tracks.yaml", kind: "Modified", diff_token: "tracks", diff: "@@ -1 +1 @@\n-old\n+new\n", hunks: [{ old_start: 1, old_count: 1, new_start: 1, new_count: 1, lines: ["-old", "+new"] }] },
    ] };
    fixture.semantic = {
      created: [], archived: [], deleted: [],
      updated: [{ path: ".gitpm/schedule-tracks.yaml", schema: "gitpm/schedule-tracks@1", fields: [{ field: "tracks.plan.title", before: "Working plan", after: "Внутренний план работ" }] }],
      counts: { created: 0, updated: 1, archived: 0, deleted: 0 }, affected_projects: [], unclassified_files: [],
      file_entities: [{ path: ".gitpm/schedule-tracks.yaml", schema: "gitpm/schedule-tracks@1" }],
    };

    render(<ChangesWorkspace api={gitPmApi(fixture)} draft={draft} role="Maintainer" locale="ru" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} />);
    const scheduleVariants = await screen.findAllByText("Варианты расписания");
    expect(scheduleVariants.length).toBeGreaterThan(0);
    fireEvent.click(scheduleVariants[0]!);
    expect(screen.getByText("Working plan")).toBeTruthy();
    expect(screen.getByText("Внутренний план работ")).toBeTruthy();
    expect(screen.getByText(/Варианты расписания.*Plan.*Заголовок/u)).toBeTruthy();
  });

  it("groups Project file semantics and keeps Reporter controls read-only", async () => {
    const fixture = new ChangesApi();
    fixture.changes = {
      changed_files_count: 4,
      affected_projects: ["P-26-111111", "P-26-222222"],
      files: [
        { path: "projects/P-26-111111/files/ТЗ_v2.docx", kind: "Added", diff_token: "new", diff: "Binary files", hunks: [] },
        { path: "projects/P-26-111111/files/ТЗ_v1.docx", kind: "Deleted", diff_token: "old", diff: "Binary files", hunks: [] },
        { path: "projects/P-26-111111/files/notes.md", kind: "Modified", diff_token: "text", diff: "@@ -1 +1 @@\n-old\n+новый\n", hunks: [{ old_start: 1, old_count: 1, new_start: 1, new_count: 1, lines: ["-old", "+новый"] }] },
        { path: "projects/P-26-222222/files/scan.pdf", kind: "Modified", diff_token: "binary", diff: "Binary files", hunks: [] },
      ],
      project_files: [
        { project_id: "P-26-111111", path: "projects/P-26-111111/files/ТЗ_v2.docx", name: "ТЗ_v2.docx", operation: "Renamed", content_kind: "binary", previous_path: "projects/P-26-111111/files/ТЗ_v1.docx", previous_name: "ТЗ_v1.docx" },
        { project_id: "P-26-111111", path: "projects/P-26-111111/files/notes.md", name: "notes.md", operation: "Modified", content_kind: "text" },
        { project_id: "P-26-222222", path: "projects/P-26-222222/files/scan.pdf", name: "scan.pdf", operation: "Replaced", content_kind: "binary" },
      ],
    };
    const onNavigate = vi.fn();
    render(<ChangesWorkspace api={gitPmApi(fixture)} draft={draft} role="Reporter" locale="ru" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} onNavigate={onNavigate} />);

    expect(await screen.findByRole("heading", { name: "Файлы проектов" })).toBeTruthy();
    expect(screen.getByText("ТЗ_v1.docx → ТЗ_v2.docx")).toBeTruthy();
    expect(screen.getByText("Файл переименован")).toBeTruthy();
    expect(screen.getByText("Файл заменён")).toBeTruthy();
    expect(screen.getByText("Текст · доступен Git diff")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Alpha project" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Бета" })).toBeTruthy();
    expect(screen.getAllByText("P-26-111111").length).toBeGreaterThan(0);
    expect(screen.getAllByText("P-26-222222").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("link", { name: "Бета" }));
    expect(onNavigate).toHaveBeenCalledWith("projects", { projectId: "P-26-222222" });
    fireEvent.click(screen.getByRole("button", { name: /Файл изменён.*notes\.md/u }));
    expect(screen.getByText("+новый")).toBeTruthy();
    expect(screen.getByText("Для этой рабочей копии или роли изменения доступны только для чтения.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Отменить всё" })).toBeNull();
    expect((screen.getByRole("button", { name: "Подготовить коммит" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a localized notice instead of the diff for an oversized change", async () => {
    const fixture = new ChangesApi();
    fixture.changes = { changed_files_count: 1, affected_projects: [], project_files: [], files: [
      { path: "projects/P-26-111111/project.yaml", kind: "Modified", diff_token: "big", diff: "diff --git\n", hunks: [], oversized: true },
    ] };
    render(<ChangesWorkspace api={gitPmApi(fixture)} draft={draft} role="Developer" locale="en" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} />);
    await screen.findByText("Technical file changes");
    fireEvent.click(screen.getByText("Technical file changes"));
    expect(screen.getByText(/This change is too large to display/u)).toBeTruthy();
    expect(screen.queryByText("-old")).toBeNull();
  });

  it("commits every file without staging selection, then pushes and creates a merge request", async () => {
    const fixture = new ChangesApi();
    render(<ChangesWorkspace api={gitPmApi(fixture)} draft={draft} role="Developer" locale="en" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} />);
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
    render(<ChangesWorkspace api={gitPmApi(fixture)} draft={{ ...draft, branch: "main" }} role="Developer" locale="en" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} directMode />);
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
