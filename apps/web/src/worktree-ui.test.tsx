// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import type { DraftStatus, WorktreeDirectory, WorktreeEntry, WorktreeFile } from "./types.js";
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

const file = (path: string, size = 4): WorktreeEntry => ({ name: path.split("/").at(-1)!, path, type: "file", size });
const dir = (path: string): WorktreeEntry => ({ name: path.split("/").at(-1)!, path, type: "directory" });

function apiFor(entries: readonly WorktreeEntry[], overrides: Partial<GitPmApi> = {}): GitPmApi {
  const listing: WorktreeDirectory = { path: "", entries };
  return {
    listWorktree: vi.fn(async (_draftId: string, _path?: string) => listing),
    readWorktreeFile: vi.fn(async (_draftId: string, path: string): Promise<WorktreeFile> => ({ path, size: 28, content: "<img src=x onerror=alert(1)>" })),
    deleteWorktreeEntry: vi.fn(async () => "c".repeat(64)),
    createWorktreeDirectory: vi.fn(async () => "c".repeat(64)),
    uploadWorktreeFile: vi.fn(async () => "c".repeat(64)),
    moveWorktreeEntry: vi.fn(async () => "c".repeat(64)),
    ...overrides,
  } as unknown as GitPmApi;
}

const noChanged = vi.fn(async () => undefined);

afterEach(cleanup);

describe("working tree file manager", () => {
  it("lists the root folder, navigates into folders, and renders repository text as inert content", async () => {
    const root = [dir("docs"), file("AGENTS.md", 32), file("README.md", 28)];
    const nested = [file("docs/guide.txt", 5)];
    const api = apiFor(root, {
      listWorktree: vi.fn(async (_draftId: string, path?: string) => (path === "docs" ? { path: "docs", entries: nested } : { path: "", entries: root })),
    });
    render(<WorktreeWorkspace api={api} draft={draft} role="Developer" locale="en" onChanged={noChanged} />);

    expect(await screen.findByRole("button", { name: /docs/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: /README\.md/u })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /README\.md/u }));
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /docs/u }));
    expect(await screen.findByRole("button", { name: /guide\.txt/u })).toBeTruthy();
    expect(screen.getByText("docs")).toBeTruthy();
  });

  it("ignores a late directory response after navigating elsewhere", async () => {
    const root = [dir("docs"), dir("uploads")];
    let resolveDocs!: (value: WorktreeDirectory) => void;
    const docsResponse = new Promise<WorktreeDirectory>((resolve) => { resolveDocs = resolve; });
    const api = apiFor(root, {
      listWorktree: vi.fn(async (_draftId: string, path?: string) => {
        if (path === "docs") return await docsResponse;
        return { path: "", entries: root };
      }),
    });
    render(<WorktreeWorkspace api={api} draft={draft} role="Developer" locale="en" onChanged={noChanged} />);

    fireEvent.click(await screen.findByRole("button", { name: /docs/u }));
    await vi.waitFor(() => expect(api.listWorktree).toHaveBeenCalledWith("DRF-TREE", "docs"));
    fireEvent.click(screen.getByRole("button", { name: "Root" }));
    expect(await screen.findByRole("button", { name: /uploads/u })).toBeTruthy();

    await act(async () => {
      resolveDocs({ path: "docs", entries: [file("docs/late.txt", 4)] });
      await docsResponse;
    });

    expect(screen.queryByRole("button", { name: /late\.txt/u })).toBeNull();
    expect(screen.getByRole("button", { name: /uploads/u })).toBeTruthy();
  });

  it("creates a folder through the name dialog", async () => {
    const api = apiFor([]);
    render(<WorktreeWorkspace api={api} draft={draft} role="Developer" locale="en" onChanged={noChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: "New folder" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "uploads" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await vi.waitFor(() => expect(api.createWorktreeDirectory).toHaveBeenCalledWith("DRF-TREE", draft.fingerprint, "uploads"));
    expect(api.createWorktreeDirectory).toHaveBeenCalledTimes(1);
  });

  it("renames an entry via move", async () => {
    const api = apiFor([file("notes.txt", 3)]);
    render(<WorktreeWorkspace api={api} draft={draft} role="Developer" locale="en" onChanged={noChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: /Rename/u }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "readme.txt" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(api.moveWorktreeEntry).toHaveBeenCalledWith("DRF-TREE", draft.fingerprint, "notes.txt", "readme.txt"));
  });

  it("deletes an entry after confirmation", async () => {
    const api = apiFor([file("draft.md", 8)]);
    render(<WorktreeWorkspace api={api} draft={draft} role="Developer" locale="en" onChanged={noChanged} confirmAction={() => true} />);
    fireEvent.click(await screen.findByRole("button", { name: /Delete/u }));
    await vi.waitFor(() => expect(api.deleteWorktreeEntry).toHaveBeenCalledWith("DRF-TREE", draft.fingerprint, "draft.md"));
  });

  it("blocks deletion when confirmation is denied", async () => {
    const api = apiFor([file("draft.md", 8)]);
    render(<WorktreeWorkspace api={api} draft={draft} role="Developer" locale="en" onChanged={noChanged} confirmAction={() => false} />);
    fireEvent.click(await screen.findByRole("button", { name: /Delete/u }));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: /Delete/u })).toBeTruthy());
    expect(api.deleteWorktreeEntry).not.toHaveBeenCalled();
  });

  it("uploads selected files into the current folder, chaining fingerprints", async () => {
    const api = apiFor([]);
    render(<WorktreeWorkspace api={api} draft={draft} role="Developer" locale="en" onChanged={noChanged} />);
    const input = (await screen.findByRole("button", { name: "Upload" })).parentElement?.querySelector("input[type=file]") as HTMLInputElement;
    const fileA = new File(["aaa"], "a.txt");
    const fileB = new File(["bb"], "b.txt");
    fireEvent.change(input, { target: { files: [fileA, fileB] } });
    await vi.waitFor(() => expect(api.uploadWorktreeFile).toHaveBeenCalledTimes(2));
    expect(api.uploadWorktreeFile).toHaveBeenNthCalledWith(1, "DRF-TREE", draft.fingerprint, "a.txt", expect.any(String));
    expect(api.uploadWorktreeFile).toHaveBeenNthCalledWith(2, "DRF-TREE", "c".repeat(64), "b.txt", expect.any(String));
  });

  it("hides mutation controls for read-only roles", async () => {
    const api = apiFor([file("readme.md", 4)]);
    render(<WorktreeWorkspace api={api} draft={draft} role="Reporter" locale="en" onChanged={noChanged} />);
    expect(await screen.findByText(/read-only/iu)).toBeTruthy();
    expect((screen.getByRole("button", { name: "New folder" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Rename/u }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows preview errors without dropping the file selection", async () => {
    const api = apiFor([file("binary.bin", 4)], { readWorktreeFile: async () => { throw new Error("Binary files cannot be previewed as text"); } });
    render(<WorktreeWorkspace api={api} draft={draft} role="Developer" locale="en" onChanged={noChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: /binary\.bin/u }));
    expect(await screen.findByText("Binary files cannot be previewed as text")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "binary.bin" })).toBeTruthy();
  });
});
