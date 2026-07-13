import { expect, test } from "@playwright/test";
import { cleanupDrafts, createDraft } from "./helpers.js";

test.describe("GitPM browser UI", () => {
  test.beforeEach(async ({ request }) => await cleanupDrafts(request));
  test.afterEach(async ({ request }) => await cleanupDrafts(request));

  test("loads the authenticated workspace instead of hanging on Loading", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto("/");

    await expect(page.getByRole("heading", { name: "source", exact: true })).toBeVisible();
    await expect(page.getByText(/· Локальный режим · Роль: Maintainer$/u)).toBeVisible();
    await expect(page.getByRole("button", { name: "Выйти", exact: true })).toHaveCount(0);
    await expect(page.locator("main.center-card")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("creates, closes, reopens and cleans up a draft", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Черновики", exact: true })).toBeVisible();

    await page.getByRole("textbox", { name: "ID черновика", exact: true }).fill("DRF-UI-LIFECYCLE");
    await page.getByRole("button", { name: "Создать черновик", exact: true }).click();
    await expect(page.getByRole("heading", { name: "DRF-UI-LIFECYCLE", exact: true })).toBeVisible();
    await expect(page.getByText("Ошибок нет", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
    await expect(page.getByRole("button", { name: "Открыть повторно", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Открыть повторно", exact: true }).click();
    await expect(page.getByRole("button", { name: "Закрыть", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();

    page.once("dialog", async (dialog) => await dialog.accept());
    await page.getByRole("button", { name: "Очистить", exact: true }).click();
    await expect(page.getByText("Черновиков пока нет.", { exact: true })).toHaveCount(2);
  });

  test("persists the selected locale across a browser reload", async ({ page }) => {
    await page.goto("/");
    const locale = page.getByLabel("Язык", { exact: true });
    await locale.selectOption("en");
    await expect(page.getByRole("heading", { name: "source", exact: true })).toBeVisible();

    await page.reload();

    await expect(page.getByLabel("Language", { exact: true })).toHaveValue("en");
    await expect(page.getByRole("heading", { name: "Drafts", exact: true })).toBeVisible();
  });

  test("loads fixture projects and tasks through the real API", async ({ page, request }) => {
    await createDraft(request, "DRF-UI-PROJECTS");
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "DRF-UI-PROJECTS", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Проекты", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Работа портфеля", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Название GitPM launch", exact: true })).toHaveValue("GitPM launch");
    await expect(page.getByRole("textbox", { name: "Название Operations", exact: true })).toHaveValue("Operations");
    await expect(page.getByRole("button", { name: /Approve schema v1/u })).toBeVisible();
  });

  test("keeps the active draft after reloading the page", async ({ page, request }) => {
    await createDraft(request, "DRF-UI-RELOAD");
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "DRF-UI-RELOAD", exact: true })).toBeVisible();

    await page.reload();

    await expect(page.getByRole("heading", { name: "DRF-UI-RELOAD", exact: true })).toBeVisible();
    await expect(page.getByText("Ошибок нет", { exact: true })).toBeVisible();
  });
});
