import { describe, expect, it } from "vitest";
import { buildTaskHierarchy } from "./index.js";

describe("task hierarchy", () => {
  it("builds an unlimited-depth ordered forest and exposes navigation helpers", () => {
    const tasks = [
      { id: "root", title: "Root" },
      { id: "child-b", parent: "root", title: "Child B" },
      { id: "child-a", parent: "root", title: "Child A" },
      { id: "grandchild", parent: "child-a", title: "Grandchild" },
      { id: "great-grandchild", parent: "grandchild", title: "Great-grandchild" },
    ];
    const hierarchy = buildTaskHierarchy(tasks, { order: ["root", "child-a", "grandchild", "great-grandchild", "child-b"] });

    expect(hierarchy.flatten().map(({ task, depth }) => [task.id, depth])).toEqual([
      ["root", 0],
      ["child-a", 1],
      ["grandchild", 2],
      ["great-grandchild", 3],
      ["child-b", 1],
    ]);
    expect(hierarchy.ancestorsOf("great-grandchild").map((task) => task.id)).toEqual(["root", "child-a", "grandchild"]);
    expect(hierarchy.descendantsOf("child-a").map((task) => task.id)).toEqual(["grandchild", "great-grandchild"]);
    expect(hierarchy.depthOf("great-grandchild")).toBe(3);
  });

  it("keeps orphaned and cyclic input visible without recursing forever", () => {
    const hierarchy = buildTaskHierarchy([
      { id: "orphan", parent: "missing" },
      { id: "cycle-a", parent: "cycle-b" },
      { id: "cycle-b", parent: "cycle-a" },
    ]);

    expect(hierarchy.flatten().map((entry) => entry.task.id).sort()).toEqual(["cycle-a", "cycle-b", "orphan"]);
    expect(hierarchy.pathTo("cycle-a").map((task) => task.id)).toEqual(["cycle-b", "cycle-a"]);
  });
});
