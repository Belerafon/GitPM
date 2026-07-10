# GitPM: политики поставки и эксплуатации

Версия документа: 0.2  
Статус: обязательный baseline v0.1

## 1. Milestones

- Alpha = MVP. Это один milestone, а не две пересекающиеся версии продукта.
- Beta = feature-complete v0.1 до итогового hardening.
- Release Candidate = security, fault, performance и operations evidence готовы.
- v0.1 = точная приемка registry и tag.

## 2. Ответственность

Каждый stage имеет:

- одного Accountable;
- список Responsible;
- список Acceptance roles.

`ARCH/SEC/QA` как единый владелец запрещен. При разногласии решение о stage status принимает Accountable, но обязательная Acceptance роль может заблокировать gate своей области.

## 3. Один repository

v0.1 обслуживает ровно один configured portfolio repository.

- Repository задается administrator configuration.
- UI не имеет repository selector.
- Пользователь не добавляет repository.
- Webhook routing принимает только configured GitLab project ID.
- Draft IDs уникальны в пределах server instance.
- Multi-repository isolation не является скрытой функцией v0.1.

## 4. Identity policy

- Canonical ID: immutable ULID.
- Filename and directory identity: ULID.
- Internal references: ULID fields only.
- Mutation API: ULID only.
- Display key: human-readable mutable attribute.
- Lookup by display key is read/resolve operation and returns ULID.
- Title/name is never identity.

## 5. Editable entities v0.1

Normal UI:

- Project;
- Task;
- Milestone;
- ViewConfiguration through saved views.

Administration UI:

- Person;
- Team;
- Calendar;
- capacity and membership.

Read-only configuration for normal users:

- statuses;
- issue types;
- permission policies.

Repository permission files can change only in a dedicated policy MR accepted by Administrator/required CODEOWNERS.

## 6. YAML policy

- Canonical formatter is authoritative.
- Domain YAML comments are unsupported and may be removed.
- Blank lines and multiline style are normalized.
- Anchors, aliases, custom tags and duplicate keys are errors.
- Manual editing outside GitPM is allowed but must pass format and validation.
- Documentation belongs in domain fields or separate Markdown files.

## 7. Migration policy

- No implicit migration on read.
- `migrate --check` reports need.
- `migrate --dry-run` writes nothing and produces diff/report.
- Apply runs in a draft, validates and creates a separate commit/MR.
- Previous-version fixture is mandatory before Alpha.
- Downgrade is not promised; Git revert is the rollback.

## 8. Dirty draft durability and no-backup policy

GitPM v0.1 performs no backup, replication, backup remote, archive copy or off-volume safety-ref copy.

Supported guarantees:

- process restart with the same persistent volume: dirty draft survives;
- container restart with the same persistent volume: dirty draft survives;
- hard kill during atomic write: at most the in-progress operation is rejected or rolled back;
- worktree directory loss while bare repository and local safety ref remain: recovery is supported;
- loss of the entire persistent volume: unpushed worktrees, local commits and safety refs are unrecoverable by GitPM.

States:

- `local-dirty`;
- `local-safety-ref`;
- `committed-local`;
- `pushed`.

RPO/RTO:

- process/container restart on same volume: RPO 0 for completed atomic writes, RTO target 5 minutes;
- worktree recovery from local safety ref: RPO bounded by configured local snapshot interval, default 60 seconds, RTO target 15 minutes;
- complete persistent-volume loss: no recovery objective for unpushed data;
- pushed data is outside GitPM local durability and follows GitLab operational policy.

UI warnings:

- local-only data is not protected from volume loss;
- closing a dirty draft does not push it;
- deleting a dirty draft is destructive;
- local safety ref is not a backup.

## 9. Authorization decision model

Decision precedence:

1. hard server deny;
2. repository policy deny;
3. actor/agent policy deny;
4. GitLab effective membership and role;
5. GitPM role allow;
6. operation/entity/draft-state allow.

Any deny wins.

GitLab role mapping defaults:

- Guest -> Viewer;
- Reporter -> Viewer;
- Developer -> Contributor;
- Maintainer -> Maintainer;
- Owner/instance administrator does not automatically become GitPM Administrator; Administrator is explicit server configuration.

