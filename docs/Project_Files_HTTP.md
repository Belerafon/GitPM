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
X-GitPM-Reference-Mode: preserve_checked

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

Для exact `replace` пользовательский flow передаёт `X-GitPM-Reference-Mode: preserve_checked`.
Сервер повторно считает ссылки внутри mutation непосредственно перед успехом и возвращает
`references.status: checked`, `action: preserved`, `before_count`, `affected_count: 0`,
`remaining_count` и project-scoped `locations`. Для `create` этот режим отклоняется. Отсутствующий
заголовок сохраняет совместимый честный ответ `{ "status": "not_checked" }`.

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
  "references": { "status": "not_checked" },
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

## Атомарная замена выбранного файла

```http
POST /api/drafts/:draftId/projects/:projectId/files/:fileName/replace
Content-Type: application/octet-stream
X-GitPM-File-Name: <percent-encoded new local file name>
X-GitPM-Upload-Size: <exact byte count>
X-GitPM-Expected-Fingerprint: <fingerprint>
X-GitPM-Large-File-Confirmation: <exact new name, only above 50 MiB>

<raw replacement bytes>
```

Этот отдельный маршрут атомарно заменяет выбранный `fileName`. Новое имя может совпадать с
прежним или отличаться от него. При совпадении содержимое заменяется, а финально пересчитанные
ссылки получают `action: preserved`. При другом имени exact-ссылки текущего Project переписываются
на новое имя и ответ получает `action: updated`; после полной repository validation старых ссылок
не должно остаться. Имя, занятое другим файлом без учёта регистра, возвращает
`PROJECT_FILE_NAME_CONFLICT` без изменения файлов.

Операция целиком выполняется одной `withUiMutation`: проверяются текущий fingerprint, владелец,
writer mode, роль Developer/Maintainer и Project scope. Исходное содержимое проверяется потоковым
digest, поэтому in-place изменение во время передачи не затирается. До успеха сохраняются точные
байты исходного файла и YAML; любая ошибка запускает best-effort rollback всех журналов. Чужой
изменившийся recovery target не перезаписывается и приводит к `PROJECT_FILE_ROLLBACK_FAILED`.
Успешный ответ имеет `operation: "replaced"`, `previous_name`, полный `item`, обязательный checked
итог `references` и новый `draft_fingerprint`.

## Предварительная проверка ссылок

```http
GET /api/drafts/:draftId/projects/:projectId/files/:fileName/references
```

Ответ содержит `status: checked`, точные `count` и `locations` (тип и ID сущности, канонический
repository-relative path, поле, optional index критерия и UTF-16 offsets), а также текущий
`draft_fingerprint`. Preview advisory: каждая мутация заново считает ссылки после проверки
fingerprint внутри `withUiMutation`; неизвестное или ошибочное состояние нельзя считать нулём.

## Переименование

```http
POST /api/drafts/:draftId/projects/:projectId/files/:fileName/rename
Content-Type: application/json

{
  "expected_fingerprint": "...",
  "new_name": "ТЗ v4.docx",
  "reference_mode": "update"
}
```

Операция доступна только Developer и Maintainer, владельцу открытого draft в writer mode `ui`, и
требует текущий fingerprint. Исходное и новое имя являются точными именами одного сегмента; имя,
отличающееся от другого файла только регистром, считается конфликтом. Переименование только
регистра самого исходного файла поддерживается переносимо, в том числе на Windows. Одинаковые
`fileName` и `new_name` отклоняются как отсутствие изменения.

`reference_mode: update` атомарно заменяет exact tokens на канонический `[[file:<new_name>]]` во
всех поддерживаемых Markdown-полях текущего Project. `keep` осознанно оставляет старые, теперь
сломанные ссылки. Совместимый `ignore_unchecked` сохраняет старое поведение и `not_checked`.

