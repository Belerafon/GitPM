// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitPmApi } from "./api.js";
import type { DraftStatus, EntityDocument, EntityResult } from "./types.js";
import { VacationCalendarWorkspace } from "./vacation-calendar-ui.js";
import { VACATION_CALENDAR_DAY_WIDTH } from "./vacation-calendar-model.js";

const adaId = "U-26-222222";
const linusId = "U-26-333333";
const draft: DraftStatus = { draft_id: "DRF-VACATION", owner_gitlab_user_id: "42", branch: "gitpm/42/DRF-VACATION", base_commit: "a".repeat(40), writer_mode: "ui", state: "open", fingerprint: "b".repeat(64), created_at: "2026-08-26T00:00:00.000Z", updated_at: "2026-08-26T00:00:00.000Z" };
const result = (document: EntityDocument): EntityResult => ({ document, path: `${document.id}.yaml`, blob_id: "c".repeat(40), draft_fingerprint: "d".repeat(64) });
const ada = result({ schema: "gitpm/person@1", id: adaId, name: "Ada", weekly_capacity_hours: 40, calendar: "C-26-444444", lifecycle: "active" });
const linus = result({ schema: "gitpm/person@1", id: linusId, name: "Linus", weekly_capacity_hours: 32, calendar: "C-26-444444", lifecycle: "active" });
const reviewers = result({ schema: "gitpm/team@1", id: "G-26-555555", name: "Reviewers", members: [linusId], lifecycle: "active" });
const vacation = result({ schema: "gitpm/availability-event@1", id: "A-26-VACATN", person: adaId, start: "2026-08-17", finish: "2026-08-21", kind: "vacation", availability_percent: 0, state: "planned", note_markdown: "Summer leave", lifecycle: "active" });
const sick = result({ schema: "gitpm/availability-event@1", id: "A-26-SICK", person: linusId, start: "2026-09-10", finish: "2026-09-12", kind: "sick-leave", availability_percent: 0, state: "taken", lifecycle: "active" });
const later = result({ schema: "gitpm/availability-event@1", id: "A-26-JULY", person: adaId, start: "2027-07-01", finish: "2027-07-05", kind: "training", availability_percent: 0, state: "planned", lifecycle: "active" });
const cancelled = result({ schema: "gitpm/availability-event@1", id: "A-26-CANCEL", person: adaId, start: "2026-10-01", finish: "2026-10-02", kind: "day-off", availability_percent: 0, state: "cancelled", lifecycle: "active" });

afterEach(cleanup);

function renderCalendar() {
  const entities = [ada, linus, reviewers, vacation, sick, later, cancelled];
  const onNavigate = vi.fn();
  const api = {
    listEntities: vi.fn(async (_draftId: string, type: string) => entities.filter((item) => ({ people: "gitpm/person@1", teams: "gitpm/team@1", "availability-events": "gitpm/availability-event@1" })[type] === item.document.schema)),
  } as unknown as GitPmApi;
  const view = render(<VacationCalendarWorkspace api={api} draft={draft} locale="en" onNavigate={onNavigate} today="2026-08-26" />);
  return { ...view, onNavigate };
}

