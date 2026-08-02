import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { FIXTURE_PROJECT_ID, cleanupDrafts, createDraft, type DraftStatus, type EntityResult } from "./helpers.js";

const prefix = "DRF-AUDIT-";

async function openDraft(page: Page, draftId: string, path: string): Promise<void> {
  await page.addInitScript(([id]) => {
    window.localStorage.setItem("gitpm.activeWorkingCopy", id);
    window.localStorage.setItem("gitpm.locale", "en");
  }, [draftId] as const);
  await page.goto(path);
  await expect(page.locator(".workspace-loading")).toHaveCount(0);
}

async function entity(request: APIRequestContext, draftId: string, type: string, id: string): Promise<EntityResult> {
  const response = await request.get(`/api/drafts/${encodeURIComponent(draftId)}/entities/${type}/${id}`);
  expect(response.status(), await response.text()).toBe(200);
  return await response.json() as EntityResult;
}

async function archiveProject(request: APIRequestContext, draft: DraftStatus, project: EntityResult): Promise<EntityResult> {
  const response = await request.post(`/api/drafts/${encodeURIComponent(draft.draft_id)}/entities/projects/${String(project.document.id)}/archive`, {
    data: { expected_fingerprint: draft.fingerprint, expected_blob_id: project.blob_id },
  });
  expect(response.status(), await response.text()).toBe(200);
  return await response.json() as EntityResult;
}

