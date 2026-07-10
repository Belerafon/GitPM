import { describe, expect, it } from "vitest";
import { run } from "./command.js";

describe("CLI foundation", () => {
  it("prints a stable version", () => {
    expect(run(["--version"])).toEqual({ exitCode: 0, output: "0.1.0" });
  });
});
