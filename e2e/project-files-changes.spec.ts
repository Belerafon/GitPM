import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FIXTURE_PROJECT_ID, cleanupDrafts, createDraft, type DraftStatus } from "./helpers.js";

const worktreeDraftId = "DRF-PROJECT-FILES";

async function workspace(request: APIRequestContext, projectName: string): Promise<DraftStatus> {
  if (projectName === "chromium-worktree") {
    await cleanupDrafts(request, worktreeDraftId);
    return await createDraft(request, worktreeDraftId);
  }
  const response = await request.get("/api/drafts");
  expect(response.status(), await response.text()).toBe(200);
  const drafts = await response.json() as readonly DraftStatus[];
  const local = drafts.find((draft) => draft.draft_id === "DRF-LOCAL");
  if (local === undefined) throw new Error("Direct mode did not expose DRF-LOCAL");
  return local;
}

async function openProject(page: Page, draftId: string): Promise<void> {
  await page.addInitScript(([id]) => {
    window.localStorage.setItem("gitpm.activeWorkingCopy", id);
    window.localStorage.setItem("gitpm.locale", "en");
  }, [draftId] as const);
  await page.goto(`/projects/${FIXTURE_PROJECT_ID}`);
  await expect(page.locator(".workspace-loading")).toHaveCount(0);
}

async function currentDraft(request: APIRequestContext, draftId: string): Promise<DraftStatus> {
  const response = await request.get(`/api/drafts/${encodeURIComponent(draftId)}`);
  expect(response.status(), await response.text()).toBe(200);
  return await response.json() as DraftStatus;
}

test("@parity carries Project files from the user and technical managers through Changes", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const draft = await workspace(request, testInfo.project.name);
  const originalName = `ТЗ ${testInfo.project.name}.txt`;
  const renamedName = `ТЗ ${testInfo.project.name} v2.txt`;
  const binaryName = `scan-${testInfo.project.name}.dat`;
  const filesDirectory = `projects/${FIXTURE_PROJECT_ID}/files`;

  await openProject(page, draft.draft_id);
  await page.getByRole("button", { name: /^Files/u }).click();
  const panel = page.getByRole("dialog", { name: /Project files/u });
  await expect(panel).toBeVisible();
  await panel.getByLabel("Select project files to upload").setInputFiles({
    name: originalName,
    mimeType: "application/octet-stream",
    buffer: Buffer.from("First line\nТочный UTF-8 текст\n", "utf8"),
  });
  await expect(panel.getByText(/· uploaded$/u)).toBeVisible();
  await expect(panel.getByText(originalName, { exact: true }).first()).toBeVisible();
  await panel.getByRole("button", { name: "Close project files" }).click();

  await page.goto("/changes");
  await expect(page.getByRole("heading", { name: "Project files", exact: true })).toBeVisible();
  await expect(page.getByText("File added", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`File added ${originalName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u") }).click();
  await expect(page.getByText("+Точный UTF-8 текст", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Prepare commit", exact: true }).click();
  const commitDialog = page.getByRole("dialog", { name: "Commit all changes", exact: true });
  await commitDialog.getByLabel("Commit message", { exact: true }).fill(`Add Project file ${testInfo.project.name}`);
  await commitDialog.getByRole("button", { name: "Commit all", exact: true }).click();
  await expect(page.getByText("No uncommitted changes", { exact: true }).first()).toBeVisible();

  const afterCommit = await currentDraft(request, draft.draft_id);
  const moved = await request.post(`/api/drafts/${encodeURIComponent(draft.draft_id)}/worktree/move`, {
    data: { expected_fingerprint: afterCommit.fingerprint, from: `${filesDirectory}/${originalName}`, to: `${filesDirectory}/${renamedName}` },
  });
  expect(moved.status(), await moved.text()).toBe(200);
  const movedResult = await moved.json() as { draft_fingerprint: string };
  const technical = await request.post(`/api/drafts/${encodeURIComponent(draft.draft_id)}/worktree/file`, {
    data: {
      expected_fingerprint: movedResult.draft_fingerprint,
      path: `${filesDirectory}/${binaryName}`,
      content_base64: Buffer.from([0, 255, 1, 128, 2, 64]).toString("base64"),
    },
  });
  expect(technical.status(), await technical.text()).toBe(201);

  await page.goto("/changes");
  await expect(page.getByText("File renamed", { exact: true })).toBeVisible();
  await expect(page.getByText(`${originalName} → ${renamedName}`, { exact: true })).toBeVisible();
  await expect(page.getByText(binaryName, { exact: true })).toBeVisible();
  await expect(page.getByText("Binary file", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto(`/projects/${FIXTURE_PROJECT_ID}`);
  await page.getByRole("button", { name: /^Files/u }).click();
  const narrowPanel = page.getByRole("dialog", { name: /Project files/u });
  const bounds = await narrowPanel.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.width).toBeLessThanOrEqual(390);

  if (testInfo.project.name === "chromium-worktree") {
    await narrowPanel.getByRole("button", { name: "Close project files" }).click();
    const external = await request.patch(`/api/drafts/${encodeURIComponent(draft.draft_id)}/writer-mode`, { data: { writer_mode: "external" } });
    expect(external.status(), await external.text()).toBe(200);
    const metadataPath = path.join(process.cwd(), ".tmp", "playwright-local-worktree", "data", "drafts", `${draft.draft_id}.json`);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { worktree_path: string };
    const externalName = "Внешний файл.txt";
    await writeFile(path.join(metadata.worktree_path, "projects", FIXTURE_PROJECT_ID, "files", externalName), "Внешнее изменение\n", "utf8");
    const polled = await request.get(`/api/drafts/${encodeURIComponent(draft.draft_id)}`);
    expect(polled.status(), await polled.text()).toBe(200);
    expect(await polled.json()).toMatchObject({ writer_mode: "external", changed_externally: true });
    await page.goto(`/projects/${FIXTURE_PROJECT_ID}`);
    await expect(page.getByText("Editing is unavailable because external writer mode is active. Switch back to the UI writer after the external tool stops.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Files/u }).click();
    const readonlyPanel = page.getByRole("dialog", { name: /Project files/u });
    await expect(readonlyPanel.getByText(externalName, { exact: true }).first()).toBeVisible();
    await expect(readonlyPanel.getByText("You can view files, but this draft cannot currently be changed.", { exact: true })).toBeVisible();
    await expect(readonlyPanel.getByRole("button", { name: "Upload files", exact: true })).toBeDisabled();
    const uiMode = await request.patch(`/api/drafts/${encodeURIComponent(draft.draft_id)}/writer-mode`, { data: { writer_mode: "ui" } });
    expect(uiMode.status(), await uiMode.text()).toBe(200);
    await cleanupDrafts(request, worktreeDraftId);
  }
});
