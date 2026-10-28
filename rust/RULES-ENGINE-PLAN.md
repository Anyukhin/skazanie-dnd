# План переноса `server/rules-engine.mjs` на Rust (крейт `sk-rules`)

> История: Rules Engine перенесён целиком 2026-10-20 (`docs/rust-rewrite-plan.md` §10). Текущие правила — `rust/AGENTS.md`.

Составлен анализом графа вызовов файла (2026-10-14). Порядок работ — задачи
Р0–Р11 по волнам (§3); внешние крейты, без которых задача не стартует, — §3.5.

## 0. Структура файла (27 528 строк)

- 1–582 — импорты из 70 модулей; 583–1935 — константы и помощники;
  1936–2219 — `normalizeCampaignState`; 2220–6131 — помощники;
- **6132–7856 — `validateCommand`**: не `switch`, а 80 последовательных
  `if`-блоков; **порядок обязателен** (от него зависит код отказа игроку);
- **7858–12806 — помощники** (~5 тыс. строк), в том числе классы пауз
  (12353–12553) и кости-стенограмма (12263–12320);
- 12808–13030 — обёртки: `resolveCommand`, удар-открытие, `resolveCommandWithPauses`;
- **13032–23439 — `resolveCommandInternal`**: подготовка и 15 замыканий
  (13032–13701), `switch` (13702–23133: 103 ветки, 123 метки), хвост
  последствий (23134–23439);
- 23470–24198 — помощники редьюсера;
- **24200–27105 — `applyGameEventCurrent`**: `switch` 24216–27057 (152 ветки,
  191 метка) и 11 реестров-выводов (27058–27103);
- 27108–27528 — `applyGameEvent`, replay, проектор, `resolveCommands`,
  `eventSummary`, `RulesEngine`.

Уже в Rust (на 2026-10-14): редьюсер — ~70 меток (~1,4 тыс. строк JS),
реестр закона; помощники `economy.rs`, `journal.rs`, `speed.rs`,
`world_clock.rs`, `classes.rs`, `tables.rs`, `sk_core::game`.
`server/rules/tactical-geometry.mjs` (731 строка) входит в `sk-rules` и ещё
не перенесён.

Пересобрать граф: парсер ESTree лежит в `node_modules/.pnpm/rolldown@1.1.5/
node_modules/rolldown/dist/parse-ast-index.mjs` (`parseAst`). Скрипты анализа —
файлами, не в командной строке (она обрезается на ~8 тыс. символов).

## 1. Кластеры помощников (вне трёх больших функций)

~590 объявлений, 10,35 тыс. строк. «Зовёт» — кластеры внутри файла.

