# План переноса маршрутов sk-server на Rust

Я только читал файлы. Серверы не запускал, `storage/` и `.env` не трогал. План опирается на разбор маршрутов из задания. Отдельно я сверил его с деревом worktree `C:/Users/anton/PycharmProjects/Dnd-narrator-live`:

- `rust/crates/sk-server/src/*.rs` — 707 строк;
- `rust/crates/sk-server/Cargo.toml` — зависит только от sk-core и sk-store;
- `rust/crates/sk-orchestrator/src/{game,autonomous}_orchestrator.rs` — по одной строке;
- `rust/crates/sk-turns/src/{npc_turn_scheduler,combat_turn_coordinator}.rs` — по одной строке (`PORT-STATUS.md:52` «в работе Н1»);
- `server/store.mjs:438–477` — комнаты;
- матчеры диспетчера `server/index.mjs:3931–6010`.

**Важная поправка к вводным.** Кроме О1 и О2 есть третий блокер: крейт `sk-turns` не перенесён. Через `settleCombatContinuation` (`index.mjs:3352–3363`) от него зависят три маршрута: `encounters/assemble` (5397), `/commands` (5785) и `system-tick` (5973). От него же зависит `combatTurnCoordinator.hold/nudge` (5762, 6497).

---

## 0. Архитектурные решения, которые принимает ведущий до С0

**1. Диспетчер по порядку JS, а не дерево axum.** Axum остаётся транспортом: один обработчик на всё плюс `security_layer`. Внутри стоит упорядоченная таблица `(метод, матчер, обработчик)` в порядке `index.mjs`. Так одним механизмом получаем паритет в пяти местах:

- **Проваливание вниз по списку.** Пример: `merchantLifecycleMatch` проверяется только для `POST` (5223). При `GET .../merchants/commands` JS идёт дальше, к `merchantMatch` (5449), и там `merchant_id` становится `'commands'`.
- **Наборы символов в регулярках.** `[A-Za-z0-9-]+`, `[^/]+`, `[A-Za-z0-9._:-]+`, у админа `[a-f0-9-]+` без длины. В axum `{id}` пропускает любые символы.
- **Сырой `req.url` против `pathname`.** 11 маршрутов с `?query` отвечают 404.
- **Ответы на неверный метод.** Вместо 405 с пустым телом — 404 JSON «API endpoint не найден» (6477). `HEAD /api/*` тоже даёт 404, а не-API `POST` отдаёт клиента (6478).
- **Порядок проверок.** `characterCreation` (3931) идёт раньше health; combat-lab и map-import (3958–3959) — раньше speech и auth.

**2. Комната — проекция, а не второе хранилище.** Это продолжает решение `docs/rust-rewrite-plan.md:43–51, 318–323`; окончательно его утверждает владелец, см. §4. Состав:

- `room.state` = состояние из `EventStore::load` плюс накладка: поля только комнаты, летопись `messages` (не больше 400), `isNarrating:false` (`store.mjs:458`).
- `room.version` — монотонный счётчик в таблице накладки. Он растёт при подтверждении проекции и при записи в летопись, в той же транзакции SQLite (`EventStore::with_connection_mut`).
- `onRoomSaved` (`store.mjs:438–470`) становится внутренним хуком «проекция записана». На него подписаны рассылка, часы и зацепки героев.

**3. Конкурентность.** JS однопоточный, Rust нет. Поэтому:

- все мутирующие маршруты кампании идут под асинхронным замком кампании;
- блокирующие вызовы (EventStore, Accounts/scrypt, `RollRegistry::persist`, чтение файлов) — только через `spawn_blocking`;
- рассылку SSE запускать **после** снятия замка кампании: замок потока не должен вызывать сам себя (`narration_stream.rs:211–276`).

**4. Модель видит только сервер.** Клиенты LLM и картинок собираются только в `main.rs` и в тестовом наборе, а в `AppState` попадают уже обёрнутыми в `MeteredLLMClient`. Это правило AGENTS §4 про `llm-client`.

---

## 1. Каркас С0 (делает ведущий)

### Файлы в `rust/crates/sk-server/src/`

