# GitPM: ранний baseline безопасности

Версия документа: 0.1  
Статус: обязательный до начала P03

## 1. Принцип

Безопасность реализуется вместе с компонентами, которые создают риск. P13 подтверждает и испытывает безопасность, а не впервые добавляет ее.

## 2. Защищаемые активы

- содержимое portfolio repository;
- dirty draft и safety refs;
- OAuth access и refresh tokens;
- master key и keyring;
- GitLab webhook secret;
- Git author identity;
- permission и agent policies;
- server filesystem;
- audit logs без секретов;
- доступность сервиса и дисковое пространство.

## 3. Границы доверия

- Browser -> GitPM HTTP API;
- Agent/MCP client -> GitPM API;
- GitPM -> local Git process;
- GitPM -> worktree filesystem;
- GitPM -> GitLab OAuth/API/Git transport;
- GitLab -> webhook endpoint;
- Administrator -> configuration and secrets;
- backup process -> bare repository and safety refs.

## 4. Основные нарушители

- обычный пользователь с ошибочными действиями;
- пользователь, пытающийся выйти за свои права;
- агент с неверным контекстом;
- скомпрометированный agent token;
- злоумышленник, управляющий именем branch, path или commit message;
- вредоносный repository content;
- злоумышленник, отправляющий поддельный webhook;
- оператор, случайно потерявший master key;
- процесс, оставивший worktree в промежуточном состоянии.

## 5. Обязательные контрмеры по этапам

### До и в P03: Git и filesystem

- запуск Git без shell;
- argv передается массивом;
- allowlist Git subcommands и options;
- branch/ref names проходят `git check-ref-format` и дополнительную policy validation;
- repository URL задается только администратором;
- path canonicalization через realpath;
- запрет выхода за worktree root;
- запрет записи в `.git` через domain API;
- symlink в управляемых каталогах запрещены;
- проверка symlink выполняется на каждом path component перед записью;
- `O_NOFOLLOW` или эквивалент используется там, где доступен;
- worktree ownership и permissions проверяются при startup;
- Git process имеет timeout, output limit и cancellation;
- credential helper не пишет token в argv, URL или environment dump;
- hard-kill recovery и lock cleanup проверяются spike и integration tests.

### В P04: YAML и HTTP

- YAML custom tags, aliases и anchors запрещены;
- duplicate keys являются ошибкой;
- ограничение глубины документа;
- ограничение количества nodes;
- максимум размера файла и request body;
- atomically written temp file создается в том же filesystem;
- content type проверяется;
- Zod/runtime validation для API;
- CSRF protection для cookie-authenticated mutations;
- per-user и per-IP rate limits;
- quota checks выполняются до записи;
- partial bulk operation запрещена, если явно не заявлена транзакционная семантика;
- ошибка не раскрывает абсолютные server paths.

### До и в P06: OAuth, tokens и webhooks

- Authorization Code Flow с PKCE;
- обязательные state и nonce;
- exact redirect URI;
- secure, HttpOnly, SameSite cookies;
- access/refresh token шифруются at rest;
- token никогда не логируется;
- webhook secret проверяется constant-time comparison;
- replay protection для webhook по event ID и времени;
- GitLab TLS certificate проверяется;
- scopes минимальны и тестируются на реальном GitLab project;
- logout отзывает локальную сессию и удаляет сохраненный token;
- administrator может принудительно отозвать token пользователя.

### В P12: agents

- отдельное моделирование угроз агента;
- agent identity не маскируется под человека;
- scope привязан к draft при создании и не расширяется самим агентом;
- deny rules имеют приоритет над allow rules;
- delete требует отдельного разрешения и количественного лимита;
- bulk operations имеют preview и итоговый semantic diff;
- agent не получает произвольный filesystem path;
- agent не может вызвать raw Git command;
- rate, file-count и diff-size quotas обязательны;
- cross-project и configuration changes блокируются до записи;
- push/MR выполняются только после server-side full validation.

### В P13: подтверждение

- итоговый threat model review;
- penetration-oriented tests;
- dependency and container scan;
- fault injection;
- backup/restore drill;
- load and quota tests;
- incident runbook;
- проверка, что ранние контрмеры не были обойдены последующими функциями.

## 6. Master key и keyring

Решение обязательно до P06.

### Источник ключа

Production:

- master key передается как mounted secret file;
- environment variable допускается только в development/test;
- ключ не хранится в repository, image или application config file;
- права secret file: только process user.

### Формат

- keyring содержит active key ID и zero or more decrypt-only previous keys;
- encrypted record содержит key ID, algorithm version, nonce и ciphertext;
- алгоритм выбирается из стандартной authenticated encryption библиотеки; собственная криптография запрещена.

### Ротация

1. добавить новый ключ как active;
2. старый оставить decrypt-only;
3. выполнить `gitpm secrets rotate --dry-run`;
4. выполнить re-encryption всех token records;
5. проверить, что старый key ID больше не используется;
6. удалить старый ключ после retention window.

### Потеря ключа

- project data не теряется;
- зашифрованные tokens считаются невосстановимыми;
- все затронутые пользователи должны войти повторно;
- server стартует в degraded mode только для локального чтения, если это безопасно;
- push/MR блокируются до восстановления keyring или re-authentication;
- событие фиксируется как security incident.

### Перезапуск и изменение конфигурации

- tokens переживают restart при наличии того же keyring и persistent state;
- если active key отсутствует, startup readiness fail;
- если отсутствует только previous key, records с этим key ID помечаются undecryptable, push от этих пользователей блокируется;
- silent token deletion запрещено.

### Отзыв

- logout удаляет local encrypted token record;
- administrator revoke удаляет record и завершает sessions;
- GitLab-side revoke обрабатывается как authentication required;
- refresh failure не приводит к бесконечному retry loop.

## 7. Обязательные security spikes P00S

- попытка command injection через branch name;
- path traversal и symlink swap во время atomic write;
- hard kill между temp write и rename;
- hard kill во время `git worktree add`;
- user credential push без появления token в process list и logs;
- webhook replay;
- YAML alias bomb;
- oversized diff;
- safety ref creation and recovery;
- GitLab handling of custom safety refs или подтвержденный fallback.

Каждый spike заканчивается ADR, воспроизводимым тестом или зафиксированным отказом от подхода.
