# Rust-сервер: правила работы

Дополняет корневой `AGENTS.md` (язык, секреты, инварианты, критерий готовности
действуют и здесь). Как переносить отдельный модуль JS — `rust/PORTING.md`;
причины и журнал решений — `docs/rust-rewrite-plan.md`; статус по модулям —
`rust/PORT-STATUS.md` (генерируется `node tools/rust-port-status.mjs`).

## 1. Статус и источник истины

- `rust/` — Cargo workspace, сервер `skazanie-server` (крейт `sk-server`).
  Все маршруты `server/index.mjs` перенесены. Контракт HTTP
  (`test/contract-rust.list`) зелёный в обоих режимах.
- **До переключения эталон — JS** (`server/*.mjs`). Rust повторяет его поведение:
  те же ветки, коды ошибок, русские тексты байт в байт. Отличие от JS —
  ошибка переноса. Баг JS переносится как есть и записывается в
  `docs/rust-port-js-findings.md`; исправляют его в обоих серверах вместе,
  отдельной задачей.
- **Переключение на 8787 решает только владелец** (`docs/rust-docker.md`).
  До него игра идёт на JS, а Rust поднимается рядом, на своём порту и своём
  хранилище.
- Правка поведения в `server/` до переключения переносится в `rust/` в той же
  ветке или отдельной задачей. На расхождение срабатывают контракт в режиме
  `rust`, корпус и эталоны с хешами файлов JS
  (`spell_acceptance_audit::fixture_matches_working_tree`,
  `route_lines_point_at_js_checks`).

## 2. Устройство сервера (решения, которые не пересматривать молча)

- **Диспетчер в порядке JS.** Маршруты — упорядоченная таблица
  `(метод, матчер, обработчик)` в порядке `index.mjs`, а не дерево axum.
  От порядка зависят проваливание вниз по списку, 404 вместо 405 и
  регулярки путей.
- **Однопоточное ядро** (`LocalSet`). Мутации кампании идут под её замком.
  Блокирующее (SQLite, scrypt, файлы) — через `spawn_blocking`. Рассылка SSE —
  после снятия замка.
- **Хранилище — SQLite в `DND_STORAGE_DIR`** (`sk-store`). Коммит, снимок и
  метаданные пишутся одной транзакцией. Ключ идемпотентности — уникальный
  индекс. Карты лежат по хешу.
- **Комната — проекция журнала плюс `room_overlays`**, второго хранилища
  комнаты нет. Версия комнаты монотонна и растёт в той же транзакции.
- **Модель видит только сервер.** Клиенты LLM собираются в `main.rs` (и в
  тестовом наборе) и в `AppState` попадают уже обёрнутыми в учёт расхода.
  Остальные крейты получают клиент внедрением.
- **Случайность — только через внедрённые кости** (`sk-dice`). Время — через
  внедрённые часы, где JS их внедряет.
- **Ожидание решения игрока — итог, а не ошибка** (урок 5). Публичный разбор
  (`sk-rules` `resolve::api`: `resolve_command`, `resolve_command_with_pauses`,
  `resolve_commands`, `RulesEngine`) отдаёт `Outcome::Committed` или
  `Outcome::Pending { resolved, prompt }` (`sk-rules/src/outcome.rs`: кто
  решает, варианты, срок, продолжение), а ошибка `Halt` — только отказ или
  сбой. События `Pending` коммитятся так же: окно реакции — событие. Внутри
  `resolve/` остановка — `Interrupt` (`Flow`) с паузой, вложенный разбор —
  `api::resolve_command_inner`; проверки и помощники вне разбора — `Halt`
  (`Step`). Ответ на окно — новая команда; внутри она повторяет остановленную
  команду по стенограмме костей (`Continuation::Replay`).
- **Тестовые крючки — только под фичей `test-hooks`**: подкоманды `journal`,
  `session`, `room`, `audit`, кости `DND_TEST_DICE_RULES` и сбои
  `DND_COMMIT_FAULTS`. Вне `NODE_ENV=test` и временного хранилища
  `skazanie-*` сервер с ними не стартует. Выпускной бинарь и Docker собираются
  без фичи.
- **Корень данных** (`data/`, `prompts/`, `public/`, `dist/`) — `DND_DATA_DIR`,
  иначе каталог бинаря, иначе корень репозитория сборки
  (`sk_core::data_root`).
- **Отметка писателя storage.** Два сервера на одном хранилище не стартуют.
  Если в каталоге лежат файлы JS, а база пуста, запуск получает отказ с
  подсказкой `import-legacy`.
- **Статус механики — тип.** `sk_core::MechanicsSupport` (`verified`,
  `partial`, `heuristic`, `ruling-only`) — единственный словарь статусов
  карточек заклинаний, действий, предметов и листов NPC; сравнивать статус
  строкой нельзя. Встроенные каталоги разбирают статус строго при загрузке
  (`load_spell_cards`, `action()`, `item_catalog_from_entries`): опечатка —
  отказ с именем карточки. Карточка из состояния или команды разбирается
  мягко (`MechanicsSupport::of`): чужое значение — не исполнимое. Обработчики
  исполнения (`resolve::spell::Cast`, `resolve::combat_action::Act`,
  `MagicMissile`) принимают `sk_rules::executable::Executable`, который
  выдаёт только `Executable::admit` на границе команды — с прежними отказами
  `MECHANICS_NOT_VERIFIED` и `RULING_REQUIRED`. Новый обработчик карточки
  берёт `Executable`, а не `&Value`. Сводки каталогов —
  `spell_catalog_census`, `combat_action_catalog_census`, `item_catalog_census`.
