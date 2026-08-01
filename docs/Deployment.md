# Deployment

This document is the canonical reference for building and running GitPM,
including the version-stamp mechanism and the data-safety model. The deployment
files live in the repository, so the procedure below is reproducible from a
clean clone.

## Profiles

| Profile | Files | Use case |
| --- | --- | --- |
| Plain | `Dockerfile`, `compose.yaml`, `compose.server.yaml` | GitPM only (API + web on `3000`/`5173`). |
| With OpenCode | `deploy/with-opencode/` (`Dockerfile`, `compose.yaml`, `gitpm-entrypoint.sh`) | GitPM bundled with the OpenCode web UI behind Caddy basic-auth (LAN server). |

Both profiles share the same version mechanism and the same data-safety rules.

## Prerequisites

* The build context **must be the repository root and must contain `.git`**.
  `.git` is intentionally not excluded by `.dockerignore` because the version
  stamp is captured from it during the image build (see below). A deploy without
  `.git` (for example a tarball export) fails the build rather than silently
  shipping a fake version.
* Docker Engine with BuildKit, and Docker Compose v2.
* Node.js 20.19.2 and pnpm 10.12.1 are only required for local non-container
  development; the image builds do not need Node on the host.

## Version stamp

There is exactly **one source of truth**: a generated `build-version.json` at the
repository root. The flow is:

1. **Capture (build time only).** During the image build, after the source is
   copied, the Dockerfile runs `node scripts/generate-build-version.mjs`. That
   script reads the current commit's author date from `.git` and writes
   `build-version.json` (for example `2026.07.23 1045`). The step is mandatory:
   if `.git` is missing it exits non-zero and the build fails. `.git` is deleted
   in the same layer, so it never reaches the final image.
2. **Consume (build time only).** `apps/web/vite.config.ts` reads
   `build-version.json` via `readBuildVersion()` and inlines the value into the
   web bundle as `__GITPM_BUILD_VERSION__`. The build never calls Git directly.
3. **Display (runtime).** `apps/web/src/version.ts` exports `BUILD_VERSION`,
   shown in the sidebar footer as `Версия <stamp>`.

Consequences of this design:

* The running application **never reads Git for the version** and **never reads
  environment variables** for it. No fallbacks to a base semver, no `+dev` tag.
* If `build-version.json` is absent (tests, local REPL, an unbuilt context), the
  footer shows an em-dash (`—`) — never an invented version.

`build-version.json` is generated artefact; it is listed in `.gitignore` and is
not committed.

### Capturing the version outside Docker

When Node is available on the host (local development), capture the stamp
manually before running the web dev server, otherwise the footer shows `—`:

```bash
corepack pnpm version:capture     # writes build-version.json from .git
```

## Data safety

All durable user data is stored on the host and mounted into the container as
bind mounts. Rebuilding the image or recreating the container does **not** touch
this data — it lives outside the image and the container layer.

| Host path (server profile) | Container path | Contents |
| --- | --- | --- |
| `$GITPM_DEPLOY_ROOT/repository` | `/repository` | Git portfolio repositories (durable business state) |
| `$GITPM_DEPLOY_ROOT/data` | `/data` | GitPM data directory |
| `$GITPM_DEPLOY_ROOT/gitpm-config` | `/app/.gitpm` | GitPM configuration |
| `$GITPM_DEPLOY_ROOT/opencode-config` | `/root/.config/opencode` | OpenCode configuration |
| `$GITPM_DEPLOY_ROOT/opencode-data` | `/root/.local/share/opencode` | OpenCode data |
| `$GITPM_DEPLOY_ROOT/state` | `/root/.local/state/opencode` | OpenCode state |
| `$GITPM_DEPLOY_ROOT/cache` | `/root/.cache/opencode` | OpenCode cache |

Take a host-side backup of `$GITPM_DEPLOY_ROOT` before any major upgrade.

## Plain profile

```bash
# Local, single-user, no auth:
GITPM_REPOSITORY_PATH=/path/to/portfolio corepack pnpm docker:build
docker compose up -d

# LAN/server profile (bind IP, OAuth, healthcheck):
docker compose -f compose.yaml -f compose.server.yaml up -d --build
```

Configuration for the server profile is documented in `compose.server.yaml`.

In the local single-user profile, GitPM does not authenticate individual HTTP
clients. Every client that can reach the API is a trusted local Maintainer. Bind
this profile to loopback, or place it behind an independently authenticating
reverse proxy after a deployment review. GitPM itself does not protect a public
network perimeter.

This profile supports one operator working with one repository and one working
tree at a time. Its mutexes and optimistic fingerprints make individual UI
operations atomic and detect stale writes; they are not a coordination mechanism
for concurrent authors. Parallel local editing is unsupported and must instead
use Git branches/worktrees and the normal Git workflow.

The legacy `user-oauth-publication` flow authenticates remote publication, not
the whole HTTP API. The authenticated multi-user profile requires worktree mode
and `GITPM_GITLAB_AUTH_MODE=oauth-identity-project-token`, as described below.

## Multi-user GitLab authentication

The supported multi-user mode deliberately separates user identity from
repository credentials:

* the GitLab OAuth application requests only `read_user`; GitPM uses the
  resulting profile for the server session and commit author/committer;
