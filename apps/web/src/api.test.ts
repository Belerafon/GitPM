import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpGitPmApi } from "./api.js";

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
});