- **Быстродействие.** Мемо нормализации (`sk-rules` `normalize::fixed_point`)
  держится на том, что нормализация — чистая функция входа и режима
  хранения. Новое скрытое состояние в нормализаторе это ломает. Бюджеты
  горячего пути — `sk-server/tests/hot_path_budget.rs`, замер против JS —
  `bench/hot-path.mjs`.

## 3. Крейты

Крейт на слой; граф без циклов. Корень — `sk-core`: приведения JS — `js::*`,
`stringify`, корень данных. Опорные крейты:

| Крейт | Что |
| --- | --- |
| `sk-rules` | Rules Engine: `validateCommand`, `resolveCommand`, редьюсер, replay |
| `sk-store` | SQLite: журнал, аккаунты, комнаты, карты, перенос старого storage (`legacy.rs`) |
| `sk-projection` | что видит игрок |
| `sk-tactics` | права, свободное действие, прогноз боя, `cutover_audit` |
| `sk-turns`, `sk-orchestrator` | ход NPC, цикл `/api/narrate`, автономный Режиссёр |
| `sk-agents`, `sk-agents-base` | роли модели и их промпты |
| `sk-server` | HTTP, маршруты, CLI, тестовые крючки |
| `sk-corpus` | сверка с корпусом записей JS (не входит в сервер) |

Остальные крейты повторяют модули `server/*.mjs` по смыслу имени; какой
JS-файл переносит модуль, сказано в его `//!`-шапке.

## 4. Команды

Из каталога `rust/`, если не сказано иное. **Только `--release`**: на машине
владельца отладочные тестовые exe блокирует Smart App Control.

```bash
cargo build --release --workspace --all-targets --locked
cargo test --release -p sk-<крейт> --no-fail-fast       # точечно, как node --test
cargo run --release -p sk-corpus -- reducer ../tmp/corpus-v2
cargo run --release -p sk-corpus -- resolve ../tmp/corpus-v2 all
cargo build --release -p sk-server --features test-hooks --bin skazanie-server
```

Из корня репозитория:

```bash
pnpm rust:play                      # сыграть: сервер на 8788, хранилище tmp/rust-play/storage
pnpm rust:play -- --offline         # то же без модели
pnpm test:contract:rust             # контракт HTTP против Rust; нужен SKAZANIE_RUST_SERVER_BIN
pnpm test:contract:js               # тот же контракт против JS
node bench/hot-path.mjs             # замер горячего пути Rust против JS
node tools/rust-port-status.mjs     # обновить rust/PORT-STATUS.md
node eval/soak-parity.mjs           # боевой стенд одним сидом против JS и Rust; код 1 — расхождение
```

- Ночной CI (`.github/workflows/rust-nightly.yml`, с ветки по умолчанию или
  кнопкой Run workflow): паритет боевого стенда и Асстохан без модели на сидах
  2–3 против Rust. Образ `Dockerfile.rust` собирается и отвечает на
  `/api/health` в задаче `docker` workflow `rust.yml`.

- `SKAZANIE_RUST_SERVER_BIN` — бинарь, собранный с `--features test-hooks`.
- Перенос старого хранилища:
  `skazanie-server import-legacy --from <storage JS> --to <новое> --dry-run`
  (справка — `--help`). Импорт делается только с копии: настоящее `storage/`
  не читать и не копировать без владельца. После импорта —
  `skazanie-server audit-storage --storage <каталог>` (только чтение; 0 —
  чисто, 1 — расхождения, 3 — отказ: нет базы или на хранилище работает сервер).
- Docker: `Dockerfile.rust`, `compose.rust.yaml` (порт 8788, свой том) —
  `docs/rust-docker.md`. Docker поднимает только владелец.
- Эталоны JS: `rust/crates/sk-*/fixtures/gen-*.mjs`, первая строка —
  `import '../../../fixtures-env.mjs'`. После правки JS, на который смотрит
  эталон, его пересоздают тем же скриптом.

## 5. Проверка перед слиянием в ветку переноса

| Изменение | Что прогнать |
| --- | --- |
| крейт | `cargo test --release -p <крейт>`; сборка без предупреждений |
| правило, редьюсер, нормализация | корпус: `reducer` — без новых расхождений; `resolve … all` — те же известные 11 |
| маршрут, проекция, права | контракт в обоих режимах (`rust` и `js`) с бинарём `test-hooks` |
| горячий путь | `hot_path_budget` отдельно от остального: под нагрузкой он краснеет по времени |
| слияние `main` | всё выше. JS-сторона `main` переносится в Rust в той же волне |

Известные расхождения корпуса v2 (7 `MakeAbilityCheck`, 3 `AdvanceScene`,
1 `UseCombatAction`) — пробелы записи корпуса, а не переноса
(`docs/rust-port-js-findings.md`). Новое расхождение — ошибка, пока не
доказано обратное.

## 6. Безопасность запусков

- Тестовый сервер — всегда с явным `AGENT_PORT` (не 8787) и временным
  `DND_STORAGE_DIR`. После прогона порт 8787 должен быть свободен от наших
  процессов.
- Бинарь сервера не запускать из тестовых скриптов без `timeout`.
- Ключ модели проверяется только на наличие; `--live` и `--judge` прогоны —
  по просьбе владельца.
- `target/` worktree после слияния его ветки удалять: сборки занимают
  десятки гигабайт.
