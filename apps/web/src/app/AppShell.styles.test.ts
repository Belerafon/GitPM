import { describe, expect, it } from "vitest";

// The browser tsconfig intentionally excludes Node types; under vitest (Node) the built-ins resolve fine.
// @ts-expect-error node:fs is unavailable in the browser type context.
import { readFileSync } from "node:fs";
// @ts-expect-error node:path is unavailable in the browser type context.
import { dirname, resolve } from "node:path";
// @ts-expect-error node:url is unavailable in the browser type context.
import { fileURLToPath } from "node:url";

const stylesPath = resolve(dirname(fileURLToPath(import.meta.url)), "../styles.css");
const styles = readFileSync(stylesPath, "utf8");

function declarationsFor(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "u"));
  expect(match, `${selector} must have a CSS rule`).not.toBeNull();
  return match![1]!;
}

describe("AppShell collapsed sidebar styles", () => {
  it("keeps the expand toggle visible where it overlaps the light workspace", () => {
    const toggle = declarationsFor(".sidebar-collapsed .sidebar-collapse-toggle");
    expect(toggle).toMatch(/position\s*:\s*absolute/u);
    expect(toggle).toMatch(/left\s*:\s*100%/u);
    expect(toggle).toMatch(/background\s*:\s*#f4f5f2/iu);
    expect(toggle).toMatch(/color\s*:\s*#18352a/iu);

    const hoveredToggle = declarationsFor(".sidebar-collapsed .sidebar-collapse-toggle:hover:not(:disabled)");
    expect(hoveredToggle).toMatch(/color\s*:\s*#f4f2e9/iu);
  });
});
