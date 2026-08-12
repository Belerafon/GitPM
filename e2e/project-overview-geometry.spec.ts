import { expect, request as createRequestContext, test, type APIRequestContext } from "@playwright/test";
import { cleanupDrafts, createDraft, FIXTURE_PROJECT_ID } from "./helpers.js";

const activeDraftStorageKey = "gitpm.activeWorkingCopy";
const e2eDraftInitializedKey = "gitpm.e2e.activeWorkingCopyInitialized";
const geometryDraftId = "DRF-GEO-OVERVIEW";
const wrappingTaskId = "T-26-WRP001";
const wrappingTaskTitle = "Task with multiple long assignees";
const wrappingAssignees = [
  { id: "U-26-WRP001", name: "Александр Александрович Александров" },
  { id: "U-26-WRP002", name: "Екатерина Константиновна Соколова" },
] as const;

const viewports = [
  { name: "wide 1688x900", width: 1688, height: 900 },
  { name: "compact 1032x900", width: 1032, height: 900 },
  { name: "tablet 900x900", width: 900, height: 900 },
  { name: "mobile 390x844", width: 390, height: 844 },
] as const;

test.describe("project overview geometry", () => {
  let sharedRequest: APIRequestContext;

  test.beforeAll(async () => {
    sharedRequest = await createRequestContext.newContext({ baseURL: "http://127.0.0.1:5174" });
    await cleanupDrafts(sharedRequest, "DRF-GEO-");
    let fingerprint = (await createDraft(sharedRequest, geometryDraftId)).fingerprint;
    const repositoryResponse = await sharedRequest.get(`/api/drafts/${geometryDraftId}/config/repository`);
    expect(repositoryResponse.status(), await repositoryResponse.text()).toBe(200);
    const repository = await repositoryResponse.json() as { readonly document: { readonly default_calendar: string } };
    for (const person of wrappingAssignees) {
      const response = await sharedRequest.post(`/api/drafts/${geometryDraftId}/entities/people`, {
        data: {
          expected_fingerprint: fingerprint,
          document: {
            schema: "gitpm/person@1",
            id: person.id,
            name: person.name,
            weekly_capacity_hours: 40,
            calendar: repository.document.default_calendar,
            lifecycle: "active",
          },
        },
      });
      expect(response.status(), await response.text()).toBe(201);
      fingerprint = (await response.json() as { readonly draft_fingerprint: string }).draft_fingerprint;
    }
    const taskResponse = await sharedRequest.post(`/api/drafts/${geometryDraftId}/entities/tasks`, {
      data: {
        expected_fingerprint: fingerprint,
        document: {
          schema: "gitpm/task@2",
          id: wrappingTaskId,
          project: FIXTURE_PROJECT_ID,
          milestone: "M-26-461GDJ",
          title: wrappingTaskTitle,
          type: "task",
          status: "backlog",
          lifecycle: "active",
          assignees: wrappingAssignees.map((person) => person.id),
        },
      },
    });
    expect(taskResponse.status(), await taskResponse.text()).toBe(201);
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

      const completeTaskRow = page.locator(".project-plan-task-row").filter({ hasText: "Approve schema v1" });
      await expect(completeTaskRow).toBeVisible();
      await expect(completeTaskRow.locator(".project-plan-task-meta")).toHaveCSS("display", "grid");
      const metadataGeometry = await completeTaskRow.evaluate((row) => {
        const meta = row.querySelector<HTMLElement>(".project-plan-task-meta")!;
        const box = (selector: string) => {
          const element = row.querySelector<HTMLElement>(selector)!;
          const bounds = element.getBoundingClientRect();
          return { selector, left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
        };
        const metaBounds = meta.getBoundingClientRect();
        return {
          meta: { left: metaBounds.left, right: metaBounds.right, scrollWidth: meta.scrollWidth, clientWidth: meta.clientWidth },
          fields: [
            box(".task-assignees"),
            box(".project-plan-task-due time"),
            box(".project-plan-task-estimate > span"),
            box(".project-plan-task-status select"),
            box(".plan-order-controls"),
          ],
        };
      });
      expect(metadataGeometry.fields.map((field) => field.selector)).toEqual([
        ".task-assignees",
        ".project-plan-task-due time",
        ".project-plan-task-estimate > span",
        ".project-plan-task-status select",
        ".plan-order-controls",
      ]);
      expect(metadataGeometry.meta.scrollWidth).toBeLessThanOrEqual(metadataGeometry.meta.clientWidth);
      for (const field of metadataGeometry.fields) {
        expect(field.left).toBeGreaterThanOrEqual(metadataGeometry.meta.left - 0.5);
        expect(field.right).toBeLessThanOrEqual(metadataGeometry.meta.right + 0.5);
      }
      for (let index = 0; index < metadataGeometry.fields.length - 1; index++) {
        const current = metadataGeometry.fields[index]!;
        const next = metadataGeometry.fields[index + 1]!;
        expect(current.right <= next.left + 0.5 || current.bottom <= next.top + 0.5).toBe(true);
      }

      const taskWithoutDue = page.locator(".project-plan-task-row").filter({ hasText: "Implement parser" });
      await expect(taskWithoutDue).toBeVisible();
      await expect(taskWithoutDue.locator(".project-plan-task-due")).toHaveText("");
      const alignedColumns = async (row: typeof completeTaskRow) => await row.evaluate((element) => {
        const selectors = [
          ".task-assignees",
          ".project-plan-task-due",
          ".project-plan-task-estimate",
          ".project-plan-task-status",
          ".plan-order-controls",
        ];
        return selectors.map((selector) => {
          const bounds = element.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          return { selector, left: bounds.left, right: bounds.right };
        });
      });
      const completeColumns = await alignedColumns(completeTaskRow);
      const incompleteColumns = await alignedColumns(taskWithoutDue);
      expect(incompleteColumns.map((column) => column.selector)).toEqual(completeColumns.map((column) => column.selector));
      for (let index = 0; index < completeColumns.length; index++) {
        expect(incompleteColumns[index]!.left).toBeCloseTo(completeColumns[index]!.left, 0);
        expect(incompleteColumns[index]!.right).toBeCloseTo(completeColumns[index]!.right, 0);
      }

      const wrappingTaskRow = page.locator(".project-plan-task-row").filter({ hasText: wrappingTaskTitle });
      await expect(wrappingTaskRow).toBeVisible();
      const assigneeCell = wrappingTaskRow.locator(".task-assignees");
      await Promise.all(wrappingAssignees.map(async (person) => await expect(assigneeCell.getByText(person.name, { exact: true })).toBeVisible()));
      const assigneeGeometry = await assigneeCell.evaluate((cell) => {
        const bounds = cell.getBoundingClientRect();
        const computed = getComputedStyle(cell);
        const lineHeight = Number.parseFloat(computed.lineHeight);
        const linkRects = Array.from(cell.querySelectorAll<HTMLElement>(".person-link"), (link) =>
          Array.from(link.getClientRects(), (rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })),
        ).flat();
        return {
          bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
          clientHeight: cell.clientHeight,
          clientWidth: cell.clientWidth,
          lineHeight,
          overflow: computed.overflow,
          scrollHeight: cell.scrollHeight,
          scrollWidth: cell.scrollWidth,
          whiteSpace: computed.whiteSpace,
          linkRects,
        };
      });
      expect(assigneeGeometry.whiteSpace).toBe("normal");
      expect(assigneeGeometry.overflow).toBe("visible");
      expect(assigneeGeometry.scrollWidth).toBeLessThanOrEqual(assigneeGeometry.clientWidth + 1);
      expect(assigneeGeometry.scrollHeight).toBeLessThanOrEqual(assigneeGeometry.clientHeight + 1);
      expect(assigneeGeometry.clientHeight).toBeGreaterThan(assigneeGeometry.lineHeight * 1.5);
      for (const rect of assigneeGeometry.linkRects) {
        expect(rect.left).toBeGreaterThanOrEqual(assigneeGeometry.bounds.left - 1);
        expect(rect.right).toBeLessThanOrEqual(assigneeGeometry.bounds.right + 1);
        expect(rect.top).toBeGreaterThanOrEqual(assigneeGeometry.bounds.top - 1);
        expect(rect.bottom).toBeLessThanOrEqual(assigneeGeometry.bounds.bottom + 1);
      }
      if (viewport.width === 1688) expect(assigneeGeometry.clientWidth).toBeGreaterThan(160);

      if (viewport.width >= 900) {
        const firstTaskRow = page.locator(".project-plan-task-row").first();
        await expect(firstTaskRow).toBeVisible();
        const columns = await firstTaskRow.evaluate((row) => {
          const list = row.closest<HTMLElement>(".project-plan-task-list")!;
          return getComputedStyle(list).gridTemplateColumns.split(" ").map((column) => Number.parseFloat(column));
        });
        if (viewport.width === 1688) {
          expect(columns).toHaveLength(3);
          expect(columns[1]).toBeGreaterThan(columns[2]!);
          await expect(firstTaskRow.locator(".project-plan-task-meta")).toHaveCSS("display", "grid");
        } else {
          expect(columns).toHaveLength(2);
          await expect(firstTaskRow.locator(".project-plan-task-meta")).toHaveCSS("display", "grid");
        }
      }

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
      // and the shared reset action are exercised under each viewport.
      await page.getByRole("button", { name: /^В работе/u }).first().click();
      // Quick and advanced filters now share one toolbar and one reset action.
      await expect(toolbar.locator(".advanced-view-clear")).toBeVisible();
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
