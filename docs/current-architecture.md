# Текущая архитектура

Дата среза: 13 июля 2026 года.

## Краткий вывод

Приложение работает как **гибридный strangler**. Существующий React UI, legacy narration/tools и JSON room contract сохранены как слой совместимости, но новый доменный контур уже не изолирован: `server/index.mjs` загружает Rule Pack, создаёт Retriever, Dice Service, Roll Registry, Rules Engine, FileEventStore, trace store, Narrator и `GameOrchestrator`, а HTTP-маршруты реально их вызывают.

Граница авторитета задаётся режимом кампании:

- `legacy` — ответ legacy handler остаётся авторитетным;
- `shadow` — legacy ответ авторитетен, новый движок только рассчитывает сравнение и trace;
- `enforce` — авторитетны валидированные события и состояние `FileEventStore`, после чего часть состояния проецируется в legacy room для старого UI.

Это уже работающая интеграция. Базовый тактический UI и подтверждённый переход группы между сценами в `enforce` переведены на server-authoritative команды и события; переход в распознанное поселение может в том же commit создать каталожного торговца через `ShopAssembler`. Администратор также может собрать исполнимую встречу через `EncounterAssembler`: сервер сам выбирает разрешённые профили, считает XP budget и размещение, а затем атомарно фиксирует создание встречи и старт боя. Но это ещё не полный cutover: `legacy/shadow` browser fallback, compatibility PUT и party vote, неполное покрытие правил и неатомарная room projection сохраняют обходные пути вокруг event stream.

## Runtime-схема

```mermaid
flowchart TD
    UI["React UI / useGameSession"]
    API["server/index.mjs HTTP API"]
    Room["Legacy room JSON + CAS"]
    Orch["GameOrchestrator"]
    Mode["EngineModeResolver"]
    Legacy["Legacy handler + RouterAIClient + tools"]
    Parse["Intent Parser"]
    Retrieve["Rule Retriever + srd_5_2_1"]
    Judge["Adjudicator"]
    Engine["Rules Engine + Dice Service"]
    Npc["Deterministic NPC scheduler"]
    Encounter["EncounterAssembler + SRD mini-compendium"]
    Director["Director transition builder"]
    Architect["Scene Architect"]
    Shop["Scene commerce + ShopAssembler"]
    Events["FileEventStore: events + snapshots"]
    Narrator["Narrator + visibility brief + verifier"]
    Trace["FileTraceStore + explanation"]
    Projection["Compatibility projection"]

    UI --> API
    API --> Room
    API --> Orch
    Orch --> Mode
    Orch --> Parse
    Parse --> Retrieve
    Retrieve --> Judge
    Mode -->|legacy / shadow| Legacy
    Judge -->|shadow calculation| Engine
    Judge -->|enforce| Engine
    Engine -->|enforce commit| Events
    API -->|StartCombat / EndTurn| Npc
    Npc --> Engine
    API -->|admin difficulty + theme| Encounter
    Encounter -->|CreateEncounter + StartCombat| Engine
    API -->|resolved party decision| Director
    Director --> Architect
    Architect --> Shop
    Director -->|AdvanceScene + optional CreateMerchant| Engine
    Engine -->|NPC commits| Events
    Events --> Narrator
    Orch --> Trace
    Legacy --> Orch
    Narrator --> Orch
    Orch --> API
    Events --> Projection
    Projection --> Room
    API --> UI
```

В `shadow` Rules Engine не коммитит рассчитанные события. Event store при этом может быть создан ленивым импортом исходного room state. В `legacy` event store не требуется для обработки хода.

## Точки входа

### Frontend

- `src/main.tsx` создаёт React root.
- `src/App.tsx` содержит основной экран, карту, чат, персонажей, торговца и admin UI. В `enforce` карта показывает initiative ribbon, merchant screen — серверные buy/sell quotes, кассу NPC и действие оценки нестандартного предмета без локальной механической мутации, а admin-раздел — ограниченные difficulty/theme controls EncounterAssembler и результат собранного roster.
- `src/useGameSession.ts` загружает комнату, вызывает narration/roll API, применяет совместимые effects и синхронизирует room state. Для боевых и торговых команд, включая `AppraiseItem`, в `enforce` он ждёт авторитетный ответ без локальной оптимистической механики; `SceneAdvanced` также заменяет scene/adventure/позиции/merchants из server state.
- `src/game-engine.ts` остаётся локальным fallback при ошибке AI.
- `src/auth-client.ts` и `src/ai-client.ts` адаптируют browser calls к существующим contracts.

