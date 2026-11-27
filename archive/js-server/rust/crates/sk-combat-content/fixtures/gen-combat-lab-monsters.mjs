import '../../../fixtures-env.mjs'
// Эталон server/combat-lab-monsters.mjs для Rust:
//
//   node rust/crates/sk-combat-content/fixtures/gen-combat-lab-monsters.mjs
//
// Весь бестиарий 2014 (каталожная запись, враг движка на разных позициях и
// индексах, роли, режимы атак, ограничения) и сотни синтетических записей:
// реальные стат-блоки с подменёнными эффектами попадания, режимами,
// перезарядкой, мультиатакой, заклинаниями, защитами и скоростями.
import { readFileSync } from 'node:fs'

import * as m from '../../../../server/combat-lab-monsters.mjs'
import { encode, hash, mulberry32, writeFixture } from './common.mjs'

const random = mulberry32(84_2014)
const pick = (items) => items[Math.floor(random() * items.length)]
const clone = (value) => structuredClone(value)

const records = JSON.parse(readFileSync(new URL('../../../../data/compendia/dnd_5e_2014/monsters.json', import.meta.url), 'utf8')).monsters
const realOnHits = records.flatMap((record) => record.actions.map((action) => action.on_hit).filter(Boolean))

const ON_HITS = [
  ...realOnHits,
  null, 'x', [], {}, { condition: 'prone' }, { condition: 'prone', instead_of_damage: true }, { condition: 'grappled', max_grappled_targets: 1, escape_dc: 14 },
  { condition: 'restrained', escape: { dc: 12 }, duration_minutes: 1, repeat_save: 'end_of_turn' }, { on_failure: 'poisoned', save_ability: 'con', dc: 11 },
  { on_failure: { condition: 'paralyzed', duration: '1_minute', repeat_save: { timing: 'end_of_each_turn' } }, save: { ability: 'con', dc: 13 } },
  { on_failure: { condition: 'frightened', repeat_save: { timing: ['end_'] } } }, { condition: 'burning', damage: { expression: '1d10', type: 'fire' } },
  { duration: 'until-extinguished', damage_expression: '1d6', damage_type: 'fire' }, { duration_hours: 1, condition: 'poisoned' }, { duration_hours: 'x', condition: 'poisoned' },
  { duration_minutes: 'x', duration: 'rounds:2', condition: 'prone' }, { damage_expression: '2d6', save_ability: 'dex', save_success: 'half_damage', excluded_targets: ['construct', 'construct', ''] },
  { damage: { expression: '3d6', type: 'poison' }, save_dc: '12', half_on_save: 1, target_restrictions: ['non_undead', 'non_elf'], requires_target: 'humanoid', target_size_max: 'large' },
  { condition: 'poisoned', at_0_hp_from_poison: { condition: 'unconscious' }, target_restrictions: 'non_elf willing', duration: { rounds: 3 } },
  { condition: 'grappled', while_grappled: true, damage: [{ expression: '1d4' }] }, { condition: 7, escape_dc: 'x' }, { repeat_save: 'start_of_turn', condition: 'prone' },
]
const MODES = [['melee'], ['ranged'], ['melee', 'ranged'], ['ranged', 'melee'], ['thrown'], 'melee', [], ['melee', 'melee', 5], null]
const RECHARGES = [{ success: [5, 6] }, { success: '56', group: 'breaths' }, { success: [] }, { group: 7 }, null, { success: ['6'] }]
const DAMAGES = [
  [{ expression: '1d6+2', type: 'slashing' }], [{ expression: '2d8-1', type: 'piercing' }, { expression: '1d6', type: 'fire' }], [{ amount: 3, type: 'bludgeoning' }],
  [{ amount: 2.5 }], [], [{ expression: 'bad', type: 'cold' }, { expression: 'worse' }, { expression: '4d4', type: 'acid' }], 'x',
  [{ expression: '1d10', type: 'piercing' }, { expression: '2d6', type: 'poison' }, { expression: '1d4', type: 'acid' }],
]
const SPEEDS = [{ walk: 30 }, { walk: 0, fly: 60 }, { fly: 40, hover: true }, { walk: 30, climb: 30, swim: '20', burrow: 0, teleport: 10 }, { walk: 40 }, {}]
const DEFENSES = [[], ['Fire', ' COLD ', ''], [{ types: ['Bludgeoning', 'piercing', 'piercing', ''], condition: 'Nonmagical-Attacks', qualifier: ' Except-Silvered ' }], [{ types: [], condition: 'x' }, { types: ['acid'] }, 5, null, 'poison']]
const SEQUENCE_STEPS = [{ action_id: 'bite' }, { action_id: 'claw', count: 2 }, { action_id: 'claw', count: 2.5 }, { action_id: 'tail', count: -1 }, { action_id: 'bite', mode: 'ranged' }, { action_id: 'gore', count: 'x' }, { action_id: 5 }]

