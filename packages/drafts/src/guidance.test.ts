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
    expect(agentFile).toContain("gitpm entity create --type <type> --file <temporary-yaml> [--project <project-id>] [--allow-delete] --json");
    expect(agentFile).toContain("gitpm entity update --type <type> --id <entity-id> --set <field>=<yaml-value>");
    expect(agentFile).toContain("gitpm notification list");
    expect(agentFile).toContain("[--project <project-id>] [--allow-delete] --json");
    expect(agentFile).toContain("A request to create, update, archive, move, or delete GitPM data does not authorize a commit.");
    expect(agentFile).toContain("Stop after reporting the verified semantic diff unless the user explicitly requested a commit.");
    expect(agentFile).toContain("gitpm commit --all");
    expect(skillFile).toContain("Direct-mode commands do not take `--draft`");
    expect(skillFile).toContain("gitpm format [--project <project-id>] [--allow-delete] --json");
    expect(skillFile).toContain("gitpm validate --changed [--project <project-id>] [--allow-delete] --json");
    expect(skillFile).toContain("gitpm diff --semantic [--project <project-id>] [--allow-delete] --json");
    expect(skillFile).toContain("gitpm notification list [--person <id>]");
    expect(skillFile).toContain("gitpm changes list|restore-file|restore-hunk|discard-all");
    expect(skillFile).toContain("gitpm history list|show|file-diff|file-history");
    expect(skillFile).toContain("gitpm commit --all -m <message> [--project <project-id>] [--allow-delete] --json");
    expect(skillFile).toContain("Do not commit unless the user explicitly requests a commit.");
  });

  it("keeps worktree instructions aligned with the installed CLI workflow", () => {
    const agentFile = normalizeWhitespace(gitPmAgentFile("DRF-GUIDANCE"));
    const skillFile = normalizeWhitespace(GITPM_SKILL_FILE_CONTENT);

    expect(agentFile).toContain("GitPM draft `DRF-GUIDANCE`");
    expect(agentFile).toContain("use Python with `openpyxl` to read, create, or modify Excel workbooks");
    expect(agentFile).toContain("gitpm entity create --draft DRF-GUIDANCE --type <type> --file <temporary-yaml> [--project <project-id>] [--allow-delete] --json");
    expect(agentFile).toContain("gitpm comment list|create|update|delete --draft DRF-GUIDANCE");
    expect(agentFile).toContain("gitpm commit --all");
    expect(skillFile).toContain("gitpm format --draft <draft-id> [--project <project-id>] [--allow-delete] --json");
    expect(skillFile).toContain("gitpm validate --changed --draft <draft-id>");
    expect(skillFile).toContain("gitpm diff --semantic --draft <draft-id>");
    expect(skillFile).toContain("gitpm comment list|create|update|delete --draft <id>");
    expect(skillFile).toContain("gitpm config show|update --draft <id>");
    expect(skillFile).toContain("gitpm changes list|restore-file|restore-hunk|discard-all --draft <id>");
    expect(skillFile).toContain("The GUI file manager is intentionally not an agent command");
    expect(skillFile).toContain("gitpm mr create --draft <id>");
  });
});
