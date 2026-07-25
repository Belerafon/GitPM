// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import { ExportMenu } from "./export-ui.js";

afterEach(cleanup);

describe("ExportMenu", () => {
  it("defaults PDF to Projects and People and sends optional project sections", async () => {
    const exportData = vi.fn(async () => ({ blob: new Blob(["pdf"]), filename: "gitpm-20260725-deadbeef-portfolio.pdf" }));
    const save = vi.fn();
    render(<ExportMenu api={{ exportData } as unknown as GitPmApi} draftId="DRF-1" locale="en" save={save} />);

    fireEvent.click(screen.getByText("Export"));
    expect((screen.getByLabelText("Projects overview") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("People overview") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("Detailed page for every project"));
    fireEvent.click(screen.getByRole("button", { name: "Download export" }));

    await waitFor(() => expect(exportData).toHaveBeenCalledWith("DRF-1", {
      format: "pdf",
      locale: "en",
      sections: ["projects", "people", "project-details"],
    }));
    expect(save).toHaveBeenCalledWith(expect.any(Blob), "gitpm-20260725-deadbeef-portfolio.pdf");
  });

  it("offers repository ZIP with or without portable Git history", async () => {
    const exportData = vi.fn(async () => ({ blob: new Blob(["zip"]), filename: "gitpm-20260725-deadbeef-repository-with-git.zip" }));
    render(<ExportMenu api={{ exportData } as unknown as GitPmApi} draftId="DRF-1" locale="en" save={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "repository" } });
    fireEvent.click(screen.getByLabelText("Include portable .git history (remote URL is removed)"));
    fireEvent.click(screen.getByRole("button", { name: "Download export" }));

    await waitFor(() => expect(exportData).toHaveBeenCalledWith("DRF-1", {
      format: "repository",
      locale: "en",
      includeGit: true,
    }));
  });
});
