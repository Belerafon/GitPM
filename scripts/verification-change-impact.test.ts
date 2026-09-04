import { describe, expect, it } from "vitest";
import { stepAffectedByPaths, verificationProfilesForPaths } from "./verification-change-impact.mjs";

describe("verification change impact", () => {
  it("selects web and browser coverage for a web source change", () => {
    expect(verificationProfilesForPaths(["apps/web/src/App.tsx"])).toEqual(["web", "e2e-ui"]);
  });

  it("widens shared contracts to every public consumer", () => {
    expect(verificationProfilesForPaths(["packages/contracts/src/http.ts"])).toEqual([
      "repository",
      "cli",
      "server",
      "web",
    ]);
  });

  it("uses the complete gate for root verification configuration", () => {
    expect(verificationProfilesForPaths(["vitest.config.ts"])).toEqual(["full"]);
    expect(verificationProfilesForPaths(["some-new-root-file.ts"])).toEqual(["full"]);
  });

  it("classifies the previously omitted browser specifications", () => {
    expect(verificationProfilesForPaths(["e2e/project-files-changes.spec.ts"])).toEqual(["e2e-ui"]);
    expect(verificationProfilesForPaths(["e2e/startup-race.spec.mjs"])).toEqual(["e2e-workflow"]);
  });

  it("does not invalidate built artifacts or Vitest for an e2e-only repair", () => {
    const paths = ["e2e/audit-lifecycles.spec.ts"];
    expect(stepAffectedByPaths("build", paths)).toBe(false);
    expect(stepAffectedByPaths("tests", paths)).toBe(false);
    expect(stepAffectedByPaths("typecheck", paths)).toBe(true);
    expect(stepAffectedByPaths("e2e", paths)).toBe(true);
  });
});