| Кластер (строк) | Состав (имя строка) | Зовёт | Импорты |
|---|---|---|---|
| Ядро и события (141) | clone 1024, assertMechanicsSupported 1035, uniqueStrings 1209, plainObject 1213, abilityModifier 2221, targetFor 5055, playerActor 5106, objectiveWithinLimit 5124, inventoryItem 5145, sameCampaignParty 5404, eventFrom 7858, npcWorldEventsFrom 7889, npcRelationshipEventsFrom 7911, heroDiedEventFrom 7937, itemGrantedEventFrom 7944, commandWithRules 7951, actorMaxHp 7967, resourcePool 9169, conditionIdsFor 10771 | — | rules/core, rules/actors, ruleset-config, npc-social |
| Команды и таблицы (545) | RULE_IDS 669, COMMAND_RULES 744, ALLOWED_COMMAND_TYPES 908, *_LIFECYCLE_COMMAND_TYPES 944–947, sourceIdsFor 4567, normalizeCommand 4579 (295), needsActor 4875 | ядро | `*_COMMAND_TYPES`/`*_POLICY_ID` из 13 модулей; canonicalCombatSpellFor, normalizeLootLines, randomUUID |
| Время (77) | castingTimeMinutes 1052, durationInMinutes 1060, normalizedClockSeconds 1074, durationInSeconds 1079, worldTimeSeconds 1094, COMBAT_ROUND_TIME_* 12555, withCombatRoundTimeMarker 12564, restartTurnClock 23983 | ядро | rules/core |
| Журнал (68) | battleLogMovePath 1114, eventJournalId 24002, attackEndpointsFor 24006, battleLogAreaFromPayload 24023, appendBattleLog 24047, recentBattleSpellName 24053, appendMapFeedback 24062 | призывы | — |
| Нормализация и производные героя (481) | inferredItemCombat 1663, normalizeInventory 1674, normalizeEnemyKnowledge 1714, normalizeProgression 1743, normalizeSceneInteractions 1759, defaultMechanics 1786, encounterWithoutLoadouts 1903, withoutDerivedPlayerFields 1925, **normalizeCampaignState 1936**, refreshPlayerDerivedState 23603 | отдых, экономика хода, время, заклинания, сцена, геометрия | **36 модулей** (почти все домены) |
| Сцена: аргументы, карта, уровни (573) | normalizeSceneAdvanceArgs 1217, canonicalSceneMetadata 1270, normalizeSceneCommerce 1281, syncSceneCells 2293, write/ensure/rebuild/reconcileSceneTacticalMap 2301–2349, уровни 2418–2710, syncCombatBounds 2911, growCombatBounds 2925, revealSceneCells 2941, sceneAdvance* 12184–12223 | ядро, торговля, объекты | tactical-map, tactical-geometry, combat-bounds, adventure-director, level-generator, actor-footprint, npc-positioning, combat-spells |
| Объекты сцены и двери (144) | doorEdgeBlocks 2727, setSceneDoorState 2731, setSceneObjectPropState 2751, sceneObjectState 2760, doorTraceKey 2803, lockpick* 2816–2834, updateSceneObjectInteraction 2854, setScenePropAt 2884 | сцена, проверки | tactical-map, lockpicking, npc-positioning |
| Геометрия и движение (520) | actorFootprint* 2226–2276, actorFootprintFits 2960, forced* 2992–3064, trajectory 3765–3786, assertVoluntaryMovementPath 3883, creatureHeightFeet 3997, distanceBetweenActors 4292, местность 10106–10230, ignoresDifficultTerrain 10940, effectiveSpeedFeet 11068, movement* 11095–11128, classSpeedBonusFeet 12163 | области, состояния, время, монстры, предметы | tactical-geometry, actor-footprint, tactical-map, npc-positioning, character-progression, item-catalog |
| Области (845) | геометрия 9898–10099, wallCells 10312, positionInEffect 10379, areaEffect* 10399–10556, areaCellsOf 10577, spellTargetsAt 10614, npcSpellTargetsAt 10683; lingeringArea* 8213–8244, areaEntryConsequences 8274, **areaTurnConsequences 8356 (230)**, spilledZoneEvents 8901 | ядро, состояния, проверки, смерть, урон, заклинания, геометрия, **applyGameEvent** | tactical-geometry, circular-area-geometry, actor-footprint, combat-spells, npc-positioning |
| Состояния (354) | CONDITION_EFFECTS 4352–4527, incapacitating/speedZero/checkAdvantage 10925–10945, модификаторы спасбросков 11162–11228, checkDisadvantage 11281, страх 11295–11312, spellTimedConditionPayload 11347, истощение 11369–11429, LIGHT_CONDITION 11701 | ядро, время | blessings, combat-spells, tactical-geometry, actor-footprint, character-progression |
| Проверки и спасброски (487) | ENEMY_LORE_* 709–742, skills 4889–5051, persuasionCheckModifier 5475, species/rolls 11237–11330, passivePerception 11456, hiddenStealth 11466, surprisedParticipants 11481, ауры 11565–11648, свет и погода 11702–11730, rollSavingThrow* 12043–12085, dangerSense 12148, savingThrowSucceeded 12176, Несгибаемый 12307–12351 | состояния, ядро, геометрия, монстры | character-progression, ruleset-config, item-lifecycle, combat-spells, weather |
| Урон, КД, защиты (268) | diceExpression 3096, resolvedHealingRoll 3105, effectiveArmorClass 7989, защиты 8009–8076, **damagePayload 8090**, damagePayloadWithHpFloor 8198, conditionArmorClassBonus 11061, hitPointMaximumBonusOf 11441, aura of life 11545, evasion 12116, savedDamageAmount 12133, withoutImmuneConditions 23507 | ядро, состояния | dice-service, item-lifecycle, scenario-knight, combat-spells |
| Смерть и 0 хитов (185) | deathSaveTracker 5110, isDead/Dying 5132–5141, deathSavingThrowAtTurnStart 8992, fallsProneEvents 9086, zeroHitPointDamageConsequences 9095, assertRevivableHero 9218 | ядро, проверки, заклинания | rules/actors |
| Отдых (41) | REST_* 949–956, restMinimumMinutesFor 958, CLASS_HIT_POINT_DIE_SIZES 964, hitPointDicePoolForActor 7971, elapsedRestMinutes 7985 | — | character-progression |
| Оружие и атака (458) | trustedAttackProfile 3130, combatItem* 3250–3269, shillelagh 3254–3307, magical weapon 3309–3319, weaponCriticalThreshold 3527, offHandWeaponFor 3561, **itemAttackProfile 3568**, attackKindFor 3675, attackSwingShape 3794, d20HitChance 3871, equippedWeaponAttacks 3917, attackProfileFor 4272, opportunityAttackProfile 4532, criticalDamageExpression 7961, coatings 8962, allowedWeaponAttacks 10958, trueStrike 11497, conditionAttackModifiers 11507 | ядро, монстры, урон, состояния, классы | item-catalog, character-progression, combat-actions, combat-spells, monster-actions, weather |
| Умения классов (185) | монах 3188–3192, боевой стиль 3359, вдохновение 3394, кара 3429, Font of Magic 3456, Lay on Hands 3492, Colossus Slayer 3512, GWF 3541, sneak attack 9516–9534, bardicInspirationDieSides 9620 | ядро, предметы, оружие, экономика | character-progression, combat-actions, item-catalog, dice-service |
| Предметы и снаряжение (388) | боеприпасы героя 3696–3738, броня 3740–3763, NPC_ITEM_USE 5161–5290, thrownFlaskEvents 8670, npcEquipmentSpentEvent 8771, npcItemUseEvents 8793, npcLoadoutAfterSpend 23543, addInventoryItem 23993 | ядро, проверки, геометрия, смерть, торговля | item-catalog, npc-equipment, enemy-loadouts, merchant-economy |
| Монстры и NPC в бою (207) | monsterTraitFor 3120, monsterActionFor 3124, rechargeMinimumOf 3240, serverOwnedMonsterActor 5065, monster spells 5293–5306, validateLegendaryActionCommand 5340, recharge/legendary reset 8601–8643, npcDamageContext 10728, мультиатака 10971–10993, replaceActor 23566, sync*Vital 23572–23601 | ядро, проверки, геометрия | monster-actions, legendary-actions, combat-spells, npc-positioning |
| Экономика хода (789; ~400 в Rust) | LOADING_* 599, ACTION_ECONOMY_EVENT_VERSION 604, initiativeGroupIds 1853, assertActorPermission 5484, **assertTurn 5505 (294)**, перезарядка 9336–9393, attackActionPlan 9404, кадры 9469–9509, isActiveTurnActor 10446, isOwnCombatTurn 10784, spend* 23645–23843, synchronizeTacticalTurn 24097, applyVersionedAttackEconomy 24114 | монстры, оружие, классы, предметы, состояния | combat-actions, combat-spells, loot-containers |
| Заклинания (~580) | компоненты 9175–9334, chooseSpellSlot 9794, scaled dice 9851–9885, reactionSlotChoice 10459, withSpellOptionOverrides 10478, concentration 10558, bless/life 10775–10780, assertBonusActionSpellAllowed 10790, энервация 10817–10901, Silvery Fortune 10903–10918, лучи 11029–11058, close* 12592–12709, concentrationReconciliationEvents 23470, refreshEnervationActionState 23635 | ядро, геометрия, **normalize/replay/applyGameEvent**, предметы, области | combat-spells, combat-actions, character-progression, character-creation-wealth, item-catalog, npc-positioning |
| Призывы и облик (195) | SUMMON_LIFECYCLE_VERSION 1102, summons expiry 1127–1172, removeSummonedActor 23845, restoreShape 23905, clearConcentrationEffect 23936, combatActorKind 23966 | время, ядро | combat-spells |
| Реакции и паузы (534) | readiedOptionFor 1873, opportunityAttackers 4543, варианты реакций 9536–9792, counterspellWindowFor 9903, **паузы 12353–12553**, REACTION_PREFERENCE_* 12711–12749, heroReactionModesFor 12727, resolveReactionPreferences 12762 | ядро, заклинания, геометрия, состояния, классы, урон, **resolveCommandWithPauses** | combat-spells, combat-actions, reaction-preferences, node:crypto |
| Предпросмотры (419, публичный API) | defaultAttackItemIdFor 3929, previewApproachAttack 3939, swingDetailsFor 4005, swingPropForText 4035, previewSwingAttack 4079, previewLongJumpAttack 4152, attackForecast 4213, previewMonsterAction 5071, previewD20Check 11738, previewTavernDiceRoll 11824 | геометрия, оружие, **validateCommand, normalizeCampaignState** | tactical-geometry, scene-hazards, scene-interactions, monster-actions, tavern-life, beast-taming |
| Торговля (412) | MERCHANT_*_FIELDS 1012–1022, lifecycle* 1335–1661, оценка 5409–5453, merchantStock 5462, checkedTransactionTotal 5466, replaceMerchant 23989, appendEconomyLog 24068, appraisal 24074–24095 | журнал | merchant-economy, item-appraisal, item-catalog |
| Общество и мир (232) | authoredOfficeParticipants 5800, assertSendLetterAllowed 6042, validatedBeastTarget 6087, fenceStanceFor 10746, pickpocket 10761, tavern 11881–11912, shrine/blessing 11937–11984, npcDepartureEvents 13023 | ядро | beast-taming, tavern-life, blessings, courier-letters, npc-social, underworld, scene-interactions |
| Встреча и удар-открытие (335) | assembleEncounterFromState 5815, encounterAssemblyInput 5927, npcCombatRequestFingerprint 5983, validateAttackNpcCommand 5992, sortedInitiative 12180, openingStrike* 12851–12910 | нормализация, API, **resolveCommandInternal** | encounter-assembler, npc-positioning, authored-npc, scenario-attention, combat-actions |
| API, реплей, сводка (470) | GAME_STATE_PROJECTOR_VERSION 651, GAME_REDUCER_VERSION 657, recording/replayDiceService 12263–12275, resolveCommand 12808, resolveCommandWithPauses 12994, applyGameEvent 27108, replayEvents 27133, createCommandProjector 27157, resolveCommands 27190, actorNameResolver 27251, **eventSummary 27268 (235)**, RulesEngine 27504 | всё | retention-context, combat-narration, merchant-economy, offscreen-world, campaign-loop-policy, npc-positioning |

