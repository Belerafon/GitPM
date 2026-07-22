import { describe, expect, it } from "vitest";
import { parseCsvEntities, parseJsonLinesEntities, parseYamlEntities } from "./entity-input.js";

describe("CLI entity import parsers", () => {
  it("parses UTF-8 CSV, quoted commas, CRLF and numeric fields", () => {
    expect(parseCsvEntities("\uFEFFname,email,weekly_capacity_hours\r\n\"Иван, Иванов\",ivan@example.test,36\r\n", "people.csv"))
      .toEqual([{ name: "Иван, Иванов", email: "ivan@example.test", weekly_capacity_hours: 36 }]);
  });

  it("rejects malformed CSV rows and numeric values with stable codes", () => {
    expect(() => parseCsvEntities("name,weekly_capacity_hours\nAda,nope\n", "people.csv"))
      .toThrowError(expect.objectContaining({ code: "CSV_VALUE_INVALID" }));
    expect(() => parseCsvEntities("name,email\nAda\n", "people.csv"))
      .toThrowError(expect.objectContaining({ code: "CSV_ROW_INVALID" }));
  });

  it("parses YAML arrays and JSON Lines mappings", () => {
    expect(parseYamlEntities("- name: Ada\n- name: Grace\n", "people.yaml")).toEqual([{ name: "Ada" }, { name: "Grace" }]);
    expect(parseJsonLinesEntities('{"name":"Ada"}\n{"name":"Grace"}\n', "people.jsonl")).toEqual([{ name: "Ada" }, { name: "Grace" }]);
  });
});
