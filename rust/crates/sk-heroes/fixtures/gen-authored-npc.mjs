import '../../../fixtures-env.mjs'
// Эталон server/authored-npc.mjs: node gen-authored-npc.mjs
//
// Все авторские NPC с боевым листом из `data/campaign-worlds-v1.json` и
// `data/campaign-scenarios-v1.json`: нормализация, безопасная нормализация и
// боевая форма. Затем — правки листа по одному полю (снять поле, `null`,
// чужой тип, граница диапазона) на верхнем уровне и во вложенных записях.
//
// Случай правки описывается адресом, а не целым листом: `{ fn: 'mutated',
// args: [npcId, path, value] }` — Rust сам берёт лист из `npcs` эталона и
// ставит `value` по пути `path` (UNDEFINED — снять поле). Удачный результат
// правки записан хешем SHA-256 от `JSON.stringify` (байт в байт, с порядком
// ключей), отказ — целиком.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as m from '../../../../server/authored-npc.mjs'
import { recorder, UNDEFINED } from './record.mjs'

const r = recorder('authored-npc')
const clone = (value) => structuredClone(value)
const readData = (name) => JSON.parse(readFileSync(new URL(`../../../../data/${name}`, import.meta.url), 'utf8'))

/** NPC с листом `mechanics` в любом месте файла, в порядке обхода. */
function authoredNpcs(value, found = []) {
  if (Array.isArray(value)) value.forEach((entry) => authoredNpcs(entry, found))
  else if (value && typeof value === 'object') {
    if (typeof value.id === 'string' && value.mechanics && typeof value.mechanics === 'object') found.push(value)
    for (const entry of Object.values(value)) authoredNpcs(entry, found)
  }
  return found
}
const npcs = [...authoredNpcs(readData('campaign-worlds-v1.json')), ...authoredNpcs(readData('campaign-scenarios-v1.json'))]
if (npcs.length < 8) throw new Error(`мало авторских NPC: ${npcs.length}`)
r.constant('npcs', npcs.map((npc) => ({ id: npc.id, name: npc.name, mechanics: npc.mechanics })))
r.constant('AUTHORED_NPC_MECHANICS_STATUSES', m.AUTHORED_NPC_MECHANICS_STATUSES)

const normalize = (...args) => r.call('normalizeAuthoredNpcMechanics', m.normalizeAuthoredNpcMechanics, ...args)
const safe = (value) => r.call('safeAuthoredNpcMechanics', m.safeAuthoredNpcMechanics, value)
const combatant = (input) => r.call('authoredNpcCombatant', m.authoredNpcCombatant, input)

// 1. Каждый NPC как есть.
for (const [index, npc] of npcs.entries()) {
  normalize(npc.mechanics)
  normalize(npc.mechanics, `templates.opening.npcs[${index}].mechanics`)
  safe(npc.mechanics)
  for (const position of [{ x: 4, y: 2 }, { x: 0, y: 0 }, { x: 10000, y: '17' }]) combatant({ npc: { id: npc.id, name: npc.name }, mechanics: npc.mechanics, position })
}

