import { describe, expect, it } from "vitest";
import { formatDuration, parseArguments, verificationPlan } from "./run-local-verification.mjs";

describe("local verification runner", () => {
  it("builds the complete local plan with a frozen install", () => {
    const options = parseArguments(["--install"]);
    expect(options).toEqual({ profile: "full", install: true });
    expect(verificationPlan(options).map((step) => step.name)).toEqual([
      "frozen install",
      "clean",
      "build",
      "lint",
      "typecheck",
      "tests",
      "e2e",
      "smoke",
      "schemas",
      "security report",
      "planning",
    ]);
  });

  it("keeps guidance verification focused and independently installable", () => {
    const options = parseArguments(["--profile", "guidance", "--install"]);
    const plan = verificationPlan(options);
    expect(plan.map((step) => step.name)).toEqual([
      "frozen install",
      "build guidance dependencies",
      "lint guidance",
      "guidance tests",
      "diff whitespace",
    ]);
    expect(plan.find((step) => step.name === "guidance tests")?.args)
      .toContain("packages/drafts/src/guidance.test.ts");
  });

  it("rejects unknown profiles and renders useful elapsed time", () => {
    expect(() => parseArguments(["--profile", "mystery"])).toThrow("Unknown verification profile");
    expect(formatDuration(125_400)).toBe("2m 05s");
  });
});
