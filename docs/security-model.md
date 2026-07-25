# Модель безопасности

## Область и текущий статус

Сервис рассчитан на небольшую частную кампанию, но может быть опубликован через внешний tunnel. Публичная ссылка считается интернет-доступной: знание URL не является средством защиты.

Runtime исполняется только в режиме `enforce`. Авторитетные команды проходят через Rules Engine и FileEventStore, а `/api/narrate` — через Game Orchestrator. Compatibility room сохранён только как server-owned read-модель; legacy handler, shadow execution и broad room write удалены. Это сужает границу доверия, но не означает завершённое production hardening.

Защищаемые свойства:

- учётные записи, session tokens, `ROUTERAI_API_KEY` и admin setup token;
- персонажи, инвентари, сообщения и скрытые данные кампании;
- целостность HP, ресурсов, инициативы, бросков, scene/adventure transition, валюты героя, кассы торговца, appraisal registry, инвентаря, merchant stock и событий;
- однократное исполнение команды и однократное потребление броска;
- привязка кампании и provenance результата к выбранному ruleset;
- ограничение раскрытия private/GM-only данных в HTTP-ответах, LLM context и traces;
- доступность сервиса, контроль AI/image расходов и provenance материалов.

## Границы доверия

| Участник | Доверие | Фактическая роль |
|---|---|---|
| Неаутентифицированный посетитель | недоверенный | setup/login/register и static content |
| Игрок | частично доверенный | доступ к кампании определяется назначением hero; не источник авторитетного state |
| Admin/ведущий | привилегированный | пользователи, герои, кампании и rulings |
| Browser | недоверенный для механики | UI и типизированные команды |
| Node server | доверенная execution boundary | auth, ACL, validation, rules, events, projection и narration orchestration |
| LLM/RouterAI | недоверенный генератор | разбор/повествование; не получает прямой доступ к repository writes |
| Proxy/tunnel | внешняя transport boundary | передача трафика; не источник identity или authorization |
| Filesystem/OneDrive | persistence boundary | требует backup, single-writer discipline и проверки восстановления |

ACL кампании сейчас основан на роли admin либо наличии у пользователя назначенного героя в комнате. Это реальная проверка доступа, но не отдельная модель membership с явными ролями участника и жизненным циклом приглашения/исключения.

## Классы данных

### Секреты

- `ROUTERAI_API_KEY`;
- `ADMIN_SETUP_TOKEN` до завершения setup;
- raw session token в cookie;
- `.env` и его резервные копии.

Секреты нельзя помещать в Git, prompts, URLs публичного tunnel, traces, migration reports или необработанные error responses. Session хранится в cookie с `HttpOnly` и `SameSite=Lax`; на диске хранится SHA-256 hash токена. `Secure` зависит от конфигурации deployment.

### Частные игровые данные

- email и display name;
- character sheets, inventories и campaign messages;
- скрытые клетки, NPC plans и GM-only state;
- private rolls, скрытые DC, точные нераскрытые параметры врагов и внутренние traces.

Для LLM используется ограниченный `NarrationBrief`, а события, state и объяснение
хода проходят viewer-specific visibility projection.

### Публичные и аутентифицированные данные

- compiled frontend и обычные static assets публичны;
- generated item выдаётся только аутентифицированному пользователю;
- `/api/health` может раскрывать служебные metadata о доступности компонентов.

## Активные меры в runtime

### Аутентификация и авторизация

- Passwords хешируются `scrypt` с уникальной salt; сравнение выполняется через `timingSafeEqual`.
- Session token генерируется случайно, в cookie используется `HttpOnly`/`SameSite=Lax`, на диске хранится только hash.
- Admin routes проверяют роль.
- Room read, narration и turn explanation требуют доступа по admin/hero-assignment ACL; broad room write retired.
- Механические команды проверяют command allowlist, actor ownership/GM override, ожидаемую версию state и provenance. Для non-admin разрешён узкий боевой набор и отдельные `BargainWithMerchant`, `AppraiseItem`, `BuyItem`, `SellItem` от имени назначенного героя.
- Создание кампании доступно admin; endpoint переключения engine mode retired и возвращает `410`.
- Generated items требуют аутентификации.

### Целостность правил, бросков и событий

