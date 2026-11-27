import '../../../fixtures-env.mjs'
// Эталоны веток редьюсера Р4а на синтетических состояниях (задача Р4а).
//
// Корпус (`gen-reduce-r4a-corpus.mjs`) покрывает частые пути, но не все типы
// (решения отряда, баррикада, вехи) и почти не видит мусора в payload. Здесь
// три небольших нормализованных состояния — зал с дверью и предметами
// (решение отряда открыто, мирный NPC на посту, призыв отряда), постоянный
// мир посреди боя на втором этаже со стэшем этажа входа, почти пустое
// состояние — и случайные события каждого перенесённого типа с правдоподобными
// и мусорными полями. Эталон — sha256 `JSON.stringify` состояния после
// `applyGameEvent` без производных полей героя и без ещё не перенесённых
// реестров; событие, на котором JS бросает, помечено `throws`.
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-reduce-r4a.mjs
// Отладка: … gen-reduce-r4a.mjs --dump <номер случая> — полное состояние JS.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { loadOpenCopy, sourceSha256 } from './open-copy.mjs'

const E = await loadOpenCopy()
const json = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

let seed = 0x4a4a0004
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (list) => list[Math.floor(random() * list.length)]
const chance = (p) => random() < p
const maybe = (p, value) => (chance(p) ? value : undefined)

// --- состояния --------------------------------------------------------------

function hallCells(locationRevealed = true) {
  const cells = []
  for (let y = 0; y < 12; y += 1) {
    for (let x = 0; x < 12; x += 1) {
      const border = x === 0 || y === 0 || x === 11 || y === 11
      let type = border ? 'wall' : 'floor'
      if (x === 6 && y > 0 && y < 11 && y !== 5) type = 'wall'
      if (x === 6 && y === 5) type = 'door'
      const cell = { x, y, type, revealed: locationRevealed && x < 6 }
      if (x === 3 && y === 3) cell.feature = 'chest'
      if (x === 8 && y === 8) cell.feature = 'stairs'
      if (x === 2 && y === 9) cell.feature = 'torch'
      cells.push(cell)
    }
  }
  return cells
}

const heroes = () => [
  {
    id: 'hero', name: 'Герой', characterClass: 'fighter', level: 3, hp: 20, maxHp: 28, experience: 900,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 8 },
    inventory: [
      { id: 'sword', name: 'Меч', type: 'weapon', equipped: true, quantity: 1 },
      { id: 'axe', name: 'Топор', type: 'weapon', equipped: false, quantity: 1 },
      { id: 'potion', name: 'Зелье лечения', type: 'consumable', quantity: 2 },
      { id: 'arrows', name: 'Стрелы', type: 'ammunition', quantity: 20, charges: { current: 20, max: 20 } },
    ],
    currency: { gp: 10, sp: 3 },
  },
  { id: 'hero-2', name: 'Второй', characterClass: 'rogue', level: 2, hp: 12, maxHp: 14, inventory: [{ id: 'dagger', name: 'Кинжал', type: 'weapon', quantity: 1 }], x: 2, y: 2 },
]

const decision = {
  id: 'decision-1', type: 'vote', status: 'open', prompt: 'Куда идти?',
  options: [{ id: 'left', label: 'Налево' }, { id: 'right', label: 'Направо' }],
  participantIds: ['hero', 'hero-2'], eligibleVoterIds: ['hero', 'hero-2'], activeVoterIds: ['hero', 'hero-2'], votes: {}, requiredVotes: 2,
}

