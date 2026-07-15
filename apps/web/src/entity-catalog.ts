import type { EntityResult, GitPmDocument } from "./types.js";

export interface EntityReference {
  readonly id: string;
  readonly name: string;
  readonly lifecycle: "active" | "archived";
}

export interface TaskReferences {
  readonly project: EntityReference;
  readonly milestone?: EntityReference;
  readonly milestoneId?: string;
}

const text = (document: GitPmDocument, key: string): string => typeof document[key] === "string" ? document[key] as string : "";
const reference = (entity: EntityResult): EntityReference => ({
  id: entity.document.id,
  name: text(entity.document, "name") || entity.document.id,
  lifecycle: entity.document.lifecycle,
});

export class EntityCatalog {
  readonly projects: ReadonlyMap<string, EntityReference>;
  readonly milestones: ReadonlyMap<string, EntityReference>;
  readonly tasks: ReadonlyMap<string, EntityReference>;

  constructor({ projects = [], milestones = [], tasks = [] }: {
    readonly projects?: readonly EntityResult[];
    readonly milestones?: readonly EntityResult[];
    readonly tasks?: readonly EntityResult[];
  }) {
    this.projects = new Map(projects.map((entity) => [entity.document.id, reference(entity)]));
    this.milestones = new Map(milestones.map((entity) => [entity.document.id, reference(entity)]));
    this.tasks = new Map(tasks.map((entity) => [entity.document.id, {
      id: entity.document.id,
      name: text(entity.document, "title") || entity.document.id,
      lifecycle: entity.document.lifecycle,
    }]));
  }

  project(id: unknown): EntityReference {
    const key = typeof id === "string" ? id : "";
    return this.projects.get(key) ?? { id: key, name: key, lifecycle: "active" };
  }

  milestone(id: unknown): EntityReference | undefined {
    const key = typeof id === "string" ? id : "";
    return key === "" ? undefined : this.milestones.get(key) ?? { id: key, name: key, lifecycle: "active" };
  }

  task(id: unknown): EntityReference {
    const key = typeof id === "string" ? id : "";
    return this.tasks.get(key) ?? { id: key, name: key, lifecycle: "active" };
  }

  referencesForTask(document: GitPmDocument): TaskReferences {
    const milestoneId = text(document, "milestone") || undefined;
    return {
      project: this.project(document.project),
      milestone: this.milestone(milestoneId),
      milestoneId,
    };
  }
}