Самые вызываемые: eventFrom 156, RULE_IDS 92, commandWithRules 90, clone 78,
conditionIdsFor 72, playerActor 54, uniqueStrings 43, abilityModifier 42,
appendBattleLog 36, replaceActor 30, actorMaxHp 28, **applyGameEvent 27**,
CONDITION_EFFECTS 24, **normalizeCampaignState 22**.

Обратные дуги (циклы): предпросмотры зовут `validateCommand`; области,
энервация, предпочтения реакций, удар-открытие и концентрация зовут редьюсер,
replay или `resolveCommand*`; 22 места заново зовут `normalizeCampaignState`.

Публичный API для `sk-tactics`, `sk-projection`, `sk-agents`, `sk-turns`: все
`preview*`, attackForecast, swingPropForText, movementStepCostFor,
movementCostOfPath, movementForActor, effectiveSpeedFeet, positionInEffect,
spellTargetsAt, spellDamageEstimate, spellComponentAvailabilityFor,
skillProficiencyForActor, enemyLoreCheckFor, exhaustionLevelOf,
incapacitatingConditionFor, initiativeGroupIds, hitPointDicePoolForActor,
heroReactionModesFor, assertSendLetterAllowed, shrinePrayerRefusalFor,
npcCombatRequestFingerprint, CONDITION_EFFECTS_TABLE, константы версий,
validateCommand, resolveCommand, resolveCommands, applyGameEvent, replayEvents,
eventSummary, actorNameResolver, RulesEngine.

## 2. Команды

### 2.1 `validateCommand` (80 блоков, порядок обязателен)

