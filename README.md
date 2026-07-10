# GitPM

Git-first система управления проектами и задачами с web UI, GitLab Merge Request workflow и файловой работой агентов через CLI.

## Current status

Статус: `planning_ready`. Реализация не начата. Planning revision v0.5 удаляет преждевременные подсистемы и сохраняет основной продуктовый объем.

## Active documents

- `docs/GitPM_Implementation_Plan_v0.5.md` - architecture and technical specification;
- `docs/GitPM_Work_Plan_v0.4.md` - executable stages and verification;
- `docs/GitPM_Requirements_Traceability_v0.3.yaml` - formal DAG, requirements, E2E and exact release gates;
- `docs/GitPM_Delivery_Policies_v0.3.md` - product and operational boundaries;
- `docs/GitPM_Security_Baseline_v0.3.md` - early security controls;
- `docs/GitPM_Planning_Maintenance_Guide_v0.1.md` - how to update and maintain planning artifacts;
- `docs/PROGRESS.md` - actual evidence, blockers and next action.

Old versions remain only in Git history.

## Planning validation

```bash
python3 scripts/validate_planning.py
python3 scripts/test_planning_validator.py
```

## Simplified v0.1 principles

- One immutable prefixed ULID per entity; no display key.
- One configured repository per server.
- One branch/worktree per draft.
- Git is the source of truth; no business database.
- No backup and no safety refs.
- No migration engine.
- No quota engine.
- Simple GitLab role mapping; OAuth token only in memory.
- No rebase or conflict UI.
- Read-only Gantt and approximate Workload.
- Agents edit files and use CLI; no MCP.
- GitLab automated tests use a local test double, not a mandatory live project.
- Physical delete and archive are both supported.
- Restore uses native Git file/hunk/revert workflows.
