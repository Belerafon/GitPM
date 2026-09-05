import { describe, expect, it } from "vitest";
import { run } from "./command.js";
import { CLI_COMMAND_NAMES, COMMAND_SPECIFICATIONS, ROOT_USAGE } from "./command-specification.js";

describe("CLI command specification registry", () => {
  it("keeps root usage, command help and argument validation aligned", async () => {
    expect(Object.keys(COMMAND_SPECIFICATIONS)).toEqual(CLI_COMMAND_NAMES);

    for (const command of CLI_COMMAND_NAMES) {
      expect(ROOT_USAGE).toContain(command);
      expect(COMMAND_SPECIFICATIONS[command].help).toContain(`gitpm ${command}`);

      const help = await run([command, "--help", "--json"]);
      expect(help.exitCode).toBe(0);
      expect(JSON.parse(help.output)).toMatchObject({
        ok: true,
        code: "OK",
        command,
        help: COMMAND_SPECIFICATIONS[command].help,
      });

      const unknownOption = await run([command, "--not-a-gitpm-option", "--json"]);
      expect(unknownOption.exitCode).toBe(1);
      expect(JSON.parse(unknownOption.output)).toMatchObject({
        ok: false,
        code: "CLI_USAGE",
        message: `Unknown option for ${command}: --not-a-gitpm-option`,
      });
    }
  });
});