| Файл | Что в нём | Из JS (`server/index.mjs`) |
|---|---|---|
| `config.rs` | `Config::from_env` для всех переменных и `Config::for_tests(dir)` без чтения окружения. `ROUTERAI_API_KEY` и `ROUTERAI_BASE_URL` читаются явно и передаются в `RouterAiClientConfig` | 202–231; переменные: AGENT_*, ROUTERAI_*, DND_AI_* (8 шт.), DND_COMBAT_TURN_TIMEOUT_MS, DND_IMAGE_MODEL, DND_RUNTIME_IMAGE_GENERATION, DND_ARCHITECT_ALERT_THRESHOLD, DND_DEFAULT_RULESET_ID, DND_MAP_LIBRARY, DND_RECAP_GAP_HOURS, COOKIE_SECURE, DND_STORAGE_DIR, ADMIN_SETUP_TOKEN, DND_WHISPER_* |
| `state.rs` | Расширенный `AppState`; сборка в `AppState::open(config, Injected{dice, llm, image, clock})` | 236–467, 2895–2903, 2971–2974, 2997–3010 |
| `dispatch.rs` | Упорядоченная таблица маршрутов и `Matcher` (`Raw` для сырого url, `Path` для pathname, регулярка JS как ручной разбор сегментов). 404 для `/api`, иначе статика | 3919–3930, 6477–6480 |
| `boundary.rs` | Последняя граница: перехват паники и `JoinError` из `spawn_blocking` дают 500 `{error:'Внутренняя ошибка сервера', code:'INTERNAL_ERROR'}`. Ошибки тела дают 400. В лог идут метод и путь без query. Начатый SSE закрывается | 3885–3917 |
| `error.rs` | `ApiError {status, error, code, extra}` реализует `IntoResponse`. `From` для `StoreError`, `ExecutorError`, `RollRegistryError`, `BodyError`, `RuleError`, `AccountError`. Помощник `status_by(code, conflict_codes, forbidden_codes, …)`, потому что у каждого маршрута свой список кодов | 638–642, 3887, 5922–5925, 6472 |
| `access.rs` | `require_user` и `require_admin` (переезжают из `auth.rs`), `campaign_membership`, `campaign_hero_ids`, `can_use_hero`, `can_manage_campaign_assets`, `can_access_room` с запасным путём старых кампаний, `access_denied_before_reconcile`, `owned_viewer_actor_id`, `assigned_campaign_hero_ids`, `party_hero_ids`, `viewer_state_for` (`campaign_state_for_viewer` + `combat_forecast_view`) | 498–526, 2275–2324, 2478–2562 (кроме подключённых героев, это трейт `Presence` из `streams.rs`) |
| `idempotency.rs` | Ключ берётся по порядку: тело, заголовок `x-idempotency-key`, иначе uuid v4; есть вариант `required` (400 `IDEMPOTENCY_KEY_REQUIRED`, предел 200). Правило «сначала права на дубликат, потом сравнение отпечатка» — общим помощником | 4297, 4324, 4705–4712, 4914–4920, 5235–5237, 6197 |
| `limits.rs` | `exceeds_rate(kind, user)` (`costlyRequests`) и `rate_limited(addr)` | 2894–2903 |
| `blocking.rs` | `run_blocking(&state, f)` и `campaign_lock(id)`: карта `tokio::sync::Mutex` по кампаниям | — |
| `http.rs` | Правка: предел тела считается в UTF-16 единицах, как `raw.length` в JS, с жёстким потолком 4 МБ в байтах. Добавить `read_raw_body` для WAV | 2905–2922 |
| `auth.rs` | Правки паритета. Ошибка `create_session` и `user_for_token` даёт 500 `INTERNAL_ERROR`, а не `None`. Проверка id совпадает с регуляркой JS (длину не ограничивать). scrypt идёт через `spawn_blocking`. Добавить вызовы `state.streams.revoke_for_session(key)` и `refresh_for_user(id)`; их реализует С9, в С0 это заглушка | 3970–4024 (4007, 4023) |
| `routes/mod.rs` | Объявление всех модулей маршрутов и `pub fn table() -> Vec<Route>` в порядке JS. **Каждый `routes/*.rs` создаётся пустым** (`pub fn routes() -> Vec<Route> { vec![] }`), чтобы исполнители не трогали общие файлы | — |
| `streams.rs` (заглушка) | Трейты `StreamRegistry` и `Presence`, пустые реализации | — |
| `room.rs`, `journal.rs`, `projection.rs` (заглушки) | Сигнатуры для С1: `get_room`, `latest_campaign_state`, `persist_authoritative_projection`, `append_room_journal`, `reconcile_campaign_projection`, хук `on_projection_saved` | — |
| `main.rs` | Порядок: `claim_storage_writer` до `AppState::open`; `tokio::signal` (ctrl_c и SIGTERM) с плавной остановкой и снятием отметки, коды 130 и 143; keep-alive 65 с и headers-timeout 66 с; затем `reconcile_all` (С1) и `release_orphan_reservations`; фоновые задачи через 250 мс | 236–240, 6481–6505 |

### `AppState`

Поля:

- `config`;
- `accounts`;
- `events: Arc<EventStore>` — `GameReducer`, `with_map_cells(TacticalMapCells)`, один файл `skazanie.sqlite`;
- `rolls: Mutex<RollRegistry>` — файл `engine/roll-registry.json`;
- `dice: Arc<dyn Dice>`;
- `ledger: Arc<DurableUsageLedger>` и `architect_usage`;
- `llm: Option<Arc<FallbackLlmClient>>` — по одному metered-клиенту на модель; `lore_llm` с тайм-аутом 30 с;
- генераторы картинок 1:1 и 16:9;
- `rule_packs`, `retriever`, `installed_profiles` — с отказом при старте, как 312–324;
- `trace_store` — `storage/turn-traces`;
- `clarifications` — реестр из `sk-narration-base`; оркестратору О2 его передают внедрением;
- `post_commit: PostCommitCoordinator` — стадии подключаются позже;
- `portraits` и `illustrations`;
- `combat_lab_runs`;
- `streams`, `costly`, `login_attempts`, `campaign_locks`, `bg: JoinSet` (с остановкой).

### Тестовый набор С0

Минимальный набор, полный делает С2: в `tests/kit/mod.rs` — `TestServer::start` (oneshot), `Client` с cookie, `ForbiddenLlm`, `FixedRng`. Обязательные тесты С0:

- 404 на неверный метод;
- `HEAD /api/health` даёт 404;
- `?q` на сыром маршруте даёт 404;
- паника в тестовом маршруте `#[cfg(test)]` даёт 500 `INTERNAL_ERROR`, и следующий запрос проходит;
- тела `null`, `[]`, `42`, `"x"`, `true` дают `INVALID_JSON_BODY`, а login принимает `null` (3995);
- 1 000 001 символ кириллицы — `REQUEST_TOO_LARGE`, 999 999 — проходит;
- 429 через `Extension(ConnectInfo)`;
- `PATCH /api/admin/users/{id}`.

### Зависимости С0 (решение владельца)

- `sk-infra`, `sk-rulepack`, `sk-ruleset`, `sk-tactics`, `sk-tactical`, `sk-projection`, `sk-agents-base`, `sk-narration-base`, `sk-dice`, `sk-society` — по пути.
- `uuid` и `sha2` есть в workspace (`rust/Cargo.toml:17,20`).
- `futures-util` нужен для тела SSE.
- `hyper-util`: `axum::serve` не настраивает тайм-ауты keep-alive и заголовков (65 и 66 с), а `hyper_util::server::conn::auto::Builder` настраивает.
- `tower-http` с фичами `catch-panic` и `limit` — по желанию; без него `boundary.rs` делает то же своими силами через `tokio::spawn`.

Объём С0 — около 1200–1500 строк Rust.

---

## 2. Задачи С1…С22

Обозначения в колонке «Паритет»:

- **Г** — эталон `rust/crates/sk-server/fixtures/gen-<имя>.mjs`. Скрипт импортирует `rust/fixtures-env.mjs`, поднимает JS-сервер через `test/kit` на временном storage: пустой ключ, детерминированные кости, `--import rust/fixtures-env.mjs` для самого сервера ради локали. Он гоняет сценарий и пишет `fixtures/<имя>.json` с полями `{method, path, headers, body, status, body_norm}`. Нормализатор маскирует токены, cookie, invite, uuid, `*At`/`*_at` и `updatedAt`. Детерминированные `event_id` (sha256 от campaign и key) не маскируются. Тест `tests/<имя>_golden.rs` прогоняет тот же сценарий через кит и сравнивает.
- **К** — контрактные JS-тесты против бинаря Rust (`SKAZANIE_SERVER_IMPL=rust`, задача С3); файл добавляется в список `test/contract-rust.list`.

