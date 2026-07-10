# GitPM: политики поставки и эксплуатации

Версия документа: 0.3  
Статус: обязательный baseline v0.1

## 1. Milestones

- Alpha = MVP: основной путь UI -> files -> diff -> commit -> push -> MR.
- Beta: все функции v0.1, включая Board, History, read-only Gantt, Workload и agent CLI workflow.
- Release Candidate: security hardening и smoke performance завершены.
- Release: exact registry gate и tag v0.1.

## 2. Ответственность

Каждый stage имеет одного Accountable, список Responsible и Acceptance roles. Закрытие stage требует evidence из Work Plan и обновления `PROGRESS.md`.

## 3. Repository boundary

v0.1 обслуживает один repository, заданный server configuration. Repository selector, пользовательское подключение новых repositories и multi-repository isolation отсутствуют.

## 4. Identity

- Единственный ID: immutable prefixed ULID.
- Filename, internal reference и mutation route используют этот ID.
- Отдельного display key нет.
- Title/name можно менять свободно.

## 5. Editable entities

Normal UI:

- Project;
- Task;
- Milestone;
- saved View.

Administration UI:

- Person;
- Team;
- Calendar;
- weekly capacity;
- statuses и issue types в пределах простых конфигурационных форм.

## 6. YAML

Formatter является authoritative. Комментарии в domain YAML не гарантируются. Manual editing разрешено, но commit/push блокируются при failed format или validation.

Schema version неизвестного формата отклоняется. Migration engine отсутствует до появления реальной второй версии schema.

## 7. Local-only durability and no backup

GitPM не создает safety refs, safety commits, backup, replication или off-volume copy.

Гарантия ограничена сохранным persistent volume:

- завершенная atomic write переживает restart;
- dirty worktree переживает restart процесса/контейнера;
- удаление worktree directory или volume может уничтожить uncommitted data;
- local commit без push также теряется вместе с volume;
- pushed branch следует operational policy GitLab.

UI показывает local-only warning. RPO/RTO для потери volume не заявляются.

## 8. Простая модель прав

GitLab role mapping:

- Guest/Reporter -> Viewer;
- Developer -> Contributor;
- Maintainer -> Maintainer;
- GitPM Administrator задается server configuration.

Viewer читает. Contributor работает со своими draft и обычными domain entities. Maintainer дополнительно управляет Person, Team, Calendar и cleanup abandoned draft. Administrator настраивает repository и OAuth/webhook secrets.

Нет собственного authorization DSL, policy repository, deny cascade, agent role engine или draft transfer.

Права проверяются backend перед mutation, commit, push и MR. GitLab может дополнительно отклонить push/MR.

## 9. OAuth session

Access token хранится только в памяти. Refresh token не сохраняется. Restart завершает OAuth sessions и требует повторного login. Шифрование token at rest, master key и key rotation не нужны, поскольку token at rest отсутствует.

## 10. Delete

Physical delete разрешен. Reference policy v0.1 - `restrict`. Archive остается отдельной операцией.

Agent delete разрешается явным CLI flag для конкретного запуска. Числовых quotas нет.

## 11. No quota engine

Нет limits по пользователям, draft, disk usage, числу entities или операциям агента как продуктовой подсистемы.

Допустимы только статические защитные ограничения процесса:

- HTTP body size;
- YAML file size/depth/node count;
- Git output size;
- command timeout;
- browser diff rendering limit.

Они задаются конфигурацией и не имеют счетчиков, billing state или административного quota UI.

## 12. Git divergence

GitPM не выполняет rebase и не разрешает merge conflicts. UI показывает branch status и ссылку на GitLab. Разрешение conflicts выполняется внешним Git client или путем нового draft.

## 13. GitLab testing boundary

Обязательные automated tests используют локальный test double. Live GitLab test project не является entry criterion или release gate.

## 14. Calendar and workload

Dates are date-only. Calendar определяет weekdays и holiday dates. Workload равномерно распределяет estimate по ISO-неделям и помечает результат как approximation.

## 15. Performance smoke

Три запуска, median, reference fixture 3000 tasks. Бюджеты заданы в Implementation Plan. Сложные p95/concurrency protocols не являются gate v0.1.

## 16. Planning maintenance

Любое изменение scope, stage, requirement, E2E или release gate выполняется по `GitPM_Planning_Maintenance_Guide_v0.1.md`. Planning validator обязателен перед commit.
