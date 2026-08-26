import { describe, expect, it } from "vitest";
import { nestScheduleColumns, parseCsvEntities, parseJsonLinesEntities, parseYamlEntities } from "./entity-input.js";

describe("CLI entity import parsers", () => {
  it("parses UTF-8 CSV, quoted commas, CRLF and numeric fields", () => {
    expect(parseCsvEntities("\uFEFFname,email,weekly_capacity_hours,annual_vacation_extra_days,annual_vacation_extra_days_reason\r\n\"Иван, Иванов\",ivan@example.test,36,5,Переработки\r\n", "people.csv"))
      .toEqual([{ name: "Иван, Иванов", email: "ivan@example.test", weekly_capacity_hours: 36, annual_vacation_extra_days: 5, annual_vacation_extra_days_reason: "Переработки" }]);
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

  it("nests legacy schedule columns under the resolved track instead of the document root", () => {
    expect(nestScheduleColumns({ title: "Ship", start: "2026-08-01", due: "2026-08-05", estimate_hours: 12, depends_on: ["T-1"], assignees: [] }, "working"))
      .toEqual({ title: "Ship", assignees: [], schedules: { working: { start: "2026-08-01", finish: "2026-08-05", effort_hours: 12, depends_on: ["T-1"] } } });
  });

  it("leaves records unchanged when no track is resolved and never invents a plan track", () => {
    expect(nestScheduleColumns({ title: "Ship", start: "2026-08-01" }, "")).toEqual({ title: "Ship" });
  });
});
