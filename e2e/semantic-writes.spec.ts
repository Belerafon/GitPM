import { expect, request as createRequestContext, test, type APIRequestContext, type Page } from "@playwright/test";
import { FIXTURE_PROJECT_ID, cleanupDrafts, createDraft, type EntityResult } from "./helpers.js";

const draftId = "DRF-UI-SEMANTIC-WRITES";
const targetProjectId = "P-26-8S9HQQ";
const activeDraftStorageKey = "gitpm.activeWorkingCopy";
const initializedKey = "gitpm.e2e.semanticWritesInitialized";

async function useDraft(page: Page): Promise<void> {
  await page.addInitScript(([activeKey, readyKey]) => {
    if (window.sessionStorage.getItem(readyKey) !== null) return;
    window.localStorage.setItem(activeKey, draftId);
    window.sessionStorage.setItem(readyKey, "true");
  }, [activeDraftStorageKey, initializedKey] as const);
}

async function english(page: Page): Promise<void> {
  await page.locator(".interface-settings > summary").click();
  await page.locator(".locale-picker select").selectOption("en");
  await page.locator(".interface-settings > summary").click();
}

async function createTask(api: APIRequestContext, document: Record<string, unknown>): Promise<EntityResult> {
  const draft = await api.get(`/api/drafts/${draftId}`);
  expect(draft.status(), await draft.text()).toBe(200);
  const { fingerprint } = await draft.json() as { fingerprint: string };
  const response = await api.post(`/api/drafts/${draftId}/entities/tasks`, { data: { expected_fingerprint: fingerprint, document } });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as EntityResult;
}

async function timeEntryCount(api: APIRequestContext, projectId: string, taskId: string): Promise<number> {
  const response = await api.get(`/api/drafts/${draftId}/projects/${projectId}/tasks/${taskId}/time-entries`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json() as unknown[]).length;
}

async function createTimeEntry(api: APIRequestContext, projectId: string, taskId: string, performedOn: string, hours: number): Promise<EntityResult> {
  const draft = await api.get(`/api/drafts/${draftId}`);
  expect(draft.status(), await draft.text()).toBe(200);
  const { fingerprint } = await draft.json() as { fingerprint: string };
  const response = await api.post(`/api/drafts/${draftId}/projects/${projectId}/tasks/${taskId}/time-entries`, {
    data: { expected_fingerprint: fingerprint, person: "U-26-15QJP8", performed_on: performedOn, hours, category: "regular" },
  });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as EntityResult;
}

function task(id: string, title: string, schedules: Record<string, unknown>, status = "backlog"): Record<string, unknown> {
  return { schema: "gitpm/task@2", id, project: FIXTURE_PROJECT_ID, title, type: "task", status, lifecycle: "active", schedules };
}

