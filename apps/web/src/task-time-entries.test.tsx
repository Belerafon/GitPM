// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import type { TimeEntryResult } from "./api.js";
import { TaskTimeEntries } from "./task-time-entries.js";
import type { DraftStatus, EntityResult } from "./types.js";
import type { ProjectFileList } from "@gitpm/contracts";
import type { ProjectFileReferenceContext } from "./project-file-reference-ui.js";

const draft: DraftStatus = { draft_id: "DRF-TIME", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-TIME", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" };
const person = { document: { schema: "gitpm/person@1", id: "U-26-ADA", name: "Ada", lifecycle: "active" }, path: "p.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) } as EntityResult;
const files: ProjectFileList = {
  project_id: "P-26-1", count: 1, total_size_bytes: 2, draft_fingerprint: draft.fingerprint,
  items: [{ name: "Отчёт [август].xlsx", path: "projects/P-26-1/files/Отчёт [август].xlsx", size_bytes: 2, media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", disposition: "attachment", modified_at: "2026-08-13T00:00:00Z", modified_at_source: "working_copy_filesystem" }],
};
const fileContext: ProjectFileReferenceContext = { draftId: draft.draft_id, projectId: files.project_id, files, loadState: { status: "ready" }, locale: "en", onReload: vi.fn() };

function entry(id: string, overrides: Partial<TimeEntryResult["document"]> = {}): TimeEntryResult {
  return {
    document: {
      schema: "gitpm/time-entry@1", id, project: "P-26-1", task: "T-26-1", person: "U-26-ADA",
      performed_on: "2026-09-01", hours: 2, category: "regular", created_at: "2026-09-01T10:00:00.000Z", state: "active",
      ...overrides,
    },
    path: `projects/P-26-1/time-entries/T-26-1/${id}.yaml`,
    blob_id: "c".repeat(40),
    draft_fingerprint: "d".repeat(64),
  };
}

afterEach(cleanup);

describe("TaskTimeEntries", () => {
  it("lists entries, sums hours and adds then voids an entry", async () => {
    const createTimeEntry = vi.fn(async (): Promise<TimeEntryResult> => entry("E-26-NEW2", { performed_on: "2026-09-03", hours: 3 }));
    const voidTimeEntry = vi.fn(async (): Promise<TimeEntryResult> => entry("E-26-NEW2", { performed_on: "2026-09-03", hours: 3, state: "voided" }));
    const api = {
      listTimeEntries: vi.fn(async (): Promise<readonly TimeEntryResult[]> => [entry("E-26-AAAA", { performed_on: "2026-08-17", hours: 4 })]),
      getConfiguration: vi.fn(async (_draftId: string, kind: string) => ({ document: { schema: "gitpm/work-categories@1", categories: [{ slug: "regular", title: "Regular", active: true }] }, path: kind, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) })),
      createTimeEntry,
      voidTimeEntry,
    } as unknown as GitPmApi;

    const onOpenPerson = vi.fn();
    render(<TaskTimeEntries api={api} draft={draft} fingerprint={draft.fingerprint} projectId="P-26-1" taskId="T-26-1" people={[person]} readOnly={false} locale="en" onFingerprintChange={vi.fn(async () => undefined)} onOpenPerson={onOpenPerson} />);

    await waitFor(() => expect(screen.getAllByText("4 hours").length).toBeGreaterThan(0));
    expect(screen.getByText(/Total hours/).parentElement?.textContent).toMatch(/4/);
    fireEvent.click(screen.getByRole("link", { name: "Ada" }));
    expect(onOpenPerson).toHaveBeenCalledWith("U-26-ADA");

    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-09-03" } });
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Add effort" }));
    await waitFor(() => expect(createTimeEntry).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByText("3 hours").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "Void entry" })[0]!);
    await waitFor(() => expect(voidTimeEntry).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryAllByRole("button", { name: "Void entry" })).toHaveLength(1));
  });

  it("defaults the date to today and the person to the first active assignee", async () => {
    const api = {
      listTimeEntries: vi.fn(async (): Promise<readonly TimeEntryResult[]> => []),
      getConfiguration: vi.fn(async (_draftId: string, kind: string) => ({ document: { schema: "gitpm/work-categories@1", categories: [{ slug: "regular", title: "Regular", active: true }] }, path: kind, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) })),
    } as unknown as GitPmApi;
    const other = { document: { schema: "gitpm/person@1", id: "U-26-LIN", name: "Linus", lifecycle: "active" }, path: "p.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) } as EntityResult;

    render(<TaskTimeEntries api={api} draft={draft} fingerprint={draft.fingerprint} projectId="P-26-1" taskId="T-26-1" people={[other, person]} assigneeIds={[person.document.id]} readOnly={false} locale="en" onFingerprintChange={vi.fn(async () => undefined)} />);

    const dateInput = await screen.findByLabelText("Date");
    const expected = (() => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; })();
    expect((dateInput as HTMLInputElement).value).toBe(expected);
    expect((screen.getByLabelText("Person") as HTMLSelectElement).value).toBe(person.document.id);
  });

  it("atomically corrects an entry and keeps the audit-linked voided original", async () => {
    const original = entry("E-26-ORIGINAL", { hours: 2, note_markdown: "wrong" });
    const voided = entry("E-26-ORIGINAL", { hours: 2, note_markdown: "wrong", state: "voided", replacement: "E-26-CORRECT" });
    const created = entry("E-26-CORRECT", { hours: 3.5, note_markdown: "corrected" });
    const replaceTimeEntry = vi.fn(async () => ({ voided, created }));
    const api = {
      listTimeEntries: vi.fn(async (): Promise<readonly TimeEntryResult[]> => [original]),
      getConfiguration: vi.fn(() => new Promise<never>(() => undefined)),
      replaceTimeEntry,
    } as unknown as GitPmApi;

    render(<TaskTimeEntries api={api} draft={draft} fingerprint={draft.fingerprint} projectId="P-26-1" taskId="T-26-1" people={[person]} readOnly={false} locale="en" onFingerprintChange={vi.fn(async () => undefined)} />);

    fireEvent.click(await screen.findByRole("button", { name: "Correct" }));
    const dialog = screen.getByRole("dialog", { name: "Correct effort entry" });
    fireEvent.change(within(dialog).getByLabelText("Hours"), { target: { value: "3.5" } });
    fireEvent.change(within(dialog).getByLabelText("Note"), { target: { value: "corrected" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(replaceTimeEntry).toHaveBeenCalledWith("DRF-TIME", "P-26-1", "T-26-1", original, draft.fingerprint, expect.objectContaining({ hours: 3.5, note_markdown: "corrected" })));
    await waitFor(() => expect(screen.getAllByText("3.5 hours").length).toBeGreaterThan(0));
    expect(screen.getAllByText("2 hours").length).toBe(1);
    expect(screen.getAllByRole("button", { name: "Correct" })).toHaveLength(1);
  });

  it("preserves archived person and inactive category when only historical hours are corrected", async () => {
    const archivedPerson = { document: { schema: "gitpm/person@1", id: "U-26-OLD", name: "Former employee", lifecycle: "archived" }, path: "old.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) } as EntityResult;
    const original = entry("E-26-HISTORY", { person: "U-26-OLD", category: "warranty", hours: 2 });
    const replaceTimeEntry = vi.fn(async (_draftId: string, _projectId: string, _taskId: string, _entry: TimeEntryResult, _fingerprint: string, input: { person: string; category: string; hours: number }) => ({
      voided: entry("E-26-HISTORY", { ...original.document, state: "voided", replacement: "E-26-HISTORY2" }),
      created: entry("E-26-HISTORY2", { person: input.person, category: input.category, hours: input.hours }),
    }));
    const api = {
      listTimeEntries: vi.fn(async (): Promise<readonly TimeEntryResult[]> => [original]),
      getConfiguration: vi.fn(async (_draftId: string, kind: string) => ({ document: { schema: "gitpm/work-categories@1", categories: [{ slug: "regular", title: "Regular", active: true }, { slug: "warranty", title: "Warranty", active: false }] }, path: kind, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) })),
      getEntity: vi.fn(async () => archivedPerson),
      replaceTimeEntry,
    } as unknown as GitPmApi;

    render(<TaskTimeEntries api={api} draft={draft} fingerprint={draft.fingerprint} projectId="P-26-1" taskId="T-26-1" people={[person]} readOnly={false} locale="en" onFingerprintChange={vi.fn(async () => undefined)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Correct" }));
    const dialog = screen.getByRole("dialog", { name: "Correct effort entry" });
    expect((within(dialog).getByLabelText("Person") as HTMLSelectElement).value).toBe("U-26-OLD");
    expect(await within(dialog).findByRole("option", { name: "Former employee (Archived)" })).toBeTruthy();
    expect((within(dialog).getByLabelText("Category") as HTMLSelectElement).value).toBe("warranty");
    expect(within(dialog).getByRole("option", { name: "Warranty (Inactive)" })).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Hours"), { target: { value: "2.5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(replaceTimeEntry).toHaveBeenCalledWith("DRF-TIME", "P-26-1", "T-26-1", original, draft.fingerprint, expect.objectContaining({ person: "U-26-OLD", category: "warranty", hours: 2.5 })));
  });

  it("collapses and expands via the heading toggle", async () => {
    const api = {
      listTimeEntries: vi.fn(async (): Promise<readonly TimeEntryResult[]> => []),
      getConfiguration: vi.fn(async (_draftId: string, kind: string) => ({ document: { schema: "gitpm/work-categories@1", categories: [{ slug: "regular", title: "Regular", active: true }] }, path: kind, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) })),
    } as unknown as GitPmApi;

    render(<TaskTimeEntries api={api} draft={draft} fingerprint={draft.fingerprint} projectId="P-26-1" taskId="T-26-1" people={[person]} readOnly={false} locale="en" onFingerprintChange={vi.fn(async () => undefined)} />);

    const toggle = await screen.findByRole("button", { name: /Actual effort/iu });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("Date")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Date")).toBeTruthy();
  });

  it("renders exact, missing and hostile references in active and voided historical notes", async () => {
    const api = {
      listTimeEntries: vi.fn(async (): Promise<readonly TimeEntryResult[]> => [
        entry("E-26-FILE01", { note_markdown: "See [[file:Отчёт \\[август\\].xlsx]] <script>x</script>" }),
        entry("E-26-FILE02", { note_markdown: "Old [[file:missing.xlsx]]", state: "voided" }),
      ]),
      getConfiguration: vi.fn(async () => ({ document: { schema: "gitpm/work-categories@1", categories: [{ slug: "regular", title: "Regular", active: true }] }, path: "work-categories", blob_id: "a".repeat(40), draft_fingerprint: draft.fingerprint })),
    } as unknown as GitPmApi;
    const rendered = render(<TaskTimeEntries api={api} draft={draft} fileContext={fileContext} fingerprint={draft.fingerprint} projectId={files.project_id} taskId="T-26-1" people={[person]} readOnly={false} locale="en" onFingerprintChange={vi.fn(async () => undefined)} />);

    expect(await screen.findByRole("link", { name: "Download Отчёт [август].xlsx" })).toBeTruthy();
    const voidedReference = screen.getByRole("note", { name: "Broken file reference: missing.xlsx" });
    expect(voidedReference.closest(".time-entry-note")?.parentElement?.classList.contains("voided")).toBe(true);
    expect(rendered.container.textContent).toContain("<script>x</script>");
    expect(rendered.container.querySelector("script,img,svg")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Correct" })).toHaveLength(1);
  });

  it("inserts canonical references in create and correction flows without breaking fingerprint callbacks", async () => {
    const original = entry("E-26-FILE03", { note_markdown: "Before selected after" });
    const created = entry("E-26-FILE04", { note_markdown: "" });
    const createTimeEntry = vi.fn(async (_d: string, _p: string, _t: string, _fingerprint: string, input: { note_markdown?: string }) => ({ ...created, document: { ...created.document, note_markdown: input.note_markdown }, draft_fingerprint: "e".repeat(64) }));
    const replaceTimeEntry = vi.fn(async (_d: string, _p: string, _t: string, _entry: TimeEntryResult, _fingerprint: string, input: { note_markdown?: string }) => ({
      voided: entry(original.document.id, { ...original.document, state: "voided", replacement: "E-26-FILE05" }),
      created: { ...entry("E-26-FILE05", { note_markdown: input.note_markdown }), draft_fingerprint: "f".repeat(64) },
    }));
    const onFingerprintChange = vi.fn(async () => undefined);
    const api = {
      listTimeEntries: vi.fn(async (): Promise<readonly TimeEntryResult[]> => [original]),
      getConfiguration: vi.fn(async () => ({ document: { schema: "gitpm/work-categories@1", categories: [{ slug: "regular", title: "Regular", active: true }] }, path: "work-categories", blob_id: "a".repeat(40), draft_fingerprint: draft.fingerprint })),
      createTimeEntry, replaceTimeEntry,
    } as unknown as GitPmApi;
    render(<TaskTimeEntries api={api} draft={draft} fileContext={fileContext} fingerprint={draft.fingerprint} projectId={files.project_id} taskId="T-26-1" people={[person]} readOnly={false} locale="en" onFingerprintChange={onFingerprintChange} />);

    const note = await screen.findByLabelText("Note") as HTMLTextAreaElement;
    note.focus(); note.setSelectionRange(0, 0);
    fireEvent.click(screen.getAllByRole("button", { name: "Insert file" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Insert a link to Отчёт [август].xlsx" }));
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add effort" }));
    await waitFor(() => expect(createTimeEntry).toHaveBeenCalledWith(draft.draft_id, files.project_id, "T-26-1", draft.fingerprint, expect.objectContaining({ note_markdown: "[[file:Отчёт \\[август\\].xlsx]]" })));
    await waitFor(() => expect(onFingerprintChange).toHaveBeenCalledWith("e".repeat(64)));

    const correct = screen.getAllByRole("button", { name: "Correct" })[0] as HTMLButtonElement;
    await waitFor(() => expect(correct.disabled).toBe(false));
    fireEvent.click(correct);
    const dialog = screen.getByRole("dialog", { name: "Correct effort entry" });
    const editNote = within(dialog).getByLabelText("Note") as HTMLTextAreaElement;
    editNote.setSelectionRange(7, 15);
    fireEvent.click(within(dialog).getByRole("button", { name: "Insert file" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Insert a link to Отчёт [август].xlsx" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(replaceTimeEntry).toHaveBeenCalledWith(draft.draft_id, files.project_id, "T-26-1", original, "e".repeat(64), expect.objectContaining({ note_markdown: "Before [[file:Отчёт \\[август\\].xlsx]] after" })));
    expect(onFingerprintChange).toHaveBeenLastCalledWith("f".repeat(64));
  });

  it("keeps notes readable but hides all mutation and insertion controls in read-only mode", async () => {
    const api = {
      listTimeEntries: vi.fn(async (): Promise<readonly TimeEntryResult[]> => [entry("E-26-READ01", { note_markdown: "[[file:Отчёт \\[август\\].xlsx]]" })]),
      getConfiguration: vi.fn(async () => ({ document: { schema: "gitpm/work-categories@1", categories: [] }, path: "work-categories", blob_id: "a".repeat(40), draft_fingerprint: draft.fingerprint })),
    } as unknown as GitPmApi;
    render(<TaskTimeEntries api={api} draft={draft} fileContext={fileContext} fingerprint={draft.fingerprint} projectId={files.project_id} taskId="T-26-1" people={[person]} readOnly locale="en" onFingerprintChange={vi.fn(async () => undefined)} />);
    expect(await screen.findByRole("link", { name: "Download Отчёт [август].xlsx" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Correct" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Void entry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Insert file" })).toBeNull();
  });
});
