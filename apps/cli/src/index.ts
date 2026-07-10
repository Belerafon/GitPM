#!/usr/bin/env node
import { run } from "./command.js";

const result = await run(process.argv.slice(2));
process.stdout.write(`${result.output}\n`);
process.exitCode = result.exitCode;
