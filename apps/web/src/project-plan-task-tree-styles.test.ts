import { describe, expect, it } from "vitest";

// The browser tsconfig intentionally excludes Node types; under vitest (Node) the built-ins resolve fine.
// @ts-expect-error node:fs is unavailable in the browser type context.
import { readFileSync } from "node:fs";
// @ts-expect-error node:path is unavailable in the browser type context.
import { dirname, resolve } from "node:path";
// @ts-expect-error node:url is unavailable in the browser type context.
import { fileURLToPath } from "node:url";

const styles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

function declarationsFor(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "u"));
  expect(match, `${selector} must have a CSS rule`).not.toBeNull();
  return match![1]!;
}

describe("project plan task tree styles", () => {
  it("does not reserve a tree gutter for root tasks", () => {
    const row = declarationsFor(".project-plan-task-row");
    expect(row).toMatch(/gap\s*:\s*\.25rem/u);
    expect(row).toMatch(/padding\s*:\s*\.48rem\s+\.4rem\s+\.48rem\s+\.2rem/u);

    const tree = declarationsFor(".project-plan-task-tree");
    expect(tree).toMatch(/width\s*:\s*var\(--task-tree-width,\s*0\)/u);
  });

  it("uses a compact circular control in the left gutter", () => {
    const control = declarationsFor(".project-plan-task-tree-control");
    expect(control).toMatch(/width\s*:\s*1\.125rem/u);
    expect(control).toMatch(/height\s*:\s*1\.125rem/u);

    const button = declarationsFor(".project-plan-task-tree-control button");
    expect(button).toMatch(/width\s*:\s*1\.125rem/u);
    expect(button).toMatch(/height\s*:\s*1\.125rem/u);
    expect(button).toMatch(/border-radius\s*:\s*999px/u);
  });
});