Frontend пока выполняет две роли: UI/read-model adapter и, в `legacy/shadow`/fallback-сценариях, автор части механических изменений. В `enforce` базовый бой, переход сцены и торговля получают authoritative state/events с сервера, но прочие старые сценарии и room contract сохраняются через слой совместимости.

### HTTP-сервер

`server/index.mjs` остаётся единым `node:http` composition root. Отдельного framework router нет, но server startup реально связывает доменные зависимости. Основные маршруты:

| Маршрут | Подключённый контур |
|---|---|
| `GET /api/health` | RouterAI configuration, текущий engine mode, ruleset и число правил |
| auth/admin routes | `server/store.mjs`: пользователи, scrypt, sessions, hero access |
| `GET /api/rules/search` | Rule Retriever; auth и строгая фильтрация ruleset/enabled packs |
| `POST /api/campaigns` | Admin-only room creation, default `shadow`, немедленный `LegacyStateImported` |
| `PATCH /api/campaigns/:id/engine-mode` | Admin-only campaign override режима |
| `POST /api/campaigns/:id/commands` | Effective `enforce`: игрок — только `StartCombat/MoveActor/MakeAttack/EndTurn` за назначенного героя; admin — расширенный typed набор. Затем Rules Engine → event commit → при необходимости NPC scheduler → room projection |
| `POST /api/campaigns/:id/encounters/assemble` | Admin-only в `enforce`: bounded `difficulty/theme` → server-owned EncounterAssembler → атомарные `EncounterCreated + CombatStarted` → NPC scheduler/replay → viewer projection |
| `GET /api/campaigns/:id/turns/:turnId/explanation` | Trace lookup и `buildTurnExplanation`; `latest` разрешён |
| `GET/PUT /api/rooms/:code` | ACL-protected legacy read/full-state compatibility sync с CAS/validation |
| `POST /api/rooms/:code/dice` | `DiceService`, затем legacy `lastDiceRoll` room write |
| `POST /api/roll` | `RollRegistry.issue` для серверного `roll_id` |
| `POST /api/narrate` | Trusted room state, mode resolver, verified roll consume и `GameOrchestrator`; в `enforce` resolved party decision проходит отдельный server-owned Director flow и может одним commit создать сцену и лавку |
| merchant routes | Публичная витрина/quotes/касса, player bargain/appraise/buy/sell, admin lifecycle и ручной `ShopAssembler`; все изменения в `enforce` проходят Rules Engine и FileEventStore |
| image routes | Authenticated generation/read; per-user generation rate limit |

Любой неизвестный `/api/*` получает JSON 404. Остальные пути обслуживаются из `dist` как SPA.

## Обработка `/api/narrate`

1. Сервер проверяет сессию, доступ к кампании и владение активным героем.
2. State из body не считается доверенным: сервер загружает `room.state` по campaign ID.
3. Per-user rate limit проверяется до дорогой работы.
4. `EngineModeResolver` выбирает `test → user → campaign → global → legacy`.
5. Переданный `roll_id` потребляется через `RollRegistry` с проверкой campaign, actor и idempotency. В `enforce` произвольный клиентский roll запрещён.
6. В `enforce` сервер проверяет, завершено ли сохранённое групповое решение. Если оно требует перехода, server-owned Director flow строит `AdvanceScene` и при необходимости `CreateMerchant`; присланные клиентом `commands` и попытка передать capability игнорируются.
7. Для остальных действий `GameOrchestrator` строит видимую проекцию, intent, retrieval queries и adjudication plan. Далее действует ветвление по режиму:
   - `legacy`: вызывается legacy handler, сохраняется trace, event commit отсутствует;
   - `shadow`: legacy handler даёт ответ, Rules Engine рассчитывает альтернативу, сохраняется comparison, commit отсутствует;
   - `enforce`: команды валидируются, события коммитятся идемпотентно, Narrator получает ограниченный brief, verifier проверяет narration.
8. В `enforce` authoritative state проецируется в room JSON для совместимости с UI.

