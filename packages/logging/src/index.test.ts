import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, REDACTED_VALUE } from "./index.js";

describe("structured logger", () => {
  it("writes JSON and redacts credentials", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createLogger({ level: "info" }, destination);

    logger.info({ authorization: "Bearer secret", correlation_id: "corr-1" }, "request");

    const record = JSON.parse(output) as Record<string, unknown>;
    expect(record.authorization).toBe(REDACTED_VALUE);
    expect(record.correlation_id).toBe("corr-1");
    expect(record.message).toBe("request");
  });
});
