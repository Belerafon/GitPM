# ADR 0003: Nested task hierarchy and atomic subtree movement

- Status: accepted
- Date: 2026-07-26

## Context

Schema v1 already has an optional Task `parent`, but the product treated it as a mostly
flat relationship. Project Plan rendered a two-level approximation, Board omitted
hierarchy context, task details could not create children, and moving a parent could
leave descendants behind.

The product needs tasks inside tasks without introducing a second entity kind or a
parallel storage model.

## Decision

1. `parent` defines an acyclic tree of arbitrary depth. The persisted model has no
   depth limit; the initial UI is designed and tested primarily for three levels.
2. A hierarchy belongs to exactly one Project and one Milestone. Parent and child must
   have the same `milestone`, including both having no milestone.
3. Each Task remains independently editable and owns its status, dates and estimate.
   Parent completion does not complete children and child completion does not complete
   the parent.
4. Progress and estimate for descendants are derived read models. They are displayed
   separately from the parent's own values and are never persisted.
5. `Milestone.task_order` supplies ordering priority inside sibling groups. Canonical
   move and reorder operations serialize the complete tree in depth-first pre-order,
   so reordering a task moves its whole subtree among siblings.
6. Project Plan is the primary tree editor. Board keeps one card per Task and shows an
   ancestor breadcrumb. Gantt uses the same depth-first hierarchy.
7. Moving a Task between Projects or Milestones is an atomic subtree operation. All
   descendants and their comments move together. An optional target parent may attach
   the subtree in the destination; full repository validation and rollback still apply.
8. When the UI creates a subtask, its assignee picker starts with the direct parent's
   assignees. The user may change or clear that selection before creation. The resulting
   assignee list is persisted on the child, and later assignee changes remain independent
   between parent and child.
9. No status or completion propagation is added.

## Consequences

- Existing repositories whose parent and child are assigned to different Milestones
  must be migrated before the stricter validator accepts them.
- All UI projections and domain mutations share one hierarchy utility, avoiding
  different recursion and ordering rules per screen.
- A deeply nested repository remains valid even if the first release gives its best
  visual support to the first three levels.
- Moving a parent can touch several Task and Comment paths, but is one atomic domain
  mutation and one semantic change.
