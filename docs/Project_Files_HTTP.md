# Read-only HTTP API файлов Project

Контракт этапа 2 предоставляет список и безопасную выдачу обычных файлов только из плоского
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

## Стабильные ошибки

| HTTP | Код | Значение |
| --- | --- | --- |
| 400 | `ENTITY_PROJECT_INVALID` | Некорректный Project ID. |
| 400 | `PROJECT_FILE_NAME_INVALID` | Имя не является допустимым одним файловым сегментом. |
| 403 | `DRAFT_FORBIDDEN` | Draft принадлежит другому пользователю. |
| 403 | `PROJECT_FILE_PATH_FORBIDDEN` | Путь содержит symlink, покидает границу Project или не может быть безопасно прочитан. |
| 404 | `ENTITY_NOT_FOUND` | Project отсутствует в текущем draft. |
| 404 | `PROJECT_FILE_NOT_FOUND` | Файл отсутствует в текущем Project. |
| 409 | `PROJECT_FILES_LAYOUT_INVALID` | В пользовательском каталоге найден не обычный файл или сам `files` не является каталогом. |
| 409 | `PROJECT_FILE_NOT_REGULAR` | Запрошенное имя существует, но не является обычным файлом. |

Ошибки используют общий envelope `{ "error": { "code", "message", "correlation_id" } }`.
