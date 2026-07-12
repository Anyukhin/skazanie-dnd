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

**Что изменено.** Создан `data/rule_packs/srd_5_2_1`: manifest, glossary, 19 RU/EN project-original paraphrase rules, ontology edges и coverage. Loader проверяет schema, уникальность, exact ruleset и числовую целостность перевода. Pack загружается при старте, фиксируется в campaign metadata и используется retriever/engine.

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

## Этап 4. Events, state version и persistence — подключено, частично

**Что было.** Клиент или legacy tools формировали новый state, а room JSON заменялся почти целиком; доменного event journal не было.

**Что изменено.** `FileEventStore` хранит immutable commit batches, durable idempotency, optimistic version checks, checksummed snapshots и replay. Новая кампания импортируется сразу; существующая может быть лениво импортирована при shadow/enforce. `POST /api/campaigns/:id/commands` коммитит events и затем проецирует авторитетные поля обратно в legacy room. Боевой reducer сохраняет state, `battleLog`, `mapFeedback`, enemy state, initiative/action economy и позиции. Metadata migrator отдельно поддерживает dry-run, byte backup и идемпотентное добавление полей.

**Почему.** Механические изменения становятся воспроизводимыми и объяснимыми.

**Совместимость.** Legacy room остаётся compatibility projection и по-прежнему имеет свой CAS `version`. Metadata migration и import — разные операции; `legacy_import_required` не очищается автоматически. Event commit и последующий `saveRoom` не образуют одну транзакцию: при конфликте projection event уже может быть сохранён.

**Тесты.** Unit-тесты проверяют append, idempotency/conflicts, snapshots, replay/reopen, backup и migration repeat. HTTP-тесты подтверждают commit, NPC follow-up commits, идемпотентный retry и идентичный combat replay после перезапуска процесса. Нет migration/cutover E2E на рабочем storage, multi-process competition и систематической crash injection.

Критерий завершения: атомарная либо надёжно восстанавливаемая outbox/projection схема, migration runner для import/reconciliation и production-like recovery tests.

## Этап 5. Базовый Rules Engine P0 — подключено, частично

**Что было.** Броски и исходы распределялись между LLM, server helpers и browser fallback.

**Что изменено.** Dice Service обслуживает server roll paths; Roll Registry выдаёт проверяемые roll references. Rules Engine валидирует actor/command/version/provenance и исполняет checks, saves, attacks/AC, damage defenses, healing, temporary HP, resources, generic conditions, initiative, action, concentration markers и zero-HP event. Общий actor lookup включает `players/actors/enemies`. В `enforce` player combat commands не принимают клиентские participants/profile/AC/damage/range: сервер выводит их из state и проверяет turn, path, walls, occupancy, speed, movement/action economy и attack range.

**Почему.** Механические вычисления должны выполняться кодом, а narration — описывать уже принятый результат.

**Совместимость.** Старый UI и legacy mode сохранены; browser fallback всё ещё имеет отдельный `Math.random` path. `/api/roll` использует новый registry, но registry пока in-memory.

**Тесты.** Есть unit-покрытие перечисленных механик, включая critical damage dice, attack follow-ups и явный `EndCombat`; domain integration проходит исследование, social ruling, check/save, spell/resource/concentration, инициативу, атаку, лечение, condition, завершение боя, отдых и restart/replay. HTTP-проверки охватывают прямой `ApplyDamage` и server-derived player attack. Не закрыты death saves, эффекты конкретных conditions, завершённый concentration save flow, bonus action/reaction consumption, rest recovery и полная weapon/spell derivation.

Критерий завершения: закрытая P0 matrix и отсутствие независимых механических путей вне engine.

### Server-authoritative combat slice — подключён, частично

**Что изменено.** Обычный игрок в `enforce` имеет только `StartCombat/MoveActor/MakeAttack/EndTurn` за назначенного героя. UI показывает инициативу/раунд/текущего участника и ждёт авторитетный ответ. Admin UI/API EncounterAssembler принимает bounded difficulty/theme, считает официальный XP budget SRD 5.2.1 уровней 1–20, выбирает roster из пяти server-owned primary-attack profiles, безопасно размещает его на revealed/reachable клетках не ближе 10 футов и коммитит `EncounterCreated + CombatStarted` атомарно. Bounded deterministic NPC scheduler делает ходы enemies до следующего живого PC, пропускает побеждённых и автоматически завершает бой при поражении стороны. Non-admin room `PUT` восстанавливает event-store combat state и оставляет только presentation allowlist листа.

