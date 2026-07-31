// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { ScheduleTracksEditor } from "./schedule-tracks-editor.js";
import type { ScheduleMap } from "./schedules.js";
import type { EntityResult } from "./types.js";
import type { TrackDefinition } from "@gitpm/scheduling";

const task = (id: string, title: string): EntityResult => ({ document: { schema: "gitpm/task@2", id, title, lifecycle: "active" }, path: `${id}.yaml`, blob_id: "a", draft_fingerprint: "b" });

afterEach(cleanup);

const targetTrack: TrackDefinition = { slug: "target", title: "Target", kind: "manual", capabilities: ["dates", "effort"] };
const workingTrack: TrackDefinition = { slug: "working", title: "Working", kind: "manual", capabilities: ["dates", "effort", "dependencies"] };
const forecastTrack: TrackDefinition = { slug: "forecast", title: "Forecast", kind: "manual", capabilities: ["dates"] };
const actualTrack: TrackDefinition = { slug: "actual", title: "Actual activity", kind: "actual", source: "time_entries" };

function StatefulEditor({ initial, tracks, primaryTrack, actual, dependencies }: { readonly initial: ScheduleMap | undefined; readonly tracks: readonly TrackDefinition[]; readonly primaryTrack: string; readonly actual?: TrackDefinition; readonly dependencies: readonly EntityResult[] }) {
  const [schedules, setSchedules] = useState<ScheduleMap | undefined>(initial);
  return <><ScheduleTracksEditor schedules={schedules} tracks={tracks} actualTrack={actual} primaryTrack={primaryTrack} dependencies={dependencies} disabled={false} locale="en" onChange={setSchedules} /><output data-testid="schedules-state">{JSON.stringify(schedules)}</output></>;
}

describe("ScheduleTracksEditor", () => {
  it("renders a simple form without tabs for a single manual track", () => {
    const { container } = render(<StatefulEditor initial={{ plan: { start: "2026-08-01", finish: "2026-08-10", effort_hours: 8 } }} tracks={[{ slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort"] }]} primaryTrack="plan" dependencies={[]} />);
    expect(container.querySelector(".schedule-tracks-tabs")).toBeNull();
    expect((screen.getByLabelText("Start date") as HTMLInputElement).value).toBe("2026-08-01");
    expect((screen.getByLabelText("Due date") as HTMLInputElement).value).toBe("2026-08-10");
    expect((screen.getByLabelText("Estimate (hours)") as HTMLInputElement).value).toBe("8");
  });

  it("shows titled tabs for several manual tracks and a read-only note for the actual track", () => {
    render(<StatefulEditor initial={{ working: { start: "2026-08-05", finish: "2026-08-20" } }} tracks={[targetTrack, workingTrack, forecastTrack]} primaryTrack="working" actual={actualTrack} dependencies={[]} />);
    const tabs = screen.getByRole("tablist");
    expect(Array.from(tabs.querySelectorAll("button")).map((button) => button.textContent)).toEqual(["Target", "Working · primary", "Forecast"]);
    expect(screen.getByText(/Actual activity is recorded from time entries/u)).toBeTruthy();
    expect((screen.getByLabelText("Due date") as HTMLInputElement).value).toBe("2026-08-20");
  });

  it("hides the estimate field for a track without the effort capability", () => {
    render(<StatefulEditor initial={{ forecast: { start: "2026-09-01", finish: "2026-09-10" } }} tracks={[forecastTrack, workingTrack]} primaryTrack="forecast" dependencies={[]} />);
    expect((screen.getByLabelText("Due date") as HTMLInputElement).value).toBe("2026-09-10");
    expect(screen.queryByLabelText("Estimate (hours)")).toBeNull();
  });

  it("creates a window for a track the task was absent from while keeping the others", () => {
    render(<StatefulEditor initial={{ working: { start: "2026-08-05", finish: "2026-08-20", effort_hours: 40 } }} tracks={[targetTrack, workingTrack]} primaryTrack="working" dependencies={[]} />);
    fireEvent.click(screen.getByRole("tab", { name: "Target" }));
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-08-30" } });
    const targetInput = screen.getByLabelText("Due date") as HTMLInputElement;
    expect(targetInput.value).toBe("2026-08-30");
  });

  it("keeps independent dependencies per track", () => {
    const depA = task("T-26-AAAAAA", "Parser");
    const depB = task("T-26-BBBBBB", "Review");
    const targetWithDeps: TrackDefinition = { slug: "target", title: "Target", kind: "manual", capabilities: ["dates", "effort", "dependencies"] };
    const { container } = render(<StatefulEditor initial={{ working: { depends_on: [depA.document.id] }, target: { depends_on: [depB.document.id] } }} tracks={[targetWithDeps, workingTrack]} primaryTrack="working" dependencies={[depA, depB]} />);
    const current = () => container.querySelector(".schedule-dependencies-current")!.textContent;
    expect(current()).toContain("Parser");
    expect(current()).not.toContain("Review");
    fireEvent.click(screen.getByRole("tab", { name: "Target" }));
    expect(current()).toContain("Review");
    expect(current()).not.toContain("Parser");
  });

  it("adds and removes a dependency on the active track", () => {
    const dep = task("T-26-AAAAAA", "Parser");
    render(<StatefulEditor initial={{ working: { start: "2026-08-05", finish: "2026-08-20" } }} tracks={[workingTrack]} primaryTrack="working" dependencies={[dep]} />);
    fireEvent.change(screen.getByLabelText("Add dependency"), { target: { value: dep.document.id } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByText("Parser")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Remove dependency Parser/u }));
    expect(screen.getByText("No dependencies")).toBeTruthy();
  });

  it("creates and removes a dependency-only window without changing its neighboring track", () => {
    const dep = task("T-26-AAAAAA", "Parser");
    render(<StatefulEditor initial={{ target: { finish: "2026-08-30" } }} tracks={[workingTrack]} primaryTrack="working" dependencies={[dep]} />);
    fireEvent.change(screen.getByLabelText("Add dependency"), { target: { value: dep.document.id } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(JSON.parse(screen.getByTestId("schedules-state").textContent ?? "null")).toEqual({
      target: { finish: "2026-08-30" },
      working: { depends_on: [dep.document.id] },
    });
    fireEvent.click(screen.getByRole("button", { name: /Remove dependency Parser/u }));
    expect(JSON.parse(screen.getByTestId("schedules-state").textContent ?? "null")).toEqual({ target: { finish: "2026-08-30" } });
  });
});
