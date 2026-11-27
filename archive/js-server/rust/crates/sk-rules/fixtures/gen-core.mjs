import '../../../fixtures-env.mjs'
// Эталоны ядра `rules-engine.mjs` для `sk-rules` (задача Р0): константы и
// таблицы, множества команд модулей, разметка трёх больших функций (метки
// `switch` разбора и редьюсера), помощники ядра и событий, связь
// «Обессиливания», метка времени раунда, сверка перенесённой экономики хода и
// журналов. Приватные функции берутся из «открытой копии» (`open-copy.mjs`).
//
// Запуск: node rust/crates/sk-rules/fixtures/gen-core.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { loadOpenCopy, sourceSha256, SOURCE_URL } from './open-copy.mjs'

const root = new URL('../../../../', import.meta.url)
const E = await loadOpenCopy()
const mod = (name) => import(new URL(`server/${name}.mjs`, root).href)
const out = { source_sha256: sourceSha256() }

// ---------- случайность генератора ----------
let seed = 0x5eed1234
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (list) => list[Math.floor(random() * list.length)]
const json = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

// ---------- множества команд модулей ----------
const npcPositioning = await mod('npc-positioning')
const captives = await mod('captives')
const beasts = await mod('beast-taming')
const loot = await mod('loot-containers')
const tavern = await mod('tavern-life')
const letters = await mod('courier-letters')
const blessings = await mod('blessings')
const knight = await mod('scenario-knight')
const dialogues = await mod('campaign-dialogues')
const itemLifecycle = await mod('item-lifecycle')
const characterLifecycle = await mod('character-lifecycle')
const attention = await mod('scenario-attention')
const characterBuild = await mod('character-build')
const merchant = await mod('merchant-economy')
const worldMemory = await mod('world-memory')
const slab = await mod('talespire-slab')
const social = await mod('npc-social')
const law = await mod('law-and-order')
const parley = await mod('parley')
out.sets = {
  NPC_WORLD_COMMAND_TYPES: [...npcPositioning.NPC_WORLD_COMMAND_TYPES],
  CAPTIVE_PLAYER_COMMAND_TYPES: [...captives.CAPTIVE_PLAYER_COMMAND_TYPES],
  CAPTIVE_COMMAND_TYPES: [...captives.CAPTIVE_COMMAND_TYPES],
  CAPTIVE_INTERROGATION_SKILLS: [...captives.CAPTIVE_INTERROGATION_SKILLS],
  CAPTIVES_POLICY_ID: captives.CAPTIVES_POLICY_ID,
  BEAST_COMMAND_TYPES: [...beasts.BEAST_COMMAND_TYPES],
  BEAST_TAMING_POLICY_ID: beasts.BEAST_TAMING_POLICY_ID,
  LOOT_CONTAINER_COMMAND_TYPES: [...loot.LOOT_CONTAINER_COMMAND_TYPES],
  LOOT_CONTAINERS_POLICY_ID: loot.LOOT_CONTAINERS_POLICY_ID,
  MAX_LOOT_LINES: loot.MAX_LOOT_LINES,
  TAVERN_COMMAND_TYPES: [...tavern.TAVERN_COMMAND_TYPES],
  TAVERN_DICE_APPROACHES: [...tavern.TAVERN_DICE_APPROACHES],
  TAVERN_STAKES_CP: [...tavern.TAVERN_STAKES_CP],
  TAVERN_POLICY_ID: tavern.TAVERN_POLICY_ID,
  COURIER_LETTER_COMMAND_TYPES: [...letters.COURIER_LETTER_COMMAND_TYPES],
  COURIER_LETTER_BODY_LIMIT: letters.COURIER_LETTER_BODY_LIMIT,
  COURIER_LETTERS_POLICY_ID: letters.COURIER_LETTERS_POLICY_ID,
  BLESSING_COMMAND_TYPES: [...blessings.BLESSING_COMMAND_TYPES],
  BLESSINGS_POLICY_ID: blessings.BLESSINGS_POLICY_ID,
  SCENARIO_KNIGHT_COMMAND_TYPES: [...knight.SCENARIO_KNIGHT_COMMAND_TYPES],
  DIALOGUE_COMMAND_TYPE: dialogues.DIALOGUE_COMMAND_TYPE,
  DIALOGUE_POLICY_ID: dialogues.DIALOGUE_POLICY_ID,
  ITEM_LIFECYCLE_COMMAND_TYPES: [...itemLifecycle.ITEM_LIFECYCLE_COMMAND_TYPES],
  CHARACTER_LIFECYCLE_COMMAND_TYPES: [...characterLifecycle.CHARACTER_LIFECYCLE_COMMAND_TYPES],
  SCENARIO_COMMAND_TYPES: [...attention.SCENARIO_COMMAND_TYPES],
  SCENARIO_TREATY_COMMAND_TYPES: [...attention.SCENARIO_TREATY_COMMAND_TYPES],
  SCENARIO_PURSE_COMMAND_TYPES: [...attention.SCENARIO_PURSE_COMMAND_TYPES],
  SCENARIO_ARMORY_COMMAND_TYPES: [...attention.SCENARIO_ARMORY_COMMAND_TYPES],
  SCENARIO_INFORMANT_COMMAND_TYPES: [...attention.SCENARIO_INFORMANT_COMMAND_TYPES],
  SCENARIO_INFORMANT_POLICY_ID: attention.SCENARIO_INFORMANT_POLICY_ID,
  SCENARIO_ARMORY_POLICY_ID: attention.SCENARIO_ARMORY_POLICY_ID,
  SCENARIO_STRANGER_STAGES: [...attention.SCENARIO_STRANGER_STAGES],
  CHARACTER_BUILD_COMMAND_TYPES: [...characterBuild.CHARACTER_BUILD_COMMAND_TYPES],
  ECONOMY_POLICY_ID: merchant.ECONOMY_POLICY_ID,
  WORLD_MEMORY_COMMAND_TYPES: [...worldMemory.WORLD_MEMORY_COMMAND_TYPES],
  SLAB_MAX_TEXT_LENGTH: slab.SLAB_MAX_TEXT_LENGTH,
  NPC_SOCIAL_COMMAND_TYPES: [...social.NPC_SOCIAL_COMMAND_TYPES],
  GUARD_ESCAPE_SKILLS: [...law.GUARD_ESCAPE_SKILLS],
  LAW_COMMAND_TYPES: [...law.LAW_COMMAND_TYPES],
  LAW_POLICY_ID: law.LAW_POLICY_ID,
  PARLEY_COMMAND_TYPES: [...parley.PARLEY_COMMAND_TYPES],
  PARLEY_POLICY_ID: parley.PARLEY_POLICY_ID,
  PARLEY_SKILLS: [...parley.PARLEY_SKILLS],
  TRUCE_BREAKING_COMMAND_TYPES: [...parley.TRUCE_BREAKING_COMMAND_TYPES],
}