| Семейство | Блоки (строки) |
|---|---|
| Общие | преамбула 6132–6151; герой и статус кампании 6777–6809; актёр, цели, полномочия, `assertTurn` 6955–6974; погибший герой 6982; происхождение правила, урон, ресурс, состояние 7819–7832 |
| Проверки | MakeAbilityCheck социальная 6152–6183; IdentifyEnemy 7569–7585 |
| Хиты и отдых | ResolveHeroDeath 6985; отдых 6994–7042; StartCombat, EndCombat, ApplyHealing, ReduceHitPointMaximum 7044–7063 |
| Атака | легендарное, действие монстра, магия стат-блока 6703–6713; MakeAttack 7222–7301; ChangeWeapon, MakeAreaAttack 7302–7324 |
| Заклинание | CastSpell 7325–7568 |
| Приёмы и движение | UseCombatAction 7586–7768; MoveActor 7769–7801 |
| Предметы | предметы NPC 6715–6763; GrantItem 7201–7221 |
| Встреча | AttackNpc 6900; жизненный цикл встречи 6903–6921 |
| Объекты и двери | баррикада 6976; OperateSceneObject 7833–7854 |
| Сцена и кампания | память мира и NPC-социальное 6184–6203; сборка героя 6684–6693; жизненный цикл героя 6764–6776; поручения, завершение, дуга, карта, AdvanceScene 6810–6899 |
| Торговля | жизненный цикл торговцев 6922–6954; сделки 7064–7156; карманная кража 7171–7200 |
| Сценарий | кошелёк, осведомитель, диалог, арсенал, договор, рыцарь, незнакомец 6466–6640 |
| Общество | NPC-мир, пленные, контейнеры, звери, парлей 6204–6287; закон 6288–6352; таверна 6353–6465; благословения и письма 6641–6683 |

### 2.2 `resolveCommandInternal`

Подготовка 13032–13117 (глубина, стенограмма костей, нормализация, прокси NPC
для заклинаний, `validateCommand`, TruceBroken). Замыкания 13061–13700:
spendBardicInspiration, appendTimeAdvance, appendScenarioKnightPresence,
**appendWorldTimeConsequences (134)**, damageTurnKey, consumeResistanceBonus,
resistanceSaveState, rollSavingThrow, areaSaveModifierFor,
legendaryResistanceFor, resolveDamagePayload, prepareElementalReactionDamage,
resolveDamageWithReactions, **appendMagicMissileResolution (99)**, rollAmount.
Хвост 23134–23439: вложенные последствия, Несгибаемый, концентрация, гибель
NPC, контейнеры добычи, должности и поручения.

| Семейство | Ветки (строка, размер) | Внешние модули |
|---|---|---|
| Базовые проверки | DeclareAction 13703, MakeAbilityCheck 13706 (93), MakeSavingThrow 13799 (58), IdentifyEnemy 15241, ResolveImprovisedAction 15284, RecordRuling 23128, default | character-progression, tavern-life, beast-taming, underworld |
| Хиты, ресурсы, состояния | ApplyDamage 15151, ApplyHealing 15158, ReduceHitPointMaximum 15167, ResolveHeroDeath 15200, GrantTemporaryHitPoints 15216, Spend/RestoreResource 15222/15230, AddCondition 15295, RemoveCondition 15341, SetSpellBonusPreference 15314, SetReactionPreference 15320 | reaction-preferences |
| **Атака** | **MakeAttack 13857 (1143)**, ChangeWeapon 15000, UseMonsterAction 15010, MakeAreaAttack 15068, UseLegendaryAction 16675 | tactical-geometry, combat-spells, item-lifecycle, npc-equipment, actor-appearance, blessings, monster-actions, legendary-actions, loot-containers, npc-positioning |
| **Заклинание** | **CastSpell 16823 (1988)**: общее 16825–17219; стрелы 17220, пул хитов 17228, attack 17256, save/debuff 17718, damage 18200, healing 18227, отпирание 18307, рассеивание 18347, знание 18397, buff/utility 18429, телепорт 18590, призыв 18624; лучи 18761. StartConcentration 16814, EndConcentration 16817 | combat-spells, combat-actions, tactical-map, circular-area-geometry, scene-interactions, lockpicking, npc-positioning |
| **Приёмы, движение, ход** | **UseCombatAction 15344 (1319)**: возобновление пауз 15377–15717, 45 приёмов 15745–16660. MoveActor 18811 (295), EndTurn 20005 (343) | combat-spells, combat-actions, scene-hazards, wild-shape, tactical-map, scenario-knight |
| Бой: вход и выход | AttackNpc 19783, CreateEncounter 19821, StartCombat 19844 (130), EndCombat 19974 | scenario-attention, item-lifecycle, captives, npc-positioning |
| Предметы | Equip, Transfer, Attune, ActivateItem 22894, UseItem 22932 (196), GrantItem 22755 | item-lifecycle, combat-spells |
| Объекты и двери | BarricadeDoor 19120, ClearDoorBarricade 19141, OperateDoor 19165, **OperateSceneObject 19258 (444)** | scene-interactions, scene-hazards, lockpicking, blessings, npc-social |
| Сцена, карта, время, отдых | UseLevelTransition 19709, ImportLocationMap 22310, RebuildLocationMap 22360, AdvanceScene 22463 (136), AdvanceTime 22599, RevealArea, SpawnEntity, StartRest 22605, SpendHitPointDie 22624, CompleteRest 22665 | adventure-director, level-generator, world-map, talespire-import, scene-requirements, scene-memory, weather |
| Кампания, память мира, герой | ResolveQuestDecision, UpdateObjective, память мира (15 типов) 22761, CompleteCampaign 22800, AdvanceCampaignArc 22815, NPC-социальное 22838, выборы, заклинания, уровень, импорт, характеристики, богатство 22858–22893 | world-memory, party-decision, campaign-loop-policy, campaign-lifecycle, npc-social, character-build, character-lifecycle, character-creation-wealth |
| Торговля | Bargain 20348, Appraise 20379, Buy 20396, PurchaseService 20445, Sell 20476, жизненный цикл торговцев 20542–20592, PickpocketNpc 20609 | merchant-economy, reputation-policy, underworld, pickpocket |
| Сценарий | ReceiveScenarioPurse 20680, Informant 20694 (рекурсия), диалог 20728 (рекурсия), арсенал, NegotiateScenarioTreaty 20855 (рекурсия), ReturnKnightHead, ReleaseCursedKnight 20898 (рекурсия), StageScenarioStranger 20930 | campaign-scenario, scenario-attention, scenario-knight, campaign-dialogues |
| NPC, пленные, звери, парлей | Place, Move, HarmNpc 20986–21029, пленные 21030–21244, CalmBeast 21245, FeedBeast 21361, ScareWithBeast 21401, ProposeParley 21419, SettleParley 21567, LootContainer 21634 | captives, beast-taming, parley, loot-containers, npc-positioning, npc-social |
| Таверна, благословения, письма, закон | OpenTavernDiceRound 21646, **AnswerTavernDiceRound 21715 (234)**, Leave, OrderTavernDrink 21961, ReceiveNpcBlessing 22024, SendLetter 22075, ClearWantedLevel 22117, ResolveGuardEncounter 22131 (179) | tavern-life, blessings, courier-letters, law-and-order, merchant-economy |

