import { describe, expect, it } from "vitest";
import {
  ApiContractError,
  DOCUMENT_SCHEMA_FILES,
  ENTITY_DOCUMENT_SCHEMAS,
  ENTITY_TYPE_SCHEMAS,
  decodeDraftStatus,
  decodeEntityDocument,
  decodeEntityResult,
} from "./index.js";

describe("@gitpm/contracts runtime contracts", () => {
  it("decodes every field of a concrete task document", () => {
    const task = decodeEntityDocument({
      schema: "gitpm/task@1",
      id: "T-26-P9G3P8",
      project: "P-26-MGP84K",
      title: "Typed task",
      type: "task",
      status: "backlog",
      lifecycle: "active",
      assignees: ["U-26-5EBAE3"],
      estimate_hours: 2.5,
    });

    expect(task).toMatchObject({ title: "Typed task", estimate_hours: 2.5 });
  });

  it("rejects missing required entity fields and unknown properties", () => {
    expect(() => decodeEntityDocument({
      schema: "gitpm/project@1",
      id: "P-26-MGP84K",
      lifecycle: "active",
    })).toThrow(ApiContractError);
    expect(() => decodeEntityDocument({
      schema: "gitpm/project@1",
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
        schema: "gitpm/project@1",
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
});
