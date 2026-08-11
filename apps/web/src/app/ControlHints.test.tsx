// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { message, type MessageKey } from "../i18n.js";
import { ControlHints } from "./ControlHints.js";

const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message("en", key, values);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function revealHover(target: HTMLElement) {
  fireEvent.mouseOver(target);
  act(() => vi.advanceTimersByTime(1_000));
}

describe("ControlHints", () => {
  it("shows detailed localized help for common actions on hover", () => {
    render(<><ControlHints t={t} /><button disabled>Save</button></>);

    const button = screen.getByRole("button", { name: "Save" });
    fireEvent.mouseOver(button);
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => vi.advanceTimersByTime(999));
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => vi.advanceTimersByTime(1));

    expect(screen.getByRole("tooltip").textContent).toBe("Save the changes entered in the current form.");
    expect(button.getAttribute("aria-describedby")).toBe("gitpm-control-hint");

    fireEvent.mouseOut(button, { relatedTarget: document.body });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  it("uses explicit contextual help before a button label", () => {
    render(<><ControlHints t={t} /><button data-control-hint="This deletion can be discarded before commit.">Delete</button></>);

    revealHover(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByRole("tooltip").textContent).toBe("This deletion can be discarded before commit.");
  });

  it("supports keyboard focus and preserves existing native titles", () => {
    render(<><ControlHints t={t} /><button aria-label="Move milestone up" title="Move milestone up">↑</button></>);
    const button = screen.getByRole("button", { name: "Move milestone up" });

    fireEvent.focusIn(button);
    expect(screen.getByRole("tooltip").textContent).toBe("Move milestone up");
    expect(button.hasAttribute("title")).toBe(false);

    fireEvent.focusOut(button, { relatedTarget: document.body });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button.getAttribute("title")).toBe("Move milestone up");
  });

  it("falls back to the accessible name for controls without dedicated help", () => {
    render(<><ControlHints t={t} /><button aria-label="Move up">↑</button></>);

    revealHover(screen.getByRole("button", { name: "Move up" }));

    expect(screen.getByRole("tooltip").textContent).toBe("Move up");
  });

  it("does not repeat visible control text as a tooltip", () => {
    render(<><ControlHints t={t} /><button aria-label="Filters and sorting">Filters and sorting</button></>);

    revealHover(screen.getByRole("button", { name: "Filters and sorting" }));

    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows localized mechanics for a labeled field on hover and keyboard focus", () => {
    render(<><ControlHints t={t} /><label>Hours<input type="number" /></label></>);
    const input = screen.getByRole("spinbutton", { name: "Hours" });

    fireEvent.focusIn(input);

    expect(screen.getByRole("tooltip").textContent).toContain("0.25-hour increments");
    expect(input.getAttribute("aria-describedby")).toBe("gitpm-control-hint");
  });

  it("supports labels associated by htmlFor and standalone aria-label fields", () => {
    render(<><ControlHints t={t} /><label htmlFor="draft">{t("drafts.id")}</label><input id="draft" /><input aria-label={t("search.label")} /></>);

    revealHover(screen.getByLabelText(t("drafts.id")));
    expect(screen.getByRole("tooltip").textContent).toContain("1–128 ASCII letters");
    fireEvent.mouseOut(screen.getByLabelText(t("drafts.id")), { relatedTarget: document.body });

    fireEvent.focusIn(screen.getByLabelText(t("search.label")));
    expect(screen.getByRole("tooltip").textContent).toContain("Archived entities are included");
  });

  it("explains how selecting a parent changes the task hierarchy", () => {
    render(<><ControlHints t={t} /><label>{t("taskHierarchy.parent")}<select><option>{t("taskHierarchy.noParent")}</option></select></label></>);

    fireEvent.focusIn(screen.getByRole("combobox", { name: t("taskHierarchy.parent") }));

    expect(screen.getByRole("tooltip").textContent).toContain("make the current task its subtask");
    expect(screen.getByRole("tooltip").textContent).toContain("adopts that parent's milestone");
  });

  it("uses explicit help for calculated read-only fields", () => {
    render(<><ControlHints t={t} /><dt data-field-hint="Earliest active work date" tabIndex={0}>First activity</dt></>);

    fireEvent.focusIn(screen.getByText("First activity"));

    expect(screen.getByRole("tooltip").textContent).toBe("Earliest active work date");
  });

  it("explains reusable entity links instead of repeating their visible name", () => {
    render(<><ControlHints t={t} /><span className="person-link" role="link" tabIndex={0}>Alex</span></>);

    fireEvent.focusIn(screen.getByRole("link", { name: "Alex" }));

    expect(screen.getByRole("tooltip").textContent).toContain("profile with assignments");
    expect(screen.getByRole("tooltip").textContent).toContain("does not change data");
  });

  it("inherits contextual help from a fieldset legend for dynamic options", () => {
    render(<><ControlHints t={t} /><fieldset><legend data-field-hint="Filters the profile without changing tasks">Status</legend><label><input type="checkbox" />In progress</label></fieldset></>);

    fireEvent.focusIn(screen.getByRole("checkbox", { name: "In progress" }));

    expect(screen.getByRole("tooltip").textContent).toBe("Filters the profile without changing tasks");
  });

  it("cancels a pending hover hint when the pointer leaves", () => {
    render(<><ControlHints t={t} /><button>Save</button></>);
    const button = screen.getByRole("button", { name: "Save" });

    fireEvent.mouseOver(button);
    act(() => vi.advanceTimersByTime(500));
    fireEvent.mouseOut(button, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(1_000));

    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("positions a short edge hint near its control and keeps the arrow pointed at it", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(480);
    render(<><ControlHints t={t} /><button aria-label="Move up">↑</button></>);
    const button = screen.getByRole("button", { name: "Move up" });
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      bottom: 140, height: 40, left: 430, right: 470, top: 100, width: 40, x: 430, y: 100, toJSON: () => ({}),
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("control-hint")) {
        return { bottom: 100, height: 36, left: 0, right: 120, top: 64, width: 120, x: 0, y: 64, toJSON: () => ({}) };
      }
      return { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) };
    });

    fireEvent.focusIn(button);

    const hint = screen.getByRole("tooltip");
    expect(hint.style.left).toBe("404px");
    expect(hint.querySelector<HTMLElement>(".control-hint-arrow")?.style.left).toBe("106px");
  });
});
