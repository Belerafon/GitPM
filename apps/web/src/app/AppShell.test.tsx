// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell.js";
import { navigationGroups } from "./navigation.js";
import { message, type Locale, type MessageKey } from "../i18n.js";

const t = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => message("en" as Locale, key, values);

function renderShell() {
  return render(<AppShell
    activeView="nav.projects"
    headerMeta={<span>meta</span>}
    headerTitle="Projects"
    locale="en"
    navigationGroups={navigationGroups}
    onNavigate={() => undefined}
    repositoryMode={false}
    t={t}
    topActions={null}
  >content</AppShell>);
}

afterEach(() => { cleanup(); vi.resetModules(); });

describe("AppShell version footer", () => {
  it("shows the build version at the sidebar bottom", async () => {
    vi.resetModules();
    vi.doMock("../version.js", () => ({
      BUILD_VERSION: "0.1.0+20260723.1045.eb7f057",
      BUILD_COMMIT: "eb7f057",
      BUILD_COMMIT_DATE: "2026-07-23T13:45:19+03:00",
    }));
    const { AppShell: Shell } = await import("./AppShell.js");
    render(<Shell
      activeView="nav.projects"
      headerMeta={<span>meta</span>}
      headerTitle="Projects"
      locale="en"
      navigationGroups={navigationGroups}
      onNavigate={() => undefined}
      repositoryMode={false}
      t={t}
      topActions={null}
    >content</Shell>);
    const footer = screen.getByTestId("sidebar-version");
    expect(footer.textContent).toContain("0.1.0+20260723.1045.eb7f057");
    expect(footer.textContent).toContain("eb7f057");
  });

  it("falls back to a dev tag and hides the commit line when build metadata is absent", () => {
    renderShell();
    const footer = screen.getByTestId("sidebar-version");
    expect(footer.textContent).toContain("Version dev");
    // No commit date means no build-info line.
    expect(footer.textContent).not.toContain("Built");
  });
});
