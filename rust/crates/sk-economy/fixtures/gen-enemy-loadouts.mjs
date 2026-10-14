import '../../../fixtures-env.mjs'
// Эталоны `server/enemy-loadouts.mjs` для Rust-переноса (`sk-economy`):
// инвентарь каждого существа бестиария (SRD 5.2.1 и редакции 2014) на
// нескольких сидах и владельцах, стат-блоки с подменёнными действиями и
// заклинаниями, граница шаблона по всему каталогу и приведение сохранённых
// инвентарей.
//
// Стат-блок записывается только полями, которые читает модуль
// (`action_profiles`, `spellcasting`) и видом существа для проверок: JS
// получает тот же урезанный вход.
//
// Запуск: node rust/crates/sk-economy/fixtures/gen-enemy-loadouts.mjs
import { PROTOTYPE_KEYS, recorder, rng } from './record.mjs'
import { junkFactory } from './junk.mjs'

const url = (path) => new URL(`../../../../server/${path}`, import.meta.url).href
const E = await import(url('enemy-loadouts.mjs'))
const C = await import(url('item-catalog.mjs'))
const { SRD_5_2_1_MONSTER_ALLOWLIST } = await import(url('encounter-assembler.mjs'))
const { loadDndsu2014Content } = await import(url('dndsu-2014-content.mjs'))
const { enemyFrom2014 } = await import(url('combat-lab-monsters.mjs'))

const ALL_IDS = [...Object.keys(C.ITEM_CATALOG), ...Object.keys(C.SCENARIO_ITEM_CATALOG)]
const random = rng(20261017)
const J = junkFactory(random, ALL_IDS)
const { pick, int, chance } = J

const trim = (block) => ({
  ...(block.action_profiles === undefined ? {} : { action_profiles: block.action_profiles }),
  ...(block.spellcasting === undefined ? {} : { spellcasting: block.spellcasting }),
  ...(block.creature_type === undefined ? {} : { creature_type: block.creature_type }),
})

export const SRD_BLOCKS = Object.entries(SRD_5_2_1_MONSTER_ALLOWLIST).map(([statBlockId, block]) => [statBlockId, trim(block)])
const content = await loadDndsu2014Content()
export const CLASSIC_BLOCKS = content.monsters.map((record, index) => [record.id, trim(enemyFrom2014(record, { x: 0, y: 0 }, index))])

const r = recorder('server/enemy-loadouts.mjs')
for (const name of ['ENEMY_LOADOUT_SCHEMA_VERSION', 'ENEMY_LOADOUT_POLICY_ID', 'MAX_ENEMY_LOADOUT_ITEMS', 'MAX_ENEMY_PURSE_CP',
  'WEAPON_CATALOG_BY_ACTION', 'AMMUNITION_BY_WEAPON', 'ENEMY_LOADOUT_TEMPLATE_IDS']) r.constant(name, E[name])

const assertId = (catalogId, options) => E.assertEnemyLoadoutItem(catalogId, options).catalog_id
for (const catalogId of [...ALL_IDS, ...PROTOTYPE_KEYS, '', 'srd_5_2_1:not-a-thing']) {
  for (const options of [undefined, { verifiedOnly: true }, { allowSpellcastingComponent: true }, { verifiedOnly: true, allowSpellcastingComponent: true }]) {
    r.call('assertEnemyLoadoutItem', assertId, catalogId, options)
  }
  r.call('optionalEnemyLoadoutItem', (id) => E.optionalEnemyLoadoutItem(id)?.catalog_id ?? null, catalogId)
}

const loadouts = []
const record = (input) => {
  r.call('enemyLoadoutFor', E.enemyLoadoutFor, input)
  try {
    loadouts.push(E.enemyLoadoutFor(input))
  } catch {
    // отказ уже записан
  }
}

