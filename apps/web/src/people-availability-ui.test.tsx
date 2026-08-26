// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleAvailability } from "./people-availability-ui.js";
import { message } from "./i18n.js";
import type { EntityDocument, EntityResult } from "./types.js";

const result = (document: EntityDocument): EntityResult => ({ document, path: `${document.id}.yaml`, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) });

afterEach(cleanup);

describe("People availability", () => {
  it("hides past planned absences in a past group and shows year day totals", () => {
    const events = [
      result({ schema: "gitpm/availability-event@1", id: "A-26-PAST", person: "U-1", start: "2026-01-10", finish: "2026-01-19", kind: "vacation", availability_percent: 0, state: "planned", lifecycle: "active" }),
      result({ schema: "gitpm/availability-event@1", id: "A-26-NEXT", person: "U-1", start: "2026-09-01", finish: "2026-09-05", kind: "vacation", availability_percent: 0, state: "planned", lifecycle: "active" }),
    ];
    render(<PeopleAvailability events={events} locale="en" onCreate={vi.fn(async () => true)} onUpdate={vi.fn(async () => true)} personId="U-1" readOnly={false} t={(key, values) => message("en", key, values)} today="2026-08-26" />);
    expect(screen.getByText("Used").nextElementSibling?.textContent).toBe("6 days");
    expect(screen.getByText("Remaining").nextElementSibling?.textContent).toBe("14 days");
    expect(screen.getAllByText("Planned").find((node) => node.tagName === "DT")?.nextElementSibling?.textContent).toBe("4 days");
    expect(screen.getByText("Sep 1, 2026 — Sep 5, 2026")).toBeTruthy();
    expect(screen.getByText("Past absences (1)")).toBeTruthy();
    expect(screen.getByText("Past", { exact: true })).toBeTruthy();
    expect(screen.getByText("Jan 10, 2026 — Jan 19, 2026")).toBeTruthy();
  });

  it("shows the personal vacation adjustment, its reason, and the increased balance", () => {
    render(<PeopleAvailability events={[]} extraDays={5} extraDaysReason="Overtime compensation" locale="en" onCreate={vi.fn(async () => true)} onUpdate={vi.fn(async () => true)} personId="U-1" readOnly={false} t={(key, values) => message("en", key, values)} today="2026-08-26" />);

    expect(screen.getByText("Vacation in 2026 · 25 working days (20 + 5)")).toBeTruthy();
    expect(screen.getByText("Additional days: Overtime compensation")).toBeTruthy();
    expect(screen.getByText("Remaining").nextElementSibling?.textContent).toBe("25 days");
  });
});