### Волна 0 — основа

| # | Задача | JS (строки) | Rust-файлы | Зависит | Объём JS→Rust | Паритет |
|---|---|---|---|---|---|---|
| **С1** | Комната, летопись, проекция, сверка, резервы бросков | `store.mjs` 438–477; `index.mjs` 2074–2117 (id сообщений, `playerNote*`, `recentNarratorTexts`), 2118–2252 (`journalEntry`, `appendRoomJournal`: 3 попытки, 400), 3012–3019 (`latestCampaignState`), 3365–3496 (`persistAuthoritativeProjection`, `journalCandidatesFor`, SEC-02 hash 3404–3416, удаление снятых полей 3447–3449), 3497–3594 (reconcile, `enableDefaultHouseRules`, reconcileAll с изоляцией ошибки кампании 3574–3582), 3595–3621 (резервы), 3622–3695 (`persistInteractionProjection`, `expirePartyDecisionIfNeeded`, `reconcilePartyDecisionPresence` через трейт `Presence`) | `room.rs`, `journal.rs`, `projection.rs`, `startup.rs` | С0 | ~750 → 1300 | Г: последовательности «коммит → проекция → летопись» с `room.version`. К: `room-projection-equivalence`, `snapshot-projector-version`. Rust-тесты: конфликт версии накладки, 400 записей, сбой одной кампании при reconcileAll |
| **С2** | Тестовый набор Rust | шаблон `test/kit/http.mjs:334–426`, `llm.mjs:151–291` | `tests/kit/{mod,client,dice,llm,fake_provider,golden}.rs`, `src/test_hooks.rs` (фича `test-hooks`: `DND_TEST_DICE_RULES`, `DND_COMMIT_FAULTS` только при `NODE_ENV=test` и storage в tmp), подкоманда `skazanie-server journal --storage --campaign` | С0 | — → ~900 | Сторож: тестовый `Config` не наследует `ROUTERAI_*`; каждый клиент в `AppState` — metered |
| **С3** | Контрактный режим JS-кита (правит `test/`, нужно право от владельца) | `test/kit/http.mjs:130–230`; ~65 своих копий spawn → `startTestServer`; кости и сбои в виде данных (`test/fixtures/*.dice.json`); `readJournal(server, code)`; `corruptCampaign(server, code, 'tail'\|'seed')`; расширение `test-network-isolation` на бинарь; `pnpm test:contract:rust` | `test/kit/*`, `test/*.test.mjs` (механически), `package.json` (скрипт) | нет, можно начать сразу | ~65 файлов | JS-корпус зелёный в режиме `js` до и после замены |

### Волна 1 — после С0; маршруты, которым нужна комната, — после С1

