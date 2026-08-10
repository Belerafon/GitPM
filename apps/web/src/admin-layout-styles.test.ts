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

describe("administration layout styles", () => {
  it("keeps the team member table aligned and independently scrollable", () => {
    const scrollRule = styles.match(/\.member-picker-scroll\s*\{([^}]*)\}/u)?.[1] ?? "";
    const checkboxRule = styles.match(/\.member-picker-table input\[type="checkbox"\]\s*\{([^}]*)\}/u)?.[1] ?? "";

    expect(scrollRule).toMatch(/max-height\s*:\s*300px/u);
    expect(scrollRule).toMatch(/overflow\s*:\s*auto/u);
    expect(checkboxRule).toMatch(/width\s*:\s*18px/u);
    expect(checkboxRule).toMatch(/height\s*:\s*18px/u);
  });
});
