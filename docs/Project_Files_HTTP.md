# HTTP API файлов Project

Контракт предоставляет список, безопасную выдачу, потоковую загрузку, переименование и удаление
обычных файлов только из плоского
каталога текущего Project `projects/<project-id>/files/`. API работает с фактической рабочей
копией draft, не создаёт manifest, sidecar, YAML-сущность или отдельный реестр.

Все маршруты требуют обычную аутентификацию чтения и проверку владельца draft. `projectId`
проверяется как Project ID, затем сервер проверяет документ
`projects/<project-id>/project.yaml`. Имя файла является ровно одним Windows-совместимым сегментом;
разделители пути, включая percent-decoded `/` и `\`, запрещены. Symlink и не-обычные файлы не
открываются.

## Список и свойства

```http
GET /api/drafts/:draftId/projects/:projectId/files
```

Отсутствующий опциональный каталог `files/` возвращает успешный пустой список. Пример ответа:

```json
{
  "project_id": "P-26-MGP84K",
  "count": 1,
  "total_size_bytes": 1234,
  "items": [
    {
      "name": "ТЗ v3.pdf",
      "path": "projects/P-26-MGP84K/files/ТЗ v3.pdf",
      "size_bytes": 1234,
      "media_type": "application/pdf",
      "disposition": "inline",
      "modified_at": "2026-08-13T10:00:00.000Z",
      "modified_at_source": "working_copy_filesystem",
      "created_at": "2026-08-12T09:00:00.000Z",
      "created_at_source": "working_copy_filesystem"
    }
  ],
  "draft_fingerprint": "..."
}
```

`created_at` отсутствует, если файловая система не сообщает осмысленное birth time. Обе даты
являются свойствами текущей рабочей копии, а не устойчивыми датами Git. `count` и
`total_size_bytes` вычисляются по фактическим обычным файлам каталога.

## Открытие и скачивание

```http
GET /api/drafts/:draftId/projects/:projectId/files/:fileName/content
GET /api/drafts/:draftId/projects/:projectId/files/:fileName/download
```

`content` возвращает `Content-Disposition: inline` только для allowlist пассивных форматов:
PDF, PNG, JPEG, GIF, WebP, AVIF, BMP, plain text, Markdown и CSV. SVG, HTML, Office-документы,
архивы и неизвестные форматы возвращаются как `attachment`; опасный тип не угадывается по
содержимому. Маршрут `download` всегда возвращает `attachment`. Оба ответа используют
`X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, RFC 5987 UTF-8 filename и потоковую
выдачу из проверенного обычного file handle.

## Потоковая загрузка и замена содержимого

```http
POST /api/drafts/:draftId/projects/:projectId/files/upload
Content-Type: application/octet-stream
X-GitPM-File-Name: %D0%A2%D0%97%20v4.docx
X-GitPM-Upload-Size: 1234
X-GitPM-Expected-Fingerprint: <fingerprint>
X-GitPM-Upload-Mode: create

<необработанные байты файла>
```

Один запрос загружает один файл. Тело передаётся потоком как исходные байты, без JSON, base64 и
multipart-буферизации. `X-GitPM-File-Name` содержит результат JavaScript `encodeURIComponent`
для точного Unicode-имени; сервер декодирует его как UTF-8. `X-GitPM-Upload-Size` обязателен,
является точным количеством байтов и сверяется с реально прочитанным потоком. Сжатый
`Content-Encoding` не поддерживается.

Режим `create` возвращает `201` и никогда не перезаписывает существующий файл. При совпадении
имени без учёта регистра операция отклоняется. Режим `replace` возвращает `200`, требует
существующий обычный файл с точно таким же именем и заменяет только его содержимое. Успешный ответ:

```json
{
  "project_id": "P-26-MGP84K",
  "operation": "created",
  "item": {
    "name": "ТЗ v4.docx",
    "path": "projects/P-26-MGP84K/files/ТЗ v4.docx",
    "size_bytes": 1234,
    "media_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "disposition": "attachment",
    "modified_at": "2026-08-13T10:00:00.000Z",
    "modified_at_source": "working_copy_filesystem"
  },
  "draft_fingerprint": "..."
}
```

