import { describe, expect, it } from "vitest";
import { isCompletedStatus } from "./status-categories.js";

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