Команда `/why` возвращает объяснение последнего или указанного trace, не выполняет новый ход и устанавливает `turn_consumed: false`.

Если RouterAI key отсутствует, `legacy` и `shadow` narration возвращают `AI_NOT_CONFIGURED`. `enforce` и structured command path способны использовать deterministic Narrator без внешней модели.

## Обработка перехода сцены в `enforce`

1. Источником запуска служит resolved `agentInteraction` и выбранная опция группы. Пока само голосование хранится в compatibility-room, а не отдельными событиями — это остаточная граница доверия.
2. `SceneArchitect` выдаёт ограниченные параметры назначения и карты. `director-scene-transition.mjs` нормализует их, строит semantic fingerprint от campaign/action и канонический `AdvanceScene`.
3. `scene-commerce.mjs` сводит предложение Директора к versioned плану: `create|none`, allowlisted settlement/theme, bounded budget и причина. Локацию, seed, merchant ID, persona, stock и цены агент не задаёт.
4. Для поселения `ShopAssembler` создаёт каталожный proposal; если торговец с той же нормализованной строкой локации уже существует, он повторно используется без сброса stock. Для wilderness постоянная лавка по умолчанию не создаётся.
5. `AdvanceScene` и optional `CreateMerchant` разрешаются последовательно и попадают в один commit как `SceneAdvanced` и `MerchantCreated`. Команда запрещена при активном бое и недоступна через generic typed-command endpoint.
6. Reducer заменяет карту, переносит отряд на уникальные проходимые клетки у входа, очищает прежних enemies/entities/map feedback/combat, закрывает party interaction и обновляет adventure history. `scene-narration.mjs` рассказывает только по committed transition/arrival/merchant events.
7. `SceneAdvanced` фиксирует `interaction_id + resolved_option_id`. Параллельное исполнение одного решения сериализуется: победитель коммитит переход, второй ключ получает `409 PARTY_DECISION_ALREADY_CONSUMED`.
8. Retry победившего idempotency key читает committed batch напрямую, не вызывает Scene Architect/LLM повторно и возвращает прежний deterministic результат; повторное использование ключа для другого перехода получает `409`.
9. Player response проходит viewer projection, а реплика перехода получает стабильный message ID и сохраняется в compatibility journal вместе с room projection.

Ограничение идентичности локации принципиально: отдельного `location_id` ещё нет, поэтому одноимённые разные места могут быть ошибочно объединены, а переименование может создать вторую лавку.

## Сборка встречи в `enforce`

1. Администратор выбирает в UI только сложность `easy|medium|hard` и тему `generic|goblinoids|undead|beasts|raiders`; endpoint также требует viewed state version и idempotency key. `CreateEncounter` через общий typed-command route запрещён.
2. Сервер загружает авторитетные карту, живых героев, их уровни и позиции. Присланные stat blocks, HP, КД, атаки, XP, participants или координаты не входят в контракт и отклоняются.
3. `EncounterAssembler` считает официальный SRD 5.2.1 XP Budget per Character для каждого уровня 1–20 и выбирает в пределах бюджета и quantity cap одну или несколько записей из 12 server-owned профилей: два гоблина, скелет, зомби, волк, гигантская крыса, два вида гигантских пауков, орк, хобгоблин, кобольд и багбир. Intent агента/администратора ограничен только allowlisted difficulty/theme; числовые профили он не сочиняет.
4. Размещение допускает только раскрытые проходимые клетки, достижимые из области группы ортогональным путём, без feature/occupancy и не ближе двух клеток — 10 футов — от каждого героя. Seed ограничен и используется для воспроизводимого выбора и tie-break, а не как текстовая инструкция.
5. Rules Engine повторно выводит proposal из авторитетного state и фиксирует `EncounterCreated` вместе с `CombatStarted` одним commit. Initiative включает только живых героев и enemy IDs созданной встречи; reducer сохраняет encounter registry, противников, позиции и combat state.
6. После commit используется тот же bounded NPC scheduler. Event replay восстанавливает встречу и бой, а tactical narration строится только из committed events.
7. Player projection оставляет видимые имя, HP, КД, скорость, координаты и `stat_block_id`, но не выдаёт внутренний provenance/source payload. Admin response сохраняет полный proposal для диагностики.

