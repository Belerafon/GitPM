# GitPM agent workflow v1

The agent uses the same draft worktree, repository format and CLI as the UI. There is no MCP server and no separate agent API.

## Runtime configuration

The CLI discovers the persisted draft runtime through environment variables:

- `GITPM_DATA_DIR` — server persistent data directory containing `drafts/` and `worktrees/`;
- `GITPM_REMOTE_URL` — exact configured repository remote;
- `GITPM_DEFAULT_BRANCH` — default branch, `main` when omitted;
- `GITPM_ASKPASS_PATH` — controlled ASKPASS program used for push;
- `GITPM_ACCESS_TOKEN` — process-memory token used only by push/MR adapters;
- `GITPM_AGENT_AUTHOR_NAME` and `GITPM_AGENT_AUTHOR_EMAIL` — commit identity.

Tokens must not be written into repository URLs, Git configuration, arguments, logs or files.

## Create or open an external draft

```bash
gitpm draft create --draft DRF-AGENT-001 --owner 42
gitpm draft open --draft DRF-AGENT-001 --owner 42
gitpm draft status --draft DRF-AGENT-001
```

Create and open switch the draft to `external` writer mode. While that mode is active, UI mutation controls remain disabled. Switch back only after the agent stops writing:

```bash
gitpm draft set-writer ui --draft DRF-AGENT-001 --owner 42
```

## Edit loop

Edit YAML directly under the reported `worktree_path`, then run:

```bash
gitpm format --draft DRF-AGENT-001 --project PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYP
gitpm validate --changed --draft DRF-AGENT-001 --project PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYP
gitpm diff --semantic --draft DRF-AGENT-001 --project PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYP
```

When `--project` is present, every changed path must belong to that Project. Repository-global configuration, People, Teams, Calendars and other Projects are rejected with `AGENT_SCOPE_VIOLATION`.

Deletion is rejected unless the same verification/commit command includes `--allow-delete`. This flag authorizes the declared deletion only for that invocation; reference and repository validation still apply.

## Publish

```bash
gitpm commit --all -m "Update delivery plan" --draft DRF-AGENT-001 --project PRJ-01J2BZA35YJGY8Z4T1P8JZ2TYP
gitpm push --draft DRF-AGENT-001
gitpm mr create --draft DRF-AGENT-001 --owner 42 --title "Update delivery plan"
```

Commit always stages every draft change after scope and repository validation. Partial staging is not supported. Push requires a clean committed worktree. MR creation uses the configured GitLab protocol adapter and marks the draft published.

Use `--json` for locale-neutral automation output. Human output follows the CLI source locale policy.

## Open UI behavior

The UI polls the draft every three seconds. A changed external fingerprint reloads affected read-models without a browser reload. Changed fields or collapsed entity cards receive a short external-update indication. Consecutive writes coalesce by extending one indication; reduced-motion mode uses the same static highlight without animation. Polling does not move focus or scroll position.
