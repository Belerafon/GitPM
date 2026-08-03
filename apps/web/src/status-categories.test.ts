import { describe, expect, it } from "vitest";
import { isBlockedStatus, isCompletedStatus } from "./status-categories.js";

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
