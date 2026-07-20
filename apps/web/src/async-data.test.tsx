// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAsyncLoad } from "./async-data.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
  return { promise, resolve, reject };
}

describe("useAsyncLoad", () => {
  it("keeps loading distinct from ready and ignores stale responses", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const applied: string[] = [];
    const { result } = renderHook(() => useAsyncLoad());

    let firstRun!: Promise<string | undefined>;
    let secondRun!: Promise<string | undefined>;
    act(() => {
      firstRun = result.current.run(() => first.promise, (value) => applied.push(value));
      secondRun = result.current.run(() => second.promise, (value) => applied.push(value));
    });
    expect(result.current.state.status).toBe("loading");

    await act(async () => { second.resolve("new"); await secondRun; });
    expect(result.current.state.status).toBe("ready");
    expect(applied).toEqual(["new"]);

    await act(async () => { first.resolve("old"); await firstRun; });
    expect(applied).toEqual(["new"]);
  });

  it("keeps ready data visible while a later request is in flight or fails", async () => {
    const refresh = deferred<string>();
    const applied: string[] = [];
    const { result } = renderHook(() => useAsyncLoad());

    await act(async () => { await result.current.run(async () => "current", (value) => applied.push(value)); });
    expect(result.current.state.status).toBe("ready");

    let refreshRun!: Promise<string | undefined>;
    act(() => { refreshRun = result.current.run(() => refresh.promise, (value) => applied.push(value)); });
    expect(result.current.state.status).toBe("ready");

    await act(async () => { refresh.reject(new Error("offline")); await refreshRun; });
    expect(result.current.state).toEqual({ status: "ready", refreshError: "offline" });
    expect(applied).toEqual(["current"]);
  });
});
