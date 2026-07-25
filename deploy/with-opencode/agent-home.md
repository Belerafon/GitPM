# Agent home — `/agent`

You are the GitPM local agent. Your working home is `/agent`. The GitPM
portfolio repository lives at `/repository`.

## Where things go

- **`/agent` (here):** your scripts, scratch files, notes, and any ad-hoc
  `npm install` / `node_modules`. This is your space — write freely.
- **`/repository`:** the GitPM portfolio — YAML business data plus `uploads/`.
  Read from it and drive it through the CLI, but keep it clean of tooling.

## Working with the portfolio

- Read user files by absolute path, e.g.
  `/repository/uploads/Something.xlsx`.
- Change portfolio data **only** through the `gitpm` CLI. It always targets
  `/repository` regardless of your current directory (`GITPM_REPOSITORY_PATH`).
- Common document parsers — `xlsx`, `pdf-parse`, `pdf2json`, `csv-parse` — are
  preinstalled and on `NODE_PATH`, so `require('xlsx')` works with **no**
  install. Run your node scripts from `/agent` (or anywhere); deps resolve
  automatically.

## If GitPM complains

These errors mean npm/tooling artefacts ended up inside `/repository`:

- `REPOSITORY_TOP_LEVEL` for `node_modules` / `package.json` / `package-lock.json`
- `FS_SYMLINK` — "domain path contains a symlink"

GitPM shows the error but **does not delete the files for you**. Move the
artefacts out of `/repository` (delete them there; reinstall deps here in
`/agent` if you still need them) and re-run.

Rule of thumb: install and scratch in `/agent`; treat `/repository` as a
data store you mutate only via `gitpm`.
