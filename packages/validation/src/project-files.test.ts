import { describe, expect, it } from "vitest";
import {
  MAX_PROJECT_FILE_NAME_UTF16_LENGTH,
  projectFileNameComparisonKey,
  projectFileNameInvalidReason,
} from "./project-files.js";

describe("Project file names", () => {
  it.each([
    "ТЗ v3.docx",
    "contract.final.PDF",
    ".env.example",
    "данные без расширения",
    "COM10.txt",
  ])("accepts the Windows-compatible name %s", (name) => {
    expect(projectFileNameInvalidReason(name)).toBeUndefined();
  });

  it.each([
    ["", "empty"],
    [".", "path_segment"],
    ["..", "path_segment"],
    ["../escape.pdf", "invalid_character"],
    ["folder\\escape.pdf", "invalid_character"],
    ["bad:name.pdf", "invalid_character"],
    ["trailing-space.pdf ", "trailing_character"],
    ["trailing-dot.", "trailing_character"],
    ["CON", "reserved_name"],
    ["nul.txt", "reserved_name"],
    ["COM1.log", "reserved_name"],
    ["LPT¹.txt", "reserved_name"],
    ["x".repeat(MAX_PROJECT_FILE_NAME_UTF16_LENGTH + 1), "too_long"],
  ] as const)("rejects %s as %s", (name, reason) => {
    expect(projectFileNameInvalidReason(name)).toBe(reason);
  });

  it("compares names without case", () => {
    expect(projectFileNameComparisonKey("ТЗ_v3.DOCX")).toBe(projectFileNameComparisonKey("тз_V3.docx"));
  });
});
