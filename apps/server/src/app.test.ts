import { Writable } from "node:stream";
import { createLogger } from "@gitpm/logging";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("health endpoints", () => {
  it("returns liveness and records the same correlation ID in JSON logs", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const app = buildApp({ logger: createLogger({ level: "info" }, destination) });
    apps.push(app);

    const response = await app.inject({
      headers: { "x-correlation-id": "test-correlation-001" },
      method: "GET",
      url: "/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).toBe("test-correlation-001");
    expect(response.json()).toEqual({
      correlation_id: "test-correlation-001",
      status: "ok",
    });
    const records = output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.some((record) => record.correlation_id === "test-correlation-001")).toBe(true);
  });

  it("returns 503 when the application is not ready", async () => {
    const app = buildApp({ isReady: () => false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "not_ready" });
  });

  it("replaces an unsafe incoming correlation ID", async () => {
    const app = buildApp();
    apps.push(app);

    const response = await app.inject({
      headers: { "x-correlation-id": "unsafe value\n" },
      method: "GET",
      url: "/health/live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).not.toBe("unsafe value\n");
  });
});
