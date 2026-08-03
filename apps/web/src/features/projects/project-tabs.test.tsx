// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectTabs } from "./project-tabs.js";
import { message, type Locale, type MessageKey } from "../../i18n.js";
import type { WorkspaceNavigate } from "../../workspace-navigation.js";

const t = (key: MessageKey) => message("en" as Locale, key);
const onNavigate = vi.fn() as unknown as WorkspaceNavigate;

afterEach(cleanup);

describe("ProjectTabs", () => {
  it("renders the overview, board, gantt and effort destinations in order with the effort label", () => {
    render(<ProjectTabs active="effort" onNavigate={onNavigate} projectId="P-1" t={t} />);
    const tabs = Array.from(screen.getAllByRole("button"), (button) => button.textContent);
    expect(tabs).toEqual(["Plan", "Board", "Gantt", "Effort"]);
    expect(screen.getByRole("button", { name: "Effort" }).getAttribute("aria-current")).toBe("page");
  });
});
