// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { message, type MessageKey } from "../i18n.js";
import { ControlHints } from "./ControlHints.js";

const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message("en", key, values);

afterEach(cleanup);

describe("ControlHints", () => {
  it("shows detailed localized help for common actions on hover", () => {
    render(<><ControlHints t={t} /><button disabled>Save</button></>);

    const button = screen.getByRole("button", { name: "Save" });
    fireEvent.mouseOver(button);

    expect(screen.getByRole("tooltip").textContent).toBe("Save the changes entered in the current form.");
    expect(button.getAttribute("aria-describedby")).toBe("gitpm-control-hint");

    fireEvent.mouseOut(button, { relatedTarget: document.body });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  it("uses explicit contextual help before a button label", () => {
    render(<><ControlHints t={t} /><button data-control-hint="This deletion can be discarded before commit.">Delete</button></>);

    fireEvent.mouseOver(screen.getByRole("button", { name: "Delete" }));

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
    render(<><ControlHints t={t} /><button aria-label="Open Alpha project"><strong>Alpha</strong></button></>);

    fireEvent.mouseOver(screen.getByRole("button", { name: "Open Alpha project" }));

    expect(screen.getByRole("tooltip").textContent).toBe("Open Alpha project");
  });
});
