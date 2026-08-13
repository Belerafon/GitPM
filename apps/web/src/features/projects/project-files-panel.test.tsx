// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ProjectFileItem, ProjectFileList } from "@gitpm/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_FILES_VIEW_COOKIE, ProjectFilesPanel, projectFileFamily, readProjectFilesView, type ProjectFilesView } from "./project-files-panel.js";

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
  document.cookie = `${encodeURIComponent(PROJECT_FILES_VIEW_COOKIE)}=; Path=/; Max-Age=0`;
});

describe("ProjectFilesPanel", () => {
  it("renders loading, empty, and retryable error states", () => {
    const onReload = vi.fn();
    const props = { locale: "en", list: null, onClose: vi.fn(), onReload, onViewChange: vi.fn(), open: true, view: "grid" as const };
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
    render(<ProjectFilesPanel locale="en" list={list(names.map((name) => item(name)))} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={vi.fn()} open view="grid" />);

    expect(screen.getByText(hostile)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    const longTile = screen.getByLabelText(names[1]!);
    expect(longTile.title).toBe(names[1]);
    expect(Array.from(document.querySelectorAll(".project-file-icon-label")).map((node) => node.textContent)).toEqual(["PDF", "DOC", "XLS", "PPT", "IMG", "TXT", "ZIP", "FILE"]);
  });

  it("switches every Project panel view through a resilient shared cookie", () => {
    function Harness() {
      const [view, setView] = useState<ProjectFilesView>(readProjectFilesView);
      return <ProjectFilesPanel locale="en" list={list([item("brief.pdf")])} loadState={{ status: "ready" }} onClose={vi.fn()} onReload={vi.fn()} onViewChange={setView} open view={view} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Table view" }));
    expect(screen.getByRole("table")).toBeTruthy();
    expect(readProjectFilesView()).toBe("table");
    expect(document.cookie).toContain(`${encodeURIComponent(PROJECT_FILES_VIEW_COOKIE)}=table`);

    expect(readProjectFilesView(`${PROJECT_FILES_VIEW_COOKIE}=%E0%A4%A`)).toBe("grid");
    expect(readProjectFilesView(`${PROJECT_FILES_VIEW_COOKIE}=tiles`)).toBe("grid");
  });
});

describe("projectFileFamily", () => {
  it("uses the neutral family for unknown and extensionless files", () => {
    expect(projectFileFamily("README")).toBe("file");
    expect(projectFileFamily("CAD.model")).toBe("file");
  });
});