// 2. Боевая форма: идентификатор, имя, позиция, вход без объекта.
const sample = npcs.find((npc) => npc.id === 'astohan-ares') ?? npcs[0]
for (const npc of [
  { id: ' astohan-ares ', name: 'Арес' }, { id: 'ASTOHAN-ARES', name: 'Арес' }, { id: 'some-guard', name: '  Стражник   у ворот ' }, { id: 'constructor', name: 'Прототип' },
  { id: 'toString', name: 'Прототип' }, { id: '__proto__', name: 'Прототип' }, { id: '../outside', name: 'Чужой' }, { id: '', name: 'Пусто' }, { id: 5, name: 'Число' },
  { id: 'a'.repeat(121), name: 'Длинный' }, { id: 'npc:one.two_3', name: 'Имя' }, { id: 'npc', name: '' }, { id: 'npc', name: '   ' }, { id: 'npc' }, { name: 'Без id' },
  { id: 'npc', name: 'Ａｒｅｓ　Ⅳ' }, { id: 'npc', name: 'x'.repeat(200) }, null, 'astohan-ares', [],
]) combatant({ npc: clone(npc), mechanics: sample.mechanics, position: { x: 1, y: 1 } })
for (const position of [{ x: '4', y: ' 2 ' }, { x: 4.5, y: 2 }, { x: -1, y: 2 }, { x: 10001, y: 2 }, { x: 4, y: null }, { x: 4 }, { x: [4], y: [2] }, { x: true, y: false }, null, undefined, 'x', []]) {
  combatant({ npc: { id: 'npc', name: 'Имя' }, mechanics: sample.mechanics, position: clone(position) })
}
combatant({ npc: { id: 'npc', name: 'Имя' }, mechanics: undefined, position: { x: 1, y: 1 } })
combatant({ npc: { id: 'npc', name: 'Имя' }, mechanics: { profile_id: 'broken' }, position: { x: 1, y: 1 } })
combatant({})
combatant(undefined)
combatant(null)
for (const expression of ['1d6-2', '1d6', '12d100+999', '2d8-0', '10d12+5']) {
  const mechanics = clone(sample.mechanics)
  mechanics.action_profiles[0].damage_expression = expression
  combatant({ npc: { id: 'npc', name: 'Имя' }, mechanics, position: { x: 1, y: 1 } })
}
for (const value of [null, undefined, 'mechanics', [], 5, {}, { profile_id: 'broken' }]) {
  normalize(clone(value))
  safe(clone(value))
}

// 3. Правки по одному полю.
const mutated = (npc, path, value) => {
  const mechanics = clone(npc.mechanics)
  let target = mechanics
  for (const key of path.slice(0, -1)) target = target[key]
  const last = path[path.length - 1]
  if (value === undefined) delete target[last]
  else target[last] = clone(value)
  const entry = { fn: 'mutated', args: [npc.id, path, value === undefined ? UNDEFINED : value] }
  try {
    entry.sha256 = createHash('sha256').update(JSON.stringify(m.normalizeAuthoredNpcMechanics(mechanics))).digest('hex')
  } catch (error) {
    entry.error = { name: error.name, code: error.code ?? null, message: error.message }
  }
  r.cases.push(entry)
}

const SCALARS = [undefined, null, '', ' 7 ', 'abc', 0, -1, 1, 2, 5, 6, 9, 10, 12, 20, 21, 30, 31, 120, 121, 500, 501, 600, 601, 1.5, '1e1', [3], ['4'], [], {}, true, false, 'Infinity', -0.0, 100000, 100001]
const TEXTS = [undefined, null, '', '   ', ' Имя  с   пробелами ', 'Ａｂｃ', 'x'.repeat(700), 5, [], ['a', 'b'], {}, true]
const IDS = [undefined, null, '', 'Bad Id', ' good-id ', 'ok.id:1_2-3', '-bad', '_bad', 'a'.repeat(120), 'a'.repeat(121), 5, ['arr'], {}, 'constructor']
const ENUM_TEXTS = (values) => [undefined, null, '', ...values, ` ${values[0]} `, values[0].toUpperCase(), 'unknown', 5, [values[0]], {}]
const STATUS = ENUM_TEXTS(['verified', 'partial', 'ruling-only', 'heuristic'])
const DAMAGE = ENUM_TEXTS(['fire', 'cold', 'slashing', 'psychic'])
const CONDITIONS = ENUM_TEXTS(['prone', 'restrained', 'exhaustion', 'unconscious'])
const DICE = [undefined, null, '', '2d6+3', ' 1d8 ', '1d8 + 2', '100d6', '10d1000', '1d6+1000', 'd6', '2d6-4', '2D6', '1к6', 5, ['1d4']]
const ARRAYS = (values) => [undefined, null, [], values, [...values, values[0]], [...values, 'unknown'], 'fire', {}, Array(21).fill(values[0]), [' FIRE ']]

