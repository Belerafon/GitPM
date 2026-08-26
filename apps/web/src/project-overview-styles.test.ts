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
      "plan-actual-disclaimer",
    ];
    for (const className of required) expect(hasRule(className), `${className} should have a CSS rule`).toBe(true);
  });

  it("styles plan-actual-disclaimer as a wrapping secondary hint that is separated from the table", () => {
    // Extract the single disclaimer rule block so its declarations can be checked in isolation.
    const ruleMatch = styles.match(new RegExp("\\.plan-actual-disclaimer\\s*\\{([^}]*)\\}", "u"));
    expect(ruleMatch, "plan-actual-disclaimer rule must exist").not.toBeNull();
    const declarations = ruleMatch![1];
    // Readable but secondary: smaller than the table body, muted colour, constrained line length
    // so the hint wraps on narrow screens and never competes with the heading.
    expect(declarations).toMatch(/font-size\s*:\s*0?\.7\d?rem/u);
    expect(declarations).toMatch(/max-width\s*:\s*\d+ch/u);
    expect(declarations).toMatch(/color\s*:\s*#6/i);
    // Separated from the table above so it reads as a footnote, not a data row.
    expect(declarations).toMatch(/border-top|padding-top|margin-top/u);
  });

  it("removes the dead rolled-note content rule that no JSX attribute feeds", () => {
    expect(styles).not.toContain("attr(data-rolled-note)");
  });

  it("preserves readable project identity and reachable register columns in narrow workspaces", () => {
    const registerRule = styles.match(/\.project-register\s*\{([^}]*)\}/u)?.[1] ?? "";
    expect(registerRule).toContain("overflow-x: auto");
    expect(styles).toContain("@media (max-width: 1180px) { .project-plan-header { grid-template-columns: 1fr; }");
    expect(styles).toContain(".project-plan-actions { flex-wrap: wrap; }");
  });
});
