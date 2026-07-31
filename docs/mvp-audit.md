# Аудит исходного MVP и текущего переходного runtime

Дата среза: 12 июля 2026 года.

> **Исторический документ:** после этапа 8 runtime работает только в
> `enforce`; legacy/shadow branches, browser gameplay fallback и broad room
> `PUT` удалены. Текущий статус см. в `docs/current-architecture.md` и
> `docs/legacy-retirement.md`.

## Как читать этот документ

Аудит намеренно разделяет три состояния:

- **baseline** — исходный MVP до добавления доменного контура;
- **реализовано и подключено** — код, который создаётся и вызывается из `server/index.mjs` рабочими HTTP-маршрутами;
- **ограничение** — совместимый legacy-путь или неполная механика, которая ещё не соответствует целевой архитектуре.

Текущий сервер — уже не legacy-приложение с набором изолированных новых файлов. Это гибридный strangler runtime: существующий React UI и room API сохранены, а `GameOrchestrator`, Rule Pack, Retriever, Rules Engine, FileEventStore, Dice Service, Roll Registry, Narrator, verifier и trace store реально собраны в сервере. При этом полнота миграции зависит от режима `legacy | shadow | enforce`, а compatibility PUT и browser fallback всё ещё оставляют обходные пути вокруг событийного движка.

## Baseline: что было в исходном MVP

- Frontend: React + TypeScript + Vite; игровой цикл сосредоточен в `src/useGameSession.ts`, локальный fallback — в `src/game-engine.ts`.
- Backend: один `node:http` сервер в `server/index.mjs` без отдельного router/middleware framework.
- Состояние кампании: полный `GameState` в `storage/rooms/<code>.json`, сохраняемый через optimistic room version.
- Авторитет механики: распределён между AI tools, `useGameSession`, browser fallback и полным `PUT /api/rooms/:code`.
- Правила: текст prompt, описания tools и неформальная интерпретация модели; версионированного корпуса и retrieval не было.
- Броски: несколько независимых реализаций, включая `Math.random` в браузере.
- Аудит: не было append-only event stream, replay, durable idempotency, turn trace и объяснения `/why`.

### Baseline-цикл хода

1. `useGameSession` отправлял на `POST /api/narrate` действие и переданный клиентом state.
2. Legacy prompt/RouterAI возвращал narration или tool effect.
3. Сервер отдавал effects без авторитетного доменного reducer.
4. Клиент применял effects и сохранял полный новый state через room PUT.
5. При ошибке AI браузер выполнял локальную механику через `src/game-engine.ts`.

Это описание сохранено как историческая точка сравнения. В текущем runtime `/api/narrate` берёт доверенное состояние с сервера и проходит через `GameOrchestrator`.

## Реализовано и подключено сейчас

`server/index.mjs` при старте создаёт и связывает:

- `DiceService` и использующий его `RollRegistry`;
- `EngineModeResolver`;
- Rule Pack `srd_5_2_1` и hybrid `RuleRetriever`;
- `RulesEngine`;
- bounded deterministic `NPC turn scheduler` для server-authoritative combat;
- `FileEventStore` в `<DND_STORAGE_DIR>/engine`;
- `FileTraceStore` в `<DND_STORAGE_DIR>/turn-traces`;
- `RouterAIClient`, `Narrator` и `GameOrchestrator`;
- legacy handler как совместимый адаптер для режимов `legacy` и `shadow`.

Новая кампания создаётся с `engine_mode: shadow` и сразу импортируется в event store. Для существующей кампании orchestrator лениво создаёт `LegacyStateImported`, когда впервые обрабатывает её в `shadow` или `enforce`. Глобальный/default режим для кампании без override остаётся `legacy`, если не задан `GAME_ENGINE_MODE`.

### Семантика режимов

| Режим | Авторитетный результат | Что делает новый движок |
|---|---|---|
| `legacy` | Legacy narration/effects | Парсит intent и retrieval-контекст для trace, но не коммитит механические события |
| `shadow` | Legacy narration/effects | Рассчитывает план и сравнение, сохраняет trace, но не коммитит рассчитанные события |
| `enforce` | Rules Engine + event store | Валидирует команды, коммитит события/idempotency, строит narration из разрешённого brief и проецирует результат в legacy room |

