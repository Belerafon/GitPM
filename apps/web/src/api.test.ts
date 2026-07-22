import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpGitPmApi } from "./api.js";
import type { EntityResult } from "./types.js";

describe("HttpGitPmApi request bodies", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not declare JSON for a request without a body", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ draft_id: "DRF-1" }), {
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
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ draft_id: "DRF-1" }), {
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
});
