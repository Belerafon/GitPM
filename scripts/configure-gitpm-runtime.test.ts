import { describe, expect, it } from "vitest";
import { credentialFreeHttpsRemote, inferGitLabRemote } from "./configure-gitpm-runtime.mjs";

describe("launcher repository configuration", () => {
  it("infers GitLab instance and project from a credential-free HTTPS origin", () => {
    expect(inferGitLabRemote("https://gitlab.example.test/group/subgroup/project.git")).toEqual({
      baseUrl: "https://gitlab.example.test",
      project: "group/subgroup/project",
    });
  });

  it("does not mistake SSH and non-GitLab remotes for OAuth-ready GitLab remotes", () => {
    expect(inferGitLabRemote("git@gitlab.com:group/project.git")).toBeUndefined();
    expect(inferGitLabRemote("https://example.test/group/project.git")).toBeUndefined();
    expect(credentialFreeHttpsRemote("https://token@gitlab.com/group/project.git")).toBeUndefined();
  });
});