test.describe("semantic scheduling writes", () => {
  let sharedRequest: APIRequestContext;

  test.beforeAll(async () => {
    sharedRequest = await createRequestContext.newContext({ baseURL: "http://127.0.0.1:5174" });
    await cleanupDrafts(sharedRequest, draftId);
    await createDraft(sharedRequest, draftId);
  });

  test.afterAll(async () => {
    await cleanupDrafts(sharedRequest, draftId);
    await sharedRequest.dispose();
  });

  test("persists project planning and preserves every task schedule window through UI edits and reload", async ({ page, request }) => {
    const dependencyId = "T-26-SMW001";
    const taskId = "T-26-SMW002";
    await createTask(request, task(dependencyId, "Semantic dependency", { plan: { start: "2026-08-01", finish: "2026-08-02" }, target: { start: "2026-08-01", finish: "2026-08-02" } }));
    await createTask(request, task(taskId, "Semantic write task", {
      plan: { start: "2026-08-03", finish: "2026-08-20", effort_hours: 16, depends_on: [dependencyId] },
      target: { start: "2026-08-04", finish: "2026-08-25", effort_hours: 20 },
    }));

    await useDraft(page);
    await page.goto(`/projects/${FIXTURE_PROJECT_ID}`);
    await english(page);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const projectEditor = page.getByRole("dialog", { name: "Edit: GitPM launch", exact: true });
    await projectEditor.getByRole("combobox", { name: "Primary track", exact: true }).selectOption("target");
    await projectEditor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(projectEditor).toBeHidden();

    const project = await request.get(`/api/drafts/${draftId}/entities/projects/${FIXTURE_PROJECT_ID}`);
    expect((await project.json() as EntityResult).document.planning).toMatchObject({ primary_track: "target", workload_track: "plan" });

    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/tasks/${taskId}`);
    await expect(page.getByRole("heading", { name: "Semantic write task", exact: true })).toBeVisible();
    await page.getByRole("complementary", { name: "Task details", exact: true }).getByRole("button", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit: Semantic write task", exact: true });
    await expect(editor.getByRole("tab", { name: /Target.*primary/iu })).toBeVisible();
    await editor.getByLabel("Title", { exact: true }).fill("Semantic write task renamed");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toBeHidden();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Semantic write task renamed", exact: true })).toBeVisible();

    await page.getByRole("complementary", { name: "Task details", exact: true }).getByRole("button", { name: "Edit", exact: true }).click();
    const renamedEditor = page.getByRole("dialog", { name: "Edit: Semantic write task renamed", exact: true });
    await renamedEditor.getByRole("tab", { name: /Target.*primary/iu }).click();
    const targetDue = renamedEditor.locator(".schedule-track-fields[data-track='target']").getByLabel("Due date", { exact: true });
    await targetDue.fill("2026-08-29");
    await targetDue.press("Tab");
    await expect(targetDue).toHaveValue("2026-08-29");
    await renamedEditor.getByRole("button", { name: "Save", exact: true }).click();

    await expect.poll(async () => {
      const response = await request.get(`/api/drafts/${draftId}/entities/tasks/${taskId}`);
      if (!response.ok()) return "";
      return ((await response.json() as EntityResult).document.schedules as Record<string, { finish?: string }>).target?.finish;
    }).toBe("2026-08-29");

    const saved = await request.get(`/api/drafts/${draftId}/entities/tasks/${taskId}`);
    const schedules = (await saved.json() as EntityResult).document.schedules as Record<string, unknown>;
    expect(schedules).toEqual({
      plan: { start: "2026-08-03", finish: "2026-08-20", effort_hours: 16, depends_on: [dependencyId] },
      target: { start: "2026-08-04", finish: "2026-08-29", effort_hours: 20 },
    });
  });

  test("shows only dependency-capable tracks in Gantt without mixing per-track edges", async ({ page, request }) => {
    const predecessorId = "T-26-SMW003";
    const successorId = "T-26-SMW004";
    await createTask(request, task(predecessorId, "Track predecessor", { plan: { start: "2026-09-01", finish: "2026-09-02" }, target: { start: "2026-09-01", finish: "2026-09-02" } }));
    await createTask(request, task(successorId, "Track successor", { plan: { start: "2026-09-03", finish: "2026-09-04", depends_on: [predecessorId] }, target: { start: "2026-09-03", finish: "2026-09-04" } }));

    await useDraft(page);
    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/timeline`);
    await english(page);
    const dependencyTrack = page.getByLabel("Dependency track", { exact: true });
    await expect(dependencyTrack.locator("option")).toHaveText(["Working plan"]);
    await dependencyTrack.selectOption("plan");
    await expect(page.locator(`.gantt-dependencies path[data-from='${predecessorId}'][data-to='${successorId}']`)).toHaveCount(1);
    await expect(dependencyTrack.locator("option[value='target']")).toHaveCount(0);
  });

  test("records late duplicate-day actual activity, reports it by project, and moves it with the task", async ({ page, request }) => {
    const taskId = "T-26-SMW005";
    await createTask(request, task(taskId, "Accepted task with actuals", { plan: { start: "2026-08-01", finish: "2026-08-31", effort_hours: 8 }, target: { start: "2026-08-01", finish: "2026-08-15" } }, "done"));

    await useDraft(page);
    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/tasks/${taskId}`);
    await english(page);
    const form = page.locator(".time-entry-form");
    await expect(form.getByRole("button", { name: "Add effort", exact: true })).toBeEnabled();
    await createTimeEntry(request, FIXTURE_PROJECT_ID, taskId, "2026-09-10", 1.5);
    await expect.poll(async () => await timeEntryCount(request, FIXTURE_PROJECT_ID, taskId)).toBe(1);
    await createTimeEntry(request, FIXTURE_PROJECT_ID, taskId, "2026-09-10", 2.25);
    await expect.poll(async () => await timeEntryCount(request, FIXTURE_PROJECT_ID, taskId)).toBe(2);
    await createTimeEntry(request, FIXTURE_PROJECT_ID, taskId, "2026-12-20", 2);
    await expect.poll(async () => await timeEntryCount(request, FIXTURE_PROJECT_ID, taskId)).toBe(3);
    await page.reload();
    await expect(page.locator(".time-entry-summary").getByText("Total hours", { exact: true }).locator("xpath=..")).toContainText("5.75");
    await expect(page.locator(".task-time-entries").getByText("Last activity", { exact: true }).locator("xpath=..")).toContainText("Dec 20, 2026");

    await page.goto(`/projects/${FIXTURE_PROJECT_ID}`);
    await expect(page.getByRole("heading", { name: "Actual hours report", exact: true })).toBeVisible();
    const report = page.locator(".actual-hours-report");
    const byDate = report.locator(".actual-breakdown").filter({ has: page.getByRole("heading", { name: "By date", exact: true }) });
    await expect(byDate.getByRole("row").filter({ hasText: "Sep 10, 2026" })).toContainText("3.75");
    await expect(byDate.getByRole("row").filter({ hasText: "Dec 20, 2026" })).toContainText("2");

    await report.getByRole("combobox", { name: "Task", exact: true }).selectOption(taskId);
    await report.getByRole("combobox", { name: "Person", exact: true }).selectOption("U-26-15QJP8");
    await report.getByRole("combobox", { name: "Category", exact: true }).selectOption("regular");
    await report.getByRole("combobox", { name: "State", exact: true }).selectOption("active");
    await report.getByLabel("Performed from", { exact: true }).fill("2026-09-10");
    await report.getByLabel("Performed to", { exact: true }).fill("2026-12-20");
    await report.getByLabel("Hours after date", { exact: true }).fill("2026-09-10");
    const planActual = report.locator(".plan-actual-heading");
    await expect(planActual.getByText("Planned", { exact: true }).locator("xpath=..")).toContainText("8 hours");
    await expect(planActual.getByText("Actual", { exact: true }).locator("xpath=..")).toContainText("5.75 hours");
    await expect(planActual.getByText("Variance", { exact: true }).locator("xpath=..")).toContainText("-2.25 hours");
    await expect(report.getByText("Hours after 2026-09-10", { exact: true }).locator("xpath=..")).toContainText("2 hours");

    const external = await request.patch(`/api/drafts/${draftId}/writer-mode`, { data: { writer_mode: "external" } });
    expect(external.status(), await external.text()).toBe(200);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Actual hours report", exact: true })).toBeVisible();
    await expect(page.getByText("Actual hours", { exact: true }).locator("xpath=..")).toContainText("7.25 hours");
    const ui = await request.patch(`/api/drafts/${draftId}/writer-mode`, { data: { writer_mode: "ui" } });
    expect(ui.status(), await ui.text()).toBe(200);

    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/tasks/${taskId}`);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Accepted task with actuals", exact: true })).toBeVisible();
    await page.goto(`/projects/${targetProjectId}`);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    const targetProjectEditor = page.getByRole("dialog", { name: "Edit: Operations", exact: true });
    const enabledTracks = targetProjectEditor.getByText("Enabled tracks", { exact: true }).locator("xpath=..");
    await expect(enabledTracks.getByRole("checkbox", { name: "Target", exact: true })).toBeChecked();
    await targetProjectEditor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(targetProjectEditor).toBeHidden();
    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/tasks/${taskId}`);
    await page.getByRole("button", { name: "Move task", exact: true }).click();
    const move = page.getByRole("dialog", { name: "Move task", exact: true });
    await move.getByRole("combobox", { name: "Target project", exact: true }).selectOption(targetProjectId);
    await move.getByRole("button", { name: "Move task", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Accepted task with actuals", exact: true })).toBeVisible();

    await expect(page).toHaveURL(new RegExp(`/projects/${targetProjectId}/tasks/${taskId}`, "u"));
    const sourceEntries = await request.get(`/api/drafts/${draftId}/projects/${FIXTURE_PROJECT_ID}/time-entries`);
    expect(sourceEntries.status(), await sourceEntries.text()).toBe(200);
    expect((await sourceEntries.json() as { items: Array<{ document: { task: string } }> }).items.filter((entry) => entry.document.task === taskId)).toHaveLength(0);
    const targetEntries = await request.get(`/api/drafts/${draftId}/projects/${targetProjectId}/time-entries`);
    expect(targetEntries.status(), await targetEntries.text()).toBe(200);
    expect((await targetEntries.json() as { items: Array<{ document: { task: string } }> }).items.filter((entry) => entry.document.task === taskId)).toHaveLength(3);
    await page.goto(`/projects/${targetProjectId}`);
    await expect(page.getByRole("heading", { name: "Actual hours report", exact: true })).toBeVisible();
    await expect(page.getByText("Actual hours", { exact: true }).locator("xpath=..")).toContainText("5.75");
  });

  test("creates a person with the repository default calendar through the real UI and API", async ({ page, request }) => {
    await useDraft(page);
    await page.goto("/people");
    await english(page);
    await page.getByRole("button", { name: "Create person", exact: false }).click();
    const dialog = page.getByRole("dialog", { name: "Create person", exact: true });
    const calendar = await dialog.getByRole("combobox", { name: "Calendar", exact: true }).inputValue();
    expect(calendar).not.toBe("");
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Default calendar E2E");
    await dialog.getByRole("spinbutton", { name: "Weekly capacity (hours)", exact: true }).fill("32");
    await dialog.getByRole("button", { name: "Create person", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(page.getByRole("link", { name: "Default calendar E2E", exact: true })).toBeVisible();

    const listed = await request.get(`/api/drafts/${draftId}/entities/people`);
    expect(listed.status(), await listed.text()).toBe(200);
    const saved = (await listed.json() as EntityResult[]).find((item) => item.document.name === "Default calendar E2E");
    expect(saved?.document.calendar).toBe(calendar);
  });

  test("atomically corrects actual effort through the real UI and preserves the audit link", async ({ page, request }) => {
    const taskId = "T-26-SMW006";
    await createTask(request, task(taskId, "Correctable actual effort", { plan: { start: "2026-09-01", finish: "2026-09-05", effort_hours: 8 } }));
    const original = await createTimeEntry(request, FIXTURE_PROJECT_ID, taskId, "2026-09-03", 1);

    await useDraft(page);
    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/tasks/${taskId}`);
    await english(page);
    await page.getByRole("button", { name: "Correct", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Correct effort entry", exact: true });
    await dialog.getByRole("spinbutton", { name: "Hours", exact: true }).fill("2.5");
    await dialog.getByRole("textbox", { name: "Note", exact: true }).fill("E2E correction");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(page.getByText("2.5 h", { exact: true })).toBeVisible();

    const listed = await request.get(`/api/drafts/${draftId}/projects/${FIXTURE_PROJECT_ID}/tasks/${taskId}/time-entries`);
    expect(listed.status(), await listed.text()).toBe(200);
    const entries = await listed.json() as EntityResult[];
    const oldEntry = entries.find((item) => item.document.id === original.document.id);
    const newEntry = entries.find((item) => item.document.id !== original.document.id);
    expect(oldEntry?.document).toMatchObject({ state: "voided", replacement: newEntry?.document.id });
    expect(newEntry?.document).toMatchObject({ state: "active", hours: 2.5, note_markdown: "E2E correction" });
  });

  test("keeps configuration reorder local until Save and persists new values after reload", async ({ page, request }) => {
    await useDraft(page);
    await page.goto("/settings");
    await english(page);
    const card = page.locator(".config-editor").filter({ has: page.getByRole("heading", { name: "Statuses", exact: true }) });
    await card.getByRole("button", { name: "Edit Statuses", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Edit: Statuses", exact: true });
    const backlog = dialog.getByLabel("Statuses backlog", { exact: true });
    const before = await backlog.inputValue();
    await backlog.fill("Must be cancelled");
    await dialog.getByRole("button", { name: "Move Must be cancelled down", exact: true }).click();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.reload();

    const statusesBefore = await request.get(`/api/drafts/${draftId}/config/statuses`);
    expect(statusesBefore.status(), await statusesBefore.text()).toBe(200);
    expect(((await statusesBefore.json() as { document: { statuses: Array<{ slug: string; title: string }> } }).document.statuses)[0]).toMatchObject({ slug: "backlog", title: before });

    await card.getByRole("button", { name: "Edit Statuses", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Edit: Statuses", exact: true });
    await dialog.getByLabel("New technical ID", { exact: true }).fill("qa-review");
    await dialog.getByRole("button", { name: "Add value", exact: true }).click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(card.getByText("qa-review", { exact: true })).toBeVisible();
    const statusesAfter = await request.get(`/api/drafts/${draftId}/config/statuses`);
    expect(((await statusesAfter.json() as { document: { statuses: Array<{ slug: string }> } }).document.statuses).some((item) => item.slug === "qa-review")).toBe(true);
  });
});
