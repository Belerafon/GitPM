import { expect, request as createRequestContext, test, type APIRequestContext } from "@playwright/test";
import { cleanupDrafts, createDraft, FIXTURE_PROJECT_ID } from "./helpers.js";

const activeDraftStorageKey = "gitpm.activeWorkingCopy";
const e2eDraftInitializedKey = "gitpm.e2e.activeWorkingCopyInitialized";
const geometryDraftId = "DRF-GEO-OVERVIEW";

const viewports = [
  { name: "wide 1688x900", width: 1688, height: 900 },
  { name: "tablet 900x900", width: 900, height: 900 },
  { name: "mobile 390x844", width: 390, height: 844 },
] as const;

test.describe("project overview geometry", () => {
  let sharedRequest: APIRequestContext;

  test.beforeAll(async () => {
    sharedRequest = await createRequestContext.newContext({ baseURL: "http://127.0.0.1:5174" });
    await cleanupDrafts(sharedRequest, "DRF-GEO-");
    await createDraft(sharedRequest, geometryDraftId);
  });

  test.beforeEach(async ({ page }, testInfo) => {
    const viewport = viewports.find((item) => testInfo.title.includes(item.name)) ?? viewports[0]!;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript(
      ([activeKey, initializedKey, draftId]) => {
        if (window.sessionStorage.getItem(initializedKey) !== null) return;
        window.localStorage.setItem(activeKey, draftId);
        window.sessionStorage.setItem(initializedKey, "true");
      },
      [activeDraftStorageKey, e2eDraftInitializedKey, geometryDraftId] as const,
    );
  });

  test.afterAll(async () => {
    await cleanupDrafts(sharedRequest, "DRF-GEO-");
    await sharedRequest.dispose();
  });

  for (const viewport of viewports) {
    test(`keeps the plan toolbar inside the viewport without horizontal overflow (${viewport.name})`, async ({ page }) => {
      await page.goto(`/projects/${FIXTURE_PROJECT_ID}`);
      const workHeading = page.getByRole("heading", { name: "План работ", exact: true });
      await expect(workHeading).toBeVisible();

      // The work-plan toolbar stays compact: only the trigger and applied chips live inline.
      const toolbar = page.locator(".project-plan-toolbar");
      await expect(toolbar).toBeVisible();
      const advancedFilterTrigger = toolbar.locator(".advanced-view-trigger");
      await expect(advancedFilterTrigger).toBeVisible();
      await expect(toolbar.locator(".advanced-view-form")).toHaveCount(0);

      const toolbarBox = await toolbar.boundingBox();
      expect(toolbarBox).not.toBeNull();
      expect(toolbarBox!.x + toolbarBox!.width).toBeLessThanOrEqual(viewport.width + 1);
      // No page-level horizontal scroll is introduced by the overview layout.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);

      // The complete filter and sorting editor is available in a separate drawer without
      // introducing page-level overflow, including at the mobile viewport.
      await advancedFilterTrigger.click();
      await expect(page.locator(".editor-drawer .advanced-view-form")).toBeVisible();
      const drawerOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(drawerOverflow).toBeLessThanOrEqual(0);
      await page.keyboard.press("Escape");
      await expect(page.locator(".editor-drawer")).toHaveCount(0);

      // Activating a quick filter must not blow the toolbar past the viewport either.
      // Use the "In progress" metric (not "Total tasks") so the narrow in-progress semantics
      // and its chip + reset button are exercised under each viewport.
      await page.getByRole("button", { name: /^В работе/u }).first().click();
      // The active filter chip and the reset button must remain visible inside the viewport.
      await expect(page.locator(".project-plan-filter-chips .filter-reset")).toBeVisible();
      const overflowAfter = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflowAfter).toBeLessThanOrEqual(0);
    });
  }

  test("the effort tab loads for the same project and renders its report", async ({ page }) => {
    await page.setViewportSize({ width: 1688, height: 900 });
    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/effort`);
    await expect(page.getByRole("heading", { name: "Отчёт по фактическим часам", exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
