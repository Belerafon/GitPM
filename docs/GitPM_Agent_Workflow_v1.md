# GitPM agent workflow v1

Agent работает в той же runtime рабочей копии и через тот же CLI, что и web UI.
Отдельного MCP mutation server или agent API нет. YAML можно читать для контекста,
но domain-сущности изменяются только командами `gitpm`.

GitPM создаёт в runtime checkout `AGENTS.md` и
`.agents/skills/gitpm/SKILL.md`. В `worktree` mode они создаются в каждом draft,
в `direct` mode — прямо в выбранной рабочей копии. Runtime восстанавливает
их при необходимости; Project scope, semantic diff, commit-all, clean checks,
push и MR исключают эти файлы.

Корневой `AGENTS.md` репозитория исходного кода GitPM относится к разработке
приложения. Runtime skill не устанавливается в source root.

## Runtime configuration

CLI использует:

- `GITPM_REPOSITORY_MODE` — `direct` (default) или `worktree`;
- `GITPM_REPOSITORY_PATH` — выбранный checkout в `direct` или source repository в `worktree`;
- `GITPM_DATA_DIR` — persistent metadata и worktrees;
- `GITPM_REMOTE_URL` — configured fetch/push remote только для `worktree` workflow;
- `GITPM_DEFAULT_BRANCH` — default branch, обычно `main`;
- `GITPM_ASKPASS_PATH` и `GITPM_ACCESS_TOKEN` — controlled remote authentication;
- `GITPM_AGENT_AUTHOR_NAME` и `GITPM_AGENT_AUTHOR_EMAIL` — commit identity.

Token запрещено записывать в repository URL, Git configuration, arguments, logs
или files. Проверить фактически установленный CLI можно командами:

```bash
gitpm --version --json
gitpm schema list --json
gitpm status --json
```

`status` возвращает mode и фактический checkout path. Все дальнейшие команды
нужно выполнять именно в этом checkout, а не в source repository GitPM.

## Direct mode (default)

В `direct` mode публичного draft lifecycle нет, `--draft` не нужен. Agent и UI
разделяют выбранную рабочую копию. Она должна находиться на настроенной основной
ветке; другая ветка или detached HEAD блокируют работу стабильной Git-ошибкой.
Одновременную запись нужно координировать организационно.

```bash
gitpm status --json
gitpm entity update --type task --id T-26-RHBNH8 \
  --set status=done --project P-26-MGP84K --json
gitpm format --project P-26-MGP84K
gitpm validate --changed --project P-26-MGP84K
gitpm diff --semantic --project P-26-MGP84K
gitpm commit --all -m "Complete delivery task" --project P-26-MGP84K
gitpm push
```

Push сначала fetch-ит remote и допускает только безопасный fast-forward. Команды
`draft ...` и `mr create` в direct mode недоступны.

## Worktree mode

Для изолированной agent-сессии создайте или откройте draft. Обе команды переводят
его в `external` writer mode; web UI остаётся read-only до явного возврата writer:

```bash
gitpm draft create --draft DRF-AGENT-001 --owner 42
gitpm draft open --draft DRF-AGENT-001 --owner 42
gitpm draft status --draft DRF-AGENT-001
```

После завершения записи:

```bash
gitpm draft set-writer ui --draft DRF-AGENT-001 --owner 42
```

Все рабочие команды получают `--draft DRF-AGENT-001`. Публикация выполняется в
draft branch и завершается Merge Request:

```bash
gitpm commit --all --draft DRF-AGENT-001 --project P-26-MGP84K \
  -m "Update delivery plan"
gitpm push --draft DRF-AGENT-001
gitpm mr create --draft DRF-AGENT-001 --owner 42 --title "Update delivery plan"
```

## CLI-only mutation boundary

Пользовательские исходные документы помещаются в разрешённый non-domain каталог
`uploads/`. Его содержимое игнорируется Git: agent может читать и преобразовывать
эти файлы, но не должен коммитить их или копировать binary content в domain paths.
Извлечённые данные передаются CLI через temporary YAML/CSV/JSONL вне checkout.

Для создания передайте temporary YAML mapping вне runtime checkout. При `--type`
можно опустить `schema`, `id` и `lifecycle`; CLI подставит schema, сгенерирует ID
и использует `active`. У Person отсутствующий `calendar` берётся из repository
`default_calendar`.

```bash
gitpm entity create --type task --file /tmp/task.yaml \
  --project P-26-MGP84K --json
```

Существующую сущность изменяйте transactional patch:

```bash
gitpm entity update --type person --id U-26-5EBAE3 \
  --set email=anna.new@example.test --set weekly_capacity_hours=36 --json
gitpm entity update --type task --id T-26-RHBNH8 \
  --unset milestone --project P-26-MGP84K --json
```

Значения `--set` разбираются как YAML. Для большого patch используйте
`--file <yaml-patch>`. `schema`, `id` и owning Project неизменяемы; `null` в patch
и `--unset` удаляют optional field. После записи GitPM валидирует весь repository
и откатывает все затронутые файлы при ошибке.

Для атомарного bulk creation:

```bash
gitpm entity import --type person --format csv --file /tmp/people.csv --dry-run --json
gitpm entity import --type person --format csv --file /tmp/people.csv --json
```

Поддерживаются CSV, YAML array и JSONL. Import сначала планирует все ID, затем
однократно валидирует итоговый repository и откатывает весь batch при любой
ошибке. Поля следует сверять через `gitpm schema show <type> --json`, а не выводить
из случайных существующих файлов.

Перед физическим удалением agent выполняет preview, затем повторяет подтверждённую
операцию с явным delete-разрешением:

```bash
gitpm entity delete --type task --id T-26-RHBNH8 --dry-run --json
gitpm entity delete --type task --id T-26-RHBNH8 --allow-delete --json
gitpm entity archive --type task --id T-26-RHBNH8 --json
```

Для Person `--unlink-references` разрешает явно удалить поддерживаемые ссылки перед
delete. В `worktree` mode эти entity-команды получают `--draft <id>`. Отдельные
`comment` и `config` команды пока доступны только в `direct` mode; этот gap нельзя
обходить прямой правкой YAML.

## Scope, validation и publication

После каждой группы mutation выполняйте format, changed validation и semantic diff.
В worktree mode добавляйте `--draft`:

```bash
gitpm format --project P-26-MGP84K
gitpm validate --changed --project P-26-MGP84K
gitpm diff --semantic --project P-26-MGP84K
```

`--project` требует, чтобы все business changes принадлежали указанному Project.
Repository configuration, People, Teams, Calendars и другие Projects приводят к
`AGENT_SCOPE_VIOLATION`. Physical deletion дополнительно требует
`--allow-delete` в соответствующей validation/diff/commit-команде, но этот флаг
не разрешает обходить CLI mutation boundary.

Commit всегда включает все изменения runtime checkout/draft после полной scope и
repository validation. Partial staging не поддерживается. Push требует clean
committed tree.

При ошибке, неоднозначном контракте или отсутствующей операции agent сообщает
sanitized command, стабильный error code, observed/expected behavior и конкретное
предложение по улучшению GitPM. Product feedback не даёт разрешения менять
исходники приложения из portfolio checkout.

## Open UI behavior

UI периодически сверяет fingerprint. В worktree external mode новые revision
перезагружают затронутые read models и кратко отмечают изменённые поля без смены
focus/scroll. В direct mode неожиданное внешнее изменение блокирует stale UI write,
пока пользователь не просмотрит и явно не подтвердит текущий checkout fingerprint;
подтверждение само по себе не меняет и не валидирует файлы.
