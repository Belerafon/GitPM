import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatYamlDocument, formatYamlText, parseYamlDocument, parseYamlMapping, parseYamlValue, referenceLabelsForDocuments, RepositoryFormatError } from "./index.js";

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
  it("parses safe create mappings and batch arrays without weakening repository document parsing", () => {
    expect(parseYamlMapping("name: Ada\nweekly_capacity_hours: 40\n")).toEqual({ name: "Ada", weekly_capacity_hours: 40 });
    expect(parseYamlValue("- name: Ada\n- name: Grace\n")).toEqual([{ name: "Ada" }, { name: "Grace" }]);
    expect(() => parseYamlDocument("name: Ada\n")).toThrowError(expect.objectContaining({ code: "SCHEMA_MISSING" }));
  });

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

  it("enforces static line and depth limits", () => {
    expect(() => parseYamlDocument(`schema: gitpm/project@1\nvalue: ${"x".repeat(20_001)}\n`))
      .toThrowError(expect.objectContaining({ code: "YAML_LINE_LIMIT" }));
    const nested = `${Array.from({ length: 70 }, (_, index) => `${"  ".repeat(index)}level${index}:`).join("\n")}\n${"  ".repeat(70)}value\n`;
    expect(() => parseYamlDocument(`schema: gitpm/project@1\nnested:\n${nested}`))
      .toThrowError(expect.objectContaining({ code: "YAML_DEPTH_LIMIT" }));
  });

  it("adds reproducible human-readable comments to every entity reference", () => {
    const project = { schema: "gitpm/project@1", id: "P-26-111111", name: "Payments", lifecycle: "active" };
    const milestone = { schema: "gitpm/milestone@1", id: "M-26-222222", project: project.id, name: "Public launch", lifecycle: "active" };
    const person = { schema: "gitpm/person@1", id: "U-26-333333", name: "Ada\nLovelace", lifecycle: "active" };
    const dependency = { schema: "gitpm/task@1", id: "T-26-444444", project: project.id, title: "Approve API", lifecycle: "active" };
    const task = {
      schema: "gitpm/task@1", id: "T-26-555555", project: project.id, title: "Ship checkout", lifecycle: "active",
      milestone: milestone.id, assignees: [person.id], depends_on: [dependency.id],
    };
    const labels = referenceLabelsForDocuments([project, milestone, person, dependency, task]);

    const formatted = formatYamlDocument(task, labels);

    expect(formatted).toContain("id: T-26-555555 # task: Ship checkout");
    expect(formatted).toContain("project: P-26-111111 # project: Payments");
    expect(formatted).toContain("milestone: M-26-222222 # milestone: Public launch");
    expect(formatted).toContain("- U-26-333333 # person: Ada Lovelace");
    expect(formatted).toContain("- T-26-444444 # task: Approve API");
    expect(formatYamlDocument({ ...milestone, task_order: [task.id, dependency.id] }, labels))
      .toContain("- T-26-555555 # task: Ship checkout");
    expect(formatYamlDocument({ ...project, milestone_order: [milestone.id], owner: person.id }, labels))
      .toContain("- M-26-222222 # milestone: Public launch");
    expect(formatYamlDocument({ schema: "gitpm/team@1", id: "G-26-666666", name: "Core", members: [person.id], lifecycle: "active" }, labels))
      .toContain("- U-26-333333 # person: Ada Lovelace");
    expect(formatYamlText(formatted, "task.yaml", labels)).toBe(formatted);
    expect(parseYamlDocument(formatted)).toEqual(task);
  });
});
