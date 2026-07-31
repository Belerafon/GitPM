// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPlanningEditor } from "./project-planning-editor.js";
import { ScheduleResolver, scheduleTracksConfig } from "./schedules.js";
import type { TrackDefinition } from "@gitpm/scheduling";
import type { ConfigurationDocument } from "@gitpm/contracts";

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

  it("shows effective repository defaults when the project has no planning override", () => {
    const config = {
      schema: "gitpm/schedule-tracks@1",
      tracks: [
        { slug: "working", title: "Working", kind: "manual", capabilities: ["dates", "effort"] },
        { slug: "target", title: "Target", kind: "manual", capabilities: ["dates", "effort"] },
        { slug: "actual", title: "Actual", kind: "actual", source: "time_entries" },
      ],
      defaults: { enabled_tracks: ["working", "actual"], primary_track: "working", workload_track: "working", dashboard_tracks: ["working", "actual"] },
    } as ConfigurationDocument;
    const resolver = new ScheduleResolver(scheduleTracksConfig(config));

    render(<ProjectPlanningEditor planning={resolver.planning(undefined)} tracks={resolver.raw?.tracks ?? []} disabled={false} locale="en" onChange={vi.fn()} />);

    const enabled = screen.getByText("Enabled tracks").closest<HTMLElement>(".planning-field")!;
    const checkboxes = within(enabled).getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.map((checkbox) => [checkbox.parentElement?.textContent, checkbox.checked])).toEqual([
      ["Working", true],
      ["Target", false],
      ["Actual", true],
    ]);
    expect((screen.getByLabelText("Primary track") as HTMLSelectElement).value).toBe("working");
    expect((screen.getByLabelText("Workload track") as HTMLSelectElement).value).toBe("working");
  });

  it("requires dates for primary and dates plus effort for workload choices", () => {
    const capabilityTracks: readonly TrackDefinition[] = [
      { slug: "working", title: "Working", kind: "manual", capabilities: ["dates", "effort"] },
      { slug: "notes", title: "Notes", kind: "manual", capabilities: ["dependencies"] },
      { slug: "forecast", title: "Forecast", kind: "manual", capabilities: ["dates"] },
      { slug: "actual", title: "Actual", kind: "actual", source: "time_entries" },
    ];
    const planning = { enabled_tracks: ["working", "notes", "forecast", "actual"], primary_track: "working", workload_track: "working", dashboard_tracks: ["working", "actual"] };
    render(<ProjectPlanningEditor planning={planning} tracks={capabilityTracks} disabled={false} locale="en" onChange={vi.fn()} />);

    expect(Array.from((screen.getByLabelText("Primary track") as HTMLSelectElement).options).map((option) => option.textContent)).toEqual(["None", "Working", "Forecast"]);
    expect(Array.from((screen.getByLabelText("Workload track") as HTMLSelectElement).options).map((option) => option.textContent)).toEqual(["None", "Working"]);
  });
});
