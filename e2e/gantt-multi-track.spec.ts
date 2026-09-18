import { expect, request as createRequestContext, test, type APIRequestContext } from "@playwright/test";
import { FIXTURE_PROJECT_ID, cleanupDrafts, createDraft, type EntityResult } from "./helpers.js";

const activeDraftStorageKey = "gitpm.activeWorkingCopy";
const e2eDraftInitializedKey = "gitpm.e2e.activeWorkingCopyInitialized";
const ganttDraftId = "DRF-UI-GANTT";
const fixtureMilestoneId = "M-26-461GDJ";
const longMilestoneName = "Stage 2. Development of the core software and preparation of the complete delivery";

test.describe("multi-track Gantt", () => {
  let sharedRequest: APIRequestContext;

  test.beforeAll(async () => {
    sharedRequest = await createRequestContext.newContext({ baseURL: "http://127.0.0.1:5174" });
    await cleanupDrafts(sharedRequest, ganttDraftId);
    const draft = await createDraft(sharedRequest, ganttDraftId);
    const milestoneResponse = await sharedRequest.get(`/api/drafts/${ganttDraftId}/entities/milestones/${fixtureMilestoneId}`);
    expect(milestoneResponse.status(), await milestoneResponse.text()).toBe(200);
    const milestone = await milestoneResponse.json() as EntityResult;
    const updateResponse = await sharedRequest.put(`/api/drafts/${ganttDraftId}/entities/milestones/${fixtureMilestoneId}`, {
      data: {
        expected_fingerprint: draft.fingerprint,
        expected_blob_id: milestone.blob_id,
        document: { ...milestone.document, name: longMilestoneName },
      },
    });
    expect(updateResponse.status(), await updateResponse.text()).toBe(200);
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

  test("contains long task metadata within each compact label row", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/timeline`);

    const label = page.locator(".gantt-label").filter({ hasText: "Approve schema v1" });
    await expect(label).toContainText(longMilestoneName);
    const geometry = await label.evaluate((element) => {
      const row = element.getBoundingClientRect();
      const content = Array.from(element.querySelectorAll<HTMLElement>("strong, span, small"), (item) => {
        const bounds = item.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom, scrollWidth: item.scrollWidth, clientWidth: item.clientWidth };
      });
      return { row: { top: row.top, bottom: row.bottom }, content };
    });

    expect(geometry.content.some((item) => item.scrollWidth > item.clientWidth)).toBe(true);
    expect(Math.min(...geometry.content.map((item) => item.top))).toBeGreaterThanOrEqual(geometry.row.top - 1);
    expect(Math.max(...geometry.content.map((item) => item.bottom))).toBeLessThanOrEqual(geometry.row.bottom + 1);
  });
});