### 2.3 Редьюсер

Не перенесено ~88 веток (~1,45 тыс. строк): кампания и дуги, решения отряда,
SceneAdvanced, LocationMapImported, MapLevelChanged, предметы и боеприпасы,
торговцы, встреча и CombatStarted, пленные, звери, парлей, перемирие, стража,
таверна, благословения, письма, ActorMoved, RestCompleted, двери и объекты,
EntitySpawned, подкуп и карманы, герой (выбор, заклинания, уровень, импорт),
награды, опыт и вехи, память мира и поручения, должности, NPC-мир,
LegacyStateImported/CampaignRewound (24201–24211) и 11 реестров-выводов
(world_deeds, tavern, blessings, offscreen_world, courier_letters, captives,
scenario_attention, scenario_knight, dialogues, beasts, autonomy).

## 3. Разбиение на задачи

### 3.1 Правила раскладки

1. **Каждым файлом владеет одна задача.** Р0 заранее создаёт все модули и точки
   входа (`validate::<семья>::check_*`, `resolve::<семья>::<команда>`,
   `reduce::<домен>::*`, `normalize::normalize_campaign_state`, проектор) с
   телами-заглушками `Err(RuleError { code: "UNPORTED", … })`; диспетчеры
   (`validate/mod.rs` с порядком всех 80 блоков, `resolve/mod.rs`, таблица
   `reduce/mod.rs` на 191 тип) пишет только Р0. Остальные задачи заменяют тела
   в своих файлах — слияние без конфликтов. Заглушки — только на точках входа.
2. **Помощники — строго по волнам:** задача зовёт помощники своей или более
   ранней волны (разбиение проверено скриптом по графу).
3. **`Resolve` — структура контекста разбора** вместо замыканий JS (состояние,
   команда, `Context`, кости, events, rolls, transcript, inspirationSpent,
   resistance*, выборы реакций, sequence, nestedConsequencesResolved,
   legendarySpendsInCommand, oiledTargets, проектор). Поля задаёт Р0, методы —
   Р4 (время мира) и Р5 (остальные) в своих `impl`-блоках.
4. **Эталоны приватных функций.** Р0 даёт генератор «открытой копии»
   `rules-engine.mjs` (абсолютные импорты, `export { … }` всех имён, копия в
   `$TEMP`). Генератор сохраняет уже нормализованное JS-состояние, чтобы тесты
   Р1–Р3 шли без Р4. Ветки сверяются по корпусу с фильтром по типу команды.

### 3.2 Задачи