Это mini-compendium из 12 профилей, а не полный monster corpus. Он хранит локальные миниатюры, несколько атак и ограниченные исполняемые traits/особые действия, включая pack tactics, nimble escape, aggressive, martial advantage, surprise attack, undead fortitude, poison, prone и web. В нём нет полной модели saves/skills, resistances/immunities, multiattack, spellcasting, legendary/lair actions, recharge, loot или rewards. Ручной admin flow пока не подключён автоматически к Director/scene transition.

## Обработка боевой команды в `enforce`

1. Сервер проверяет session, campaign ACL и effective `enforce` mode.
2. Для non-admin применяется отдельный allowlist из четырёх команд и проверяется владение героем. Атаковать таким путём можно только живого противника из `state.enemies`.
3. Клиентская команда сокращается до доверенного минимума: type, actor ID, target ID либо destination и expected version. Сервер заново выводит участников боя, attack profile, AC, damage, advantage/disadvantage, range и provenance из сохранённого состояния.
4. `RulesEngine` использует общий actor lookup `players + actors + enemies`, проверяет очередь, жизнь участника/цели, action, ортогональный путь по проходимым клеткам, стены, occupancy, скорость и уже потраченное movement.
5. События идемпотентно коммитятся в FileEventStore; reducer обновляет HP/`alive`, позиции, initiative/action economy, `activePlayerId`, `tacticalTurn`, `battleLog` и `mapFeedback`.
6. После `StartCombat` или `EndTurn` bounded scheduler последовательно обрабатывает server-owned enemies до следующего живого PC. Он детерминированно оценивает допустимые сочетания цели и действия, дальность, ожидаемый урон, шанс добивания, КД, контроль и поддержку союзников, затем двигается, применяет выбранное умение/атаку и завершает ход; побеждённые пропускаются, а бой заканчивается при поражении стороны. Dice при этом остаются серверными.
7. Сервер загружает итоговый replay state, строит тактическую реплику только по committed events, сохраняет её идемпотентно вместе с compatibility journal, проецирует state в legacy room и возвращает `authoritative_state`, объединённые mechanics, `npc_turns` и room version. UI отдельно отображает структурированный `battleLog` как «Боевую хронику».

Этот цикл умеет продолжить встречу, созданную EncounterAssembler, но не является полным Tactical Controller: решения NPC остаются bounded rule-based policy без LLM, долгосрочного планирования, spellcasting, multiattack и полной модели реакций/окружения.

## Обработка торговли в `enforce`

1. UI запрашивает витрину для выбранного доступного героя и NPC в текущей локации.
2. Сервер загружает latest event state и возвращает публичную persona, кошелёк героя, `merchant_purse_cp`, stock, server-derived buy/sell quotes и `expected_state_version`.
3. Клиент отправляет только `BargainWithMerchant`, `AppraiseItem`, `BuyItem` или `SellItem`, идентификаторы, количество при сделке, viewed version и idempotency key. Цена, appraisal policy и валютная дельта в контракт не входят.
4. `merchant-economy.mjs` разрешает `catalog_id`, доверенную event-sourced appraisal attestation, базовую цену/provenance, bounded basis-point policy, ликвидность кассы и sellability. `item-appraisal.mjs` детерминированно выводит bounded цену из server-owned категории/редкости/состояния. `RulesEngine` проверяет ACL actor scope, присутствие NPC, отсутствие боя, stock/funds/quantity/version и выполняет серверный бросок торга.
5. `MerchantItemAppraised` записывает fingerprinted аттестацию в `mechanics.item_appraisals`. Один `MerchantPurchaseCompleted` либо `MerchantSaleCompleted` атомарно меняет кошелёк героя, кассу торговца, инвентарь и stock; bargain хранится отдельно для пары герой–торговец. Reducer добавляет соответствующую запись в bounded `economyLog`.
6. FileEventStore обеспечивает optimistic locking, semantic request fingerprint, durable idempotency и replay. Compatibility projector переносит currency/inventory/merchants/mechanics/economy log в room, после чего UI заменяет состояние authoritative response.

Автоматическая базовая лавка в поселении уже работает, включая bounded стартовую кассу, а нестандартный предмет можно оценить через server policy. Но это не автономная городская экономика: нет услуг, устойчивого диалога, репутации, supply/demand и автоматических restock clocks. Ручной `RestockMerchant` существует, долгосрочного расписания пополнения нет; appraisal пока не идентифицирует магические свойства и считает состояние предмета `serviceable`.