- Rule Retriever строго ограничивает поиск ruleset кампании; IDs Rules Engine согласованы с Rule Pack.
- Dice Service использует ограниченную grammar выражений и server-side RNG.
- Roll Registry связывает выданный бросок с владельцем и поддерживает one-time consume.
- FileEventStore активен в новом контуре: immutable commits, stream version, durable idempotency, snapshots/checksums, replay и process lock.
- `/api/campaigns/:id/commands` доступен участнику кампании. Обычный игрок получает узкий combat allowlist и не может передать авторитетные participants, attack modifier, AC, damage/range или управлять чужим актёром; администратор сохраняет расширенный диагностический typed-command контур.
- Merchant endpoints дополнительно проверяют присутствие NPC в текущей локации, отсутствие активного боя и `expected_state_version` просмотренной котировки. Запрос игрока не переносит цену, appraisal policy/descriptor, валютную дельту, шаблон предмета, stock, модификатор проверки или d20; сервер заново выводит их из каталога, allowlisted appraisal policy и event state. `AppraiseItem` записывает отдельную fingerprinted аттестацию, а покупка/продажа одним событием меняет валюту героя, кассу NPC, предмет и stock. Semantic request fingerprint вместе с idempotency key не допускает повторного результата или переиспользования ключа для другого предмета.
- В боевом пути Rules Engine выводит профиль атаки и цель из сохранённого state, проверяет очередь, action/movement, карту, стены, occupancy, path, speed и range. Враги входят в actor lookup, а их ходы выполняет bounded deterministic scheduler отдельными идемпотентными commit-ами.
- `POST /api/campaigns/:id/encounters/assemble` доступен только администратору и принимает bounded `difficulty/theme`, viewed version, seed/idempotency metadata. Stat blocks, HP, КД, атаки, XP, participants и spawn coordinates не входят в контракт: Rules Engine повторно собирает proposal из авторитетной карты, уровней и позиций. `CreateEncounter` через общий command endpoint отклоняется.
- EncounterAssembler выбирает только server-owned SRD 5.2.1 primary-attack profiles и официальный XP budget уровней 1–20. Spawn возможен только на revealed/walkable клетке, достижимой от группы, без feature/occupancy и минимум в двух клетках (10 футах) от каждого героя; `EncounterCreated + CombatStarted` фиксируются одним commit. Player projection оставляет идентичность, позицию, `alive` и качественное состояние здоровья врага, но удаляет точные HP/максимум, КД, скорость, stat block и скрытые модификаторы до server-side раскрытия в `mechanics.enemy_knowledge`.
- Переход сцены доступен только server-owned Director capability. `/api/narrate` отбрасывает клиентские `commands`/`commandCapability`, generic typed-command route отклоняет `AdvanceScene`, а Rules Engine требует director/admin context и отсутствие активного боя.
- Director может передать только bounded scene/shop intent. Сервер канонизирует карту, выводит location/decision-derived seed/merchant/catalog/price и коммитит `SceneAdvanced` + optional `MerchantCreated` одним batch. `interaction_id + resolved_option_id` обеспечивает exactly-once consumption при конкурентных ключах, а победивший retry читается из событий без нового model call.
- `/api/narrate` отклоняет присланные клиентом `state`, `player`, raw roll и engine mode. Состояние загружается сервером, а подтверждённые изменения проходят через orchestrator.
- Групповые решения и голоса сохраняются событиями.
- Новые кампании сразу создаются в единственном режиме `enforce`.

### LLM boundary и visibility

- RouterAI вызывается через общий client wrapper с ограниченными ролями и versioned prompts.
- Game Orchestrator разделяет intent parsing, adjudication, execution и narration.
- В LLM передаётся data-only context с delimiters и минимальный `NarrationBrief`.
- Narrator не является источником механических событий.
- Verifier сравнивает narration с подтверждёнными events/projection и при нарушении может вернуть deterministic safe summary.
- Trace Store редактирует известные поля секретов перед записью.

### HTTP и abuse controls

