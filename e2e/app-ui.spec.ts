import { expect, test } from "@playwright/test";
import { cleanupDrafts, createDraft } from "./helpers.js";

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

    await expect(page.getByRole("heading", { name: "source", exact: true })).toBeVisible();
    await expect(page.getByText(/· Локальный режим · Роль: Maintainer$/u)).toBeVisible();
    await expect(page.getByRole("button", { name: "Черновики", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Работа портфеля", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Выйти", exact: true })).toHaveCount(0);
    await expect(page.locator("main.center-card")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("opens the configured repository directly on its projects", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Проекты", exact: true })).toHaveClass(/active/u);
    await expect(page.getByText("DRF-UI-WORKSPACE", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Название GitPM launch", exact: true })).toHaveValue("GitPM launch");
    await expect(page.getByRole("textbox", { name: "Название Operations", exact: true })).toHaveValue("Operations");
  });

  test("persists the selected locale across a browser reload", async ({ page }) => {
    await page.goto("/");
    const locale = page.getByLabel("Язык", { exact: true });
    await locale.selectOption("en");
    await expect(page.getByRole("heading", { name: "source", exact: true })).toBeVisible();

    await page.reload();

    await expect(page.getByLabel("Language", { exact: true })).toHaveValue("en");
    await expect(page.getByRole("heading", { name: "Portfolio work", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Drafts", exact: true })).toHaveCount(0);
  });

  test("loads fixture projects and tasks through the real API", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Работа портфеля", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Название GitPM launch", exact: true })).toHaveValue("GitPM launch");
    await expect(page.getByRole("textbox", { name: "Название Operations", exact: true })).toHaveValue("Operations");
    await expect(page.getByRole("button", { name: /Approve schema v1/u })).toBeVisible();
  });

  test("keeps the configured repository open after reloading the page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("textbox", { name: "Название GitPM launch", exact: true })).toHaveValue("GitPM launch");

    await page.reload();

    await expect(page.getByRole("textbox", { name: "Название GitPM launch", exact: true })).toHaveValue("GitPM launch");
    await expect(page.getByRole("button", { name: "Черновики", exact: true })).toHaveCount(0);
  });
});
