# GitPM agent workflow v1

The agent uses the same draft worktree, repository format and CLI as the UI. There is no MCP server and no separate agent API. Every draft contains generated `AGENTS.md` and `.agents/skills/gitpm/SKILL.md`, regardless of writer mode, so an agent can join at any stage. Draft creation and runtime recovery restore the current versions; agent status also repairs them when necessary. These are local worktree runtime files: Project scope, semantic diff, commit-all, clean checks, push, and Merge Requests exclude them in both UI and CLI workflows.

The generated runtime `AGENTS.md` is distinct from the GitPM source repository's root `AGENTS.md`: the root file governs development of the application, while the generated file and skill govern CLI-only portfolio work inside the reported draft worktree. The runtime skill is never installed in the source root.

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

## CLI-only mutation boundary

Repository YAML may be read for context but must not be edited directly. Entity creation goes through the CLI using a temporary input file outside the worktree:

```bash
gitpm entity create --draft DRF-AGENT-001 --file /tmp/entity.yaml --project P-26-MGP84K --json
```

The v0.1 CLI does not expose update, archive, or delete entity commands. An agent must report that capability gap instead of editing repository files or inventing a command.

For any GitPM error, ambiguous contract, inconsistent output or missing CLI operation, the agent reports the sanitized command and stable error code, explains observed versus expected behavior, and gives the user a concrete GitPM improvement proposal. Product feedback does not authorize a manual workaround or changes to the GitPM application from the portfolio draft.

After each supported mutation, run:

```bash
gitpm format --draft DRF-AGENT-001 --project P-26-MGP84K
gitpm validate --changed --draft DRF-AGENT-001 --project P-26-MGP84K
gitpm diff --semantic --draft DRF-AGENT-001 --project P-26-MGP84K
```

When `--project` is present, every changed path must belong to that Project. Repository-global configuration, People, Teams, Calendars and other Projects are rejected with `AGENT_SCOPE_VIOLATION`.

Deletion is rejected unless the same verification/commit command includes `--allow-delete`. This flag authorizes the declared deletion only for that invocation; reference and repository validation still apply. It does not authorize bypassing the CLI.

## Publish

```bash
gitpm commit --all -m "Update delivery plan" --draft DRF-AGENT-001 --project P-26-MGP84K
gitpm push --draft DRF-AGENT-001
gitpm mr create --draft DRF-AGENT-001 --owner 42 --title "Update delivery plan"
```

Commit always stages every draft change after scope and repository validation. Partial staging is not supported. Push requires a clean committed worktree. MR creation uses the configured GitLab protocol adapter and marks the draft published.

Use `--json` for locale-neutral automation output. Human output follows the CLI source locale policy.

## Open UI behavior

The UI polls the draft every three seconds. A changed external fingerprint reloads affected read-models without a browser reload. Changed fields or collapsed entity cards receive a short external-update indication. Consecutive writes coalesce by extending one indication; reduced-motion mode uses the same static highlight without animation. Polling does not move focus or scroll position.
