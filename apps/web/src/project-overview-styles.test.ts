import { describe, expect, it } from "vitest";

// The browser tsconfig intentionally excludes Node types; under vitest (Node) the built-ins resolve fine.
// @ts-expect-error node:fs is unavailable in the browser type context.
import { readFileSync } from "node:fs";
// @ts-expect-error node:path is unavailable in the browser type context.
import { dirname, resolve } from "node:path";
// @ts-expect-error node:url is unavailable in the browser type context.
import { fileURLToPath } from "node:url";

const stylesPath = resolve(dirname(fileURLToPath(import.meta.url)), "styles.css");
const styles = readFileSync(stylesPath, "utf8");

const hasRule = (className: string): boolean => new RegExp(`\\.${className.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`, "u").test(styles);

describe("project overview styles", () => {
  it("defines a rule for every class the new overview components render", () => {
    const required = [
      "actual-report-task-link",
      "plan-source",
      "plan-source-label",
      "correction-history-count",
      "plan-cell-source",
      "project-plan-summary-blocked",
    ];
    for (const className of required) expect(hasRule(className), `${className} should have a CSS rule`).toBe(true);
  });

  it("removes the dead rolled-note content rule that no JSX attribute feeds", () => {
    expect(styles).not.toContain("attr(data-rolled-note)");
  });
});
