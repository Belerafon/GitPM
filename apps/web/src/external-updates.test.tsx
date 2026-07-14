// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changedEntityFields, useExternalHighlights } from "./external-updates.js";
import type { EntityResult, GitPmDocument } from "./types.js";

const entity = (document: GitPmDocument): EntityResult => ({ document, path: `${document.id}.yaml`, blob_id: "a".repeat(40), draft_fingerprint: "b".repeat(64) });
const before = entity({ schema: "gitpm/task@1", id: "T-26-111111", lifecycle: "active", title: "Before", status: "backlog" });
afterEach(() => vi.useRealTimers());

describe("external update reconciliation", () => {
  it("returns only changed fields and collapsed entity indicators", () => {
    const after = entity({ ...before.document, title: "After", status: "done" });
    expect(changedEntityFields([before], [after])).toEqual({ "T-26-111111": ["status", "title"] });
    expect(changedEntityFields([before], [])).toEqual({ "T-26-111111": ["$entity"] });
    expect(changedEntityFields([], [after])).toEqual({});
  });

  it("coalesces consecutive writes and expires one stable indication", () => {
    vi.useFakeTimers(); const { result } = renderHook(() => useExternalHighlights(1000));
    act(() => result.current.mark({ "T-26-111111": ["title"] }));
    act(() => { vi.advanceTimersByTime(700); result.current.mark({ "T-26-111111": ["status"] }); });
    expect(result.current.highlights).toEqual({ "T-26-111111": ["status", "title"] });
    act(() => vi.advanceTimersByTime(700)); expect(result.current.highlights).toEqual({ "T-26-111111": ["status", "title"] });
    act(() => vi.advanceTimersByTime(301)); expect(result.current.highlights).toEqual({});
  });
});