const raws = [
  {
    sessionCode: 'R4A-A', campaign: 'Зал', partyMemberIds: ['hero', 'hero-2'], activePlayerId: 'hero', players: heroes(),
    enemies: [{ id: 'goblin-1', name: 'Гоблин', hp: 7, maxHp: 7, x: 8, y: 3, loadout: { items: [{ item_instance_id: 'goblin-1-item-1', catalog_id: 'arrow', name: 'Стрелы', quantity: 6, charges: { current: 6, max: 6 } }] } }],
    actors: [{ id: 'summon-wolf', name: 'Волк', kind: 'summon', faction: 'party', ownerId: 'hero', hp: 5, maxHp: 5, x: 3, y: 2, sourceEffectId: 'eff-1', summon_lifecycle_version: 2 }],
    scene: { location_id: 'test-hall', location: 'Зал', title: 'Зал', objective: 'Осмотреться', turn: 2, cells: hallCells(), levels: [{ offset: 1, label: 'Чердак' }, { offset: -1, hint: 'винный погреб' }] },
    social: { npcs: [{ id: 'npc-anna', name: 'Анна', location_id: 'test-hall', available: true }, { id: 'merchant-bo', name: 'Бо', location: 'Зал' }] },
    merchants: [{ id: 'merchant-bo', name: 'Бо', stock: [] }],
    npc_world: { placements: [{ npc_id: 'npc-anna', location_id: 'test-hall', x: 4, y: 8 }, { npc_id: 'npc-anna', location_id: 'elsewhere', x: 1, y: 1 }], inventories: { 'npc-anna': [{ id: 'tear', item_instance_id: 'tear-1', name: 'Слеза', quantity: 1 }] } },
    agentInteraction: decision,
    mechanics: {
      positions: { hero: { x: 2, y: 3 }, 'hero-2': { x: 2, y: 2 }, 'goblin-1': { x: 8, y: 3 }, 'summon-wolf': { x: 3, y: 2 } },
      scene_interactions: { 'prop-3-3': { state: 'closed', inspected: true, last_actor_id: 'hero-2' } },
      temporary_hp: { hero: 3 },
      resting: { 'goblin-1': { kind: 'short' } },
      conditions: { 'goblin-1': [{ id: 'unconscious' }, { id: 'fled' }, 'prone'] },
      combat: { active: true, round: 2, initiative: [{ actor_id: 'hero' }, { actor_id: 'goblin-1' }], active_index: 0, action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 5, movement_path: [{ x: 1, y: 3 }, { x: 2, y: 3 }], object_interaction: true } } },
      progression: { milestones: [{ id: 'm-old', milestone: 'Старое', encounter_id: '' }], milestones_since_level: 2 },
    },
    adventure: { chapter: 2, currentHook: 'Найти вход', secrets: ['ключ'], gmNotes: 'тайна', history: [{ chapter: 1, title: 'Начало', location: 'Деревня', status: 'completed' }], visitedLocations: ['Деревня', 'Зал'] },
    locationLevels: { 'test-hall': [{ index: 0, label: 'Первый этаж' }, { index: -1, label: '' }] },
  },
  {
    sessionCode: 'R4A-B', campaign: 'Мир', partyMemberIds: ['hero'], activePlayerId: 'hero-2', players: heroes(),
    enemies: [{ id: 'wolf-1', name: 'Волк', hp: 11, maxHp: 11, x: 4, y: 4, origin: { npc_id: 'npc-anna' } }],
    campaignConcept: { campaign_mode: 'persistent', story_sequence: 1, story_history: [{ story_number: 1 }], arc_history: [] },
    scene: { location_id: 'tower', location: 'Башня', title: 'Башня', objective: 'Подняться', level: { index: 1, label: 'Второй этаж' }, cells: hallCells(false), levels: [{ offset: 1, label: 'Верх' }] },
    levelEntities: { tower: { enemies: [{ id: 'rat', name: 'Крыса', hp: 2, maxHp: 2, x: 5, y: 5 }], entities: [], summons: [], positions: { rat: { x: 5, y: 5 } }, scene_interactions: {}, encounter: null, npc_placements: [{ npc_id: 'npc-guard', location_id: 'tower', x: 9, y: 9 }] } },
    social: { npcs: [{ id: 'npc-guard', name: 'Страж', location_id: 'tower' }] },
    mechanics: {
      positions: { hero: { x: 2, y: 3 }, 'wolf-1': { x: 4, y: 4 } },
      combat: { active: true, round: 3, initiative: [{ actor_id: 'wolf-1' }, { actor_id: 'hero' }], active_index: 1, truce: { leader_id: 'wolf-1', hero_id: 'hero', round: 3, outcomes: ['withdraw'] }, parley_attempts: 1 },
      encounter: { id: 'enc-1', encounter_id: 'enc-1', status: 'staged', enemy_ids: ['wolf-1'] },
    },
    worldMemory: { quests: [{ id: 'quest:chapter:1', title: 'Глава', status: 'active', visibility: 'party' }, { id: 'quest-main', title: 'Главное', status: 'active', visibility: 'party' }] },
    adventure: { chapter: 4, history: [] },
    autonomy: { pacing: { beat: 3 } },
  },
  { sessionCode: 'R4A-C', campaign: 'Пусто', players: [{ id: 'solo', name: 'Один', hp: 5, maxHp: 5 }] },
]
// Нормализация не всегда идемпотентна (второй проход достраивает маршруты
// карты мира), а Rust применяет событие без неё — поэтому состояние
// нормализуется до неподвижной точки.
function fixedPoint(raw) {
  let state = E.normalizeCampaignState(json(raw))
  for (let pass = 0; pass < 6; pass += 1) {
    const next = E.normalizeCampaignState(state)
    if (JSON.stringify(next) === JSON.stringify(state)) return state
    state = next
  }
  throw new Error('нормализация не сходится')
}
const bases = raws.map(fixedPoint)

