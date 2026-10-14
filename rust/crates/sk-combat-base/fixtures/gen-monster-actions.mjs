// Эталон monster-actions для Rust: все приёмы бестиария 2014 и авторских
// миров плюс сотни синтетических (перезарядка, «X раз», области с мусором в
// полях), доступность по маркерам, допустимые цели, эффекты попадания и
// мультиатаки.
//
//   node rust/crates/sk-combat-base/fixtures/gen-monster-actions.mjs
//
// Пишет monster-actions.json рядом с собой.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  monsterActionAvailable,
  monsterActionSpentMarker,
  monsterActionUsageKey,
  monsterActionUsesSpent,
  monsterAreaAction,
  monsterAttackTargetAllowed,
  monsterMultiattackSequenceFor,
  monsterMultiattackSequences,
  monsterOnHitTargetAllowed,
  monsterRechargeMinimum,
} from '../../../../server/monster-actions.mjs'

const here = (name) => fileURLToPath(new URL(name, import.meta.url))
const readJson = (path) => JSON.parse(readFileSync(here(path), 'utf8'))

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(5150)
const pick = (items) => items[Math.floor(random() * items.length)]

const monsters = readJson('../../../../data/compendia/dnd_5e_2014/monsters.json').monsters
const worlds = readJson('../../../../data/campaign-worlds-v1.json')
const realActions = monsters.flatMap((monster) => [...monster.actions, ...monster.bonus_actions, ...monster.reactions, ...monster.legendary_actions, ...monster.lair_actions])
const realActors = []
const onHits = []
const walk = (value) => {
  if (Array.isArray(value)) value.forEach(walk)
  else if (value && typeof value === 'object') {
    if (Array.isArray(value.action_profiles) || Array.isArray(value.special_actions)) realActors.push(value)
    if (value.on_hit && typeof value.on_hit === 'object') onHits.push(value.on_hit)
    for (const list of ['action_profiles', 'special_actions']) if (Array.isArray(value[list])) realActions.push(...value[list])
    Object.values(value).forEach(walk)
  }
}
walk(worlds)
for (const monster of monsters) for (const action of monster.actions) if (action.on_hit) onHits.push(action.on_hit)