test.describe("audited vertical lifecycles", () => {
  test.afterEach(async ({ request }) => await cleanupDrafts(request, prefix));

  test("archive Project -> reload Workload -> active Tasks are excluded", async ({ page, request }) => {
    test.setTimeout(120_000);
    const draft = await createDraft(request, `${prefix}WORKLOAD`);
    await openDraft(page, draft.draft_id, "/workload");
    await expect(page.getByText("Included Tasks").locator("xpath=following-sibling::*[1]")).toHaveText("1");

    const archivedProject = await archiveProject(request, draft, await entity(request, draft.draft_id, "projects", FIXTURE_PROJECT_ID));
    await page.reload();

    await expect(page.getByText("Included Tasks").locator("xpath=following-sibling::*[1]")).toHaveText("0");
    await expect(page.getByText("Archived", { exact: true }).locator("xpath=following-sibling::*[1]")).toHaveText("2");
    await expect(page.locator(".workload-table")).toHaveCount(0);

    await page.goto("/portfolio");
    await expect(page.getByText("Active tasks", { exact: true }).locator("xpath=following-sibling::*[1]")).toHaveText("1");
    await page.goto("/projects");
    await expect(page.getByRole("button", { name: /GitPM launch/u })).toHaveCount(0);
    await page.goto("/people/U-26-5EBAE3");
    await expect(page.getByText("Assigned tasks", { exact: true }).locator("xpath=following-sibling::*[1]")).toHaveText("0");
    await expect(page.getByRole("button", { name: /Approve schema v1/u })).toHaveCount(0);
    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/tasks/T-26-P9G3P8`);
    await expect(page.getByText("This task is unavailable while its project is archived. Restore the project first.", { exact: true })).toBeVisible();
    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/board`);
    await expect(page.getByRole("button", { name: /Approve schema v1/u })).toHaveCount(0);
    await page.goto(`/projects/${FIXTURE_PROJECT_ID}/gantt`);
    await expect(page.getByText("Approve schema v1", { exact: true })).toHaveCount(0);

    const restored = await request.post(`/api/drafts/${encodeURIComponent(draft.draft_id)}/entities/projects/${FIXTURE_PROJECT_ID}/restore`, {
      data: { expected_fingerprint: archivedProject.draft_fingerprint, expected_blob_id: archivedProject.blob_id },
    });
    expect(restored.status(), await restored.text()).toBe(200);
    await page.goto("/people/U-26-5EBAE3");
    await expect(page.getByText("Assigned tasks", { exact: true }).locator("xpath=following-sibling::*[1]")).toHaveText("1");
    await expect(page.getByRole("button", { name: /Approve schema v1/u }).first()).toBeVisible();
  });

  test("Saved View update, rename, archive and delete unblock configuration", async ({ page, request }) => {
    test.setTimeout(120_000);
    const draft = await createDraft(request, `${prefix}VIEWS`);
    await openDraft(page, draft.draft_id, `/projects/${FIXTURE_PROJECT_ID}/board`);
    await page.getByLabel("Type filter").selectOption("bug");
    await page.getByText("Create and manage saved views", { exact: true }).click();
    await page.getByLabel("View name", { exact: true }).fill("Audit blockers");
    await page.getByRole("button", { name: "Save as new", exact: true }).click();
    await expect(page.getByRole("button", { name: "Apply Audit blockers", exact: true })).toBeVisible();

    await page.reload();
    await page.getByText("Create and manage saved views", { exact: true }).click();
    const viewCard = page.getByText("Audit blockers", { exact: true }).locator("xpath=ancestor::article[1]");
    await page.getByLabel("Status filter").selectOption("done");
    const updateResponse = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/entities/views/"));
    await viewCard.getByRole("button", { name: "Update current view", exact: true }).click();
    expect((await updateResponse).status()).toBe(200);
    await viewCard.getByLabel("View name for Audit blockers").fill("Renamed blockers");
    const renameResponse = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/entities/views/"));
    await viewCard.getByRole("button", { name: "Rename", exact: true }).click();
    expect((await renameResponse).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Apply Renamed blockers", exact: true })).toBeVisible();

    await page.goto("/settings");
    const issueTypes = page.getByRole("heading", { name: "Issue types", exact: true }).locator("xpath=ancestor::article[1]");
    await issueTypes.getByRole("button", { name: "Edit Issue types", exact: true }).click();
    const issueDialog = page.getByRole("dialog", { name: "Edit: Issue types", exact: true });
    await issueDialog.getByRole("button", { name: "Delete Bug", exact: true }).click();
    await issueDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(issueDialog.getByRole("button", { name: "Open blocking view", exact: true })).toBeVisible();
    await issueDialog.getByRole("button", { name: "Open blocking view", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${FIXTURE_PROJECT_ID}/board\\?view=V-`, "u"));

    await page.getByText("Create and manage saved views", { exact: true }).click();
    const renamedCard = page.getByText("Renamed blockers", { exact: true }).locator("xpath=ancestor::article[1]");
    await renamedCard.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(renamedCard.getByText("Archived", { exact: true })).toBeVisible();
    page.once("dialog", async (dialog) => await dialog.accept());
    await renamedCard.getByRole("button", { name: "Delete permanently", exact: true }).click();
    await expect(page.getByText("Renamed blockers", { exact: true })).toHaveCount(0);
    await page.reload();
    await page.getByText("Create and manage saved views", { exact: true }).click();
    await expect(page.getByText("Renamed blockers", { exact: true })).toHaveCount(0);

    await page.goto("/settings");
    const reloadedTypes = page.getByRole("heading", { name: "Issue types", exact: true }).locator("xpath=ancestor::article[1]");
    await reloadedTypes.getByRole("button", { name: "Edit Issue types", exact: true }).click();
    const reloadedDialog = page.getByRole("dialog", { name: "Edit: Issue types", exact: true });
    await reloadedDialog.getByRole("button", { name: "Delete Bug", exact: true }).click();
    await reloadedDialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Edit: Issue types", exact: true })).toHaveCount(0);
    await expect(reloadedTypes.getByText("Bug", { exact: true })).toHaveCount(0);
  });

  test("default calendar Delete stays disabled until a replacement is selected", async ({ page, request }) => {
    test.setTimeout(120_000);
    const draft = await createDraft(request, `${prefix}CALENDAR`);
    let fingerprint = draft.fingerprint;
    for (const [id, name] of [["C-26-E2E001", "Temporary default"], ["C-26-E2E002", "Final default"]] as const) {
      const response = await request.post(`/api/drafts/${draft.draft_id}/entities/calendars`, {
        data: { expected_fingerprint: fingerprint, document: { schema: "gitpm/calendar@1", id, name, working_weekdays: [1, 2, 3, 4, 5], holidays: [], lifecycle: "active" } },
      });
      expect(response.status(), await response.text()).toBe(201);
      fingerprint = (await response.json() as EntityResult).draft_fingerprint;
    }

    await openDraft(page, draft.draft_id, "/settings");
    const setDefault = async (calendarId: string) => {
      const repository = page.getByRole("heading", { name: "Repository settings", exact: true }).locator("xpath=ancestor::article[1]");
      await repository.getByRole("button", { name: "Edit Repository settings", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Edit: Repository settings", exact: true });
      await dialog.getByLabel("Repository default calendar").selectOption(calendarId);
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).toHaveCount(0);
    };
    await setDefault("C-26-E2E001");

    await page.goto("/calendars");
    const temporary = page.getByText(/Temporary default \(Repository default calendar\)/u).locator("xpath=ancestor::article[1]");
    await temporary.getByRole("button", { name: "Edit calendar", exact: true }).click();
    let calendarDialog = page.getByRole("dialog", { name: "Edit calendar: Temporary default", exact: true });
    await calendarDialog.getByText("More actions", { exact: true }).click();
    await expect(calendarDialog.getByRole("button", { name: "Archive", exact: true })).toBeDisabled();
    await expect(calendarDialog.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
    await calendarDialog.getByRole("button", { name: "Close editor", exact: true }).click();

    await page.goto("/settings");
    await setDefault("C-26-E2E002");
    await page.goto("/calendars");
    const oldDefault = page.getByText("Temporary default", { exact: true }).locator("xpath=ancestor::article[1]");
    await oldDefault.getByRole("button", { name: "Edit calendar", exact: true }).click();
    calendarDialog = page.getByRole("dialog", { name: "Edit calendar: Temporary default", exact: true });
    await calendarDialog.getByText("More actions", { exact: true }).click();
    await expect(calendarDialog.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
    page.once("dialog", async (dialog) => await dialog.accept());
    await calendarDialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("Temporary default", { exact: true })).toHaveCount(0);
  });
});
