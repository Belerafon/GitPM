# GitPM: политики поставки и эксплуатации

Версия документа: 0.5  
Статус: обязательный baseline v0.1 с принятыми post-release дополнениями

## 1. Milestones

- Alpha = MVP: UI -> files -> diff -> commit all -> push -> MR.
- Beta: Board, History, read-only Gantt, Workload and agent CLI workflow.
- Release Candidate: security hardening and reproducible operational smoke complete.
- Release: factual execution gate passes and tag v0.1 is created.

## 2. Ответственность и evidence

Каждый stage имеет одного Accountable и Responsible roles. Acceptance roles объявляются только там, где нужна отдельная ролевая приёмка; для stage без них достаточно успешных checks и evidence. Фактический status хранится только в `GitPM_Execution_Status_v0.1.yaml`. `PROGRESS.md` не дублирует checklist.

## 3. Repository boundary

v0.1 обслуживает один выделенный GitPM repository. Repository selector, mixed source-code repository и multi-repository isolation отсутствуют.

## 4. Identity

- один immutable короткий ID вида `P-26-7K4M9Q`;
- Project ID равен имени Project directory, остальные entity filenames равны ID;
- internal references and mutation routes use ID;
- current-state uniqueness is validated;
- историческая гарантия непереиспользования deleted ID не заявляется.

## 5. Schema baseline

P01 должен завершиться approved schema v1 baseline. Parser implementation не начинается на schema drafts. Calendar and date-only rules входят в baseline до API and UI.

## 6. Editable entities

Normal UI: Project, Task, Milestone, Saved View и Task Comment.

Maintainer UI: Person, Team, Calendar, statuses and issue types.

Credential-free repository URL, GitLab project и OAuth Application ID доступны
Maintainer в repository settings, если не заданы environment variables. OAuth
access token, read credential и другие секреты остаются только во внешней
конфигурации или памяти процесса и никогда не принимаются settings UI.

## 7. YAML

Formatter authoritative. ID известных сущностей получают канонические комментарии
`# <kind>: <name/title>` для читаемых YAML и Git diff; произвольные ручные
комментарии не гарантируются. Unknown schema version отклоняется. Migration engine отсутствует.

## 8. Workspace consistency

- `direct` mode использует выбранный checkout и не публикует draft/writer lifecycle;
- `worktree` draft имеет одного owner и one writer mode: `ui` or `external`;
- multiple readers allowed в обоих режимах;
- browser uses polling every 3 seconds;
- commit always includes all draft changes в `worktree` mode и все изменения
  выбранного checkout в `direct` mode;
- dirty workspace/draft is never auto-cleaned;
- worktree close does not delete worktree or branch.

## 9. No backup

Нет safety refs, backup, replication or off-volume copy. Выбранный checkout в
`direct` mode и configured persistent data directory/volume в `worktree`
mode являются соответствующей local durability boundary. Их потеря может
уничтожить unpushed data.

## 10. Authorization

- Guest/non-member: deny;
- Reporter: read-only;
- Developer: own drafts and normal entities;
- Maintainer: administrative entities and explicit cleanup;
- Administrator: external deployment/secrets operator; secret settings UI отсутствует.

Role is refreshed before mutation, commit, push and MR. GitLab remains final control for push/MR.

## 11. OAuth and GitLab

OAuth 2.0 Authorization Code with PKCE is the only login flow. Access token is memory-only. Webhook is absent; MR status is polled. Automated tests use local test doubles, not a live GitLab project.

## 12. Delete and restore

Physical delete and archive are separate. Delete обычно использует `restrict`.
Для Person доступно отдельное подтверждённое unlink поддерживаемых ссылок перед
delete. Restore supports whole file, deleted file and hunk. Selected lines are absent.

## 13. No quota engine

Only static process-protection limits exist. No counters, billing state, per-user quotas or quota UI.

## 14. Git divergence

No rebase and no conflict editor. Conflict resolution is external or the user creates a new draft from current remote main.

## 15. Calendar, Gantt and Workload

Calendar is date-only. Gantt is read-only. Workload is approximation and explains its formula.

## 16. Planning maintenance

Scope or architecture changes require synchronized updates of active docs, registry, execution status and validators according to the Maintenance Guide.


## 17. Localization

- UI and human-readable CLI use registered locale packs; user-facing strings are not hard-coded.
- Russian `ru` is mandatory and complete for release v0.1.
- English `en` is the source locale and fallback.
- Default locale is configurable and defaults to `ru`; browser choice is stored only in localStorage.
- API and CLI JSON output remain locale-neutral and use stable codes.
- Repository content and user-authored text are not translated automatically.
- Date-only values remain ISO in YAML and are formatted without timezone date shifts.
- Release gate requires key/placeholder parity and Russian UI/CLI acceptance evidence.