const NUMBERS = [0, 1, 3, 5, 6, 7, -1, 2.5, '4', 'x', null, true, 120, 121, 4.5, 125]
function syntheticAction() {
  const action = { id: pick(['breath', 'spike', 'gaze', '', null, 'roar', 9]) }
  const put = (probability, key, make) => {
    if (random() < probability) action[key] = make()
  }
  put(0.7, 'kind', () => pick(['save_area', 'save_area', 'melee', 'save']))
  put(0.4, 'recharge', () => pick([{ success: [5, 6] }, { success: [6], group: 'breaths' }, { success: '46' }, { success: [] }, { group: 'g' }, 5, '6', 7, [5], null, { success: ['5', 6] }, { success: [null] }]))
  put(0.2, 'recharge_group', () => pick(['breaths', null, 3, '']))
  put(0.4, 'uses', () => pick(NUMBERS))
  put(0.2, 'condition', () => pick(['prone', null, '']))
  put(0.15, 'on_hit', () => pick([{}, null, 0]))
  put(0.25, 'effects', () => pick([{}, { a: 1 }, [], [1], 'ab', '', 5, null]))
  put(0.85, 'save', () => pick([
    { ability: 'dex', dc: 15, success: 'half_damage' }, { ability: 'con', dc: 40, success: 'no_damage' }, { ability: 'luck', dc: 15, success: 'half_damage' },
    { ability: 'wis', dc: 0, success: 'half_damage' }, { ability: 'str', dc: 2.5, success: 'half_damage' }, { ability: 'int', dc: '12', success: 'half_damage' },
    { ability: 'cha', dc: 12, success: 'none' }, 'dex', null,
  ]))
  put(0.85, 'area', () => pick([
    { shape: 'cone', length_ft: 30 }, { shape: 'line', length_ft: 60, width_ft: 5 }, { shape: 'line', length_ft: 60, width_ft: 10 }, { shape: 'line', length_ft: 60 },
    { shape: 'sphere', radius_ft: 20 }, { shape: 'sphere', length_ft: null, radius_ft: 20 }, { shape: 'cube', length_ft: 10 }, { shape: 'cone', length_ft: 4 },
    { shape: 'cone', length_ft: 125 }, { shape: 'cone', length_ft: '30' }, { shape: 'cone', length_ft: 30, width_ft: 200 }, { shape: 'cone', length_ft: 30, width_ft: 'x' },
    { shape: 'cone' }, null,
  ]))
  put(0.85, 'damage', () => pick([
    [{ type: 'fire', expression: '6d6' }], [{ type: 'cold', amount: 10 }], [{ type: 'laser', expression: '1d6' }], [{ type: 'fire', expression: 'bad' }],
    [{ type: 'fire', amount: -1 }], [{ type: 'fire', amount: 2.5 }], [{ type: 'acid', expression: 5 }], [{ type: 'acid', expression: '' , amount: 3 }],
    [], [{ type: 'fire', amount: 1 }, { type: 'cold', amount: 1 }, { type: 'acid', amount: 1 }, { type: 'poison', amount: 1 }, { type: 'thunder', amount: 1 }],
    [{ type: 'necrotic', expression: ' 2D8 + 4 ' }], 'x',
  ]))
  put(0.4, 'name_ru', () => pick(['Дыхание', null, 3]))
  put(0.3, 'name', () => pick(['Breath', null]))
  return action
}
// Почти исправная область: одна-две правки от рабочей записи, чтобы каждая
// проверка `monsterAreaAction` срабатывала поодиночке.
function nearArea() {
  const action = {
    id: 'breath', name_ru: 'Дыхание', kind: 'save_area', recharge: { success: [5, 6], group: 'breaths' },
    save: { ability: 'dex', dc: 15, success: 'half_damage' }, area: { shape: 'cone', length_ft: 30 }, damage: [{ type: 'fire', expression: '6d6' }],
  }
  const donor = syntheticAction()
  const keys = Object.keys(donor)
  for (let count = Math.floor(random() * 3); count > 0 && keys.length; count -= 1) {
    const key = pick(keys)
    action[key] = donor[key]
  }
  return action
}
const actions = [...realActions, ...Array.from({ length: 300 }, syntheticAction), ...Array.from({ length: 250 }, nearArea), null, {}, 'x']

const MARKERS = ['monster-action-used:breath', 'monster-action-used:breaths', 'monster-action-used:spike#1', 'monster-action-used:spike#2', 'monster-action-used:fire-breath',
  'monster-action-used:g', 'monster-action-used:roar#3', 'monster-action-used:9', 'monster-action-used:', 'prone']
const randomConditions = () => Array.from({ length: Math.floor(random() * 4) }, () => {
  const marker = pick(MARKERS)
  const roll = random()
  return roll < 0.6 ? marker : roll < 0.85 ? { id: marker } : roll < 0.9 ? { id: null } : roll < 0.95 ? null : 7
})

const summaries = actions.map((action, index) => {
  const conditions = randomConditions()
  return {
    action: index,
    conditions,
    area: monsterAreaAction(action),
    recharge: monsterRechargeMinimum(action),
    key: monsterActionUsageKey(action),
    spent: monsterActionUsesSpent(action, conditions),
    available: monsterActionAvailable(action, conditions),
    marker: monsterActionSpentMarker(action, conditions),
  }
})

const CONDITION_POOL = ['incapacitated', 'paralyzed', 'stunned', 'prone', 'grappled', 'restrained', 'unconscious', 'blinded']
const targets = []
for (let index = 0; index < 300; index += 1) {
  const action = {}
  if (random() < 0.4) action.target_condition = pick([...CONDITION_POOL, '', null, 5])
  if (random() < 0.5) action.target_any_conditions = pick([['incapacitated'], ['grappled'], ['prone', 'restrained'], [], ['blinded', 'grappled'], [5], null])
  const conditions = Array.from({ length: Math.floor(random() * 4) }, () => {
    const id = pick(CONDITION_POOL)
    const roll = random()
    return roll < 0.5 ? id : roll < 0.9 ? { id, source_actor: pick(['boss', 'other', null, undefined]) } : { id: null }
  })
  const sourceId = pick(['boss', 'other', null])
  targets.push({ action, conditions: JSON.parse(JSON.stringify(conditions)), sourceId, allowed: monsterAttackTargetAllowed(action, conditions, sourceId) })
}

