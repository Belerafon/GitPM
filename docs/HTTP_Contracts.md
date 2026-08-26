# HTTP contracts

`@gitpm/contracts` is the shared browser/server boundary for GitPM HTTP data.

Repository documents originate in `schemas/v1`. The script
`scripts/generate-contract-document-schemas.mjs` embeds that catalog in the contracts package;
`pnpm contracts:verify` fails when the generated registry is stale. Entity type names used by the
domain layer and CLI are exported by the same package instead of being repeated locally.

The package exposes:

- concrete TypeScript document types such as `ProjectDocument`, `TaskDocument`,
  `CalendarDocument`, and `SavedViewDocument`, inferred from the generated JSON Schema constants;
- strict discriminated unions for validated writes and known-field read models for generic UI
  editors;
- shared DTO interfaces for sessions, drafts, changes, history, comments, notifications,
  repository connections, worktree browsing, and publication;
- named response decoders backed by AJV and the repository JSON Schemas;
- request-body JSON Schemas used by Fastify routes.

The web client must pass a named decoder for every JSON response. There is intentionally no
generic `decodeDto<T>` fallback. A successful HTTP status with a malformed response raises
`API_RESPONSE_CONTRACT_INVALID`.

Binary export is the explicit exception to the JSON decoder rule. The authenticated
`GET /api/drafts/:draftId/export` route returns a PDF, standalone HTML file, spreadsheet
workbook, or ZIP archive with a safe ASCII filename in `Content-Disposition` and
`Cache-Control: no-store`. Query validation uses stable `EXPORT_*` error codes. See
[`Export.md`](Export.md).

Mutation routes declare a Fastify body schema. Entity and configuration documents also pass
through the shared full JSON Schema decoder before the domain layer is called. Malformed requests
return HTTP 400 with the locale-neutral code `REQUEST_CONTRACT_INVALID`.

Notification read state is server-owned personal runtime data, not repository business data.
`GET /api/drafts/:draftId/notifications` returns a required `read` boolean on every notification.
`POST /api/drafts/:draftId/notifications/read` accepts `{ "keys": string[] }`, authenticates the
draft reader, ignores keys that are not currently visible to that reader, and persists matching
keys by repository namespace and resolved Person ID under the server data directory. This action
does not mutate repository YAML, change the draft fingerprint, or require a writable draft. The
web client imports matching legacy `localStorage` keys once and removes them only after successful
server persistence.

The changes list includes a required `project_files` read model derived directly from canonical
`projects/<project-id>/files/<flat-name>` paths. It groups Project storage changes without a
manifest or sidecar. Its operation and content-kind values are locale-neutral; text/binary
classification inspects bounded bytes rather than trusting an extension, and uncertain external
rename pairs remain separate delete/add records.

Direct-mode history writes use two explicit routes rather than overloading draft lifecycle:
`POST /api/drafts/:draftId/history/:commit/restore-files` accepts an optimistic fingerprint and
1–200 changed paths, while `POST /api/drafts/:draftId/history/:commit/revert-direct` accepts the
fingerprint and commit message. Their decoded results return the refreshed fingerprint; the revert
result also returns the newly created commit. The existing `/revert` route remains the worktree-mode
operation that creates a separate revert draft.

When a repository document schema changes:

1. update the corresponding file in `schemas/v1`;
2. run `corepack pnpm contracts:generate`;
3. update the generic known-field UI read model when a new field must be edited dynamically;
4. update affected HTTP DTO schemas and named decoders;
5. run `corepack pnpm verify:repository` and the affected server, CLI, web, or export consumer
   profiles identified by the impact analysis; use `verify:local` only when the schema change is
   genuinely cross-cutting and cannot be bounded.