`POST /api/campaigns/:id/commands` доступен только когда effective mode кампании уже равен `enforce`; иначе сервер возвращает conflict. Обычный игрок может отправить через него только `StartCombat/MoveActor/MakeAttack/EndTurn` назначенного героя, а admin — расширенный диагностический набор. `CreateEncounter` через этот общий route запрещён: отдельный admin endpoint принимает только bounded difficulty/theme и заново выводит всю числовую механику. Обычный `/api/narrate` использует precedence resolver: test → user → campaign → global → default.

## Текущий HTTP API

| Маршрут | Фактическое назначение |
|---|---|
| `GET /api/health` | RouterAI, engine mode и метаданные загруженного Rule Pack |
| auth/admin routes | Setup, регистрация, сессии, управление пользователями и hero IDs |
| `GET /api/rules/search` | Аутентифицированный поиск через подключённый Retriever со строгим ruleset/pack filter |
| `POST /api/campaigns` | Admin-only создание кампании, default `shadow`, room save и первичный event-store import |
| `PATCH /api/campaigns/:id/engine-mode` | Admin-only переключение `legacy \| shadow \| enforce` |
| `POST /api/campaigns/:id/commands` | Effective `enforce`: player combat allowlist/ownership либо расширенный admin set; Rules Engine, event commit, NPC scheduling и compatibility projection |
| `POST /api/campaigns/:id/encounters/assemble` | Admin-only в `enforce`: официальный SRD XP budget уровней 1–20, 12 server-owned monster profiles, safe spawn, атомарные `EncounterCreated + CombatStarted` и replay/projection |
| `GET /api/campaigns/:id/turns/:turnId/explanation` | Объяснение trace; `turnId=latest` поддерживается |
| `GET /api/rooms/:code` | Room read с проверкой доступа по назначенным hero IDs |
| `PUT /api/rooms/:code` | Compatibility full-state sync с CAS и дополнительной серверной валидацией |
| `POST /api/rooms/:code/dice` | Свободный d20 через `DiceService` и запись результата в legacy room |
| `POST /api/roll` | Выдача зарегистрированного серверного броска через `RollRegistry` |
| `POST /api/narrate` | Доверенный room state → verified roll → `GameOrchestrator` → выбранный режим |
| `POST /api/items/generate-image` | Аутентифицированная, rate-limited генерация файла |
| `GET /generated/items/:file` | Аутентифицированная выдача сгенерированного файла из configured storage |
| `GET /api/campaigns/:id/npcs/:npcId/portrait` | Authenticated viewer-visible NPC → static role portrait либо rate-limited generated WebP из hashed persistent cache |

Неизвестный путь `/api/*` возвращает JSON 404 и не проваливается в SPA.

## Точки прямой мутации и обхода событий

Таблица показывает как исходные точки, так и их текущее состояние.

| Точка | Прямая мутация | Текущее состояние |
|---|---|---|
| `src/useGameSession.ts:finishTurn` | Применяет narration effects к карте, предметам и журналу | Сохраняется для совместимости `legacy/shadow`; базовые start/move/attack/end-turn в `enforce` отправляются как typed commands без локальной оптимистической механики |
| `src/useGameSession.ts:commit/mutate` и CRUD игрока/мира | Собирает и отправляет полный `GameState`, пишет `localStorage` | Всё ещё активный compatibility path; для non-admin `enforce` сервер восстанавливает event-store mechanics/enemies/player mechanics и принимает лишь presentation-поля листа, но broad narrative/admin writes остаются |
| `src/game-engine.ts:resolveAction` | Локальный исход и `Math.random` | Всё ещё обходной browser fallback при недоступности AI; должен быть удалён после полного cutover |
| `server/index.mjs:executeTool` | Legacy effects `roll/reveal/spawn/objective/grantItems` | Бросок уже использует `DiceService`; остальные effects остаются legacy-предложениями, не event commit |
| `PUT /api/rooms/:code` | Замена совместимого room state | REFACTOR выполнен частично: non-admin не может перезаписать боевую механику в `enforce`, но narrative state и admin divergence всё ещё возможны |
| `persistAuthoritativeProjection` | Копирует HP/enemies/mechanics/items/movement/tactical turn/battle log/map feedback и выбранные scene/rulings из event state в room JSON | Нужный strangler adapter, но event commit и room save не образуют одну транзакцию; conflict projection не откатывает уже записанные события |
| `POST /api/rooms/:code/dice` | Записывает `lastDiceRoll` и room version | RNG унифицирован через `DiceService`, однако запись остаётся вне event stream |
| image generation | Записывает файл в `storage/generated/items` либо hashed `storage/generated/npcs` | Изолированный побочный эффект; путь следует `DND_STORAGE_DIR`, а generated NPC portrait выдаётся только после auth, campaign ACL и viewer-visible profile check |
| auth repository | Меняет `auth.json` и сессии | Допустимая отдельная bounded context; не является игровым event stream |