const syntheticOnHits = [{}, { required_target_type: 'humanoid' }, { required_target_type: 'beast' }, { excluded_targets: ['elf'] }, { excluded_targets: ['undead', 'construct'] },
  { required_target_type: 'humanoid', excluded_targets: ['dwarf', 'elf'] }, { required_target_type: '' }, { excluded_targets: [] }, { excluded_targets: ['goblin'] }]
const allOnHits = [...onHits, ...syntheticOnHits]
const TARGETS = [
  {}, { creature_type: 'Humanoid' }, { creature_type: 'beast' }, { creatureType: 'UNDEAD' }, { race: 'elf-high' }, { race_id: 'drow' }, { raceId: 'Эльф' },
  { speciesBenefits: { race_id: 'elf-wood' } }, { race: 'dwarf', subtypes: ['goblin'] }, { creature_type: null, race: null }, { subtypes: 'elf' },
  { speciesBenefits: null, race_id: 'Dwarf' }, { creature_type: 'construct', subtypes: ['construct', 5] }, null,
]
const onHitCases = []
for (const onHit of allOnHits) for (const target of TARGETS) onHitCases.push({ onHit, target, allowed: monsterOnHitTargetAllowed(onHit, target) })

function syntheticActor() {
  const ids = ['bite', 'claw', 'tail', 'spit']
  const profiles = ids.filter(() => random() < 0.7).map((id) => ({ id }))
  const sequence = () => Array.from({ length: Math.floor(random() * 4) }, () => pick([...ids, 'gore', 5]))
  const trait = { id: 'multiattack' }
  if (random() < 0.7) trait.sequences = Array.from({ length: Math.floor(random() * 4) }, () => (random() < 0.1 ? 'bite' : sequence()))
  if (random() < 0.4) trait.sequence = sequence()
  if (random() < 0.3) trait.sequence_conditions = pick([[{ requires: 'flying' }], [null, { requires: 'flying' }], { 1: { requires: 'flying' } }, [{ requires: 'swimming' }], ['x']])
  const actor = { traits: random() < 0.9 ? [{ id: 'other' }, trait] : [], action_profiles: profiles }
  if (random() < 0.4) actor.movement_mode = pick(['fly', 'walk'])
  if (random() < 0.05) actor.action_profiles = 'x'
  return actor
}
const actors = [...realActors, ...Array.from({ length: 200 }, syntheticActor), null, {}]
const multiattack = actors.map((actor, index) => {
  const sequences = monsterMultiattackSequences(actor)
  const lookups = Array.from({ length: 3 }, () => {
    const used = Array.from({ length: Math.floor(random() * 3) }, () => pick(['bite', 'claw', 'tail', 'spit']))
    const next = pick(['bite', 'claw', 'tail', 'spit', 'gore'])
    return { used, next, sequence: monsterMultiattackSequenceFor(actor, next, used) }
  })
  return { actor: index, sequences, lookups }
})

const fixture = { actions, summaries, targets, onHitCases, actors, multiattack }
const lines = Object.entries(fixture).map(([key, value]) => `${JSON.stringify(key)}: [\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`)
writeFileSync(here('monster-actions.json'), `{\n${lines.join(',\n')}\n}\n`)
console.log(`monster-actions.json: ${actions.length} приёмов (${summaries.filter((entry) => entry.area).length} областей), ${targets.length} целей, ${onHitCases.length} попаданий, ${actors.length} мультиатак (${multiattack.filter((entry) => entry.sequences.length).length} с последовательностями)`)
