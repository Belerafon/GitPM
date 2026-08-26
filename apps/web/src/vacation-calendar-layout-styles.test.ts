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

describe("Vacation calendar overflow containment", () => {
  it("scrolls the timeline horizontally while keeping names sticky", () => {
    expect(rule(".vacation-calendar-scroll")).toContain("overflow-x: auto");
    expect(rule(".vacation-calendar-scroll")).toContain("overflow-y: hidden");
    expect(rule(".vacation-calendar-labels")).toContain("position: sticky");
    expect(rule(".vacation-calendar-timeline")).toContain("overflow: hidden");
  });

  it("stripes rows, paints weekend columns, and lets bar dates overflow", () => {
    expect(rule(".vacation-calendar-label.even, .vacation-calendar-row.even")).toContain("background: #eef1ec");
    expect(rule(".vacation-calendar-weekend")).toContain("background: rgba(88, 96, 90, .14)");
    expect(rule(".vacation-calendar-bar")).toContain("overflow: visible");
    expect(rule(".vacation-calendar-bar span")).toContain("overflow: visible");
  });
});
