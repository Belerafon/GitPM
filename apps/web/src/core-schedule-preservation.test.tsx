// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { CoreWorkspace } from "./core-ui.js";
import type { ConfigurationDocument, ConfigurationResult, DraftStatus, EntityDocument, EntityResult } from "./types.js";

const draft: DraftStatus = { draft_id: "DRF-CORE", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-CORE", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z" };

function makeResult(document: EntityDocument, revision: number): EntityResult {
  return { document, path: `${document.id}.yaml`, blob_id: String(revision).padStart(40, "a"), draft_fingerprint: String(revision).padStart(64, "b") };
}

class MultiTrackApi {
  entities: EntityResult[] = [];
  revision = 0;
  private result(document: EntityDocument): EntityResult { this.revision += 1; return makeResult(document, this.revision); }
  async listEntities(_draftId: string, type: string, project?: string) {
    const schemas: Record<string, string> = { people: "gitpm/person@1", projects: "gitpm/project@2", tasks: "gitpm/task@2", milestones: "gitpm/milestone@2" };
    return this.entities.filter((item) => item.document.schema === schemas[type] && (project === undefined || item.document.project === project));
  }
  async createEntity(_draftId: string, _type: string, _fingerprint: string, document: EntityDocument) { const next = this.result(document); this.entities.push(next); return next; }
  async updateEntity(_draftId: string, _type: string, entity: EntityResult, _fingerprint: string, document: EntityDocument) { const next = this.result(document); this.entities = this.entities.map((item) => item === entity ? next : item); return next; }
  async archiveEntity(_draftId: string, type: string, entity: EntityResult, fingerprint: string) { return await this.updateEntity(_draftId, type, entity, fingerprint, { ...entity.document, lifecycle: "archived" }); }
  async deleteEntity(_draftId: string, _type: string, entity: EntityResult) { this.entities = this.entities.filter((item) => item !== entity); }
  async moveTask(_draftId: string, entity: EntityResult, _fingerprint: string, targetProject: string, targetMilestone?: string, targetParent?: string) { return await this.updateEntity(_draftId, "tasks", entity, _fingerprint, { ...entity.document, project: targetProject, milestone: targetMilestone, parent: targetParent }); }
  async getConfiguration(_draftId: string, kind: "statuses" | "issue-types" | "work-categories" | "schedule-tracks"): Promise<ConfigurationResult> {
    const document = (kind === "statuses" ? { schema: "gitpm/statuses@2", statuses: [{ slug: "backlog", title: "Backlog", active: true, category: "backlog" }, { slug: "done", title: "Done", active: true, category: "done" }] }
      : kind === "schedule-tracks" ? { schema: "gitpm/schedule-tracks@1", tracks: [
          { slug: "target", title: "Target", kind: "manual", capabilities: ["dates", "effort"] },
          { slug: "working", title: "Working", kind: "manual", capabilities: ["dates", "effort", "dependencies"] },
          { slug: "forecast", title: "Forecast", kind: "manual", capabilities: ["dates"] },
        ], defaults: { enabled_tracks: ["target", "working", "forecast"], primary_track: "working", workload_track: "working", dashboard_tracks: ["target", "working", "forecast"] } }
        : kind === "work-categories" ? { schema: "gitpm/work-categories@1", categories: [{ slug: "regular", title: "Regular", active: true }] }
        : { schema: "gitpm/issue-types@1", issue_types: [{ slug: "task", title: "Task", active: true }] }) as ConfigurationDocument;
    return { document, path: kind, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) };
  }
  async listTimeEntries(): Promise<readonly never[]> { return []; }
  async createTimeEntry(): Promise<never> { throw new Error("not used"); }
  async voidTimeEntry(): Promise<never> { throw new Error("not used"); }
  async updateConfiguration(): Promise<ConfigurationResult> { throw new Error("not used"); }
}

afterEach(cleanup);

