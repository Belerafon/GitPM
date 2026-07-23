import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateBuildVersion } from "./generate-build-version.mjs";
import { readBuildVersion } from "./git-version.mjs";

describe("generateBuildVersion", () => {
  it("captures the version from Git into build-version.json", () => {
    const info = generateBuildVersion(process.cwd());
    expect(info).not.toBeNull();
    expect(readBuildVersion(process.cwd())?.version).toBe(info.version);
  });

  it("writes nothing when Git is unavailable, leaving no file behind", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gitpm-gen-"));
    try {
      const info = generateBuildVersion(dir);
      expect(info).toBeNull();
      expect(existsSync(path.join(dir, "build-version.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
