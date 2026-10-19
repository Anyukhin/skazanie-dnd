import '../../../fixtures-env.mjs'
// Эталон `normalizeCampaignState` на синтетических состояниях с мусором
// (задача Р4б): корпус (`gen-normalize-corpus.mjs`) даёт правдоподобные
// кампании, а здесь — края нормализации: дробные и строковые числа, `null`
// вместо объектов, повторные id вещей, ключи прототипа в заготовках, отдых,
// смерть, часы мира с остатком секунд, экономика хода в camelCase, герои с
// предысторией, враги без инвентаря, сценарные поля.
//
// Эталон — sha256 `JSON.stringify` итога целиком; состояния лежат целиком.
//
//   node rust/crates/sk-rules/fixtures/gen-normalize-synthetic.mjs
//   node …/gen-normalize-synthetic.mjs --dump <номер>   — итог JS
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { normalizeCampaignState } from '../../../../server/rules-engine.mjs'
import { sourceSha256 } from './open-copy.mjs'

let seed = 0x5eed4b4b
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
const sha = (text) => createHash('sha256').update(text).digest('hex')

const NUMBERS = [0, 1, 2, -3, 2.5, '4', '', null, 'x', 1e21, 7, 12, 20, 99]
const CLASSES = ['fighter', 'wizard', 'cleric', 'rogue', 'ranger', 'paladin', 'bard', 'druid', 'monk', 'warlock', 'sorcerer', 'barbarian', 'unknown']

function item(index) {
  return {
    ...(chance(0.8) ? { id: pick(['sword', 'bow', ' bow ', 'potion', `item-${index}`, 7, '']) } : {}),
    name: pick(['Длинный лук', 'Арбалет', 'Граната', 'Динамит', 'Меч', 'Зелье лечения', 'Стрелы', 'Longbow']),
    quantity: pick([1, 2, '3', 0, -1, 2.5, 1e6, undefined]),
    ...maybe(0.3, { equipped: chance(0.5) }),
    ...maybe(0.2, { combat: pick([{ kind: 'melee', damage: '1d8' }, [1, 2], null]) }),
    ...maybe(0.2, { properties: pick(['метательное', 'bow', null]) }),
    ...maybe(0.2, { weight: pick(NUMBERS) }),
  }
}

function hero(index) {
  const id = pick([`hero-${index}`, `hero-${index}`, 'hero-0'])
  return {
    id,
    name: `Герой ${index}`,
    class: pick(CLASSES),
    level: pick(NUMBERS),
    hp: pick(NUMBERS),
    ...(chance(0.5) ? { maxHp: pick(NUMBERS) } : { max_hp: pick(NUMBERS) }),
    experience: pick(NUMBERS),
    abilities: { str: pick([8, 14, 18, '12']), dex: pick([10, 16]), con: 14, int: pick([8, 18]), wis: 12, cha: pick([10, 16]) },
    inventory: chance(0.9) ? Array.from({ length: Math.floor(random() * 5) }, (_, n) => item(n)) : pick([null, 'x', {}]),
    ...maybe(0.4, { currency: pick([{ gold: 5, silver: '3' }, null, { platinum: -1 }]) }),
    ...maybe(0.3, { subclass: pick(['champion', 'evocation', 'nonsense', null]) }),
    ...maybe(0.3, { classSkillProficiencies: pick([['athletics', 'perception'], ['stealth', 'stealth'], 'x']) }),
    ...maybe(0.2, { selectedFeatureIds: pick([['archery'], [], null]) }),
    ...maybe(0.3, { knownSpellIds: pick([['magic-missile', 'shield'], [], null]) }),
    ...maybe(0.3, { preparedSpellIds: pick([['cure-wounds', 'bless'], []]) }),
    ...maybe(0.2, { backgroundId: pick(['acolyte', 'soldier', 'criminal', 'unknown']), backgroundChoices: { replacementSkills: pick([['insight'], [], ['athletics', 'arcana']]) } }),
    ...maybe(0.2, { x: pick(NUMBERS), y: pick(NUMBERS) }),
    ...maybe(0.15, { combatSpells: [{ id: 'old' }], characterSheet: { old: true }, inventoryLoad: 3 }),
    ...maybe(0.1, { footprint: pick([{ width: 2, height: 2 }, 'large', null]) }),
  }
}