Маршрут доступен только ролям Developer и Maintainer, владельцу открытого draft в режиме записи
`ui`, и требует текущий fingerprint. Поток сначала записывается в уникальный target-local файл,
после чего публикуется без молчаливого overwrite. Временный файл и backup удаляются до полной
проверки репозитория и вычисления нового fingerprint; для возможного отката прежнее содержимое
удерживается открытым обычным file handle. При ошибке проверки новый файл удаляется, а прежнее
содержимое замены восстанавливается потоково. Успешная и неуспешная операция не оставляет manifest,
sidecar, реестр, backup или временный файл.

Для файла строго больше `50 * 1024 * 1024` байт обязателен дополнительный заголовок
`X-GitPM-Large-File-Confirmation` с тем же percent-encoded точным именем. Это порог осознанного
подтверждения, а не лимит. Отдельный настраиваемый эксплуатационный лимит по умолчанию равен 2 GiB;
его можно задать числом байтов через `GITPM_PROJECT_FILE_MAX_UPLOAD_BYTES` либо
`projectFileMaxUploadBytes` в `config.json`. Превышение возвращает `PROJECT_FILE_TOO_LARGE`.

## Переименование

```http
POST /api/drafts/:draftId/projects/:projectId/files/:fileName/rename
Content-Type: application/json

{
  "expected_fingerprint": "...",
  "new_name": "ТЗ v4.docx",
  "reference_mode": "ignore_unchecked"
}
```

Операция доступна только Developer и Maintainer, владельцу открытого draft в writer mode `ui`, и
требует текущий fingerprint. Исходное и новое имя являются точными именами одного сегмента; имя,
отличающееся от другого файла только регистром, считается конфликтом. Переименование только
регистра самого исходного файла поддерживается переносимо, в том числе на Windows. Одинаковые
`fileName` и `new_name` отклоняются как отсутствие изменения.

До этапа поддержки ссылок единственный допустимый `reference_mode` — `ignore_unchecked`. Он явно
означает, что сервер не искал и не переписывал `[[file:...]]`; ответ не выдаёт неподтверждённое
количество ссылок:

```json
{
  "project_id": "P-26-MGP84K",
  "operation": "renamed",
  "previous_name": "ТЗ v3.docx",
  "item": { "name": "ТЗ v4.docx", "path": "projects/P-26-MGP84K/files/ТЗ v4.docx" },
  "references": { "status": "not_checked" },
  "draft_fingerprint": "..."
}
```

Здесь `item` содержит тот же полный набор свойств, что элемент списка. Будущая версия сможет
добавить режим атомарного обновления ссылок и checked-результат без переосмысления текущего режима.

## Удаление из текущей версии

```http
DELETE /api/drafts/:draftId/projects/:projectId/files/:fileName
Content-Type: application/json

{
  "expected_fingerprint": "...",
  "confirmation_name": "ТЗ v4.docx",
  "reference_mode": "ignore_unchecked"
}
```

Права, owner, writer mode и fingerprint проверяются так же, как для переименования. Для удаления
нужно точно повторить имя с учётом регистра в `confirmation_name`. До реализации поиска ссылок
допустим только честный режим `ignore_unchecked`.

```json
{
  "project_id": "P-26-MGP84K",
  "operation": "deleted",
  "name": "ТЗ v4.docx",
  "path": "projects/P-26-MGP84K/files/ТЗ v4.docx",
  "size_bytes": 1234,
  "references": { "status": "not_checked" },
  "secure_erase": false,
  "draft_fingerprint": "..."
}
```

Удаление убирает файл только из текущей рабочей версии репозитория. `secure_erase: false` является
частью контракта: ранее закоммиченное содержимое может остаться в истории Git, а файловая система
и носитель также не гарантируют физическое стирание.