const TOP = {
  profile_id: IDS, status: STATUS, level: SCALARS, challenge_rating: [undefined, null, '', '1', '1/2', '1/4', '10', '30', '100', '1/', '1/100', ' 5 ', 5, 0.5, ['2'], '1/2/3'],
  xp: SCALARS, encounter_difficulty: ENUM_TEXTS(['easy', 'medium', 'hard', 'deadly']), hp: SCALARS, armor: SCALARS, speed: SCALARS,
  initiative_bonus: SCALARS, proficiency_bonus: SCALARS, size: ENUM_TEXTS(['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan']),
  creature_type: ENUM_TEXTS(['humanoid', 'dragon', 'undead', 'fey']),
  abilities: [undefined, null, {}, [], 'str', { str: 10, dex: 10, con: 10, int: 10, wis: 10 }, { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 0 }, { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 31 },
    { str: '12', dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, { cha: 10, wis: 10, int: 10, con: 10, dex: 10, str: 10 }, { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, luck: 3 }, { str: null, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }],
  skills: [undefined, null, {}, [], { stealth: 21 }, { stealth: -20 }, { stealth: -21 }, { flying: 3 }, { perception: '5', insight: 2 }, { sleight_of_hand: 4, 0: 1 }],
  saving_throws: [undefined, null, {}, { str: 3 }, { luck: 1 }, { con: 2.5 }],
  damage_vulnerabilities: ARRAYS(['fire', 'cold']), damage_resistances: ARRAYS(['fire', 'cold']), damage_immunities: ARRAYS(['fire', 'poison']),
  condition_immunities: [undefined, null, [], ['charmed', 'frightened'], ['charmed', 'charmed'], ['sleepy'], 'charmed', Array(25).fill('prone'), Array.from({ length: 25 }, (_, i) => ['blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'grappled', 'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious'][i % 15])],
  traits: [undefined, null, [], 'multiattack', {}, Array(13).fill({ id: 'aggressive' }), [{ id: 'aggressive' }, { id: 'aggressive' }], [{ id: 'aggressive', extra: 1 }], [5], [{ id: 'charge', name: 'Рывок' }, { id: 'pack-tactics' }],
    [{ id: 'multiattack', action_id: 'nope' }], [{ id: 'multiattack', action_counts: { nope: 1 } }], [{ id: 'multiattack', action_counts: [] }], [{ id: 'multiattack', action_counts: 'x' }]],
  action_profiles: [undefined, null, [], {}, 'x', [5]],
  spellcasting: [undefined, null, 'x', [], {}, { ability: 'int', save_dc: 15, attack_bonus: 7, spells: [] }, { ability: 'int', save_dc: 15, attack_bonus: 7, spells: [{ id: 'fire-bolt', uses: 'at-will' }] },
    { ability: 'int', save_dc: 15, attack_bonus: 7, spells: Array.from({ length: 21 }, () => ({ id: 'fire-bolt', uses: 1 })) }, { ability: 'int', save_dc: 15, attack_bonus: 7, spells: 'fire-bolt' },
    { ability: 'luck', save_dc: 15, attack_bonus: 7, spells: [{ id: 'fire-bolt', uses: 1 }] }, { ability: 'int', save_dc: 15, attack_bonus: 7, spells: [{ id: 'fire-bolt', uses: 1 }], slots: 3 }],
  legendary: [undefined, null, 'x', [], {}, { uses: 3, actions: [] }, { uses: 3, actions: 'x' }, { uses: 3, actions: [{ id: 'a', cost: 1, kind: 'attack', attack_modifier: 5, damage_type: 'fire', range_feet: 5 }] },
    { uses: 3, resistance: 6, actions: [{ id: 'a', cost: 1, kind: 'attack', attack_modifier: 5, damage_type: 'fire', range_feet: 5 }] }, { uses: 3, resistance: null, actions: [{ id: 'a', cost: 1, kind: 'attack', attack_modifier: 5, damage_type: 'fire', range_feet: 5 }] },
    { uses: 3, actions: Array.from({ length: 7 }, (_, i) => ({ id: `a${i}`, cost: 1, kind: 'attack', attack_modifier: 5, damage_type: 'fire', range_feet: 5 })) },
    { uses: 3, actions: [{ id: 'a', cost: 1, kind: 'attack', attack_modifier: 5, damage_type: 'fire', range_feet: 5 }, { id: 'a', cost: 1, kind: 'attack', attack_modifier: 5, damage_type: 'fire', range_feet: 5 }] },
    { uses: 3, actions: [{ id: 'a', cost: 6, kind: 'attack', attack_modifier: 5, damage_type: 'fire', range_feet: 5 }] }, { uses: 3, actions: [{ id: 'a', cost: 1, kind: 'save', damage_type: 'fire', range_feet: 5, save_ability: 'dex', save_dc: 15, radius_feet: 0 }] },
    { uses: 3, actions: [{ id: 'a', cost: 1, kind: 'save', damage_expression: '2d6', damage_type: 'fire', range_feet: 30, save_ability: 'dex', save_dc: 15, radius_feet: 10, area_shape: 'line' }] },
    { uses: 3, actions: [{ id: 'a', cost: 1, kind: 'save', damage_expression: '2d6', damage_type: 'fire', range_feet: 30, save_ability: 'dex', save_dc: 15, radius_feet: 10, area_shape: 'cone', half_on_save: 'yes' }] },
    { uses: 3, actions: [{ id: 'a', cost: 1, kind: 'hex', damage_type: 'fire', range_feet: 5 }] }, { uses: 3, actions: [5] }],
  special_actions: [undefined, null, 'x', {}, [], [5], Array(5).fill({}), [{ id: 'x' }]],
  features: [undefined, null, [], {}, [5], Array(13).fill({ id: 'f', status: 'partial', description: 'x' }), [{ id: 'f', status: 'partial', description: 'x' }, { id: 'f', status: 'verified', description: 'y' }],
    [{ id: 'f', status: 'partial', description: '' }], [{ id: 'f', status: 'partial', description: 'ok', extra: 1 }]],
  tactics: [undefined, null, [], 'x', ['a'], ['a', ''], ['a', '   '], Array(9).fill('a'), [5, true, {}], ['  много   пробелов  ', 'x'.repeat(400)]],
  unexpected_field: [undefined, 1, null],
  0: [undefined, 1],
}
const TRAIT = { id: [...IDS, 'aggressive', 'multiattack', 'instant-victory', ' charge '], name: TEXTS, attacks: SCALARS, action_id: [undefined, null, 'nope', ...IDS.slice(3, 6)], action_counts: [undefined, null, {}, [], 'x', { nope: 1 }, { ' x ': 1 }, { 'Bad Key': 1 }, { 5: 1, a: 2 }], extra: [undefined, 1] }
const ACTION = {
  id: IDS, name: TEXTS, kind: ENUM_TEXTS(['melee', 'ranged']), attack_modifier: SCALARS, damage_expression: DICE, damage_type: DAMAGE, range_feet: SCALARS,
  normal_range_feet: [undefined, null, 4, 5, 10, 400, 600, 601, '5', 'x'], tactical_priority: [undefined, null, -1, 0, 20, 21, '3', 'x'],
  on_hit: [undefined, null, 'x', [], {}, { damage_expression: '2d8', damage_type: 'cold' }, { damage_expression: 'x', damage_type: 'cold' }, { damage_expression: '2d8', damage_type: 'ice' }, { damage_expression: '2d8', damage_type: 'cold', save: 1 }],
  extra: [undefined, 1],
}
const FEATURE = { id: IDS, name: TEXTS, status: STATUS, description: [...TEXTS, 'x'.repeat(601)], extra: [undefined, 1] }
const SPELLCASTING = { ability: ENUM_TEXTS(['int', 'wis', 'cha']), save_dc: SCALARS, attack_bonus: SCALARS, spells: [undefined, null, [], {}, 'x'], extra: [undefined, 1] }
const SPELL = { id: [...IDS, 'fire-bolt', 'detect-magic', 'unknown-spell', 'shield', 'wish'], uses: [...SCALARS, 'at-will', 'At-Will', ' at-will'], extra: [undefined, 1] }
const LEGENDARY = { uses: SCALARS, resistance: [undefined, null, 0, 5, 6, -1, '2', 'x'], actions: [undefined, null, [], 'x'], extra: [undefined, 1] }
const LEGENDARY_ACTION = {
  id: IDS, name: TEXTS, cost: SCALARS, kind: ENUM_TEXTS(['attack', 'save']), attack_modifier: SCALARS, damage_expression: DICE, damage_type: DAMAGE, range_feet: SCALARS,
  save_ability: ENUM_TEXTS(['dex', 'con', 'str']), save_dc: SCALARS, half_on_save: [undefined, null, true, false, 'true', 1], condition: CONDITIONS,
  radius_feet: SCALARS, cooldown_turns: [undefined, null, 0, 1, 10, 11, '3', 'x'], area_shape: [undefined, null, 'sphere', 'cone', 'line', ' cone ', 5], extra: [undefined, 1],
}
const SPECIAL_ACTION = {
  id: [undefined, null, 'other-id', 5], kind: [undefined, 'attack', 'save_area'], damage: [undefined, [], [{ expression: '2d6', type: 'fire' }], 'x'],
  save: [undefined, null, { ability: 'con', dc: 15 }, {}], area: [undefined, { shape: 'sphere', radius_ft: 20 }, { shape: 'cube' }], recharge: [undefined, null, { die: '1d6', success: [6] }],
}

const mutateAll = (npc, prefix, table) => {
  for (const [key, values] of Object.entries(table)) for (const value of values) mutated(npc, [...prefix, key], value)
}
for (const npc of npcs) {
  const mechanics = npc.mechanics
  const full = ['astohan-eldrin', 'astohan-kaelan', 'astohan-sargat'].includes(npc.id)
  if (full) mutateAll(npc, [], TOP)
  else for (const [key, values] of Object.entries(TOP)) for (const value of values.slice(0, 6)) mutated(npc, [key], value)
  ;(mechanics.traits ?? []).forEach((_, index) => (full || index === 0) && mutateAll(npc, ['traits', index], TRAIT))
  ;(mechanics.action_profiles ?? []).forEach((_, index) => (full || index === 0) && mutateAll(npc, ['action_profiles', index], ACTION))
  ;(mechanics.features ?? []).forEach((_, index) => index === 0 && mutateAll(npc, ['features', index], FEATURE))
  for (const key of Object.keys(mechanics.abilities ?? {})) for (const value of [undefined, null, 0, 1, 30, 31, '15', 'x']) mutated(npc, ['abilities', key], value)
  for (const key of Object.keys(mechanics.skills ?? {}).slice(0, 2)) for (const value of [undefined, null, -21, 20, 21, '3']) mutated(npc, ['skills', key], value)
  if (mechanics.spellcasting) {
    mutateAll(npc, ['spellcasting'], SPELLCASTING)
    mechanics.spellcasting.spells.forEach((_, index) => (full || index === 0) && mutateAll(npc, ['spellcasting', 'spells', index], SPELL))
    if (mechanics.spellcasting.spells.length > 1) mutated(npc, ['spellcasting', 'spells', 1], clone(mechanics.spellcasting.spells[0]))
  }
  if (mechanics.legendary) {
    mutateAll(npc, ['legendary'], LEGENDARY)
    mechanics.legendary.actions.forEach((_, index) => mutateAll(npc, ['legendary', 'actions', index], LEGENDARY_ACTION))
  }
  ;(mechanics.special_actions ?? []).forEach((_, index) => mutateAll(npc, ['special_actions', index], SPECIAL_ACTION))
  if (mechanics.special_actions?.length) mutated(npc, ['special_actions', 1], clone(mechanics.special_actions[0]))
}

r.write('authored-npc.json')
