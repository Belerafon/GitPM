import { describe, expect, it } from "vitest";

// The browser tsconfig intentionally excludes Node types; under vitest (Node) the built-ins resolve fine.
// @ts-expect-error node:fs is unavailable in the browser type context.
import { readFileSync } from "node:fs";
// @ts-expect-error node:path is unavailable in the browser type context.
import { dirname, resolve } from "node:path";
// @ts-expect-error node:url is unavailable in the browser type context.
import { fileURLToPath } from "node:url";

const styles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");
const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(styles)?.[1] ?? "";
};

describe("Gantt overflow containment", () => {
  it("allows horizontal scrolling without creating a vertical empty scroll range", () => {
    expect(rule(".gantt-scroll")).toContain("overflow-x: auto");
    expect(rule(".gantt-scroll")).toContain("overflow-y: hidden");
    expect(rule(".gantt-timeline")).toContain("overflow: hidden");
  });

  it("rotates only the milestone diamond and leaves its long label untransformed", () => {
    expect(rule(".gantt-milestone")).not.toContain("transform:");
    expect(rule(".gantt-milestone::before")).toContain("transform: rotate(45deg)");
    expect(rule(".gantt-milestone span")).not.toContain("transform:");
    expect(rule(".gantt-milestone span")).toContain("text-overflow: ellipsis");
    expect(rule(".gantt-milestone span")).not.toContain("top: -");
  });

  it("stacks track selectors so a native dropdown does not sit on sibling labels", () => {
    expect(rule(".gantt-track-fields")).toContain("display: flex");
    expect(rule(".gantt-track-fields > label")).toContain("display: grid");
    expect(rule(".gantt-additional-tracks")).toContain("border: 0");
  });
});