function mutate(source) {
  const record = clone(source)
  const actions = record.actions ?? []
  for (const action of actions) {
    if (action.kind !== 'weapon_attack') continue
    if (random() < 0.4) action.on_hit = clone(pick(ON_HITS))
    if (random() < 0.25) action.modes = clone(pick(MODES))
    if (random() < 0.2) action.recharge = clone(pick(RECHARGES))
    if (random() < 0.15) action.uses = pick([1, '3', null, 'x'])
    if (random() < 0.3) action.damage = clone(pick(DAMAGES))
    if (random() < 0.15) action.ranged_damage = pick(['1d4+1', 'bad', ''])
    if (random() < 0.2) action.range_ft = pick([{ normal: 30 }, { long: 120 }, null, 'x', { normal: 20, long: 60 }])
    if (random() < 0.15) action.reach_ft = pick([10, null, '15'])
    if (random() < 0.1) action.target = 'one_prone_creature'
    if (random() < 0.1) action.attack_type = pick(['spell', 'weapon'])
    if (random() < 0.15) action.id = pick(['dagger', 'Javelin', 'net', 'spear', 'bite'])
    if (random() < 0.1) delete action.name_ru
  }
  if (random() < 0.3) {
    actions.push({ id: 'multiattack', kind: 'multiattack', name_ru: pick(['Мультиатака', null]), sequences: Array.from({ length: Math.floor(random() * 3) }, () => Array.from({ length: 1 + Math.floor(random() * 3) }, () => clone(pick(SEQUENCE_STEPS)))), ...(random() < 0.3 ? { conditions: pick([[null, 'flying'], [false], ['x']]) } : {}) })
    record.actions = actions
  }
  if (random() < 0.15) actions.push({ id: 'special-roar', kind: 'special', name_ru: 'Рёв' })
  if (random() < 0.2) record.speed_ft = clone(pick(SPEEDS))
  if (random() < 0.2) record.damage_resistances = clone(pick(DEFENSES))
  if (random() < 0.15) record.damage_immunities = clone(pick(DEFENSES))
  if (random() < 0.1) record.damage_vulnerabilities = clone(pick(DEFENSES))
  if (random() < 0.15) record.condition_immunities = pick([['poisoned'], [], 'x'])
  if (random() < 0.15) record.bonus_actions = [...(record.bonus_actions ?? []), pick([{ id: 'aggressive', name_ru: 'Агрессивный' }, { id: 'nimble-escape' }, { id: 'leap' }])]
  if (random() < 0.1) record.traits = [...(record.traits ?? []), pick([{ id: 'pack-tactics' }, { id: 'false-appearance', name_ru: 'Ложный облик' }, { id: 'shapechanger' }])]
  if (random() < 0.1) record.habitats = pick([['forest', 'forest', '', null], [], ['cave']])
  if (random() < 0.1) record.xp = pick([10, 5000, '200'])
  if (random() < 0.1) record.challenge_rating = pick(['5', '1/8', 'x'])
  if (random() < 0.15) {
    record.spellcasting = {
      ability: pick(['int', 'wis', 'cha', undefined]),
      save_dc: pick([13, '12', undefined]),
      attack_modifier: pick([5, null, undefined]),
      caster_level: pick([3, null, undefined]),
      class: pick(['wizard', undefined]),
      spell_slots: [
        { level: 0, spells: [{ key: 'fire-bolt', name_ru: 'Огненный снаряд' }, { key: 'light' }] },
        { level: 1, slots: pick([4, '2', null]), spells: [{ key: 'magic-missile' }, { key: 'shield' }, { key: 'fire-bolt' }, { key: '' }] },
        { level: 3, slots: 2, spells: [{ key: 'fireball' }, { key: 'counterspell' }, { key: 'invented-spell', name_ru: '' }] },
      ],
      innate_spells: pick([undefined, [{ uses: 'at-will', spells: [{ key: 'mage-hand' }] }, { uses: 1, spells: [{ key: 'fireball' }, { key: 'misty-step', name_ru: 'Туманный шаг' }] }]]),
    }
    record.traits = [...(record.traits ?? []), { id: 'spellcasting', mechanics: { spellcasting_field: pick(['spellcasting', 'spellcasting.spell_slots']), components_required: ['verbal'], ...(random() < 0.5 ? { components_not_required: ['material'] } : {}) } }]
  }
  return record
}

function catalogCase(record) {
  const { statBlock, ...entry } = m.monsterCatalogEntry(record)
  return { entry, statBlock: hash(statBlock) }
}

const POSITIONS = [{ x: 5, y: 2 }, { x: '3', y: 1.5 }, null, { x: 'a' }]
const real = records.map((record, index) => {
  const enemy = m.enemyFrom2014(record, { x: 5, y: 2 }, 0)
  return {
    record: index,
    enemy,
    variants: POSITIONS.map((position, slot) => hash(m.enemyFrom2014(record, position, slot === 3 ? Number.NaN : slot))),
    catalog: catalogCase(record),
    roles: m.monsterRolesFor(record),
    modes: m.monsterAttackModesFor(record),
    limitations: m.monsterLimitationsFor(record),
  }
})

const synthetic = []
for (let round = 0; round < 6; round += 1) {
  for (const source of records) {
    const record = mutate(source)
    const position = pick(POSITIONS)
    const index = pick([0, 1, 2, 7])
    try {
      synthetic.push({
        record,
        position,
        index,
        enemy: hash(m.enemyFrom2014(record, position, index)),
        catalog: catalogCase(record),
        roles: m.monsterRolesFor(record),
        modes: m.monsterAttackModesFor(record),
        limitations: m.monsterLimitationsFor(record),
      })
    } catch {
      // JS упал на этой записи — случай не берётся в эталон.
    }
  }
}
const damages = ['1d6+2', '2d8-1', '10d10', '1d6 + 2', 'd6', '1D6', '', null, undefined, 5, '3d4+0', '12d6+15', '1d6+2x', ' 1d6']
const damageCases = damages.map((expression) => ({ expression: encode(expression), parsed: m.parseMonsterDamage(expression) ?? null }))

writeFixture(new URL('combat-lab-monsters.json', import.meta.url), {
  images: Object.entries(m.DND_2014_MONSTER_IMAGES),
  real,
  synthetic,
  damage: damageCases,
})
