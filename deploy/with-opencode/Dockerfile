# syntax=docker/dockerfile:1
#
# GitPM + OpenCode combined image (server deployment profile).
#
# The build context MUST be the repository root: it contains .git, which is
# required to capture the build version at image build time. .git is removed
# immediately after the capture and never reaches the final image. See
# docs/Deployment.md for the full procedure.
#
#   docker compose -f deploy/with-opencode/compose.yaml up -d --build

FROM ghcr.io/anomalyco/opencode:1.17.15 AS opencode

FROM node:20.19.2-alpine

RUN apk add --no-cache \
    bash \
    ca-certificates \
    caddy \
    coreutils \
    curl \
    fd \
    findutils \
    gawk \
    git \
    grep \
    jq \
    less \
    nano \
    openssh-client \
    openssl \
    procps \
    ripgrep \
    sed \
    sqlite \
    tar \
    tree \
    tini \
    tzdata \
    util-linux \
    vim \
    wget \
 && git config --system --add safe.directory /repository \
 && git config --system --add safe.directory /data/repository \
 && ln -sf /bin/true /usr/local/bin/xdg-open \
 && ln -sf /bin/true /usr/bin/xdg-open

COPY --from=opencode /usr/local/bin/opencode /usr/local/bin/opencode

WORKDIR /app
COPY . .

# Capture the build version from Git into build-version.json (mandatory: the
# step fails if .git is absent, so the version is never silently faked), then
# drop .git so it never ships in the final image.
RUN node scripts/generate-build-version.mjs && rm -rf .git

RUN corepack enable \
 && corepack pnpm install --frozen-lockfile \
 && corepack pnpm build \
 && ln -sf /app/apps/cli/dist/index.js /usr/local/bin/gitpm

ENV GITPM_RUNTIME_MODE=production \
    GITPM_BIND_HOST=0.0.0.0 \
    GITPM_NO_BROWSER=1

COPY deploy/with-opencode/gitpm-entrypoint.sh /usr/local/bin/gitpm-entrypoint.sh
RUN chmod +x /usr/local/bin/gitpm-entrypoint.sh

EXPOSE 80 4096

ENTRYPOINT ["/sbin/tini","--"]
CMD ["/usr/local/bin/gitpm-entrypoint.sh"]
