import { describe, expect, it } from "vitest";
import { formatBuildVersion, readBaseVersion } from "./git-version.mjs";

describe("formatBuildVersion", () => {
  it("encodes the commit author date as UTC build metadata plus the short hash", () => {
    expect(formatBuildVersion("0.1.0", "2026-07-23T13:45:19+03:00", "eb7f057")).toBe("0.1.0+20260723.1045.eb7f057");
  });

  it("omits the hash suffix when none is provided", () => {
    expect(formatBuildVersion("0.1.0", "2026-01-02T00:00:00Z", "")).toBe("0.1.0+20260102.0000");
  });

  it("trims whitespace around the commit hash", () => {
    expect(formatBuildVersion("0.1.0", "2026-01-02T00:00:00Z", "  abc123  ")).toBe("0.1.0+20260102.0000.abc123");
  });

  it("falls back to a dev tag when the commit date cannot be parsed", () => {
    expect(formatBuildVersion("0.1.0", "not-a-date", "eb7f057")).toBe("0.1.0+dev");
    expect(formatBuildVersion("0.1.0", "", "eb7f057")).toBe("0.1.0+dev");
  });
});

describe("readBaseVersion", () => {
  it("resolves the workspace version from the repository root", () => {
    expect(readBaseVersion(process.cwd())).toBe("0.1.0");
  });
});