```json
{
  "project_id": "P-26-MGP84K",
  "operation": "renamed",
  "previous_name": "ТЗ v3.docx",
  "item": { "name": "ТЗ v4.docx", "path": "projects/P-26-MGP84K/files/ТЗ v4.docx" },
  "references": { "status": "checked", "action": "updated", "before_count": 3, "affected_count": 3, "remaining_count": 0, "locations": [] },
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
  "reference_mode": "restrict"
}
```

Права, owner, writer mode и fingerprint проверяются так же, как для переименования. Для удаления
нужно точно повторить имя с учётом регистра в `confirmation_name`. `restrict` блокирует удаление
кодом `PROJECT_FILE_DELETE_REFERENCED`, если найдено хотя бы одно использование. `unlink` заменяет
каждый exact token decoded видимым именем файла как plain text и затем удаляет файл. Совместимый
`ignore_unchecked` ничего не утверждает о ссылках.

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
| 409 | `PROJECT_FILE_DELETE_REFERENCED` | `restrict` обнаружил ссылки; требуется явный `unlink` либо отмена. |
| 409 | `PROJECT_FILE_REFERENCES_CHANGED` | YAML-документ или набор ссылок изменился во время атомарной операции. |
| 409 | `PROJECT_FILE_LARGE_CONFIRMATION_REQUIRED` | Для файла больше 50 MiB не передано его точное имя-подтверждение. |
| 409 | `PROJECT_FILE_CHANGED_EXTERNALLY` | Файл или защищаемый путь изменился во время мутации. |
| 409 | `PROJECT_FILE_ROLLBACK_FAILED` | Исходный файл не удалось безопасно восстановить из-за внешнего изменения; чужой файл не перезаписывается. |
| 413 | `PROJECT_FILE_TOO_LARGE` | Файл превышает настроенный эксплуатационный лимит сервера. |
| 415 | `PROJECT_FILE_UPLOAD_CONTENT_TYPE_REQUIRED` | Загрузка требует `application/octet-stream`. |
| 422 | `PROJECT_FILE_VALIDATION_FAILED` | После операции полная проверка репозитория не прошла; операция откачена. |

Ошибки используют общий envelope `{ "error": { "code", "message", "correlation_id" } }`.

## Отображение в Changes

`GET /api/drafts/:draftId/changes` сохраняет обычный массив `files` с Git diff и дополнительно
возвращает обязательный locale-neutral массив `project_files`. Каждый его элемент содержит
`project_id`, текущие `path` и `name`, `operation` (`Added`, `Modified`, `Replaced`, `Renamed` или
`Deleted`) и проверенный по содержимому `content_kind` (`text`, `binary` или `unknown`). Для
доказанного переименования также возвращаются `previous_path` и `previous_name`.

Тип содержимого определяется ограниченными чтением и строгим UTF-8 decoding, а не расширением.
Для добавленного текста размером не более 1 MiB проверяется всё содержимое и строится обычный
Git-compatible diff. Более крупное содержимое с текстовым началом получает честный `unknown` и
существующий `oversized`, потому что образец не доказывает отсутствие бинарных байтов позже;
очевидные бинарные байты в строковый DTO не декодируются. Изменённый и удалённый текст сохраняет
обычный `git diff --no-textconv`, а его штатный binary marker имеет приоритет при классификации.

Штатная рабочая копия не индексирует файл только ради распознавания rename. Git обычно показывает
внешний unstaged move как delete + untracked add. Поэтому `Renamed` сообщается только для явного
porcelain rename либо единственной пары в том же Project с одинаковым Git blob identity. Если
содержимое одновременно изменено и связь нельзя доказать без manifest/sidecar, контракт честно
возвращает отдельные `Deleted` и `Added`. Перенос между Project никогда не объединяется в rename.
Вложенные, невалидные или неоднозначные внешние пути не попадают в `project_files`: они остаются в
`unclassified_files` и в отчёте полной repository validation.
