# Покрытие правил

> **Обновление этапа 8:** runtime теперь enforce-only. Упоминания
> `legacy/shadow` в старых строках таблиц описывают прежний срез и не означают
> доступный путь исполнения.

## Как читать таблицы

- **Корпус** — правило присутствует в `rules.jsonl` и доступно Retriever.
- **Engine** — Rules Engine имеет проверяемый command/event/reducer path.
- **Runtime** — путь достижим через подключённый `server/index.mjs`, прежде всего через enforce/orchestrator или `POST /api/campaigns/:id/commands`.
- **Тест** — существует автоматическая проверка. Пометка `unit` не означает HTTP/UI integration.

Статусы: **да**, **частично**, **нет**. Наличие runtime path не означает, что существующий UI уже формирует каждую structured command. Явно подключены к UI в `enforce` базовый цикл `StartCombat/MoveActor/MakeAttack/CastSpell/EndTurn`, управляемые призывы, merchant commands и admin-only сборка встречи по difficulty/theme.

## Rule Pack

| Показатель | Значение |
|---|---:|
| `ruleset_id` | `srd_5_2_1` |
| Версия manifest | `5.2.1` |
| Языки | canonical EN, display RU/EN |
| Правила | 23 |
| Glossary terms | 25 |
| Ontology edges | 23 |
| Формализация записей | 16 × `deterministic`, 7 × `structured`, 0 × `retrieval_only` |
| Материал | Оригинальные краткие пересказы механики |
| Числовая целостность RU/EN | Проверяется loader-ом и unit-тестом |

Это минимальный P0 corpus с небольшим economy slice: уровни formalization отражают текущую связь с engine, но не означают полноту редакции. Loader, Retriever и Rules Engine подключены к runtime; strict ruleset filter применяется до ранжирования. `GET /api/rules/search` даёт отдельный read-only доступ к поиску.

Machine-readable release coverage хранится в
`data/rules-coverage-matrix.json`. Команда `pnpm content:verify` сверяет её
с фактическими runtime-каталогами и проверяет ссылочную целостность; строгий
`pnpm release:verify` остаётся красным для любой обязательной категории со
статусом `partial|missing`.

## P0

| Механика | Корпус | Engine | Runtime | Тест | Остаточное ограничение |
|---|---|---|---|---|---|
| Dice expression parser | частично | да | да | unit | Отдельной полной grammar rule в corpus нет |
| Проверка характеристики | да | да | да, enforce | unit | Special checks и полный UI flow не моделируются |
| Спасбросок | да | да | да, enforce | unit | Generic ability save; сложные триггеры не оркестрованы |
| Бросок атаки | да | да | да, enforce UI/API | unit + authoritative HTTP | Профиль выводится сервером; безоружный PC fallback использует `1 + STR`, а EncounterAssembler projection содержит только один основной attack profile без multiattack/spells |
| Класс доспеха | да | да | да, enforce | unit + authoritative HTTP | Берётся из server actor; клиентский override игнорируется, но полной derivation AC из экипировки нет |
| Натуральные 1/20 | да | да | да, enforce | unit | Для атаки natural 1 промахивается, natural 20 отмечается critical и удваивает только damage dice, не модификатор |
| Урон | да | да | да | unit + domain integration + HTTP | `MakeAttack` и `ApplyDamage` создают zero-HP/concentration follow-ups; authoritative HTTP проверяет server-derived attack damage |
| Resistance/vulnerability/immunity | да | да | да, enforce | unit + spell scenario | Generic defenses работают; Resistance cantrip редакции 2024 выбирает один из 11 типов и один раз за ход уменьшает подходящий урон на серверный 1к4 с replay/provenance. Полного registry всех типов/источников защит всё ещё нет |
| Лечение | да | да | да, enforce | unit | Ограничение максимумом HP есть; browser flow отдельно не проверен |
| Temporary HP | да | да | да, enforce | unit | Используется большее значение; stacking model минимален |
| Advantage/disadvantage | да | да | да на server paths | unit | Legacy browser fallback всё ещё может бросать отдельно |
| Initiative | да | да | да, enforce UI/API | unit + domain integration + HTTP | Участники выводятся из живых party и enemy IDs staged encounter; tie rule упрощён и не настраивается кампанией |
| Turn order / EndCombat | да | да | да, enforce UI/API | unit + domain integration + HTTP | NPC scheduler идёт до следующего PC, завершает бой при поражении стороны и закрывает encounter; loot/reward flow отсутствует |
| Action/movement consumption | да | частично | да для combat slice | unit + HTTP | Attack/spell расходуют action; path расходует movement; spell с нужным casting time расходует bonus action; атака по возможности расходует reaction. Ready отсутствует |
| Bonus action | да | частично | да для combat spell slice | unit | Отдельно расходуется `healing-word`; общего feature/action corpus пока нет |
| Reaction | да | частично | да, enforce UI/API | unit | `UseCombatAction` закрывает проверяемые окна Shield/Parry/Riposte/Uncanny Dodge/Opportunity Attack; нет универсального Ready и произвольных триггеров |
| Fighter Indomitable (9–12) | да | да | да, enforce UI/API | unit + replay + projection | Один раз после failed save: атомарная пауза исходной команды, обязательный новый d20 с бонусом уровня воина, без расхода Reaction; работает для generic/spell/area/concentration/death saves. Несколько воинов в одной массовой атаке отвечают последовательно, а исходная команда применяется один раз после последнего решения. Short Rest не возвращает ресурс, Long Rest возвращает |
| Basic resource pools | да | да | да, enforce | unit | Generic spend/restore и class-specific Short/Long Rest recovery policy; полного корпуса ресурсов всех классов и предметов нет |
| Conditions | да | частично | частично | unit | Add/remove хранится, эффекты конкретных conditions не исполняются |
| Concentration | да | да для damage lifecycle | да, enforce | unit + replay | Любой `DamageApplied` проходит единый follow-up: СЛ max(10, половина фактического урона), Constitution modifier и классовое владение, Bless/Bane/Mind Sliver/Silvery Fortune/Aura of Protection, success/failure и очистка связанного эффекта. 0 ОЗ завершает концентрацию без броска; временные HP не отменяют save, иммунитет отменяет. Не закрыты все внешние причины завершения и полный effect corpus |
| Падение до 0 HP, смерть и нокаут | да | да для базового SRD lifecycle | да, enforce UI/API | unit + scheduler/replay/reopen | Автоматический d20 в начале хода, 3 успеха/провала, natural 1/20, урон при 0 HP, massive damage, Medicine DC 10, healing reset и event-sourced восстановление стабильного героя через 1d4 часа; Bless/Bane меняют итог, Beacon of Hope даёт преимущество и максимальное лечение, Death Ward один раз оставляет цель на 1 HP. Aura of Life позиционно защищает союзников в 30 футах от некротического урона и уменьшения максимума HP, а в начале хода поднимает союзника с 0 до 1 HP до выполнения death save. Полностью бессознательный отряд автоматически проматывает время только после победы без живых врагов. Nonlethal knockout проверяет trusted melee-профиль, оставляет 1 HP, начинает Short Rest, допускает раннее пробуждение лечением/первой помощью и завершает бой без убийства цели. При `party_incapacitated` исход оставлен рассказчику. Не закрыты остальные особенности до 12 уровня и generic instant death без урона |