## Модули и их фактический статус

| Модуль | Реализовано и подключено | Остаточное ограничение |
|---|---|---|
| `contracts.mjs` | Общие LLM, rule, campaign, event и snapshot contracts | Не все legacy boundaries выражены интерфейсами |
| `engine-mode.mjs` | Строгие `legacy/shadow/enforce` и precedence; вызывается HTTP runtime | Нет готовой автоматической rollout/rollback policy по метрикам |
| `llm-client.mjs` | Timeout, error taxonomy, JSON/tool validation, allowlist; используется text paths | Image generation остаётся отдельным provider call |
| `rule-pack.mjs` | Строгая загрузка, schema и numeric integrity | Один минимальный pack; нет подписанного registry packs |
| `rule-retriever.mjs` | RU/EN lexical, aliases, typo tolerance, local vector/ontology и filters | Нет внешних embeddings, production metrics и полного корпуса |
| `intent-parser.mjs` | Реально вызывается orchestrator | Ограниченный rule-based набор intents |
| `adjudicator.mjs` | Формирует plans/rulings для orchestrator | Неполное P0/P1 покрытие и workflow утверждения ruling |
| `dice-service.mjs` | Все серверные d20-пути используют единый crypto/default RNG | Browser fallback всё ещё использует `Math.random` |
| `roll-registry.mjs` | Issue/register/consume и повтор consume по idempotency | In-memory: теряется при рестарте, не multi-process |
| `rules-engine.mjs` | Command validation, общий lookup героев/actors/enemies, trusted combat profile, `CreateEncounter`, path/range/turn/action checks, базовый death-save/stabilization lifecycle с 1d4-hour stable recovery, Bless/Bane, Beacon of Hope, Death Ward, позиционные Aura of Life и Aura of Protection, Fighter Indomitable 9–12 с атомарной паузой/перебросом любого failed save, Resistance 2024, автоматический Constitution save концентрации из общего damage pipeline, trusted-melee nonlethal knockout с Short Rest/лечением/первой помощью, `AdvanceScene`, appraisal/торговые события, атомарная касса и reducer/replay; авторитетен в `enforce` | Нет диагоналей, cover/LOS, полной weapon/spell semantics, всех condition effects, полного rest recovery, всех внешних причин окончания концентрации и оставшегося корпуса save/death features до 12 уровня |
| `encounter-assembler.mjs` | Официальный SRD 5.2.1 XP budget уровней 1–20, 12 server-owned monster profiles с изображениями, несколькими атаками и ограниченными traits, bounded difficulty/theme, deterministic selection и безопасные revealed/reachable spawn cells не ближе 10 футов | Mini-compendium не содержит полного corpus, полной модели saves/resistances, multiattack, spellcasting, legendary/lair/recharge, loot/rewards; нет автоматического Director integration |
| `encounter-narration.mjs` | Детерминированная реплика только по committed `EncounterCreated`/`CombatStarted` | Не создаёт механические факты и не заменяет полноценное описание существ/тактики |
| `merchant-economy.mjs` | Versioned price allowlist, currency conversion, bounded merchant policy/purse, catalog/appraisal quotes, sellability и public projection | Малый catalog; нет EP, services, reputation, supply/demand и автоматических restock clocks |
| `item-appraisal.mjs` | Строгий allowlist descriptor, category/rarity/condition formula, bounded CP, provenance и SHA-256 fingerprint | Это price policy, а не идентификация магии; merchant path пока фиксирует `serviceable` |
| `scene-commerce.mjs` / `director-scene-transition.mjs` | Bounded commerce intent, semantic fingerprint, atomic `SceneAdvanced` + optional `MerchantCreated`, защита server-only capability | Party vote ещё compatibility-room; повторное использование торговца основано на строке, а не `location_id` |
| `shop-assembler.mjs` | Детерминированные persona/stock/policy/стартовая касса из server-owned catalog, settlement/theme/budget limits | Только базовая лавка; нет services, диалога и economy simulation |
| `scene-narration.mjs` | Детерминированно объединяет committed transition, arrival и созданного торговца | Не является полноценным автономным рассказчиком сцены или NPC dialogue engine |
| `npc-social.mjs` / `npc-social-check.mjs` / `npc-social-controller.mjs` | Persistent NPC, приватные профили, двухфазные server-owned проверки, отношения с порогами, обещания с дедлайнами/последствиями, replay и player projection | Нет фракционной репутации, графа свидетелей, расписаний NPC и автоматического разрешения условных обещаний по мировым событиям |
| `npc-turn-scheduler.mjs` | Bounded deterministic enemy policy с оценкой цели/действия, дистанции, урона, контроля и поддержки союзников; отдельные идемпотентные commits, skip defeated и auto-end до следующего PC | Нет LLM Tactical Controller, долгосрочных целей, spellcasting, multiattack, полной модели reactions/cover/height/environment, loot/rewards |
| `event-store.mjs` | Активные immutable commits, optimistic version, durable idempotency, snapshots/checksums, replay, lazy legacy import | File adapter ориентирован на один процесс; room projection не в одной транзакции |
| `game-orchestrator.mjs` | Активная точка сборки режимов, intent, retrieval, adjudication, engine, narration и trace; принимает Director capability только как серверный `Symbol` | Shadow может сравнивать независимо полученные броски; intent coverage ограничен |
| `security.mjs` / `viewer-projection.mjs` | Command allowlist, visible-state projection, player projection room/commands/narrate, публичные enemy/encounter поля без внутреннего source/provenance, narration brief, delimiters и verifier | Explanation endpoint не перепроецирует каждое событие по visibility |
| `narrator.mjs` | LLM или deterministic narration после commit; verifier подключён | Не является полнофункциональным NPC/scene simulator |
| `trace-store.mjs` | Активная запись trace, redaction, `/why` и explanation | File storage; campaign ACL есть, тонкая event visibility выдачи отсутствует |
| `migrations/001-event-engine.mjs` | Dry-run, точная `.bak`, idempotent metadata update | Runner не объединён с event import, mode switch и очисткой migration marker в одну операцию |