// --- события ----------------------------------------------------------------

const ids = ['hero', 'hero-2', 'goblin-1', 'wolf-1', 'summon-wolf', 'solo', 'ghost', '', null, undefined, 7]
const texts = ['', '  Текст  с\tпробелами ', 'x'.repeat(130), 'обычный', null, undefined, 42, true]
const numbers = [0, 1, 2, 3, -1, '2', 'x', null, undefined, 1.5, 9e15, 40]
const bools = [true, false, 'true', 1, null, undefined]
const points = [{ x: 3, y: 4 }, { x: '2', y: 3 }, { x: 2.5, y: 1 }, { x: -1, y: 2 }, { x: 40, y: 40 }, {}, null, undefined, 'x']
const currencies = [{ gp: 3, sp: 1 }, { cp: 99 }, null, undefined, 0, { gp: 'x' }]

let mapPayloads = null
function maps() {
  if (mapPayloads) return mapPayloads
  const ground = E.deserializeTacticalMap(bases[0].scene.map)
  const upper = E.deserializeTacticalMap(bases[0].scene.map)
  upper.levelIndex = 1
  upper.levelLabel = 'Чердак'
  mapPayloads = { ground: E.serializeTacticalMap(ground), upper: E.serializeTacticalMap(upper), broken: { version: 'нет' } }
  return mapPayloads
}