describe("schedule track preservation", () => {
  it("edits only working.finish and keeps target, forecast, and working.depends_on", async () => {
    const entityApi = new MultiTrackApi();
    const api = entityApi as unknown as GitPmApi;
    const project = await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@2", id: "P-26-111111", name: "Multi-track", status: "backlog", lifecycle: "active" } as EntityDocument);
    const dependency = await entityApi.createEntity("DRF-CORE", "tasks", "", { schema: "gitpm/task@2", id: "T-26-AAAAAA", project: project.document.id, title: "Dependency", type: "task", status: "backlog", lifecycle: "active" } as EntityDocument);
    await entityApi.createEntity("DRF-CORE", "tasks", "", {
      schema: "gitpm/task@2",
      id: "T-26-WORKING",
      project: project.document.id,
      title: "Multi-track task",
      type: "task",
      status: "backlog",
      lifecycle: "active",
      schedules: {
        target: { start: "2026-08-01", finish: "2026-08-30" },
        working: { start: "2026-08-05", finish: "2026-08-20", effort_hours: 40, depends_on: [dependency.document.id] },
        forecast: { finish: "2026-09-10" },
      },
    } as EntityDocument);

    render(<CoreWorkspace api={api} draft={draft} initialProjectId={project.document.id} initialTaskId="T-26-WORKING" locale="en" surface="tasks" onChanged={vi.fn(async () => undefined)} />);

    await screen.findByRole("heading", { name: "Multi-track task" });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editDialog = screen.getByRole("dialog", { name: "Edit: Multi-track task" });
    expect((within(editDialog).getByLabelText("Due date") as HTMLInputElement).value).toBe("2026-08-20");
    fireEvent.change(within(editDialog).getByLabelText("Due date"), { target: { value: "2026-08-25" } });
    fireEvent.click(within(editDialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(entityApi.entities.find((item) => item.document.id === "T-26-WORKING")?.document).toBeDefined());
    const saved = entityApi.entities.find((item) => item.document.id === "T-26-WORKING")!.document as EntityDocument & { schedules: Record<string, unknown> };

    expect(saved.schedules.target).toEqual({ start: "2026-08-01", finish: "2026-08-30" });
    expect(saved.schedules.forecast).toEqual({ finish: "2026-09-10" });
    expect(saved.schedules.working).toEqual({ start: "2026-08-05", finish: "2026-08-25", effort_hours: 40, depends_on: [dependency.document.id] });
  });

  it("removes only the working window when the task form clears every editable field", async () => {
    const entityApi = new MultiTrackApi();
    const api = entityApi as unknown as GitPmApi;
    const project = await entityApi.createEntity("DRF-CORE", "projects", "", { schema: "gitpm/project@2", id: "P-26-222222", name: "Clear window", status: "backlog", lifecycle: "active" } as EntityDocument);
    await entityApi.createEntity("DRF-CORE", "tasks", "", {
      schema: "gitpm/task@2",
      id: "T-26-CLEAR",
      project: project.document.id,
      title: "Clear window task",
      type: "task",
      status: "backlog",
      lifecycle: "active",
      schedules: {
        target: { start: "2026-08-01", finish: "2026-08-30" },
        working: { start: "2026-08-05", finish: "2026-08-20", effort_hours: 40 },
      },
    } as EntityDocument);

    render(<CoreWorkspace api={api} draft={draft} initialProjectId={project.document.id} initialTaskId="T-26-CLEAR" locale="en" surface="tasks" onChanged={vi.fn(async () => undefined)} />);

    await screen.findByRole("heading", { name: "Clear window task" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editDialog = screen.getByRole("dialog", { name: "Edit: Clear window task" });
    fireEvent.change(within(editDialog).getByLabelText("Start date"), { target: { value: "" } });
    fireEvent.change(within(editDialog).getByLabelText("Due date"), { target: { value: "" } });
    fireEvent.change(within(editDialog).getByLabelText("Estimate (hours)"), { target: { value: "" } });
    fireEvent.click(within(editDialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(entityApi.entities.find((item) => item.document.id === "T-26-CLEAR")?.document).toBeDefined());
    const saved = entityApi.entities.find((item) => item.document.id === "T-26-CLEAR")!.document as EntityDocument & { schedules: Record<string, unknown> };
    expect(saved.schedules.target).toEqual({ start: "2026-08-01", finish: "2026-08-30" });
    expect(saved.schedules.working).toBeUndefined();
  });
});
