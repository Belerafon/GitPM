import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isTcpPortAvailable } from "./gitpm-readiness.mjs";

const servers = new Set<net.Server>();

afterEach(async () => {
  await Promise.all([...servers].map(async (server) => await new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.clear();
});

describe("GitPM local port readiness", () => {
  it("distinguishes an occupied port from a released port", async () => {
    const server = net.createServer();
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("TCP test server did not expose a port");

    expect(await isTcpPortAvailable({ host: "127.0.0.1", port: address.port })).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.delete(server);
    expect(await isTcpPortAvailable({ host: "127.0.0.1", port: address.port })).toBe(true);
  });
});
