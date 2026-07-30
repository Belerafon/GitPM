// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell.js";
import { navigationGroups } from "./navigation.js";
import { message, type Locale, type MessageKey } from "../i18n.js";

const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message("en" as Locale, key, values);

function shellProps() {
  return {
    activeView: "nav.projects" as const,
    headerMeta: <span>meta</span>,
    headerTitle: "Projects",
    navigationGroups,
    onNavigate: () => undefined,
    repositoryMode: false,
    t,
    topActions: null,
    children: "content",
  };
}

afterEach(() => { cleanup(); localStorage.clear(); vi.resetModules(); });

describe("AppShell version footer", () => {
  it("shows the build version at the sidebar bottom", async () => {
    vi.resetModules();
    vi.doMock("../version.js", () => ({ BUILD_VERSION: "2026.07.23 1045" }));
    const { AppShell: Shell } = await import("./AppShell.js");
    render(<Shell {...shellProps()} />);
    const footer = screen.getByTestId("sidebar-version");
    expect(footer.textContent).toContain("2026.07.23 1045");
  });

  it("shows an unavailable marker when no version was captured", () => {
    render(<AppShell {...shellProps()} />);
    const footer = screen.getByTestId("sidebar-version");
    expect(footer.textContent).toContain("Version —");
  });
});

describe("AppShell collapsible navigation", () => {
  it("renders navigation icons and collapses to icon-only mode, persisting the choice", () => {
    render(<AppShell {...shellProps()} />);
    const shell = document.querySelector(".app-shell")!;
    expect(document.querySelectorAll(".nav-icon").length).toBe(navigationGroups.flatMap((group) => group.items).length);
    expect(shell.classList.contains("sidebar-collapsed")).toBe(false);
    expect(screen.getByRole("button", { name: "Collapse navigation" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));

    expect(shell.classList.contains("sidebar-collapsed")).toBe(true);
    expect(localStorage.getItem("gitpm.navigation.sidebarCollapsed")).toBe("true");
    expect(screen.getByRole("button", { name: "Expand navigation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Projects" }).getAttribute("title")).toBe("Projects");

    fireEvent.click(screen.getByRole("button", { name: "Expand navigation" }));
    expect(shell.classList.contains("sidebar-collapsed")).toBe(false);
    expect(localStorage.getItem("gitpm.navigation.sidebarCollapsed")).toBe("false");
  });

  it("restores the collapsed state from storage on mount", () => {
    localStorage.setItem("gitpm.navigation.sidebarCollapsed", "true");
    render(<AppShell {...shellProps()} />);
    expect(document.querySelector(".app-shell")!.classList.contains("sidebar-collapsed")).toBe(true);
    expect(screen.getByRole("button", { name: "Expand navigation" })).toBeTruthy();
  });
});
