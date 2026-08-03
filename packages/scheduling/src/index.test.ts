import { describe, expect, it } from "vitest";
import {
  buildSchedulingReadModel,
  buildGanttModel,
  daysBetween,
  declaredWindow,
  dependencyEdges,
  detectCyclesPerTrack,
  effectiveFinish,
  effectiveWindow,
  finishVarianceDays,
  hasCapability,
  isActualTrack,
  isManualTrack,
  isOverdue,
  overdueDays,
  resolvePlanning,
  resolveTrack,
  readModelTrack,
  resolveSchedulingHierarchy,
  rollupOverflowWarnings,
  rollupWindow,
  validatePlanning,
  windowEffort,
  windowCapabilityViolations,
  windowDateRangeViolations,
  type PlanningSettings,
  type ScheduleTracksConfig,
  type ScheduleWindow,
  type Schedulable,
} from "./index.js";

const config: ScheduleTracksConfig = {
  schema: "gitpm/schedule-tracks@1",
  tracks: [
    { slug: "target", title: "Целевой график", kind: "manual", capabilities: ["dates"] },
    { slug: "plan", title: "Рабочий план", kind: "manual", capabilities: ["dates", "effort", "dependencies"] },
    { slug: "actual", title: "Фактическая активность", kind: "actual", source: "time_entries" },
  ],
  defaults: { enabled_tracks: ["plan"], primary_track: "plan", workload_track: "plan", comparison_track: "plan", dashboard_tracks: ["plan"] },
};

const schedulable = (id: string, schedules: Readonly<Record<string, ScheduleWindow>> = {}): Schedulable => ({ id, schedules });

describe("schedule track resolution", () => {
  it("resolves tracks and kinds", () => {
    expect(resolveTrack(config, "plan")?.kind).toBe("manual");
    expect(isManualTrack(resolveTrack(config, "plan")!)).toBe(true);
    expect(isActualTrack(resolveTrack(config, "actual")!)).toBe(true);
    expect(resolveTrack(config, "missing")).toBeUndefined();
  });

  it("reads declared windows and respects capabilities", () => {
    expect(hasCapability(resolveTrack(config, "target")!, "effort")).toBe(false);
    expect(hasCapability(resolveTrack(config, "plan")!, "dependencies")).toBe(true);
    const subject = schedulable("T-26-1", { plan: { start: "2026-09-01", finish: "2026-09-30", effort_hours: 160 } });
    expect(declaredWindow(subject, "plan")?.effort_hours).toBe(160);
    expect(declaredWindow(subject, "target")).toBeUndefined();
  });
});

describe("capability and range violations", () => {
  it("flags effort and dependencies on tracks lacking the capability", () => {
    const target = resolveTrack(config, "target")!;
    expect(windowCapabilityViolations({ effort_hours: 10 }, target)).toHaveLength(1);
    expect(windowCapabilityViolations({ depends_on: ["T-26-9"] }, target)).toHaveLength(1);
    expect(windowCapabilityViolations({ start: "2026-09-01", finish: "2026-09-30" }, target)).toHaveLength(0);
  });

  it("keeps dates always allowed and validates ranges", () => {
    const plan = resolveTrack(config, "plan")!;
    expect(windowCapabilityViolations({ start: "2026-09-01", finish: "2026-09-30", effort_hours: 40, depends_on: ["T-26-9"] }, plan)).toHaveLength(0);
    expect(windowDateRangeViolations({ start: "2026-09-30", finish: "2026-09-01" })?.code).toBe("DATE_RANGE");
    expect(windowDateRangeViolations({ start: "2026-09-01", finish: "2026-09-30" })).toBeUndefined();
  });
});