| # | Задача | JS (строки) | Rust | Зависит | Объём | Паритет |
|---|---|---|---|---|---|---|
| **С4** | Служебные маршруты и справочники: полный health (`configured` по ключу, `model`, `models`, `fallbackModels`, `rulesetId`, `ruleCount`, `installedRulesets`, `characterCreation`), `admin/usage`, speech status и transcribe (WAV), `rulesets/:id/character-creation`, `rules/search`, `world-templates`, `engine-mode` → 410 | 3931–3969, 4425–4442, 5216–5220 | `routes/service.rs`, `routes/catalog.rs` | С0 | ~85 → 250 | Г: health, каталоги, поиск. К: `api-integration` (часть), `world-template-api` (GET). **Сначала JS-тест на ките для speech** |
| **С5** | Боевой стенд администратора | `routes/combat-lab-routes.mjs` 1–86; `index.mjs` 340–344, 3958 | `routes/combat_lab.rs` (прогоны — фоновые задачи `tokio`, `DELETE` даёт 202, `report` — вложение, 405 только для `report`) | С0 | ~90 → 250 | К: `combat-lab-observer-api`. Г: scenarios, catalog, assess, generate |
| **С6** | Кампании, членство, рекап: `GET`/`POST /campaigns` (bootstrap мастером или state админом; серверные поля `RULESET_*`/`WORLD_TEMPLATE_*`; 1..5 мест; первое место владельцу), `heroes`, `invites`, `join`, `recap` (любая ошибка → 200 `{recap:null, reason:'unavailable'}`) | 206–207, 4444–4620, 4805–4868 | `routes/campaigns.rs`, `routes/recap.rs` | С1 | ~230 → 500 | К: `creator-seat-api`, `ruleset-selection-api`, `world-template-api`, `table-of-five-api` (без typing). Г: создание и приглашение. **Сначала JS-тест для `/api/heroes`** |
| **С7** | Настройки ИИ, редакция, домашние правила (ключ `${key}:house-rule:${id}`; режим и модель — строкой летописи, без события) | 4622–4803 | `routes/settings.rs` | С1 | ~180 → 380 | К: `campaign-reasoning-settings` (HTTP), `campaign-improv-mode` (HTTP), `house-rule-default-api`, `exploration-opening-strike-api` (позже, нужны `/commands`) |
| **С8** | Откат и жизненный цикл (`event_id` = sha256(`campaignId\0key`); `forceSnapshot`; `NarrativeSummaryRecorded`) | 4901–5037 | `routes/controls.rs` | С1 | ~140 → 300 | Г на `event_id` и состояние после отката. **JS-теста на `/controls` нет — сначала написать на ките** |
| **С9** | Живой поток и присутствие: реестр соединений (`sessionKey`, `userId`, `heroIds`, `actorId`, `mapHash`, `Mutex<CampaignStreamOutbox>`), полная и лёгкая сверка доступа (1000 мс), `revoke` (кадр access revoked) и `refresh`, кадр `id/event/data`, пульс 20 с, `retry 2000`, тело SSE с сигналом занятости и `drain`, `typing`, подписка на хук проекции (`broadcastCampaignRoom`), `reconcilePartyDecisionPresence` при закрытии | 270–290, 2361–2477, 2601–2712, 2829–2835 (рассылка), 4172–4282 | `streams.rs` (замена заглушки), `routes/stream.rs` | С1, С0 (`auth.rs` уже зовёт хуки) | ~340 → 900 | К: `stream-live-access-api`, `stream-backpressure-api`, `stream-viewer-isolation-api`, `reconcile-access-perf-api` (после переформулировки). Rust: режим `listen` кита, клиент, который никогда не читает |
| **С10** | Комната, общий кубик, выдача кости: `GET /rooms/:id?map_hash=` (200 с пустой комнатой, если `state` нет), `PUT` → 410, `dice` (ключ `public-die:<roll_id>`, `PUBLIC_DIE_SIDES`), `/api/roll` (`CHECK_REQUIRED`) | 528, 6007–6113 | `routes/rooms.rs` | С1; присутствие из С9 через трейт | ~110 → 260 | К: `free-dice-api` (после С9), `narrate-room-version-race` (часть с PUT). Г: room с `map_hash` |
| **С11** | Решения отряда и задания: `quests abandon/accept`, `votes` (кворум по подключённым героям), общий бросок `1d20` с purpose `party_decision`, сверка повтора после гонки 4352–4358 | 4283–4424 | `routes/party.rs` | С1, С9 (кворум) | ~145 → 330 | К: `quest-abandonment-api` (после `readJournal`). **JS-тест на `party-decisions/:id/roll` — сначала на ките** |
| **С12** | Ассеты и картинки: портрет (302 или файл с ETag, `X-NPC-Portrait-*`), иллюстрация (только кеш), `asset-preparation` GET/POST, `/generated/items/:file`, `generate-image` (лимит 10, reserve/settle/fail, 429 `LLM_QUOTA_EXCEEDED` до провайдера) | 2962–2995, 3834–3883, 4027–4171, 6114–6142 | `routes/assets.rs`, `files.rs` | С1, С0 (ledger, генераторы) | ~230 → 550 | К: `item-images-api`, `npc-portraits-api`, `location-illustrations-api` (через `startFakeProvider`) |
| **С13** | Импорт и перестройка карт (preview, apply, rebuild; 405 на прочие методы; `CONFLICT_CODES`; `DND_MAP_LIBRARY`) | `routes/map-import-routes.mjs` 1–205; `index.mjs` 352–361, 3959 | `routes/map_import.rs` | С1 | ~215 → 450 | К: `map-import-api` (оба теста), `map-import-command` остаётся на движке |
| **С14** | Торговцы — управление и сборка: `merchants/commands` (lifecycle, лимит 60), `merchants/assemble` (`ShopAssembler`, лимит 30), `GET merchants/:id` (`decodeURIComponent` → 400 `INVALID_MERCHANT_ID`, `slice(120)`), отпечатки торговца | 648–661, 1023–1247, 5222–5304, 5449–5471 | `routes/merchants_admin.rs`, `merchant_guard.rs` | С1 | ~360 → 750 | К: `merchant-lifecycle-api`. Г: отпечатки через `fixtures-env` (сотни случаев) |
| **С15** | Диалог и объяснение хода: `dialogue` GET/DELETE (реестр уточнений из `AppState`, `pendingNarrationCheck`); `explanation` без проверки комнаты и без перевода в верхний регистр (паритет 5201–5202) | 4870–4899, 5198–5214 | `routes/dialogue.rs` | С1 | ~50 → 150 | Г. **JS-тест на `explanation` — сначала на ките** |
| **С16** | Санитайзеры и отпечатки `/commands` — **чистые функции без маршрута** | 528–636 (наборы, `LOOT_STALE_ERROR_CODES`, `lootTakenRecordFor`), 662–994 (предмет, MakeAttack 689–796, NPC-бой 797–847, отдых 848–888, предмет 889–910, обыск 911–958, развитие 959–994), 1248–2035 (`combatActorFor`, `assertPlayerCombatActorPermission`, `sanitizePlayer*`, `expandPlayerRestCommand`, `withCourierReplyDraft` — модель как трейт), 2036–2073 (`sanitizeMerchantCommand`) | `command_guard.rs`, `command_fingerprints.rs` | С0 | ~1150 → 2200 | Г: эталоны функций через `fixtures-env.mjs`. Функции не экспортированы из `index.mjs`, поэтому генератор вырезает их через `vm` по диапазону строк или вызывает через HTTP-сценарии `tactical-command-guard`. Самый объёмный, но независимый кусок |

### Волна 2 — после Н1 и Н2 (`sk-turns`)

| # | Задача | JS | Rust | Зависит | Объём | Паритет |
|---|---|---|---|---|---|---|
| **С17** | Системный такт, мировые часы, зацепки героев, стартовые толчки: `system-tick` (`STATE_VERSION_CONFLICT`/`IDEMPOTENCY_CONFLICT` → 200 с комнатой); часы торговцев, слухов и пленных с 3 попытками на конфликт; `HeroHookWeaver` на хуке проекции; `settleCombatContinuation`; толчок через 250 мс и `enableDefaultHouseRules` | 2713–2827, 2837–2892, 3352–3363, 3696–3796, 5958–6005, 6489–6504 | `routes/system_tick.rs`, `clocks.rs`, `hero_hooks.rs` | С1, sk-turns Н1/Н2 (`settle`); часы можно делать раньше | ~330 → 700 | К: `world-rumor-clock-api` (HTTP), `captives-api` (часы), `hero-hooks-api` |

### Волна 3 — маршруты оркестратора: одна задача С18 с подзадачами по файлам (после О2; С18.4 — после О1)

| # | Подзадача | JS | Rust | Зависит | Объём | Паритет |
|---|---|---|---|---|---|---|
| **С18.1** | `POST /campaigns/:id/commands`: атомарность команд, запреты `AdvanceScene`/`CreateEncounter`/lifecycle, `hold` координатора боя, двухфазный ручной бросок, критический момент, письма, контейнеры добычи, коды → 500/409/403 | 5530–5956 | `routes/commands.rs` | О2, С16, sk-turns | ~430 → 900 | К: около 40 файлов группы 2 (`authoritative-combat-api`, `command-retry-intent-api`, `loot-containers-api`, `make-attack-idempotency`, …) |
| **С18.2** | Торговля игрока `POST merchants/:id/commands` (лимит 120) | 5472–5528 | `routes/merchant_trade.rs` | О2, С14, С16 | ~60 → 150 | К: `merchant-api` |
| **С18.3** | Сборка встречи (белый список полей 5318, предпросмотр занятости 5349–5368, отпечатки встречи 995–1022) | 995–1022, 5306–5447 | `routes/encounters.rs` | О2, sk-turns | ~170 → 380 | К: `encounter-api`, `longstrider-api` |
| **С18.4** | Автономия `intents` и `advance` (ключи `:intent`, `:custom`, `:combat`, `:completion`), `assertDirectorAdvanceReady`, `warnOnDeadlyEncounter` | 2563–2600, 3094–3125, 5039–5197 | `routes/autonomy.rs` | О1 (+ post-commit) | ~200 → 450 | К: `director-player-entry-api`, `hit-dice-api`, `mvp-player-cycle-api` (HTTP) |
| **С18.5** | `/api/narrate`: `LEGACY_PAYLOAD_RETIRED`, `UNVERIFIED_ROLL`, лимит 40, переходы сцены Режиссёра и соло-выход, `executeTool`, приватный ответ мимо SSE с `knowledge_gate`, дельты рассказа в поток, `LLM_*` → 502, перечитывание `room_version` 6431–6432 | 2326–2359, 2924–2960, 3021–3351, 6143–6476 | `routes/narrate.rs`, `director_transition.rs` | О2, О1 (`takeRouteHint`), С9, С11 | ~720 → 1600 | К: около 45 файлов группы 6 (`narration-stream-api`, `party-interaction-api`, `solo-party-exit-api`, `tavern-api`, `parley-api`, …) |

