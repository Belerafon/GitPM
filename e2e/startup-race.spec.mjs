import { createServer } from "node:http";
import { test, expect } from "@playwright/test";
import { waitForGitPmServices } from "../scripts/gitpm-readiness.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("Test server has no TCP address"));
      else resolve(address.port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("readiness gate waits for a delayed API even when the web UI is already available", async () => {
  const web = createServer((_request, response) => { response.writeHead(200); response.end("web"); });
  const api = createServer((_request, response) => { response.writeHead(200); response.end("ready"); });
  const reservation = createServer();
  const webPort = await listen(web);
  const apiPort = await listen(reservation);
  await close(reservation);
  let resolved = false;

  try {
    const readiness = waitForGitPmServices({
      serverUrl: `http://127.0.0.1:${apiPort}/health/ready`,
      webUrl: `http://127.0.0.1:${webPort}`,
      attempts: 80,
      intervalMs: 25,
    }).then((value) => { resolved = true; return value; });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(resolved).toBe(false);

    await new Promise((resolve, reject) => {
      api.once("error", reject);
      api.listen(apiPort, "127.0.0.1", resolve);
    });
    expect(await readiness).toBe(true);
  } finally {
    await close(web);
    if (api.listening) await close(api);
  }
});
