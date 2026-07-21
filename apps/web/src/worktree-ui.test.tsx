// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import type { DraftStatus } from "./types.js";
import { WorktreeWorkspace } from "./worktree-ui.js";

const draft: DraftStatus = {
  draft_id: "DRF-TREE",
  owner_gitlab_user_id: "42",
  branch: "gitpm/42/DRF-TREE",
  base_commit: "a".repeat(40),
  writer_mode: "ui",
  state: "open",
  fingerprint: "b".repeat(64),
  created_at: "2026-07-21T00:00:00.000Z",
  updated_at: "2026-07-21T00:00:00.000Z",
};

afterEach(cleanup);

describe("working tree browser", () => {
  it("loads folders lazily and renders repository text as inert content", async () => {
    const listWorktree = vi.fn(async (_draftId: string, path?: string) => path === "docs"
      ? { path: "docs", entries: [{ name: "guide.txt", path: "docs/guide.txt", type: "file" as const, size: 6 }] }
      : { path: "", entries: [
        { name: ".agents", path: ".agents", type: "directory" as const },
        { name: "docs", path: "docs", type: "directory" as const },
        { name: "AGENTS.md", path: "AGENTS.md", type: "file" as const, size: 32 },
        { name: "README.md", path: "README.md", type: "file" as const, size: 28 },
        { name: "external", path: "external", type: "symlink" as const },
      ] });
    const readWorktreeFile = vi.fn(async (_draftId: string, path: string) => ({ path, size: 28, content: "<img src=x onerror=alert(1)>" }));
    const api = { listWorktree, readWorktreeFile } as unknown as GitPmApi;
    render(<WorktreeWorkspace api={api} draft={draft} locale="en" />);

    expect(await screen.findByText(".agents")).toBeTruthy();
    expect(screen.getByRole("button", { name: /AGENTS\.md/u })).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /README\.md/u }));
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(readWorktreeFile).toHaveBeenCalledWith("DRF-TREE", "README.md");

    fireEvent.click(screen.getByText("docs"));
    expect(await screen.findByRole("button", { name: /guide\.txt/u })).toBeTruthy();
    expect(listWorktree).toHaveBeenCalledWith("DRF-TREE", "docs");
    expect(screen.getByText("external").closest("button")).toBeNull();
  });

  it("shows preview errors without dropping the file selection", async () => {
    const api = {
      listWorktree: async () => ({ path: "", entries: [{ name: "binary.bin", path: "binary.bin", type: "file" as const, size: 4 }] }),
      readWorktreeFile: async () => { throw new Error("Binary files cannot be previewed as text"); },
    } as unknown as GitPmApi;
    render(<WorktreeWorkspace api={api} draft={draft} locale="en" />);
    fireEvent.click(await screen.findByRole("button", { name: /binary\.bin/u }));
    expect(await screen.findByText("Binary files cannot be previewed as text")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "binary.bin" })).toBeTruthy();
  });
});