Critical permission freshness:

- membership may be cached for at most 60 seconds for reads;
- create draft, delete, commit, push, create MR and policy changes force refresh or use a membership result newer than 10 seconds;
- GitLab authorization failure invalidates local cached permission immediately.

Viewer:

- read portfolio, files, history, diff and MR state;
- cannot create draft or mutate.

Contributor:

- create and edit own draft;
- CRUD allowed project entities;
- delete only if repository/project policy allows;
- commit, push and create MR under own identity;
- cannot change permission files, server settings or another user's draft.

Maintainer:

- Contributor rights;
- Calendar, Person, Team and capacity administration;
- migration draft;
- cleanup abandoned draft after retention;
- create revert draft from another user's merged work;
- cannot change server Administrator assignment.

Administrator:

- configure the single repository and secrets;
- configure role mapping, quotas and agent policies;
- approve permission-policy MR as required reviewer;
- recover/cleanup local worktrees;
- cannot bypass protected main.

Agent:

- dedicated identity and dedicated draft;
- only explicitly scoped project ULIDs and operations;
- delete requires `allow_delete` and numeric limit;
- no raw Git or arbitrary filesystem;
- push/MR only after server-side revalidation.

Draft ownership:

- owner may mutate own draft;
- Maintainer may read and recover abandoned draft;
- draft transfer is not supported in v0.1;
- cleanup of another user's dirty draft requires Maintainer plus explicit confirmation;
- config and permissions files are checked from Git diff before commit and push, not only hidden in UI.

## 10. Quotas

Defaults:

- 5 active drafts per Contributor;
- 50 active worktrees per server;
- 2 GiB per worktree;
- 20 GiB local bare repository plus worktrees warning threshold;
- 1 MiB per YAML file;
- 10 MiB HTTP request;
- 5 MiB rendered diff response;
- 2 000 changed files per UI commit;
- 500 files per agent operation;
- 100 deletes per human draft without Maintainer override;
- 20 deletes per agent draft by default when delete is enabled;
- merged drafts retained 7 days;
- closed clean drafts retained 14 days;
- dirty drafts are never automatically deleted.

Quota rejection is atomic and returns a dedicated error code.

## 11. Performance budgets and protocol

Reference runner:

- Linux x86_64;
- 4 dedicated vCPU;
- 8 GiB RAM;
- local NVMe-class storage;
- Node.js and Git versions pinned in runner manifest;
- GitLab RTT below 20 ms for GitLab-specific measurements.

Protocol:

- fixed fixture commit SHA;
- 5 warmup runs;
- 20 measured runs for each non-destructive case;
- report p50, p95, max and standard deviation;
- record process RSS peak and filesystem/cache mode;
- cold application load starts a new process with empty application cache;
- warm load reuses process and in-memory model;
- filesystem page cache state is recorded, not silently assumed;
- concurrency suite simulates 30 authenticated users and 10 active drafts for 15 minutes;
- network is excluded from local parser/validation budgets and included in explicitly GitLab-labeled budgets;
- raw samples and runner manifest are release artifacts.

Alpha fixture: 3 000 tasks.

- cold application load p95 <= 2.5 s;
- warm model open p95 <= 300 ms;
- single task write p95 <= 300 ms excluding full validation;
- full validation p95 <= 2.5 s;
- semantic diff for 100 files p95 <= 1.2 s;
- create local worktree p95 <= 2.5 s;
- task list interactive p95 <= 2.5 s;
- server RSS <= 700 MiB plus <= 140 MiB per active loaded worktree model.

Release fixture: 10 000 tasks.

- cold application load p95 <= 6 s;
- full validation p95 <= 10 s;
- task list interactive p95 <= 4 s;
- 30-user/10-draft suite error rate < 1 percent excluding injected failures;
- no unbounded memory growth across the 15-minute run.

## 12. Cleanup and storage policy

- No backup subsystem exists.
- Cleanup never deletes dirty draft automatically.
- Merged/closed clean worktrees follow retention.
- Before cleanup, branch/MR state is verified.
- Disk warning and hard quota are observable.
- Loss of persistent volume is handled as infrastructure data loss, not as an application restore workflow.
