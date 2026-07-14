import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { credentialFreeHttpsRemote, directoryFingerprint, inferGitLabRemote, localServerLogLevel } from "./configure-gitpm-runtime.mjs";

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

  it("shows only errors by default while allowing an explicit diagnostic log level", () => {
    expect(localServerLogLevel({})).toBe("error");
    expect(localServerLogLevel({ LOG_LEVEL: "info" })).toBe("info");
    expect(localServerLogLevel({ LOG_LEVEL: "  " })).toBe("error");
  });

  it("changes the bundled demo fingerprint when its files change", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gitpm-demo-fingerprint-"));
    try {
      await mkdir(path.join(root, "projects"));
      await writeFile(path.join(root, "projects", "project.yaml"), "id: P-26-7K4M9Q\n", "utf8");
      const initial = await directoryFingerprint(root);

      await writeFile(path.join(root, "projects", "project.yaml"), "id: P-26-ABC123\n", "utf8");

      expect(await directoryFingerprint(root)).not.toBe(initial);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