**С19 (ведущий, финал).** Полный контрактный список; перенос `projection-postcommit-error-api`, `recovery-required-api` и `storage-backup-cli:107` на Rust; правка `docs/` и AGENTS §5 (сторожа на Rust); Docker-образ.

---

## 3. Волны и порядок

```
С3 (JS-кит) ───────────────────────────────────────────────▶ (параллельно всему)
С0 ─▶ С4, С5, С16                       (без комнаты, сразу)
   └▶ С1 ─▶ С6 С7 С8 С10 С12 С13 С14 С15 (параллельно, по файлам)
         └▶ С9 ─▶ С11                   (кворум — после реестра потоков)
Н1/Н2 (sk-turns) ─▶ С17
О1 ─▶ С18.4;  О2 ─▶ С18.1 (+С16), С18.2 (+С14), С18.3, С18.5 (+С9, С11)
все ─▶ С19
```

- **Критический путь:** С0 → С1 → С9 → (О2) → С18.5.
- **Одновременно:** в волне 1 до 10 исполнителей. Каждый владеет только своими `routes/*.rs` и вспомогательным файлом; `routes/mod.rs`, `state.rs` и `Cargo.toml` правит только ведущий. Если исполнителю нужно новое поле в `AppState`, он просит ведущего.
- **Проверка задачи:**
  - `cargo test -p sk-server --release` (только `--release`, из-за Smart App Control);
  - эталоны Г;
  - `pnpm test:contract:rust` по своему списку;
  - тот же список в режиме `js` должен остаться зелёным.

---

## 4. Риски и решения владельца

### Решения

1. **Комната.** Утвердить: «комната = проекция журнала плюс накладка (летопись не больше 400, поля только комнаты) в той же SQLite; `room.version` — счётчик накладки в одной транзакции с подтверждением проекции». От этого зависят форма ответа клиенту и судьба тестов, которые проверяют расхождение файла комнаты и журнала: `projection-postcommit-error-api`, `reconcile-access-perf-api`. Их инварианты нужно переформулировать, а AGENTS §9 требует на это решения владельца.
2. **Новые зависимости sk-server:**
   - `futures-util` — тело SSE;
   - `hyper-util` — тайм-ауты 65 и 66 с;
   - `tower-http` с `catch-panic` и `limit` — по желанию;
   - для разработки — ничего сверх `tokio::net` и `tower`.
3. **Право исполнителю С3 править `test/`.** `PORTING.md` §7 это запрещает.
4. **Предел тела.** Паритет в UTF-16 символах (рекомендую) или байты.
5. **Перенос старого storage.** Автоматически при пустой SQLite (`Accounts::import_legacy` + `import_file_store`) или явной подкомандой `skazanie-server import-legacy`. Рекомендую подкоманду и отказ старта, если рядом лежат JS-файлы, а база пустая.
6. **`.env`.** В Rust его никто не загружает. Решить: оставить так (Docker передаёт окружение, тесты изолированы по построению) или добавить `dotenvy` и сторожа сети.
7. **Последовательность записей.** Замок кампании на мутирующих маршрутах. Это строже JS, где `await` перемежает запросы; описать как отклонение в отчёте.

### Риски

- **Рассылка внутри замка.** Взаимная блокировка, если хук проекции вызывает `broadcast` под замком потока или кампании. Правило: рассылать после `drop` замков.
- **Отравленный `std::sync::Mutex`** у `EventStore`, `RollRegistry` и `Accounts` снимается через `into_inner`, поэтому после паники в памяти может остаться полуобновлённое состояние. После 500 из-за паники сбрасывать `head_cache` кампании и перечитывать резервы.
- **Синхронный SQLite и fsync FULL** на рабочих потоках tokio задерживают SSE всех кампаний. Обязателен `run_blocking`, и это надо проверять ревью.
- **Пять маршрутов без JS-тестов** (speech, heroes, controls, party roll, explanation): сверять Rust не с чем, сначала нужен тест на ките.
- **14 «UI-контрактов»** читают текст `server/index.mjs` через `readFileSync`. После перехода они проверяют мёртвый код; переписать их в С19.
- **Порядок JSON.** Работает `serde_json` с `preserve_order`. Тексты ошибок копировать байт в байт; эталоны Г ловят расхождения.
- **Масштаб.** `/commands` и `/api/narrate` вместе с помощниками — около 2300 строк JS. Без С16, начатого заранее, волна 3 станет узким местом.

---

# Рецензия плана (поправки)

# Рецензия плана переноса маршрутов sk-server

Сверял с `C:/Users/anton/PycharmProjects/Dnd-narrator-live`, HEAD `ef356203 merge(rust): rs/turns-n1`. Ничего не менял и не запускал.

## 1. Устаревшие вводные

1. **Блокер sk-turns снят, его надо убрать из плана.** Н1 влит (`1f12a9ce`, `ef356203`). В `rust/crates/sk-turns/src/npc_turn_scheduler.rs` 2577 строк, в `combat_turn_coordinator.rs` 779. Задачи «Н2» нет: в `sk-turns/src/lib.rs:4-7` оба модуля отнесены к Н1. Запись `rust/PORT-STATUS.md:54` («в работе Н1») устарела, а не `:52`. Что из этого следует:
   - волну 2 переписать как «после С1», без Н1/Н2;
   - `system-tick` (5958–6005) больше ничем не заблокирован;
   - `settleCombatContinuation` (3352–3363) зовёт только стадию `combat-continuation`, то есть `runNpcTurnScheduler` (373–375). О1 ему не нужен.