for (const [statBlockId, block] of SRD_BLOCKS) {
  for (let index = 0; index < 8; index += 1) {
    record({ statBlockId, block, ownerId: `${statBlockId}-${index}`, seed: `sweep-${index % 3}`, ...(chance(0.5) ? { sourceId: `encounter-proposal-${index}` } : {}) })
  }
}
for (const [statBlockId, block] of CLASSIC_BLOCKS) {
  for (let index = 0; index < 2; index += 1) {
    record({ statBlockId, block, ownerId: `enemy-${index}`, seed: `classic-${index}`, sourceId: 'encounter-proposal-classic' })
  }
}

const HUMANOIDS = SRD_BLOCKS.filter(([statBlockId]) => E.ENEMY_LOADOUT_TEMPLATE_IDS.includes(statBlockId))
const ACTION_IDS = [...Object.keys(E.WEAPON_CATALOG_BY_ACTION), 'bite', 'claw', 'constructor', 'toString', '__proto__', 'valueOf', '']
for (let index = 0; index < 250; index += 1) {
  const [statBlockId, base] = pick(HUMANOIDS)
  const block = structuredClone(base)
  if (chance(0.5)) block.action_profiles = Array.from({ length: int(0, 14) }, () => ({ id: pick(ACTION_IDS), kind: pick(['melee', 'ranged']) }))
  if (chance(0.3)) {
    block.spellcasting = pick([
      { ability: 'int', spells: [{ id: 'fire-bolt' }] },
      { component_pouch: false },
      { requires_component_pouch: false, spells: [] },
      { components_not_required: ['material'] },
      { spells: [{ id: 'x', components_not_required: ['material', 'verbal'] }] },
      { spells: [{ id: 'x', components_not_required: ['material'] }, { id: 'y' }] },
      'заклинатель',
      ['spells'],
    ])
  }
  const classic = chance(0.25)
  const id = classic ? `dnd_5e_2014:monster:${pick(['goblin', 'veteran', 'cultist', 'bandit', 'scout', 'acolyte', 'mage', 'constructor', ''])}` : pick([statBlockId, ` ${statBlockId} `, 'srd_5_2_1:wolf'])
  record({
    statBlockId: id,
    block,
    ownerId: pick([`owner-${index}`, '', '  ', null, 'o'.repeat(130)]),
    seed: pick([`seed-${index}`, undefined, null, 7, { a: 1 }]),
    ...(chance(0.4) ? { sourceId: pick(['src', null, 's'.repeat(170)]) } : {}),
  })
}
record(undefined)
record({ statBlockId: 'srd_5_2_1:bandit' })

for (const loadout of loadouts) {
  if (loadout.items.length && chance(0.7)) continue
  r.call('normalizeEnemyLoadout', E.normalizeEnemyLoadout, loadout)
}
for (const loadout of loadouts.filter((entry) => entry.items.length).slice(0, 150)) {
  r.call('normalizeEnemyLoadout', E.normalizeEnemyLoadout, loadout)
}
for (let index = 0; index < 150; index += 1) {
  const source = {}
  if (chance(0.7)) source[pick(['template_id', 'templateId'])] = pick(['srd_5_2_1:bandit', '', null, 7, '  t  '])
  if (chance(0.7)) source[pick(['purse_cp', 'purseCp'])] = pick([-50, 0, 25, 1e9, '40', 2.5, null])
  if (chance(0.7)) {
    const sample = pick(loadouts.filter((entry) => entry.items.length)) ?? { items: [] }
    source.items = pick([[...sample.items, { catalog_id: 'srd_5_2_1:scimitar' }], Array.from({ length: 15 }, () => pick(sample.items) ?? {}), 'нет', [J.junk()]])
  }
  r.call('normalizeEnemyLoadout', E.normalizeEnemyLoadout, chance(0.9) ? source : J.junk())
}
r.call('normalizeEnemyLoadout', E.normalizeEnemyLoadout, undefined)
r.write('enemy-loadouts.json')
