# Покрытие правил

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
| Правила | 21 |
| Glossary terms | 25 |
| Ontology edges | 21 |
| Формализация записей | 14 × `deterministic`, 7 × `structured`, 0 × `retrieval_only` |
| Материал | Оригинальные краткие пересказы механики |
| Числовая целостность RU/EN | Проверяется loader-ом и unit-тестом |

Это минимальный P0 corpus с небольшим economy slice: уровни formalization отражают текущую связь с engine, но не означают полноту редакции. Loader, Retriever и Rules Engine подключены к runtime; strict ruleset filter применяется до ранжирования. `GET /api/rules/search` даёт отдельный read-only доступ к поиску.

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
| Resistance/vulnerability/immunity | да | да | да, enforce | unit | Generic damage type strings, полного registry типов нет |
| Лечение | да | да | да, enforce | unit | Ограничение максимумом HP есть; browser flow отдельно не проверен |
| Temporary HP | да | да | да, enforce | unit | Используется большее значение; stacking model минимален |
| Advantage/disadvantage | да | да | да на server paths | unit | Legacy browser fallback всё ещё может бросать отдельно |
| Initiative | да | да | да, enforce UI/API | unit + domain integration + HTTP | Участники выводятся из живых party и enemy IDs staged encounter; tie rule упрощён и не настраивается кампанией |
| Turn order / EndCombat | да | да | да, enforce UI/API | unit + domain integration + HTTP | NPC scheduler идёт до следующего PC, завершает бой при поражении стороны и закрывает encounter; loot/reward flow отсутствует |
| Action/movement consumption | да | частично | да для combat slice | unit + HTTP | Attack/spell расходуют action; path расходует movement; spell с нужным casting time расходует bonus action. Ready/reaction windows отсутствуют |
| Bonus action | да | частично | да для combat spell slice | unit | Отдельно расходуется `healing-word`; общего feature/action corpus пока нет |
| Reaction | да | нет | нет | нет | Нет `UseReaction` и trigger validation |
| Basic resource pools | да | да | да, enforce | unit | Generic spend/restore; rest не восстанавливает pools автоматически |
| Conditions | да | частично | частично | unit | Add/remove хранится, эффекты конкретных conditions не исполняются |
| Concentration | да | частично | частично | unit | Start/end и `ConcentrationCheckRequired` есть; save/fail завершение не собрано полностью |
| Падение до 0 HP | да | частично | частично | unit | Unconscious marker есть; death saves/stable/death lifecycle отсутствуют |

`/api/campaigns/:id/commands` принимает запрос лишь когда effective campaign mode равен `enforce`. Обычный игрок ограничен безопасным combat set, включая `CastSpell`, и назначенным героем или принадлежащим ему призывом; сервер отбрасывает клиентские participants/profile/AC/damage/range/DC/cost/stat-block overrides. Admin сохраняет расширенный диагностический набор. Команды проходят actor scope, expected version и provenance validation, а commit идемпотентен в FileEventStore.

## P1

