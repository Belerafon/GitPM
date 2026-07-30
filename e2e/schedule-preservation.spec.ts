import { expect, request as createRequestContext, test, type APIRequestContext } from "@playwright/test";
import { FIXTURE_PROJECT_ID, cleanupDrafts, createDraft, type EntityResult } from "./helpers.js";

const activeDraftStorageKey = "gitpm.activeWorkingCopy";
const e2eDraftInitializedKey = "gitpm.e2e.activeWorkingCopyInitialized";
const scheduleDraftId = "DRF-UI-SCHEDULE";
const dependencyTaskId = "T-26-AAA001";
const multiTrackTaskId = "T-26-BBB002";

function multiTrackDocument(): Record<string, unknown> {
  return {
    schema: "gitpm/task@2",
    id: multiTrackTaskId,
    project: FIXTURE_PROJECT_ID,
    title: "Schedule preservation E2E",
    type: "task",
    status: "backlog",
    lifecycle: "active",
    schedules: {
      plan: { start: "2026-08-05", finish: "2026-08-20", effort_hours: 40, depends_on: [dependencyTaskId] },
      target: { start: "2026-08-01", finish: "2026-08-30" },
    },
  };
}

async function createTask(api: APIRequestContext, draftId: string, fingerprint: string, document: Record<string, unknown>): Promise<EntityResult> {
  const response = await api.post(`/api/drafts/${draftId}/entities/tasks`, { data: { expected_fingerprint: fingerprint, document } });
  expect(response.status(), await response.text()).toBe(201);
  return await response.json() as EntityResult;
}

test.describe("schedule track preservation", () => {
  let sharedRequest: APIRequestContext;

  test.beforeAll(async () => {
    sharedRequest = await createRequestContext.newContext({ baseURL: "http://127.0.0.1:5174" });
    await cleanupDrafts(sharedRequest, scheduleDraftId);
    await createDraft(sharedRequest, scheduleDraftId);
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ([activeKey, initializedKey, draftId]) => {
        if (window.sessionStorage.getItem(initializedKey) !== null) return;
        window.localStorage.setItem(activeKey, draftId);
        window.sessionStorage.setItem(initializedKey, "true");
      },
      [activeDraftStorageKey, e2eDraftInitializedKey, scheduleDraftId] as const,
    );
  });

  test.afterAll(async () => {
    await cleanupDrafts(sharedRequest, scheduleDraftId);
    await sharedRequest.dispose();
  });

  test("edits only plan.finish through the browser and keeps target and plan.depends_on", async ({ page, request }) => {
    const api = request;
    const draftResponse = await api.get(`/api/drafts/${scheduleDraftId}`);
    expect(draftResponse.status()).toBe(200);
    const draft = await draftResponse.json() as { fingerprint: string };

    const dependency = await createTask(api, scheduleDraftId, draft.fingerprint, {
      schema: "gitpm/task@2", id: dependencyTaskId, project: FIXTURE_PROJECT_ID, title: "Schedule dependency E2E", type: "task", status: "backlog", lifecycle: "active",
    });
    await createTask(api, scheduleDraftId, dependency.draft_fingerprint, multiTrackDocument());

    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/tasks/${multiTrackTaskId}`);
    await page.locator(".interface-settings > summary").click();
    await page.getByLabel("Язык", { exact: true }).selectOption("en");
    await page.locator(".interface-settings > summary").click();

    await expect(page.getByRole("heading", { name: "Schedule preservation E2E", exact: true })).toBeVisible();

    const taskDetails = page.getByRole("complementary", { name: "Task details", exact: true });
    await taskDetails.getByRole("button", { name: "Edit", exact: true }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit: Schedule preservation E2E", exact: true });
    const dueDate = editDialog.getByLabel("Due date", { exact: true });
    await expect(dueDate).toHaveValue("2026-08-20");
    await dueDate.fill("2026-08-25");
    await editDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editDialog).toBeHidden();

    await expect(page.getByRole("heading", { name: "Schedule preservation E2E", exact: true })).toBeVisible();

    const fetched = await api.get(`/api/drafts/${scheduleDraftId}/entities/tasks/${multiTrackTaskId}`);
    expect(fetched.status(), await fetched.text()).toBe(200);
    const result = await fetched.json() as EntityResult;
    const schedules = result.document.schedules as Record<string, { start?: string; finish?: string; effort_hours?: number; depends_on?: string[] }>;
    expect(schedules.target).toEqual({ start: "2026-08-01", finish: "2026-08-30" });
    expect(schedules.plan).toEqual({ start: "2026-08-05", finish: "2026-08-25", effort_hours: 40, depends_on: [dependencyTaskId] });
  });
});
