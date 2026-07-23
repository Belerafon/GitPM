// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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

afterEach(() => { cleanup(); vi.resetModules(); });

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
