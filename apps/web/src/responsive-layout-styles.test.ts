import { describe, expect, it } from "vitest";

// The browser tsconfig intentionally excludes Node types; under vitest (Node) the built-ins resolve fine.
// @ts-expect-error node:fs is unavailable in the browser type context.
import { readFileSync } from "node:fs";
// @ts-expect-error node:path is unavailable in the browser type context.
import { dirname, resolve } from "node:path";
// @ts-expect-error node:url is unavailable in the browser type context.
import { fileURLToPath } from "node:url";

const styles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

describe("responsive workspace breakpoints", () => {
  it("stacks wide content grids before the desktop sidebar makes them overflow", () => {
    expect(styles).toContain("@media (max-width: 1000px) { .draft-layout { grid-template-columns: 1fr; } }");
    expect(styles).toContain("@media (max-width: 1000px) { .workload-toolbar { grid-template-columns: 1fr; }");
    expect(styles).toContain("@media (max-width: 1000px) { .people-profile-header { grid-template-columns: auto minmax(0, 1fr); }");
    expect(styles).toContain(".people-profile-controls { grid-column: 1 / -1;");
  });

  it("adapts advanced filter controls to the drawer instead of the viewport", () => {
    expect(styles).toContain(".advanced-view-form { container: advanced-view-form / inline-size;");
    expect(styles).toContain("@container advanced-view-form (max-width: 520px)");
    expect(styles).toContain(".advanced-filter-condition-controls > select, .advanced-filter-condition-controls > input { min-width: 0; width: 100%; }");
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr) auto;");
  });
});