- Ответы получают `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, CSP и `Cross-Origin-Resource-Policy`.
- Origin проверяется: разрешены same-host и localhost development origins. Запрос без заголовка `Origin` допускается.
- Для narration действует in-memory per-user limit 40 запросов за 10 минут; для image generation — 10 за 10 минут; admin endpoint сборки встреч имеет отдельный in-memory limiter.
- Auth limiter остаётся in-memory и привязан к socket IP.
- Размер JSON body ограничен примерно 1 МБ; filenames generated assets строятся из UUID и allowlisted extension.

## Остаточные угрозы и ограничения мер

### Compatibility read model и presentation writes

`PUT /api/rooms/:id` retired, поэтому браузер не может заменить механическое или повествовательное состояние целиком. Room JSON пишет только серверный projector, а checkpoint подтверждается после совпадения канонического SHA-256.

Оставшееся ограничение: для редактируемых presentation-полей персонажа и кампании ещё нужны отдельные типизированные команды. До их появления такие локальные UI-изменения не должны считаться сохранёнными.

Старые snapshots не считаются доверенными автоматически. `cutover:verify` сравнивает room, snapshot и replay и завершает работу с ошибкой при расхождении; импорт разрешён только offline после backup и явного принятия канонического состояния.

### Неполная модель membership и visibility

Hero assignment предотвращает чтение комнаты произвольным аутентифицированным пользователем, но не заменяет explicit campaign membership repository с ролями и отзывом доступа. Room representation остаётся широкой для допущенного участника.

`GET /api/campaigns/:id/turns/:turnId/explanation` проверяет доступ к комнате и
повторно фильтрует команды, броски и события под конкретного участника. Остаточный
риск — новые типы trace payload должны добавляться в тот же allowlist-проектор.

### Неатомарность event state и read model

Событие сначала фиксируется в FileEventStore, затем authoritative projection сохраняется в compatibility room. Эти операции, consume Roll Registry и запись trace не объединены одной транзакцией. Durable outbox, reconciliation и hash checkpoint восстанавливают проекцию, но временное расхождение возможно.

Требуемое усиление: общая транзакционная база либо проверенная crash-recovery процедура для event, roll consume и trace.

### Повтор команды и жизненный цикл броска

FileEventStore обеспечивает durable idempotency механической команды по campaign/idempotency key. Roll Registry переживает restart одного процесса, но не координируется между несколькими instances. Event commit и roll consume не атомарны.

Browser gameplay RNG и второй shadow-roll удалены. Initiative, attack, damage и поддержанные проверки выполняются сервером.

### Остаточные риски экономики

SRD catalog entries неизменяемы, и известный `catalog_id` перекрывает snapshot price. Для homebrew простой `base_price_cp`, provenance или поддельный appraisal object из legacy import не считаются достаточным доверием: цену подтверждает только `MerchantItemAppraised` в event stream. Аттестация имеет versioned category/rarity/condition policy, SHA-256 fingerprint и связь с actor/item/stack key; изменение предмета делает запись неприменимой. Merchant workflow принимает только `item_id`, а состояние пока задаёт как `serviceable`, поэтому эта формула не доказывает магические свойства или фактическую сохранность предмета.

`merchant.purse_cp` ограничен тем же безопасным CP-диапазоном, проходит lifecycle validator и виден в quote projection. Покупка пополняет кассу, продажа списывает её; недостаток средств и переполнение проверяются до события, а before/after значения входят в purchase/sale payload для replay. Legacy merchant без кассы получает детерминированный compatibility reserve, но его происхождение, как и остального импортированного snapshot, нужно отдельно подтвердить при cutover.

Текущий catalog покрывает малый набор предметов, EP отсутствует, а Persuasion proficiency/expertise не выводятся из полной модели персонажа. Equip/use effects не выведены из versioned item templates. Event-sourced merchant lifecycle доступен только admin/director контуру, а ShopAssembler принимает лишь allowlisted catalog stock, bounded adjustment и выводит кассу, услугу и restock policy; автоматический Director flow использует тот же validator и event batch. Persistent social conversation, отношения, серверный торг, услуги и economy clock сохраняются и воспроизводятся после restart. Всё ещё нет signed quote expiry, theft, supply/demand, механических эффектов специализированных услуг и защиты экономики нескольких кампаний общей БД. Наценки, appraisal formula, минимум выкупа 1 CP и результат торга являются версионированной policy кампании, а не утверждением о правиле SRD.

### Остаточные риски перехода сцены

`SceneAdvanced` и автоматически созданный `MerchantCreated` атомарны внутри
FileEventStore commit. Compatibility-room projection остаётся отдельной
записью, но durable outbox marker, monotonic checkpoint и startup/GET
reconciliation автоматически восстанавливают её после сбоя.

Тактическая сцена и узел `worldMap` используют устойчивый `location_id`, поэтому повторный вход возвращает сохранённую карту. Для торговцев действует legacy fallback по нормализованной строке локации: два разных одноимённых места всё ещё могут переиспользовать одного NPC, а переименование — создать второго. Это ограничение MVP экономического compatibility-пути, а не надёжная identity model.

### Остаточные риски EncounterAssembler

Mini-compendium содержит только пять профилей и переносит из SRD лишь HP, КД, скорость, initiative bonus и один основной удар вместе с CR/XP provenance. Это не полные stat blocks: traits, saves/skills, resistances/immunities, multiattack, spells, reactions и особые действия не исполняются. Поэтому метка сложности отражает официальный XP budget и локальную bounded allocation policy, но не доказывает фактический баланс встречи с учётом недоступной механики или состава ресурсов группы.

Автономный Director умеет запросить bounded encounter. Tactical Controller
выбирает server-owned action profile, цель и путь, после чего Rules Engine
повторно валидирует команды. XP/loot/recovery и authenticated SSE multiplayer
работают. За пределами vertical slice остаются полный monster corpus,
legendary/lair actions, высоты, cover и multiprocess realtime coordination.

### CSRF, Origin и proxy trust

Origin check и `SameSite=Lax` снижают риск browser CSRF, но CSRF token/double-submit mechanism отсутствует. Запросы без `Origin` допускаются для non-browser clients, поэтому Origin check не является аутентификатором. Нужны явная production allowlist, CSRF policy для cookie-authenticated mutations и доверенная конфигурация proxy hops.

### Abuse и стоимость AI

Narration/image limits работают на пользователя, но хранятся только в памяти, сбрасываются при рестарте и не синхронизируются между процессами. Они считают requests, а не tokens или фактическую стоимость. Self-registration остаётся доступной, поэтому злоумышленник может создавать несколько accounts. Нет campaign budget, durable quota, concurrency limit и admin cost kill switch.

### CSP и внешние ресурсы

Активная CSP повышает базовую защиту, но legacy frontend запрашивает Google Fonts. Текущая `style-src`/`font-src` policy может блокировать внешний font stylesheet или font files; визуальное отличие не является security bypass, но показывает, что policy и frontend dependencies ещё нужно согласовать.

### Filesystem и масштабирование

FileEventStore имеет lock и checksummed snapshots, однако file persistence ориентирована на один Node process. Legacy auth/room JSON и новый event store не образуют общую транзакцию; OneDrive sync может добавлять внешние конфликты. Для multi-process deployment нужен database-backed adapter или формально проверенный single-writer режим.

### Supply chain и provenance

Dependency specs в `package.json` используют `latest`, хотя lockfile присутствует. Base image tags не закреплены digest-ами. Происхождение части PNG assets не подтверждено. Нужны pinned inputs, dependency audit/SBOM и документированные права на assets.

## Авторизация механической команды

Целевой и для базового `enforce`-боя в основном реализованный порядок проверки:

1. аутентификация пользователя;
2. admin/hero-assignment access к кампании;
3. actor ownership или admin override;
4. для игрока — только combat allowlist и живая enemy target; клиентские combat overrides отбрасываются;
5. ruleset lock и strict retrieval;
6. schema/command allowlist и provenance IDs;
7. expected stream/state version;
8. idempotency key;
9. resource/turn/action, path/walls/occupancy/speed/range constraints;
10. только затем — roll, event commit и projection.

Event commit и legacy projection связаны recoverable outbox/checkpoint
protocol. Оставшаяся граница — внешний roll consume и trace write не атомарны с
event commit.

## Logging и trace

Допустимо логировать request/turn/campaign IDs, обезличенный user ID, engine mode, rule/event IDs, versions, latency и error code. Не следует логировать `.env`, raw cookies, passwords, полный state/prompt, private narration, hidden state, base64 images и необработанные provider responses.

Trace Store выполняет redaction известных секретных ключей, а explanation endpoint
дополнительно строит проекцию под конкретного viewer.

## Проверенность

Актуальный suite включает unit tests основных доменных модулей. Real-HTTP scenarios на реальном `server/index.mjs` проверяют совместимый admin flow, player combat flow, merchant flow, EncounterAssembler и Director scene/shop flow: allowlist/ownership, серверный профиль атаки вместо поддельных полей, отказ от forged encounter stat blocks/coordinates/participants, safe spawn, атомарные `EncounterCreated + CombatStarted`, NPC turn, forged price/appraisal policy/state/system command, stale quote, appraisal registry/fingerprint, ограниченную кассу, bargain/buy/sell, атомарные `SceneAdvanced + MerchantCreated`, concurrent exactly-once consumption, event replay без нового model call, durable narration journal, player visibility projection и private-memory containment.

Это не доказывает безопасность real RouterAI, Docker/Pinggy, production
migration/restore, multi-process concurrency, shadow divergence, rate-limit
bypass или penetration testing. SSE/concurrent two-user и crash recovery
проверяются real-HTTP тестом, но не полноценной автоматизацией браузерных окон.

## Gates для production-использования `enforce`

- explicit campaign membership и event-level visibility для reads/traces;
- отказ от оставшихся broad narrative/admin state writes;
- транзакционная либо восстанавливаемая связка внешнего roll consume и trace с
  уже восстанавливаемыми event/projection;
- database-coordinated Roll Registry и quotas с token/cost budget;
- CSRF/trusted-proxy/production-origin policy;
- backup/restore и reconciliation rehearsal;
- UI, RouterAI, migration, concurrency и security integration tests;
- подтверждённый provenance assets/rules/dependencies.