* one administrator-provisioned Project Access Token performs membership
  checks, fetch, push, and Merge Request API calls for exactly one configured
  GitLab project.

Configure all project coordinates administratively and use worktree mode:

```bash
GITPM_REPOSITORY_MODE=worktree
GITPM_GITLAB_AUTH_MODE=oauth-identity-project-token
GITPM_GITLAB_URL=https://gitlab.example
GITPM_GITLAB_PROJECT=group/portfolio
GITPM_GITLAB_CLIENT_ID=<oauth-application-id>
GITPM_GITLAB_REDIRECT_URI=https://gitpm.example/api/auth/callback
GITPM_PUSH_REMOTE_URL=https://gitlab.example/group/portfolio.git
GITPM_GITLAB_PROJECT_TOKEN_FILE=/run/secrets/gitpm_gitlab_project_token
```

`GITPM_GITLAB_PROJECT_TOKEN` may be used instead of the `*_FILE` variable, but
a Docker secret is preferred. Never set both. The secret file must contain only
the token. The token is rejected if placed in `.gitpm/config.json`; it is never
accepted from the browser, returned by the API, embedded in the repository URL,
or stored in a user session.

The OAuth application needs only the `read_user` scope. The Project Access
Token must belong to the configured project, have Developer or Maintainer
access, and have `api` plus `write_repository` scopes. GitPM validates that the
credential-free repository URL and configured `group/project` identify the same
project on the configured GitLab origin. In this mode those values cannot be
changed through HTTP.

Reporter sessions are read-only. Developer and Maintainer sessions may mutate
data and publish their own drafts. Role membership is checked again through the
Project Access Token before every mutation, commit, push, and Merge Request.
Each commit uses the OAuth user's GitLab name and Public email for both author
and committer without modifying Git config. A missing Public email blocks the
commit until the user configures one in GitLab.

GitLab records the Project Access Token bot as the pusher and Merge Request
creator; the Git commit itself records the initiating user. GitPM adds
`Initiated in GitPM by @username` to the Merge Request description and writes a
sanitized server audit event with user ID/username, operation, result, branch,
commit SHA, and Merge Request IID when applicable. Tokens are excluded.

The older `user-oauth-publication` mode remains available as a separate
compatibility mode. It requests the historical publication scopes and must not
be combined with `GITPM_GITLAB_PROJECT_TOKEN`.

## With-OpenCode profile (LAN server)

This profile bundles the OpenCode web UI (`:4096`) alongside GitPM, with Caddy
in front of GitPM's web (`:80` inside the container) providing HTTP basic auth.
It is the profile used on a dedicated server such as `myserver`.

### Layout

```
$GITPM_DEPLOY_ROOT/           # default /srv/gitpm
├── repository/               # bind-mounted -> /repository
├── data/                     # bind-mounted -> /data
├── gitpm-config/             # bind-mounted -> /app/.gitpm
├── opencode-config/          # bind-mounted -> /root/.config/opencode
├── opencode-data/            # bind-mounted -> /root/.local/share/opencode
├── state/                    # bind-mounted -> /root/.local/state/opencode
├── cache/                    # bind-mounted -> /root/.cache/opencode
└── secrets/
    ├── opencode-web.env      # opencode web env (e.g. auth tokens)
    └── gitpm-web.env         # BASIC_AUTH_USER / BASIC_AUTH_PASS for Caddy
```

The repository clone (with `.git`) lives elsewhere; it is the **build context**,
not a bind mount. On `myserver` it is `/srv/gitpm/app`.

### Build and run

From the repository root:

```bash
docker compose -f deploy/with-opencode/compose.yaml up -d --build
```

Variables (set in a `.env` file or export them):

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITPM_DEPLOY_ROOT` | `/srv/gitpm` | Host root holding the bind mounts and `secrets/`. |
| `GITPM_BIND_IP` | `10.0.0.1` | LAN IP to publish ports on. |
| `GITPM_WEB_PORT` | `86` | Host port for the GitPM web UI (Caddy + basic auth). |
| `GITPM_OPENCODE_PORT` | `85` | Host port for the OpenCode web UI. |

> Port `87` is avoided — Chromium and Firefox block it (`ERR_UNSAFE_PORT`).

### Upgrade procedure

```bash
cd <repo>                                     # the clone, e.g. /srv/gitpm/app
git pull --ff-only                            # brings in new source + .git ref
docker compose -f deploy/with-opencode/compose.yaml up -d --build
docker compose -f deploy/with-opencode/compose.yaml logs --tail=50 gitpm
```

The rebuild captures a fresh `build-version.json` from the new `HEAD`, so the
sidebar footer reflects the deployed commit. Bind-mounted user data is untouched.

### Verifying the version stamp

```bash
# What the running image captured at build time:
docker exec gitpm cat /app/build-version.json
# What the launcher logged at startup (reads the file only, never Git):
docker logs gitpm 2>&1 | grep "Версия сборки"
```

The value in `/app/build-version.json` and the footer text must match the commit
date of `HEAD` (`git -C <repo> log -1 --format=%cI`). If you see `—`, `.git` was
not present in the build context — re-clone or restore it and rebuild.