// ---------- константы движка ----------
const allTypes = [...E.ALLOWED_COMMAND_TYPES]
const extraTypes = ['', 'Unknown', 'type', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'SwingResolved', 'makeattack']
out.constants = {
  RULE_IDS: E.RULE_IDS,
  COMMAND_RULES: E.COMMAND_RULES,
  ALLOWED_COMMAND_TYPES: allTypes,
  MERCHANT_LIFECYCLE_COMMAND_TYPES: [...E.MERCHANT_LIFECYCLE_COMMAND_TYPES],
  ENCOUNTER_LIFECYCLE_COMMAND_TYPES: [...E.ENCOUNTER_LIFECYCLE_COMMAND_TYPES],
  needs_actor: Object.fromEntries([...allTypes, ...extraTypes].map((type) => [type, E.needsActor(type)])),
  GAME_STATE_PROJECTOR_VERSION: E.GAME_STATE_PROJECTOR_VERSION,
  GAME_REDUCER_VERSION: E.GAME_REDUCER_VERSION,
  TURN_REACTION_EXTENSION_LIMIT: E.TURN_REACTION_EXTENSION_LIMIT,
  PICKPOCKET_CAUGHT_RELATIONSHIP_DELTA: E.PICKPOCKET_CAUGHT_RELATIONSHIP_DELTA,
  MAGIC_ITEM_SPELL_IMMUNITY_EVENT_SCHEMA_VERSION: E.MAGIC_ITEM_SPELL_IMMUNITY_EVENT_SCHEMA_VERSION,
  MONK_BONUS_UNARMED_ACTION_IDS: [...E.MONK_BONUS_UNARMED_ACTION_IDS],
  LOADING_ACTION_TYPES: [...E.LOADING_ACTION_TYPES],
  ACTION_ECONOMY_EVENT_VERSION: E.ACTION_ECONOMY_EVENT_VERSION,
  ATTACK_ACTION_KINDS: [...E.ATTACK_ACTION_KINDS],
  REST_POLICY_ID: E.REST_POLICY_ID,
  REST_EVENT_SCHEMA_VERSION: E.REST_EVENT_SCHEMA_VERSION,
  HIT_POINT_DIE_EVENT_SCHEMA_VERSION: E.HIT_POINT_DIE_EVENT_SCHEMA_VERSION,
  AMMUNITION_SPENT_EVENT_SCHEMA_VERSION: E.AMMUNITION_SPENT_EVENT_SCHEMA_VERSION,
  REST_MINIMUM_MINUTES: E.REST_MINIMUM_MINUTES,
  CLASS_HIT_POINT_DIE_SIZES: E.CLASS_HIT_POINT_DIE_SIZES,
  SUMMON_LIFECYCLE_VERSION: E.SUMMON_LIFECYCLE_VERSION,
  MOVE_BATTLE_LOG_PATH_VERSION: E.MOVE_BATTLE_LOG_PATH_VERSION,
  EXTINGUISHABLE_FLAME_CONDITIONS: [...E.EXTINGUISHABLE_FLAME_CONDITIONS],
  READIED_TRIGGERS: E.READIED_TRIGGERS,
  CREATURE_ENTITY_KINDS: [...E.CREATURE_ENTITY_KINDS],
  ALL_ABILITIES: [...E.ALL_ABILITIES],
  PROTECTION_FROM_ENERGY_EXPIRY_POLICY: E.PROTECTION_FROM_ENERGY_EXPIRY_POLICY,
  CONDITION_EFFECTS: E.CONDITION_EFFECTS,
  SOURCE_SCOPED_BOOLEAN_CONDITIONS: [...E.SOURCE_SCOPED_BOOLEAN_CONDITIONS],
  INCAPACITATING_CONDITIONS: [...E.INCAPACITATING_CONDITIONS],
  SPEED_ZERO_CONDITIONS: [...E.SPEED_ZERO_CONDITIONS],
  CUTTING_WORDS_ACTION_ID: E.CUTTING_WORDS_ACTION_ID,
  PROTECTION_ACTION_IDS: [...E.PROTECTION_ACTION_IDS],
  REACTION_PREFERENCE_LABELS: E.REACTION_PREFERENCE_LABELS,
  REACTION_PREFERENCE_SPELL_IDS: [...E.REACTION_PREFERENCE_SPELL_IDS],
  REACTION_PREFERENCE_ACTION_IDS: [...E.REACTION_PREFERENCE_ACTION_IDS],
  COMBAT_ROUND_TIME_POLICY: E.COMBAT_ROUND_TIME_POLICY,
  COMBAT_ROUND_TIME_COMMANDS: [...E.COMBAT_ROUND_TIME_COMMANDS],
}