| № | Волна | Строк JS | Задача | Модули `sk-rules` | Зависит от |
|---|---|---|---|---|---|
| Р0 | 0 | ~1,45 тыс. | Каркас, ядро, команды, паузы, кости | `core.rs`, `command/{rules,normalize,types}.rs`, `context.rs`, `pause.rs`, `dice_record.rs`, `turn_economy.rs`, скелеты `validate/`, `resolve/`, `reduce/` | — |
| Р1 | 0 | ~1,76 тыс. | Тактическая геометрия, движение, области, цели | `tactical_geometry.rs`, `geometry/{footprint,movement,forced,terrain}.rs`, `areas/shape.rs`, `targets.rs`, `scene_map_sync.rs` | перенесённое |
| Р2 | 1 | ~1,56 тыс. | Состояния, проверки, спасброски, урон, смерть, отдых, взлом; простые команды | `conditions.rs`, `checks/{skills,saves,indomitable}.rs`, `damage.rs`, `death.rs`, `rest.rs`, `lockpick.rs`, `resolve/{vitals,rest}.rs`, `validate/vitals.rs` | Р0, Р1 |
| Р3 | 1 | ~1,6 тыс. | Оружие, умения классов, предметы NPC, монстры, экономика хода, `assertTurn`, сборка встречи | `combat/{weapons,class_features,npc_items,monsters,turn,encounter}.rs`, `validate/actor_turn.rs` | Р0, Р1 |
| Р4 | 1 | ~2,9 тыс. | Нормализация кампании, сцена, уровни, объекты, призывы, остаток редьюсера (кроме торговцев), реестры, replay и проектор, время мира | `normalize/{campaign,scene,summons}.rs`, `scene/{levels,objects,placement}.rs`, `society_helpers.rs`, `reduce/{scene,items,world,social,character,registries}.rs`, `replay.rs`, `resolve/world_time.rs` | Р0, Р1 |
| Р5 | 2 | ~2,35 тыс. | Ядро разбора: заклинания-помощники, реакции, последствия областей, замыкания, хвост, обёртки, удар-открытие, базовые команды | `spells/{components,slots,enervation}.rs`, `reactions.rs`, `areas/consequences.rs`, `resolve/{kernel,post,api,opening_strike,basic}.rs`, `validate/social_check.rs` | Р0–Р4 |
| Р6 | 2 | ~2,15 тыс. | Сцена и кампания, память мира, герой, торговля (с редьюсером торговцев), сценарий | `resolve/{scene,campaign,character,trade,scenario}.rs`, `validate/{scene,campaign,trade,scenario}.rs`, `merchants.rs`, `reduce/merchants.rs` | Р0–Р4 |
| Р7 | 2 | ~2,0 тыс. | Общество: NPC-мир, пленные, звери (кроме CalmBeast), парлей, контейнеры, таверна, благословения, письма, закон; предпросмотр d20; `eventSummary` | `resolve/society/*.rs`, `validate/society.rs`, `preview_checks.rs`, `summary.rs` | Р0–Р4 |
| Р8 | 3 | ~1,95 тыс. | Атака, действия монстров, легендарные; предпросмотры атаки | `resolve/{attack,monster}.rs`, `validate/attack.rs`, `preview_attack.rs` | Р0–Р5 |
| Р9 | 3 | ~2,25 тыс. | Заклинание (CastSpell, концентрация); при нужде делится по 17718 | `resolve/spell/{common,attack,save,heal_buff,utility,summon}.rs`, `validate/spell.rs` | Р0–Р5 |
| Р10 | 3 | ~2,2 тыс. | Приёмы и возобновление пауз, движение, конец хода | `resolve/{combat_action,resume,movement,end_turn}.rs`, `validate/{combat_action,movement}.rs` | Р0–Р5 |
| Р11 | 3 | ~1,6 тыс. | Начало и конец боя, предметы, объекты и двери, CalmBeast, StageScenarioStranger | `resolve/{combat_lifecycle,items,objects,doors}.rs`, `validate/{combat_lifecycle,items,objects}.rs`, `npc_item_events.rs` | Р0–Р5 |

Итого ~23,8 тыс. строк JS.

### 3.3 Строки по задачам

- **Р0.** Константы 583–667, 669–692, 744–947, 949–977, 1102, 1111–1125,
  1873–1888, 2719, 4352–4527, 9615–9617, 12711–12718, 12555–12584. Ядро
  1024–1100, 1209–1215, 2221, 3096, 3120–3128, 3740–3763, 5106, 5124, 5145,
  5404, 7858–7959 (кроме 7911), 7967, 9169, 10771, 10817–10879, 10925–10937,
  23566, 23966, 23983. normalizeCommand 4567–4887. Кости и паузы 12263–12320,
  12353–12553. Сверка перенесённого 9336–9509, 23645–23796, 24097–24198,
  24002–24072. Скелеты validate 6132–6151, 6777–6809, 6982, 7819–7832;
  подготовка resolve 13032–13117; таблица редьюсера.
- **Р1.** `server/rules/tactical-geometry.mjs` целиком; 2226–2285, 2293–2413,
  2960–2976, 2992–3094, 3765–3786, 3883–3908, 3997, 4292, 5055, 5110–5143, 8185,
  9887, 9898–10099 (кроме 9903), 10106–10298, 10312–10403, 10432, 10577–10725,
  1695, 10940, 10995–11016, 11068–11155, 12163.
- **Р2.** 709–742, 958, 2816–2852, 3105, 3418, 4889–5053, 5475, 7971–7987,
  7989–8088, 8090–8205, 8992–9167, 9218, 10487–10490, 10516–10556, 10775, 10945,
  11061, 11162–11235, 11237–11345, 11347–11448, 11456–11505, 11507–11543,
  11545–11730, 12043–12154, 12176, 12322–12351, 23507; resolve 15167, 15200,
  15222, 15230, 15241, 15295, 15341, 22605–22738; validate 6985–7042, 7061,
  7569–7585.
- **Р3.** 586–595, 1853, 3130–3400, 3429–3684, 3696–3738, 3917, 4005–4033,
  4266–4290, 4532, 5161–5398, 5484–5798, 5800–6024, 7961, 8601–8658, 8771,
  8962–8990, 9345–9378, 9404–9467, 9516–9534, 9620, 10446, 10452, 10728, 10784,
  10971–10993, 23572–23601, 23798–23843; validate 6955–6974.
- **Р4.** 84, 667, 979–1010, 1127–1207, 1217–1379, 1663–2219, 2418–2710,
  2719–2904 (кроме взлома), 2911–2957, 5455, 7911, 10746–10769, 11881–11920,
  12184–12261, 13013–13030, 23543, 23603, 23845–23964, 23993; все неперенесённые
  ветки редьюсера, кроме Merchant*; 24201–24211, 27058–27103, 27108–27188;
  замыкания времени 13119–13313.