Версионированные prompts находятся в `prompts/<role>/v1.txt`; trace фиксирует версии intent parser, adjudicator, narrator и verifier, когда они применимы.

## Состояние и persistence

### Legacy room/read model

```text
storage/rooms/<code>.json
  version
  state = совместимый GameState
  updatedAt
```

`version` обеспечивает optimistic conflict detection. `validateRoomUpdate` проверяет campaign membership через hero IDs, неизменность roster, право менять своих героев, append-only природу новых сообщений, размер карты, campaign/mode permissions и неубывание `state_version`. В `enforce` non-admin PUT дополнительно восстанавливает из event store механические поля игроков, currency/inventory, enemies, merchants, mechanics, tactical turn, battle/economy log, ruleset lock и клетки карты; от игрока сохраняется только allowlist presentation-полей персонажа. При этом широкий narrative state и более широкие права admin сохраняются, поэтому PUT всё ещё не равен command-only модели.

### Event state

```text
<DND_STORAGE_DIR>/engine/
  immutable commit batches
  idempotency metadata
  checksummed snapshots
```

`normalizeCampaignState` добавляет ruleset lock, `state_version` и разделы `mechanics`. Новые кампании импортируются при создании; существующие — лениво при первом `shadow/enforce` ходе. `enforce` коммитит события с expected state version и idempotency key, затем reducer формирует authoritative state.

`persistAuthoritativeProjection` переносит в room выбранные HP, enemies, mechanics, inventory/currency, merchants, movement, active/tactical turn, battle/economy log, map feedback, scene/entities/adventure/suggestions/закрытие interaction и rulings. Это compatibility adapter, а не транзакционная проекция: если последующий `saveRoom` конфликтует, event commit уже состоялся, а HTTP response может вернуть прежнюю room version.

### Остальные данные

- `<DND_STORAGE_DIR>/auth.json` — пользователи, password/session hashes и hero IDs;
- `<DND_STORAGE_DIR>/turn-traces/<campaign>` — redacted turn traces;
- `<DND_STORAGE_DIR>/generated/items` — generated images;
- browser `localStorage` — резервная совместимая копия UI-state.

Путь generated images теперь следует `DND_STORAGE_DIR`; прежнее ограничение о жёстко заданном project storage устранено.

## Правила и provenance

