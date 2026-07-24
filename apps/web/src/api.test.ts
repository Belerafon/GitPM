import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, formatApiError, HttpGitPmApi } from "./api.js";
import { ApiContractError } from "@gitpm/contracts";
import type { EntityResult } from "./types.js";

describe("HttpGitPmApi request bodies", () => {
  afterEach(() => vi.unstubAllGlobals());

  const draftStatus = {
    draft_id: "DRF-1",
    owner_gitlab_user_id: "42",
    branch: "gitpm/42/DRF-1",
    base_commit: "a".repeat(40),
    writer_mode: "ui",
    state: "open",
    fingerprint: "b".repeat(64),
    created_at: "2026-07-23T00:00:00.000Z",
    updated_at: "2026-07-23T00:00:00.000Z",
  };

  it("does not declare JSON for a request without a body", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(draftStatus), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await new HttpGitPmApi().closeDraft("DRF-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/drafts/DRF-1/close", expect.objectContaining({ method: "POST" }));
    const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers);
    expect(headers.has("content-type")).toBe(false);
  });

  it("declares JSON when a request has a JSON body", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(draftStatus), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await new HttpGitPmApi().createDraft("DRF-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/drafts", expect.objectContaining({ method: "POST" }));
    const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("preserves structured error details and sends explicit unlink confirmation", async () => {
    const details = [{ path: "teams/G-26-CORE.yaml", label: "Core" }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "DELETE_RESTRICTED", message: "referenced", details } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const entity = { document: { schema: "gitpm/person@1", id: "U-26-5EBAE3" }, path: "people/U-26-5EBAE3.yaml", blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) } as EntityResult;
    const api = new HttpGitPmApi();

    await expect(api.deleteEntity("DRF-1", "people", entity, entity.draft_fingerprint)).rejects.toEqual(expect.objectContaining({
      code: "DELETE_RESTRICTED",
      details,
    }));
    await api.deleteEntity("DRF-1", "people", entity, entity.draft_fingerprint, true);

    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toMatchObject({ unlink_references: true });
  });

  it("formats API validation errors with their stable code, path, field and expectation", () => {
    const message = formatApiError(new ApiError("VALIDATION_FAILED", "Repository validation failed", [
      {
        code: "REPOSITORY_TOP_LEVEL",
        path: "legacy-exports",
        message: 'Unknown top-level directory "legacy-exports"',
      },
      {
        code: "SCHEMA_INVALID",
        path: "projects/P-26-111111/project.yaml",
        field: "group",
        message: "must match pattern",
        expected: "a non-empty group name",
      },
    ]));

    expect(message).toBe([
      "[VALIDATION_FAILED] Repository validation failed",
      '- [REPOSITORY_TOP_LEVEL] legacy-exports — Unknown top-level directory "legacy-exports"',
      "- [SCHEMA_INVALID] projects/P-26-111111/project.yaml · field group — must match pattern; expected a non-empty group name",
    ].join("\n"));
  });

  it("accepts configuration documents without entity identity fields", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      document: {
        schema: "gitpm/statuses@1",
        statuses: [{ slug: "backlog", title: "Backlog", color: "gray", active: true }],
      },
      path: ".gitpm/statuses.yaml",
      blob_id: "a".repeat(40),
      draft_fingerprint: "b".repeat(64),
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const result = await new HttpGitPmApi().getConfiguration("DRF-1", "statuses");

    expect(result.document).toEqual({
      schema: "gitpm/statuses@1",
      statuses: [{ slug: "backlog", title: "Backlog", color: "gray", active: true }],
    });
  });

  it("rejects entity responses that violate the shared runtime contract", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      document: { schema: "gitpm/statuses@1", statuses: [] },
      path: ".gitpm/statuses.yaml",
      blob_id: "a".repeat(40),
      draft_fingerprint: "b".repeat(64),
    }]), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(new HttpGitPmApi().listEntities("DRF-1", "people")).rejects.toBeInstanceOf(ApiContractError);
  });
});
