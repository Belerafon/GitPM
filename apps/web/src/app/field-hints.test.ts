import { describe, expect, it } from "vitest";
// The browser tsconfig intentionally excludes Node types; these tests run under Vitest in Node.
// @ts-expect-error node:fs is unavailable in the browser type context.
import { readFileSync, readdirSync } from "node:fs";
// @ts-expect-error node:path is unavailable in the browser type context.
import { dirname, join } from "node:path";
// @ts-expect-error node:url is unavailable in the browser type context.
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { localeRegistry, message, type MessageKey } from "../i18n.js";
import { FIELD_HINT_KEYS, localizedFieldHints } from "./field-hints.js";

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const automaticLabels = new Set<MessageKey>(FIELD_HINT_KEYS.map(([label]) => label));

function productionTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry: { readonly isDirectory: () => boolean; readonly name: string }) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionTsxFiles(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") && !entry.name.includes(".stories.") ? [path] : [];
  });
}

function jsxTag(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

function hasAttribute(node: ts.JsxOpeningLikeElement, name: string): boolean {
  return node.attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.getText() === name);
}

function translationKeys(node: ts.Node): MessageKey[] {
  const keys: MessageKey[] = [];
  const visit = (candidate: ts.Node) => {
    const firstArgument = ts.isCallExpression(candidate) ? candidate.arguments[0] : undefined;
    if (ts.isCallExpression(candidate) && candidate.expression.getText() === "t" && firstArgument !== undefined && ts.isStringLiteral(firstArgument)) {
      keys.push(firstArgument.text as MessageKey);
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return keys;
}

function containsInlineHelp(node: ts.JsxElement): boolean {
  let found = false;
  const visit = (candidate: ts.Node) => {
    if (ts.isJsxElement(candidate) && jsxTag(candidate.openingElement) === "small") found = true;
    if (!found) ts.forEachChild(candidate, visit);
  };
  node.children.forEach(visit);
  return found;
}

function elementHasHint(node: ts.JsxElement): boolean {
  return hasAttribute(node.openingElement, "data-field-hint")
    || containsInlineHelp(node)
    || translationKeys(node).some((key) => automaticLabels.has(key));
}

function enclosingFieldset(node: ts.Node): ts.JsxElement | undefined {
  let parent = node.parent;
  while (parent !== undefined) {
    if (ts.isJsxElement(parent) && jsxTag(parent.openingElement) === "fieldset") return parent;
    parent = parent.parent;
  }
  return undefined;
}

function uncoveredFieldCaptions(): string[] {
  const uncovered: string[] = [];
  for (const path of productionTsxFiles(sourceRoot)) {
    const source = readFileSync(path, "utf8");
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) && ["label", "legend"].includes(jsxTag(node.openingElement))) {
        let covered = elementHasHint(node);
        if (!covered && jsxTag(node.openingElement) === "label") {
          const fieldset = enclosingFieldset(node);
          const legend = fieldset?.children.find((child): child is ts.JsxElement => ts.isJsxElement(child) && jsxTag(child.openingElement) === "legend");
          covered = legend !== undefined && elementHasHint(legend);
        }
        if (!covered) {
          const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
          const relative = path.slice(sourceRoot.length + 1).replaceAll("\\", "/");
          uncovered.push(`${relative}:${line} <${jsxTag(node.openingElement)}> ${translationKeys(node).join(", ") || "dynamic caption"}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return uncovered;
}

describe("field hint catalog", () => {
  it("keeps automatic localized captions semantically unambiguous", () => {
    for (const locale of Object.keys(localeRegistry)) {
      const byCaption = new Map<string, Set<string>>();
      for (const [label, hint] of FIELD_HINT_KEYS) {
        const caption = message(locale, label);
        const hints = byCaption.get(caption) ?? new Set<string>();
        hints.add(message(locale, hint));
        byCaption.set(caption, hints);
      }
      expect([...byCaption].filter(([, hints]) => hints.size > 1), locale).toEqual([]);
    }
  });

  it("suppresses an unexpected localized caption collision instead of choosing the wrong hint", () => {
    const translate = (key: MessageKey) => key.startsWith("fieldHint.") ? key : "same caption";
    expect(localizedFieldHints(translate).has("same caption")).toBe(false);
  });

  it("covers every JSX field caption with an automatic, explicit, inline, or group hint", () => {
    expect(uncoveredFieldCaptions()).toEqual([]);
  });
});
