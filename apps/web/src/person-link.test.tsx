// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersonLink } from "./person-link.js";

afterEach(cleanup);

describe("person links", () => {
  it("opens the person profile without triggering the surrounding card", () => {
    const openCard = vi.fn(); const openPerson = vi.fn();
    render(<button onClick={openCard}><PersonLink name="Ada" onOpen={openPerson} personId="U-26-ADA" /></button>);
    fireEvent.click(screen.getByRole("link", { name: "Ada" }));
    expect(openPerson).toHaveBeenCalledWith("U-26-ADA");
    expect(openCard).not.toHaveBeenCalled();
  });

  it("supports keyboard navigation", () => {
    const openPerson = vi.fn();
    render(<PersonLink name="Ada" onOpen={openPerson} personId="U-26-ADA" />);
    fireEvent.keyDown(screen.getByRole("link", { name: "Ada" }), { key: "Enter" });
    expect(openPerson).toHaveBeenCalledWith("U-26-ADA");
  });
});