// ---------- разметка больших функций ----------
const source = readFileSync(SOURCE_URL, 'utf8')
function functionBody(name) {
  const start = source.indexOf(`\nfunction ${name}(`)
  if (start < 0) throw new Error(`нет функции ${name}`)
  const end = start + source.slice(start).search(/\r?\n\}\r?\n/)
  return source.slice(start, end)
}
const labelConstants = { MERCHANT_ECONOMY_CLOCK_EVENT_TYPE: merchant.MERCHANT_ECONOMY_CLOCK_EVENT_TYPE, DIALOGUE_COMMAND_TYPE: dialogues.DIALOGUE_COMMAND_TYPE }
function caseLabels(name) {
  return [...functionBody(name).matchAll(/^ {4}case (.+):\s*(?:\{\s*)?$/gm)].map((match) => {
    const label = match[1].trim()
    if (/^'.*'$/.test(label)) return label.slice(1, -1)
    if (!(label in labelConstants)) throw new Error(`метка ${label}`)
    return labelConstants[label]
  })
}
out.structure = {
  resolve_labels: caseLabels('resolveCommandInternal'),
  reduce_labels: caseLabels('applyGameEventCurrent'),
}

// ---------- помощники ядра ----------
const garbage = [null, 0, 1, -3, 2.5, '', ' ', 'x', ' hero ', 'hero', 'Герой', true, false, [], ['a'], [1, 2], { id: 'z' }, {}, 'constructor', '12']
const cases = {}

cases.unique_strings = [
  ...garbage.map((value) => [value]),
  [['a', ' a ', 'a', 'b', '', '  ', null, 5, 5.5, true, [1, 2], [null], { x: 1 }, 'b ']],
  [['hero', 'hero', ' hero', 'enemy']],
  [[0, '0', -0, 1e21, 0.1]],
].map(([value]) => ({ input: value, expected: E.uniqueStrings(value) }))

cases.ability_modifier = [...garbage, 10, 11, 9, 8, 7, 30, -1, '15', '7.5', 1e16].map((score) => ({ score, expected: E.abilityModifier(score) }))

const expressions = [undefined, null, 6, 8, '1d6', '2d6+1', '1d8-2', 'кость', '', '3', 0, -4, 12.5, '0d6', '1d1', ' 2 d 10 ', '1d6+99999']
cases.dice_expression = []
for (const dice of expressions) for (const bonus of [undefined, 0, 2, -3, '4', 'x', 1.5]) for (const fallback of [4, 6, 8]) {
  try { cases.dice_expression.push({ dice, bonus, fallback, expected: E.diceExpression(dice, bonus, fallback) }) }
  catch (error) { cases.dice_expression.push({ dice, bonus, fallback, error: error.name }) }
}

const traitActors = [
  null, {}, { traits: 'multiattack' }, { traits: ['multiattack'] }, { traits: [{ id: 'multiattack', attacks: 2 }] }, { traits: [{ id: null }, 'pack-tactics', { id: 'nimble-escape' }] },
  { traits: [['multiattack'], 5, true, { name: 'x' }] }, { traits: [{ id: 5 }, 'multiattack'] },
]
cases.monster_trait_for = traitActors.flatMap((actor) => ['multiattack', 'pack-tactics', 'nimble-escape', '5', 'true', '[object Object]'].map((traitId) => ({ actor, trait_id: traitId, expected: E.monsterTraitFor(actor, traitId) })))
const actionActors = [null, {}, { action_profiles: [] }, { action_profiles: [{ id: 'bite' }, { id: 'claw' }, { id: 5 }, { name: 'x' }] }, { action_profiles: 'bite' }]
cases.monster_action_for = actionActors.flatMap((actor) => [undefined, null, '', 'claw', 'bite', 'tail', 5, '5', 0].map((actionId) => ({ actor, action_id: actionId, expected: E.monsterActionFor(actor, actionId) })))

const { ITEM_CATALOG } = await mod('item-catalog')
const armorIds = Object.entries(ITEM_CATALOG).filter(([, entry]) => entry?.equip?.armor).map(([id]) => id)
const someItems = Object.keys(ITEM_CATALOG).slice(0, 40)
function randomInventory() {
  const count = Math.floor(random() * 4)
  return Array.from({ length: count }, (_, index) => {
    const id = pick([...armorIds, ...someItems.slice(0, 5), 'unknown:item', ''])
    const item = { id: `item-${index}`, quantity: pick([1, 0, 2, undefined]) }
    if (random() < 0.8) item.equipped = pick([true, false, 1, 0, 'yes'])
    if (random() < 0.5) item.catalog_id = id
    else if (random() < 0.7) item.catalogId = id
    return json(item)
  })
}
cases.armor = Array.from({ length: 120 }, () => {
  const actor = { abilities: { str: pick([8, 10, 13, 15, 18, '15', undefined]) }, inventory: randomInventory() }
  return { actor, shield: E.hasEquippedShield(actor), stealth: E.armorStealthDisadvantage(actor), penalty: E.armorStrengthSpeedPenalty(actor) }
})

cases.target_for = [
  { target_id: 'a', target_ids: ['b'], actor_id: 'c' }, { target_id: null, target_ids: ['b'], actor_id: 'c' }, { target_id: '', target_ids: [], actor_id: 'c' },
  { target_id: null, target_ids: [], actor_id: null }, { target_id: 0, target_ids: [0], actor_id: 'c' }, { target_ids: ['', 'x'], actor_id: 'c' },
].map((command) => ({ command, expected: E.targetFor(command) ?? null }))

const partyState = {
  players: [{ id: 'hero' }, { id: 5 }, { actor_id: 'legacy' }, { name: 'nobody' }, { id: 'undefined' }],
  partyMemberIds: [],
}
const partyIds = [undefined, null, '', 'hero', 5, '5', 'legacy', 'undefined', 'enemy', ' hero']
cases.player_actor = partyIds.map((id) => ({ state: partyState, id, expected: E.playerActor(partyState, id) }))
cases.same_campaign_party = [
  ...partyIds.map((id) => ({ state: partyState, id: String(id), expected: E.sameCampaignParty(partyState, id) })),
  ...partyIds.map((id) => ({ state: { ...partyState, partyMemberIds: ['hero', 7, null] }, id: String(id), expected: E.sameCampaignParty({ ...partyState, partyMemberIds: ['hero', 7, null] }, id) })),
]

const objectives = [undefined, null, '', 'Коротко', 'Найти   старую\nкарту  в   библиотеке', 'Очень длинная цель, которую надо обрезать по границе слова — с запятыми, точками; двоеточиями: и тире - вот так', 'Словобезпробеловсовсемдлинноеслововсёвместе', 0, 42, ['a', 'b'], 'a, b, c, d, e, f, g, h, i, j, k, l']
cases.objective_within_limit = objectives.flatMap((value) => [5, 12, 20, 40, 80].map((maximum) => ({ value, maximum, expected: E.objectiveWithinLimit(value, maximum) })))

const inventoryActor = { inventory: [{ id: 'sword' }, { id: 5 }, null, { name: 'x' }, { id: 'undefined' }] }
cases.inventory_item = [undefined, null, '', 'sword', 5, '5', 'undefined', 'shield'].map((itemId) => ({ actor: inventoryActor, item_id: itemId, expected: E.inventoryItem(inventoryActor, itemId) }))

cases.assert_mechanics_supported = [
  null, {}, { mechanicsSupport: 'verified' }, { mechanicsSupport: 'partial' }, { mechanicsSupport: 'heuristic' }, { mechanicsSupport: 'heuristic', supportNote: 'нет' },
  { mechanicsSupport: 'ruling-only' }, { mechanicsSupport: 'ruling-only', supportNote: '  высотного перемещения нет  ' }, { supportNote: 5 }, { mechanicsSupport: 'VERIFIED' },
].map((subject) => {
  try { E.assertMechanicsSupported(subject, '«Левитации»'); return { subject, ok: true } }
  catch (error) { return { subject, code: error.code, message: error.message } }
})

cases.casting_time_minutes = [undefined, null, '', '1 действие', '10 минут', '1 МИНУТА', '1 час', '8 часов', '1 действие или 8 часов', '24 ЧАСА', '1 день', '7 дней', 'сутки', '2 суток', '1 мин', '5мин', '100 лет', 60, '1 бонусное действие', '3 часов'].map((value) => ({ value, expected: E.castingTimeMinutes(value) }))
cases.durations = []
for (const amount of [undefined, null, 0, 1, 2.5, -3, '4', 'x', 7, 15, 1e20]) for (const unit of [undefined, null, '', 'minute', 'hour', 'Часа', ' day ', 'round', 'раундов', 'second', 'секунды', 'week', 7]) {
  cases.durations.push({ amount, unit, minutes: E.durationInMinutes(amount, unit), seconds: E.durationInSeconds(amount, unit) })
}
cases.normalized_clock_seconds = [undefined, null, 0, 1.0004, 1.0005, -1, 'x', '12.3456', 1e9, 0.0015].map((value) => ({ value, expected: E.normalizedClockSeconds(value) }))
cases.world_time_seconds = [
  {}, { mechanics: {} }, { mechanics: { world_time: { elapsed_minutes: 10 } } }, { mechanics: { world_time: { elapsed_minutes: 10, second_remainder: 12.3456 } } },
  { mechanics: { world_time: { elapsed_minutes: '7', second_remainder: -2 } } }, { mechanics: { world_time: { elapsed_minutes: 1.5, amount: 2, unit: 'hour' } } },
  { mechanics: { world_time: { amount: 3, unit: 'day', second_remainder: 30 } } }, { mechanics: { world_time: { elapsed_minutes: -5 } } }, { mechanics: { world_time: { elapsed_minutes: null, amount: 15 } } },
].map((state) => ({ state, expected: E.worldTimeSeconds(state) }))

// ---------- события ----------
const commandShapes = [
  { campaign_id: 'C1', command_id: 'cmd-1', actor_id: 'hero', target_ids: ['goblin', ' orc ', 'goblin'], source_rule_ids: ['srd_5_2_1:combat:attack-roll'], ruleset_id: 'srd_5_2_1', house_rule_id: null, ruling_id: null, visibility: 'party' },
  { command_id: 'cmd-2', actor_id: null, target_ids: [], source_rule_ids: [], ruleset_id: 'dnd_5e_2014', house_rule_id: 'house:x', ruling_id: 'r-1' },
  { campaign_id: null, command_id: 'cmd-3', actor_id: 'hero', target_ids: ['hero'], source_rule_ids: ['dnd_5e_2014:combat:damage', 'dnd_5e_2014:combat:damage'], ruleset_id: 'dnd_5e_2014', visibility: null },
  { command_id: 'cmd-4', target_ids: [5, null], source_rule_ids: ['a', 'b'], ruleset_id: 'unknown' },
]
const payloads = [
  undefined, null, {}, { amount: 3 }, { summon_lifecycle_version: 1 }, { summonLifecycleVersion: 2 }, { path: [{ x: 1, y: 2 }] }, { path: 'x' }, { path: [], battle_log_path_version: 0 },
  { resistance_cantrip_reduction: 2 }, { aura_of_life_source: 'paladin' }, { aura_of_protection_source: 'p' }, { indomitable_applied: true }, { indomitable_bonus: 3 }, { indomitable_applied: 'yes', indomitable_bonus: 0 },
  [1, 2], 'текст',
]
const eventTypes = ['DamageApplied', 'ConcentrationEnded', 'SummonedCreatureDismissed', 'HeroDied', 'HitPointsReducedToZero', 'ActorMoved', 'TurnStarted']
const targetsVariants = [undefined, null, [], ['x', 'x', ' y '], 'single', [1, 2, null]]
cases.event_from = []
for (const command of commandShapes) for (const eventType of eventTypes) for (let index = 0; index < 6; index += 1) {
  const payload = pick(payloads)
  const targets = pick(targetsVariants)
  const entry = { command, event_type: eventType }
  if (payload !== undefined) entry.payload = payload
  if (targets !== undefined) entry.targets = targets
  entry.expected = json(E.eventFrom(command, eventType, payload, targets))
  cases.event_from.push(entry)
}
cases.command_with_rules = commandShapes.flatMap((command) => [[], ['srd_5_2_1:combat:damage'], ['srd_5_2_1:checks:saving-throw', 'srd_5_2_1:conditions:common'], ['', 'srd_5_2_1:combat:attack-roll', 'other:x']]
  .map((rules) => ({ command, rules, expected: E.commandWithRules(command, ...rules) })))
cases.hero_died = commandShapes.map((command) => ({ command, payload: { reason: 'x' }, expected: E.heroDiedEventFrom(command, { reason: 'x' }) }))
cases.item_granted = commandShapes.map((command) => ({ command, payload: { item: { id: 'i' } }, targets: ['hero'], expected: E.itemGrantedEventFrom(command, { item: { id: 'i' } }, ['hero']) }))
const drafts = [
  [], 'x', [{ event_type: 'NpcPlaced', payload: { npc_id: 'n' } }],
  [{ event_type: 'NpcMoved', payload: { npc_id: 'n' }, target_ids: ['a'], visibility: 'gm_only', event_id: 'e-1' }, { event_type: 'NpcHarmed', target_ids: null, event_id: '' }],
]
cases.npc_world_events_from = commandShapes.flatMap((command) => drafts.map((list) => ({ command, drafts: list, expected: E.npcWorldEventsFrom(command, list) })))

// ---------- состояние ----------
cases.actor_max_hp = [null, {}, { maxHp: 12 }, { max_hp: '8' }, { maxHp: null, max_hp: 5 }, { maxHp: 0 }, { maxHp: -3 }, { maxHp: 2.5 }].map((actor) => ({ actor, expected: E.actorMaxHp(actor) }))
const resourceState = { mechanics: { resources: { hero: { slot1: { current: 2, max: 3 }, slot2: { max: '4' }, odd: { current: -1, max: -5 }, junk: null } } } }
cases.resource_pool = ['slot1', 'slot2', 'odd', 'junk', 'missing'].flatMap((resource) => [0, 2].map((providedMax) => ({ state: resourceState, actor_id: 'hero', resource, provided_max: providedMax, expected: E.resourcePool(resourceState, 'hero', resource, providedMax) })))
const conditionsState = {
  mechanics: {
    conditions: {
      hero: [{ id: 'prone' }, 'poisoned', { id: 'stunned' }, { id: 'freedom-of-movement' }, { id: 'grappled' }, null, { name: 'x' }],
      foe: [{ id: 'restrained' }, { id: 'banished' }, { id: 'paralyzed' }],
      fast: [{ id: 'hasted' }],
      empty: [],
      walker: [{ id: 'freedom-of-movement' }],
    },
  },
}
cases.conditions = ['hero', 'foe', 'fast', 'empty', 'walker', 'missing'].map((id) => ({
  state: conditionsState,
  id,
  ids: [...E.conditionIdsFor(conditionsState, id)],
  incapacitating: E.incapacitatingConditionFor(conditionsState, id),
  speed_zero: E.speedZeroConditionFor(conditionsState, id),
  ignores_difficult_terrain: E.ignoresDifficultTerrain(conditionsState, id),
}))
const kindState = { players: [{ id: 'hero' }], actors: [{ id: 'wolf', kind: 'summon', faction: 'party', ownerId: 'hero' }, { id: 'npc' }], enemies: [{ id: 'goblin' }, { id: 'imp', kind: 'summon', faction: 'hostile', owner_id: 'x' }] }
cases.combat_actor_kind = ['hero', 'wolf', 'npc', 'goblin', 'imp', 'missing'].map((id) => ({ state: kindState, id, expected: E.combatActorKind(kindState, id) }))
cases.restart_turn_clock = [
  { event_type: 'TruceEstablished', created_at: '2026-01-01T00:00:00.000Z', event_id: 'e-1' },
  { event_type: 'TruceEstablished', created_at: '2026-01-02T00:00:00.000Z' },
  { event_type: 'TruceEstablished', created_at: '' },
  { event_type: 'TruceEstablished' },
  { event_type: 'TruceEstablished', created_at: 12345, event_id: null },
].map((event) => {
  const state = { mechanics: { combat: { active: true, turn_started_at: 'old', turn_started_event_id: 'old-id' } } }
  E.restartTurnClock(state, event)
  return { event, expected: state.mechanics.combat }
})
cases.battle_log_move_path = [
  undefined, null, {}, { battle_log_path_version: 1 }, { battle_log_path_version: 1, path: [] }, { battle_log_path_version: '1', path: [{ x: 1, y: 2 }, { x: '3', y: 4 }] },
  { battle_log_path_version: 1, teleport: true, path: [{ x: 1, y: 1 }] }, { battle_log_path_version: 1, path: [{ x: 1.5, y: 2 }] }, { battle_log_path_version: 2, path: [{ x: 1, y: 2 }] },
  { battle_log_path_version: 1, path: [null] }, { battle_log_path_version: 1, path: [{ x: null, y: 0 }] },
].map((payload) => ({ payload, expected: E.battleLogMovePath(payload) }))
cases.readied_option_for = [undefined, null, {}, { spell_id: 'fire-bolt' }, { spell_id: 'fire-bolt', spell_name: 'Огненный снаряд' }, { spell_id: '', spell_name: 'x' }, { spell_id: 5, spell_name: null }]
  .flatMap((readied) => [undefined, 'Враг подошёл'].map((reason) => ({ readied, reason, expected: E.readiedOptionFor(readied, reason) })))
cases.condition_uses_effect_identity = []
for (const condition of ['prone', 'longstrider', 'protected-from-energy:fire', 'bless-d4', 'acid-arrow', 'invisible']) {
  for (const payload of [undefined, null, {}, { effect_id: 'e' }, { effect_id: null }, { effect_id: 'e', repeat_save_timing: 'turn-end' }, { effect_id: 'e', repeat_save_on_damage: true }, { effect_id: 'e', escape_check_ability: 'str' },
    { effect_id: 'e', start_turn_save: {} }, { effect_id: 'e', spell_id: 'vitriolic-sphere', recurring_damage_timing: 'turn-end' }, { effect_id: 'e', spell_id: 'vitriolic-sphere' }]) {
    cases.condition_uses_effect_identity.push({ condition, payload, expected: E.conditionUsesEffectIdentity(condition, payload) })
  }
}

// ---------- «Обессиливание» ----------
cases.enervation = []
for (const ruleset of ['dnd_5e_2014', 'srd_5_2_1', undefined]) {
  for (let index = 0; index < 14; index += 1) {
    const effectId = pick(['eff-1', 'eff-2', '', null])
    const condition = (target) => json({
      id: pick(['enervated', 'enervated', 'enervated', 'other']),
      source_actor: pick(['mage', 'mage', 'other']),
      effect_id: pick([effectId, effectId, 'eff-x']),
      continuation_version: pick([1, 1, '1', 2, undefined]),
      spell_id: pick([undefined, 'enervation', 'other', null]),
      ...(random() < 0.4 ? { continuation_damage: pick(['5d8', '', 0]) } : {}),
      ...(random() < 0.3 ? { continuation_damage_type: pick(['fire', '']) } : {}),
      ...(random() < 0.4 ? { continuation_range: pick([30, '45', 'x', null]) } : {}),
      ...(random() < 0.3 ? { continuation_upcast_dice_per_level: pick([1, 'x']) } : {}),
      ...(random() < 0.3 ? { continuation_duration_seconds: pick([12, 'y']) } : {}),
      ...(random() < 0.5 ? { slot_level: pick([5, 6, 9, 'x', 3]) } : {}),
      target,
    })
    const state = json({
      ...(ruleset ? { ruleset_id: ruleset } : {}),
      mechanics: {
        concentration: { mage: effectId == null ? {} : { effect_id: effectId, spell_id: 'enervation' } },
        conditions: { zed: [condition('zed')], alpha: [condition('alpha'), condition('alpha')], beta: 'oops', mage: [] },
      },
    })
    for (const actionId of [undefined, null, 'enervation-repeat', 'other']) {
      cases.enervation.push({
        state, caster_id: 'mage', action_id: actionId,
        link: json(E.enervationLinkFor(state, 'mage')) ?? null,
        action: json(E.enervationContinuationActionFor(state, 'mage', actionId)) ?? null,
      })
    }
  }
}

// ---------- метка времени раунда ----------
const roundEvents = [
  { event_type: 'AttackResolved' }, { event_type: 'ActorMoved', payload: { distance: 0 } }, { event_type: 'ActorMoved', payload: { distance: '10' } },
  { event_type: 'CombatActionUsed', payload: { action_type: 'free' } }, { event_type: 'CombatActionUsed', payload: { action_type: 'bonus_action' } }, { event_type: 'CombatActionUsed', payload: { movement_spent: 5 } },
  { event_type: 'EquipmentChanged', payload: { timing: 'action' } }, { event_type: 'ItemUsed', payload: { combat_action: 'object_interaction' } }, { event_type: 'ItemUsed', payload: { combat_action: 'free' } },
  { event_type: 'DieRolled' }, { event_type: 'DoorLockpicked' },
]
cases.round_time = []
for (let index = 0; index < 80; index += 1) {
  const command = { ...pick(commandShapes), command_type: pick(['MakeAttack', 'MoveActor', 'EndTurn', 'UseItem', 'CastSpell', 'AdvanceScene']) }
  const events = Array.from({ length: Math.floor(random() * 3) }, () => pick(roundEvents))
  const rawState = pick([{}, { mechanics: { combat: { active: true, round: 3 } } }, { mechanics: { combat: { active: true, round: 'x' } } }, { mechanics: { combat: { active: false } } },
    { mechanics: { combat: { active: true, round_time_pending: true } } }, { mechanics: { combat: { active: 1 } } }])
  const context = pick([{}, { __resolve_depth: 0 }, { __resolve_depth: 1 }, { __resolve_depth: '2' }])
  const result = { command, events, rolls: [{ total: 1 }] }
  cases.round_time.push({ result, raw_state: rawState, context, expected: E.withCombatRoundTimeMarker(result, rawState, context) })
}

// ---------- провенанс ----------
const sourceStates = [{}, { ruleset_id: 'dnd_5e_2014' }, { ruleset_id: '' }, { ruleset_id: 'srd_5_2_1' }, { ruleset_id: 'homebrew' }]
const sourceCommands = []
for (const type of [...allTypes.slice(0, 40), ...extraTypes]) for (const rules of [undefined, [], ['x:y'], ['srd_5_2_1:combat:damage'], ['dnd_5e_2014:combat:damage', ' '], 'srd_5_2_1:a']) {
  const command = { command_type: type }
  if (rules !== undefined) command[random() < 0.5 ? 'source_rule_ids' : 'sourceRuleIds'] = rules
  sourceCommands.push(command)
}
cases.source_ids_for = sourceCommands.map((command) => {
  const state = pick(sourceStates)
  try { return { command, state, expected: E.sourceIdsFor(command, state) } }
  catch (error) { return { command, state, error: { name: error.name, code: error.code ?? null } } }
})

out.cases = json(cases)
writeFileSync(new URL('core.json', import.meta.url), `${JSON.stringify(out)}\n`)
console.log('core.json:', Object.entries(out.cases).map(([key, list]) => `${key} ${list.length}`).join(', '))
