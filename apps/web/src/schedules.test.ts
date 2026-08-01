import { describe, expect, it } from "vitest";
import { buildSchedule, setScheduleDependencies, updateScheduleWindow, withScheduleWindow } from "./schedules.js";

describe("updateScheduleWindow", () => {
  const multiTrack = {
    target: { start: "2026-08-01", finish: "2026-08-30" },
    working: { start: "2026-08-05", finish: "2026-08-20", effort_hours: 40, depends_on: ["T-26-AAAAAA"] },
    forecast: { finish: "2026-09-10" },
  };

  it("changes only the edited finish and keeps other tracks, depends_on, and sibling fields", () => {
    const next = updateScheduleWindow(multiTrack, "working", { start: "2026-08-05", finish: "2026-08-18", effort_hours: "40" })!;
    expect(next.target).toEqual({ start: "2026-08-01", finish: "2026-08-30" });
    expect(next.forecast).toEqual({ finish: "2026-09-10" });
    expect(next.working).toEqual({ start: "2026-08-05", finish: "2026-08-18", effort_hours: 40, depends_on: ["T-26-AAAAAA"] });
  });

  it("preserves depends_on and unknown fields when only the finish is patched", () => {
    const next = updateScheduleWindow(multiTrack, "working", { finish: "2026-08-17" })!;
    expect(next.target).toEqual(multiTrack.target);
    expect(next.forecast).toEqual(multiTrack.forecast);
    expect(next.working).toEqual({ start: "2026-08-05", finish: "2026-08-17", effort_hours: 40, depends_on: ["T-26-AAAAAA"] });
  });

  it("keeps a dependency-only window when every editable field is cleared", () => {
    const next = updateScheduleWindow(multiTrack, "working", { start: "", finish: "", effort_hours: "" })!;
    expect(next.working).toEqual({ depends_on: ["T-26-AAAAAA"] });
    expect(next.target).toEqual(multiTrack.target);
    expect(next.forecast).toEqual(multiTrack.forecast);
  });

  it("returns undefined when clearing the only window empties the whole map", () => {
    expect(updateScheduleWindow({ working: { start: "2026-08-05", finish: "2026-08-20" } }, "working", { start: "", finish: "", effort_hours: "" })).toBeUndefined();
  });

  it("clearing individual editable fields removes them while keeping depends_on", () => {
    const next = updateScheduleWindow(multiTrack, "working", { start: "", finish: "2026-08-20", effort_hours: "" })!;
    expect(next.working).toEqual({ finish: "2026-08-20", depends_on: ["T-26-AAAAAA"] });
  });

  it("builds a fresh window when no existing schedules are present", () => {
    const next = updateScheduleWindow(undefined, "working", { start: "2026-08-05", finish: "2026-08-20", effort_hours: "40" })!;
    expect(next).toEqual({ working: { start: "2026-08-05", finish: "2026-08-20", effort_hours: 40 } });
  });

  it("returns undefined when building an empty fresh window", () => {
    expect(updateScheduleWindow(undefined, "working", { start: "", finish: "", effort_hours: "" })).toBeUndefined();
  });

  it("leaves the schedules untouched when the track slug is empty", () => {
    expect(updateScheduleWindow(multiTrack, "", { finish: "2026-08-19" })).toEqual(multiTrack);
  });

  it("keeps buildSchedule parity for fresh single-track creation", () => {
    expect(buildSchedule("working", "2026-08-05", "2026-08-20", "40")).toEqual({ working: { start: "2026-08-05", finish: "2026-08-20", effort_hours: 40 } });
  });
});

describe("setScheduleDependencies", () => {
  it("creates a dependency-only window for an absent track", () => {
    expect(setScheduleDependencies(undefined, "working", ["T-26-AAAAAA"])).toEqual({
      working: { depends_on: ["T-26-AAAAAA"] },
    });
  });

  it("removes an empty dependency-only window after its last dependency is cleared", () => {
    expect(setScheduleDependencies({ working: { depends_on: ["T-26-AAAAAA"] } }, "working", [])).toBeUndefined();
  });

  it("preserves neighboring tracks while dependencies change", () => {
    const multiTrack = {
      target: { start: "2026-08-01", finish: "2026-08-30" },
      working: { start: "2026-08-05", finish: "2026-08-20", effort_hours: 40, depends_on: ["T-26-AAAAAA"] },
      forecast: { finish: "2026-09-10" },
    };
    expect(setScheduleDependencies(multiTrack, "working", ["T-26-BBBBBB"])).toEqual({
      target: multiTrack.target,
      forecast: multiTrack.forecast,
      working: { start: "2026-08-05", finish: "2026-08-20", effort_hours: 40, depends_on: ["T-26-BBBBBB"] },
    });
  });
});

describe("withScheduleWindow", () => {
  it("sets schedules on the document and deletes the key when the map is empty", () => {
    const preserved = { schema: "gitpm/task@2", id: "T-26-BBBBBB", schedules: { target: { finish: "2026-08-30" } } } as const;
    const updated = withScheduleWindow(preserved, "working", { start: "2026-08-05", finish: "2026-08-20", effort_hours: "40" });
    expect(updated.schedules).toEqual({ target: { finish: "2026-08-30" }, working: { start: "2026-08-05", finish: "2026-08-20", effort_hours: 40 } });

    const cleared = withScheduleWindow({ ...preserved, schedules: { working: { finish: "2026-08-20" } } }, "working", { finish: "" });
    expect(cleared.schedules).toBeUndefined();
  });
});
