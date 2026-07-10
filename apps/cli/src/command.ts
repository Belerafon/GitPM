import { GITPM_VERSION } from "@gitpm/shared";

export function run(args: readonly string[]): { exitCode: number; output: string } {
  if (args.includes("--version") || args.includes("-v")) {
    return { exitCode: 0, output: GITPM_VERSION };
  }

  return {
    exitCode: 0,
    output: "gitpm foundation CLI; domain commands are introduced in P02",
  };
}