**Ограничение.** `legacy/shadow` tactical fallback с `Math.random` сохранён. Monster mini-compendium содержит только пять проекций одного основного удара: нет traits, saves, resistances, multiattack, spells, особых действий и полного weapon corpus. Также нет Director auto-trigger, loot/rewards, диагоналей, difficult terrain, cover/LOS, полного condition/concentration/death lifecycle, Tactical Controller agent и multi-browser realtime.

**Тесты.** Domain/Real-HTTP flows проверяют derived encounter, отказ от forged stat blocks/coordinates/participants, safe spawn, atomic start, normal-player ACL, path/speed/occupancy, NPC scheduling, player projection, persistent journal, idempotency и replay/restart. Полный бой 4 PC + 3 NPC от spawn до loot и два одновременно подключённых браузера не проверены.

## Этап 6. Новый игровой цикл — подключено, частично

**Что было.** Один legacy prompt интерпретировал намерение, выбирал tool и писал narration; клиент применял effects.

**Что изменено.** `GameOrchestrator` объединяет Intent Parser, Adjudicator, retrieval, Rules Engine, Event Store, Narrator, visibility projection, deterministic Verifier и trace store. `/api/narrate` использует доверенное server state, проверяет membership/hero и verified roll, а `/api/campaigns/:id/turns/:turnId/explanation` и `/why` дают объяснение. Базовый тактический UI в `enforce` теперь идёт напрямую через typed command path; `legacy/shadow` narration effects остаются совместимым параллельным путём.

**Почему.** LLM не должен незаметно становиться источником механического state.

**Совместимость.** Сохранена форма существующего `/api/narrate`; выбранные авторитетные изменения проецируются обратно в room для старого frontend.

**Тесты.** Unit-тесты покрывают роли, verifier и orchestrator. Реальный HTTP-тест проходит совместимый `/why` и доказывает, что подделанный клиентом HP не принимается. Это не полный E2E всей цепочки: UI, настоящий LLM, все intents, visibility cases и restart между commit/explanation не проверены.

Критерий завершения: расширенный contract/E2E suite и покрытие всех P0 intents/visibility levels.

## Этап 7. Shadow и последовательное переключение — подключено, частично

**Что было.** Единственный активный legacy path.

**Что изменено.** Runtime разрешает `legacy`, `shadow` и `enforce`; новые кампании начинают в shadow, режим меняется администратором. Shadow сохраняет legacy outcome авторитетным и записывает сравнение; enforce коммитит новые events.

**Почему.** Кампании нужно переводить постепенно с наблюдаемым расхождением и быстрым возвратом.

**Совместимость.** Legacy остаётся fallback. Переключение выполняется по кампании, без удаления старых endpoints.

**Тесты.** Есть unit-проверки resolver/orchestrator и HTTP-проверка смены режима. Нет длительного shadow rollout, divergence SLO, canary на реальных данных и rollback rehearsal. Текущий shadow может независимо бросить кости в legacy и новом engine, поэтому сравнение случайных исходов не всегда эквивалентно; целевой single-roll invariant ещё не выполнен.

Критерий завершения: один общий зарегистрированный roll для обоих сравнений, стабильные divergence metrics и проверенный canary/rollback.

## Этап 8. Удаление legacy — не готово

**Что было.** Legacy был единственным рабочим runtime.

**Что изменено.** Новый путь интегрирован, но legacy намеренно сохранён как режим и compatibility layer.

**Почему.** Не закрыты P0 coverage, атомарность projection, массовая миграция, длительный shadow период, browser regression и recovery rehearsal.

**Совместимость.** Старый UI/API продолжают работать; удаление сейчас было бы несовместимым изменением.

**Тесты.** Перед удалением нужны UI/API regression, migrated-campaign replay/restart, public deployment, concurrency/load, security и rollback tests.

Удаление разрешено только после миграции всех активных кампаний, истечения rollback window и доказательства, что production requests не используют legacy mutation path.

## Ближайшие приоритеты

1. Сделать event commit и legacy projection атомарными либо гарантированно восстанавливаемыми.
2. Убрать второй независимый roll в shadow и собирать измеримые divergence reports.
3. Расширить EncounterAssembler от пяти primary-attack projections до полных разрешённых stat blocks, Director trigger и loot/rewards; довести геометрию, spells/conditions/death flow и Tactical Controller, затем убрать tactical browser fallback.
4. Добавить контролируемый bulk import/reconciliation runner с backup, dry-run и rollback rehearsal.
5. Расширить HTTP/UI/RouterAI/security tests до multi-browser/realtime и production-like набора; restart/replay базового combat slice уже покрыт.
6. Только затем начинать canary migration реальных кампаний и обсуждать удаление legacy.
