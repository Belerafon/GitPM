import { expect, request as createRequestContext, test, type APIRequestContext } from "@playwright/test";
import { FIXTURE_PROJECT_ID, cleanupDrafts, createDraft } from "./helpers.js";

const activeDraftStorageKey = "gitpm.activeWorkingCopy";
const e2eDraftInitializedKey = "gitpm.e2e.activeWorkingCopyInitialized";
const ganttDraftId = "DRF-UI-GANTT";

test.describe("multi-track Gantt", () => {
  let sharedRequest: APIRequestContext;

  test.beforeAll(async () => {
    sharedRequest = await createRequestContext.newContext({ baseURL: "http://127.0.0.1:5174" });
    await cleanupDrafts(sharedRequest, ganttDraftId);
    await createDraft(sharedRequest, ganttDraftId);
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ([activeKey, initializedKey, draftId]) => {
        if (window.sessionStorage.getItem(initializedKey) !== null) return;
        window.localStorage.setItem(activeKey, draftId);
        window.sessionStorage.setItem(initializedKey, "true");
      },
      [activeDraftStorageKey, e2eDraftInitializedKey, ganttDraftId] as const,
    );
  });

  test.afterAll(async () => {
    await cleanupDrafts(sharedRequest, ganttDraftId);
    await sharedRequest.dispose();
  });

  test("shows titled track controls and toggles an additional track overlay", async ({ page }) => {
    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/timeline`);
    await page.locator(".interface-settings > summary").click();
    await page.getByLabel("Язык", { exact: true }).selectOption("en");
    await page.locator(".interface-settings > summary").click();

    await expect(page.locator(".gantt-bar")).not.toHaveCount(0);
    const primarySelect = page.getByLabel("Primary track", { exact: true });
    await expect(primarySelect).toBeVisible();
    await expect(primarySelect.locator("option", { hasText: "Working plan" })).toHaveCount(1);
    await expect(primarySelect.locator("option", { hasText: "Target" })).toHaveCount(1);

    await expect(page.locator(".gantt-bar-overlay[data-track='target']")).not.toHaveCount(0);
    const additional = page.locator(".gantt-additional-tracks");
    await additional.getByLabel("Target", { exact: true }).uncheck();
    await expect(page.locator(".gantt-bar-overlay[data-track='target']")).toHaveCount(0);
    await additional.getByLabel("Target", { exact: true }).check();
    await expect(page.locator(".gantt-bar-overlay[data-track='target']")).not.toHaveCount(0);
  });
});
