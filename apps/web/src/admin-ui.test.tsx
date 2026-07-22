// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { AdminWorkspace } from "./admin-ui.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "./types.js";

const draft: DraftStatus = { draft_id: "DRF-ADMIN", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-ADMIN", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" };
const configDocument = (kind: "statuses" | "issue-types") => (kind === "statuses" ? { schema: "gitpm/statuses@1", id: "CONFIG-STATUSES", lifecycle: "active", statuses: [{ slug: "backlog", title: "Backlog", color: "#808080", active: true }, { slug: "done", title: "Done", color: "#228b22", active: true }] } : { schema: "gitpm/issue-types@1", id: "CONFIG-TYPES", lifecycle: "active", issue_types: [{ slug: "task", title: "Task", color: "#0000ff", active: true }] }) as GitPmDocument;

class AdminApi {
  entities: EntityResult[] = [];
  configurations = new Map<"statuses" | "issue-types", EntityResult>([["statuses", this.config("statuses")], ["issue-types", this.config("issue-types")]]);
  mutations = 0;
  private config(kind: "statuses" | "issue-types"): EntityResult { return { document: configDocument(kind), path: `.gitpm/${kind}.yaml`, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) }; }
  private result(document: GitPmDocument): EntityResult { this.mutations += 1; return { document, path: `${document.id}.yaml`, blob_id: String(this.mutations).padStart(40, "a"), draft_fingerprint: String(this.mutations).padStart(64, "b") }; }
  async listEntities(_draftId: string, type: string) { const names: Record<string, string> = { calendars: "calendar", people: "person", teams: "team" }; return this.entities.filter((item) => item.document.schema === `gitpm/${names[type] ?? type.slice(0, -1)}@1`); }
  async createEntity(_draftId: string, _type: string, _fingerprint: string, document: GitPmDocument) { const result = this.result(document); this.entities.push(result); return result; }
  async updateEntity(_draftId: string, _type: string, entity: EntityResult, _fingerprint: string, document: GitPmDocument) { const result = this.result(document); this.entities = this.entities.map((item) => item === entity ? result : item); return result; }
  async archiveEntity(draftId: string, type: string, entity: EntityResult, fingerprint: string) { return await this.updateEntity(draftId, type, entity, fingerprint, { ...entity.document, lifecycle: "archived" }); }
  async deleteEntity(_draftId: string, _type: string, entity: EntityResult) { this.mutations += 1; this.entities = this.entities.filter((item) => item !== entity); }
  async getConfiguration(_draftId: string, kind: "statuses" | "issue-types") { return this.configurations.get(kind)!; }
  async updateConfiguration(_draftId: string, kind: "statuses" | "issue-types", _entity: EntityResult, _fingerprint: string, document: GitPmDocument) { const result = this.result(document); this.configurations.set(kind, result); return result; }
}

afterEach(cleanup);

describe("administration UI", () => {
  it("lets Maintainer create Calendar, Person and Team and edit statuses", async () => {
    const admin = new AdminApi(); const api = admin as unknown as GitPmApi; const changed = vi.fn(async () => undefined);
    const rendered = render(<AdminWorkspace api={api} draft={draft} role="Maintainer" locale="en" surface="calendar" onChanged={changed} />);
    fireEvent.click(await screen.findByRole("button", { name: /Create calendar/u }));
    const calendarForm = within(screen.getByRole("dialog", { name: "Create calendar" })).getByRole("button", { name: "Create calendar" }).closest("form")!;
    fireEvent.change(within(calendarForm).getByLabelText("Name"), { target: { value: "Default" } });
    fireEvent.change(within(calendarForm).getByLabelText("Holidays (YYYY-MM-DD, comma-separated)"), { target: { value: "2026-01-01" } }); fireEvent.submit(calendarForm);
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
    fireEvent.click(within(statusesCard).getByRole("button", { name: "Edit" }));
    const statusTitle = await screen.findByLabelText("Statuses backlog"); fireEvent.change(statusTitle, { target: { value: "Queue" } }); fireEvent.submit(statusTitle.closest("form")!);
    await waitFor(() => expect((admin.configurations.get("statuses")!.document.statuses as Array<{ title: string }>)[0]?.title).toBe("Queue"));
    fireEvent.click(within(statusesCard).getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Move Queue down" }));
    expect(screen.getByLabelText("Statuses backlog").closest(".config-row")?.classList.contains("is-saving")).toBe(true);
    expect(screen.getByLabelText("Statuses done").closest(".config-row")?.classList.contains("is-saving")).toBe(true);
    await waitFor(() => expect(screen.getByLabelText("Statuses backlog").closest(".config-row")?.classList.contains("recently-changed")).toBe(true));
    expect(screen.getByLabelText("Statuses done").closest(".config-row")?.classList.contains("recently-changed")).toBe(true);
    await waitFor(() => expect((admin.configurations.get("statuses")!.document.statuses as Array<{ slug: string }>)[0]?.slug).toBe("done"));
    expect(changed).toHaveBeenCalled();
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
});