| Механика | Корпус | Engine | Runtime | Тест | Ограничение |
|---|---|---|---|---|---|
| Перемещение | нет | частично | да, enforce UI/API | unit + HTTP | Ортогональный shortest path, стены, occupancy, speed/action economy проверяются; нет диагоналей, difficult terrain, forced movement и opportunity attacks |
| Дальность и зоны | нет | частично | да для attack/spell slice | unit + HTTP | Атаки и боевые заклинания используют общую Chebyshev-дистанцию; нет cover, reach/size и полного набора area templates |
| Укрытие | нет | нет | нет | нет | Нет corpus rule и вычисления |
| Line of sight | нет | нет | нет | нет | Legacy revealed cells не образуют formal LOS |
| Отдых | нет | частично | да, structured command | частично | Start/complete events без recovery policy |
| Заклинания | нет | частично | да, enforce UI/API | unit + browser audit | Ограниченный server-owned catalog: attack/save/healing/summon; нет полного compendium, upcast, components и сложных эффектов |
| Предметы | частично | частично | да, structured command + merchant API | unit + HTTP | Небольшой server catalog и transfer/stock есть; полного item/effect corpus, use/equip/attunement/crafting нет |
| Монеты и торговля | да, 2 правила | да, economy slice | да, enforce UI/API | unit + real HTTP | CP/SP/GP/PP, buy/sell/bargain, server appraisal, merchant purse и optimistic quote; нет EP, услуг, reputation, supply/demand, auto-restock и полной экономики |
| Плавание в бурной воде | да | частично | да, legacy/shadow | unit + retrieval | SRD СЛ 15 извлекается и используется для hazard; полной геометрии скорости плавания нет |
| Удушье | да | частично | частично | unit + retrieval | Hazard и условие снятия сохраняются; автоматический счёт минут и уровней Истощения по ходам ещё не реализован |
| Длительные эффекты | частично | частично | да для hazards | unit | Условие окончания и обязательная проверка исполняются; общего scheduler длительностей пока нет |
| Блоки существ | частично | частично | да, admin enforce UI/API | unit + domain integration + HTTP | EncounterAssembler имеет пять server-owned SRD 5.2.1 primary-attack projections; нет полного stat block: traits, saves/skills, resistances/immunities, multiattack, spells и особые действия отсутствуют |
| Сборка встречи | нет | частично | да, admin enforce UI/API | unit + domain integration + HTTP | Официальный XP budget уровней 1–20, bounded difficulty/theme, quantity cap и revealed/reachable spawn не ближе 10 футов; нет Director auto-trigger, tactics profiles, loot/rewards |
| Способности классов | нет | нет | нет | нет | Нет corpus и engine handlers |

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

Rules Engine создаёт события для checks, attacks, damage, healing, temporary HP, resources, generic conditions, concentration markers, encounter/combat/turn, movement, time, reveal/objective/entities/items/rulings и торговли. Reducer формирует persistent encounter registry, список противников, `battleLog`, `mapFeedback`, `economyLog`, appraisal registry, позиции, enemy `alive`, initiative/action economy, кошельки героев, кассы торговцев и merchant stock. `EncounterCreated` и `CombatStarted` создаются одним commit, а FileEventStore хранит immutable commits, idempotency metadata, snapshots и replay state.

Проверено unit-тестами: reducer/replay parity, optimistic conflict, idempotent retry/conflict, reopen store и snapshots. Domain/real-HTTP paths проверяют server-derived encounter proposal, safe spawn, atomic start, direct damage и player combat commits, NPC turns, player projection, повтор idempotency key и идентичный authoritative combat state после replay/перезапуска HTTP-процесса. Не проверены:

- crash между event commit и legacy room projection;
- multi-process append;
- bulk import/cutover реальных room files;
- unknown event schema upgrade;
- visibility-filtered explanation для всех пяти уровней.

## Ссылочная целостность rule IDs

Текущие `RULE_IDS` Rules Engine приведены к фактическим IDs `srd_5_2_1`; прежнее расхождение paths устранено. Этот факт нельзя считать бессрочной гарантией: обязательный gate для дальнейших изменений должен проверять, что каждый provenance ID существует в locked enabled pack или в явно разрешённом house/ruling registry, а shadow/enforce не запускается при unresolved IDs.

## Итог

Новый Engine имеет реальное runtime-покрытие, но оно неоднородно: typed command endpoint и UI делают базовый server-authoritative combat и admin-created encounter достижимыми, orchestrator покрывает ограниченный набор intents, а `legacy/shadow` browser paths сохраняются для совместимости. Domain integration и real-HTTP scenarios подтверждают сборку встречи, atomic start, NPC scheduler и restart/replay, но mini-compendium ограничен пятью primary-attack projections. Не закрыты traits/saves/resistances/multiattack/spells, loot/rewards, диагонали/difficult terrain/cover/LOS, full conditions/death saves, Tactical Controller, автоматическая интеграция EncounterAssembler с Director, multi-browser realtime, RouterAI и production migration/rollback E2E.
