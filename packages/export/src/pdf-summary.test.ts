import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DraftManager } from "@gitpm/drafts";
import type { GitClient } from "@gitpm/git-client";

const pdfCapture = vi.hoisted(() => ({ definition: undefined as unknown }));

vi.mock("pdfmake/build/pdfmake.js", () => ({
  default: {
    vfs: {},
    createPdf: (definition: unknown) => {
      pdfCapture.definition = definition;
      return { getBuffer: (callback: (buffer: Buffer) => void) => callback(Buffer.from("%PDF-1.7\n", "ascii")) };
    },
  },
}));

vi.mock("pdfmake/build/vfs_fonts.js", () => ({ default: {} }));

import { ExportService } from "./index.js";

describe("PDF summary pages", () => {
  const manager = {
    getWorkspace: async () => ({ worktree_path: path.resolve("fixtures/schema-v1/demo") }),
  } as unknown as DraftManager;
  const git = {
    history: async () => [{
      commit: "deadbeef".padEnd(40, "0"),
      parents: [],
      author_name: "Ada",
      author_email: "ada@example.test",
      authored_at: "2026-07-25T12:00:00.000Z",
      subject: "demo",
    }],
  } as unknown as GitClient;
  const service = new ExportService(manager, git, () => new Date("2026-07-26T10:00:00.000Z"));

  it("matches the default web project and people registers", async () => {
    await service.create("DRF-1", { format: "pdf", locale: "en" });

    const definition = pdfCapture.definition as {
      readonly pageOrientation: string;
      readonly content: readonly unknown[];
    };
    const rendered = JSON.stringify(definition);

    expect(definition.pageOrientation).toBe("landscape");
    expect(rendered).toContain('"text":"Active projects"');
    expect(rendered).toContain('"text":"Completed tasks"');
    expect(rendered).toContain('"text":"Project owner"');
    expect(rendered).toContain('"text":"Milestones"');
    expect(rendered).toContain('"text":"Due date"');
    expect(rendered).toContain('"text":"Risk"');
    expect(rendered).toContain('"In progress"');
    expect(rendered).toContain('"On track"');
    expect(rendered).toContain('"text":"Weekly capacity (hours)"');
    expect(rendered).toContain("GitPM launch");
    expect(rendered).toContain("Core team");
    expect(rendered).toContain("40 h/week");
    expect(rendered).toContain("Standard work week");
    expect(rendered).not.toContain("anna@example.test");
  });

  it("localizes the new register columns and derived values", async () => {
    await service.create("DRF-1", { format: "pdf", locale: "ru" });

    const rendered = JSON.stringify(pdfCapture.definition);
    expect(rendered).toContain('"text":"Ответственный за проект"');
    expect(rendered).toContain('"text":"Недельная ёмкость (часы)"');
    expect(rendered).toContain('"text":"Срок"');
    expect(rendered).toContain('"text":"Риск"');
    expect(rendered).toContain('"По плану"');
    expect(rendered).toContain("40 ч/нед.");
  });
});
