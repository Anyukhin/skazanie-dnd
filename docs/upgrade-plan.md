# План постепенной модернизации

План следует Strangler Pattern. Статус относится к рабочему HTTP runtime, а не просто к наличию файла:

- **подключено** — компонент вызывается `server/index.mjs`;
- **частично** — основной путь работает, но не закрыты важные механики, эксплуатационные гарантии или все сценарии;
- **изолировано** — код и unit-тесты есть, но пользовательский путь его не вызывает;
- **не готово** — критерии production/cutover не выполнены.

## Этап 0. Baseline и безопасная точка отсчёта — частично

**Что было.** React/Vite UI, `node:http` API, RouterAI legacy tools, JSON-комнаты, browser fallback и отсутствие автоматизированного regression-набора.

**Что изменено.** Зафиксированы исходная архитектура, API, точки прямой мутации и риски. Появились unit-тесты доменных модулей, полный domain integration flow Orchestrator→EventStore→reopen/replay и real-HTTP integration scenarios на временном storage: совместимый admin/API flow и отдельный player combat/restart flow.

**Почему.** Модернизация должна отличать исходное поведение от нового и оставлять проверяемый rollback.

**Совместимость.** Старые room endpoints и форма ответа `/api/narrate` сохранены. Полный baseline commit/tag и подтверждённый remote в рамках этой работы не создавались.

**Тесты.** HTTP-тесты используют реальный `server/index.mjs`; combat flow проверяет идемпотентность и replay после restart. Это не заменяет multi-browser/realtime UI, Docker/Pinggy, настоящий RouterAI, рабочие данные или crash recovery между event commit и room projection.

Критерий завершения: проверенный baseline tag, независимый backup и расширенный characterisation suite старого UI/API.

## Этап 1. Interfaces, adapters и feature flags — подключено, частично

**Что было.** `server/index.mjs` напрямую вызывал RouterAI и не имел формальных контрактов или режимов двигателя.

**Что изменено.** Добавлены contracts, `RouterAIClient`, версии role prompts и resolver `legacy/shadow/enforce`. `server/index.mjs` создаёт эти компоненты; `/api/narrate` разрешает режим, а администратор может менять campaign mode через `PATCH /api/campaigns/:id/engine-mode`.

**Почему.** Явные границы позволяют менять реализацию по одной кампании без удаления совместимого пути.

**Совместимость.** Значение resolver по умолчанию — `legacy`; новые кампании создаются с `shadow`. Legacy handler сохранён внутри orchestrator. Enforce может выдавать детерминированную narration без AI key, а legacy/shadow требуют доступный legacy AI path.

**Тесты.** Есть unit-проверки precedence, invalid modes, LLM JSON/tool validation и HTTP-проверка admin switch. Нет полного parity-теста всех legacy ответов и настоящего RouterAI.

Критерий завершения: стабильный compatibility suite, метрики режима и конфигурационный rollout без ручного изменения файлов.

## Этап 2. Rule Pack — подключено

**Что было.** Механика была распределена между prompt, tool descriptions, browser fallback и интерпретацией модели; versioned corpus отсутствовал.

**Что изменено.** Создан `data/rule_packs/srd_5_2_1`: manifest, glossary, 22 RU/EN project-original paraphrase rules, 22 ontology edges и coverage. Loader проверяет schema, уникальность, exact ruleset и числовую целостность перевода. Pack загружается при старте, фиксируется в campaign metadata и используется retriever/engine.

**Почему.** Разрешённый механический материал и стабильные citations должны существовать независимо от prompt.

**Совместимость.** Legacy path остаётся доступен. Rule IDs Rules Engine приведены к фактическим IDs pack; новые mappings обязаны проходить ту же проверку ссылочной целостности.

**Тесты.** Покрыты schema, edition mixing, path traversal и нарушение чисел/формул. Не реализованы подписанный registry packs и production provenance approval workflow.

Критерий завершения: формальная политика публикации/подписания pack и автоматический integrity gate для каждого нового corpus.

