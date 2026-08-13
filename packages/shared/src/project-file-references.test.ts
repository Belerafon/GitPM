import { describe, expect, it } from "vitest";
import {
  formatProjectFileReference,
  resolveProjectFileReference,
  tokenizeProjectFileReferences,
} from "./project-file-references.js";

describe("Project file reference syntax", () => {
  it("tokenizes exact Unicode references and preserves repeated source offsets", () => {
    const source = "См. [[file:ТЗ_v3.docx]] и [[file:ТЗ_v3.docx]].";
    const tokens = tokenizeProjectFileReferences(source);
    expect(tokens).toEqual([
      { kind: "text", value: "См. ", start: 0, end: 4 },
      { kind: "file_reference", name: "ТЗ_v3.docx", raw: "[[file:ТЗ_v3.docx]]", start: 4, end: 23 },
      { kind: "text", value: " и ", start: 23, end: 26 },
      { kind: "file_reference", name: "ТЗ_v3.docx", raw: "[[file:ТЗ_v3.docx]]", start: 26, end: 45 },
      { kind: "text", value: ".", start: 45, end: 46 },
    ]);
  });

  it("reports UTF-16 offsets without normalizing Unicode file names", () => {
    const source = "😀 [[file:Схема 🧭.png]]";
    const token = tokenizeProjectFileReferences(source).find((item) => item.kind === "file_reference");
    expect(token).toEqual({
      kind: "file_reference",
      name: "Схема 🧭.png",
      raw: "[[file:Схема 🧭.png]]",
      start: 3,
      end: source.length,
    });
  });

  it("round-trips spaces and brackets through canonical escaping", () => {
    const name = "ТЗ [пункт 5] final.docx";
    const formatted = formatProjectFileReference(name);
    expect(formatted).toBe("[[file:ТЗ \\[пункт 5\\] final.docx]]");
    expect(tokenizeProjectFileReferences(formatted)).toEqual([
      { kind: "file_reference", name, raw: formatted, start: 0, end: formatted.length },
    ]);
  });

  it("lexically round-trips literal backslashes and brackets without granting storage validity", () => {
    const name = "literal \\ [draft].txt";
    const formatted = formatProjectFileReference(name);
    expect(formatted).toBe("[[file:literal \\\\ \\[draft\\].txt]]");
    expect(tokenizeProjectFileReferences(formatted)).toEqual([
      { kind: "file_reference", name, raw: formatted, start: 0, end: formatted.length },
    ]);
    expect(resolveProjectFileReference(name, ["literal [draft].txt"])).toBe("missing");
  });

  it("keeps escaped, empty, malformed, nested and unknown-escape syntax as unchanged text", () => {
    const samples = [
      "\\[[file:escaped.pdf]]",
      "[[file:]]",
      "before [[file:unclosed.pdf",
      "[[file:outer [[file:inner.pdf]]]]",
      "[[file:bad\\q.pdf]]",
      "[[file:bad]name.pdf]]",
      "[[file:bad\nname.pdf]]",
    ];
    for (const source of samples) {
      expect(tokenizeProjectFileReferences(source)).toEqual([{ kind: "text", value: source, start: 0, end: source.length }]);
    }
  });

  it("recovers after a closed malformed candidate and tokenizes the next valid reference", () => {
    const source = "[[file:bad\\q.pdf]] then [[file:good.pdf]]";
    expect(tokenizeProjectFileReferences(source)).toEqual([
      { kind: "text", value: "[[file:bad\\q.pdf]] then ", start: 0, end: 24 },
      { kind: "file_reference", name: "good.pdf", raw: "[[file:good.pdf]]", start: 24, end: source.length },
    ]);
  });

  it("does not interpret hostile HTML and Markdown as executable structure", () => {
    const source = "[[file:<img src=x onerror=alert(1)>.png]]";
    expect(tokenizeProjectFileReferences(source)).toEqual([
      { kind: "file_reference", name: "<img src=x onerror=alert(1)>.png", raw: source, start: 0, end: source.length },
    ]);
  });

  it("distinguishes existing and broken references with exact case-sensitive names", () => {
    const names = ["ТЗ_v3.docx", "Plan.xlsx"];
    expect(resolveProjectFileReference("ТЗ_v3.docx", names)).toBe("existing");
    expect(resolveProjectFileReference("тз_v3.docx", names)).toBe("missing");
    expect(resolveProjectFileReference("Plan.xls", names)).toBe("missing");
    expect(resolveProjectFileReference("../Plan.xlsx", names)).toBe("missing");
    expect(tokenizeProjectFileReferences("[[file:../Plan.xlsx]]")[0]).toMatchObject({
      kind: "file_reference",
      name: "../Plan.xlsx",
    });
    const escapedBackslash = "[[file:folder\\\\Plan.xlsx]]";
    expect(tokenizeProjectFileReferences(escapedBackslash)[0]).toMatchObject({
      kind: "file_reference",
      name: "folder\\Plan.xlsx",
    });
    expect(resolveProjectFileReference("folder\\Plan.xlsx", names)).toBe("missing");
  });

  it("rejects names that cannot have a canonical single-line spelling", () => {
    expect(() => formatProjectFileReference("")).toThrow(TypeError);
    expect(() => formatProjectFileReference("bad\u0000name")).toThrow(TypeError);
  });
});
