# P14 localization acceptance

Date: 2026-07-13

Result: passed for the approved local deployment scope.

- Russian web UI was traversed through Drafts, Portfolio, Projects, Tasks, Board, People, Calendar, Repository settings, Workload, Gantt, Changes and History.
- The browser reported `lang=ru`, `dir=ltr`; the selected locale remained `ru` after reload.
- A representative validation state (`Ошибок: 2`) and a representative Git error were understandable in Russian.
- Russian date-only and decimal formatting were visible in Workload; duration and plural rules were verified in unit tests.
- Locale packs passed key, placeholder and raw-HTML checks. A synthetic third locale rendered through registry metadata without component changes.
- Changing locale produced no API payloads in the existing browser contract test.
- Per product-owner direction, CLI messages are not localized. CLI remains locale-neutral and has a dedicated UTF-8 Cyrillic round-trip test.

Artifacts:

- `localization-completeness-report.txt`
- `vfy-032-browser-transcript.txt`
- `cli-utf8-transcript.txt`
- `vfy-032-workload-ru.png`
- `vfy-032-git-error-ru.png`