function mechanics(players) {
  const ids = players.map((player) => player.id)
  const someId = () => pick([...ids, 'ghost', ''])
  return {
    ...maybe(0.5, { temporary_hp: { [someId()]: pick(NUMBERS) } }),
    ...maybe(0.5, { resources: { [someId()]: pick([{ spell_slot_1: { current: 1, max: 2 } }, {}, null]) } }),
    ...maybe(0.6, { hit_point_dice: { [someId()]: pick([{ spent: pick(NUMBERS) }, null, 'x']), [someId()]: { spent: 1 } } }),
    ...maybe(0.6, { resting: { [someId()]: pick([
      { kind: 'long', schema_version: 2, rest_id: 'r-1', started_at_minutes: pick(NUMBERS), minimum_duration_minutes: pick(NUMBERS) },
      { kind: 'short', reason: 'knockout', recovery_minutes_remaining: pick(NUMBERS) },
      { kind: 'odd', schema_version: '2' },
      null,
    ]) } }),
    ...maybe(0.5, { death: {
      campaign_status: pick(['party_defeated', 'active', 'x']),
      heroes: { [someId()]: pick([{ status: 'dead', resolution: pick(['replaced', 'nope', null]), died_round: pick([3, 2.5, '4']), died_world_minutes: pick([60, null]), replacement_name: pick([null, 5, 'Новый']) }, null]) },
      saving_throws: { [someId()]: { successes: pick(NUMBERS), failures: pick(NUMBERS), stable: chance(0.5), recovery_minutes_remaining: pick(NUMBERS) } },
    } }),
    ...maybe(0.5, { world_time: pick([
      { elapsed_minutes: pick(NUMBERS), second_remainder: pick([0, 59.5, 61, -5, '30', null]) },
      { amount: pick(NUMBERS), unit: pick(['hour', 'day', 'round', 'Часа', undefined]) },
      5,
      null,
    ]) }),
    ...maybe(0.6, { combat: {
      active: chance(0.6),
      round: pick(NUMBERS),
      initiative: pick([[{ actor_id: someId(), initiative: 12 }], null, 'x']),
      active_index: pick(NUMBERS),
      reaction_window: pick([null, { id: 'w1' }, [], 0]),
      readied: { [someId()]: pick([{ trigger: 'enemy-approaches' }, { trigger: 'constructor' }, { trigger: 'nope' }, null]), b: { trigger: 'enemy-casts-spell', spell_id: 'x' } },
      group_initiative: pick([true, 'true', 1]),
      turn_completed: pick([[' a ', 'a', '', 3], null]),
      round_time_pending: pick([true, false, 'yes']),
      truce: pick([null, { leader_id: 'e1', established_round: 2 }, 'x']),
      parley_attempts: pick(NUMBERS),
      turn_reaction_extensions: pick(NUMBERS),
      turn_started_at: pick([null, '2026-01-01', 5, undefined]),
      turn_started_event_id: pick([null, 'ev', 7]),
      action_economy: { [someId()]: pick([{ movementSpent: '5', extraActions: 2, loadingWeaponItemIds: { action: ['x', 'x'] } }, { movement_spent: -3, surged_action_only: true }, null, 'x']) },
      extra_field: 'kept',
    } }),
    ...maybe(0.4, { scene_interactions: { chest: { state: pick([null, 'open', 7]), inspected: chance(0.5), used_by: ['a', 'a', ''], lockpicked_by: pick([null, 5]), knowledge_ids: Array.from({ length: 30 }, (_, n) => `k${n}`) }, '': { state: 'x' }, bad: 5 } }),
    ...maybe(0.4, { enemy_knowledge: { party: { e1: { health: true, speed: 'exact', armor_class: 'maybe' }, e2: { nothing: true }, e3: null } } }),
    ...maybe(0.3, { reaction_preferences: pick([{ [someId()]: { opportunity_attack: 'ask' } }, {}, null]) }),
    ...maybe(0.3, { encounter: pick([{ id: 'enc', enemies: [{ id: 'e1', loadout: { items: [] } }, null, 'x'] }, null, []]) }),
    ...maybe(0.3, { active_effects: pick([[{ id: 'fx' }], 'x']) }),
    ...maybe(0.3, { progression: { milestones: pick([[{ id: 'm1', milestone: 'x' }, { id: '' }, null], 'x']), milestones_since_level: pick(NUMBERS) } }),
    ...maybe(0.3, { campaign_lifecycle: { status: pick(['paused', 'concluded', 'weird']), reason: 'x' } }),
    ...maybe(0.2, { positions: { [someId()]: { x: 1, y: 2 } } }),
    ...maybe(0.2, { custom_mechanics_field: [1, 2] }),
  }
}

