import { buildApp } from "./app.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const app = buildApp();

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, "server stopping");
  await app.close();
  process.exitCode = 0;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await app.listen({ host, port });
} catch (error) {
  app.log.fatal({ err: error }, "server failed to start");
  process.exitCode = 1;
}
