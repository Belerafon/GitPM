# ADR 0006: Portfolio task directory with hierarchy context

- Status: accepted
- Date: 2026-08-26
- Supersedes: ADR 0002 decision 5

## Context

ADR 0002 removed the global Task directory because its flat stream hid the Project and milestone
relationships that give each Task meaning. Users still need a cross-Project view for finding and
comparing work without opening Projects one by one. Restoring the former flat list would repeat the
same usability failure.

## Decision

1. `/tasks` is the canonical portfolio Task directory and has a persistent **Tasks** navigation item
   beside **Projects**.
2. The directory renders Tasks as `Project -> milestone -> Task -> subtask`. Tasks without an active
   milestone remain visible in a separate group inside their Project.
3. Filtering operates over the full portfolio and targets Task properties. Project and milestone
   selectors are not persistent controls: the directory already exposes those relationships through
   its hierarchy, while the Projects workspace is the primary structural directory.
4. A matching descendant retains its ancestors as context-only rows. Filtering must not flatten the
   hierarchy or make a Task appear detached from its Project and milestone.
5. Project, milestone and Task links open their existing Project-scoped canonical routes. Project
   workspaces remain the editing context; this decision adds a cross-Project directory, not a second
   mutation model.
6. Filter state is locale-neutral and addressable in the URL. A legacy or malformed filter payload
   falls back through the existing query parser rules.
7. The filter drawer starts with four attention-oriented presets: overdue Tasks, the next Task per
   active Project, unassigned Tasks and Tasks without a due date. The next Task is the unfinished Task
   with the earliest due date in that Project; start date, title and immutable ID break ties, and an
   undated Task is selected only when the Project has no dated unfinished Task.
8. Task rows expose explicit column headings and hover descriptions for Task navigation, assignees,
   due date, estimate and status. Missing values explain what is absent instead of leaving an
   unexplained dash.

## Consequences

- Users can inspect and filter all work without losing ownership or hierarchy context.
- The portfolio directory loads all Projects, milestones and Tasks, so large-repository performance
  must be monitored separately from the indexed Project workspace read model.
- Board and Timeline remain Project-scoped.
- Repository schema, canonical entity paths and Project scope validation do not change.
