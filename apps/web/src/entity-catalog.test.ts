import { describe, expect, it } from "vitest";
import { EntityCatalog } from "./entity-catalog.js";
import type { EntityDocument, EntityResult } from "./types.js";

const entity = (document: EntityDocument): EntityResult => ({ document, path: "", blob_id: "blob", draft_fingerprint: "fingerprint" });

describe("EntityCatalog", () => {
  it("resolves task references and preserves archived milestones", () => {
    const project = entity({ schema: "gitpm/project@1", id: "P-26-111111", name: "Alpha", lifecycle: "active" });
    const milestone = entity({ schema: "gitpm/milestone@1", id: "M-26-222222", project: project.document.id, name: "Beta", lifecycle: "archived" });
    const task = entity({ schema: "gitpm/task@1", id: "T-26-333333", project: project.document.id, milestone: milestone.document.id, title: "Task", lifecycle: "active" });

    expect(new EntityCatalog({ projects: [project], milestones: [milestone] }).referencesForTask(task.document)).toEqual({
      project: { id: "P-26-111111", name: "Alpha", lifecycle: "active" },
      milestone: { id: "M-26-222222", name: "Beta", lifecycle: "archived" },
      milestoneId: "M-26-222222",
    });
  });

  it("keeps an unresolved ID visible instead of treating it as no milestone", () => {
    const task = entity({ schema: "gitpm/task@1", id: "T-26-333333", project: "P-26-111111", milestone: "M-26-222222", title: "Task", lifecycle: "active" });
    const references = new EntityCatalog({}).referencesForTask(task.document);

    expect(references.project.name).toBe("P-26-111111");
    expect(references.milestone?.name).toBe("M-26-222222");
  });
});
