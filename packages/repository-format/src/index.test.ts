import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatYamlText, parseYamlDocument, RepositoryFormatError } from "./index.js";

async function yamlFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await yamlFiles(absolute));
    else if (entry.name.endsWith(".yaml")) result.push(absolute);
  }
  return result.sort();
}

describe("safe YAML profile", () => {
  it("formats every demo document idempotently and removes comments", async () => {
    const fixtureRoot = path.join(process.cwd(), "fixtures", "schema-v1", "demo");
    const files = await yamlFiles(fixtureRoot);
    expect(files).toHaveLength(14);
    for (const file of files) {
      const original = `# removed by formatter\n${await readFile(file, "utf8")}`;
      const once = formatYamlText(original, file);
      const twice = formatYamlText(once, file);
      expect(twice).toBe(once);
      expect(once).not.toContain("removed by formatter");
      expect(once.endsWith("\n")).toBe(true);
    }
  });

  it.each([
    ["YAML_DUPLICATE_KEY", "schema: gitpm/project@1\nid: one\nid: two\n"],
    ["YAML_ANCHOR", "schema: gitpm/project@1\nvalue: &shared text\n"],
    ["YAML_ALIAS", "schema: gitpm/project@1\nvalue: *shared\n"],
    ["YAML_CUSTOM_TAG", "schema: gitpm/project@1\nvalue: !custom text\n"],
    ["YAML_LINE_ENDING", "schema: gitpm/project@1\r\n"],
  ])("rejects unsafe YAML with %s", (code, text) => {
    try {
      parseYamlDocument(text);
      expect.fail("unsafe YAML passed");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryFormatError);
      expect(error).toMatchObject({ code });
    }
  });
});