const decisionIds = ['decision-1', 'other', undefined, 5]
const builders = {
  CampaignStoryCompleted: () => ({ schema_version: pick([1, 2, 3, '1', undefined]), story_number: pick([1, 2, 2, '2', 1.5, undefined]), title: pick(texts), quest_id: 'quest-main' }),
  CampaignArcChainSet: () => ({ enabled: pick(bools) }),
  CampaignArcCompleted: () => ({
    next_arc: pick([{ arc_number: 2, title: 'Новая' }, ['a'], null, undefined, 'строка']),
    closed_arc: pick([{ final_chapter: pick(numbers), title: 'Старая' }, null, undefined, ['x']]),
    epilogue: pick(texts), chronicle: pick(texts), hook: pick(texts), occurred_at: maybe(0.5, '2026-10-15T10:00:00.000Z'),
  }),
  PartyDecisionOpened: () => ({ interaction: pick([decision, { ...decision, id: 'decision-2', options: [{ id: 'x', label: 'Икс' }] }, { ...decision, options: [] }, null, 'строка']) }),
  PartyVoteCast: () => ({ interaction_id: pick(decisionIds), hero_id: pick(ids), option_id: pick(['left', 'right', 'up', undefined]), votes: maybe(0.3, { hero: 'left' }), active_voter_ids: maybe(0.5, ['hero', 7]), eligible_voter_ids: maybe(0.3, ['hero']), required_votes: pick([1, 2, '2', undefined]) }),
  PartyDecisionAbstained: () => ({ interaction_id: pick(decisionIds), abstained_voter_ids: maybe(0.6, ['hero-2', 'hero-2', 5]), abstentions: maybe(0.5, { 'hero-2': { reason: 'afk' } }), votes: maybe(0.3, {}), active_voter_ids: maybe(0.5, ['hero']), required_votes: pick([1, undefined]) }),
  PartyDecisionResolved: () => ({ interaction_id: pick(decisionIds), resolved_option_id: pick(['left', 'right', 'up', undefined]), votes: maybe(0.4, { hero: 'right' }), abstained_voter_ids: maybe(0.3, ['hero-2']), resolution_reason: pick(['majority', '', undefined, 'x'.repeat(100)]), roll: maybe(0.3, { total: 12 }), required_votes: pick([2, undefined]) }),
  PartyDecisionExpired: () => ({ interaction_id: pick(decisionIds), resolved_option_id: pick(['left', 'right', 'up', undefined]), votes: maybe(0.4, { hero: 'right' }), active_voter_ids: maybe(0.3, []) }),
  PartyDecisionConsumed: () => ({ interaction_id: pick(decisionIds), resolved_option_id: pick(['left', undefined]) }),
  SceneAdvanced: () => {
    const sceneMap = pick([maps().ground, maps().broken, undefined])
    return {
      scene: pick([{ location_id: pick(['next-hall', 'test-hall', '']), location: 'Новый зал', title: 'Новый зал', cells: hallCells(false), ...(sceneMap ? { map: sceneMap } : {}), levels: [{ offset: 1, label: 'Верх' }] }, null, undefined, { cells: [] }]),
      worldMap: maybe(0.4, { seed: 's', locations: [{ id: 'next-hall', name: 'Новый зал' }], routes: [], currentLocationId: 'next-hall' }),
      adventure: pick([{ chapter: pick(numbers), currentHook: pick(texts), lastTransition: pick(texts), unresolvedThreads: ['a', 'a', 5, ' b '], visitedLocations: ['X'], history: [{ chapter: 2, title: '', status: 'continued', location_id: 'l' }, null, 5] }, undefined, 'строка']),
      party_positions: pick([[{ actor_id: 'hero', x: 2, y: 2 }, { actor_id: 'hero-2', x: 3, y: 2 }], [{ actor_id: 'hero', x: 2, y: 2 }, { actor_id: 'hero', x: 4, y: 4 }, { actor_id: 'ghost', x: 1, y: 1 }], [{ actor_id: 'hero', x: 6, y: 1 }], undefined]),
      library_levels: maybe(0.4, [{ index: 1, map: maps().upper }, { index: 0, map: maps().ground }, { index: -1, map: maps().broken }, null]),
      summon_lifecycle_version: pick([2, undefined]),
    }
  },
  LocationMapImported: () => ({
    location_id: pick(['test-hall', 'tower', '', undefined]),
    preserve_layout: pick(bools),
    levels: pick([[{ index: 0, map: maps().ground }, { index: 1, map: maps().upper }], [{ index: 1, map: maps().upper }], [{ index: 0, map: maps().broken }, { index: '0', map: maps().ground }], undefined, [null]]),
    applied_to_scene: pick([true, true, false]),
    relocations: maybe(0.7, [{ kind: 'actor', id: 'goblin-1', x: 9, y: 9 }, { kind: 'actor', id: 'summon-wolf', removed: true }, { kind: 'entity', id: 'e-1', x: 2, y: 2 }, { kind: 'entity', id: 'e-2', removed: true }, { id: '' }, { kind: 'actor', id: 'wolf-1', x: -1 }]),
    party_positions: pick([[{ actor_id: 'hero', x: 2, y: 2 }], [{ actor_id: 'hero', x: 9, y: 9 }], undefined]),
    map_requirements: maybe(0.3, { schema_version: 2 }), clear_library_source: pick(bools),
  }),
  MapLevelChanged: () => ({
    location_id: pick(['test-hall', 'tower', '', undefined]),
    from_level: pick([0, 1, undefined, 'x']), to_level: pick([0, 1, -1, undefined]),
    map: pick([maps().upper, maps().ground, maps().broken, undefined]),
    level_label: pick(texts),
    party_positions: pick([[{ actor_id: 'hero', x: 2, y: 2 }, { actor_id: 'hero-2', x: 5, y: 5 }], [{ actor_id: 'hero', x: 4, y: 8 }], undefined]),
  }),
  EncounterCreated: () => ({
    encounter: pick([
      { id: 'enc-2', difficulty: 'medium', theme: 'лес', enemies: [{ id: 'orc', name: 'Орк', hp: 15, x: 9, y: 2, loadout: { items: [] } }, { id: 'npc-anna', origin: { npc_id: 'npc-anna' }, x: '3', footprint: { version: 1, size: 2 } }, null] },
      { encounter_id: 'enc-3', enemies: 'нет' }, null, ['x'], undefined,
    ]),
    encounter_id: pick(['enc-x', undefined]), authored_npc_identity_schema_version: pick([1, undefined]),
  }),
  CombatStarted: () => ({ round: pick(numbers), initiative: pick([[{ actor_id: 'hero', total: 15 }, { actor_id: 'goblin-1', total: 8 }, { actor_id: 7 }], [], undefined, null]), active_index: pick(numbers), combat_instance_id: pick(['c-1', '', undefined, 5]), group_initiative: pick(bools) }),
  ActorMoved: () => ({ from: pick(points), to: pick(points), path: maybe(0.5, [{ x: 2, y: 3 }, { x: 3, y: 4 }, null]), distance: pick(numbers), movement_spent: pick(numbers), movement_remaining: pick(numbers), spend_movement: pick(bools), monster_ability: pick(['aggressive', undefined]), teleport: pick(bools), battle_log_path_version: pick([1, undefined]) }),
  AreaRevealed: () => ({ cells: pick([[{ x: 7, y: 2 }, { x: 8, y: 2 }, { x: 99, y: 1 }, { x: 'a' }], [], 'x', undefined]) }),
  DoorStateChanged: () => ({ door_id: pick(['door-6-5', 'nope', undefined]), state: pick(['open', 'closed', 'locked', 'broken', 'ajar', undefined]) }),
  DoorBarricaded: () => ({ door_id: pick(['door-6-5', 'nope']), material_item_id: pick(['axe', undefined]), previous_state: pick(['open', 'closed', 'weird', undefined]), side_x: pick(numbers), side_y: pick(numbers) }),
  DoorBarricadeCleared: () => ({ door_id: pick(['door-6-5', 'nope']), restored_state: pick(['open', 'closed', 'broken', undefined]) }),
  DoorBarricadeForced: () => ({ door_id: 'door-6-5' }),
  DoorForced: () => ({ door_id: pick(['door-6-5', 'nope']), success: pick(bools) }),
  DoorLockpicked: () => ({ door_id: pick(['door-6-5', 'nope', undefined]), success: pick(bools) }),
  LockpickNoticed: () => ({ target_id: 'door-6-5' }),
  SceneObjectOperated: () => ({ prop_id: pick(['prop-3-3', 'prop-2-9', '', undefined]), action_spent: pick(bools) }),
  ScenarioKnightHeadReturned: () => ({ action_spent: pick(bools) }),
  SceneObjectCheckResolved: () => ({ prop_id: 'prop-3-3' }),
  SceneObjectInspected: () => ({ prop_id: pick(['prop-3-3', 'prop-8-8', '']), success: pick(bools), trap_detected: pick(bools) }),
  SceneObjectUseRecorded: () => ({ prop_id: pick(['prop-3-3', 'prop-2-9']) }),
  SceneObjectKnowledgeRevealed: () => ({ prop_id: pick(['prop-3-3', 'prop-8-8']), knowledge_id: pick(['k-1', 'k-2', undefined, 5]) }),
  SceneObjectLootRevealed: () => ({ prop_id: pick(['prop-3-3', 'x'.repeat(130)]) }),
  SceneObjectStateChanged: () => ({ prop_id: pick(['prop-3-3', 'prop-2-9', 'nope']), state: pick(['open', 'taken', 'used', 'closed', undefined, 'x'.repeat(50)]), lockpicked: pick(bools), success: pick(bools) }),
  SceneObjectLootGranted: () => ({ prop_id: 'prop-3-3', loot: pick([[{ id: 'gem', name: 'Самоцвет', quantity: 1 }, { id: 'sword', name: 'Дубль' }, { id: 'gem', name: 'Ещё' }, { name: 'без id' }], undefined, 'x']) }),
  SceneObjectEffectApplied: () => ({ prop_id: 'prop-2-9', temporary_hp_after: pick(numbers) }),
  EntitySpawned: () => ({ entity: pick([{ id: 'e-1', kind: 'chest', x: 4, y: 4 }, { id: 'e-2', kind: 'enemy', x: 5, y: 5 }, { id: 'e-3', kind: 'torch', x: 'a', y: 1 }, { id: 'e-4', x: 1 }, { kind: 'barrel', x: 40, y: 1 }, null, 'строка']) }),
  EquipmentChanged: () => ({ item_id: pick(['axe', 'sword', 'potion', undefined]), item_name: pick(texts), timing: pick(['action', 'free', undefined]) }),
  ItemDawnRechargeResolved: () => ({ schema_version: pick([1, 2]), items: [{ owner_id: 'hero', item_id: 'sword', charges_after: 2 }] }),
  ItemUsed: () => ({ attack_replacement: pick(bools), action_economy_version: pick([2, 1, undefined]), combat_action: pick(['action', 'bonus_action', 'object_interaction', undefined, true]) }),
  ItemConsumed: () => ({ item_id: pick(['potion', 'arrows', 'nope', undefined]), quantity: pick(numbers) }),
  AmmunitionSpent: () => ({ owner_id: pick(['hero', undefined, 'hero-2']), item_id: pick(['arrows', 'nope']), quantity_after: pick(numbers), shots_after: pick(numbers), capacity_after: pick(numbers) }),
  NpcEquipmentSpent: () => ({ owner_id: pick(['goblin-1', undefined]), item_instance_id: pick(['goblin-1-item-1', '', undefined]), quantity_after: pick(numbers), shots_after: pick(numbers), shots_before: pick(numbers), reason: pick(['ammunition', 'potion', undefined]) }),
  ScenarioPurseGranted: () => ({ hero_id: pick(ids), currency_after: pick(currencies) }),
  // `captive: null` роняет реестр пленных (`safeCaptive`), ещё не перенесённый.
  CaptiveTaken: () => ({ captive: pick([{ actor_id: pick(['goblin-1', 'wolf-1', '']), origin: pick(['knockout', null, undefined]) }, undefined]) }),
  BeastTamed: () => ({ actor_id: pick(['goblin-1', 'wolf-1', '', undefined]), diet: pick(['herbivore', null, undefined]) }),
  CaptiveHandedOver: () => ({ hero_id: pick(ids), currency_after: pick(currencies) }),
  ParleyProposed: () => ({ leader_id: pick(['goblin-1', '', undefined]), skill: pick(['persuasion', '', undefined]), refused: pick(bools), success: pick(bools), total: pick([15, null, undefined, '12']), kept: pick(numbers), modifier: pick(numbers), difficulty: pick(numbers) }),
  ParleyRejected: () => ({ leader_id: pick(['goblin-1', undefined]), reason: pick(['roll_failed', null, undefined, 5]) }),
  TruceEstablished: () => ({ truce: pick([{ leader_id: 'goblin-1', leader_name: 'Вожак', hero_id: 'hero', round: 2, outcomes: ['withdraw', 'surrender'] }, null, undefined, { leader_id: '' }]) }),
  TruceBroken: () => ({ round: pick(numbers), actor_id: pick(ids), target_id: pick(ids), broken_by: pick(['party', 'enemy', null, undefined]) }),
  GuardEncounterResolved: () => ({ hero_id: pick(ids), currency_after: pick(currencies) }),
  NpcBlessingGranted: () => ({ hero_id: pick(ids), currency_after: pick(currencies) }),
  CourierLetterSent: () => ({ hero_id: pick(ids), currency_after: pick(currencies) }),
  TavernDiceRoundOpened: () => ({ hero_id: pick(ids), currency_after: pick(currencies) }),
  TavernDiceRoundCancelled: () => ({ hero_id: pick(ids), currency_after: pick(currencies) }),
  TavernDiceRoundResolved: () => ({ hero_id: pick(ids), currency_after: pick(currencies) }),
  TavernDrinkOrdered: () => ({ hero_id: pick(ids), currency_after: pick(currencies) }),
  ParleySettled: () => ({ hero_id: pick(ids), currency_after: pick(currencies), round: pick(numbers), leader_id: pick(['goblin-1', undefined]), outcome: pick(['withdraw', null, undefined]), enemy_ids: pick([['goblin-1'], null, undefined]) }),
  NpcBribeOffered: () => ({ npc_id: pick(['npc-anna', null, undefined]), currency_after: pick(currencies), amount_cp: pick(numbers), insulted: pick(bools), policy_id: pick(['p', null, undefined]) }),
  NpcPocketPicked: () => ({ npc_id: 'npc-anna', currency_after: pick(currencies), purse_cp: pick(numbers), item: pick([{ id: 'ring', name: 'Кольцо', quantity: 1 }, { id: 'potion-2', name: 'Зелье лечения', type: 'consumable', quantity: 3 }, null, undefined]), policy_id: pick(['p', undefined]) }),
  CharacterAbilitiesRolled: () => ({ rolls: [[3, 4, 5]], method: pick(['4d6', undefined]) }),
  CharacterWealthRolled: () => ({ gp: pick(numbers) }),
  ExperienceAwarded: () => ({ recipients: pick([['hero', 'hero-2', 'hero', 'ghost'], ['solo'], [], undefined, 'x']), total_xp: pick([100, 101, 0, -5, '50', undefined]) }),
  MilestoneAwarded: () => ({ milestone: pick(['Победа', 'm-old', '', undefined, 5]), encounter_id: pick(['enc-1', undefined]) }),
}

