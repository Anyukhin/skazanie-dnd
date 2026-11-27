# Архив: JS-сервер «Сказания»

С 2026-11-27 сервер игры один — Rust (`rust/`, бинарь `skazanie-server`).
Здесь лежит то, что было нужно только прежнему JS-серверу. Пути внутри
архива повторяют пути в репозитории: `archive/js-server/server/index.mjs` —
это бывший `server/index.mjs`.

**Архив не запускается.** Импорты в его файлах указывают на соседей по
прежнему дереву, а часть соседей осталась в живом `server/`. Рабочее состояние
JS-сервера целиком — коммит `c7b065c4` (последний `main` до архива):

```bash
git worktree add ../Dnd-js-server c7b065c4
```

Игру из такой копии на 8787 не поднимать: там идёт игра владельца на Rust, а
сыгранное на Rust обратно в JS не переносится (`AGENTS.md` §9).

## Что здесь

| Каталог | Что | Чем заменено |
| --- | --- | --- |
| `server/` | HTTP-сервер (`index.mjs`, `routes/`, `dev.mjs`), миграции файлового хранилища, модули, которые читал только сервер (поток повествования, учёт расхода, роли модели `lore-voice`, `npc-social-controller`, `campaign-recap` и др.) | крейты `rust/` — модуль с тем же смыслом имени, его `//!`-шапка называет этот файл |
| `test/` | тесты JS-сервера и его модулей (≈460 файлов) | тесты крейтов `rust/crates/*/tests` и контракт HTTP `test/contract-rust.list` |
| `tools/` | `audit-cutover`, `audit-ruleset-cutover`, `recover-world-memory`, сверки переноса (`corpus-after-states`, `export-rust-tables`, `rust-js-line-refs`, `rust-port-status`) | `skazanie-server audit-storage`, `check-content` |
| `eval/` | стенды, поднимавшие JS-сервер, и паритет боёв JS против Rust (`soak-parity`) | `eval/combat-http-soak.mjs`, `eval/astohan-seeds.mjs` на Rust |
| `rust/` | генераторы эталонов Rust (`gen-*.mjs`, `capture-*.mjs`, `fixtures-env.mjs`) | эталоны `rust/crates/*/fixtures/*.json(.gz)` заморожены: Rust теперь сам эталон |
| `Dockerfile`, `compose.yaml` | образ и Compose JS-сервера | `Dockerfile.rust`, `compose.rust.yaml` |
| `tsconfig.server.json` | проверка JSDoc-типов сервера (`pnpm typecheck:server`) | — |

Проект Compose прежнего контейнера (`archive/js-server/compose.yaml` с
`--project-directory .`) лаунчеры используют только чтобы погасить его, если
он ещё жив и держит 8787.

## Что осталось живым

- `server/` — замороженная JS-библиотека: правила, карты и каталоги, которые
  читают клиент, инструменты контента, стенды и контрактные тесты
  (`server/README.md`).
- `test/` — тесты клиента и инструментов (`pnpm test`) и контракт HTTP против
  Rust (`pnpm test:contract`).
- `tools/rust-cutover.ps1` — разовый перенос файлового `storage/` JS в базу
  Rust (`docs/rust-docker.md`).

Что ещё предстоит перенести с JS на Rust (контракт на чистый HTTP, инструменты
контента, бэкап базы) — `docs/audit-2026-11-27-plan.md`, волна «Rust-only,
этап 2».
