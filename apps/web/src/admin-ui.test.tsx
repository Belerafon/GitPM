// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { AdminWorkspace } from "./admin-ui.js";
import type { ConfigurationDocument, ConfigurationResult, DraftStatus, EntityDocument, EntityResult } from "./types.js";

const draft: DraftStatus = { draft_id: "DRF-ADMIN", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-ADMIN", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" };
const configDocument = (kind: "statuses" | "issue-types") => (kind === "statuses" ? { schema: "gitpm/statuses@1", statuses: [{ slug: "backlog", title: "Backlog", color: "gray", active: true }, { slug: "done", title: "Done", color: "green", active: true }] } : { schema: "gitpm/issue-types@1", issue_types: [{ slug: "task", title: "Task", color: "blue", active: true }] }) as ConfigurationDocument;

class AdminApi {
  entities: EntityResult[] = [];
  configurations = new Map<"statuses" | "issue-types", ConfigurationResult>([["statuses", this.config("statuses")], ["issue-types", this.config("issue-types")]]);
  mutations = 0;
  private config(kind: "statuses" | "issue-types"): ConfigurationResult { return { document: configDocument(kind), path: `.gitpm/${kind}.yaml`, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) }; }
  private result(document: EntityDocument): EntityResult { this.mutations += 1; return { document, path: `${document.id}.yaml`, blob_id: String(this.mutations).padStart(40, "a"), draft_fingerprint: String(this.mutations).padStart(64, "b") }; }
  async listEntities(_draftId: string, type: string) { const names: Record<string, string> = { calendars: "calendar", people: "person", teams: "team" }; return this.entities.filter((item) => item.document.schema === `gitpm/${names[type] ?? type.slice(0, -1)}@1`); }
  async createEntity(_draftId: string, _type: string, _fingerprint: string, document: EntityDocument) { const result = this.result(document); this.entities.push(result); return result; }
  async updateEntity(_draftId: string, _type: string, entity: EntityResult, _fingerprint: string, document: EntityDocument) { const result = this.result(document); this.entities = this.entities.map((item) => item === entity ? result : item); return result; }
  async archiveEntity(draftId: string, type: string, entity: EntityResult, fingerprint: string) { return await this.updateEntity(draftId, type, entity, fingerprint, { ...entity.document, lifecycle: "archived" }); }
  async deleteEntity(_draftId: string, _type: string, entity: EntityResult) { this.mutations += 1; this.entities = this.entities.filter((item) => item !== entity); }
  async getConfiguration(_draftId: string, kind: "statuses" | "issue-types") { return this.configurations.get(kind)!; }
  async updateConfiguration(_draftId: string, kind: "statuses" | "issue-types", entity: ConfigurationResult, _fingerprint: string, document: ConfigurationDocument) { const result: ConfigurationResult = { ...entity, document }; this.configurations.set(kind, result); return result; }
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
    expect(await screen.findByText("Default")).toBeTruthy();
    expect(screen.getByLabelText("Working week preview").querySelectorAll(".working")).toHaveLength(5);

    const onOpenPerson = vi.fn();
    rendered.rerender(<AdminWorkspace api={api} draft={draft} role="Maintainer" locale="en" onOpenPerson={onOpenPerson} surface="people" onChanged={changed} />);
    fireEvent.click(await screen.findByRole("button", { name: /Create person/u }));
    const personForm = within(screen.getByRole("dialog", { name: "Create person" })).getByRole("button", { name: "Create person" }).closest("form")!;
    fireEvent.change(within(personForm).getByLabelText("Name"), { target: { value: "Alice" } }); fireEvent.change(within(personForm).getByLabelText("Weekly capacity (hours)"), { target: { value: "32" } }); fireEvent.submit(personForm);
    expect(await screen.findByText("Alice")).toBeTruthy();
    expect(document.querySelectorAll(".people-directory-table tbody tr")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Edit person" })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Alice" }));
    expect(onOpenPerson).toHaveBeenCalledWith(expect.stringMatching(/^U-/u));
    fireEvent.click(screen.getByRole("button", { name: /Create team/u }));
    const teamForm = within(screen.getByRole("dialog", { name: "Create team" })).getByRole("button", { name: "Create team" }).closest("form")!;
    fireEvent.change(within(teamForm).getByLabelText("Name"), { target: { value: "Core" } }); fireEvent.click(within(teamForm).getByLabelText("Alice")); fireEvent.submit(teamForm);
    const teamTable = document.querySelector<HTMLElement>(".team-directory-table")!;
    expect(await within(teamTable).findByText("Core")).toBeTruthy();
    expect(admin.entities.find((item) => item.document.schema === "gitpm/team@1")?.document.members).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Search teams or members"), { target: { value: "Alice" } });
    expect(within(teamTable).getByText("Core")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search teams or members"), { target: { value: "Nobody" } });
    expect(within(teamTable).queryByText("Core")).toBeNull();

    rendered.rerender(<AdminWorkspace api={api} draft={draft} role="Maintainer" locale="en" surface="settings" onChanged={changed} />);
    const statusesCard = (await screen.findByRole("heading", { name: "Statuses" })).closest<HTMLElement>(".config-editor")!;
    expect(within(statusesCard).getByText("Backlog").closest<HTMLElement>(".config-preview")?.style.backgroundColor).toBe("rgb(238, 240, 242)");
    fireEvent.click(within(statusesCard).getByRole("button", { name: "Edit Statuses" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit: Statuses" });
    expect(within(dialog).getAllByText("Technical ID")).toHaveLength(2);
    expect(within(dialog).getByRole("switch", { name: "Active: Backlog" })).toBeTruthy();
    const statusTitle = within(dialog).getByLabelText("Statuses backlog");
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
    await waitFor(() => expect((admin.configurations.get("statuses")!.document.statuses as readonly { title: string; color: string; active: boolean }[])[0]).toMatchObject({ title: "Queue", color: "blue", active: false }));
    fireEvent.click(within(statusesCard).getByRole("button", { name: "Edit Statuses" }));
    fireEvent.change(screen.getByLabelText("Statuses backlog"), { target: { value: "Unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Edit: Statuses" })).toBeNull();
    fireEvent.click(within(statusesCard).getByRole("button", { name: "Edit Statuses" }));
    expect((screen.getByLabelText("Statuses backlog") as HTMLInputElement).value).toBe("Queue");
    fireEvent.click(screen.getByRole("button", { name: "Move Queue down" }));
    expect(screen.getByLabelText("Statuses backlog").closest(".config-row")?.classList.contains("is-saving")).toBe(true);
    expect(screen.getByLabelText("Statuses done").closest(".config-row")?.classList.contains("is-saving")).toBe(true);
    await waitFor(() => expect(screen.getByLabelText("Statuses backlog").closest(".config-row")?.classList.contains("recently-changed")).toBe(true));
    expect(screen.getByLabelText("Statuses done").closest(".config-row")?.classList.contains("recently-changed")).toBe(true);
    await waitFor(() => expect((admin.configurations.get("statuses")!.document.statuses as readonly { slug: string }[])[0]?.slug).toBe("done"));
    expect(changed).toHaveBeenCalled();
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

  it("keeps archive reversible and confirms permanent administration deletion", async () => {
    const admin = new AdminApi(); const api = admin as unknown as GitPmApi;
    await admin.createEntity("DRF-ADMIN", "calendars", "", { schema: "gitpm/calendar@1", id: "CAL-26-111111", name: "Default", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" });
    const confirmAction = vi.fn(() => false);
    render(<AdminWorkspace api={api} confirmAction={confirmAction} draft={draft} role="Maintainer" locale="en" surface="calendar" onChanged={vi.fn(async () => undefined)} />);
    await screen.findByText("Default");
    fireEvent.click(screen.getByRole("button", { name: "Edit calendar" }));

    const deleteButton = screen.getByRole("button", { name: "Delete" });
    expect(deleteButton.className).toContain("danger");
    expect(screen.getByRole("button", { name: "Archive" }).className).not.toContain("danger");
    fireEvent.click(deleteButton);
    expect(confirmAction).toHaveBeenCalledWith("Delete Default permanently? This action cannot be undone.");
    expect(screen.getByRole("dialog", { name: "Edit calendar: Default" })).toBeTruthy();

    confirmAction.mockReturnValue(true);
    fireEvent.click(deleteButton);
    await waitFor(() => expect(screen.queryByText("Default")).toBeNull());
  });

  it("shows each person's projects as clickable links in the people directory", async () => {
    const personId = "U-26-ADA";
    const ownedProjectId = "P-26-ALPHA";
    const taskProjectId = "P-26-BETA";
    const admin = new AdminApi(); const api = admin as unknown as GitPmApi;
    await admin.createEntity("DRF-ADMIN", "calendars", "", { schema: "gitpm/calendar@1", id: "CAL-26-DEFAULT", name: "Default", working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" });
    await admin.createEntity("DRF-ADMIN", "people", "", { schema: "gitpm/person@1", id: personId, name: "Ada", weekly_capacity_hours: 32, calendar: "CAL-26-DEFAULT", lifecycle: "active" });
    await admin.createEntity("DRF-ADMIN", "projects", "", { schema: "gitpm/project@1", id: ownedProjectId, name: "Alpha", owner: personId, status: "in-progress", lifecycle: "active" });
    await admin.createEntity("DRF-ADMIN", "projects", "", { schema: "gitpm/project@1", id: taskProjectId, name: "Beta", owner: "U-26-OTHER", status: "planned", lifecycle: "active" });
    await admin.createEntity("DRF-ADMIN", "tasks", "", { schema: "gitpm/task@1", id: "T-26-REVIEW", project: taskProjectId, title: "Review", status: "planned", assignees: [personId], lifecycle: "active" });
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
