import { describe, expect, it } from "vitest";
import type { ErrorObject } from "ajv";
import {
  ApiContractError,
  DOCUMENT_SCHEMA_FILES,
  ENTITY_DOCUMENT_SCHEMAS,
  ENTITY_TYPE_SCHEMAS,
  decodeConfigurationResult,
  decodeDraftStatus,
  decodeEntityDocument,
  decodeEntityResult,
  describeAjvError,
  summarizeAjvErrors,
} from "./index.js";

describe("@gitpm/contracts runtime contracts", () => {
  it("decodes every field of a concrete task document", () => {
    const task = decodeEntityDocument({
      schema: "gitpm/task@2",
      id: "T-26-P9G3P8",
      project: "P-26-MGP84K",
      title: "Typed task",
      type: "task",
      status: "backlog",
      lifecycle: "active",
      assignees: ["U-26-5EBAE3"],
      schedules: { plan: { start: "2026-07-01", finish: "2026-07-02", effort_hours: 2.5 } },
    });

    expect(task).toMatchObject({ title: "Typed task" });
    expect(task.schedules?.plan?.effort_hours).toBe(2.5);
  });

  it("rejects missing required entity fields and unknown properties", () => {
    expect(() => decodeEntityDocument({
      schema: "gitpm/project@2",
      id: "P-26-MGP84K",
      lifecycle: "active",
    })).toThrow(ApiContractError);
    expect(() => decodeEntityDocument({
      schema: "gitpm/project@2",
      id: "P-26-MGP84K",
      name: "Project",
      status: "active",
      lifecycle: "active",
      invented: true,
    })).toThrow(ApiContractError);
  });

  it("rejects malformed result metadata and DTO responses", () => {
    expect(() => decodeEntityResult({
      document: {
        schema: "gitpm/project@2",
        id: "P-26-MGP84K",
        name: "Project",
        status: "active",
        lifecycle: "active",
      },
      path: 42,
      blob_id: "blob",
      draft_fingerprint: "fingerprint",
    })).toThrow(ApiContractError);
    expect(() => decodeDraftStatus({ draft_id: "DRF-1" })).toThrow(ApiContractError);
  });

  it("derives entity and CLI schema catalogs from the shared registry", () => {
    expect(ENTITY_DOCUMENT_SCHEMAS).toEqual(Object.values(ENTITY_TYPE_SCHEMAS));
    expect(Object.keys(DOCUMENT_SCHEMA_FILES)).toEqual(expect.arrayContaining([
      "project",
      "task",
      "comment",
      "statuses",
      "issue-types",
    ]));
  });

  it("describes which field, type, and constraint caused a response contract failure", () => {
    expect(() => decodeEntityResult({
      document: {
        schema: "gitpm/project@2",
        id: "P-26-MGP84K",
        name: "Project",
        status: "active",
        lifecycle: "active",
      },
      path: 42,
      blob_id: "blob",
      draft_fingerprint: "fingerprint",
    })).toThrow(/EntityResult: response does not match the shared HTTP contract: path must be string/u);
  });

  it("names the missing required property in a ConfigurationResult failure", () => {
    expect(() => decodeConfigurationResult({
      document: { schema: "gitpm/statuses@2", statuses: [{ slug: "backlog", title: "Backlog", active: true }] },
      path: ".gitpm/statuses.yaml",
      draft_fingerprint: "f".repeat(64),
    })).toThrow(/is missing required property 'blob_id'/u);
  });

  it("points at unexpected properties inside a document body", () => {
    expect(() => decodeEntityDocument({
      schema: "gitpm/project@2",
      id: "P-26-MGP84K",
      name: "Project",
      status: "active",
      lifecycle: "active",
      invented: true,
    })).toThrow(/has unexpected property 'invented'/u);
  });
});

describe("AJV error summarization", () => {
  const error = (overrides: Partial<ErrorObject> = {}): ErrorObject => ({
    instancePath: "",
    schemaPath: "#/",
    keyword: "type",
    params: { type: "string" },
    ...overrides,
  });

  it("renders type, required, additionalProperties, enum, const, and pattern keywords", () => {
    expect(describeAjvError(error({ instancePath: "/path", keyword: "type", params: { type: "string" } })))
      .toBe("path must be string");
    expect(describeAjvError(error({ instancePath: "", keyword: "required", params: { missingProperty: "blob_id" } })))
      .toBe("response is missing required property 'blob_id'");
    expect(describeAjvError(error({ instancePath: "/document", keyword: "additionalProperties", params: { additionalProperty: "foo" } })))
      .toBe("document has unexpected property 'foo'");
    expect(describeAjvError(error({ instancePath: "/role", keyword: "enum", params: { allowedValues: ["Reporter", "Developer"] } })))
      .toBe('role must be one of ["Reporter","Developer"]');
    expect(describeAjvError(error({ instancePath: "/mode", keyword: "const", params: { allowedValue: "repository" } })))
      .toBe('mode must equal "repository"');
    expect(describeAjvError(error({ instancePath: "/id", keyword: "pattern", params: { pattern: "^[A-Z]" } })))
      .toBe('id must match pattern "^[A-Z]"');
  });

  it("renders array indices and nested members as a dotted path", () => {
    expect(describeAjvError(error({ instancePath: "/document/statuses/0/active", keyword: "type", params: { type: "boolean" } })))
      .toBe("document.statuses[0].active must be boolean");
  });

  it("falls back to the keyword message for unsupported keywords", () => {
    expect(describeAjvError(error({ instancePath: "/count", keyword: "minimum", params: { comparison: ">=", limit: 0 }, message: "must be >= 0" })))
      .toBe("count: must be >= 0");
    expect(describeAjvError(error({ instancePath: "/count", keyword: "minItems", params: {} })))
      .toBe("count: failed minItems");
  });

  it("joins multiple errors and truncates past the limit", () => {
    const errors = [
      error({ instancePath: "/a", keyword: "type", params: { type: "string" } }),
      error({ instancePath: "/b", keyword: "type", params: { type: "number" } }),
      error({ instancePath: "/c", keyword: "type", params: { type: "boolean" } }),
    ];
    expect(summarizeAjvErrors(errors)).toBe("a must be string; b must be number; c must be boolean");
    expect(summarizeAjvErrors(errors, 2)).toBe("a must be string; b must be number; and 1 more");
    expect(summarizeAjvErrors([], 2)).toBe("no validation errors reported");
  });
});
