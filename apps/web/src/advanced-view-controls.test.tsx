// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AdvancedViewControls } from "./advanced-view-controls.js";
import { applyAdvancedViewQuery, defaultLifecycleViewQuery, emptyViewQuery, type AdvancedViewQuery, type ViewField } from "./advanced-view-query.js";
import { message } from "./i18n.js";

const items = [{ name: "Alpha", due: "2026-03-01" }, { name: "Beta", due: "2026-01-01" }];
const fields: readonly ViewField<(typeof items)[number]>[] = [
  { id: "name", label: "Name", type: "text", read: (row) => row.name },
  { id: "due", label: "Due", type: "date", read: (row) => row.due },
];

function Harness({ allowSorting = true }: { readonly allowSorting?: boolean } = {}) {
  const [query, setQuery] = useState<AdvancedViewQuery>(() => emptyViewQuery());
  const result = applyAdvancedViewQuery(items, fields, query, "en");
  return <><AdvancedViewControls allowSorting={allowSorting} fields={fields} locale="en" onChange={setQuery} query={query} resultCount={result.length} t={(key, values) => message("en", key, values)} totalCount={items.length} /><output>{result.map((row) => row.name).join(",")}</output></>;
}

function LifecycleHarness() {
  const lifecycleFields: readonly ViewField<{ lifecycle: string }>[] = [{
    id: "lifecycle",
    label: message("ru", "advancedView.field.lifecycle"),
    type: "select",
    options: [{ value: "active", label: "Активные" }, { value: "archived", label: "Архивные" }],
    read: (row) => row.lifecycle,
  }];
  const [query, setQuery] = useState<AdvancedViewQuery>(() => defaultLifecycleViewQuery());
  return <AdvancedViewControls allowSorting={false} fields={lifecycleFields} locale="ru" onChange={setQuery} query={query} resultCount={1} t={(key, values) => message("ru", key, values)} totalCount={2} />;
}

afterEach(cleanup);

describe("AdvancedViewControls", () => {
  it("keeps the page compact, edits in a drawer, and exposes removable applied chips", () => {
    render(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Filters and sorting" }));
    const dialog = screen.getByRole("dialog", { name: "Filters and sorting" });
    fireEvent.click(within(dialog).getByText("Custom filters and sorting"));
    fireEvent.click(within(dialog).getByRole("button", { name: /Add condition/u }));
    fireEvent.change(within(dialog).getByLabelText("Value"), { target: { value: "Beta" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Add sorting/u }));
    fireEvent.change(within(dialog).getByLabelText("Sorting field 1"), { target: { value: "due" } });
    expect(screen.getByText("Alpha,Beta")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(document.querySelector("output")?.textContent).toBe("Beta");
    const filterChip = document.querySelector<HTMLElement>(".filter-chip")!;
    expect(within(filterChip).getByText("Name").classList.contains("filter-chip-field")).toBe(true);
    expect(within(filterChip).getByText("contains").classList.contains("filter-chip-operator")).toBe(true);
    expect(within(filterChip).getByText("Beta").classList.contains("filter-chip-value")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Remove filter/u }));
    expect(screen.getByText("Beta,Alpha")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByText("Alpha,Beta")).toBeTruthy();
  });

  it("offers popular one-click presets before the advanced editor", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Filters and sorting" }));
    const dialog = screen.getByRole("dialog", { name: "Filters and sorting" });
    const presets = within(dialog).getByRole("group", { name: "Quick presets" });

    expect(within(presets).getByRole("button", { name: "Name: A–Z" })).toBeTruthy();
    expect(within(presets).getByRole("button", { name: "Name: Z–A" })).toBeTruthy();
    fireEvent.click(within(presets).getByRole("button", { name: "Due: earliest first" }));

    expect(screen.queryByRole("dialog", { name: "Filters and sorting" })).toBeNull();
    expect(screen.getByText("Beta,Alpha")).toBeTruthy();
  });

  it("exposes a filter-only variant without sorting controls", () => {
    render(<Harness allowSorting={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const dialog = screen.getByRole("dialog", { name: "Filters" });

    expect(within(dialog).getByText("Custom filters").closest("details")?.open).toBe(true);
    expect(within(dialog).queryByRole("heading", { name: "Sorting" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Add sorting/u })).toBeNull();
    expect(within(dialog).getByRole("heading", { level: 3, name: "Filters" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Without a finish date" })).toBeTruthy();
  });

  it("describes the default lifecycle filter by its visible effect", () => {
    render(<LifecycleHarness />);

    const label = screen.getByText("Архивные скрыты");
    expect(label.classList.contains("filter-chip-semantic")).toBe(true);
    expect(screen.queryByText(/Жизненный цикл/u)).toBeNull();
    expect(screen.getByRole("button", { name: "Удалить фильтр: Архивные скрыты" })).toBeTruthy();
  });
});
