// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ProjectFileItem, ProjectFileList } from "@gitpm/contracts";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api.js";
import { PROJECT_FILES_VIEW_COOKIE, ProjectFilesPanel, projectFileFamily, readProjectFilesView, type ProjectFilesView } from "./project-files-panel.js";

const uploadApi = { deleteProjectFile: vi.fn(), projectFileReferences: vi.fn(), renameProjectFile: vi.fn(), replaceProjectFile: vi.fn(), uploadProjectFile: vi.fn() };
const uploadProps = { api: uploadApi, draftId: "DRF-1", fingerprint: "b".repeat(64), onDeleted: vi.fn(), onRenamed: vi.fn(), onReplaced: vi.fn(), onUploaded: vi.fn(), projectId: "P-26-111111", readOnly: false };

const item = (name: string, size_bytes = 1234): ProjectFileItem => ({
  name,
  path: `projects/P-26-111111/files/${name}`,
  size_bytes,
  media_type: "application/octet-stream",
  disposition: "attachment",
  modified_at: "2026-08-13T10:00:00.000Z",
  modified_at_source: "working_copy_filesystem",
});

const list = (items: readonly ProjectFileItem[]): ProjectFileList => ({
  project_id: "P-26-111111",
  count: items.length,
  total_size_bytes: items.reduce((total, file) => total + file.size_bytes, 0),
  items,
  draft_fingerprint: "b".repeat(64),
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  document.cookie = `${encodeURIComponent(PROJECT_FILES_VIEW_COOKIE)}=; Path=/; Max-Age=0`;
});
beforeEach(() => {
  uploadApi.projectFileReferences.mockResolvedValue({ project_id: "P-26-111111", file_name: "file", status: "checked", count: 0, locations: [], draft_fingerprint: "b".repeat(64) });
});