`/api/campaigns/:id/commands` принимает запрос лишь когда effective campaign mode равен `enforce`. Обычный игрок ограничен безопасным combat set, включая `CastSpell`, и назначенным героем или принадлежащим ему призывом; сервер отбрасывает клиентские participants/profile/AC/damage/range/DC/cost/stat-block overrides. Admin сохраняет расширенный диагностический набор. Команды проходят actor scope, expected version и provenance validation, а commit идемпотентен в FileEventStore.

## P1

| Механика | Корпус | Engine | Runtime | Тест | Ограничение |
|---|---|---|---|---|---|
| Перемещение | нет | частично | да, enforce UI/API | unit + HTTP | Ортогональный shortest path, стены, occupancy, speed/action economy и выход из 5-футовой зоны досягаемости проверяются; нет диагоналей, difficult terrain и forced movement |
| Дальность и зоны | нет | частично | да для attack/spell slice | unit + HTTP | Атаки и боевые заклинания используют общую Chebyshev-дистанцию; нет cover, reach/size и полного набора area templates |
| Укрытие | нет | нет | нет | нет | Нет corpus rule и вычисления |
| Line of sight | нет | нет | нет | нет | Legacy revealed cells не образуют formal LOS |
| Отдых | нет | частично | да, structured command | частично | Start/complete events применяют class-specific resource recovery policy; нет полного SRD lifecycle сна, прерываний, Hit Dice и истощения |
| Заклинания | нет | частично | да, enforce UI/API | unit + browser audit | Ограниченный server-owned catalog: attack/save/healing/summon; нет полного compendium, upcast, components и сложных эффектов |
| Предметы | частично | частично | да, structured command + merchant API | unit + HTTP | Небольшой server catalog и transfer/stock есть; полного item/effect corpus, use/equip/attunement/crafting нет |
| Монеты и торговля | да, 2 правила | да, economy slice | да, enforce UI/API | unit + real HTTP | CP/SP/GP/PP, buy/sell/bargain/service, server appraisal, merchant purse, canonical location и auto-restock; нет EP, theft, supply/demand, механических эффектов специализированных услуг и полной экономики |
| Плавание в бурной воде | да | частично | да, legacy/shadow | unit + retrieval | SRD СЛ 15 извлекается и используется для hazard; полной геометрии скорости плавания нет |
| Удушье | да | частично | частично | unit + retrieval | Hazard и условие снятия сохраняются; автоматический счёт минут и уровней Истощения по ходам ещё не реализован |
| Длительные эффекты | частично | частично | да для hazards | unit | Условие окончания и обязательная проверка исполняются; общего scheduler длительностей пока нет |
| Блоки существ | частично | частично | да, admin enforce UI/API | unit + domain integration + HTTP | EncounterAssembler имеет 12 server-owned SRD 5.2.1 profiles с несколькими действиями и ограниченными traits; нет полного stat block corpus, полной модели saves/resistances, spellcasting, legendary/lair/recharge и особых действий |
| Сборка встречи | нет | частично | да, admin enforce UI/API | unit + domain integration + HTTP | Официальный XP budget уровней 1–20, bounded difficulty/theme, quantity cap и revealed/reachable spawn не ближе 10 футов; нет Director auto-trigger, tactics profiles, loot/rewards |
| Способности классов | частично | частично | частично, enforce UI/API | unit + replay | Реализованы отдельные server-owned способности, включая Aura of Protection и Fighter Indomitable; полного корпуса уровней 1–12 нет |

