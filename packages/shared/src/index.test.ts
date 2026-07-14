import { describe, expect, it } from "vitest";
import { ENTITY_ID_PREFIX, isEntityId, newEntityId, newUniqueEntityId } from "./index.js";

describe("short entity IDs", () => {
  it("includes the entity type, UTC year and six Crockford Base32 characters", () => {
    expect(newEntityId(ENTITY_ID_PREFIX.project, () => 19, new Date("2026-07-14T12:00:00+03:00"))).toBe("P-26-KKKKKK");
  });

  it("validates both the common shape and the expected entity type", () => {
    expect(isEntityId("T-26-X8D2FW", ENTITY_ID_PREFIX.task)).toBe(true);
    expect(isEntityId("P-26-7K4M9Q", ENTITY_ID_PREFIX.task)).toBe(false);
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