## Этап 3. Retrieval — подключено, частично

**Что было.** Отдельного поиска правил не было.

**Что изменено.** Добавлен deterministic hybrid retrieval: normalization, RU stemming, fuzzy matching, RU/EN aliases, lexical/local-vector score, ontology expansion и deterministic reranking. До scoring применяется exact `ruleset_id`/enabled-pack filter. Поиск доступен через `GET /api/rules/search` и используется новым игровым циклом.

**Почему.** Модель и adjudication получают малый проверяемый набор правил, а не весь корпус или случайную редакцию.

**Совместимость.** Search endpoint только читает данные; legacy narration может продолжить работу без retrieval.

**Тесты.** Unit-тесты покрывают русские формы, опечатки, EN/mixed queries, paraphrases, determinism, ontology и чужой ruleset; HTTP-сценарий проверяет поиск правила о преимуществе. Нет обезличенного quality dataset, recall/precision SLO и нагрузочного теста.

Критерий завершения: измеренные quality/latency thresholds на representative queries.

## Этап 4. Events, state version и persistence — подключено, критерий recovery выполнен

**Что было.** Клиент или legacy tools формировали новый state, а room JSON заменялся почти целиком; доменного event journal не было.

**Что изменено.** `FileEventStore` хранит immutable commit batches, durable idempotency, optimistic version checks, checksummed snapshots и replay. Новая кампания импортируется сразу; существующая может быть лениво импортирована при shadow/enforce. `POST /api/campaigns/:id/commands` коммитит events и затем проецирует авторитетные поля обратно в legacy room. Боевой reducer сохраняет state, `battleLog`, `mapFeedback`, enemy state, initiative/action economy и позиции. Metadata migrator отдельно поддерживает dry-run, byte backup и идемпотентное добавление полей.

**Почему.** Механические изменения становятся воспроизводимыми и объяснимыми.

**Совместимость.** Legacy room остаётся compatibility projection и по-прежнему
имеет свой CAS `version`. Commit содержит projection-outbox marker, metadata —
monotonic checkpoint; startup и room GET восстанавливают отставшую projection.
Metadata migration и import остаются разными операциями.

**Тесты.** Unit-тесты проверяют append, idempotency/conflicts, snapshots,
replay/reopen, pending/acknowledged projection и migration repeat. HTTP-тест
искусственно оставляет commit без room projection, перезапускает сервер и
проверяет автоматическое восстановление. Нет production migration/cutover E2E
на рабочем storage и multi-process competition.

Критерий завершения: атомарная либо надёжно восстанавливаемая outbox/projection схема, migration runner для import/reconciliation и production-like recovery tests.

## Этап 5. Базовый Rules Engine P0 — подключено, частично

**Что было.** Броски и исходы распределялись между LLM, server helpers и browser fallback.

**Что изменено.** Dice Service обслуживает server roll paths; Roll Registry выдаёт проверяемые roll references. Rules Engine валидирует actor/command/version/provenance и исполняет checks, saves, attacks/AC, damage defenses, healing, temporary HP, resources, generic conditions, initiative, action, полный damage→concentration save/fail workflow и базовый zero-HP lifecycle. Общий actor lookup включает `players/actors/enemies`. В `enforce` player combat commands не принимают клиентские participants/profile/AC/damage/range: сервер выводит их из state и проверяет turn, path, walls, occupancy, speed, movement/action economy и attack range.

**Почему.** Механические вычисления должны выполняться кодом, а narration — описывать уже принятый результат.

**Совместимость.** Старый UI и legacy mode сохранены; browser fallback всё ещё имеет отдельный `Math.random` path. `/api/roll` использует durable файловый registry с одноразовым consume; для multi-process deployment его нужно перенести в общую БД.

