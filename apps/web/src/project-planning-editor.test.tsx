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
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["Working plan", "Target"]);
  });

  it("explains custom track names, data sources, and every planning role", () => {
    const namedTracks: readonly TrackDefinition[] = [
      { slug: "commitment", title: "Commitment", kind: "manual", capabilities: ["dates", "effort"] },
      { slug: "actual", title: "Actual Activity", kind: "actual", source: "time_entries" },
    ];
    render(<ProjectPlanningEditor planning={{ enabled_tracks: ["commitment", "actual"], primary_track: "commitment", workload_track: "commitment", dashboard_tracks: ["commitment", "actual"] }} tracks={namedTracks} disabled={false} locale="ru" onChange={vi.fn()} />);

    expect(screen.getByText("Что такое вариант расписания?")).toBeTruthy();
    expect(screen.getByText(/Названия вроде Commitment или Working plan задаёт администратор/u)).toBeTruthy();
    expect(screen.getByText(/Пользователи заполняют данные проекта/u)).toBeTruthy();
    expect(screen.getByText(/GitPM рассчитывает его автоматически по записям времени/u)).toBeTruthy();
    const comparisonHelp = screen.getByRole("button", { name: "Справка: Вариант расписания для сравнения" });
    expect(comparisonHelp.getAttribute("data-control-hint")).toContain("базовый план или зафиксированные обязательства");
    expect(screen.getByText("Как GitPM использует варианты расписания")).toBeTruthy();
  });

  it("disables workload tracks that lack the effort capability", () => {
    const noEffort: readonly TrackDefinition[] = [
      { slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort"] },
      { slug: "target", title: "Target", kind: "manual", capabilities: ["dates"] },
    ];
    render(<ProjectPlanningEditor planning={{ enabled_tracks: ["plan", "target"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan", "target"] }} tracks={noEffort} disabled={false} locale="en" onChange={vi.fn()} />);
    const workload = screen.getByLabelText("Workload track") as HTMLSelectElement;
    expect(Array.from(workload.options).map((option) => option.textContent)).toEqual(["Plan"]);
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
    expect(checkboxes.map((checkbox) => [checkbox.parentElement?.querySelector(".planning-track-name")?.textContent, checkbox.checked])).toEqual([
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

    expect(Array.from((screen.getByLabelText("Primary track") as HTMLSelectElement).options).map((option) => option.textContent)).toEqual(["Working", "Forecast"]);
    expect(Array.from((screen.getByLabelText("Workload track") as HTMLSelectElement).options).map((option) => option.textContent)).toEqual(["Working"]);
  });

  it("offers only enabled manual date tracks for comparison", () => {
    const capabilityTracks: readonly TrackDefinition[] = [
      { slug: "working", title: "Working", kind: "manual", capabilities: ["dates", "effort"] },
      { slug: "links", title: "Links", kind: "manual", capabilities: ["dependencies"] },
      { slug: "effort", title: "Effort", kind: "manual", capabilities: ["effort"] },
      { slug: "actual", title: "Actual", kind: "actual", source: "time_entries" },
      { slug: "disabled", title: "Disabled", kind: "manual", capabilities: ["dates"] },
    ];
    render(<ProjectPlanningEditor planning={{ enabled_tracks: ["working", "links", "effort", "actual"], primary_track: "working", workload_track: "working", dashboard_tracks: ["working", "actual"] }} tracks={capabilityTracks} disabled={false} locale="en" onChange={vi.fn()} />);

    expect(Array.from((screen.getByLabelText("Comparison track") as HTMLSelectElement).options).map((option) => option.textContent)).toEqual(["None", "Working"]);
  });

  it("blocks disabling an enabled used manual track but never blocks the actual track", () => {
    render(<ProjectPlanningEditor planning={{ enabled_tracks: ["plan", "target", "actual"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan", "target", "actual"] }} tracks={tracks} usedTracks={new Set(["target", "actual"])} disabled={false} locale="en" onChange={vi.fn()} />);
    const enabled = screen.getByText("Enabled tracks").closest<HTMLElement>(".planning-field")!;
    const target = within(enabled).getByText("Target").closest("label")!;
    const actual = within(enabled).getByText("Actual activity").closest("label")!;

    expect((target.querySelector("input") as HTMLInputElement).disabled).toBe(true);
    expect(target.textContent).toContain("This project already has schedule data in the track.");
    expect((actual.querySelector("input") as HTMLInputElement).disabled).toBe(false);
  });

  it("blocks disabling the only manual date track", () => {
    const primaryOnly: readonly TrackDefinition[] = [
      { slug: "forecast", title: "Forecast", kind: "manual", capabilities: ["dates"] },
      { slug: "links", title: "Links", kind: "manual", capabilities: ["dependencies"] },
      { slug: "actual", title: "Actual", kind: "actual", source: "time_entries" },
    ];
    render(<ProjectPlanningEditor planning={{ enabled_tracks: ["forecast", "links", "actual"], primary_track: "forecast", workload_track: "", dashboard_tracks: [] }} tracks={primaryOnly} disabled={false} locale="en" onChange={vi.fn()} />);
    const forecast = screen.getByText("Forecast", { selector: ".planning-checkboxes span" }).closest("label")!;

    expect((forecast.querySelector("input") as HTMLInputElement).disabled).toBe(true);
    expect(forecast.textContent).toContain("This track is currently the only valid choice for a required role.");
  });

  it("blocks disabling the only dates-and-effort track", () => {
    const workloadTracks: readonly TrackDefinition[] = [
      { slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort"] },
      { slug: "forecast", title: "Forecast", kind: "manual", capabilities: ["dates"] },
    ];
    render(<ProjectPlanningEditor planning={{ enabled_tracks: ["plan", "forecast"], primary_track: "forecast", workload_track: "plan", dashboard_tracks: [] }} tracks={workloadTracks} disabled={false} locale="en" onChange={vi.fn()} />);
    const plan = screen.getByText("Plan", { selector: ".planning-checkboxes span" }).closest("label")!;

    expect((plan.querySelector("input") as HTMLInputElement).disabled).toBe(true);
  });

  it("selects valid alternatives when the current primary and workload tracks are disabled", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ProjectPlanningEditor planning={{ enabled_tracks: ["plan", "target", "actual"], primary_track: "plan", workload_track: "plan", dashboard_tracks: ["plan", "target"] }} tracks={tracks} disabled={false} locale="en" onChange={onChange} />);
    const plan = screen.getByText("Working plan", { selector: ".planning-checkboxes span" }).closest("label")!;

    fireEvent.click(plan.querySelector("input") as HTMLInputElement);
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({ enabled_tracks: ["target", "actual"], primary_track: "target", workload_track: "target" });

    rerender(<ProjectPlanningEditor planning={{ enabled_tracks: ["plan", "target", "actual"], primary_track: "target", workload_track: "target", dashboard_tracks: ["plan", "target"] }} tracks={tracks} disabled={false} locale="en" onChange={onChange} />);
    const target = screen.getByText("Target", { selector: ".planning-checkboxes span" }).closest("label")!;
    fireEvent.click(target.querySelector("input") as HTMLInputElement);
    expect(onChange.mock.calls.at(-1)?.[0]).toMatchObject({ enabled_tracks: ["plan", "actual"], primary_track: "plan", workload_track: "plan" });
  });

  it("does not count dependency-only or actual tracks as planning alternatives", () => {
    const alternatives: readonly TrackDefinition[] = [
      { slug: "plan", title: "Plan", kind: "manual", capabilities: ["dates", "effort"] },
      { slug: "links", title: "Links", kind: "manual", capabilities: ["dependencies"] },
      { slug: "actual", title: "Actual", kind: "actual", source: "time_entries" },
    ];
    render(<ProjectPlanningEditor planning={{ enabled_tracks: ["plan", "links", "actual"], primary_track: "plan", workload_track: "plan", dashboard_tracks: [] }} tracks={alternatives} disabled={false} locale="en" onChange={vi.fn()} />);
    const plan = screen.getByText("Plan", { selector: ".planning-checkboxes span" }).closest("label")!;

    expect((plan.querySelector("input") as HTMLInputElement).disabled).toBe(true);
  });
});
