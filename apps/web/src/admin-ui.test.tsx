// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type GitPmApi } from "./api.js";
import { AdminWorkspace } from "./admin-ui.js";
import type { ConfigurationDocument, ConfigurationImpact, ConfigurationResult, DraftStatus, EntityDocument, EntityResult, RepositoryDocument, RepositoryResult } from "./types.js";

const draft: DraftStatus = { draft_id: "DRF-ADMIN", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-ADMIN", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" };
type ConfigurationKind = "statuses" | "issue-types" | "work-categories" | "schedule-tracks";
const configDocument = (kind: ConfigurationKind) => (kind === "statuses" ? { schema: "gitpm/statuses@2", statuses: [{ slug: "backlog", title: "Backlog", color: "gray", active: true, category: "backlog" }, { slug: "accepted", title: "Accepted", color: "green", active: true, category: "done" }] } : kind === "work-categories" ? { schema: "gitpm/work-categories@1", categories: [{ slug: "regular", title: "Regular work", active: true }, { slug: "rework", title: "Rework", active: true }] } : kind === "schedule-tracks" ? { schema: "gitpm/schedule-tracks@1", tracks: [{ slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort", "dependencies"] }, { slug: "target", title: "Target", kind: "manual", capabilities: ["dates"] }, { slug: "actual", title: "Actual", kind: "actual", source: "time_entries" }], defaults: { enabled_tracks: ["plan", "target", "actual"], primary_track: "plan", workload_track: "plan", comparison_track: "target", dashboard_tracks: ["plan", "target", "actual"] } } : { schema: "gitpm/issue-types@1", issue_types: [{ slug: "task", title: "Task", color: "blue", active: true }] }) as ConfigurationDocument;

class AdminApi {
  entities: EntityResult[] = [];
  configurations = new Map<ConfigurationKind, ConfigurationResult>([["statuses", this.config("statuses")], ["issue-types", this.config("issue-types")], ["work-categories", this.config("work-categories")], ["schedule-tracks", this.config("schedule-tracks")]]);
  configurationReads: ConfigurationKind[] = [];
  configurationImpact: ConfigurationImpact = { blocking: false, issues: [] };
  configurationUpdates = 0;
  repository: RepositoryResult | undefined;
  mutations = 0;
  private config(kind: ConfigurationKind): ConfigurationResult { return { document: configDocument(kind), path: `.gitpm/${kind}.yaml`, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) }; }
  private result(document: EntityDocument): EntityResult { this.mutations += 1; return { document, path: `${document.id}.yaml`, blob_id: String(this.mutations).padStart(40, "a"), draft_fingerprint: String(this.mutations).padStart(64, "b") }; }
  async listEntities(_draftId: string, type: string) { const schemas: Record<string, string> = { calendars: "gitpm/calendar@1", people: "gitpm/person@1", teams: "gitpm/team@1", projects: "gitpm/project@2", tasks: "gitpm/task@2", milestones: "gitpm/milestone@2" }; return this.entities.filter((item) => item.document.schema === schemas[type]); }
  async createEntity(_draftId: string, _type: string, _fingerprint: string, document: EntityDocument) { const result = this.result(document); this.entities.push(result); if (document.schema === "gitpm/calendar@1" && this.repository !== undefined && !this.entities.some((item) => item !== result && item.document.id === this.repository?.document.default_calendar)) this.repository = { ...this.repository, document: { ...this.repository.document, default_calendar: String(document.id) } }; return result; }
  async updateEntity(_draftId: string, _type: string, entity: EntityResult, _fingerprint: string, document: EntityDocument) { const result = this.result(document); this.entities = this.entities.map((item) => item === entity ? result : item); return result; }
  async archiveEntity(draftId: string, type: string, entity: EntityResult, fingerprint: string) { return await this.updateEntity(draftId, type, entity, fingerprint, { ...entity.document, lifecycle: "archived" }); }
  async restoreEntity(draftId: string, type: string, entity: EntityResult, fingerprint: string) { return await this.updateEntity(draftId, type, entity, fingerprint, { ...entity.document, lifecycle: "active" }); }
  async deleteEntity(_draftId: string, _type: string, entity: EntityResult) {
    if (entity.document.schema === "gitpm/calendar@1" && this.repository?.document.default_calendar === entity.document.id) throw new ApiError("DELETE_RESTRICTED", `${entity.document.id} is referenced`);
    this.mutations += 1; this.entities = this.entities.filter((item) => item.document.id !== entity.document.id);
  }
  async getConfiguration(_draftId: string, kind: ConfigurationKind) { this.configurationReads.push(kind); return this.configurations.get(kind)!; }
  async getRepositoryConfiguration() { const calendar = this.entities.find((item) => item.document.schema === "gitpm/calendar@1")?.document.id ?? "C-26-QD7FJ4"; this.repository ??= { document: { schema: "gitpm/repository@1" as const, default_branch: "main", default_calendar: calendar, allowed_top_level_files: [], ui_poll_interval_seconds: 5 }, path: ".gitpm/repository.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) }; return this.repository; }
  async getConfigurationImpact() { return this.configurationImpact; }
  async updateConfiguration(_draftId: string, kind: ConfigurationKind, entity: ConfigurationResult, _fingerprint: string, document: ConfigurationDocument) { this.configurationUpdates += 1; const result: ConfigurationResult = { ...entity, document }; this.configurations.set(kind, result); return result; }
  async updateRepositoryConfiguration(_draftId: string, entity: RepositoryResult, _fingerprint: string, document: RepositoryDocument) { this.repository = { ...entity, document }; return this.repository; }
}

afterEach(cleanup);

describe("administration UI", () => {
  it("lets Maintainer create Calendar, Person and Team and edit statuses", async () => {
    const admin = new AdminApi(); const api = admin as unknown as GitPmApi; const changed = vi.fn(async () => undefined);
    const rendered = render(<AdminWorkspace api={api} draft={draft} role="Maintainer" locale="en" surface="calendar" onChanged={changed} />);
    fireEvent.click(await screen.findByRole("button", { name: /Create calendar/u }));
    const calendarForm = within(screen.getByRole("dialog", { name: "Create calendar" })).getByRole("button", { name: "Create calendar" }).closest("form")!;
    fireEvent.change(within(calendarForm).getByLabelText("Name"), { target: { value: "Default" } });
    fireEvent.click(within(calendarForm).getByRole("button", { name: /Add non-working date/u }));
    fireEvent.change(within(calendarForm).getByLabelText("Non-working date 1"), { target: { value: "2026-01-01" } }); fireEvent.submit(calendarForm);
    expect(await screen.findByText(/Default \(Repository default calendar\)/u)).toBeTruthy();
    expect(screen.getByLabelText("Working week preview").querySelectorAll(".working")).toHaveLength(5);

    const onOpenPerson = vi.fn();
    rendered.rerender(<AdminWorkspace api={api} draft={draft} role="Maintainer" locale="en" onOpenPerson={onOpenPerson} surface="people" onChanged={changed} />);
    const peopleCard = document.querySelector<HTMLElement>(".people-directory-card")!;
    expect(within(peopleCard).getByRole("button", { name: /Filters and sorting/u })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /Create person/u }));
    const personForm = within(screen.getByRole("dialog", { name: "Create person" })).getByRole("button", { name: "Create person" }).closest("form")!;
    fireEvent.change(within(personForm).getByLabelText("Name"), { target: { value: "Alice" } }); fireEvent.change(within(personForm).getByLabelText("Weekly capacity (hours)"), { target: { value: "32" } }); fireEvent.submit(personForm);
    expect(await screen.findByText("Alice")).toBeTruthy();
    expect(admin.entities.find((item) => item.document.schema === "gitpm/person@1")?.document.calendar).toBe(admin.entities.find((item) => item.document.schema === "gitpm/calendar@1")?.document.id);
    expect(document.querySelectorAll(".people-directory-table tbody tr")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Edit person" })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Alice" }));
    expect(onOpenPerson).toHaveBeenCalledWith(expect.stringMatching(/^U-/u));
    fireEvent.click(screen.getByRole("button", { name: /Create team/u }));
    const teamForm = within(screen.getByRole("dialog", { name: "Create team" })).getByRole("button", { name: "Create team" }).closest("form")!;
    const memberTable = within(teamForm).getByRole("table", { name: "Members" });
    expect(memberTable.closest(".member-picker-scroll")).toBeTruthy();
    expect(within(memberTable).getByRole("columnheader", { name: "Person" })).toBeTruthy();
    expect(within(memberTable).getByRole("columnheader", { name: "Weekly capacity (hours)" })).toBeTruthy();
    fireEvent.change(within(teamForm).getByLabelText("Name"), { target: { value: "Core" } }); fireEvent.click(within(teamForm).getByLabelText("Alice")); fireEvent.submit(teamForm);
    const teamTable = document.querySelector<HTMLElement>(".team-directory-table")!;
    expect(await within(teamTable).findByText("Core")).toBeTruthy();
    expect(admin.entities.find((item) => item.document.schema === "gitpm/team@1")?.document.members).toHaveLength(1);
    const teamCard = teamTable.closest<HTMLElement>(".directory-card")!;
    fireEvent.click(within(teamCard).getByRole("button", { name: /Filters and sorting/u }));
    let filterDialog = screen.getByRole("dialog", { name: "Filters and sorting" });
    fireEvent.click(within(filterDialog).getByRole("button", { name: /Add condition/u }));
    fireEvent.change(within(filterDialog).getAllByLabelText("Field")[1]!, { target: { value: "members" } });
    fireEvent.change(within(filterDialog).getAllByLabelText("Value")[1]!, { target: { value: admin.entities.find((item) => item.document.name === "Alice")!.document.id } });
    fireEvent.click(within(filterDialog).getByRole("button", { name: "Apply" }));
    expect(within(teamTable).getByText("Core")).toBeTruthy();
    fireEvent.click(within(teamCard).getByRole("button", { name: /Remove filter: Members/u }));
    fireEvent.click(within(teamCard).getByRole("button", { name: /Filters and sorting/u }));
    filterDialog = screen.getByRole("dialog", { name: "Filters and sorting" });
    fireEvent.click(within(filterDialog).getByRole("button", { name: /Add condition/u }));
    fireEvent.change(within(filterDialog).getAllByLabelText("Field")[1]!, { target: { value: "name" } });
    fireEvent.change(within(filterDialog).getAllByLabelText("Value")[1]!, { target: { value: "Nobody" } });
    fireEvent.click(within(filterDialog).getByRole("button", { name: "Apply" }));
    expect(within(teamTable).queryByText("Core")).toBeNull();

    rendered.rerender(<AdminWorkspace api={api} draft={draft} role="Maintainer" locale="en" surface="settings" onChanged={changed} />);
    const statusesCard = (await screen.findByRole("heading", { name: "Statuses" })).closest<HTMLElement>(".config-editor")!;
    expect(within(statusesCard).getByText("Backlog").closest<HTMLElement>(".config-preview")?.style.backgroundColor).toBe("rgb(238, 240, 242)");
    fireEvent.click(within(statusesCard).getByRole("button", { name: "Edit Statuses" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit: Statuses" });
    expect(within(dialog).getAllByText("Technical ID")).toHaveLength(2);
    expect(within(dialog).getByRole("switch", { name: "Active: Backlog" })).toBeTruthy();
    const statusTitle = within(dialog).getByLabelText("Statuses backlog");
    expect((within(dialog).getByLabelText("Status category accepted") as HTMLSelectElement).value).toBe("done");
    fireEvent.change(within(dialog).getByLabelText("Status category backlog"), { target: { value: "active" } });
    fireEvent.change(statusTitle, { target: { value: "Queue" } });
    const statusRow = statusTitle.closest<HTMLElement>(".config-row")!;
    expect(statusRow.querySelector(".config-preview")?.textContent).toBe("Queue");
    const colorPalette = within(statusRow).getByRole("group", { name: "Color backlog" });
    expect(within(colorPalette).queryByRole("textbox")).toBeNull();
    expect(within(colorPalette).queryByRole("combobox")).toBeNull();
    expect(within(colorPalette).getByRole("button", { name: "Use Gray for Queue" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(colorPalette).getByRole("button", { name: "Use Blue for Queue" }));
    expect(within(colorPalette).getByRole("button", { name: "Use Blue for Queue" }).getAttribute("aria-pressed")).toBe("true");
    expect(statusRow.querySelector<HTMLElement>(".config-preview")?.style.backgroundColor).toBe("rgb(233, 240, 255)");
    expect(statusRow.textContent).not.toContain("blue");
    fireEvent.click(within(dialog).getByRole("switch", { name: "Active: Queue" }));
    fireEvent.submit(statusTitle.closest("form")!);
    await waitFor(() => expect((admin.configurations.get("statuses")!.document.statuses as readonly { title: string; color: string; active: boolean; category: string }[])[0]).toMatchObject({ title: "Queue", color: "blue", active: false, category: "active" }));
    fireEvent.click(within(statusesCard).getByRole("button", { name: "Edit Statuses" }));
    fireEvent.change(screen.getByLabelText("Statuses backlog"), { target: { value: "Unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Edit: Statuses" })).toBeNull();
    fireEvent.click(within(statusesCard).getByRole("button", { name: "Edit Statuses" }));
    expect((screen.getByLabelText("Statuses backlog") as HTMLInputElement).value).toBe("Queue");
    const updatesBeforeCancel = changed.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Statuses backlog"), { target: { value: "Cancelled rename" } });
    fireEvent.click(screen.getByRole("button", { name: "Move Cancelled rename down" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(changed.mock.calls).toHaveLength(updatesBeforeCancel);
    expect((admin.configurations.get("statuses")!.document.statuses as readonly { slug: string; title: string }[])[0]).toMatchObject({ slug: "backlog", title: "Queue" });

    fireEvent.click(within(statusesCard).getByRole("button", { name: "Edit Statuses" }));
    fireEvent.click(screen.getByRole("button", { name: "Move Queue down" }));
    fireEvent.change(screen.getByLabelText("New technical ID"), { target: { value: "review" } });
    fireEvent.click(screen.getByRole("button", { name: "Add value" }));
    fireEvent.submit(screen.getByLabelText("Statuses backlog").closest("form")!);
    await waitFor(() => expect((admin.configurations.get("statuses")!.document.statuses as readonly { slug: string }[])[0]?.slug).toBe("accepted"));
    expect((admin.configurations.get("statuses")!.document.statuses as readonly { slug: string }[]).some((item) => item.slug === "review")).toBe(true);
    expect(changed).toHaveBeenCalled();
  });

  it("preserves current archived members when a team is edited", async () => {
    const admin = new AdminApi(); const api = admin as unknown as GitPmApi;
    const activePersonId = "U-26-ACTIVE"; const archivedMemberId = "U-26-FORMER"; const otherArchivedId = "U-26-OTHER"; const teamId = "G-26-CORE";
    admin.entities = [
      { document: { schema: "gitpm/person@1", id: activePersonId, name: "Alice", weekly_capacity_hours: 40, calendar: "C-26-DEFAULT", lifecycle: "active" }, path: `${activePersonId}.yaml`, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) },
      { document: { schema: "gitpm/person@1", id: archivedMemberId, name: "Former member", weekly_capacity_hours: 40, calendar: "C-26-DEFAULT", lifecycle: "archived" }, path: `${archivedMemberId}.yaml`, blob_id: "c".repeat(40), draft_fingerprint: "b".repeat(64) },
      { document: { schema: "gitpm/person@1", id: otherArchivedId, name: "Other former member", weekly_capacity_hours: 40, calendar: "C-26-DEFAULT", lifecycle: "archived" }, path: `${otherArchivedId}.yaml`, blob_id: "d".repeat(40), draft_fingerprint: "b".repeat(64) },
      { document: { schema: "gitpm/team@1", id: teamId, name: "Core", members: [activePersonId, archivedMemberId], lifecycle: "active" }, path: `${teamId}.yaml`, blob_id: "e".repeat(40), draft_fingerprint: "b".repeat(64) },
    ];

    render(<AdminWorkspace api={api} draft={draft} role="Maintainer" locale="en" surface="people" onChanged={vi.fn(async () => undefined)} />);
    const editTeam = await screen.findByRole("button", { name: "Edit team" });
    const teamTable = document.querySelector<HTMLElement>(".team-directory-table")!;
    expect(within(teamTable).getByText("Former member")).toBeTruthy();
    fireEvent.click(editTeam);
    const dialog = screen.getByRole("dialog", { name: "Edit team: Core" });
    expect((within(dialog).getByLabelText("Former member") as HTMLInputElement).checked).toBe(true);
    expect(within(dialog).queryByLabelText("Other former member")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Name Core"), { target: { value: "Core renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(admin.entities.find((item) => item.document.id === teamId)?.document).toMatchObject({ name: "Core renamed", members: [activePersonId, archivedMemberId] }));
  });

  it("loads, displays and updates the schedule tracks configuration", async () => {
    const admin = new AdminApi(); const api = admin as unknown as GitPmApi; const changed = vi.fn(async () => undefined);
    render(<AdminWorkspace api={api} draft={draft} role="Maintainer" locale="en" surface="settings" onChanged={changed} />);

    const tracksCard = (await screen.findByRole("heading", { name: "Schedule tracks" })).closest<HTMLElement>(".config-editor")!;
    expect(admin.configurationReads).toContain("schedule-tracks");
    expect(within(tracksCard).getByText("Plan")).toBeTruthy();
    expect(within(tracksCard).getByText("Target")).toBeTruthy();
    expect(within(tracksCard).getAllByText("Actual")).toHaveLength(2);

    fireEvent.click(within(tracksCard).getByRole("button", { name: "Edit Schedule tracks" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit: Schedule tracks" });
    expect((within(dialog).getByLabelText("Track kind plan") as HTMLSelectElement).value).toBe("manual");
    expect(within(dialog).getByText("Time entries")).toBeTruthy();
    const planTitle = within(dialog).getByLabelText("Schedule tracks plan");
    fireEvent.change(planTitle, { target: { value: "Working plan" } });
    const targetRow = within(dialog).getByLabelText("Schedule tracks target").closest<HTMLElement>(".config-row")!;
    fireEvent.click(within(targetRow).getByLabelText("Dependencies"));
    fireEvent.change(within(dialog).getByLabelText("New track technical ID"), { target: { value: "forecast" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add manual track" }));
    fireEvent.change(within(dialog).getByLabelText("Primary track"), { target: { value: "target" } });
    fireEvent.submit(planTitle.closest("form")!);

    await waitFor(() => expect(admin.configurations.get("schedule-tracks")!.document).toMatchObject({
      tracks: [expect.objectContaining({ slug: "plan", title: "Working plan", kind: "manual", capabilities: ["dates", "effort", "dependencies"] }), expect.objectContaining({ slug: "target", capabilities: ["dates", "dependencies"] }), expect.objectContaining({ slug: "actual", source: "time_entries" }), expect.objectContaining({ slug: "forecast", kind: "manual", capabilities: ["dates"] })],
      defaults: { enabled_tracks: ["plan", "target", "actual"], primary_track: "target", workload_track: "plan", comparison_track: "target", dashboard_tracks: ["plan", "target", "actual"] },
    }));
    expect(changed).toHaveBeenCalled();
  });

  it("explains schedule tracks and their roles in the Russian editor", async () => {
    const admin = new AdminApi(); const api = admin as unknown as GitPmApi;
    render(<AdminWorkspace api={api} draft={draft} role="Maintainer" locale="ru" surface="settings" onChanged={vi.fn(async () => undefined)} />);

    const tracksCard = (await screen.findByRole("heading", { name: "Контуры расписания" })).closest<HTMLElement>(".config-editor")!;
    fireEvent.click(within(tracksCard).getByRole("button", { name: "Редактировать: Контуры расписания" }));
    const dialog = await screen.findByRole("dialog", { name: "Редактировать: Контуры расписания" });
    const hint = dialog.querySelector<HTMLElement>(".schedule-tracks-hint")!;
    expect(within(hint).getByText(/Контур — это отдельный вариант расписания/u)).toBeTruthy();
    expect(within(hint).getByText(/Ручные контуры заполняются пользователями/u)).toBeTruthy();
    expect(within(hint).getByText(/основной контур используется как рабочее расписание/u)).toBeTruthy();
  });

  it("changes the repository default calendar and UI polling interval", async () => {
    const admin = new AdminApi(); const api = admin as unknown as GitPmApi;
    const onOpenCalendar = vi.fn();
    await admin.createEntity("DRF-ADMIN", "calendars", "", { schema: "gitpm/calendar@1", id: "C-26-111111", name: "Old default", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" });
    await admin.createEntity("DRF-ADMIN", "calendars", "", { schema: "gitpm/calendar@1", id: "C-26-222222", name: "New default", working_weekdays: [1, 2, 3, 4, 5, 6, 7], holidays: ["2026-08-17"], lifecycle: "active" });
    render(<AdminWorkspace api={api} draft={draft} role="Maintainer" locale="en" surface="settings" onOpenCalendar={onOpenCalendar} onChanged={vi.fn(async () => undefined)} />);
    const repositoryCard = (await screen.findByRole("heading", { name: "Repository settings" })).closest<HTMLElement>(".config-editor")!;
    const calendarSummary = repositoryCard.querySelector<HTMLElement>(".repository-default-calendar")!;
    expect(within(calendarSummary).getByText("C-26-111111")).toBeTruthy();
    expect(within(calendarSummary).getByLabelText("Working week preview").querySelectorAll(".working")).toHaveLength(5);
    expect(within(calendarSummary).getByText(/Used for new people/u)).toBeTruthy();
    fireEvent.click(within(calendarSummary).getByRole("button", { name: "Old default" }));
    expect(onOpenCalendar).toHaveBeenLastCalledWith("C-26-111111");
    fireEvent.click(within(calendarSummary).getByRole("button", { name: "Open calendar" }));
    expect(onOpenCalendar).toHaveBeenLastCalledWith("C-26-111111");
    fireEvent.click(within(repositoryCard).getByRole("button", { name: "Edit Repository settings" }));
    const dialog = screen.getByRole("dialog", { name: "Edit: Repository settings" });
    fireEvent.change(within(dialog).getByLabelText("Repository default calendar"), { target: { value: "C-26-222222" } });
    const selectedPreview = dialog.querySelector<HTMLElement>(".repository-calendar-selection-preview")!;
    expect(within(selectedPreview).getByLabelText("Working week preview").querySelectorAll(".working")).toHaveLength(7);
    expect(within(selectedPreview).getByText("C-26-222222")).toBeTruthy();
    expect(selectedPreview.querySelector("time")?.getAttribute("datetime")).toBe("2026-08-17");
    fireEvent.click(within(selectedPreview).getByRole("button", { name: "Open selected calendar" }));
    expect(onOpenCalendar).toHaveBeenLastCalledWith("C-26-222222");
    fireEvent.change(within(dialog).getByLabelText("UI polling interval"), { target: { value: "7" } });
    fireEvent.submit(within(dialog).getByRole("button", { name: "Save" }).closest("form")!);
    await waitFor(() => expect(admin.repository?.document).toMatchObject({ default_calendar: "C-26-222222", ui_poll_interval_seconds: 7 }));
  });

  it("opens the editor for a calendar selected by a deep link", async () => {
    const admin = new AdminApi(); const api = admin as unknown as GitPmApi;
    await admin.createEntity("DRF-ADMIN", "calendars", "", { schema: "gitpm/calendar@1", id: "C-26-111111", name: "Deep linked", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" });
    render(<AdminWorkspace api={api} draft={draft} initialCalendarId="C-26-111111" role="Maintainer" locale="en" surface="calendar" onChanged={vi.fn(async () => undefined)} />);

    expect(await screen.findByRole("dialog", { name: "Edit calendar: Deep linked" })).toBeTruthy();
  });

  it("shows concrete reference blockers instead of submitting an unsafe configuration update", async () => {
    const admin = new AdminApi(); const api = admin as unknown as GitPmApi;
    admin.configurationImpact = { blocking: true, issues: [{ code: "CONFIG_REFERENCE", path: "projects/P-26-111111/views/V-26-333333.yaml", field: "filters.statuses", message: "Status backlog is still in use" }] };
    const onOpenView = vi.fn();
    render(<AdminWorkspace api={api} draft={draft} role="Maintainer" locale="en" surface="settings" onOpenView={onOpenView} onChanged={vi.fn(async () => undefined)} />);
    const statusesCard = (await screen.findByRole("heading", { name: "Statuses" })).closest<HTMLElement>(".config-editor")!;
    fireEvent.click(within(statusesCard).getByRole("button", { name: "Edit Statuses" }));
    const dialog = screen.getByRole("dialog", { name: "Edit: Statuses" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Backlog" }));
    fireEvent.submit(within(dialog).getByRole("button", { name: "Save" }).closest("form")!);
    expect(await within(dialog).findByText(/projects\/P-26-111111\/views\/V-26-333333.yaml/u)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open blocking view" }));
    expect(onOpenView).toHaveBeenCalledWith("P-26-111111", "V-26-333333");
    expect(admin.configurationUpdates).toBe(0);
  });

  it("creates the official Russian 2026 preset with understandable defaults", async () => {
    const admin = new AdminApi(); const api = admin as unknown as GitPmApi;
    render(<AdminWorkspace api={api} draft={draft} role="Maintainer" locale="ru" surface="calendar" onChanged={vi.fn(async () => undefined)} />);

    fireEvent.click(await screen.findByRole("button", { name: /Создать календарь/u }));
    const dialog = screen.getByRole("dialog", { name: "Создать календарь" });
    const form = within(dialog).getByRole("button", { name: "Создать календарь" }).closest("form")!;
    fireEvent.change(within(form).getByLabelText("Предустановка календаря"), { target: { value: "russia-2026-five-day" } });

    expect((within(form).getByLabelText("Название") as HTMLInputElement).value).toBe("Россия — пятидневка (2026)");
    expect(within(form).getByText("2026: 247 рабочих дней")).toBeTruthy();
    expect(within(form).getByRole("link", { name: "Официальный источник" }).getAttribute("href")).toBe("https://government.ru/news/56309/");
    expect(within(form).getAllByLabelText(/Нерабочая дата/u)).toHaveLength(14);
    fireEvent.submit(form);

    await waitFor(() => expect(admin.entities).toHaveLength(1));
    expect(admin.entities[0]?.document).toMatchObject({
      schema: "gitpm/calendar@1",
      name: "Россия — пятидневка (2026)",
      working_weekdays: [1, 2, 3, 4, 5],
      holidays: expect.arrayContaining(["2026-01-09", "2026-11-04", "2026-12-31"]),
      lifecycle: "active",
    });
    expect(admin.entities[0]?.document.holidays).toHaveLength(14);
  });

  it("renders Developer administration as read-only", async () => {
    const admin = new AdminApi(); const api = admin as unknown as GitPmApi;
    render(<AdminWorkspace api={api} draft={draft} role="Developer" locale="en" surface="calendar" onChanged={vi.fn(async () => undefined)} />);
    expect(await screen.findByText("Administrative changes require Maintainer.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Create calendar/u }) as HTMLButtonElement).disabled).toBe(true);
    expect(admin.mutations).toBe(0);
  });

  it("blocks default-calendar archival and deletion until another default is selected", async () => {
    const admin = new AdminApi(); const api = admin as unknown as GitPmApi;
    await admin.createEntity("DRF-ADMIN", "calendars", "", { schema: "gitpm/calendar@1", id: "C-26-111111", name: "Default", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" });
    await admin.createEntity("DRF-ADMIN", "calendars", "", { schema: "gitpm/calendar@1", id: "C-26-222222", name: "Replacement", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" });
    const confirmAction = vi.fn(() => true);
    const rendered = render(<AdminWorkspace api={api} confirmAction={confirmAction} draft={draft} role="Maintainer" locale="en" surface="calendar" onChanged={vi.fn(async () => undefined)} />);
    await screen.findByText(/Default \(Repository default calendar\)/u);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit calendar" })[0]!);

    const deleteButton = screen.getByRole("button", { name: "Delete" });
    expect(deleteButton.className).toContain("danger");
    expect((screen.getByRole("button", { name: "Archive" }) as HTMLButtonElement).disabled).toBe(true);
    expect((deleteButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Choose another repository default calendar/u)).toBeTruthy();
    fireEvent.click(deleteButton);
    expect(confirmAction).not.toHaveBeenCalled();
    expect(admin.entities.some((item) => item.document.id === "C-26-111111")).toBe(true);

    rendered.rerender(<AdminWorkspace api={api} confirmAction={confirmAction} draft={draft} role="Maintainer" locale="en" surface="settings" onChanged={vi.fn(async () => undefined)} />);
    const repositoryCard = (await screen.findByRole("heading", { name: "Repository settings" })).closest<HTMLElement>(".config-editor")!;
    fireEvent.click(within(repositoryCard).getByRole("button", { name: "Edit Repository settings" }));
    fireEvent.change(screen.getByLabelText("Repository default calendar"), { target: { value: "C-26-222222" } });
    fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form")!);
    await waitFor(() => expect(admin.repository?.document.default_calendar).toBe("C-26-222222"));

    rendered.rerender(<AdminWorkspace api={api} confirmAction={confirmAction} draft={draft} role="Maintainer" locale="en" surface="calendar" onChanged={vi.fn(async () => undefined)} />);
    await screen.findByText(/^Default$/u);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit calendar" })[0]!);
    const enabledDelete = screen.getByRole("button", { name: "Delete" });
    expect((enabledDelete as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(enabledDelete);
    expect(confirmAction).toHaveBeenCalledWith("Delete Default permanently? This action cannot be undone.");
    await waitFor(() => expect(screen.queryByText(/Default \(Repository default calendar\)/u)).toBeNull());
    expect(admin.entities.some((item) => item.document.id === "C-26-111111")).toBe(false);
  });

  it("shows each person's projects as clickable links in the people directory", async () => {
    const personId = "U-26-ADA";
    const ownedProjectId = "P-26-ALPHA";
    const taskProjectId = "P-26-BETA";
    const admin = new AdminApi(); const api = admin as unknown as GitPmApi;
    await admin.createEntity("DRF-ADMIN", "calendars", "", { schema: "gitpm/calendar@1", id: "CAL-26-DEFAULT", name: "Default", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" });
    await admin.createEntity("DRF-ADMIN", "people", "", { schema: "gitpm/person@1", id: personId, name: "Ada", weekly_capacity_hours: 32, calendar: "CAL-26-DEFAULT", lifecycle: "active" });
    await admin.createEntity("DRF-ADMIN", "projects", "", { schema: "gitpm/project@2", id: ownedProjectId, name: "Alpha", owner: personId, status: "in-progress", lifecycle: "active" });
    await admin.createEntity("DRF-ADMIN", "projects", "", { schema: "gitpm/project@2", id: taskProjectId, name: "Beta", owner: "U-26-OTHER", status: "planned", lifecycle: "active" });
    await admin.createEntity("DRF-ADMIN", "tasks", "", { schema: "gitpm/task@2", id: "T-26-REVIEW", project: taskProjectId, title: "Review", status: "planned", assignees: [personId], lifecycle: "active" });
    const onOpenProject = vi.fn();
    render(<AdminWorkspace api={api} draft={draft} role="Maintainer" locale="en" surface="people" onOpenProject={onOpenProject} onChanged={vi.fn(async () => undefined)} />);

    await screen.findByText("Ada");
    const peopleTable = document.querySelector<HTMLElement>(".people-directory-table")!;
    expect(within(peopleTable).getByRole("columnheader", { name: "Projects" })).toBeTruthy();
    expect(within(peopleTable).getByRole("link", { name: "Alpha" })).toBeTruthy();
    expect(within(peopleTable).getByRole("link", { name: "Beta" })).toBeTruthy();
    fireEvent.click(within(peopleTable).getByRole("link", { name: "Alpha" }));
    expect(onOpenProject).toHaveBeenCalledWith(ownedProjectId);
  });
});