describe("rollup and effective windows", () => {
  const children: readonly Schedulable[] = [
    schedulable("T-26-A", { plan: { start: "2026-09-03", finish: "2026-09-10", effort_hours: 40 } }),
    schedulable("T-26-B", { plan: { start: "2026-09-01", finish: "2026-09-20", effort_hours: 60 } }),
    schedulable("T-26-C", { plan: { finish: "2026-09-25" } }),
  ];

  it("rolls up earliest start, latest finish and summed effort", () => {
    const rolled = rollupWindow(children, "plan");
    expect(rolled).toEqual({ start: "2026-09-01", finish: "2026-09-25", effort_hours: 100 });
  });

  it("returns undefined when no child contributes a window", () => {
    expect(rollupWindow(children, "target")).toBeUndefined();
  });

  it("distinguishes an absent estimate from an explicit zero estimate", () => {
    const withoutEstimates = rollupWindow([schedulable("T-26-A", { plan: { start: "2026-09-01", finish: "2026-09-02" } })], "plan");
    const zeroEstimate = rollupWindow([schedulable("T-26-B", { plan: { effort_hours: 0 } })], "plan");
    expect(windowEffort(withoutEstimates)).toBeUndefined();
    expect(windowEffort(zeroEstimate)).toBe(0);
  });

  it("prefers declared window, otherwise falls back to rollup", () => {
    const parent = schedulable("T-26-P", { plan: { start: "2026-09-05", finish: "2026-09-15" } });
    expect(effectiveWindow(parent, "plan")).toEqual({ start: "2026-09-05", finish: "2026-09-15" });
    expect(effectiveWindow(parent, "plan", children)).toEqual({ start: "2026-09-05", finish: "2026-09-15" });
    expect(effectiveWindow(schedulable("T-26-Q"), "plan", children)?.start).toBe("2026-09-01");
    expect(effectiveWindow(schedulable("T-26-Q"), "plan")).toBeUndefined();
  });

  it("warns when children overflow the declared range", () => {
    const parent = schedulable("T-26-P", { plan: { start: "2026-09-02", finish: "2026-09-18" } });
    const warnings = rollupOverflowWarnings(parent, children, ["plan"]);
    expect(warnings).toContainEqual({ track: "plan", field: "start", declared: "2026-09-02", rolled: "2026-09-01" });
    expect(warnings).toContainEqual({ track: "plan", field: "finish", declared: "2026-09-18", rolled: "2026-09-25" });
  });

  it("builds declared, rolled, and effective windows for a parent", () => {
    const parent = schedulable("T-26-P", { plan: { start: "2026-09-02", finish: "2026-09-18" } });
    const model = buildSchedulingReadModel(parent, children, ["plan", "target"]);
    const plan = readModelTrack(model, "plan")!;
    expect(plan.declared).toEqual({ start: "2026-09-02", finish: "2026-09-18" });
    expect(plan.rolled).toEqual({ start: "2026-09-01", finish: "2026-09-25", effort_hours: 100 });
    expect(plan.effective).toEqual(plan.declared);
    expect(effectiveFinish(model, "plan")).toBe("2026-09-18");
    expect(model.overflowWarnings).toHaveLength(2);

    const rolledOnly = buildSchedulingReadModel(schedulable("T-26-Q"), children, ["plan"]);
    expect(readModelTrack(rolledOnly, "plan")?.effective).toEqual({ start: "2026-09-01", finish: "2026-09-25", effort_hours: 100 });
  });
});

