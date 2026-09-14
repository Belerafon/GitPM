# ADR 0007: Decorative browser slugs on entity routes

- Status: accepted
- Date: 2026-09-14

## Context

Browser routes addressed Project, Task, Milestone, Person and Calendar pages by immutable ID
only, for example `/projects/P-26-7K4M9Q`. Names are UTF-8, mutable and not unique, so they cannot
become identity. Users still need a readable address bar when sharing a Project or Person link.

Repository paths, HTTP mutation routes and CLI commands already use IDs. A stored display key
would contradict the identity policy in the implementation plan.

## Decision

1. Canonical identity in a browser path remains the immutable entity ID.
2. After the ID, the UI may append a derived ASCII slug: `/projects/P-26-7K4M9Q-pereezd-analiticheskoy-platformy`.
3. The parser extracts the ID at the start of the segment and ignores the remainder. ID-only URLs stay valid.
4. The slug is computed at presentation time from the current name or title. Person URLs use the full name parts, not `display_name_format`. It is not stored in YAML, schema or Git.
5. Lookup, API calls and writes use only the ID. Duplicate names share a slug and stay distinct by ID.
6. After entity documents load, the current slug replaces the address with `history.replaceState`. An outdated slug in a bookmark still opens the entity.
7. Nested workspace tabs keep the same compound project segment: `/projects/:id-:slug/board`.

## Consequences

- Shared links remain unambiguous after rename.
- Locale packs do not affect the serialized URL.
- HTTP `/api` routes, repository layout and CLI contracts are unchanged.