describe("ProjectFilesPanel", () => {
  const fileWithSize = (name: string, size: number): File => {
    const file = new File([new Uint8Array([1])], name, { type: "application/octet-stream" });
    Object.defineProperty(file, "size", { configurable: true, value: size });
    return file;
  };
  const uploaded = (name: string, size: number, fingerprint = "c".repeat(64), operation: "created" | "replaced" = "created") => ({
    project_id: "P-26-111111", operation,
    item: item(name, size), draft_fingerprint: fingerprint,
  });

  it("renders loading, empty, and retryable error states", () => {
    const onReload = vi.fn();
    const props = { ...uploadProps, locale: "en", list: null, onClose: vi.fn(), onReload, onViewChange: vi.fn(), open: true, view: "grid" as const };
    const rendered = render(<ProjectFilesPanel {...props} loadState={{ status: "loading" }} />);
    expect(screen.getByRole("status").textContent).toContain("Loading project files");

    rendered.rerender(<ProjectFilesPanel {...props} list={list([])} loadState={{ status: "ready" }} />);
    expect(screen.getByText("No files yet")).toBeTruthy();

    rendered.rerender(<ProjectFilesPanel {...props} loadState={{ status: "error", error: "offline" }} />);
    expect(screen.getByRole("alert").textContent).toContain("offline");
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("renders familiar file families and treats hostile and long names as text", () => {
    const hostile = '<img src=x onerror="globalThis.pwned=true">.pdf';
    const names = [hostile, "Техническое задание с очень длинным полным именем версии 24.docx", "budget.xlsx", "deck.pptx", "photo.png", "notes.md", "source.zip", "opaque.bin"];
    render(<ProjectFilesPanel {...uploadProps} locale="en" list={list(names.map((name) => item(name)))} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);

    expect(screen.getByText(hostile)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    const longTile = screen.getByRole("link", { name: `Download ${names[1]!}` }).closest("li") as HTMLElement;
    expect(longTile.title).toBe(names[1]);
    expect(Array.from(document.querySelectorAll(".project-file-icon-label")).map((node) => node.textContent)).toEqual(["PDF", "DOC", "XLS", "PPT", "IMG", "TXT", "ZIP", "FILE"]);
  });

  it("switches every Project panel view through a resilient shared cookie", () => {
    function Harness() {
      const [view, setView] = useState<ProjectFilesView>(readProjectFilesView);
      return <ProjectFilesPanel {...uploadProps} locale="en" list={list([item("brief.pdf")])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={setView} open view={view} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Table view" }));
    expect(screen.getByRole("table")).toBeTruthy();
    expect(readProjectFilesView()).toBe("table");
    expect(document.cookie).toContain(`${encodeURIComponent(PROJECT_FILES_VIEW_COOKIE)}=table`);

    expect(readProjectFilesView(`${PROJECT_FILES_VIEW_COOKIE}=%E0%A4%A`)).toBe("grid");
    expect(readProjectFilesView(`${PROJECT_FILES_VIEW_COOKIE}=tiles`)).toBe("grid");
  });

  it("uploads exactly 50 MiB directly but requires an exact per-file confirmation above it", async () => {
    const atLimit = fileWithSize("ровно-50.bin", 50 * 1024 * 1024);
    const aboveLimit = fileWithSize("Большой <план>.bin", 50 * 1024 * 1024 + 1);
    uploadApi.uploadProjectFile
      .mockResolvedValueOnce(uploaded(atLimit.name, atLimit.size))
      .mockResolvedValueOnce(uploaded(aboveLimit.name, aboveLimit.size, "d".repeat(64)));
    render(<ProjectFilesPanel {...uploadProps} locale="ru" list={list([])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);
    const input = screen.getByLabelText("Выбрать файлы проекта для загрузки");

    fireEvent.change(input, { target: { files: [atLimit] } });
    await waitFor(() => expect(uploadApi.uploadProjectFile).toHaveBeenCalledTimes(1));
    expect(uploadApi.uploadProjectFile.mock.calls[0]![6]?.largeFileConfirmation).toBeUndefined();

    fireEvent.change(input, { target: { files: [aboveLimit] } });
    const dialog = await screen.findByRole("dialog", { name: "Подтверждение большого файла" });
    const confirmButton = within(dialog).getByRole("button", { name: "Всё равно загрузить большой файл" });
    expect(confirmButton).toHaveProperty("disabled", true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: `${aboveLimit.name} ` } });
    expect(confirmButton).toHaveProperty("disabled", true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: aboveLimit.name } });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(uploadApi.uploadProjectFile).toHaveBeenCalledTimes(2));
    expect(uploadApi.uploadProjectFile.mock.calls[1]![4]).toBe(aboveLimit.name);
    expect(uploadApi.uploadProjectFile.mock.calls[1]![6]?.largeFileConfirmation).toBe(aboveLimit.name);
  });

  it("confirms each large file in a multiple selection separately", async () => {
    const first = fileWithSize("Первый большой.bin", 50 * 1024 * 1024 + 1);
    const second = fileWithSize("Второй большой.bin", 50 * 1024 * 1024 + 2);
    uploadApi.uploadProjectFile
      .mockResolvedValueOnce(uploaded(first.name, first.size, "c".repeat(64)))
      .mockResolvedValueOnce(uploaded(second.name, second.size, "d".repeat(64)));
    render(<ProjectFilesPanel {...uploadProps} locale="ru" list={list([])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);
    fireEvent.change(screen.getByLabelText("Выбрать файлы проекта для загрузки"), { target: { files: [first, second] } });

    let dialog = await screen.findByRole("dialog", { name: "Подтверждение большого файла" });
    expect(dialog.textContent).toContain(first.name);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: first.name } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Всё равно загрузить большой файл" }));
    await waitFor(() => expect(uploadApi.uploadProjectFile).toHaveBeenCalledTimes(1));

    dialog = await screen.findByRole("dialog", { name: "Подтверждение большого файла" });
    await waitFor(() => expect(dialog.textContent).toContain(second.name));
    expect(within(dialog).getByRole<HTMLInputElement>("textbox").value).toBe("");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: second.name } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Всё равно загрузить большой файл" }));
    await waitFor(() => expect(uploadApi.uploadProjectFile).toHaveBeenCalledTimes(2));
    expect(uploadApi.uploadProjectFile.mock.calls.map((call) => call[6]?.largeFileConfirmation)).toEqual([first.name, second.name]);
  });

  it("keeps successful drag-and-drop items while another fails, then retries with the latest fingerprint", async () => {
    const first = fileWithSize("договор.bin", 3);
    const second = fileWithSize("ошибка.bin", 4);
    const onUploaded = vi.fn();
    uploadApi.uploadProjectFile
      .mockResolvedValueOnce(uploaded(first.name, first.size, "c".repeat(64)))
      .mockRejectedValueOnce(new ApiError("FORBIDDEN", "Reporter cannot upload"))
      .mockResolvedValueOnce(uploaded(second.name, second.size, "d".repeat(64)));
    render(<ProjectFilesPanel {...uploadProps} onUploaded={onUploaded} locale="en" list={list([])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);

    fireEvent.drop(screen.getByText("Drop files here to upload"), { dataTransfer: { files: [first, second] } });
    await waitFor(() => expect(screen.getByText(/uploaded/u)).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/failed/u)).toBeTruthy());
    expect(screen.getByText(first.name)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("FORBIDDEN");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(uploadApi.uploadProjectFile).toHaveBeenCalledTimes(3));
    expect(uploadApi.uploadProjectFile.mock.calls[1]![2]).toBe("c".repeat(64));
    expect(uploadApi.uploadProjectFile.mock.calls[2]![2]).toBe("c".repeat(64));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText(/uploaded/u)).toHaveLength(2);
  });

  it("offers explicit replace or a different name for conflicts", async () => {
    const existing = item("ТЗ.docx", 10);
    const replacement = fileWithSize(existing.name, 11);
    const caseConflict = fileWithSize("тз.DOCX", 12);
    uploadApi.uploadProjectFile
      .mockResolvedValueOnce(uploaded(existing.name, replacement.size, "c".repeat(64), "replaced"))
      .mockResolvedValueOnce(uploaded("ТЗ новая.docx", caseConflict.size, "d".repeat(64)));
    render(<ProjectFilesPanel {...uploadProps} locale="ru" list={list([existing])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);
    const input = screen.getByLabelText("Выбрать файлы проекта для загрузки");

    fireEvent.change(input, { target: { files: [replacement] } });
    expect(uploadApi.uploadProjectFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Заменить текущий файл" }));
    const replaceDialog = await screen.findByRole("dialog", { name: "Подтверждение замены файла" });
    expect(replaceDialog.textContent).toContain("0 проверенных ссылок");
    fireEvent.click(within(replaceDialog).getByRole("button", { name: "Заменить файл и сохранить ссылки" }));
    await waitFor(() => expect(uploadApi.uploadProjectFile).toHaveBeenCalledTimes(1));
    expect(uploadApi.uploadProjectFile.mock.calls[0]!.slice(4, 6)).toEqual([existing.name, "replace"]);

    fireEvent.change(input, { target: { files: [caseConflict] } });
    const rename = screen.getByLabelText(`Другое имя для файла ${caseConflict.name}`);
    fireEvent.change(rename, { target: { value: "ТЗ новая.docx" } });
    fireEvent.click(within(rename.closest(".project-files-conflict") as HTMLElement).getByRole("button", { name: "Загрузить с этим именем" }));
    await waitFor(() => expect(uploadApi.uploadProjectFile).toHaveBeenCalledTimes(2));
    expect(uploadApi.uploadProjectFile.mock.calls[1]!.slice(4, 6)).toEqual(["ТЗ новая.docx", "create"]);
  });

  it("traps and restores replacement confirmation focus and closes it from Escape or its backdrop", async () => {
    const existing = item("contract.docx", 10);
    const inputFile = () => fileWithSize(existing.name, 11);
    render(<ProjectFilesPanel {...uploadProps} locale="en" list={list([existing])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);
    const input = screen.getByLabelText("Select project files to upload");

    fireEvent.change(input, { target: { files: [inputFile()] } });
    fireEvent.click(screen.getByRole("button", { name: "Replace current file" }));
    let dialog = await screen.findByRole("dialog", { name: "Confirm file replacement" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const confirm = within(dialog).getByRole("button", { name: "Replace file and preserve references" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm file replacement" })).toBeNull());
    expect(document.activeElement?.classList.contains("project-files-upload-item")).toBe(true);

    fireEvent.change(input, { target: { files: [inputFile()] } });
    fireEvent.click(await screen.findByRole("button", { name: "Replace current file" }));
    dialog = await screen.findByRole("dialog", { name: "Confirm file replacement" });
    fireEvent.mouseDown(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm file replacement" })).toBeNull());
    expect(uploadApi.uploadProjectFile).not.toHaveBeenCalled();
  });

  it("cancels an active upload and disables selection and drops in read-only mode", async () => {
    const pending = fileWithSize("pending.bin", 8);
    uploadApi.uploadProjectFile.mockImplementationOnce(async (_draft, _project, _fingerprint, _file, _name, _mode, options) => await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true })));
    const rendered = render(<ProjectFilesPanel {...uploadProps} locale="en" list={list([])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);
    fireEvent.change(screen.getByLabelText("Select project files to upload"), { target: { files: [pending] } });
    await waitFor(() => expect(screen.getByText(/uploading/u)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByText(/cancelled/u)).toBeTruthy());

    rendered.rerender(<ProjectFilesPanel {...uploadProps} readOnly locale="en" list={list([])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);
    expect(screen.getByRole("button", { name: "Upload files" })).toHaveProperty("disabled", true);
    fireEvent.drop(screen.getByText("Uploads are unavailable while this draft is read-only."), { dataTransfer: { files: [fileWithSize("ignored.bin", 1)] } });
    expect(uploadApi.uploadProjectFile).toHaveBeenCalledTimes(1);
  });

  it("uses encoded server open/download URLs and shows only repository-relative properties", () => {
    const preview = { ...item("Схема </a>.pdf", 2048), media_type: "application/pdf", disposition: "inline" as const };
    const attachment = item("ТЗ #1.docx", 4096);
    render(<ProjectFilesPanel {...uploadProps} locale="en" list={list([preview, attachment])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);

    const previewLink = screen.getByRole("link", { name: `Open ${preview.name} in a new tab` });
    const downloadLink = screen.getByRole("link", { name: `Download ${attachment.name}` });
    expect(previewLink.getAttribute("href")).toBe(`/api/drafts/DRF-1/projects/P-26-111111/files/${encodeURIComponent(preview.name)}/content`);
    expect(downloadLink.getAttribute("href")).toBe(`/api/drafts/DRF-1/projects/P-26-111111/files/${encodeURIComponent(attachment.name)}/download`);
    expect(previewLink).toHaveProperty("target", "_blank");
    expect(previewLink.getAttribute("rel")).toBe("noopener noreferrer");

    fireEvent.click(screen.getByRole("button", { name: `Select ${preview.name} for file actions` }));
    const propertiesTrigger = screen.getByRole("button", { name: "Properties" });
    fireEvent.click(propertiesTrigger);
    const dialog = screen.getByRole("dialog", { name: "File properties" });
    expect(dialog.textContent).toContain(preview.path);
    expect(dialog.textContent).toContain("current working-copy filesystem");
    expect(dialog.textContent).not.toMatch(/[A-Z]:\\|\/home\//u);
    const close = within(dialog).getByRole("button", { name: "Close editor" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: "Escape" });
    return waitFor(() => {
      expect(document.activeElement).toBe(propertiesTrigger);
      expect(screen.getByRole("dialog", { name: "Project files · 2" })).toBeTruthy();
    }).then(() => {
      fireEvent.click(propertiesTrigger);
      const reopened = screen.getByRole("dialog", { name: "File properties" });
      fireEvent.mouseDown(reopened);
      return waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "File properties" })).toBeNull();
        expect(screen.getByRole("dialog", { name: "Project files · 2" })).toBeTruthy();
      });
    });
  });

  it("renames Unicode and case-only names with the current fingerprint and surfaces conflicts", async () => {
    const original = { ...item("ТЗ v3.DOCX"), media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    const result = { project_id: "P-26-111111", operation: "renamed" as const, previous_name: original.name, item: { ...original, name: "ТЗ V3.docx", path: "projects/P-26-111111/files/ТЗ V3.docx" }, references: { status: "not_checked" as const }, draft_fingerprint: "c".repeat(64) };
    uploadApi.renameProjectFile.mockResolvedValueOnce(result);
    const onRenamed = vi.fn();
    render(<ProjectFilesPanel {...uploadProps} onRenamed={onRenamed} locale="ru" list={list([original])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);
    fireEvent.click(screen.getByRole("button", { name: `Выбрать файл ${original.name} для действий` }));
    fireEvent.click(screen.getByRole("button", { name: "Переименовать" }));
    const dialog = screen.getByRole("dialog", { name: "Переименование файла" });
    fireEvent.change(within(dialog).getByLabelText("Новое полное имя файла"), { target: { value: result.item.name } });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Переименовать" })).toHaveProperty("disabled", false));
    fireEvent.click(within(dialog).getByRole("button", { name: "Переименовать" }));
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith(result));
    expect(uploadApi.renameProjectFile).toHaveBeenCalledWith("DRF-1", "P-26-111111", original.name, "b".repeat(64), result.item.name, "update");

    cleanup();
    uploadApi.renameProjectFile.mockRejectedValueOnce(new ApiError("PROJECT_FILE_NAME_CONFLICT", "name exists"));
    render(<ProjectFilesPanel {...uploadProps} locale="en" list={list([original])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);
    fireEvent.click(screen.getByRole("button", { name: `Select ${original.name} for file actions` }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const conflictDialog = screen.getByRole("dialog", { name: "Rename file" });
    fireEvent.change(within(conflictDialog).getByLabelText("New full file name"), { target: { value: "CONTRACT.docx" } });
    await waitFor(() => expect(within(conflictDialog).getByRole("button", { name: "Rename" })).toHaveProperty("disabled", false));
    fireEvent.click(within(conflictDialog).getByRole("button", { name: "Rename" }));
    expect((await within(conflictDialog).findByRole("alert")).textContent).toContain("PROJECT_FILE_NAME_CONFLICT");
    expect(screen.getByRole("link", { name: `Download ${original.name}` })).toBeTruthy();
  });

  it("requires the exact full name for delete and updates through the decoded result", async () => {
    const doomed = item("Договор final.pdf", 88);
    const result = { project_id: "P-26-111111", operation: "deleted" as const, name: doomed.name, path: doomed.path, size_bytes: doomed.size_bytes, references: { status: "not_checked" as const }, secure_erase: false as const, draft_fingerprint: "d".repeat(64) };
    uploadApi.deleteProjectFile.mockResolvedValueOnce(result);
    const onDeleted = vi.fn();
    render(<ProjectFilesPanel {...uploadProps} onDeleted={onDeleted} locale="en" list={list([doomed])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);
    fireEvent.click(screen.getByRole("button", { name: `Select ${doomed.name} for file actions` }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete file" });
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    expect(confirm).toHaveProperty("disabled", true);
    expect(dialog.textContent).toContain("not secure erase");
    await waitFor(() => expect(dialog.textContent).toContain("Verified references in this Project: 0"));
    fireEvent.change(within(dialog).getByLabelText(`Type the exact full name “${doomed.name}” to delete`), { target: { value: doomed.name.toLocaleLowerCase() } });
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.change(within(dialog).getByLabelText(`Type the exact full name “${doomed.name}” to delete`), { target: { value: doomed.name } });
    fireEvent.click(confirm);
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(result));
    expect(uploadApi.deleteProjectFile).toHaveBeenCalledWith("DRF-1", "P-26-111111", doomed.name, "b".repeat(64), doomed.name, "restrict");
  });

  it("requires separate explicit consent before unlinking referenced text on delete", async () => {
    const doomed = item("referenced.txt", 8);
    uploadApi.projectFileReferences.mockResolvedValueOnce({ project_id: "P-26-111111", file_name: doomed.name, status: "checked", count: 1, locations: [{ entity_type: "task", entity_id: "T-26-P9G3P8", path: "projects/P-26-111111/tasks/T-26-P9G3P8.yaml", field: "description_markdown", start: 0, end: 23 }], draft_fingerprint: "b".repeat(64) });
    uploadApi.deleteProjectFile.mockResolvedValueOnce({ project_id: "P-26-111111", operation: "deleted", name: doomed.name, path: doomed.path, size_bytes: doomed.size_bytes, references: { status: "checked", action: "unlinked", before_count: 1, affected_count: 1, remaining_count: 0, locations: [] }, secure_erase: false, draft_fingerprint: "c".repeat(64) });
    render(<ProjectFilesPanel {...uploadProps} locale="en" list={list([doomed])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);
    fireEvent.click(screen.getByRole("button", { name: `Select ${doomed.name} for file actions` }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete file" });
    await waitFor(() => expect(dialog.textContent).toContain("Verified references in this Project: 1"));
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: doomed.name } });
    const confirm = within(dialog).getByRole("button", { name: "Delete" });
    expect(confirm).toHaveProperty("disabled", true);
    expect(uploadApi.deleteProjectFile).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    expect(confirm).toHaveProperty("disabled", false);
    fireEvent.click(confirm);
    await waitFor(() => expect(uploadApi.deleteProjectFile).toHaveBeenCalledWith("DRF-1", "P-26-111111", doomed.name, "b".repeat(64), doomed.name, "unlink"));
  });

  it("replaces the selected file with a differently named local file after checked preview", async () => {
    const old = item("old.txt", 3);
    const next = new File(["new bytes"], "new.txt", { type: "text/plain" });
    const result = { project_id: "P-26-111111", operation: "replaced" as const, previous_name: old.name, item: item(next.name, next.size), references: { status: "checked" as const, action: "updated" as const, before_count: 1, affected_count: 1, remaining_count: 0, locations: [] }, draft_fingerprint: "c".repeat(64) };
    uploadApi.projectFileReferences.mockResolvedValueOnce({ project_id: "P-26-111111", file_name: old.name, status: "checked", count: 1, locations: [], draft_fingerprint: "b".repeat(64) });
    uploadApi.replaceProjectFile.mockResolvedValueOnce(result);
    const onReplaced = vi.fn();
    render(<ProjectFilesPanel {...uploadProps} onReplaced={onReplaced} locale="en" list={list([old])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);
    fireEvent.click(screen.getByRole("button", { name: `Select ${old.name} for file actions` }));
    fireEvent.click(screen.getByRole("button", { name: "Replace with new file" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm file replacement" });
    await waitFor(() => expect(dialog.textContent).toContain("Verified references in this Project: 1"));
    fireEvent.change(within(dialog).getByLabelText("Choose the new local file"), { target: { files: [next] } });
    expect(dialog.textContent).toContain("old.txt");
    expect(dialog.textContent).toContain("new.txt");
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace file and preserve references" }));
    await waitFor(() => expect(uploadApi.replaceProjectFile).toHaveBeenCalledWith("DRF-1", "P-26-111111", old.name, "b".repeat(64), next, next.name, expect.any(Object)));
    expect(onReplaced).toHaveBeenCalledWith(result);
  });

  it("requires the exact new local name before replacing a selected file above 50 MiB", async () => {
    const old = item("old.bin", 3);
    const next = fileWithSize("new-large.bin", 50 * 1024 * 1024 + 1);
    render(<ProjectFilesPanel {...uploadProps} locale="en" list={list([old])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);
    fireEvent.click(screen.getByRole("button", { name: `Select ${old.name} for file actions` }));
    fireEvent.click(screen.getByRole("button", { name: "Replace with new file" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm file replacement" });
    await waitFor(() => expect(dialog.textContent).toContain("Verified references"));
    fireEvent.change(within(dialog).getByLabelText("Choose the new local file"), { target: { files: [next] } });
    const confirm = within(dialog).getByRole("button", { name: "Replace file and preserve references" });
    expect(confirm).toHaveProperty("disabled", true);
    const textboxes = within(dialog).getAllByRole("textbox");
    fireEvent.change(textboxes.at(-1)!, { target: { value: next.name.toUpperCase() } });
    expect(confirm).toHaveProperty("disabled", true);
    fireEvent.change(textboxes.at(-1)!, { target: { value: next.name } });
    expect(confirm).toHaveProperty("disabled", false);
  });

  it("blocks on preview failure, retries, and ignores a cancelled replacement preview", async () => {
    const deferred: { resolve?: (value: unknown) => void } = {};
    uploadApi.projectFileReferences.mockReset()
      .mockRejectedValueOnce(new ApiError("NETWORK_ERROR", "offline"))
      .mockResolvedValueOnce({ project_id: "P-26-111111", file_name: "ref.txt", status: "checked", count: 1, locations: [{ entity_type: "task", entity_id: "T-26-P9G3P8", path: "projects/P-26-111111/tasks/T-26-P9G3P8.yaml", field: "description_markdown", start: 0, end: 16 }], draft_fingerprint: "b".repeat(64) })
      .mockImplementationOnce(async () => await new Promise((resolve) => { deferred.resolve = resolve; }));
    const referenced = item("ref.txt");
    render(<ProjectFilesPanel {...uploadProps} locale="en" list={list([referenced])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);
    fireEvent.click(screen.getByRole("button", { name: `Select ${referenced.name} for file actions` }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog", { name: "Delete file" });
    expect((await within(dialog).findByRole("alert")).textContent).toContain("action is blocked");
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(dialog.textContent).toContain("Verified references in this Project: 1"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    const replacement = new File(["new"], referenced.name);
    fireEvent.change(screen.getByLabelText("Select project files to upload"), { target: { files: [replacement] } });
    fireEvent.click(await screen.findByRole("button", { name: "Replace current file" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    deferred.resolve?.({ project_id: "P-26-111111", file_name: referenced.name, status: "checked", count: 0, locations: [], draft_fingerprint: "b".repeat(64) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("dialog", { name: "Confirm file replacement" })).toBeNull();
    expect(uploadApi.uploadProjectFile).not.toHaveBeenCalled();
  });

  it("keeps open, download and properties available but disables mutations in read-only mode", () => {
    const readonly = { ...item("read only.txt"), media_type: "text/plain", disposition: "inline" as const };
    render(<ProjectFilesPanel {...uploadProps} readOnly locale="en" list={list([readonly])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="table" />);
    expect(screen.getByRole("link", { name: `Open ${readonly.name} in a new tab` })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Select ${readonly.name} for file actions` }));
    expect(screen.getByRole("link", { name: "Download" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Properties" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Rename" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Delete" })).toHaveProperty("disabled", true);
  });

  it("shows verified property references to a read-only viewer and retries an error", async () => {
    uploadApi.projectFileReferences.mockReset()
      .mockRejectedValueOnce(new ApiError("NETWORK_ERROR", "offline"))
      .mockResolvedValueOnce({ project_id: "P-26-111111", file_name: "read only.txt", status: "checked", count: 2, locations: [{ entity_type: "task", entity_id: "T-26-P9G3P8", path: "projects/P-26-111111/tasks/T-26-P9G3P8.yaml", field: "description_markdown", start: 0, end: 22 }], draft_fingerprint: "b".repeat(64) });
    const readonly = item("read only.txt");
    render(<ProjectFilesPanel {...uploadProps} readOnly locale="en" list={list([readonly])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);
    fireEvent.click(screen.getByRole("button", { name: `Select ${readonly.name} for file actions` }));
    fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    const dialog = screen.getByRole("dialog", { name: "File properties" });
    expect((await within(dialog).findByRole("alert")).textContent).toContain("action is blocked");
    expect(dialog.textContent).toContain("Not verified");
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(dialog.textContent).toContain("References in this Project2"));
    expect(dialog.textContent).toContain("T-26-P9G3P8");
  });
});

describe("projectFileFamily", () => {
  it("uses the neutral family for unknown and extensionless files", () => {
    expect(projectFileFamily("README")).toBe("file");
    expect(projectFileFamily("CAD.model")).toBe("file");
  });
});
