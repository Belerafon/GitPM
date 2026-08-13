// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ProjectFileItem, ProjectFileList } from "@gitpm/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api.js";
import { PROJECT_FILES_VIEW_COOKIE, ProjectFilesPanel, projectFileFamily, readProjectFilesView, type ProjectFilesView } from "./project-files-panel.js";

const uploadApi = { uploadProjectFile: vi.fn() };
const uploadProps = { api: uploadApi, draftId: "DRF-1", fingerprint: "b".repeat(64), onUploaded: vi.fn(), projectId: "P-26-111111", readOnly: false };

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
    const longTile = screen.getByLabelText(names[1]!);
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
    await waitFor(() => expect(uploadApi.uploadProjectFile).toHaveBeenCalledTimes(1));
    expect(uploadApi.uploadProjectFile.mock.calls[0]!.slice(4, 6)).toEqual([existing.name, "replace"]);

    fireEvent.change(input, { target: { files: [caseConflict] } });
    const rename = screen.getByLabelText(`Другое имя для файла ${caseConflict.name}`);
    fireEvent.change(rename, { target: { value: "ТЗ новая.docx" } });
    fireEvent.click(within(rename.closest(".project-files-conflict") as HTMLElement).getByRole("button", { name: "Загрузить с этим именем" }));
    await waitFor(() => expect(uploadApi.uploadProjectFile).toHaveBeenCalledTimes(2));
    expect(uploadApi.uploadProjectFile.mock.calls[1]!.slice(4, 6)).toEqual(["ТЗ новая.docx", "create"]);
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
});

describe("projectFileFamily", () => {
  it("uses the neutral family for unknown and extensionless files", () => {
    expect(projectFileFamily("README")).toBe("file");
    expect(projectFileFamily("CAD.model")).toBe("file");
  });
});