## Классификация KEEP / WRAP / REFACTOR / REPLACE / MISSING

| Компонент baseline | Решение | Реальный статус |
|---|---|---|
| React UI и основные пользовательские сценарии | **KEEP** | Сохранены; работают через совместимые ответы и room projection |
| Существующие HTTP contracts | **KEEP** | Старые маршруты сохранены, рядом добавлены campaign/command/rules/explanation endpoints |
| scrypt, hashed sessions, HttpOnly cookie, server-only AI key | **KEEP** | Активны; дополнены ACL, security headers и Origin check |
| Прямой текстовый вызов RouterAI | **WRAP** | Legacy chat и новый Narrator используют `RouterAIClient`; image generation пока вызывает provider отдельно |
| JSON room repository | **WRAP** | Остаётся compatibility projection/read model рядом с активным `FileEventStore` |
| Полный room PUT | **REFACTOR** | Player combat mechanics в `enforce` восстанавливается из event store; broad narrative state и admin override ещё не ограничены доменными командами |
| `useGameSession` как автор механики | **REFACTOR** | Enforce-путь переносит авторитет на сервер; legacy/shadow и fallback сохраняют старую роль клиента |
| Legacy tool effects | **REFACTOR** | Обёрнуты legacy handler; структурированные команды уже проходят Rules Engine, но tool effects ещё не всегда конвертируются в события |
| Browser fallback `game-engine.ts` | **REPLACE** | Пока активен; серверный deterministic fallback не заменил его во всех UI-сценариях |
| Разрозненные серверные броски | **REPLACE** | `/api/roll`, room dice и legacy `roll_check` переведены на `DiceService`; browser `Math.random` остался |
| Правила только в prompt | **REPLACE** | Rule Pack и Retriever загружены и используются orchestrator/search; legacy модель по-прежнему содержит совместимый prompt |
| Нормализованный Rule Pack | **MISSING в baseline** | Реализован, проверяется при загрузке и подключён к runtime |
| Rule Retriever | **MISSING в baseline** | Реализован и подключён к `/api/rules/search` и orchestrator |
| Rules Engine + reducer + replay | **MISSING в baseline** | Реализован и авторитетен в `enforce`; базовый UI combat и enemy scheduler подключены, но покрытие механик ещё неполное |
| Event repository и snapshots | **MISSING в baseline** | `FileEventStore` активен для import/commit/replay; legacy room остаётся параллельной проекцией |
| Intent Parser + Adjudicator | **MISSING в baseline** | Вызываются каждым orchestrated ходом; поддерживают только ограниченный набор intents/команд |
| Narration brief + verifier | **MISSING в baseline** | Активны в `enforce`; narration строится после commit из видимых событий |
| Turn trace и `/why` | **MISSING в baseline** | Trace сохраняется во всех режимах, `/why` и explanation route подключены |
| Feature modes | **MISSING в baseline** | `legacy/shadow/enforce` реально разрешаются и переключаются для кампании |
| Metadata migration | **MISSING в baseline** | Реализована с dry-run/backup/idempotency; runner не является единым автоматическим cutover в event store |

## Правила и механика

Pack `data/rule_packs/srd_5_2_1` содержит 23 двуязычных оригинальных пересказа правил, glossary, 23 ontology edges, manifest и coverage metadata. Rule IDs движка согласованы с текущим pack; прежнее утверждение об ID mismatch больше не актуально.

