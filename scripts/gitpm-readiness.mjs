import http from "node:http";
import net from "node:net";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isHttpReady(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300);
    });
    request.setTimeout(500, () => request.destroy());
    request.once("error", () => resolve(false));
  });
}

export function isTcpPortAvailable({ host, port }) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    const finish = (available) => {
      probe.removeAllListeners();
      resolve(available);
    };
    probe.unref();
    probe.once("error", () => finish(false));
    probe.listen({ host, port, exclusive: true }, () => {
      probe.close((error) => finish(error === undefined));
    });
  });
}

export async function waitForGitPmServices({
  serverUrl,
  webUrl,
  attempts = 240,
  intervalMs = 250,
  isCancelled = () => false,
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (isCancelled()) return false;
    const [serverReady, webReady] = await Promise.all([isHttpReady(serverUrl), isHttpReady(webUrl)]);
    if (serverReady && webReady) return true;
    if (attempt + 1 < attempts) await delay(intervalMs);
  }
  return false;
}
