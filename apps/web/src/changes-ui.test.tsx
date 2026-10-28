// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitPmApi } from "./test-gitpm-api.js";
import { ApiError } from "./api.js";
import { ChangesWorkspace, safeExternalUrl } from "./changes-ui.js";
import { PersonNameFormatProvider } from "./person-name.js";
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
  people: EntityResult[] = [];
  availabilityEvents: EntityResult[] = [];
  taskEntities: EntityResult[] = [];
  milestoneEntities: EntityResult[] = [];
  listChanges = vi.fn(async () => this.committed ? { changed_files_count: 0, affected_projects: [], files: [], project_files: [] } : this.changes);
  semanticChanges = vi.fn(async () => this.committed ? { created: [], updated: [], archived: [], deleted: [], counts: { created: 0, updated: 0, archived: 0, deleted: 0 }, affected_projects: [], file_entities: [], unclassified_files: [] } : this.semantic);
  listEntities = vi.fn(async (_draftId: string, type: string) => type === "projects" ? this.projects : type === "people" ? this.people : type === "availability-events" ? this.availabilityEvents : type === "tasks" ? this.taskEntities : type === "milestones" ? this.milestoneEntities : []);
  restoreFile = vi.fn(async (_draftId: string, _fingerprint: string, path: string) => { this.restored.push(path); });
  restoreHunk = vi.fn(async (_draftId: string, _fingerprint: string, path: string) => { this.restored.push(path); });
  discardAll = vi.fn(async () => undefined);
  commitAll = vi.fn(async () => { this.committed = true; return { commit: "c".repeat(40), branch: draft.branch, draft_fingerprint: "d".repeat(64) }; });
  push = vi.fn(async () => ({ branch: draft.branch, commit: "c".repeat(40) }));
  syncDirect = vi.fn(async () => ({ branch: "main", commit: "e".repeat(40), strategy: "merge" as const, draft_fingerprint: "f".repeat(64) }));
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

  it("resolves person, milestone and task references in field values to display names", async () => {
    const fixture = new ChangesApi();
    fixture.people = [
      { document: { schema: "gitpm/person@1", id: "U-26-900001", name: "Иван", family_name: "Иванов", middle_name: "Иванович", lifecycle: "active" }, path: "people/U-26-900001.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) },
      { document: { schema: "gitpm/person@1", id: "U-26-900002", name: "Анна", family_name: "Петрова", lifecycle: "active" }, path: "people/U-26-900002.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) },
    ];
    fixture.taskEntities = [
      { document: { schema: "gitpm/task@2", id: "T-26-900003", title: "Подготовка стенда", lifecycle: "active", project: "P-26-111111" }, path: "projects/P-26-111111/tasks/T-26-900003.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) },
    ];
    fixture.milestoneEntities = [
      { document: { schema: "gitpm/milestone@2", id: "M-26-900004", name: "Этап 2", lifecycle: "active", project: "P-26-111111" }, path: "projects/P-26-111111/milestones/M-26-900004.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) },
    ];
    fixture.semantic = {
      created: [], archived: [], deleted: [],
      updated: [{ id: "T-26-111111", path: "projects/P-26-111111/tasks/T-26-111111.yaml", schema: "gitpm/task@2", project: "P-26-111111", fields: [
        { field: "assignees", after: ["U-26-900001", "U-26-900002"] },
        { field: "owner", before: "U-26-900002", after: "U-26-900001" },
        { field: "milestone", after: "M-26-900004" },
        { field: "parent", after: "T-26-900003" },
      ] }],
      counts: { created: 0, updated: 1, archived: 0, deleted: 0 }, affected_projects: ["P-26-111111"], unclassified_files: [],
      file_entities: [{ path: "projects/P-26-111111/tasks/T-26-111111.yaml", schema: "gitpm/task@2", id: "T-26-111111", display_name: "Проведение испытаний" }],
    };

    render(<ChangesWorkspace api={gitPmApi(fixture)} draft={draft} role="Developer" locale="ru" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} />);
    fireEvent.click((await screen.findAllByText("Проведение испытаний"))[0]!);
    expect(screen.getByText("Иванов Иван Иванович (U-26-900001), Петрова Анна (U-26-900002)")).toBeTruthy();
    expect(screen.getByText("Петрова Анна (U-26-900002)")).toBeTruthy();
    expect(screen.getByText("Иванов Иван Иванович (U-26-900001)")).toBeTruthy();
    expect(screen.getByText("Этап 2 (M-26-900004)")).toBeTruthy();
    expect(screen.getByText("Подготовка стенда (T-26-900003)")).toBeTruthy();
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

  it.each(["created", "updated", "archived", "deleted"] as const)("names %s availability events after their employee and keeps the event ID secondary", async (group) => {
    const fixture = new ChangesApi();
    const path = "availability/A-26-3451SP.yaml";
    const person: EntityResult = { document: { schema: "gitpm/person@1", id: "U-26-900001", name: "Иван", family_name: "Иванов", middle_name: "Иванович", lifecycle: "active" }, path: "people/U-26-900001.yaml", blob_id: "a".repeat(40), draft_fingerprint: draft.fingerprint };
    fixture.people = [person];
    fixture.availabilityEvents = group === "deleted" ? [] : [{ ...person, path, document: { schema: "gitpm/availability-event@1", id: "A-26-3451SP", person: person.document.id, lifecycle: group === "archived" ? "archived" : "active" } }];
    fixture.changes = { changed_files_count: 1, affected_projects: [], project_files: [], files: [{ path, kind: group === "created" ? "Added" : group === "deleted" ? "Deleted" : "Modified", diff_token: "availability", diff: "", hunks: [] }] };
    fixture.semantic = {
      created: [], updated: [], archived: [], deleted: [],
      [group]: [{ id: "A-26-3451SP", path, schema: "gitpm/availability-event@1", fields: group === "deleted" ? [{ field: "person", before: person.document.id }] : group === "created" ? [{ field: "person", after: person.document.id }] : [{ field: "start", before: "2026-10-28", after: "2026-10-29" }] }],
      counts: { created: 0, updated: 0, archived: 0, deleted: 0, [group]: 1 }, affected_projects: [], unclassified_files: [],
      file_entities: [{ path, schema: "gitpm/availability-event@1", id: "A-26-3451SP" }],
    };

    const { container } = render(<ChangesWorkspace api={gitPmApi(fixture)} draft={draft} role="Developer" locale="ru" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} />);
    await screen.findAllByText("Иванов Иван Иванович");
    const summary = container.querySelector(".semantic-item summary")!;
    expect(within(summary as HTMLElement).getByText("Событие доступности")).toBeTruthy();
    expect(summary.querySelector("strong")?.textContent).toBe("Иванов Иван Иванович");
    expect(summary.querySelector("code")?.textContent).toBe("A-26-3451SP");
    expect(container.querySelector(".change-file-entity strong")?.textContent).toBe("Иванов Иван Иванович");
    if (group === "deleted") {
      fireEvent.click(summary);
      expect(screen.getByText("Сотрудник")).toBeTruthy();
      expect(screen.getByText("Иванов Иван Иванович (U-26-900001)")).toBeTruthy();
    }
  });

  it("uses the new employee and configured name format when an availability event is reassigned", async () => {
    const fixture = new ChangesApi();
    const path = "availability/A-26-3451SP.yaml";
    fixture.people = [{ document: { schema: "gitpm/person@1", id: "U-26-900002", name: "Анна", family_name: "Петрова", middle_name: "Ивановна", lifecycle: "active" }, path: "people/U-26-900002.yaml", blob_id: "a".repeat(40), draft_fingerprint: draft.fingerprint }];
    fixture.semantic = {
      created: [], archived: [], deleted: [],
      updated: [{ id: "A-26-3451SP", path, schema: "gitpm/availability-event@1", fields: [{ field: "person", before: "U-26-900001", after: "U-26-900002" }] }],
      counts: { created: 0, updated: 1, archived: 0, deleted: 0 }, affected_projects: [], unclassified_files: [],
      file_entities: [{ path, schema: "gitpm/availability-event@1", id: "A-26-3451SP" }],
    };
    const { container } = render(<PersonNameFormatProvider format="family-initials"><ChangesWorkspace api={gitPmApi(fixture)} draft={draft} role="Developer" locale="ru" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} /></PersonNameFormatProvider>);
    await screen.findByText("Петрова А. И.");
    expect(container.querySelector(".semantic-item summary strong")?.textContent).toBe("Петрова А. И.");
  });

  it("keeps the event identity when its employee name cannot be resolved", async () => {
    const fixture = new ChangesApi();
    const path = "availability/A-26-3451SP.yaml";
    fixture.semantic = {
      created: [], updated: [], archived: [],
      deleted: [{ id: "A-26-3451SP", path, schema: "gitpm/availability-event@1", fields: [{ field: "person", before: "U-26-900001" }] }],
      counts: { created: 0, updated: 0, archived: 0, deleted: 1 }, affected_projects: [], unclassified_files: [],
      file_entities: [{ path, schema: "gitpm/availability-event@1", id: "A-26-3451SP" }],
    };
    const { container } = render(<ChangesWorkspace api={gitPmApi(fixture)} draft={draft} role="Developer" locale="ru" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} />);
    await screen.findAllByText("A-26-3451SP");
    expect(container.querySelector(".semantic-item summary code")?.textContent).toBe("A-26-3451SP");
    expect(container.querySelector(".semantic-item summary strong")?.textContent).toBe("A-26-3451SP");
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
    expect(await screen.findByText("Committed")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Push branch" }));
    await waitFor(() => expect(fixture.push).toHaveBeenCalledWith("DRF-CHANGES"));
    expect(await screen.findByText("Pushed to main")).toBeTruthy();
    expect(screen.queryByLabelText("Merge request title")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create merge request" })).toBeNull();
  });

  it("offers push from unpublished commits after reload", async () => {
    const fixture = new ChangesApi();
    fixture.changes = { changed_files_count: 0, affected_projects: [], project_files: [], files: [] };
    render(<ChangesWorkspace api={gitPmApi(fixture)} draft={{ ...draft, sync: { head: "c".repeat(40), ahead: 2, behind: 0, default_branch: "main", default_branch_ahead: 0 } }} role="Developer" locale="en" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} />);
    fireEvent.click(await screen.findByRole("button", { name: "Push branch" }));
    await waitFor(() => expect(fixture.push).toHaveBeenCalledWith("DRF-CHANGES"));
  });

  it("offers direct sync for divergence and asks before merging", async () => {
    const fixture = new ChangesApi();
    fixture.changes = { changed_files_count: 0, affected_projects: [], project_files: [], files: [] };
    const confirmAction = vi.fn(() => true);
    render(<ChangesWorkspace api={gitPmApi(fixture)} draft={{ ...draft, branch: "main", sync: { head: "c".repeat(40), remote_commit: "d".repeat(40), ahead: 1, behind: 2, default_branch: "main", default_branch_ahead: 0 } }} role="Developer" locale="en" onChanged={vi.fn(async () => undefined)} confirmAction={confirmAction} directMode />);
    expect(await screen.findByText("origin is 2 commits ahead")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Push branch" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sync with origin" }));
    await waitFor(() => expect(fixture.syncDirect).toHaveBeenCalledWith("DRF-CHANGES", draft.fingerprint));
    expect(confirmAction).toHaveBeenCalled();
    expect(await screen.findByText("Changes merged into local main. Review the result, then push.")).toBeTruthy();
  });

  it("reports merge conflicts in the selected locale and keeps Push unavailable", async () => {
    const fixture = new ChangesApi();
    fixture.changes = { changed_files_count: 0, affected_projects: [], project_files: [], files: [] };
    fixture.syncDirect.mockRejectedValueOnce(new ApiError("GIT_SYNC_CONFLICT", "Merge conflicts require manual resolution", { conflicted_files: ["projects/P-26-111111/project.yaml"] }));
    render(<ChangesWorkspace api={gitPmApi(fixture)} draft={{ ...draft, branch: "main", sync: { head: "c".repeat(40), remote_commit: "d".repeat(40), ahead: 1, behind: 1, default_branch: "main", default_branch_ahead: 0 } }} role="Developer" locale="ru" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} directMode />);
    fireEvent.click(await screen.findByRole("button", { name: "Синхронизировать с origin" }));
    expect(await screen.findByText(/Конфликт слияния в projects\/P-26-111111\/project.yaml/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Отправить ветку" })).toBeNull();
  });

  it("asks to sign in for push when GitLab is configured and the session is missing", async () => {
    const fixture = new ChangesApi();
    fixture.changes = { changed_files_count: 0, affected_projects: [], project_files: [], files: [] };
    const onGitLabLogin = vi.fn();
    render(<ChangesWorkspace api={gitPmApi(fixture)} draft={{ ...draft, sync: { head: "c".repeat(40), ahead: 1, behind: 0, default_branch: "main", default_branch_ahead: 0 } }} role="Developer" locale="en" onChanged={vi.fn(async () => undefined)} confirmAction={() => true} gitlabConfigured gitlabSignedIn={false} onGitLabLogin={onGitLabLogin} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in to GitLab to push" }));
    expect(onGitLabLogin).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Push branch" })).toBeNull();
  });
});
