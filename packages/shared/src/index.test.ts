import { describe, expect, it } from "vitest";
import { GITPM_VERSION } from "./index.js";

describe("shared package", () => {
  it("exposes the application version", () => {
    expect(GITPM_VERSION).toBe("0.1.0");
  });
});
