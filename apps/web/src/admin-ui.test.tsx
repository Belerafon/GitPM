// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { AdminWorkspace } from "./admin-ui.js";
import type { DraftStatus, EntityResult, GitPmDocument } from "./types.js";

const draft: DraftStatus = { draft_id: "DRF-ADMIN", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-ADMIN", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" };
const configDocument = (kind: "statuses" | "issue-types") => (kind === "statuses" ? { schema: "gitpm/statuses@1", id: "CONFIG-STATUSES", lifecycle: "active", statuses: [{ slug: "backlog", title: "Backlog", color: "gray", active: true }] } : { schema: "gitpm/issue-types@1", id: "CONFIG-TYPES", lifecycle: "active", issue_types: [{ slug: "task", title: "Task", color: "blue", active: true }] }) as GitPmDocument;

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
  it("lets Maintainer create Calendar, Person and Team and edit repository configuration", async () => {
    const admin = new AdminApi(); const api = admin as unknown as GitPmApi; const changed = vi.fn(async () => undefined);
    const rendered = render(<AdminWorkspace api={api} draft={draft} role="Maintainer" locale="en" surface="calendar" onChanged={changed} />);
    const calendarButton = await screen.findByRole("button", { name: "Create calendar" }); const calendarForm = calendarButton.closest("form")!;
    fireEvent.change(within(calendarForm).getByLabelText("Name"), { target: { value: "Default" } });
    fireEvent.change(within(calendarForm).getByLabelText("Holidays (YYYY-MM-DD, comma-separated)"), { target: { value: "2026-01-01" } }); fireEvent.submit(calendarForm);
    expect(await screen.findByDisplayValue("Default")).toBeTruthy();

    rendered.rerender(<AdminWorkspace api={api} draft={draft} role="Maintainer" locale="en" surface="people" onChanged={changed} />);
    const personButton = await screen.findByRole("button", { name: "Create person" }); const personForm = personButton.closest("form")!;
    fireEvent.change(within(personForm).getByLabelText("Name"), { target: { value: "Alice" } }); fireEvent.change(within(personForm).getByLabelText("Weekly capacity (hours)"), { target: { value: "32" } }); fireEvent.submit(personForm);
    expect(await screen.findByDisplayValue("Alice")).toBeTruthy();
    const teamButton = screen.getByRole("button", { name: "Create team" }); const teamForm = teamButton.closest("form")!;
    fireEvent.change(within(teamForm).getByLabelText("Name"), { target: { value: "Core" } }); fireEvent.click(within(teamForm).getByLabelText("Alice")); fireEvent.submit(teamForm);
    expect(await screen.findByDisplayValue("Core")).toBeTruthy();
    expect(admin.entities.find((item) => item.document.schema === "gitpm/team@1")?.document.members).toHaveLength(1);

    rendered.rerender(<AdminWorkspace api={api} draft={draft} role="Maintainer" locale="en" surface="settings" onChanged={changed} />);
    const statusTitle = await screen.findByLabelText("Statuses backlog"); fireEvent.change(statusTitle, { target: { value: "Queue" } }); fireEvent.submit(statusTitle.closest("form")!);
    await waitFor(() => expect((admin.configurations.get("statuses")!.document.statuses as Array<{ title: string }>)[0]?.title).toBe("Queue"));
    expect(changed).toHaveBeenCalled();
  });

  it("renders Developer administration as read-only", async () => {
    const admin = new AdminApi(); const api = admin as unknown as GitPmApi;
    render(<AdminWorkspace api={api} draft={draft} role="Developer" locale="en" surface="calendar" onChanged={vi.fn(async () => undefined)} />);
    expect(await screen.findByText("Administrative changes require Maintainer.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create calendar" }) as HTMLButtonElement).disabled).toBe(true);
    expect(admin.mutations).toBe(0);
  });
});