**Тесты.** Есть unit-покрытие перечисленных механик, включая critical damage dice, attack follow-ups, death saves/stabilization, Bless/Bane, преимущество и максимальное лечение Beacon of Hope, Death Ward, позиционные эффекты Aura of Life и Aura of Protection, автоматический concentration save с временными HP/иммунитетом/классовым владением и очисткой эффекта, nonlethal knockout оружием и ближним заклинанием, Short Rest/лечение/первую помощь и явный `EndCombat`; domain integration проходит исследование, social ruling, check/save, spell/resource/concentration, инициативу, атаку, лечение, condition, завершение боя, отдых и restart/replay. Отдельный scheduler/reopen flow проверяет три спасброска, стабилизацию, постбоевые 1d4 часа и пробуждение на 1 ОЗ; scheduler также завершает бой при живой нокаутированной цели на 1 ОЗ. HTTP-проверки охватывают прямой `ApplyDamage` и server-derived player attack. Не закрыты эффекты всех conditions, оставшиеся death-flow features до 12 уровня, все внешние причины окончания концентрации, полный rest recovery и полная weapon/spell derivation.

Критерий завершения: закрытая P0 matrix и отсутствие независимых механических путей вне engine.

### Server-authoritative combat slice — завершён для bounded vertical slice

**Что изменено.** Обычный игрок в `enforce` использует server-authoritative combat commands за назначенного героя, включая перемещение, атаки, заклинания, классовые действия, реакции и `EndTurn`. UI показывает инициативу/раунд/текущего участника, предлагает nonlethal toggle только для ближней атаки и ждёт авторитетный ответ. Сервер повторно проверяет trusted melee-профиль, оставляет нокаутированной цели 1 ОЗ, запускает Short Rest и поддерживает пробуждение от времени, лечения или Medicine СЛ 10. Admin UI/API EncounterAssembler принимает bounded difficulty/theme, считает официальный XP budget SRD 5.2.1 уровней 1–20, выбирает roster из 12 server-owned monster profiles, безопасно размещает его на revealed/reachable клетках не ближе 10 футов и коммитит `EncounterCreated + CombatStarted` атомарно. Bounded deterministic NPC scheduler делает ходы enemies и автоматические death saves до следующего управляемого PC, закрывает бой только после разрешения нестабильных героев и после безопасной победы выводит полностью стабильный бессознательный отряд из тупика через event-sourced 1d4-hour recovery; при живых врагах outcome остаётся решением рассказчика. Non-admin room `PUT` восстанавливает event-store combat state и оставляет только presentation allowlist листа.

**Ограничение.** `legacy/shadow` tactical fallback с `Math.random` сохранён.
Monster mini-compendium содержит 12 server-owned profiles, но не полный corpus:
отсутствуют legendary/lair actions, широкий spellcasting и множество редких
особых действий. Bounded Director trigger, Tactical Controller, loot/rewards и
SSE multiplayer работают; высоты, cover и сложная местность остаются вне
vertical slice.

**Тесты.** Domain/Real-HTTP flows проверяют derived encounter, отказ от forged
stat blocks/coordinates/participants, safe spawn, atomic start, normal-player
ACL, path/speed/occupancy, Tactical Controller, player projection, persistent
journal и idempotency. Сквозной сценарий проводит 4 PC против минимум 3 NPC от
spawn до loot, перезапускает сервер после committed атаки и проверяет
roll/command/rule/HP provenance. Отдельный multiplayer test держит два
authenticated SSE-соединения и выполняет concurrent commands.

## Этап 6. Новый игровой цикл — выполнено для автономного vertical slice

**Что было.** Один legacy prompt интерпретировал намерение, выбирал tool и писал narration; клиент применял effects.

**Что изменено.** `GameOrchestrator` объединяет Intent Parser, Adjudicator, retrieval, Rules Engine, Event Store, Narrator, visibility projection, deterministic Verifier и trace store. Отдельный автономный контур принимает шесть narrative-only intents и серверно исполняет `pacing → exploration/social/quest → EncounterAssembler → combat → rewards/downtime → travel → next scene`. Travel time/risk, random encounter, NPC social profile, XP/loot и расписания вычисляются без механических полей от LLM. `/api/narrate` использует доверенное server state, а `/autonomy/advance` доступен обычному участнику кампании. В UI видны текущая фаза и напряжение.

