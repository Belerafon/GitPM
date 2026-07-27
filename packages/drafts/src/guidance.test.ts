import { describe, expect, it } from "vitest";
import { GITPM_DIRECT_SKILL_FILE_CONTENT, gitPmDirectAgentFile } from "./direct-guidance.js";
import { GITPM_SKILL_FILE_CONTENT, gitPmAgentFile } from "./worktree-guidance.js";

const normalizeWhitespace = (value: string) => value.replace(/\s+/gu, " ").trim();

describe("generated agent guidance", () => {
  it("keeps direct-mode instructions aligned with the installed CLI workflow", () => {
    const agentFile = normalizeWhitespace(gitPmDirectAgentFile({
      checkoutPath: "C:/portfolio",
      branch: "main",
      remoteUrl: "ssh://git@example.test/portfolio.git",
    }));
    const skillFile = normalizeWhitespace(GITPM_DIRECT_SKILL_FILE_CONTENT);

    expect(agentFile).toContain("use Python with `openpyxl` to read, create, or modify Excel workbooks");
    expect(agentFile).toContain("Stop after reporting the verified semantic diff unless the user explicitly requested a commit.");
    expect(agentFile).toContain("gitpm commit --all");
    expect(skillFile).toContain("Direct-mode commands do not take `--draft`");
    expect(skillFile).toContain("gitpm validate --changed");
    expect(skillFile).toContain("gitpm diff --semantic");
  });

  it("keeps worktree instructions aligned with the installed CLI workflow", () => {
    const agentFile = normalizeWhitespace(gitPmAgentFile("DRF-GUIDANCE"));
    const skillFile = normalizeWhitespace(GITPM_SKILL_FILE_CONTENT);

    expect(agentFile).toContain("GitPM draft `DRF-GUIDANCE`");
    expect(agentFile).toContain("use Python with `openpyxl` to read, create, or modify Excel workbooks");
    expect(agentFile).toContain("gitpm commit --all");
    expect(skillFile).toContain("gitpm validate --changed --draft <draft-id>");
    expect(skillFile).toContain("gitpm diff --semantic --draft <draft-id>");
    expect(skillFile).toContain("gitpm mr create --draft <id>");
  });
});
