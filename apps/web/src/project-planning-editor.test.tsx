// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPlanningEditor } from "./project-planning-editor.js";
import type { TrackDefinition } from "@gitpm/scheduling";

afterEach(cleanup);

const tracks: readonly TrackDefinition[] = [
  { slug: "plan", title: "Working plan", kind: "manual", capabilities: ["dates", "effort"] },
  { slug: "target", title: "Target", kind: "manual", capabilities: ["dates", "effort"] },
  { slug: "actual", title: "Actual activity", kind: "actual", source: "time_entries" },
];

describe("ProjectPlanningEditor", () => {
  it("changes the primary track and reports the new planning", () => {
    const onChange = vi.fn();
    render(<ProjectPlanningEditor planning={{ enabled_tracks: ["plan", "target", "actual"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan", "target", "actual"] }} tracks={tracks} disabled={false} locale="en" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Primary track"), { target: { value: "target" } });
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)?.[0];
    expect(next).toMatchObject({ primary_track: "target", enabled_tracks: ["plan", "target", "actual"] });
  });

  it("uses track titles and offers the manual tracks for primary selection", () => {
    render(<ProjectPlanningEditor planning={{ enabled_tracks: ["plan", "target", "actual"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan", "target", "actual"] }} tracks={tracks} disabled={false} locale="en" onChange={vi.fn()} />);
    const select = screen.getByLabelText("Primary track") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["None", "Working plan", "Target"]);
  });

  it("disables workload tracks that lack the effort capability", () => {
    const noEffort: readonly TrackDefinition[] = [
      { slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort"] },
      { slug: "target", title: "Target", kind: "manual", capabilities: ["dates"] },
    ];
    render(<ProjectPlanningEditor planning={{ enabled_tracks: ["plan", "target"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan", "target"] }} tracks={noEffort} disabled={false} locale="en" onChange={vi.fn()} />);
    const workload = screen.getByLabelText("Workload track") as HTMLSelectElement;
    expect(Array.from(workload.options).map((option) => option.textContent)).toEqual(["None", "Plan"]);
  });
});