describe("Vacation calendar UI", () => {
  it("renders the 6-month timeline, summary, and bar geometry, then scales to 12 months", async () => {
    const { container } = renderCalendar();
    await waitFor(() => expect(container.querySelectorAll(".vacation-calendar-bar")).toHaveLength(2));
    const chart = container.querySelector(".vacation-calendar-scroll")!;
    expect(chart.getAttribute("data-start")).toBe("2026-08-01");
    expect(chart.getAttribute("data-finish")).toBe("2027-01-31");
    expect(chart.getAttribute("data-months")).toBe("6");
    expect(screen.getByText("Absent today").nextElementSibling?.textContent).toBe("0");
    expect(screen.getByText("Leaving in 30 days").nextElementSibling?.textContent).toBe("1");
    expect(screen.getByText("Peak simultaneous absence").nextElementSibling?.textContent).toBe("1");
    const adaBar = container.querySelector(`[data-event-id="A-26-VACATN"]`) as HTMLElement;
    expect(adaBar.getAttribute("data-offset")).toBe("16");
    expect(adaBar.getAttribute("data-duration")).toBe("5");
    expect(adaBar.style.left).toBe(`${16 * VACATION_CALENDAR_DAY_WIDTH[6]}px`);
    expect(adaBar.style.width).toBe(`${5 * VACATION_CALENDAR_DAY_WIDTH[6]}px`);
    expect(adaBar.getAttribute("title")).toContain("Summer leave");
    expect(container.querySelector(`.vacation-calendar-label[data-person-id="${adaId}"]`)?.className).not.toContain("away");
    expect(container.querySelector(".vacation-calendar-label small")?.textContent).toContain("Taken");
    expect(screen.getByRole("button", { name: "Ada" }).getAttribute("title")).toContain("Available today");
    fireEvent.click(screen.getByRole("button", { name: "12 months" }));
    await waitFor(() => expect(container.querySelector(".vacation-calendar-scroll")?.getAttribute("data-months")).toBe("12"));
    expect(container.querySelectorAll(".vacation-calendar-bar")).toHaveLength(3);
    const julyBar = container.querySelector(`[data-event-id="A-26-JULY"]`) as HTMLElement;
    expect(julyBar.getAttribute("data-duration")).toBe("5");
    expect(julyBar.style.width).toBe(`${5 * VACATION_CALENDAR_DAY_WIDTH[12]}px`);
    expect(container.querySelector(`[data-event-id="A-26-VACATN"]`)?.getAttribute("style")).toContain(`${16 * VACATION_CALENDAR_DAY_WIDTH[12]}px`);
  });

  it("filters by team, person, kind, state and name, then resets", async () => {
    const { container, onNavigate } = renderCalendar();
    await waitFor(() => expect(container.querySelectorAll(".vacation-calendar-label")).toHaveLength(2));
    fireEvent.change(screen.getByLabelText("Team"), { target: { value: reviewers.document.id } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Linus" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Ada" })).toBeNull();
    expect(container.querySelector(`[data-event-id="A-26-SICK"]`)).not.toBeNull();
    expect(container.querySelector(`[data-event-id="A-26-VACATN"]`)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() => expect(container.querySelectorAll(".vacation-calendar-label")).toHaveLength(2));
    fireEvent.change(screen.getByLabelText("Person"), { target: { value: adaId } });
    expect(screen.queryByRole("button", { name: "Linus" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "sick-leave" } });
    expect(container.querySelector(`[data-event-id="A-26-SICK"]`)).not.toBeNull();
    expect(container.querySelector(`[data-event-id="A-26-VACATN"]`)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    fireEvent.change(screen.getByLabelText("State"), { target: { value: "cancelled" } });
    expect(container.querySelector(`[data-event-id="A-26-CANCEL"]`)).not.toBeNull();
    expect(container.querySelector(`[data-event-id="A-26-VACATN"]`)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    fireEvent.change(screen.getByLabelText("Search by name"), { target: { value: "lin" } });
    expect(screen.getByRole("button", { name: "Linus" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ada" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Linus" }));
    expect(onNavigate).toHaveBeenCalledWith("people", { personId: linusId });
  });

  it("paints a person red while they are away and shows leave-until in the hint", async () => {
    const current = result({ schema: "gitpm/availability-event@1", id: "A-26-NOW", person: adaId, start: "2026-08-25", finish: "2026-08-28", kind: "vacation", availability_percent: 0, state: "planned", lifecycle: "active" });
    const entities = [ada, linus, reviewers, current];
    const api = {
      listEntities: vi.fn(async (_draftId: string, type: string) => entities.filter((item) => ({ people: "gitpm/person@1", teams: "gitpm/team@1", "availability-events": "gitpm/availability-event@1" })[type] === item.document.schema)),
    } as unknown as GitPmApi;
    const { container } = render(<VacationCalendarWorkspace api={api} draft={draft} locale="en" today="2026-08-26" />);
    await waitFor(() => expect(container.querySelector(".vacation-calendar-label.away")).not.toBeNull());
    expect(container.querySelector(`.vacation-calendar-label[data-person-id="${adaId}"]`)?.className).toContain("away");
    expect(container.querySelector(`.vacation-calendar-row.away[data-person-id="${adaId}"]`)).not.toBeNull();
    expect(screen.getByRole("button", { name: "Ada" }).getAttribute("title")).toContain("Vacation until");
  });
});
