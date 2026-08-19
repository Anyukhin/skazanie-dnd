# Базовая линия перед M0

Снято **2026-07-26** на коммите `b9c6c8f` ветки `agent/mvp-autonomous-campaign`,
до начала M0 из `docs/tactical-map-plan.md`.

M0 меняет форму сохранённых данных — это единственная работа в бэклоге,
способная испортить существующие кампании. Здесь записано, как всё выглядело
**до** изменений, чтобы после M0 сравнивать с конкретными числами, а не с
воспоминанием.

---

## Точка отката

Полная копия каталога `storage/`:

```
C:\Users\anton\PycharmProjects\Dnd-backups\storage-2026-07-26\
```

188 файлов, SHA-256 сверены пофайлово с оригиналом — расхождений нет.
Восстановление — обычное копирование обратно; ни ключа, ни кода проекта для
этого не нужно.

**Штатный `pnpm backup` для этого не использовался, потому что он не работает.**
Скрипт запускает `tools/storage-backup.mjs` без аргументов, а CLI требует
`create <storage-dir> <backup-file>` — на деле печатается usage и код возврата 1.
Сверх того `createStorageBackup` требует `DND_BACKUP_KEY` длиной не меньше
32 байт, а такой переменной нет ни в `.env`, ни в `.env.example`. Починка —
отдельная задача; пока команда в `AGENTS.md` §2 описывает несуществующее
поведение.

> **2026-08-18.** Починено: `pnpm backup` без аргументов снимает копию
> `storage` в `./backups/skazanie-<дата>.skzbackup`, `DND_BACKUP_KEY` заведён
> в `.env.example`, заметка в `AGENTS.md` §2 переписана. Абзац выше оставлен
> как есть — он объясняет, почему точка отката 2026-07-26 снята обычным
> копированием, а не штатной командой.

## Состояние проверок

| Команда | Код возврата | Что означает |
| --- | --- | --- |
| `pnpm test` | 0 | 551 тест, все зелёные |
| `pnpm typecheck:server` | 0 | три файла с `// @ts-check` |
| `pnpm build` | 0 | `tsc -p tsconfig.app.json` + `vite build` |
| `pnpm content:verify` | 0 | целостность контента в порядке |
| `pnpm cutover:audit` | 0 | `ready: true`, `blockers: []` |
| `pnpm cutover:verify` | 0 | то же в строгом режиме |
| `pnpm release:verify` | **2** | 22 release-блокера, см. ниже |

`release:verify` красный **по построению**, а не из-за регрессии: это покрытие
правил и неподтверждённые права на контент.

```
CONTAINER_DIGESTS_UNPINNED
COVERAGE:classes:partial, COVERAGE:equipment:partial, COVERAGE:feats:missing,
COVERAGE:glossary:partial, COVERAGE:monsters:partial, COVERAGE:spells:partial,
COVERAGE:subclasses:partial
DNDSU_RIGHTS_UNVERIFIED, FONT_PROVENANCE_UNVERIFIED, PROJECT_LICENSE_MISSING,
PUBLIC_ASSET_RIGHTS_UNVERIFIED
RIGHTS:data/dndsu-class-actions-1-12.json
RIGHTS:data/dndsu-class-build-rules-1-12.json
RIGHTS:data/dndsu-spell-mechanics-overrides.json
RIGHTS:data/dndsu-spells-0-6.json
RIGHTS:data/rule_packs/srd_5_2_1/coverage.yaml
RIGHTS:data/rule_packs/srd_5_2_1/glossary.csv
RIGHTS:data/rule_packs/srd_5_2_1/manifest.yaml
RIGHTS:data/rule_packs/srd_5_2_1/ontology_edges.jsonl
RIGHTS:data/rule_packs/srd_5_2_1/rules.jsonl
RIGHTS:public/assets
```

**После M0 в этом списке не должно появиться ни одной новой строки.**

## Расхождения room / snapshot / replay

`pnpm cutover:audit`: 7 кампаний, `ready: true`, `blockers: []`. У каждой
кампании версия комнаты, версия потока событий и версия после replay совпадают,
проекция и replay сходятся по SHA-256.

| Кампания | room | event | replay | projection_matched | replay_matched |
| --- | --- | --- | --- | --- | --- |
| `E2E-FIX-713` | 12 | 12 | 12 | true | true |
| `E2E-FIX-714` | 25 | 25 | 25 | true | true |
| `E2E-JUL13` | 52 | 52 | 52 | true | true |
| `QW12` | 9 | 9 | 9 | true | true |
| `RUNE-742` | 14 | 14 | 14 | true | true |
| `WORLD-02F89866` | 5 | 5 | 5 | true | true |
| `WORLD-98E6B8FB` | 6 | 6 | 6 | true | true |

**После M0 сравнивать именно с этим:** ни одна кампания не должна потерять
`projection_matched` или `replay_matched`, а число кампаний остаться равным 7.
Рост версий — нормально, расхождение версий между собой — нет.

## Тесты

**551 тест, 551 прошёл, 0 упало**, полный прогон около 140 секунд
(`node --test --test-concurrency=4`).

### Один тест нестабилен — это не регрессия

`test/mvp-player-cycle-api.test.mjs`, сценарий «обычные игроки проходят
автономную кампанию, полный бой, награды и три сцены» (~30 с) падает примерно в
половине прогонов. Проверено 2026-07-26 на серии запусков в основном дереве:
на **неизменённом** коде он дал 1 успех из 4, на изменённом — столько же.
Причина не в коде правок.

Падает каждый раз по-разному, всегда на движении или отдыхе после боя:

- `PATH_BLOCKED` — «До клетки назначения нет свободного пути»
- `SPEED_EXCEEDED` — «Недостаточно скорости для этого перемещения»
- `REST_ACTOR_INCAPACITATED` — «Отдых доступен только живому герою с хитами»

Карта здесь детерминирована: код кампании (`PLAYER-MVP`) и идентификаторы героев
в тесте зафиксированы, а seed считается от них. Недетерминированы **броски** —
тест поднимает настоящий сервер по HTTP без внедрённого Dice Service, поэтому
исход боя, а с ним позиции и остаток хитов, каждый раз разные.

**Практический вывод:** одиночное падение этого файла регрессией не считать —
перезапустить. Настоящая починка (детерминированный Dice Service в этом
сценарии) выходит за рамки подготовки к M0.

### Отдельно: замер в `git worktree` недействителен

Тот же тест в свежем `git worktree` прошёл 6 раз из 6. В репозитории
`core.autocrlf = true`, поэтому worktree выгружается с CRLF, и поведение
отличается от основного дерева. Сравнивать «до» и «до» нужно **в одном
каталоге**, иначе разница в переводах строк выдаёт себя за разницу в коде.