describe("scheduling hierarchy resolution", () => {
  it("resolves nested tasks children-first and preserves a declared parent window", () => {
    const hierarchy = resolveSchedulingHierarchy({
      tracks: ["plan"],
      tasks: [
        { id: "T-parent", milestone: "M-1", schedules: { plan: { start: "2026-09-05", finish: "2026-09-12", effort_hours: 20 } } },
        { id: "T-child", parent: "T-parent", milestone: "M-1" },
        { id: "T-leaf", parent: "T-child", milestone: "M-1", schedules: { plan: { start: "2026-09-01", finish: "2026-09-15", effort_hours: 6 } } },
      ],
    });

    expect(readModelTrack(hierarchy.readModels.get("T-child")!, "plan")?.effective).toEqual({ start: "2026-09-01", finish: "2026-09-15", effort_hours: 6 });
    const parent = hierarchy.readModels.get("T-parent")!;
    expect(readModelTrack(parent, "plan")?.rolled).toEqual({ start: "2026-09-01", finish: "2026-09-15", effort_hours: 6 });
    expect(readModelTrack(parent, "plan")?.effective).toEqual({ start: "2026-09-05", finish: "2026-09-12", effort_hours: 20 });
    expect(parent.overflowWarnings).toEqual([
      { track: "plan", field: "start", declared: "2026-09-05", rolled: "2026-09-01" },
      { track: "plan", field: "finish", declared: "2026-09-12", rolled: "2026-09-15" },
    ]);
  });

  it("aggregates only resolved roots into milestones and the project without double-counting effort", () => {
    const hierarchy = resolveSchedulingHierarchy({
      tracks: ["plan"],
      project: { id: "P-1" },
      milestones: [{ id: "M-1" }],
      tasks: [
        { id: "T-parent", milestone: "M-1" },
        { id: "T-child", parent: "T-parent", milestone: "M-1", schedules: { plan: { start: "2026-08-02", finish: "2026-08-05", effort_hours: 5 } } },
        { id: "T-outside", schedules: { plan: { start: "2026-08-01", finish: "2026-08-10", effort_hours: 2 } } },
      ],
    });

    expect(readModelTrack(hierarchy.readModels.get("T-parent")!, "plan")?.effective?.effort_hours).toBe(5);
    expect(readModelTrack(hierarchy.readModels.get("M-1")!, "plan")?.effective).toEqual({ start: "2026-08-02", finish: "2026-08-05", effort_hours: 5 });
    expect(readModelTrack(hierarchy.readModels.get("P-1")!, "plan")?.effective).toEqual({ start: "2026-08-01", finish: "2026-08-10", effort_hours: 7 });
  });

  it("prefers a declared project window over the rolled-up child window at the project root", () => {
    const hierarchy = resolveSchedulingHierarchy({
      tracks: ["plan"],
      project: { id: "P-DECL", schedules: { plan: { start: "2026-09-01", finish: "2026-09-30" } } },
      tasks: [
        { id: "T-LATE", schedules: { plan: { start: "2026-09-01", finish: "2026-11-15", effort_hours: 8 } } },
      ],
    });

    const projectModel = hierarchy.readModels.get("P-DECL")!;
    expect(readModelTrack(projectModel, "plan")?.declared).toEqual({ start: "2026-09-01", finish: "2026-09-30" });
    expect(readModelTrack(projectModel, "plan")?.rolled).toEqual({ start: "2026-09-01", finish: "2026-11-15", effort_hours: 8 });
    expect(readModelTrack(projectModel, "plan")?.effective).toEqual({ start: "2026-09-01", finish: "2026-09-30" });
  });
});

describe("variance and overdue", () => {
  it("counts calendar days between ISO dates", () => {
    expect(daysBetween("2026-02-28", "2026-03-20")).toBe(20);
    expect(finishVarianceDays("2026-03-20", "2026-02-28")).toBe(20);
  });

  it("detects overdue against today", () => {
    expect(isOverdue("2026-09-30", "2026-10-01")).toBe(true);
    expect(isOverdue("2026-09-30", "2026-09-30")).toBe(false);
    expect(overdueDays("2026-09-30", "2026-10-10")).toBe(10);
    expect(overdueDays(undefined, "2026-10-10")).toBeUndefined();
  });
});