function state(index) {
  const players = chance(0.95) ? Array.from({ length: 1 + Math.floor(random() * 3) }, (_, n) => hero(index * 10 + n)) : pick([null, 'x', []])
  const heroes = Array.isArray(players) ? players : []
  return {
    ...maybe(0.5, { state_version: pick(NUMBERS) }),
    ...maybe(0.2, { stateVersion: pick(NUMBERS) }),
    ...maybe(0.5, { ruleset_id: pick(['srd_5_2_1', 'dnd_5e_2014', '', null]) }),
    ...maybe(0.2, { rulesetId: 'dnd_5e_2014' }),
    ...maybe(0.3, { enabled_house_rules: pick([['skazanie:economy-v1', 'x', 'x'], 'x', null]) }),
    ...maybe(0.2, { enabled_rule_packs: pick([['a', ' a '], []]) }),
    ...maybe(0.3, { character_start_level: pick(NUMBERS) }),
    ...maybe(0.2, { worldMemory: pick([{ entities: [] }, null]) }),
    players,
    ...maybe(0.5, { actors: [{ actor_id: 'npc-1', hp: pick(NUMBERS), alive: pick([true, false, undefined]) }, { id: '', hp: 3 }, { id: 'npc-2', maxHp: '7', summoned: true, x: 3, y: 4 }] }),
    ...maybe(0.5, { enemies: [{ id: 'e1', name: 'Гоблин', hp: pick(NUMBERS), max_hp: 7, x: 5, y: '6' }, { id: 'e2', hp: 0, loadout: { items: [{ catalog_id: 'arrow', quantity: 5 }] } }] }),
    ...maybe(0.3, { partyName: pick(['', 'Отряд', 5, null]) }),
    ...maybe(0.4, { partyMemberIds: pick([heroes.map((h) => h.id), ['ghost'], 'x']) }),
    ...maybe(0.3, { mapFeedback: Array.from({ length: 9 }, (_, n) => ({ n })) }),
    ...maybe(0.3, { battleLog: Array.from({ length: 55 }, (_, n) => n) }),
    ...maybe(0.3, { adventure: pick([{ chapter: pick(NUMBERS), history: Array.from({ length: 25 }, (_, n) => n), visitedLocations: ['Город', 'Город', 3] }, null, []]) }),
    ...maybe(0.4, { scene: { title: 'Сцена', location: pick(['Таверна', '', null]), ...maybe(0.5, { location_id: 'tavern' }) } }),
    mechanics: chance(0.9) ? mechanics(heroes) : pick([null, 'x']),
    ...maybe(0.2, { merchants: [{ id: 'm1', name: 'Торговец', stock: [] }] }),
    ...maybe(0.2, { agentInteraction: pick([{ id: 'i1', options: [] }, 'x']) }),
    ...maybe(0.2, { world_offices: pick([{ offices: [] }, null]) }),
    ...maybe(0.2, { campaignConcept: { mode: pick(['persistent', 'oneshot']), title: 'X' }, campaignMode: pick(['persistent', undefined]) }),
    ...maybe(0.1, { extra_root: { kept: true } }),
  }
}

const states = []
const cases = []
for (let index = 0; index < 400; index += 1) {
  const raw = JSON.parse(JSON.stringify(state(index)))
  let outcome
  try {
    const normalized = normalizeCampaignState(raw)
    if (process.argv[2] === '--dump' && Number(process.argv[3]) === index) {
      console.log(JSON.stringify(normalized, null, 1))
      process.exit(0)
    }
    outcome = { sha: sha(JSON.stringify(normalized)) }
  } catch (error) {
    outcome = { throws: String(error?.message ?? error).slice(0, 200) }
  }
  states.push(raw)
  cases.push(outcome)
}
const output = new URL('./normalize-synthetic.json', import.meta.url)
writeFileSync(output, `${JSON.stringify({ source_sha256: sourceSha256(), states, cases })}\n`)
console.log(`normalize-synthetic.json: состояний ${states.length}, бросает ${cases.filter((entry) => entry.throws).length}`)