2. **`sk-agents` перенесён целиком** (`48f800cc`). Bootstrapper, recap, hero hooks, scene architect и lore voice готовы. Это стоит отразить в зависимостях С6, С17 и С18.

## 2. Архитектурные блокеры, которых нет в §0

3. **Нужные крейты не `Send`.** В Rust они устроены так:
   - `CombatTurnCoordinator<'a>` держит заимствования `&'a dyn …` и `RefCell`/`Cell` (`combat_turn_coordinator.rs:469-484`), а `HostFuture` у него без `Send` (`:401`);
   - `PostCommitCoordinator` в `sk-society/src/post_commit_coordinator.rs` (10 вхождений `RefCell`, структуры с `'a`);
   - `npc_turn_scheduler.rs` (тоже `RefCell` и `'a`).

   Положить их в `Arc<AppState>` под многопоточным axum не выйдет, и `post_commit: PostCommitCoordinator` из §1 в таком виде не соберётся. В §0 нужно решение. Варианты:
   - однопоточный «исполнитель кампаний»: `LocalSet` или `current_thread`-рантайм, который владеет этими объектами, а обработчики шлют ему задания по каналу;
   - переписать крейты на `Mutex`/`Arc`. Это правка чужих крейтов, запрещённая `PORTING.md` §7, значит, нужно решение владельца.
4. **Настройки ИИ кампании на время запроса.** В плане нет `runWithCampaignAiSettings` (`index.mjs:3919-3928`): id из пути переводится в верхний регистр, `model` по умолчанию `|| model`. Это поле читает `FallbackLLMClient` (`server/llm-client.mjs:706`, `currentCampaignModel`) и рассуждения (`:541`).
   - В Rust контекст живёт в thread-local стеке (`sk-narration-base/src/campaign_ai_context.rs:156-166`). Через `.await` и `spawn_blocking` он теряется.
   - Нужен `tokio::task_local!` или явная передача. Добавить в С0 (`dispatch.rs`) с тестом.
   - Отдельно решить фоновые задачи. В JS `queueMicrotask` из `onRoomSaved` (2829–2835, 2875–2892) наследует контекст запроса, поэтому мораль NPC и зацепки героев идут на модели этой кампании. В Rust нужно явно захватывать настройки при `nudge` или задокументировать отклонение.
5. **Объём замка кампании (§0.3, решение 7).** Если держать замок через ожидание модели (`/api/narrate`, `/commands` с критическим моментом, `autonomy/advance`), запросы стола встанут на 9 с и больше:
   - голоса (4312);
   - `typing` (4172);
   - кубик (6011);
   - автоход координатора.

   В JS они перемежаются. Замок брать только на «load → commit → проекция». Нужен тест, что конфликт `expected_state_version` по-прежнему даёт 409, а не тихо сериализуется (см. `narrate-room-version-race`).

## 3. Пропуски в каркасе С0 и диспетчере

6. **`/api/health` не проверяет метод** (`index.mjs:3940`, сырой `req.url`). `HEAD` и `POST` с разрешённого источника отвечают 200. Обязательный тест С0 «`HEAD /api/health` даёт 404» неверен: заменить на «HEAD и POST дают 200». Текущий Rust `get(health)` (`sk-server/src/lib.rs:105`) на `POST` вернёт 405, это тоже исправить.
7. **Сырых маршрутов с `?query` 15, а не 11:**
   - 3940 health, 3954 admin/usage;
   - 3960 и 3964 speech;
   - 3970, 3974, 3984, 3993, 4002 auth;
   - 4011 и 4015 admin/users;
   - 6010 `rooms/:id/dice`, 6093 `/api/roll`, 6118 `generate-image`, 6143 `narrate`.

   `/generated/items/` (6114) query допускает: `serveGenerated` (3835) отрезает его через `split('?')`. Сейчас Rust на `/api/health?x` отвечает 200, это уже расхождение.
8. **Пример с торговцем в §0.1 неверен.** `GET …/merchants/commands` не доходит до обработчика с `merchant_id='commands'`: условие `!pathname.endsWith('/commands')` (5455) его отсекает, ответ 404. Верный пример — `GET …/merchants/assemble`. Ещё одна тонкость: `decodeURIComponent` с ответом 400 `INVALID_MERCHANT_ID` (5451–5454) срабатывает **до проверки метода**. Например, `DELETE …/merchants/%E0` даёт 400, а не 404. Добавить в тесты С0.
9. **Исключения из правила «404 вместо 405»:**
   - `map-import` отвечает 405 на **любой** метод, кроме POST, включая GET и HEAD (`server/routes/map-import-routes.mjs:60`);
   - нераспознанный путь под `/api/admin/combat-lab/` проваливается дальше по диспетчеру (`combat-lab-routes.mjs:84`).

   Это записать в `Matcher`.