**Почему.** LLM не должен незаметно становиться источником механического state.

**Совместимость.** Сохранена форма существующего `/api/narrate`; выбранные авторитетные изменения проецируются обратно в room для старого frontend.

**Тесты.** Unit-тесты покрывают intents, pacing, travel/random encounter, social assembler, downtime, rewards, роли, verifier и orchestrator. Real-HTTP сценарий проводит обычных игроков через четыре Director intent, полный серверный бой, restart, reward/rest/travel и три сцены; автономная 30+ turn campaign сравнивает replay без snapshot и повторное открытие EventStore.

**Оставшееся ограничение.** Качество художественной импровизации с реальным LLM требует отдельного online-eval; механический автономный цикл от этого не зависит.

## Этап 7. Shadow и последовательное переключение — подключено, частично

**Что было.** Единственный активный legacy path.

**Что изменено.** Runtime разрешает `legacy`, `shadow` и `enforce`; новые кампании начинают в shadow, режим меняется администратором. Shadow сохраняет legacy outcome авторитетным и записывает сравнение; enforce коммитит новые events.

**Почему.** Кампании нужно переводить постепенно с наблюдаемым расхождением и быстрым возвратом.

**Совместимость.** Legacy остаётся fallback. Переключение выполняется по кампании, без удаления старых endpoints.

**Тесты.** Есть unit-проверки resolver/orchestrator и HTTP-проверка смены режима. Нет длительного shadow rollout, divergence SLO, canary на реальных данных и rollback rehearsal. Текущий shadow может независимо бросить кости в legacy и новом engine, поэтому сравнение случайных исходов не всегда эквивалентно; целевой single-roll invariant ещё не выполнен.

Критерий завершения: один общий зарегистрированный roll для обоих сравнений, стабильные divergence metrics и проверенный canary/rollback.

## Этап 8. Удаление legacy — runtime удалён, data cutover заблокирован аудитом

**Что было.** Legacy был единственным рабочим runtime.

**Что изменено.** `enforce` стал единственным исполняемым runtime. Удалены legacy/shadow ветки оркестратора, shadow comparison, live lazy import, `LegacyStateSynchronized`, browser gameplay fallback и broad room PUT. Новые кампании и общий публичный d20 записываются событиями. Compatibility room остался только server-owned read-моделью. Добавлены канонический projection SHA-256, hash-verified acknowledgement outbox и fail-closed `cutover:verify`.

**Почему этап ещё нельзя объявить завершённым для данных.** Read-only аудит семи существующих кампаний обнаружил projection drift во всех семи и snapshot/replay drift в одной. Автоматическое перезаписывание пользовательских сохранений запрещено без выбора канонической стороны и проверенной резервной копии.

**Совместимость.** Старый UI продолжает читать room projection, но не может записать её целиком. Старые snapshot импортируются только явным offline workflow.

**Тесты.** Enforce-only resolver/orchestrator, отсутствие browser RNG/mutators, strict payload, retired endpoints, replay без snapshots, projection hash и cutover fail-closed покрыты локально. До физического удаления `storage/rooms` нужны reconciliation на копии, restore rehearsal, public deployment, concurrency/load и rollback window.

Физическое удаление compatibility read-модели разрешено только после `cutover:verify = ready`, миграции всех активных кампаний и истечения rollback window. Live legacy mutation path уже закрыт.

## Ближайшие приоритеты

1. Определить канонический источник для семи расходящихся кампаний и исправить snapshot/replay drift на копии storage.
2. Добавить контролируемый reconciliation/import runner с manifest, backup, dry-run и rollback rehearsal.
3. Довести presentation edits до отдельных типизированных persistent-команд.
4. Перенести event/outbox/roll coordination в транзакционное хранилище для multi-process deployment.
5. Расширить HTTP/UI/RouterAI/security tests до multi-browser/realtime и production-like набора.
6. После зелёного `cutover:verify` и rollback window удалить compatibility room read-модель.
