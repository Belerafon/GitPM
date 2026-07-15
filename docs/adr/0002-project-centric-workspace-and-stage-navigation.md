# ADR 0002: Project-centric workspace and first-class stage navigation

- Status: accepted
- Date: 2026-07-15

## Context

Schema v1 already requires every task to belong to a project and restricts its optional `milestone` reference to the same project. The web application nevertheless exposed Projects, Tasks, Board and Gantt as mostly independent global catalogs. A milestone was only a filter on the task list, and `/tasks` loaded every task from every project by default.

This made valid domain relationships difficult to discover and produced a task stream without a useful working scope.

## Decision

1. A project is the primary planning workspace.
2. Project Overview, Tasks, Board and Timeline are persistent project tabs. Project Overview is the canonical project landing page and combines project metadata, summary metrics, stages and their visible tasks.
3. A stage has a canonical detail route. The former stage-list route redirects to the project plan:

   ```text
   /projects/:projectId
   /projects/:projectId/stages/:stageId
   ```

4. Board and Timeline use project-scoped canonical routes. Legacy query routes are parsed and replaced without losing filters.
5. Tasks exist only inside a project workspace. The former global `/tasks` entry point redirects to `/projects`; Portfolio and Team Workload remain the explicit cross-project views.
6. Project screens may use a project workspace read model. The read model is derived from Git/YAML, cached by the current content fingerprint, and invalidated after UI or external changes. No business database is introduced.
7. Schema v1 and repository paths remain compatible. The UI term “stage” continues to map to `gitpm/milestone@1` until a separate schema decision establishes whether GitPM needs ordered project phases rather than due-date milestones.

## Consequences

- Project context is visible and addressable in the URL.
- The project landing page exposes progress, deadlines, every stage and its tasks without a second directory screen.
- Opening a stage reveals only its tasks and provides creation inside that scope.
- Task details link back to their project and stage.
- Repository reads for a project reuse one parsed index while preserving external-writer freshness.
- Global navigation is smaller; Board and Timeline are reached from the project workspace.
- A future schema v2 may add phase-specific fields such as ordering, start date and status, but it is not required for project-stage-task navigation.
