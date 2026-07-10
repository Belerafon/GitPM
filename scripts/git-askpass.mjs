#!/usr/bin/env node
const prompt = process.argv[2] ?? "";
if (/username/i.test(prompt)) {
  process.stdout.write("oauth2");
} else {
  const token = process.env.GITPM_ASKPASS_TOKEN;
  if (!token) {
    process.stderr.write("ASKPASS token is unavailable\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(token);
  }
}