const DERIVED = ['combatSpells', 'combatActions', 'characterSheet', 'inventoryLoad']
// `law` перенесён, но читает летопись `world_deeds`, которой ещё нет в Rust.
const REGISTRIES = ['law', 'world_deeds', 'offscreen_world', 'courier_letters', 'captives', 'scenario_knight', 'dialogues', 'autonomy']
function comparable(state) {
  const copy = JSON.parse(JSON.stringify(state))
  for (const player of copy.players ?? []) for (const field of DERIVED) delete player[field]
  for (const key of REGISTRIES) delete copy[key]
  return copy
}
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const PER_TYPE = 24
const cases = []
const dumps = []
let index = 0
for (const [type, build] of Object.entries(builders)) {
  for (let n = 0; n < PER_TYPE; n += 1) {
    const base = n % bases.length
    const event = json({
      event_type: type,
      command_id: maybe(0.8, `cmd-${index}`),
      event_id: maybe(0.6, `evt-${index}`),
      created_at: maybe(0.6, '2026-10-15T12:00:00.000Z'),
      occurred_at: maybe(0.3, '2026-10-15T11:00:00.000Z'),
      // `eventFrom` всегда кладёт `actor_id` (`null`, если его нет).
      actor_id: pick(['hero', 'hero', 'hero-2', 'goblin-1', 'solo', null]),
      target_ids: pick([['hero'], ['goblin-1'], ['hero-2', 'hero'], ['solo'], [], undefined]),
      payload: build(),
      ...(chance(0.15) ? { state_version_after: 40 + n } : {}),
      ...(type === 'ItemDawnRechargeResolved' && chance(0.7) ? { event_schema_version: 1 } : {}),
    })
    const mode = Number.isSafeInteger(event.state_version_after) ? 'legacy' : 'current'
    let expected = null
    let throws = false
    try {
      expected = comparable(E.applyGameEvent(bases[base], event))
    } catch {
      throws = true
    }
    cases.push({ base, mode, event, ...(throws ? { throws: true } : { sha256: sha(expected) }) })
    dumps.push(expected)
    index += 1
  }
}

const dump = process.argv.indexOf('--dump')
if (dump >= 0) {
  const at = Number(process.argv[dump + 1])
  console.log(JSON.stringify({ case: cases[at], expected: dumps[at] }, null, 1))
} else {
  const path = new URL('reduce-r4a.json', import.meta.url)
  writeFileSync(path, `${JSON.stringify({ source_sha256: sourceSha256(), bases, cases })}\n`)
  console.log(`состояний: ${bases.length}, случаев: ${cases.length}, бросает JS: ${cases.filter((entry) => entry.throws).length}`)
}