## P2 и rulings

| Область | Текущее состояние |
|---|---|
| Импровизированные действия | Adjudicator создаёт `ruling_draft`; orchestrator подключён, но набор распознаваемых intents ограничен |
| Редкие взаимодействия | Не включены в pack; требуют явного ruling и provenance, а не догадки Narrator |
| Социальные сцены | Повествовательный путь есть, отдельного deterministic subsystem нет |
| House rules | Metadata поля предусмотрены; repository/approval/versioning не реализованы |
| `RecordRuling` | Event поддерживается structured command path и FileEventStore |
| Объяснения | Trace доступен через `/why` и explanation endpoint; проверка видимости содержимого trace пока недостаточна |

## Retrieval coverage

Unit-тесты включают русский, склонения, опечатки, English, mixed RU/EN, paraphrases, ontology expansion, deterministic ordering и запрет чужого `ruleset_id`/disabled pack. Реальный HTTP integration-сценарий проверяет поиск запроса о помехе/преимуществе.

Domain integration flow дополнительно связывает legacy import, typed commands, rolls, events, snapshots/replay, narration trace и `/why`; он не поднимает HTTP/server process и не заменяет browser E2E.

Не измерены:

- recall/precision на representative обезличенном наборе;
- latency/memory под нагрузкой;
- malicious very-long input;
- external embedding adapter;
- поиск по разрешённым house/campaign packs.

## Events, replay и объяснимость

Rules Engine создаёт события для checks, attacks, damage, healing, temporary HP, resources, generic conditions, автоматических concentration saves и завершения эффектов, encounter/combat/turn, movement, time, reveal/objective/entities/items/rulings и торговли. Reducer формирует persistent encounter registry, список противников, `battleLog`, `mapFeedback`, `economyLog`, appraisal registry, позиции, enemy `alive`, initiative/action economy, кошельки героев, кассы торговцев и merchant stock. `EncounterCreated` и `CombatStarted` создаются одним commit, а FileEventStore хранит immutable commits, idempotency metadata, snapshots и replay state.

Проверено unit-тестами: reducer/replay parity, optimistic conflict, idempotent retry/conflict, reopen store и snapshots. Domain/real-HTTP paths проверяют server-derived encounter proposal, safe spawn, atomic start, direct damage и player combat commits, NPC turns, player projection, повтор idempotency key и идентичный authoritative combat state после replay/перезапуска HTTP-процесса. Не проверены:

- crash между event commit и legacy room projection;
- multi-process append;
- bulk import/cutover реальных room files;
- unknown event schema upgrade;
- visibility-filtered explanation для всех пяти уровней.

## Ссылочная целостность rule IDs

Текущие `RULE_IDS` Rules Engine приведены к фактическим IDs `srd_5_2_1`; прежнее расхождение paths устранено. Этот факт нельзя считать бессрочной гарантией: обязательный gate для дальнейших изменений должен проверять, что каждый provenance ID существует в locked enabled pack или в явно разрешённом house/ruling registry, а shadow/enforce не запускается при unresolved IDs.

## Итог

Новый Engine имеет реальное runtime-покрытие, но оно неоднородно: typed command endpoint и UI делают базовый server-authoritative combat и admin-created encounter достижимыми, orchestrator покрывает ограниченный набор intents, а `legacy/shadow` browser paths сохраняются для совместимости. Domain integration и real-HTTP scenarios подтверждают сборку встречи, atomic start, NPC scheduler и restart/replay; отдельный сценарный набор подтверждает death-save lifecycle и reopen event store. Не закрыты полный monster/action corpus, loot/rewards, диагонали/difficult terrain/cover/LOS, все conditions и death-save exceptions, Tactical Controller, автоматическая интеграция EncounterAssembler с Director, multi-browser realtime, RouterAI и production migration/rollback E2E.
