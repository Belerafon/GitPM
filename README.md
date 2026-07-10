# GitPM

Git-first система управления проектами и задачами с web UI, GitLab Merge Request workflow и поддержкой агентов.

## Current status

Статус: `planning_ready`. Реализация не начата. Planning revision v0.4 устраняет противоречия identity model, DAG, traceability, permissions, browser/Git security, observability и E2E specifications.

GitPM v0.1 намеренно не реализует резервное копирование. Локальные safety refs помогают при сбое процесса или потере worktree directory, но не при потере persistent volume.

## Active documents

- `docs/GitPM_Implementation_Plan_v0.4.md` - architecture and technical specification;
- `docs/GitPM_Work_Plan_v0.3.md` - executable stage plan;
- `docs/GitPM_Requirements_Traceability_v0.2.yaml` - formal DAG, requirements, E2E specifications and exact release gates;
- `docs/GitPM_Delivery_Policies_v0.2.md` - milestones, identity, permissions, quotas, durability and performance;
- `docs/GitPM_Security_Baseline_v0.2.md` - early security controls;
- `docs/PROGRESS.md` - actual evidence and next action.

Old versions remain available only in Git history.

## Planning validation

```bash
python3 scripts/validate_planning.py
python3 scripts/test_planning_validator.py
```

The validator parses YAML and checks:

- exactly one active version of each plan family;
- duplicate and missing stage/E2E/requirement IDs;
- stage dependency existence and DAG cycles;
- stage headings against the registry;
- exact E2E sequence `E2E-001` through `E2E-045`;
- requirement fields, acceptance criteria and bidirectional test links;
- exact release-gate coverage;
- obsolete architecture decisions such as `restore/lines`, repository picker or production key in environment;
- no executable backup subsystem in v0.1 planning.

## Core principles

- Immutable ULID is canonical identity.
- Display key is a mutable presentation attribute.
- Git is the business source of truth.
- One entity per YAML file named by ULID.
- One branch/worktree per draft.
- Changes go through validation, commit, push and GitLab MR.
- Physical delete and archive are separate operations.
- Restore uses native Git file/hunk/commit workflows.
- No database for business data and no custom Undo.
- One configured repository per server in v0.1.
- Alpha is the MVP.
- No backup subsystem in v0.1.