- **Р5.** 583, 700, 2978–2990, 3410, 4530–4565, 8213–8585, 9175–9334 (кроме
  9218), 9536–9792, 9794–9885, 9903–9922, 10411–10430, 10440–10443,
  10459–10513, 10558, 10780, 10790–10807, 10887–10918, 11029–11058,
  12592–12709, 12727–12806, 12808–12822, 12851–13011, 23470, 23635,
  27190–27244, 27504; замыкания 13061–13700 (кроме трёх времени); хвост
  23134–23439; resolve 13703, 13706, 13799, 15151, 15158, 15216, 15314, 15320,
  23128, default; validate 6152–6183.
- **Р6.** 1012–1022, 1381–1661, 5409–5453, 5462–5473, 23989, 24074–24095;
  resolve 19709, 20348–20929, 22310–22604, 22739–22893; редьюсер 25492–25699;
  validate 6184–6203, 6466–6640, 6684–6693, 6764–6776, 6810–6899, 6922–6954,
  7064–7200.
- **Р7.** 6042–6130, 11738–11837, 11937–12036, 27251–27502; resolve
  20986–21244, 21361–22309; validate 6204–6465, 6641–6683.
- **Р8.** 3794–3876, 3929–3995, 4035–4264, 5065–5103; resolve 13857–15066,
  15068–15150, 16675–16813; validate 6703–6713, 7222–7324.
- **Р9.** resolve 16814–18810; validate 6711–6713 (с Р8 через точку входа),
  7325–7568.
- **Р10.** resolve 15344–16662, 18811–19105, 20005–20347; validate 7586–7801.
- **Р11.** 8670–8952 (кроме 8771), 12180; resolve 15284, 19120–19257,
  19258–19701, 19783–20004, 20930–20985, 21245–21360, 22755, 22894–23127;
  validate 6715–6763, 6900–6921, 6976, 7044–7058, 7201–7221, 7833–7854.

### 3.4 Волны

```
Волна 0:  Р0, Р1                 (параллельно)
Волна 1:  Р2, Р3, Р4             (каждая: Р0+Р1)
Волна 2:  Р5, Р6, Р7             (каждая: Р0..Р4)
Волна 3:  Р8, Р9, Р10, Р11       (каждая: Р0..Р5)
```

Зависимости во время выполнения (через диспетчер; сборке не мешают, сверке по
корпусу нужны): Р10→Р8 (weapon_attack, trip, удар вдогонку в MoveActor);
Р9→Р10 (движение от заклинания); Р6→Р5 (осведомитель, диалог, договор, рыцарь
зовут MakeAbilityCheck); Р5→Р11 (удар-открытие запускает StartCombat/AttackNpc);
Р5→Р10 (предпочтения реакций исполняются как UseCombatAction); возобновление
паузы (Р10)→Р8, Р9, Р10. Сверку волны 3 закрывать после слияния всей волны.

### 3.5 Внешние крейты (нужны до старта)

| Задача | Крейты |
|---|---|
| Р0 | sk-ruleset, sk-dice, sk-society, sk-scene-base; множества команд и политик 11 модулей — локальная копия с эталоном; canonicalCombatSpellFor (sk-combat-content); normalizeLootLines (частная копия) |
| Р1 | sk-ruleset, sk-geometry, **sk-tactical** (deserializeTacticalMap, cellAt, edgeBetween, movementStepBlocked), sk-combat-content, sk-items; шесть функций npc-positioning (sk-npc-world) — частная копия с эталоном |
| Р2 | sk-combat-content, sk-items-life, sk-world-time (weather), sk-world-story (scenario-knight), sk-npc-world |
| Р3 | sk-combat-base, sk-combat-content, sk-items, sk-social, sk-economy, sk-heroes (authored-npc), sk-attention, sk-encounters, sk-npc-world, sk-director (lootCombatActionFor) |
| Р4 | **все крейты до уровня 11** |
| Р5 | sk-combat-base, sk-combat-content, sk-items, sk-items-life, sk-economy, sk-npc-world, sk-world-life, sk-character, sk-chargen, sk-story, sk-director |
| Р6 | sk-economy, sk-items, sk-attention, sk-world-story, sk-story, sk-director, sk-memory, sk-social, sk-npc-world, sk-world-life, sk-character, sk-combat-content, sk-chargen, sk-world-time, sk-tactical |
| Р7 | sk-npc-world, sk-world-life, sk-social, sk-economy, sk-items, sk-director, sk-attention, sk-world-story, sk-narration |
| Р8 | sk-combat-base, sk-combat-content, sk-items, sk-items-life, sk-economy, sk-npc-world, sk-director, sk-attention, sk-world-time |
| Р9 | sk-combat-content, sk-npc-world, sk-tactical, sk-attention |
| Р10 | sk-combat-content, sk-tactical, sk-world-story |
| Р11 | sk-combat-content, sk-items-life, sk-economy, sk-npc-world, sk-world-life, sk-attention, sk-social |

Вывод: Р0 и Р1 стартуют после `sk-combat-content` и `sk-tactical`; волна 1
(особенно Р4) ждёт уровня 11. Ослабление: Р4 сдаёт нормализацию двумя слоями —
(а) производные поля героя и умолчания `mechanics` (нужны sk-combat-content,
sk-character, sk-items-life); (б) нормализаторы реестров, которые на уже
нормализованном состоянии ничего не меняют (проверить в JS:
`normalizeCampaignState(s) == s` без производных полей на всех `states/`
корпуса) и доделываются позже.

## 4. Риски

