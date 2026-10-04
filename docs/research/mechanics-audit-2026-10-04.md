# Аудит механик «Сказания» в сравнении с Baldur's Gate 3

Дата: 2026-10-04. Baseline: cb045a84, worktree codex/bg3-experience-roadmap.
Объём: только механики из серверного Rules Engine, их события, проекция и
основной UI; старые отчёты сверены с кодом. Статус «частично» означает, что
исполняемый срез есть, но BG3-подобная фича не покрыта целиком. Отсутствие
постоянного NPC-спутника — принятое решение владельца, а не пропущенная
реализация.

## Выводы

Архитектура уже держит правильную границу: typed-команда проходит ACL и
валидацию, Rules Engine создаёт события, reducer восстанавливает состояние,
viewer projection скрывает private/GM-данные, а Narrator получает commit-only
brief. Этот путь зафиксирован в [current-architecture.md](../current-architecture.md#L95)
и [product-principles.md](../product-principles.md#L91).

Основной разрыв с BG3 находится в широте тактических взаимодействий и в
предпросмотре последствий. Обычный бой, дальность, стены, занятость, реакции,
концентрация, укрытие, опасные области, nonlethal и обыск тела уже имеют
server-owned пути.

Нельзя переносить BG3-поведение поверх кампании 2014 незаметно. Высота,
взаимодействие поверхностей, shove с отбрасыванием и отдельные расходники
должны быть либо частью выбранной редакции, либо versioned house rule.
Правило высоты прямо отключено для D&D 2014 в
[tactical-geometry.mjs](../../server/rules/tactical-geometry.mjs#L569).

Самые полезные ближайшие улучшения: единый серверный preview, полноценный
forced movement/вертикальность, более богатая готовность, расширенный
surface/prop-контур, социальные исходы с типизированным fail-forward и
усиление Narrator verifier. Они дают ощущение BG3 без копирования его
контента и баланса.

## Матрица текущего покрытия

| Область | Фактический статус | Evidence и граница |
|---|---|---|
| Реакции | Частично, реализованный набор verified; последовательный resume verified | Девять реакций имеют режим ask/auto/never и durable событие; [reaction-preferences.mjs](../../server/reaction-preferences.mjs#L22), [reaction-preferences.test.mjs](../../test/reaction-preferences.test.mjs#L90), [spell-reaction-area-audit.test.mjs](../../test/spell-reaction-area-audit.test.mjs#L153) и [indomitable.test.mjs](../../test/indomitable.test.mjs#L303). Одно поле хранит текущую паузу, но не доказывает отсутствие stack; failing-сценария для stack пока нет. |
| Opportunity attack | Verified | Сервер проверяет реакцию, недееспособность, reach и выход из зоны по пути; [rules-engine.mjs](../../server/rules-engine.mjs#L4177), [reaction-preferences.test.mjs](../../test/reaction-preferences.test.mjs#L209). Отход, невидимость и Zephyr Strike подавляют триггер. |
| Shove/grapple | Partial для 2014 и BG3 | D&D 2014 разрешает shove выбрать prone или push 5 ft ([Basic Rules](https://www.dndbeyond.com/sources/dnd/basic-rules-2014/combat), [SRD CC v5.1 PDF](https://media.dndbeyond.com/compendium-images/srd/5.1/SRD_CC_v5.1.pdf)); текущий код проверяет contest и применяет только prone, что подтверждают [combat-actions.mjs](../../server/combat-actions.mjs#L57), [rules-dndsu-2014-review.test.mjs](../../test/rules-dndsu-2014-review.test.mjs#L609) и [rules-dndsu-2014-review.test.mjs](../../test/rules-dndsu-2014-review.test.mjs#L622). BG3-style edge/fall остаётся отдельным расширением. |
| Forced movement | Частично verified | Push/pull отдельных заклинаний создают ActorMoved с forced_movement и повторной проверкой входа в область; [rules-engine.mjs](../../server/rules-engine.mjs#L7743), [spell-forced-movement-and-typed-riders.test.mjs](../../test/spell-forced-movement-and-typed-riders.test.mjs#L29). Полного общего API и вертикального падения нет. |
| Jump | Частично verified | Long jump и swing авторитетны, но требуют боя/server plan и одной высоты; [rules-engine.mjs](../../server/rules-engine.mjs#L7040), [rules-engine.mjs](../../server/rules-engine.mjs#L9352), [rules-engine.mjs](../../server/rules-engine.mjs#L17312) и [compound-maneuver-preview.test.mjs](../../test/compound-maneuver-preview.test.mjs#L37). |
| Throw | Частично | Thrown weapon и thrown-area предметы проходят typed attack/area path; [rules-engine.mjs](../../server/rules-engine.mjs#L6635) и [rules-engine.mjs](../../server/rules-engine.mjs#L3320). Геройский thrown item пока не списывается через AmmunitionSpent ([attack-completion-audit.md](../attack-completion-audit.md#L91)); произвольный бросок предмета и возврат экземпляра не закрыты. |
| Ready | Частично | ActionReadied хранится и срабатывает на два server-recognized trigger; [rules-engine.mjs](../../server/rules-engine.mjs#L1789), [rules-engine.mjs](../../server/rules-engine.mjs#L14686) и [ready-action.test.mjs](../../test/ready-action.test.mjs#L52). Произвольное воспринимаемое обстоятельство и полноценная точка spell-release отсутствуют. |
| Surfaces/areas | Частично, сильный срез | Active effects поддерживают difficult terrain, entry/turn triggers, damage, condition, push, fire/web/douse; [rules-engine.mjs](../../server/rules-engine.mjs#L15587), [spell-lingering-zone-triggers.test.mjs](../../test/spell-lingering-zone-triggers.test.mjs#L48) и [spell-review-engine-mismatches.test.mjs](../../test/spell-review-engine-mismatches.test.mjs#L65). Нет общего каталога взаимодействий всех пропсов. |
| Height | Partial и ruleset-dependent | Cell elevation есть, 2024-style ranged high ground есть как house rule, 2014 возвращает level; [tactical-geometry.mjs](../../server/rules/tactical-geometry.mjs#L562), [rules-dndsu-2014-review.test.mjs](../../test/rules-dndsu-2014-review.test.mjs#L234) и [npc-tactics-cover.test.mjs](../../test/npc-tactics-cover.test.mjs#L114). Fly/climb/fall/edge knock-off не исполнены. |
| Cover/LoS | Verified для attack slice | Trajectory учитывает стены/двери/рёбра, cover — лучшие half/three-quarters от actor/feature; [tactical-geometry.mjs](../../server/rules/tactical-geometry.mjs#L553), [rules-engine.mjs](../../server/rules-engine.mjs#L3874) и [npc-tactics-cover.test.mjs](../../test/npc-tactics-cover.test.mjs#L80). Area-cover относительно центра не полный. |
| Concentration | Verified для damage/0 HP, partial overall | Damage pipeline считает DC max(10, half damage), Constitution save и end; [rules-engine.mjs](../../server/rules-engine.mjs#L21165) и [concentration-saves.test.mjs](../../test/concentration-saves.test.mjs#L39). Внешние причины и полный spell corpus не закрыты. |
| Dialogue checks | Verified server boundary, partial content | Две фазы: AbilityCheckResolved до LLM, затем NpcConversationRecorded; [npc-social.md](../npc-social.md#L14), [npc-social.test.mjs](../../test/npc-social.test.mjs#L215) и [npc-social.test.mjs](../../test/npc-social.test.mjs#L911). Нет group/opposed checks и social action в бою, кроме отдельного parley. |
| Fail-forward/quests | Частично | Квестовые clocks, proof facts, failure/abandoned и NPC death invalidation event-sourced; [world-memory.mjs](../../server/world-memory.mjs#L951), [quest-consequences.mjs](../../server/quest-consequences.mjs#L158), [quest-progress-evidence.test.mjs](../../test/quest-progress-evidence.test.mjs#L111) и [quest-consequence-knowledge.test.mjs](../../test/quest-consequence-knowledge.test.mjs#L35). Произвольные последствия свободных действий ограничены bounded adjudicator. |
| Companions | Решено вне scope | Приручённый зверь идёт по сценам и держит стражу, но не боевой актор; [beast-taming.mjs](../../server/beast-taming.mjs#L34). NPC-companion явно отложен в [experience-upgrade-plan-2.md](../experience-upgrade-plan-2.md#L6). |
| Camp/rest | Verified rest, partial BG3 camp | StartRest/Hit Dice/CompleteRest и мировые часы серверны; [rules-engine.mjs](../../server/rules-engine.mjs#L6318) и [rest-mechanics.test.mjs](../../test/rest-mechanics.test.mjs#L38). Есть панель отдыха в [DungeonMap.tsx](../../src/DungeonMap.tsx#L3671), но нет отдельного camp hub с личными сценами. |
| Quests/journal | Verified state, partial branching | UI показывает offers, active clocks, failed/abandoned, threads и story history; [AppViews.tsx](../../src/AppViews.tsx#L639), [quest-progress-evidence.test.mjs](../../test/quest-progress-evidence.test.mjs#L206). Нет полноценного graph view зависимостей и выбора нескольких исходов в одной карточке. |
| Loot | Verified corpse/captive/tribute | Контейнер рождается в том же commit, остаток item instances переносится, проекция защищена; [loot-containers.mjs](../../server/loot-containers.mjs#L11), [rules-coverage.md](../rules-coverage.md#L1042) и [loot-containers.test.mjs](../../test/loot-containers.test.mjs#L227). Cache и dropped-on-ground loot не создаются. |
| Nonlethal | Verified subset | Только trusted melee или melee spell, hp_after=1, knockout recovery/first aid; [rules-engine.mjs](../../server/rules-engine.mjs#L6576), [rules-engine.mjs](../../server/rules-engine.mjs#L13227), [rules-engine.mjs](../../server/rules-engine.mjs#L14912) и [nonlethal-knockout.test.mjs](../../test/nonlethal-knockout.test.mjs#L58). |

## Реакции и экономика хода

Команда SetReactionPreference проходит тот же Rules Engine provenance, что и combat commands. Сервер проецирует владельцу reactionModes, а UI меняет режим через useGameSession; [viewer-projection.mjs](../../server/viewer-projection.mjs#L1596) и [useGameSession.ts](../../src/useGameSession.ts#L1987). Это уже удачная BG3 фишка: игрок заранее решает, когда не прерывать ход.

В состоянии боя хранится одно текущее reaction_window
([rules-engine.mjs](../../server/rules-engine.mjs#L1730)), но это не доказывает
отсутствие последовательного resume. Существующие тесты проверяют окна двух
владельцев подряд ([spell-reaction-area-audit.test.mjs](../../test/spell-reaction-area-audit.test.mjs#L153)),
несколько Indomitable ([indomitable.test.mjs](../../test/indomitable.test.mjs#L303))
и вложенное окно после заготовленного удара ([reaction-attack-continuation.test.mjs](../../test/reaction-attack-continuation.test.mjs#L140)).
Нового reaction stack не планировать по одному полю состояния: сначала нужен воспроизводимый failing scenario с несколькими незавершёнными resume.

Preview должен возвращать не только красную клетку риска, а список причин:
кто провоцирует opportunity attack, viewer-safe доступную реакцию, cover и
расход movement/action. Точная КД скрытого врага и число реакций скрытого
владельца не должны попадать в preview: это уже защищают
[viewer-projection.mjs](../../server/viewer-projection.mjs#L1317) и
[index.mjs](../../server/index.mjs#L2291). Публичный прогноз намеренно обнуляет
armor_class у неизвестного врага ([index.mjs](../../server/index.mjs#L2305)).
Часть UI уже выводит cover и reason; [DungeonMap.tsx](../../src/DungeonMap.tsx#L2124) и [DungeonMap.tsx](../../src/DungeonMap.tsx#L2371). Сервер должен оставаться единственным вычислителем, а клиент только показывать safe snapshot.

## Shove, jump, throw, ready

В редакции 2014 shove — специальная рукопашная атака: игрок выбирает сбить
цель ничком или оттолкнуть её на 5 ft. Это прямо сказано в [Basic Rules](https://www.dndbeyond.com/sources/dnd/basic-rules-2014/combat)
и [SRD CC v5.1](https://media.dndbeyond.com/compendium-images/srd/5.1/SRD_CC_v5.1.pdf).
Текущий contest реализует только prone, поэтому это неполнота 2014, а не
осознанное отличие правила. BG3-style push к краю, падение и столкновение с
поверхностью — следующий отдельный policy: target size, направление,
blocked path, fall damage, forced ActorMoved, provenance и отсутствие
opportunity attack.

Long jump сейчас честно ограничен: только горизонтальная линия, целевая и
промежуточные клетки раскрыты, разница elevation запрещена, скорость и разбег
проверяются сервером. Это хороший вертикальный срез для preview, но не
полет/падение и не прыжок через пропасть. Не расширять его изменением смысла
старого события: добавить versioned movement mode и отдельные события падения.

Thrown weapon определяется профилем атаки и получает attack_kind=thrown, но
документ аудита фиксирует P2: геройский thrown item не списывается через
AmmunitionSpent. Это влияет на экономику и replay; исправлять нужно общим
item-lifecycle policy, а не клиентским уменьшением количества.

Ready уже тратит действие и может удерживать spell с concentration. Два
триггера — враг подошёл или начал заклинание. Acceptance для расширения:
неизвестный trigger отклоняется до расхода, заготовка переживает restart,
release расходует ровно reaction, а истёкшая заготовка создаёт
ReadiedActionExpired.

## Пространство: поверхности, высота, cover, concentration

TacticalMap хранит surface, moveCost, elevation, edges, blocksSight,
cover и prop footprint; [tactical-map.mjs](../../server/tactical-map.mjs#L89)
и [tactical-map.mjs](../../server/tactical-map.mjs#L1712). Визуальный canvas и
3D-проекция читают эти поля, но authoritative collision остаётся серверным.

Active area effects — уже настоящий event-sourced слой: SpellAreaCreated
фиксирует shape/radius/trigger/damage/condition/push и concentration, а
SpellAreaTriggered помечает обработанную цель. Взаимодействия огня с web,
маслом и douse ограничены двумя объявленными правилами, что соответствует
требованию не придумывать бесконечные elemental chains.

Высота требует решения редакции. В 2024-срезе ranged high ground даёт
advantage/disadvantage только дальше 5 ft; в D&D 2014 этот house rule
отключён. Поэтому acceptance должен проверять два кампейна: одинаковая карта,
разный ruleset, разные forecast/event/projection.

Concentration уже проходит единый DamageApplied follow-up и пишет
ConcentrationCheckRequired, ConcentrationSavingThrowResolved,
ConcentrationEnded. Следующий шаг — реестр причин завершения
(long-rest, duration, special spell break, incapacitation) и проверка, что
каждый effect_id очищает condition/area/summon ровно один раз.

## Диалог, fail-forward и квесты

Social controller получает очищенный brief: публичный профиль, отношения,
видимые факты, promises и recent dialogue. LLM не выбирает skill, DC,
modifier или delta; normalizer ограничивает relationship_delta и запрещает
promise после failed check; [npc-social-controller.mjs](../../server/npc-social-controller.mjs#L291)
и [npc-social.mjs](../../server/npc-social.mjs#L752).

В бою отдельный ProposeParley уже останавливает обе стороны, делает
двухфазный d20 и даёт withdraw/tribute/surrender/resume; [rules-coverage.md](../rules-coverage.md#L1220).
Это лучше, чем разрешать свободный social dialogue в каждом раунде.

Недостаёт typed outcome graph: успех проверки сейчас не всегда означает
переговорный результат, а failure может только ограничить delta. Для
BG3-like dialogue cards полезно сохранять SocialOutcome с reason,
disclosed_fact_ids, relation delta, quest hooks и доступными следующими
действиями. World Memory и quest-consequences должны принять только
подтверждённые event IDs.

Квестовая память уже хранит clocks, proof facts, status, responsibility и
knowledge gates. UI показывает часы и активные нити, но не показывает
причинный граф: какой факт продвинул clock, какой NPC умер и какие варианты
остались. Следует добавить read-only graph projection, не меняя server
authority.

## Camp, companions, loot, nonlethal

Rest — полноценный серверный lifecycle, но BG3 camp — это отдельная
социальная локация. Разумное расширение без NPC-companion: camp actions для
разговоров с уже присутствующими NPC, cooking/crafting/downtime и recap,
всё через TimeAdvanced и typed events. Музыка намеренно не выбрана и в этот
план не входит.

Постоянный recruitable NPC не нужен по принятому решению. Оставить summon,
pact-familiar marker и noncombat tamed beast отдельными сущностями; не
превращать их в скрытую party slot. Если решение изменится, сначала нужен
отдельный design для initiative, XP, death, resurrection, projection и
encounter budget.

Loot containers — сильная часть текущего проекта: остаток экземпляров
переезжает атомарно, просмотр защищён reach/visibility, взятие идемпотентно.
Следующая фича — cache/ground loot и dropped weapon, но только через тот же
registry; нельзя добавлять второй inventory path в UI.

Nonlethal сейчас оставляет 1 HP,
запускает 60-minute knockout rest, затем может закончиться лечением или
Medicine check. Нужны только сценарии для surrendered/captive/loot и
согласованное отображение причины в combat log.

## Рассказчик: что улучшить

Текущий Narrator имеет response plan, few-shot, deterministicNarration,
verifier и fallback; [narrator.mjs](../../server/narrator.mjs#L220) и
[narrator.mjs](../../server/narrator.mjs#L1968). При отсутствии RouterAI
structured command path продолжает работать через deterministic provider.

Исторический benchmark 11 сентября зафиксировал ограничение lexical guard:
в 24-сценной выборке восемь существенных ошибок тогда прошли проверку
([narrator-comparison-2026-09-11.md](../narrator-comparison-2026-09-11.md#L59)).
Это уже исправлено replay от 12 сентября: все 8/8 отмеченных ошибок отклонены,
а две ложные блокировки устранены ([narrator-craft.md](../narrator-craft.md#L8),
[narrator-fixes-replay-2026-09-12.json](../../eval/narrator-fixes-replay-2026-09-12.json#L1)).
Исторический результат остаётся доказательством границы языкового guard, а не текущей уязвимостью. Нужен новый regression corpus v12 для непроверенных перефразировок; [narrator-craft.md](../narrator-craft.md#L46) прямо сохраняет ограничение конечного набора форм.

Текущий guard подтверждён [narrator-evidence-regression.test.mjs](../../test/narrator-evidence-regression.test.mjs#L54)
и [narrator-grounding-regression.test.mjs](../../test/narrator-grounding-regression.test.mjs#L70).
Приоритетный дизайн: передавать Narrator не сырые события, а typed
NarrationClaims: confirmed_action, confirmed_outcome, forbidden_implications,
visible_changes, permitted_npc_reactions, sensory_anchors. Ответ модели
сначала проверять на claim coverage и запрещённые implications, затем
пускать craft feedback. Если claim verifier не уверен, отдавать короткий
deterministic result и сохранять модельный текст только в trace.

## Приоритеты доработок

| Приоритет | Server → events | Projection/UI | Acceptance и риск |
|---|---|---|---|
| P0 preview | Добавить read-only forecast API поверх attackForecast, movementStepCostFor, coverBetween и reaction candidates; событий нет. | Причины пути, известная КД, cover, high-ground, viewer-safe reaction и расхода одним preview. | Скрытые КД/реакции не раскрывать; сравнить preview с commit на 2014/2024. |
| P2 reaction edge case | Сохранять текущий sequential resume; добавлять schema stack только после failing test с незавершёнными nested windows. | Viewer-safe trigger/action и восстановление текущего окна после reload. | Existing tests cover two owners, Indomitable and ready continuation; риск преждевременной миграции ниже. |
| P0 ready | Расширить READIED_TRIGGERS policy и release contract, сохранив v1 replay. | Карточка выбранного trigger и preview результата. | Unknown trigger не тратит action; restart/expiry tests. |
| P1 shove/vertical | Policy per ruleset для 2014 push 5 ft, BG3 fall/edge и forced movement; ActorMoved version + FallResolved. | Направление, клетки падения, итог урона/препятствия. | Blocked path, size, no-OA; отдельно тестировать официальный 2014 shove и BG3-like policy. |
| P1 surfaces/props | Единый resolver для active area и TacticalProp interactions, существующие SpellArea/SceneObject events. | Surface legend, trigger marker, extinguish/burn/topple reason. | Fire/web/oil/ice + replay; не создавать произвольные цепочки. |
| P1 social outcomes | SocialOutcome event schema, claims/facts/quest hooks после server check. | Диалоговая карточка с фактом проверки и доступными следующими ветками. | Success не объявляет согласие без event; failed check даёт bounded opportunity. |
| P1 quest graph | Read-only dependency/clock projection поверх worldMemory и quest-consequences. | Факты, часы, ответственный NPC, последствия и доступные варианты. | NPC death/office transfer/abandon/replay; не раскрывать GM knowledge. |
| P1 camp/downtime | Расширить StartRest/CompleteRest через typed CampActivity и TimeAdvanced. | Передышка: отдых, camp action, crafting/rumor/training. | Инвариант времени и ресурсов, interruption policy; без музыки и companion recruit. |
| P1 loot world | Создавать cache/ground/drop container тем же loot registry и event reducer. | Точки добычи, pickup preview, weight/ownership. | Atomic transfer, reach, visibility, replay; не дублировать inventory. |
| P1 narrator claims | Расширить NarrationBrief/verifier, добавить negative implication corpus и provider eval. | Отдавать короткий проверенный текст с корректным failure framing. | Все benchmark failures rejected/fallback; risk over-rejection. |
| P2 map UX | Использовать уже server-owned geometry и projection для camera/overlays. | Контекстное action wheel, inspect mode, unobstructed markers, level/elevation legend. | Browser acceptance на desktop/mobile; не переносить collision в canvas. |

## Правила, конфликты и границы решения

1. Целевая кампания не может автоматически смешивать D&D 2014, SRD 5.2.1 и BG3 house rules. Кампания уже lock-ит ruleset/version; [product-principles.md](../product-principles.md#L121) требует явного house_rule_id.
2. Height advantage, shove push, surfaces и расходники 2024 должны иметь versioned policies. Сначала выбрать редакцию, затем писать engine/events/tests/UI; prompt не компенсирует отсутствие правила.
3. Планы из старых документов не первичный источник: устаревшее ограничение про «укрытие и высоту не применяются» противоречит tactical-geometry. Source of truth — код + тест, docs/rules-coverage обновлять вместе с изменением.
4. Reliability, backups/cutover, музыка и NPC-companion отложены явным решением
владельца; этот аудит не превращает их в обязательные P1.

## Минимальный набор проверок для реализации

Для каждой новой mechanic policy нужны unit tests успеха/отказа, ownership и
visibility, idempotency, replay/restart и один HTTP path через /commands или
/api/narrate. Для map features добавить map-quality/scene-program и ручной
browser check: preview должен совпадать с commit.

Для narrator claims нужны regression cases из benchmark: successful check без согласия NPC, failed check без выдуманной причины, known fact, promise, death/loot и разрешённая NPC reaction. Отдельно измерять fallback rate, first-token latency и ложные rejection.

Команды проверять через pipeline сервер → Rules Engine → typed events → FileEventStore → reducer/replay → viewer projection → UI/Narrator. Не создавать параллельные client-only решения для path, range, damage, DC, cover, reaction или loot.
