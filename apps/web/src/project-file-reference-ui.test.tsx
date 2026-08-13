// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ProjectFileList } from "@gitpm/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafeMarkdown } from "./core-ui.js";
import { ProjectFileMarkdownField, type ProjectFileReferenceContext } from "./project-file-reference-ui.js";

const list: ProjectFileList = {
  project_id: "P-26-111111",
  count: 2,
  total_size_bytes: 3,
  draft_fingerprint: "a".repeat(64),
  items: [
    { name: "ТЗ [финал].pdf", path: "projects/P-26-111111/files/ТЗ [финал].pdf", size_bytes: 1, media_type: "application/pdf", disposition: "inline", modified_at: "2026-08-13T00:00:00Z", modified_at_source: "working_copy_filesystem" },
    { name: "Документ.docx", path: "projects/P-26-111111/files/Документ.docx", size_bytes: 2, media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", disposition: "attachment", modified_at: "2026-08-13T00:00:00Z", modified_at_source: "working_copy_filesystem" },
  ],
};
const context: ProjectFileReferenceContext = { draftId: "DRF А", projectId: list.project_id, files: list, loadState: { status: "ready" }, locale: "en", onReload: vi.fn() };

afterEach(cleanup);

describe("Project file reference UI", () => {
  it("preserves Markdown precedence and safely renders exact, missing, malformed, escaped, path-looking, and hostile references", () => {
    const source = "# **See [[file:ТЗ \\[финал\\].pdf]]** [[file:a**b.pdf]]\n- Missing [[file:документ.docx]] [[file:../secret]]\n\\[[file:Документ.docx]] [[file:bad\\q]] <img src=x onerror=alert(1)>";
    const rendered = render(<SafeMarkdown fileContext={context} source={source} />);
    const link = screen.getByRole("link", { name: "Open ТЗ [финал].pdf in a new tab" });
    expect(link.getAttribute("href")).toBe("/api/drafts/DRF%20%D0%90/projects/P-26-111111/files/%D0%A2%D0%97%20%5B%D1%84%D0%B8%D0%BD%D0%B0%D0%BB%5D.pdf/content");
    expect(link.closest("strong")).toBeTruthy();
    expect(screen.getByRole("note", { name: "Broken file reference: a**b.pdf" }).textContent).toContain("a**b.pdf");
    expect(screen.getByRole("note", { name: "Broken file reference: документ.docx" })).toBeTruthy();
    expect(screen.getByRole("note", { name: "Broken file reference: ../secret" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Документ/u })).toBeNull();
    expect(rendered.container.textContent).toContain("[[file:bad\\q]]");
    expect(rendered.container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(rendered.container.querySelector("img,script,svg")).toBeNull();
  });

  it("uses the download route for attachment DTOs", () => {
    render(<SafeMarkdown fileContext={context} source="[[file:Документ.docx]]" />);
    expect(screen.getByRole("link", { name: "Download Документ.docx" }).getAttribute("href")).toContain("/%D0%94%D0%BE%D0%BA%D1%83%D0%BC%D0%B5%D0%BD%D1%82.docx/download");
  });

  it("inserts a canonical long Unicode reference over the selection and returns focus", async () => {
    const onValueChange = vi.fn();
    const rendered = render(<ProjectFileMarkdownField context={context} disabled={false} label="Description" onValueChange={onValueChange} value="Before selected after" />);
    const textarea = screen.getByLabelText("Description") as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(7, 15);
    fireEvent.click(screen.getByRole("button", { name: "Insert file" }));
    const picker = screen.getByRole("group", { name: "Choose a Project file to link" });
    fireEvent.click(within(picker).getByRole("button", { name: /ТЗ/u }));
    expect(onValueChange).toHaveBeenCalledWith("Before [[file:ТЗ \\[финал\\].pdf]] after");
    const inserted = String(onValueChange.mock.calls[0]?.[0]);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(textarea);
    rendered.rerender(<ProjectFileMarkdownField context={context} disabled={false} label="Description" onValueChange={onValueChange} value={inserted} />);
    expect(textarea.value).toBe(inserted);
  });

  it("shows loading, empty, error/retry and disables insertion in read-only state", () => {
    const { rerender } = render(<ProjectFileMarkdownField context={{ ...context, files: null, loadState: { status: "loading" } }} disabled={false} label="Description" />);
    fireEvent.click(screen.getByRole("button", { name: "Insert file" }));
    expect(screen.getByRole("status").textContent).toContain("Loading");
    const reload = vi.fn();
    rerender(<ProjectFileMarkdownField context={{ ...context, files: null, loadState: { status: "error", error: "offline" }, onReload: reload }} disabled={false} label="Description" />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reload).toHaveBeenCalledOnce();
    rerender(<ProjectFileMarkdownField context={{ ...context, files: { ...list, count: 0, items: [] } }} disabled={false} label="Description" />);
    expect(screen.getByText("This Project has no files to link.")).toBeTruthy();
    rerender(<ProjectFileMarkdownField context={context} disabled label="Description" />);
    expect(screen.getByRole("button", { name: "Insert file" })).toHaveProperty("disabled", true);
  });

  it("keeps references neutral until a ready exact list can resolve them", () => {
    const { rerender } = render(<SafeMarkdown fileContext={{ ...context, files: null, loadState: { status: "loading" } }} source="[[file:Документ.docx]]" />);
    expect(screen.getByLabelText("File reference not checked: Документ.docx").textContent).toBe("[[file:Документ.docx]]");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
    rerender(<SafeMarkdown fileContext={context} source="[[file:Документ.docx]]" />);
    expect(screen.getByRole("link", { name: "Download Документ.docx" })).toBeTruthy();
    rerender(<SafeMarkdown fileContext={{ ...context, files: { ...list, count: 0, items: [] } }} source="[[file:Документ.docx]]" />);
    expect(screen.getByRole("note", { name: "Broken file reference: Документ.docx" })).toBeTruthy();
  });

  it("closes the picker on Escape and returns focus to its trigger", async () => {
    render(<ProjectFileMarkdownField context={context} disabled={false} label="Description" />);
    const trigger = screen.getByRole("button", { name: "Insert file" });
    fireEvent.click(trigger);
    const picker = screen.getByRole("group", { name: "Choose a Project file to link" });
    (within(picker).getAllByRole("button")[0] as HTMLButtonElement).focus();
    fireEvent.keyDown(picker, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Choose a Project file to link" })).toBeNull();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(trigger);
  });
});
