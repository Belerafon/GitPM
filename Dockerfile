FROM node:20.19.2-bookworm-slim

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates git \
    && git config --system --add safe.directory /repository \
    && git config --system --add safe.directory /data/repository \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

# Capture the build version from Git into build-version.json. This is mandatory:
# the step fails if .git is absent, so the version is never silently faked.
# .git is removed right away so it never ships in the final image.
RUN node scripts/generate-build-version.mjs && rm -rf .git

RUN corepack enable \
    && corepack pnpm install --frozen-lockfile \
    && corepack pnpm build \
    && ln -sf /app/apps/cli/dist/index.js /usr/local/bin/gitpm

ENV GITPM_RUNTIME_MODE=production \
    GITPM_BIND_HOST=0.0.0.0 \
    GITPM_NO_BROWSER=1

EXPOSE 3000 5173

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "Promise.all([fetch('http://127.0.0.1:3000/health/ready'),fetch('http://127.0.0.1:5173/')]).then(r=>{if(r.some(x=>!x.ok))process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "scripts/run-gitpm-local.mjs"]