describe("per-track dependency cycles", () => {
  it("detects a cycle only within the requested track", () => {
    const subjects: readonly Schedulable[] = [
      schedulable("T-26-1", { plan: { depends_on: ["T-26-2"] } }),
      schedulable("T-26-2", { plan: { depends_on: ["T-26-3"] } }),
      schedulable("T-26-3", { plan: { depends_on: ["T-26-1"] } }),
    ];
    expect(detectCyclesPerTrack(subjects, "plan")).toEqual([["T-26-1", "T-26-2", "T-26-3"]]);
    expect(detectCyclesPerTrack(subjects, "target")).toEqual([]);
    expect(dependencyEdges(subjects[0]!, "plan")).toEqual(["T-26-2"]);
  });

  it("ignores dependencies that point outside the known set", () => {
    const subjects: readonly Schedulable[] = [schedulable("T-26-1", { plan: { depends_on: ["T-26-GHOST"] } })];
    expect(detectCyclesPerTrack(subjects, "plan")).toEqual([]);
  });
});

describe("planning resolution and validation", () => {
  it("falls back to config defaults and manual tracks", () => {
    const resolved = resolvePlanning(config);
    expect(resolved.primary_track).toBe("plan");
    expect(resolved.workload_track).toBe("plan");
    const minimal: ScheduleTracksConfig = {
      schema: "gitpm/schedule-tracks@1",
      tracks: [
        { slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort"] },
        { slug: "actual", title: "Actual", kind: "actual", source: "time_entries" },
      ],
      defaults: {},
    };
    expect(resolvePlanning(minimal).enabled_tracks).toEqual(["plan"]);
    expect(resolvePlanning(config, { enabled_tracks: [], dashboard_tracks: [] })).toMatchObject({
      enabled_tracks: [],
      dashboard_tracks: [],
    });
  });

  it("validates planning settings", () => {
    const settings: PlanningSettings = {
      enabled_tracks: ["plan", "ghost"],
      primary_track: "target",
      workload_track: "actual",
      comparison_track: "plan",
      dashboard_tracks: ["plan", "target"],
    };
    const codes = validatePlanning(config, settings).map((issue) => issue.code);
    expect(codes).toContain("PLANNING_UNKNOWN_TRACK");
    expect(codes).toContain("PLANNING_PRIMARY_NOT_ENABLED");
    expect(codes).toContain("PLANNING_WORKLOAD_NOT_MANUAL");
    expect(codes).toContain("PLANNING_DASHBOARD_UNKNOWN");
  });

  it("accepts consistent settings", () => {
    const settings: PlanningSettings = {
      enabled_tracks: ["target", "plan", "actual"],
      primary_track: "plan",
      workload_track: "plan",
      comparison_track: "target",
      dashboard_tracks: ["target", "plan", "actual"],
    };
    expect(validatePlanning(config, settings)).toEqual([]);
  });

  it.each([
    ["actual", "PLANNING_PRIMARY_NOT_MANUAL"],
    ["links", "PLANNING_PRIMARY_MISSING_DATES"],
  ])("rejects %s as primary", (primaryTrack, expectedCode) => {
    const extended: ScheduleTracksConfig = {
      ...config,
      tracks: [...config.tracks, { slug: "links", title: "Dependencies", kind: "manual", capabilities: ["dependencies"] }],
    };
    const settings: PlanningSettings = {
      enabled_tracks: [primaryTrack, "plan"],
      primary_track: primaryTrack,
      workload_track: "plan",
      dashboard_tracks: [],
    };

    expect(validatePlanning(extended, settings)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: expectedCode, field: "primary_track", track: primaryTrack }),
    ]));
  });

  it.each([
    ["actual", "PLANNING_COMPARISON_NOT_MANUAL"],
    ["effort", "PLANNING_COMPARISON_MISSING_DATES"],
  ])("rejects %s as comparison", (comparisonTrack, expectedCode) => {
    const extended: ScheduleTracksConfig = {
      ...config,
      tracks: [...config.tracks, { slug: "effort", title: "Effort", kind: "manual", capabilities: ["effort"] }],
    };
    const settings: PlanningSettings = {
      enabled_tracks: ["plan", comparisonTrack],
      primary_track: "plan",
      workload_track: "plan",
      comparison_track: comparisonTrack,
      dashboard_tracks: [],
    };

    expect(validatePlanning(extended, settings)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: expectedCode, field: "comparison_track", track: comparisonTrack }),
    ]));
  });

  it("accepts a dates-capable manual comparison", () => {
    const settings: PlanningSettings = {
      enabled_tracks: ["plan", "target"],
      primary_track: "plan",
      workload_track: "plan",
      comparison_track: "target",
      dashboard_tracks: [],
    };

    expect(validatePlanning(config, settings)).toEqual([]);
  });
});

