import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftManager } from "@gitpm/drafts";
import { buildApp } from "./app.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => await Promise.all(apps.splice(0).map(async (app) => await app.close())));

function manager(): DraftManager {
  return {
    repositoryMode: "worktree",
    getDraft: async () => ({
      draft_id: "DRF-1",
      owner_gitlab_user_id: "42",
      branch: "gitpm/42/DRF-1",
      base_commit: "a".repeat(40),
      writer_mode: "ui",
      state: "open",
      fingerprint: "b".repeat(64),
      created_at: "2026-07-25T00:00:00.000Z",
      updated_at: "2026-07-25T00:00:00.000Z",
    }),
  } as unknown as DraftManager;
}

describe("export API", () => {
  it("authenticates the read and returns a binary attachment", async () => {
    const create = vi.fn(async () => ({
      content: Buffer.from("%PDF"),
      content_type: "application/pdf",
      filename: "gitpm-20260725-deadbeef-portfolio.pdf",
    }));
    const app = buildApp({
      authenticate: () => ({ userId: "42", role: "Reporter" }),
      draftManager: manager(),
      exportService: { create },
    });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/drafts/DRF-1/export?format=pdf&locale=ru&sections=projects,people,gantt" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="gitpm-20260725-deadbeef-portfolio.pdf"');
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.rawPayload.toString()).toBe("%PDF");
    expect(create).toHaveBeenCalledWith("DRF-1", {
      format: "pdf",
      locale: "ru",
      sections: ["projects", "people", "gantt"],
    });
  });

  it("rejects invalid format and include_git values with stable codes", async () => {
    const app = buildApp({
      authenticate: () => ({ userId: "42", role: "Maintainer" }),
      draftManager: manager(),
      exportService: { create: vi.fn() },
    });
    apps.push(app);

    const format = await app.inject({ method: "GET", url: "/api/drafts/DRF-1/export?format=docx" });
    const includeGit = await app.inject({ method: "GET", url: "/api/drafts/DRF-1/export?format=repository&include_git=1" });

    expect(format.statusCode).toBe(400);
    expect(format.json()).toMatchObject({ error: { code: "EXPORT_FORMAT_INVALID" } });
    expect(includeGit.statusCode).toBe(400);
    expect(includeGit.json()).toMatchObject({ error: { code: "EXPORT_INCLUDE_GIT_INVALID" } });
  });
});
