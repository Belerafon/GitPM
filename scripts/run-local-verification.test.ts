import { describe, expect, it } from "vitest";
import { formatDuration, parseArguments, verificationPlan } from "./run-local-verification.mjs";

describe("local verification runner", () => {
  it("builds the complete local plan with a frozen install", () => {
    const options = parseArguments(["--install"]);
    expect(options).toEqual({
      profile: "full",
      install: true,
      resume: false,
      lowImpact: false,
      reportPath: undefined,
    });
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

  it.each([
    ["web", "test:web"],
    ["server", "test:server"],
    ["cli", "test:cli"],
    ["repository", "test:repository"],
    ["planning-domain", "test:planning-domain"],
    ["workflow", "test:workflow"],
    ["export", "test:export"],
  ])("maps the %s impact profile to its thematic tests", (profile, testScript) => {
    const plan = verificationPlan(parseArguments(["--profile", profile]));
    expect(plan.find((step) => step.name === "thematic tests")?.args).toContain(testScript);
    expect(plan.at(-1)?.name).toBe("diff whitespace");
  });

  it.each([
    ["tooling", "test:tooling"],
    ["e2e-ui", "e2e:ui"],
    ["e2e-workflow", "e2e:workflow"],
  ])("provides the %s specialized profile", (profile, testScript) => {
    const plan = verificationPlan(parseArguments(["--profile", profile]));
    expect(plan.some((step) => step.args.includes(testScript))).toBe(true);
    expect(plan.at(-1)?.name).toBe("diff whitespace");
  });

  it("rejects unknown profiles and renders useful elapsed time", () => {
    expect(() => parseArguments(["--profile", "mystery"])).toThrow("Unknown verification profile");
    expect(formatDuration(125_400)).toBe("2m 05s");
  });

  it("parses resumable low-impact verification with an explicit report", () => {
    expect(parseArguments(["--resume", "--low-impact", "--report", ".tmp/result.json"])).toEqual({
      profile: "full",
      install: false,
      resume: true,
      lowImpact: true,
      reportPath: ".tmp/result.json",
    });
  });
});