Обе операции проверяют identity каталогов и файлов до публикации, не следуют symlink, выполняют
полную `validateRepository` и откатываются при её ошибке. Для переносимого rollback исходный файл
переименовывается в уникальную внутреннюю Windows-совместимую transient-запись того же плоского
каталога; как и любой обычный Project file, validation считает её непрозрачным содержимым. При
rename новое имя публикуется из transient-записи через hard link без overwrite. Transient-запись
удаляется только при совпадении identity; внешне подменённый файл не удаляется. После штатного
успеха или
штатного отката внутренние записи не остаются. Если внешний процесс занял исходное имя или
подменил rollback-запись и восстановление нельзя выполнить без перезаписи чужого файла, сервер
возвращает `PROJECT_FILE_ROLLBACK_FAILED`. При занятом исходном имени GitPM не уничтожает ни чужой
файл, ни исходное содержимое: последнее остаётся во внутренней transient-записи для ручного
восстановления. Её repository-relative шаблон —
`projects/<project-id>/files/.gitpm-project-file-<uuid>.delete` для удаления и
`projects/<project-id>/files/.gitpm-project-file-<uuid>.rename` для переименования. Это единственный
допустимый аварийный остаток; обычный успех, обычная ошибка и успешный rollback не оставляют
transient-записей. Ответ и серверный журнал не раскрывают абсолютный filesystem path. Такая авария
требует ручного исправления рабочей копии; успешная полная validation после неё не обещается.

## Стабильные ошибки

| HTTP | Код | Значение |
| --- | --- | --- |
| 400 | `ENTITY_PROJECT_INVALID` | Некорректный Project ID. |
| 400 | `PROJECT_FILE_NAME_INVALID` | Имя не является допустимым одним файловым сегментом. |
| 400 | `PROJECT_FILE_UPLOAD_METADATA_INVALID` | Обязательный заголовок загрузки отсутствует, повреждён или имеет недопустимое значение. |
| 400 | `PROJECT_FILE_UPLOAD_SIZE_MISMATCH` | Фактический размер потока отличается от объявленного. |
| 403 | `DRAFT_FORBIDDEN` | Draft принадлежит другому пользователю. |
| 403 | `PROJECT_FILE_PATH_FORBIDDEN` | Путь содержит symlink, покидает границу Project или не может быть безопасно прочитан. |
| 404 | `ENTITY_NOT_FOUND` | Project отсутствует в текущем draft. |
| 404 | `PROJECT_FILE_NOT_FOUND` | Файл отсутствует в текущем Project. |
| 409 | `PROJECT_FILES_LAYOUT_INVALID` | В пользовательском каталоге найден не обычный файл или сам `files` не является каталогом. |
| 409 | `PROJECT_FILE_NOT_REGULAR` | Запрошенное имя существует, но не является обычным файлом. |
| 409 | `PROJECT_FILE_EXISTS` | `create` встретил существующий файл; нужна явная замена. |
| 409 | `PROJECT_FILE_NAME_CONFLICT` | Другое имя совпадает без учёта регистра. |
| 409 | `PROJECT_FILE_RENAME_NO_CHANGE` | Новое имя полностью совпадает с исходным. |
| 409 | `PROJECT_FILE_DELETE_CONFIRMATION_REQUIRED` | Для удаления не повторено точное имя файла. |
| 409 | `PROJECT_FILE_REFERENCES_UNSUPPORTED` | Запрошена проверка или правка ссылок, которой текущая версия ещё не поддерживает. |
| 409 | `PROJECT_FILE_LARGE_CONFIRMATION_REQUIRED` | Для файла больше 50 MiB не передано его точное имя-подтверждение. |
| 409 | `PROJECT_FILE_CHANGED_EXTERNALLY` | Файл или защищаемый путь изменился во время мутации. |
| 409 | `PROJECT_FILE_ROLLBACK_FAILED` | Исходный файл не удалось безопасно восстановить из-за внешнего изменения; чужой файл не перезаписывается. |
| 413 | `PROJECT_FILE_TOO_LARGE` | Файл превышает настроенный эксплуатационный лимит сервера. |
| 415 | `PROJECT_FILE_UPLOAD_CONTENT_TYPE_REQUIRED` | Загрузка требует `application/octet-stream`. |
| 422 | `PROJECT_FILE_VALIDATION_FAILED` | После операции полная проверка репозитория не прошла; операция откачена. |

Ошибки используют общий envelope `{ "error": { "code", "message", "correlation_id" } }`.
