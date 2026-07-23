import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION_UNAVAILABLE, captureVersionFromGit, formatBuildVersion, readBuildVersion } from "./git-version.mjs";

describe("formatBuildVersion", () => {
  it("formats the commit author date as YYYY.MM.DD HHMM in UTC", () => {
    expect(formatBuildVersion("2026-07-23T13:45:19+03:00")).toBe("2026.07.23 1045");
  });

  it("returns the unavailable marker for an invalid date", () => {
    expect(formatBuildVersion("not-a-date")).toBe(VERSION_UNAVAILABLE);
    expect(formatBuildVersion("")).toBe(VERSION_UNAVAILABLE);
  });
});

describe("captureVersionFromGit", () => {
  it("reads the current commit from the repository", () => {
    const info = captureVersionFromGit(process.cwd());
    expect(info).not.toBeNull();
    expect(info.version).toMatch(/^\d{4}\.\d{2}\.\d{2} \d{4}$/u);
    expect(typeof info.commit).toBe("string");
    expect(typeof info.commitDate).toBe("string");
  });
});

describe("readBuildVersion", () => {
  it("reads the captured build-version.json", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gitpm-read-"));
    try {
      writeFileSync(
        path.join(dir, "build-version.json"),
        JSON.stringify({ version: "2026.03.04 0506", commit: "deadbeef", commitDate: "2026-03-04T05:06:00Z" }),
      );
      expect(readBuildVersion(dir)).toEqual({ version: "2026.03.04 0506", commit: "deadbeef", commitDate: "2026-03-04T05:06:00Z" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no version was captured", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gitpm-read-"));
    try {
      expect(readBuildVersion(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