Это минимальный, а не полный SRD-корпус. Критическая атака удваивает только damage dice и сохраняет rule provenance; базовые death saves, stabilization, damage at 0 HP, massive damage, stable recovery через 1d4 часа и nonlethal knockout с 60-минутным Short Rest исполняются и replay-ятся сервером. Bless/Bane меняют итог death save, Beacon of Hope даёт преимущество и максимизирует кости лечения, Aura of Life позиционно даёт некротическое сопротивление, блокирует уменьшение максимума ОЗ и поднимает союзника с 0 ОЗ в начале хода, а Aura of Protection добавляет нескладывающийся позиционный бонус Харизмы ко всем saves. Воин 9–12 уровня получает одно использование «Несгибаемого»: после провала движок атомарно ставит исходную команду на паузу, предлагает обязательный переброс с бонусом уровня воина, не расходует реакцию и восстанавливает ресурс только продолжительным отдыхом; путь покрывает обычные, заклинательные, area, concentration и death saves. Общий damage pipeline автоматически исполняет Constitution save концентрации и завершает связанный эффект при провале или 0 ОЗ. Generic conditions, полный отдых, внешние причины окончания концентрации и оставшиеся особенности 1–12 уровней, влияющие на death flow, реализованы не полностью. Поэтому `enforce` означает авторитетность реализованного среза, а не полноту всех правил игры.

## Защита, добавленная в runtime

- room/campaign access проверяется по admin role или пересечению hero IDs с roster;
- команды разрешены только владельцу actor, затем проходят allowlist и Rules Engine validation;
- `/api/narrate` игнорирует присланный клиентом state и загружает room state;
- `enforce` принимает только серверный `roll_id`; consume проверяет campaign, actor и idempotency;
- generated files и rule search требуют сессию;
- mutating requests проходят same-host/localhost Origin check;
- CSP, `nosniff`, referrer, permissions и CORP headers включены;
- narration/image rate limits привязаны к пользователю;
- traces редактируют известные secret-like поля.

Остаточные риски: self-registration открыта; rate limits и Roll Registry живут в памяти; отсутствие `Origin` разрешено и CSRF token нет; explanation проверяет доступ к кампании, но не выполняет отдельную visibility projection каждого trace event.

## Проверки: что действительно доказано

Модульные тесты проверяют Rule Pack/Retriever, Dice/Roll, Rules Engine, mode resolver, LLM contracts, intent/adjudication, event-store recovery/idempotency/snapshots, migration, orchestrator, security, narrator и traces.

`test/game-flow-integration.test.mjs` выполняет domain integration flow через реальный Orchestrator, Rules Engine, FileEventStore и FileTraceStore: legacy import → исследование → social ruling → check/save → spell/resource/concentration → initiative/attack/damage → healing/condition → `/why` → явный `EndCombat` → rest → reopen/replay без snapshot.

Есть real-HTTP integration scenarios с настоящим `server/index.mjs`, временным storage и без RouterAI key. Совместимый flow проверяет setup admin → создание shadow-кампании → admin switch в `enforce` → поиск правила → `ApplyDamage` → idempotent retry → explanation → `/api/narrate /why`, игнорирующий поддельный client state → JSON 404. Отдельные flows проверяют player combat allowlist/ownership, server-derived attack profile, path/speed/occupancy, NPC turn, persistent journal и replay, а также admin EncounterAssembler: отказ от forged stat blocks/coordinates/participants, safe spawn, atomic start, player projection и restart/replay.

Не проверены end-to-end:

- автоматизированный multi-browser/realtime поток;
- Docker/Compose и публичный tunnel;
- реальный RouterAI text/image provider;
- production metadata migration и cutover существующего storage;
- rollback и восстановление room projection после конфликта;
- многопроцессная конкуренция и длительная нагрузка.

## Главные остаточные риски

1. Event commit и запись compatibility room projection не атомарны.
2. Legacy/shadow browser fallback и broad narrative/admin PUT позволяют менять часть состояния вне event stream; player combat mechanics в `enforce` уже защищена восстановлением event-state.
3. В `shadow` legacy handler и Rules Engine могут выполнить независимые броски; сравнение не гарантирует один общий roll artifact.
4. Roll Registry и request rate limits теряются при рестарте и не координируются между процессами.
5. Покрытие P0-механик неполное, хотя Rule Pack/Retriever/Engine уже подключены.
6. Metadata migration и lazy `LegacyStateImported` — два разных шага; единого проверенного production cutover workflow пока нет.
7. File stores рассчитаны прежде всего на один процесс и требуют осторожности в синхронизируемой OneDrive-папке.
8. Domain integration и HTTP combat/restart scenarios подтверждают основной вертикальный срез, но не доказывают multi-browser realtime, AI, migration или production compatibility целиком.