10. **Нормализация `pathname` по WHATWG URL** (3920, 4027). JS разбирает `.`/`..`, превращает `\` в `/` и т. д. Например, `/api/x/../rooms/ABC` совпадёт с GET комнаты. Hyper так не нормализует. В `Matcher::Path` нужен такой же разбор и тесты.
11. **Регулярка админа с флагом `i`** (4015): допустимы и `A-F`.
12. **Раздача клиента** (3798–3833) отвечает на **любой** метод: DELETE и PUT с разрешённого источника получают клиента. Ещё два ответа:
    - без `dist` — 404 JSON «Сначала выполните pnpm build»;
    - ошибка `decodeURIComponent` — 400 «Некорректный путь».

    Текущий Rust отвечает 404 на всё, кроме GET/HEAD (`sk-server/src/lib.rs:83-85`). Внести в С0.
13. **GET комнаты без `state`** отвечает 200 с пустой комнатой **только администратору**. Остальным `canAccessRoom` даёт 403 раньше (6073–6074). Уточнить в С10.
14. **Пропущенные переменные `config.rs`:**
    - `DND_CORPUS_DIR` (`server/rules-corpus.mjs:29`);
    - `DND_DEFAULT_RULESET_VERSION` (`server/migrations/001-event-engine.mjs:74`).

    И паритет `Number(env)`: `NaN` и `0` при `||`.
15. **Сигналы.** JS делает `process.exit(code)` без плавной остановки (240). `SIGTERM` в tokio есть только под `cfg(unix)`, а основная машина — Windows. Описать как отклонение.
16. **`json()` и `readBody`.** Различия `JSON.parse` и serde: одиночные суррогаты `\ud800` JS принимает, serde нет; печать чисел `5.0` против `5`, `1e+21` против `1e21`. Включить случаи в эталоны С0 и проверить, что ответ идёт через `sk_core::js`.

## 4. Помощники и проводка без хозяина

17. **Сборка `CombatTurnCoordinator` (432–467)** не отдана ни одной задаче. В неё входят:
    - `isSeatUnclaimed` (`campaignHasMemberships`, `assignedCampaignHeroIds`, `partyHeroIds`);
    - `onCommitted`: `tactical_narration_parts`, затем строка летописи `combatMessageId('auto-turn:…')`, «Система боя»;
    - `onClockChanged`, который вызывает `broadcastCampaignRoom`.

    Назначить на С17. Учесть, что `stateWithLivePresence` (2611) читает `combatTurnCoordinator.clockFor`, поэтому С9 и С10 зависят от этого экземпляра или трейта.
18. **Зависимости `PostCommitCoordinator` (372–395)** тоже без хозяина:
    - `continueCombat` — `runNpcTurnScheduler`;
    - `completeEncounter` — `autonomousCampaign`, то есть **О1**;
    - `persistProjection`;
    - `heroesNeedingHooks` и `weaveHeroHooks` (2871–2874).

    Расписать по задачам: `continueCombat` и `persist` — С17, `completeEncounter` — С18.4.
19. **Хук `onRoomSaved` 2829–2835** кроме рассылки зовёт `combatTurnCoordinator.nudge` и `nudgeWorldClocks`. С9 берёт его только как «рассылку», а хозяина у этих вызовов нет. Передать С17.
20. **Без назначения или без имени:**
    - `commandType` (644–647);
    - `partyVoterIdForAccount`, `partyVoterSnapshot`, `campaignVoterCount` (2484–2543) не перечислены в `access.rs`. Первые два нужны С1 (3639) и С11 (4300), последний — С18.5 (6278);
    - глобальный `setActiveMapLibrary` (356);
    - `room.updatedAt` (`store.mjs:449,460`) нет в §0.2, а ответы отдают `{...room}`, рассылка — `updatedAt` (2706).

## 5. Неверные зависимости

21. **С14 зависит от О2.** `executeMerchantLifecycleCommand` (1217–1240) вызывает `gameOrchestrator.handle` (1220), а через него идут оба маршрута С14: `merchants/commands` (5239) и `merchants/assemble` (5287). Перенести С14 в волну 3 или оставить в волне 1 только `GET merchants/:id` (5449–5471) и санитайзеры жизненного цикла.
22. **О2 зависит от О1.** `GameOrchestrator` получает `unknownActionHandler: autonomousCampaign` (3007). Критический путь — С0 → С1 → О1 → О2 → С18.5. Все С18.x транзитивно ждут О1. Исправить граф в §3.
23. **С15 (dialogue).** Реестр уточнений — поле оркестратора (`gameOrchestrator.clarificationRegistry`, 4881). То, что О2 обязан принимать его внедрением, записать как контракт О2, а не только как решение С15.
24. **С18.1 зависит ещё и от С14.** Он использует `assertMerchantIdempotency` (1023, вызов в 5713) и `assertMerchantResultFingerprint` (1241, вызов в 5773).
25. **В зависимостях С0 перечислены не все нужные крейты.** Нужны также:

    | Крейт | Что нужно |
    |---|---|
    | `sk-agents` | bootstrap 4515, recap 4609, hero hooks 2846, scene architect 311, `LoreVoice`, `propose_routed_travel` |
    | `sk-chargen` | портреты, иллюстрации |
    | `sk-economy` | `ShopAssembler`, `merchant_view_for` |
    | `sk-story` | `MapLibrary` |
    | `sk-narration` | `tactical_narration_parts` |
    | `sk-turns` | |
    | `sk-director` | `assert_campaign_playable`, `create_scene_transition` |
    | `sk-encounters` | |
    | `sk-character` | |

    Без них исполнителям волны 1 придётся править `Cargo.toml` ведущего.

## 6. Пересечения между задачами

26. С18.4 (3094–3125) целиком лежит внутри С18.5 (3021–3351). `warnOnDeadlyEncounter` вызывается только в autonomy (5054, 5146): исключить его из С18.5.
27. `enableDefaultHouseRules` (3543) есть и в С1 (3497–3594), и в С17. Оставить в С1, в С17 — только вызов при старте.
28. `main.rs` 6481–6505 (С0) пересекается с 6489–6504 (С17). В С0 — точка подключения, в С17 — её наполнение.
29. `PUBLIC_DIE_SIDES` (528) объявлен в С10 и входит в диапазон С16 (528–636).
30. Торговец разнесён по трём файлам: 648–661 (С14), 2036–2073 (С16), общий разбор id 5449–5454 (С14 и С18.2). Предлагаю:
    - всё про отпечатки и игровую торговлю — в `command_guard.rs` С16;
    - в `merchant_guard.rs` — только жизненный цикл (1032–1240);
    - 5449–5454 — общий помощник С14.
31. 2829–2835: С9 и С17, см. п. 19.

## 7. С16 — не «чистые функции»

32. **Функции `assert*Idempotency` асинхронно читают `eventStore`.** Строки: 768, 828, 860, 891, 939, 1005, 1023. `withCourierReplyDraft` (1918) зовёт модель. Значит, в С16 нужен трейт журнала, а не только трейт модели.
33. **Вырезать функции через `vm` по номерам строк хрупко.** У `index.mjs` верхнеуровневые эффекты: `claimStorageWriter` (236), `await loadRulePacks` (314), `listen`. Генератор должен:
    - брать только исходники функций со заглушками зависимостей;
    - сверять хеш `server/index.mjs` с закреплённым коммитом и падать при расхождении.

    Как запасной путь — эталоны через HTTP.

## 8. Инварианты AGENTS.md §5 и их сторожа в плане

| Инвариант | Что не так в плане | Поправка |
|---|---|---|
| Игрок видит только разрешённое | `viewer-projection-api` (HTTP) не упомянут. `combat-forecast-disclosure` — юнит-тест JS-модулей, а не контракт | `viewer-projection-api` — в К С10 и С18.5. В `access.rs` — Rust-тест `viewer_state_for` (закрытая КД не утекает процентом попадания) |
| Все броски серверные, проверка только кость своей карточки | `roll-binding` (HTTP) и `roll-reservation-api` (`--import` сбоя commit) отсутствуют | `roll-binding` → С10 (`/api/roll`) и С18.5. `roll-reservation-api` → С1 (резервы) и С18.5. В `DND_COMMIT_FAULTS` добавить отказ подтверждения проекции (`test/fixtures/fail-projection-ack-once.mjs`) |
| Права и владелец героя (`security.test`) | Тест статический: `llm-client` импортирует только `index.mjs`, привязки промптов. Сторожа для Rust нет (§0.4 без теста) | Rust-тест в С2: `RouterAiClient`/генератор картинок создаются только в `sk-server/src/{main,state}.rs` и `tests/kit` |
| Клиентские поля недоверенные | `tactical-command-guard` проверяет **клиентский** `src/tactical-command-guard.mjs`, а не сервер. Ссылка в С16 ошибочна | Серверные сторожа — `authoritative-combat-api`, `make-attack-idempotency`, `loading-attacks-http-review`, `sneak-attack-http`, `spell-reaction-http`. Внести явно в К С18.1 |
| Параллельные команды не перезаписывают друг друга | `snapshot-projector-version` — юнит-тест `FileEventStore`, контрактом против бинаря быть не может | Убрать из К С1; аналог — Rust-тест в С1 или sk-store. `narrate-room-version-race` целиком — в С18.5; плюс тест «замок не глотает конфликт версии» (п. 5) |
| Идемпотентность и 409 на другой endpoint с тем же ключом | `api-integration` указан «частью» в С4; `game-flow-integration` не HTTP (это О2) | В С0 `idempotency.rs` — Rust-тест конфликта ключа между `/commands`, `merchants/:id/commands`, `encounters/assemble` и `dice`. `api-integration` разбить по задачам явно |
| Потеря хвоста журнала даёт `CAMPAIGN_RECOVERY_REQUIRED`, сервер жив | `recovery-required-api` отложен до С19, хотя сверку делает С1 | Перенести в К после С6 и С10 (ему нужны только `POST /campaigns`, `GET /rooms` и health) |
| Replay совпадает (`pnpm cutover:audit`) | Не учтено: `server/cutover-audit.mjs` читает файловые комнаты и снимки JS | Отдельная задача: аудит для SQLite или решение владельца |
| Бэкап не снимается с живого storage | Учтён только `storage-backup-cli:107` | Добавить `restore-rehearsal-api` и копирование `skazanie.sqlite` вместе с `-wal`/`-shm` в `pnpm backup` |
| Комната и журнал (решение 1) | Кроме двух названных тестов, файл комнаты читают или пишут `store-regression` (`rooms/BROKEN.json`) и `reconcile-access-perf-api` (`rooms/*.json`) | Внести в список решения владельца |
| Остальные HTTP-инварианты | Потоки (С9), сеть (С3), граница 500 (С0), учёт (С12), `map-import` (С13) покрыты | — |

34. **Прямо не названы HTTP-файлы, которые относятся к волне 1:**
    - `character-creation-api` → С4 и С6;
    - `combat-lab-api` → С5: указан только `-observer-api`;
    - `persistent-campaign-api`, `stage1-multiplayer-api`, `world-data-flow-api`, `ruleset-activation-guard`, `soak-crash-recovery-api` → С19 или по маршрутам.

    Всего HTTP-тестов 103. Нужна явная таблица «файл → задача», а не «около 40» и «около 45».
35. **В С15 «JS-теста нет» неверно для `dialogue`:** есть `test/dialogue-api.test.mjs` и `campaign-dialogues-api`. Но они ходят в `/api/narrate`, `votes` и `autonomy/advance`, поэтому годятся как К только после С18.5. Теста нет только у `explanation`.

## 9. Мелкие неточности

36. В С17 «3 попытки на конфликт» есть только у часов торговцев (3697, 3746). У молвы — предел оборотов `WORLD_RUMOR_BURST_LIMIT = 4` (274, 2802). У пленных повторов нет (2748–2774).
37. С0 `access.rs` относит 2478–2562 к себе «кроме подключённых героев». Но `connectedHeroIdsForCampaign` (2478) делает сверку потоков (2480), поэтому `campaign_voter_count` и кворум требуют трейт `Presence` уже в С0.

---

# Решения ведущего (2026-10-21)

1. **Игровое ядро — один поток, как JS.** Не-`Send` крейты (`CombatTurnCoordinator`,
   `PostCommitCoordinator`, планировщик ходов NPC) не переписываются: всё
   игровое ядро (хранилище, движок, координаторы, оркестраторы, рассылка) живёт
   в однопоточном исполнителе (`tokio::task::LocalSet` на своём потоке), HTTP-слой
   axum шлёт ему задания по каналу и ждёт ответ. Задачи в `LocalSet`
   перемежаются на `await` ровно как запросы в цикле событий Node: ожидание
   модели в `/api/narrate` не блокирует голоса, кубик и `typing`. Отдельный
   замок кампании не нужен; конфликт `expected_state_version` по-прежнему 409
   (тест). Блокирующие вызовы (SQLite FULL, scrypt) — `spawn_blocking` из ядра
   с возвратом результата в ядро.
2. **Комната — проекция журнала плюс накладка** (летопись ≤ 400, поля только
   комнаты, `room.version` — счётчик накладки в одной транзакции SQLite с
   подтверждением проекции). Продолжает решение «один источник истины»
   (`docs/rust-rewrite-plan.md` §1 п. 3, §7). Тесты, проверяющие расхождение
   файла комнаты и журнала, переформулируются (это не ослабление инварианта:
   расхождение в Rust невозможно по устройству).
3. **Новые зависимости** sk-server (`futures-util`, `hyper-util`, `tower-http`,
   `dotenvy` только в `main.rs`) — разрешены владельцем 2026-10-13.
4. **Предел тела — паритет в UTF-16** с жёстким потолком 4 МБ в байтах.
5. **Настройки ИИ кампании на запрос** — `tokio::task_local!` поверх
   `campaign_ai_context`, захват при постановке фоновых задач.
6. **С3 (правка JS-тестов под контрактный режим)** — ждёт решения владельца
   (`PORTING.md` §7 запрещает исполнителям трогать `test/`); до решения паритет
   маршрутов — эталонами Г.