describe("gantt model", () => {
  it("builds primary and visible bars plus dependencies and actual segments", () => {
    const subjects: readonly Schedulable[] = [
      schedulable("T-26-1", { target: { start: "2026-09-01", finish: "2026-09-30" }, plan: { start: "2026-08-15", finish: "2026-09-20", depends_on: ["T-26-2"] } }),
      schedulable("T-26-2", { plan: { start: "2026-08-01", finish: "2026-08-14" } }),
    ];
    const actual = new Map<string, readonly { date: string; hours: number }[]>([["T-26-1", [{ date: "2026-12-18", hours: 3.5 }]]]);
    const model = buildGanttModel(subjects, { primaryTrack: "plan", visibleTracks: ["plan", "target"], dependencyTrack: "plan", actual });
    const first = model.rows[0]!;
    expect(first.primary).toEqual({ track: "plan", start: "2026-08-15", finish: "2026-09-20" });
    expect(first.bars).toContainEqual({ track: "target", start: "2026-09-01", finish: "2026-09-30" });
    expect(first.actual).toEqual([{ date: "2026-12-18", hours: 3.5 }]);
    expect(first.dependencies).toEqual([{ track: "plan", from: "T-26-2", to: "T-26-1" }]);
    expect(model.rows[1]!.primary).toEqual({ track: "plan", start: "2026-08-01", finish: "2026-08-14" });
  });

  it("omits bars for tracks the task is absent from", () => {
    const model = buildGanttModel([schedulable("T-26-1", { plan: { start: "2026-08-01", finish: "2026-08-10" } })], { primaryTrack: "plan", visibleTracks: ["plan", "target"] });
    expect(model.rows[0]!.bars).toEqual([{ track: "plan", start: "2026-08-01", finish: "2026-08-10" }]);
  });

  it("keeps a task whose only bar is in a secondary visible track", () => {
    const subjects: readonly Schedulable[] = [schedulable("T-26-1", { target: { start: "2026-09-01", finish: "2026-09-30" } })];
    const model = buildGanttModel(subjects, { primaryTrack: "plan", visibleTracks: ["plan", "target"] });
    expect(model.rows[0]!.primary).toBeUndefined();
    expect(model.rows[0]!.bars).toEqual([{ track: "target", start: "2026-09-01", finish: "2026-09-30" }]);
  });

  it("computes a range across visible tracks, actual activity and milestones", () => {
    const subjects: readonly Schedulable[] = [
      schedulable("T-26-1", { plan: { start: "2026-08-15", finish: "2026-09-20" }, target: { start: "2026-09-01", finish: "2026-09-30" } }),
    ];
    const actual = new Map<string, readonly { date: string; hours: number }[]>([["T-26-1", [{ date: "2026-12-18", hours: 4 }]]]);
    const model = buildGanttModel(subjects, { primaryTrack: "plan", visibleTracks: ["plan", "target"], actual, milestones: [{ id: "M-1", finish: "2026-07-01" }] });
    expect(model.range).toEqual({ start: "2026-07-01", finish: "2026-12-18" });
  });

  it("aggregates is the consumer's job; the builder carries the provided actual segments", () => {
    const subjects: readonly Schedulable[] = [schedulable("T-26-1", { plan: { start: "2026-08-01", finish: "2026-08-10" } })];
    const actual = new Map<string, readonly { date: string; hours: number }[]>([["T-26-1", [{ date: "2026-08-03", hours: 7 }]]]);
    const model = buildGanttModel(subjects, { primaryTrack: "plan", actual });
    expect(model.rows[0]!.actual).toEqual([{ date: "2026-08-03", hours: 7 }]);
  });
});
