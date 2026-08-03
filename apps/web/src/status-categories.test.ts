import { describe, expect, it } from "vitest";
import { isBlockedStatus, isCompletedStatus, isInProgressStatus } from "./status-categories.js";

describe("isCompletedStatus", () => {
  it("uses the semantic category rather than a reserved slug", () => {
    const statuses = [
      { slug: "accepted", title: "Accepted", active: true, category: "done" as const },
      { slug: "done", title: "Still active", active: true, category: "active" as const },
    ];

    expect(isCompletedStatus(statuses, "accepted")).toBe(true);
    expect(isCompletedStatus(statuses, "done")).toBe(false);
  });
});

describe("isBlockedStatus", () => {
  it("falls back to the blocked slug when the status model has no blocked category", () => {
    const statuses = [
      { slug: "in-progress", title: "In progress", active: true, category: "active" as const },
      { slug: "blocked", title: "Blocked", active: true, category: "active" as const },
      { slug: "done", title: "Done", active: true, category: "done" as const },
    ];

    expect(isBlockedStatus(statuses, "blocked")).toBe(true);
    expect(isBlockedStatus(statuses, "in-progress")).toBe(false);
    expect(isBlockedStatus(statuses, "done")).toBe(false);
    expect(isBlockedStatus(statuses, "unknown")).toBe(false);
  });

  it("prefers a configured blocked category when the schema introduces one", () => {
    const statuses = [
      { slug: "hold", title: "Hold", active: true, category: "blocked" },
      { slug: "blocked", title: "Blocked", active: true, category: "active" as const },
    ];

    expect(isBlockedStatus(statuses, "hold")).toBe(true);
    // A blocked-category status wins even though its slug is not in the fallback list.
  });
});

describe("isInProgressStatus", () => {
  it("matches only the in-progress slug among active-category statuses", () => {
    const statuses = [
      { slug: "backlog", title: "Backlog", active: true, category: "backlog" as const },
      { slug: "planned", title: "Planned", active: true, category: "active" as const },
      { slug: "in-progress", title: "In progress", active: true, category: "active" as const },
      { slug: "review", title: "Review", active: true, category: "active" as const },
      { slug: "blocked", title: "Blocked", active: true, category: "active" as const },
      { slug: "done", title: "Done", active: true, category: "done" as const },
    ];

    expect(isInProgressStatus(statuses, "in-progress")).toBe(true);
    // review shares the active category but is NOT direct execution.
    expect(isInProgressStatus(statuses, "review")).toBe(false);
    expect(isInProgressStatus(statuses, "blocked")).toBe(false);
    expect(isInProgressStatus(statuses, "planned")).toBe(false);
    expect(isInProgressStatus(statuses, "backlog")).toBe(false);
    expect(isInProgressStatus(statuses, "done")).toBe(false);
    expect(isInProgressStatus(statuses, "unknown")).toBe(false);
  });

  it("prefers a configured in-progress category when the schema introduces one", () => {
    const statuses = [
      { slug: "dev", title: "Dev", active: true, category: "in-progress" },
      { slug: "in-progress", title: "In progress", active: true, category: "active" as const },
    ];

    expect(isInProgressStatus(statuses, "dev")).toBe(true);
  });
});
