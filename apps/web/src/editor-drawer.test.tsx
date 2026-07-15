// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { EditorDrawer } from "./editor-drawer.js";

afterEach(cleanup);

function Harness() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Edit item</button><EditorDrawer closeLabel="Close editor" onClose={() => setOpen(false)} open={open} title="Edit item"><form className="editor-drawer-form"><label>Name<input /></label></form></EditorDrawer></>;
}

describe("EditorDrawer", () => {
  it("focuses the form, closes with Escape, and restores focus", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Edit item" });
    trigger.focus();
    fireEvent.click(trigger);

    expect(screen.getByRole("dialog", { name: "Edit item" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("");
  });
});
