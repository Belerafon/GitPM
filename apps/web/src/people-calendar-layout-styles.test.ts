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

describe("People schedule calendar density", () => {
  it("keeps day cells compact and marks today", () => {
    expect(rule(".people-calendar-grid")).toContain("minmax(92px, 1fr)");
    expect(rule(".people-calendar-grid")).toContain("min-width: 644px");
    expect(rule(".people-calendar-day")).toContain("height: 52px");
    expect(rule(".people-calendar-day.today")).not.toContain("outline");
    expect(rule(".people-calendar-day.today time")).toContain("background: #d94d43");
    expect(rule(".people-calendar-day.free")).toContain("#c8e6cf");
    expect(rule(".people-calendar-day.occupied")).toContain("#d4e4f6");
    expect(rule(".people-calendar-day.unavailable")).toContain("#f6c56b");
    expect(rule(".people-calendar-day.off")).toContain("#e3e5e2");
    expect(rule(".people-calendar-hint")).toContain("pointer-events: none");
    expect(rule(".people-calendar-hint")).toContain("position: fixed");
  });
});
