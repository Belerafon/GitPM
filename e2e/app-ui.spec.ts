import { expect, test } from "@playwright/test";
import { FIXTURE_PROJECT_ID, cleanupDrafts, createDraft } from "./helpers.js";

test.describe("GitPM browser UI", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupDrafts(request);
    await createDraft(request, "DRF-UI-WORKSPACE");
  });
  test.afterEach(async ({ page, request }) => {
    await page.close();
    await cleanupDrafts(request);
  });

  test("loads the authenticated workspace instead of hanging on Loading", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Проекты", exact: true })).toBeVisible();
    await expect(page.getByText("Локальный режим · Роль: Maintainer", { exact: true })).toBeVisible();
    await page.locator(".repository-card summary").click();
    await expect(page.locator(".repository-card code")).toBeVisible();
    await expect(page.getByRole("button", { name: "Репозиторий", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Текущая рабочая копия", exact: true })).toHaveValue("DRF-UI-WORKSPACE");
    await expect(page.getByRole("heading", { name: "Проекты", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Выйти", exact: true })).toHaveCount(0);
    await expect(page.locator("main.center-card")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("opens the configured repository directly on its projects", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Проекты", exact: true })).toHaveClass(/active/u);
    await expect(page.getByRole("combobox", { name: "Текущая рабочая копия", exact: true })).toHaveValue("DRF-UI-WORKSPACE");
    await expect(page.getByRole("button", { name: /^GitPM launch/u })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Operations/u })).toBeVisible();
  });

  test("persists the selected locale across a browser reload", async ({ page }) => {
    await page.goto("/");
    const locale = page.getByLabel("Язык", { exact: true });
    await locale.selectOption("en");
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

    await page.reload();

    await expect(page.getByLabel("Language", { exact: true })).toHaveValue("en");
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Repository", exact: true })).toBeVisible();
  });

  test("loads fixture projects and tasks through the real API", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Проекты", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /^GitPM launch/u })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Operations/u })).toBeVisible();
    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/tasks`);
    await expect(page.getByRole("button", { name: /Approve schema v1/u })).toBeVisible();
  });

  test("keeps the configured repository open after reloading the page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: /^GitPM launch/u })).toBeVisible();

    await page.reload();

    await expect(page.getByRole("button", { name: /^GitPM launch/u })).toBeVisible();
    await expect(page.getByRole("button", { name: "Репозиторий", exact: true })).toBeVisible();
  });

  test("keeps every section reachable and restores focus without page overflow at UX00 viewports", async ({ page }) => {
    test.setTimeout(120_000);
    const destinations = ["Repository", "Team", "Projects", "Statuses and task types"] as const;
    for (const width of [320, 390, 800, 1280, 1920]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      await page.locator(".locale-picker select").selectOption("en");

      for (const destination of destinations) {
        if (width <= 880) {
          await page.getByRole("button", { name: "Open navigation", exact: true }).click();
          await expect(page.locator("aside.sidebar.open")).toBeVisible();
        }
        const navigationItem = page.getByRole("button", { name: destination, exact: true });
        await navigationItem.click();
        await expect(navigationItem).toHaveAttribute("aria-current", "page");
        await expect(page.locator(".workspace-loading")).toHaveCount(0);
        await expect.poll(async () => await page.evaluate(() => document.activeElement?.getAttribute("tabindex"))).toBe("-1");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      }
      if (width === 1280) {
        for (const [section, tabs] of [
          ["Team", ["Team workload", "People and teams", "Working calendars"]],
          ["Repository", ["Working copies", "Changes", "History"]],
        ] as const) {
          await page.getByRole("button", { name: section, exact: true }).click();
          for (const tab of tabs) {
            await page.getByRole("button", { name: tab, exact: true }).click();
            await expect(page.getByRole("button", { name: tab, exact: true })).toHaveAttribute("aria-current", "page");
            await expect(page.locator(".workspace-loading")).toHaveCount(0);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
          }
        }
      }
    }
  });

  test("restores routed sections, selected entities and browser history", async ({ page }) => {
    await page.goto("/");
    await page.locator(".locale-picker select").selectOption("en");
    await expect(page).toHaveURL(/\/projects$/u);

    await page.goto("/tasks");
    await expect(page).toHaveURL(/\/projects$/u);
    await expect(page.getByRole("button", { name: "Tasks", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Team", exact: true }).click();
    await expect(page).toHaveURL(/\/workload$/u);
    await page.getByRole("button", { name: "People and teams", exact: true }).click();
    await expect(page).toHaveURL(/\/people$/u);
    await expect(page.getByRole("heading", { name: "People and teams", exact: true })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/workload$/u);
    await expect(page.getByRole("heading", { name: "Team workload", exact: true })).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/\/people$/u);

    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/tasks`);
    await expect(page).toHaveURL(new RegExp(`/projects/${FIXTURE_PROJECT_ID}(?:\\?.*)?$`, "u"));
    await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Approve schema v1/u }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${FIXTURE_PROJECT_ID}/tasks/[^/?]+(?:\\?.*)?$`, "u"));
    const taskUrl = page.url();
    await expect(page.getByRole("heading", { name: "Task details", exact: true })).toBeVisible();

    await page.reload();
    expect(page.url()).toBe(taskUrl);
    await expect(page.getByRole("heading", { name: "Task details", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${FIXTURE_PROJECT_ID}(?:\\?.*)?$`, "u"));
    await expect(page.getByRole("heading", { name: "Work plan", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Approve schema v1/u })).toBeVisible();
    await page.getByRole("button", { name: /Alpha/u }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${FIXTURE_PROJECT_ID}/stages/[^/?]+$`, "u"));
    await expect(page.getByLabel("Milestone", { exact: true }).getByRole("heading", { name: "Alpha", exact: true })).toBeVisible();

    await page.goto(`/board?project=${FIXTURE_PROJECT_ID}&status=backlog&type=task`);
    await expect(page.getByLabel("Status filter", { exact: true })).toHaveValue("backlog");
    await expect(page.getByLabel("Type filter", { exact: true })).toHaveValue("task");
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/projects/${FIXTURE_PROJECT_ID}/board\\?status=backlog&type=task$`, "u"));
    await expect(page.getByLabel("Status filter", { exact: true })).toHaveValue("backlog");
    await expect(page.getByLabel("Type filter", { exact: true })).toHaveValue("task");
  });

  test("creates, switches and remembers a working copy", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Репозиторий", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Рабочие копии", exact: true })).toBeVisible();

    await page.getByRole("textbox", { name: "ID рабочей копии", exact: true }).fill("DRF-UI-SECOND");
    await page.getByRole("button", { name: "Создать рабочую копию", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Текущая рабочая копия", exact: true })).toHaveValue("DRF-UI-SECOND");

    await page.reload();
    await expect(page.getByRole("combobox", { name: "Текущая рабочая копия", exact: true })).toHaveValue("DRF-UI-SECOND");
    await expect(page.getByRole("button", { name: "Репозиторий", exact: true })).toHaveClass(/active/u);

    await page.getByRole("button", { name: "Репозиторий", exact: true }).click();
    await page.getByRole("button", { name: /DRF-UI-WORKSPACE.*gitpm\/local-user\/DRF-UI-WORKSPACE/u }).click();
    await expect(page.getByRole("combobox", { name: "Текущая рабочая копия", exact: true })).toHaveValue("DRF-UI-WORKSPACE");
  });
});
