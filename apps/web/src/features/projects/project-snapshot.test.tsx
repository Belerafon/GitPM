// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectSnapshot } from "./project-snapshot.js";
import type { EntityDocument } from "../../types.js";

const project = (schedules: Record<string, unknown>, planning?: Record<string, unknown>): EntityDocument =>
  ({ schema: "gitpm/project@2", id: "P-26-1", name: "Demo", status: "in-progress", lifecycle: "active", ...(planning === undefined ? {} : { planning }), schedules } as EntityDocument);

afterEach(cleanup);

describe("ProjectSnapshot", () => {
  it("renders nothing without schedule finishes", () => {
    const { container } = render(<ProjectSnapshot project={project({})} locale="en" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows primary and comparison finish with the signed variance", () => {
    render(<ProjectSnapshot project={project({ plan: { finish: "2026-03-20" }, target: { finish: "2026-02-28" } }, { primary_track: "plan", comparison_track: "target" })} locale="en" />);
    expect(screen.getByText("Primary finish").parentElement?.textContent).toContain("Mar");
    expect(screen.getByText("Comparison finish")).toBeTruthy();
    expect(screen.getByText("Variance").parentElement?.textContent).toMatch(/\+20 d/);
  });
});
