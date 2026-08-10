// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { GlobalSearch } from "./global-search.js";
import { message, type MessageKey } from "./i18n.js";

const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message("en", key, values);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("GlobalSearch", () => {
  it("opens from the keyboard, debounces the request, and navigates to an archived task", async () => {
    const searchEntities = vi.fn(async () => ({
      query: "approve",
      total: 1,
      items: [{ entity_type: "task" as const, id: "T-26-P9G3P8", title: "Approve schema v1", context: "GitPM launch", project_id: "P-26-MGP84K", lifecycle: "archived" as const }],
    }));
    const onNavigate = vi.fn();
    render(<GlobalSearch api={{ searchEntities } as unknown as GitPmApi} draftId="DRF-1" onNavigate={onNavigate} t={t} />);

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const input = screen.getByRole("combobox", { name: "Global search" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "approve" } });

    await waitFor(() => expect(searchEntities).toHaveBeenCalledWith("DRF-1", "approve", 20));
    const option = await screen.findByRole("option", { name: /Approve schema v1/u });
    expect(within(option).getByText("Archived")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onNavigate).toHaveBeenCalledWith("tasks", { projectId: "P-26-MGP84K", taskId: "T-26-P9G3P8", query: { archive: ["1"] } });
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("shows empty state and routes directory-only result types to their sections", async () => {
    const searchEntities = vi.fn()
      .mockResolvedValueOnce({ query: "none", total: 0, items: [] })
      .mockResolvedValueOnce({ query: "core", total: 1, items: [{ entity_type: "team", id: "G-26-XB86WT", title: "Core team", lifecycle: "active" }] });
    const onNavigate = vi.fn();
    render(<GlobalSearch api={{ searchEntities } as unknown as GitPmApi} draftId="DRF-1" onNavigate={onNavigate} t={t} />);
    const input = screen.getByRole("combobox", { name: "Global search" });

    fireEvent.change(input, { target: { value: "none" } });
    expect(await screen.findByText("No matching projects, tasks or people.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "core" } });
    fireEvent.click(await screen.findByRole("option", { name: /Core team/u }));

    expect(onNavigate).toHaveBeenCalledWith("people");
  });
});
