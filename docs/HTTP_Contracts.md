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

Mutation routes declare a Fastify body schema. Entity and configuration documents also pass
through the shared full JSON Schema decoder before the domain layer is called. Malformed requests
return HTTP 400 with the locale-neutral code `REQUEST_CONTRACT_INVALID`.

When a repository document schema changes:

1. update the corresponding file in `schemas/v1`;
2. run `corepack pnpm contracts:generate`;
3. update the generic known-field UI read model when a new field must be edited dynamically;
4. update affected HTTP DTO schemas and named decoders;
5. run `corepack pnpm verify:local`.