1. **Глобальное и скрытое состояние.**
   - Режим retention (`withRetentionMode`, thread_local в sk-society):
     `applyGameEvent` выбирает его по `reducer_version` и `state_version_after`
     каждого события, `replayModeFor` — по первому событию потока; проектор
     кэширует состояние по режиму. Нормализаторы world-memory, npc-social,
     npc-positioning читают тот же режим. Повторить `INVALID_REDUCER_VERSION`,
     `UNSUPPORTED_REDUCER_VERSION`.
   - `sceneTacticalMapCache` — WeakMap по **ссылке** на `scene.map`, обновляется
     только в `writeSceneTacticalMap`. В Rust — кэш по содержимому или версии;
     проверить, что JS нигде не читает устаревший кэш после правки на месте.
   - `createCommandProjector` сверяет префикс событий по ссылке и
     `JSON.stringify` и всегда заново применяет последнее событие. События
     правятся после добавления (`splice` 14278, 16522; замена `payload` 16397,
     16540, 12800) — сбрасывать кэш при любом расхождении префикса.
   - Маркеры контекста на `Symbol` (монах, кара, вторая рука, тип действия для
     перезарядки) переживают `{...context}`, но не JSON — в Rust типизированные
     поля `Context`.
   - `__resolve_depth`, `__corpus_recording`; запись корпуса не переносится.
   - `randomUUID` (command_id, effect_id концентрации, перепродажа, выданный
     предмет) и `createHash` (id окон реакции) — внедряемая фабрика и `sk_core::hash`.
2. **Паузы-исключения.** Четыре класса бросаются глубоко (resistanceSaveState,
   rollSavingThrow, prepareElementalReactionDamage, appendMagicMissileResolution;
   три места в MakeAttack; CastSpell 17321) и ловятся в шести местах с разной
   семантикой: `resolveCommandWithPauses` (верхний уровень — префикс плюс окно,
   вложенный — дальше; `pending_execution ??=`), `resolveOpeningStrike`
   (события старта боя в префикс), `resolvePendingCommand` (добавляет
   накопленные events и rolls), CastSpell — дополнительный луч (18788) и
   MoveActor — удар вдогонку (18966) **перезаписывают** pending_command,
   транскрипт и pending_execution. ResistanceAfterRollPause меняет
   `trigger_roll` и фазу. События до броска паузы теряются, если не попали в
   префикс. В Rust: внутри разбора `Result<_, Interrupt>` (`Rule`,
   `Pause(Box<Pause>)`, `Fault`), на границе API — `Outcome` и `Halt` без паузы
   (урок 5); каждое место с `isCombatPause`/`instanceof RulesValidationError` —
   отдельно.
3. **Стенограмма костей.** `recordingDiceService` пишет `{method, args,
   result}`; для `rollD20`/`rollCheck` args — объект **с порядком ключей места
   вызова**. Транскрипт лежит в `ReactionWindowOpened.pending_dice_transcript`
   (журнал и хеш проекции) — JSON совпадает побайтно, типизированный
   `D20Request` форму не сохранит. Вложенный разбор оборачивает кости повторно.
   `replayDiceService` в JS сверяет **только метод** (а `sk_dice::TranscriptDice`
   ещё выражение, режим и модификатор) — для игрового возобновления нужен
   мягкий повтор, плюс `allowAdditionalRolls` и подмена бросков Несгибаемого по
   `roll_id`. Сухой прогон удара-открытия — кости «всегда минимум» с id
   `opening-strike-dry-run`.
4. **Мутация входа.** `normalizeCampaignState` клонирует всё, кроме
   `worldMemory`; производные поля обнуляются (`null`), а не удаляются.
   `resolveCommandInternal` до проверки кладёт прокси NPC (`npc-spell-proxy`) в
   `state.actors`, затем `validateCommand` нормализует **ещё раз**. Блоки
   валидации дополняют команду (`Object.assign`, social_check, удаление
   `modifier`) — `validate_command` получает `&mut Value` и идёт строго по
   порядку. `openingStrikeTurnState` меняет копию; `resolveReactionPreferences`
   правит `payload` событий ответа. `rawState` JS не меняет.
5. **Порядок бросков.** Обход `Object.entries`/`Map`/`Set` — только
   `js::entries` и `IndexMap`; короткое замыкание `some`/`every`/`&&`/тернарные
   с броском внутри; значения по умолчанию параметров; «один раз на владельца»
   (вдохновение, Сопротивление); `DieRolled` посреди событий; рекурсивные
   `resolveCommand*` с общими костями.
6. **Прочее.** Порядок 80 блоков валидации содержателен. 131 вызов
   `projectEvents`/`events.reduce(applyGameEvent, …)` внутри `switch` —
   паритет ветки требует паритета редьюсера по её ранним событиям. Нормализация
   на каждое событие и квадратичный replay — проектор нужен и в Rust. Тексты
   `eventSummary` и отказов — побайтно.

## 5. Замер: идемпотентность нормализации (2026-10-14)

`normalizeCampaignState(s)` против `s` (без производных полей героя) на 3000
состояний корпуса `tmp/corpus-v1/states`: **2631 неизменны (88 %)**, 369
меняются. Первые расхождения: `mechanics.combat.turn_started_at` — 245,
`worldMap.locations[].summary` — 21, `players[].inventory[].origin` — 17,
`mechanics.combat.group_initiative` — 16, `inventory[].stack_key` — 13,
порядок ключей `mechanics.resting.<id>` — 8, `enemies[].loadout` — 3,
`mechanics.resources.<враг или призыв>` — ~25 по одному, единичные
`social`, `worldMemory.quests`, `players[].subclass`. Значит, Р4 может сдать
нормализацию слоем «бой, инвентарь, ресурсы врагов и призывов, карта мира» и
получить паритет почти всего корпуса; нормализаторы реестров — следом.
Скрипт замера — `normalize-idempotent.mjs` (импортирует `normalizeCampaignState`
и сравнивает первое расхождение по пути).
