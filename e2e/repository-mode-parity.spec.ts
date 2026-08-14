import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { FIXTURE_PROJECT_ID, cleanupDrafts, createDraft, type DraftStatus } from "./helpers.js";

const parityDraft = "DRF-PARITY";

async function workspace(request: APIRequestContext, projectName: string): Promise<DraftStatus> {
  if (projectName === "chromium-worktree") {
    await cleanupDrafts(request, parityDraft);
    return await createDraft(request, parityDraft);
  }
  const response = await request.get("/api/drafts");
  expect(response.status(), await response.text()).toBe(200);
  const drafts = await response.json() as readonly DraftStatus[];
  const local = drafts.find((draft) => draft.draft_id === "DRF-LOCAL");
  if (local === undefined) throw new Error("Direct mode did not expose DRF-LOCAL");
  return local;
}

async function openWorkspace(page: Page, draftId: string, path: string): Promise<void> {
  await page.addInitScript(([id]) => {
    window.localStorage.setItem("gitpm.activeWorkingCopy", id);
    window.localStorage.setItem("gitpm.locale", "en");
  }, [draftId] as const);
  await page.goto(path);
  await expect(page.locator(".workspace-loading")).toHaveCount(0);
}

test("@parity creates, edits, commits and reads history through the browser", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const draft = await workspace(request, testInfo.project.name);
  const title = `Parity ${testInfo.project.name}`;
  const renamed = `${title} edited`;
  await openWorkspace(page, draft.draft_id, `/projects/${FIXTURE_PROJECT_ID}`);

  await page.getByRole("button", { name: /New task/u }).first().click();
  const createDialog = page.getByRole("dialog", { name: "New task", exact: true });
  await createDialog.getByLabel("Title", { exact: true }).fill(title);
  await createDialog.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(createDialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(title, "u") })).toBeVisible();

  await page.getByRole("button", { name: new RegExp(title, "u") }).click();
  const inspector = page.getByRole("complementary", { name: "Task details", exact: true });
  await inspector.getByRole("button", { name: "Edit", exact: true }).click();
  const editDialog = page.getByRole("dialog", { name: `Edit: ${title}`, exact: true });
  await editDialog.getByLabel("Title", { exact: true }).fill(renamed);
  await editDialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: renamed, exact: true })).toBeVisible();

  await page.goto("/changes");
  await expect(page.getByText(renamed, { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Prepare commit", exact: true }).click();
  const commitDialog = page.getByRole("dialog", { name: "Commit all changes", exact: true });
  await commitDialog.getByLabel("Commit message", { exact: true }).fill(`Verify ${testInfo.project.name} parity`);
  await commitDialog.getByRole("button", { name: "Commit all", exact: true }).click();
  await expect(page.locator(".publish-step.complete").getByText("Committed", { exact: true })).toBeVisible();
  // Clean-state text lives inside the collapsed technical-changes block; expand it before reading.
  await page.getByText("Technical file changes", { exact: true }).click();
  await expect(page.getByText("No uncommitted changes", { exact: true }).first()).toBeVisible();

  await page.goto("/history");
  await expect(page.getByText(`Verify ${testInfo.project.name} parity`, { exact: true }).first()).toBeVisible();
  const exported = await request.get(`/api/drafts/${encodeURIComponent(draft.draft_id)}/export?format=html&locale=en`);
  expect(exported.status(), await exported.text()).toBe(200);
  expect(exported.headers()["content-type"]).toContain("text/html");

  if (testInfo.project.name === "chromium-worktree") await cleanupDrafts(request, parityDraft);
});

test("@direct redirects stale workspace routes and hides draft management", async ({ page, request }, testInfo) => {
  const draft = await workspace(request, testInfo.project.name);
  await openWorkspace(page, draft.draft_id, "/workspaces");
  await expect(page.getByRole("heading", { name: "Changes", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Current working copy", exact: true })).toHaveCount(0);
});
