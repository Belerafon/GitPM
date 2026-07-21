import { describe, expect, it } from "vitest";
import { ENTITY_ID_PREFIX, isEntityId, newEntityId, newUniqueEntityId, resolveRepositoryMode, DEFAULT_REPOSITORY_MODE, REPOSITORY_MODES } from "./index.js";

describe("short entity IDs", () => {
  it("includes the entity type, UTC year and six Crockford Base32 characters", () => {
    expect(newEntityId(ENTITY_ID_PREFIX.project, () => 19, new Date("2026-07-14T12:00:00+03:00"))).toBe("P-26-KKKKKK");
  });

  it("validates both the common shape and the expected entity type", () => {
    expect(isEntityId("T-26-X8D2FW", ENTITY_ID_PREFIX.task)).toBe(true);
    expect(isEntityId("P-26-7K4M9Q", ENTITY_ID_PREFIX.task)).toBe(false);
    expect(isEntityId("N-26-X8D2FW", ENTITY_ID_PREFIX.comment)).toBe(true);
    expect(isEntityId("T-26-OOOOOO")).toBe(false);
  });

  it("rejects biased or out-of-range injected random values", () => {
    expect(() => newEntityId(ENTITY_ID_PREFIX.task, () => 32, new Date("2026-01-01"))).toThrow(RangeError);
  });

  it("retries when an ID already exists in the current repository state", () => {
    const values = [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2];
    const id = newUniqueEntityId(ENTITY_ID_PREFIX.task, new Set(["T-26-111111"]), () => values.shift() ?? 0, new Date("2026-01-01"));
    expect(id).toBe("T-26-222222");
  });
});

describe("repository mode resolution", () => {
  it("defaults to direct when nothing is configured", () => {
    expect(DEFAULT_REPOSITORY_MODE).toBe("direct");
    expect(resolveRepositoryMode({})).toBe("direct");
    expect(resolveRepositoryMode({ envValue: "", configValue: undefined })).toBe("direct");
  });

  it("uses the configuration file value when env is absent", () => {
    expect(resolveRepositoryMode({ configValue: "worktree" })).toBe("worktree");
    expect(resolveRepositoryMode({ configValue: "direct" })).toBe("direct");
  });

  it("environment variable takes precedence over the configuration file", () => {
    expect(resolveRepositoryMode({ configValue: "worktree", envValue: "direct" })).toBe("direct");
    expect(resolveRepositoryMode({ configValue: "direct", envValue: "worktree" })).toBe("worktree");
  });

  it("rejects unknown env values with a stable error code", () => {
    expect(() => resolveRepositoryMode({ envValue: "bare" })).toThrow(/Expected one of/u);
    expect(() => resolveRepositoryMode({ envValue: "bare" })).toThrow(expect.objectContaining({ code: "REPOSITORY_MODE_UNKNOWN" }));
  });

  it("rejects unknown config values when env is absent", () => {
    expect(() => resolveRepositoryMode({ configValue: "sidebar" })).toThrow(expect.objectContaining({ code: "REPOSITORY_MODE_UNKNOWN" }));
  });

  it("exposes the accepted modes", () => {
    expect(REPOSITORY_MODES).toEqual(["direct", "worktree"]);
  });
});
