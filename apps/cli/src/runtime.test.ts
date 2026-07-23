import { describe, expect, it } from "vitest";
import { mergeRequestProtocolFromEnvironment } from "./runtime.js";

describe("CLI runtime wiring", () => {
  it("builds the production Merge Request protocol from GitLab environment", async () => {
    const requests: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetchImplementation: typeof globalThis.fetch = async (input, init) => {
      requests.push({ input, ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify({
        iid: 7,
        state: "opened",
        source_branch: "gitpm/42/DRF-CLI",
        target_branch: "main",
        web_url: "https://gitlab.example/group/project/-/merge_requests/7",
      }), { status: 201, headers: { "content-type": "application/json" } });
    };
    const protocol = mergeRequestProtocolFromEnvironment({
      GITPM_GITLAB_URL: "https://gitlab.example",
      GITPM_GITLAB_PROJECT: "group/project",
    }, fetchImplementation);

    await expect(protocol?.createMergeRequest("memory-only-token", {
      source_branch: "gitpm/42/DRF-CLI",
      target_branch: "main",
      title: "CLI integration",
    })).resolves.toMatchObject({ iid: 7, state: "opened" });
    expect(requests).toEqual([expect.objectContaining({
      input: "https://gitlab.example/api/v4/projects/group%2Fproject/merge_requests",
      init: expect.objectContaining({ method: "POST", headers: expect.any(Headers) }),
    })]);
    const request = requests[0]!.init!;
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer memory-only-token");
  });

  it("leaves Merge Requests unavailable when endpoint configuration is incomplete", () => {
    expect(mergeRequestProtocolFromEnvironment({ GITPM_GITLAB_URL: "https://gitlab.example" })).toBeUndefined();
    expect(mergeRequestProtocolFromEnvironment({ GITPM_GITLAB_PROJECT: "group/project" })).toBeUndefined();
  });
});