Pack `data/rule_packs/srd_5_2_1` содержит 23 двуязычных оригинальных пересказа, 25 glossary terms, 23 ontology edge, manifest и coverage metadata. Он загружается при старте и используется `/api/rules/search` и orchestrator retrieval. Rules Engine ссылается на существующие IDs pack; известного ID mismatch нет.

В `enforce` события несут `source_rule_ids` или `ruling_id`, trace хранит retrieval, план, commands, rolls, events и versions. Это даёт provenance для реализованного среза, но не превращает минимальный corpus в полное покрытие SRD.

## Случайность

| Путь | RNG/registry | Статус |
|---|---|---|
| `/api/rooms/:code/dice` | `DiceService` default crypto | Активен, результат дополнительно пишется в room |
| `/api/roll` | `RollRegistry` → `DiceService` | Активен; выдаёт проверяемый `roll_id` |
| Legacy `roll_check` | `DiceService` | Активен в legacy/shadow handler |
| Rules Engine | Инъецированный `DiceService` | Активен в shadow/enforce calculations |
| Enforce tactical UI | Typed command → Rules Engine `DiceService` | Сервер авторитетен для initiative/attack/damage |
| Legacy/shadow browser fallback | `Math.random` | Всё ещё активен в `src/game-engine.ts` и прежнем tactical path |

Единый серверный RNG подключён, но полного единственного roll authority пока нет: browser fallback остаётся, Roll Registry не durable, а shadow legacy/engine расчёты могут выполнить разные броски.

## Auth и runtime security

Активные меры:

- `scrypt`, timing-safe comparison, случайные session tokens и только их SHA-256 hashes на диске;
- `HttpOnly`, `SameSite=Lax`, conditional `Secure` cookie;
- server-only RouterAI key;
- room ACL через admin role или назначенного героя в roster;
- actor ownership и command allowlist;
- trusted server state для narration;
- auth для rule search, rooms, generated files и AI endpoints;
- same-host/localhost Origin check для mutating methods;
- CSP, `X-Content-Type-Options`, Referrer/Permissions Policy и CORP;
- body size limit, auth-attempt rate limit и per-user narration/image limits;
- prompt data delimiters, state visibility projection, deterministic narration verifier и trace redaction.

Ограничения:

- self-registration открыта;
- Origin-less requests разрешены, отдельного CSRF token нет;
- rate-limit maps и Roll Registry находятся в памяти;
- hero assignment служит membership model, отдельной сущности campaign membership нет;
- non-admin compatibility PUT в `enforce` не может заменить сохранённую боевую механику, но broad narrative state и admin divergence остаются;
- explanation route применяет campaign ACL, но не отдельную visibility projection к каждому trace event;
- CSP разрешает только self styles, поэтому внешний Google Fonts import может не загрузиться;
- нет durable token/cost quota RouterAI, только request-count limits.

## Проверенная область

Актуальный suite включает unit tests доменных модулей, event-store reopen/replay, migration dry-run/backup/idempotency, orchestrator modes, security, viewer projection, narrator и trace.

Дополнительно `test/game-flow-integration.test.mjs` проверяет связанный domain flow от legacy import через исследование, ruling, check/save, spell, бой, лечение, condition и rest до reopen/replay и `/why`.

Real-HTTP integration scenarios запускают настоящий `server/index.mjs` на временном storage. Совместимый API-flow проверяет создание shadow-кампании, admin switch в `enforce`, rule search, damage, idempotent retry, explanation, `/api/narrate /why` с игнорированием forged client state и API 404. Отдельные flows проверяют обычного игрока в бою и торговле (`AppraiseItem`, отказ от forged price/policy, ограниченную кассу, buy/sell/replay), административный EncounterAssembler с отказом от forged профилей/координат/participants, атомарным start, NPC scheduler, player projection и replay, а также Director → `SceneAdvanced` → `ShopAssembler`: атомарный городской переход, отсутствие лавки в wilderness, защиту от forged system command, concurrent exactly-once consumption решения, replay без повторного картографа, private-memory containment, долговечный journal и replay после перезапуска HTTP-процесса.

Не заявлено автоматизированное multi-browser E2E, Docker/Compose, RouterAI с реальным ключом, миграция рабочего storage, rollback/cutover, публичный tunnel, multi-process или нагрузочный сценарий. Поэтому текущую архитектуру корректно считать подключённым вертикальным срезом strangler-перехода, а не завершённой заменой baseline.
