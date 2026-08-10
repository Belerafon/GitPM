# ADR 0005: Composable view filters and sorting

## Context

GitPM entity directories previously exposed unrelated always-visible controls: a lifecycle toggle,
text search, and one-value Project or Task selectors. They could only express a flat conjunction and
could not order results consistently. Adding another control for every field would make the primary
workspace progressively denser.

The repository `gitpm/saved-view@1` contract is Project-scoped and intentionally supports only the
existing Task list/board fields. Expanding that durable YAML contract is a separate migration and is
not required to make interactive directories queryable.

## Decision

1. Entity directories use one shared, typed client-side query model. A query contains:
   - a recursively nested filter expression whose groups combine children with `and` or `or`;
   - typed conditions for text, dates, numbers, booleans, references and reference arrays;
   - an ordered list of ascending or descending sort rules.
2. The main workspace stays compact. It shows one **Filters and sorting** button, applied condition
   and sort chips, a per-chip remove action, **Clear all**, and the visible/total count. The full
   builder is an accessible modal drawer with draft, Apply and Cancel behavior.
3. Empty filter groups match all rows. Empty sort values are always placed last, in either direction.
   Equal rows retain their input order, so sorting is deterministic and stable.
4. The initial directory query is `lifecycle = active`. This is an ordinary removable condition;
   clearing it exposes archived rows rather than creating an implicit second filter system.
5. Project and project-Task queries are serialized into the route `filters` value. The parser accepts
   only fields and operators declared by the current surface, with limits of 20,000 serialized
   characters, eight group levels, 100 filter nodes and ten sort rules. Unknown or malformed URL
   input falls back to an empty query.
6. Task hierarchy remains intact after filtering. Matching descendants retain their ancestors as
   context-only rows, while sorting changes sibling order without changing stored manual order.

## Supported entity surfaces

- Projects: ID, name, group, owner, status, lifecycle, dates, overdue/risk, Task count and milestone
  count.
- Project Tasks: ID, title, status, type, milestone, assignees, dates, effort and overdue state.
- People: ID, name, email, weekly capacity, calendar, Project count, teams and lifecycle.
- Teams: ID, name, members, member count and lifecycle.
- Calendars: ID, name, working-day count, holiday count and lifecycle.

Board saved views, workload horizon controls and repository-operational screens keep their own domain
controls. They are not entity directories and must not silently adopt a Project-scoped saved-view
contract. A future durable advanced-view schema can reuse the query semantics only through an
explicit versioned repository-format change.

## Consequences

- New entity directories add field descriptors instead of implementing new query logic.
- Filters remain locale-neutral in the URL while labels and values remain localized in the UI.
- The browser performs the query over the already-loaded, scope-constrained entity set; it cannot
  widen a Project Task view to another Project.
- Complex filters are shareable for the Project directory and Project Task workspace, but they are
  not yet durable repository Saved Views.
