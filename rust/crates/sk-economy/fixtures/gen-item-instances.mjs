import '../../../fixtures-env.mjs'
// Эталоны `server/item-instances.mjs` для Rust-переноса (`sk-economy`):
// снимок каждой записи каталога, создание экземпляров с владельцем,
// происхождением и зарядами, приведение сохранённых экземпляров с
// недоверенными снимками (глубина, числа, картинки, эффекты) и сид-целые.
//
// Запуск: node rust/crates/sk-economy/fixtures/gen-item-instances.mjs
import { PROTOTYPE_KEYS, recorder, rng } from './record.mjs'
import { junkFactory } from './junk.mjs'

const url = (path) => new URL(`../../../../server/${path}`, import.meta.url).href
const I = await import(url('item-instances.mjs'))
const C = await import(url('item-catalog.mjs'))

const ALL_IDS = [...Object.keys(C.ITEM_CATALOG), ...Object.keys(C.SCENARIO_ITEM_CATALOG)]
const random = rng(20261016)
const J = junkFactory(random, ALL_IDS)
const { pick, int, chance } = J

const r = recorder('server/item-instances.mjs')
for (const name of ['ITEM_INSTANCE_SCHEMA_VERSION', 'ITEM_INSTANCE_ORIGIN_KINDS', 'ITEM_INSTANCE_OWNER_KINDS', 'MAX_ITEM_INSTANCE_QUANTITY',
  'MAX_ITEM_SNAPSHOT_NUMBER', 'MAX_ITEM_SNAPSHOT_WEIGHT', 'MAX_ITEM_INSTANCE_CHARGES']) r.constant(name, I[name])

for (const id of [...ALL_IDS, ...PROTOTYPE_KEYS, '', 'srd_5_2_1:unknown', undefined, null, 7, ['srd_5_2_1:dagger'], ' srd_5_2_1:dagger']) {
  r.call('itemInstanceSnapshot', I.itemInstanceSnapshot, id)
}

const OWNERS = [{ kind: 'enemy', actor_id: 'enemy-1' }, { kind: 'container', actorId: ' body-1 ' }, { kind: 'hero', actor_id: 'h' }, { kind: 'enemy' }, null, 'enemy', { kind: ' enemy ', actor_id: 'x'.repeat(130) }]
const ORIGINS = [{ kind: 'enemy_loadout', template_id: 'srd_5_2_1:bandit', source_id: 'encounter-1' }, { kind: 'looted', templateId: 't', sourceId: 's' }, { kind: 'made-up' }, { kind: ' stolen ' }, null, {}]
const created = []
for (const catalogId of [...ALL_IDS, ...PROTOTYPE_KEYS.slice(0, 4), 'srd_5_2_1:unknown']) {
  for (let variant = 0; variant < 3; variant += 1) {
    const input = { catalogId, instanceId: pick([`inst-${catalogId}-${variant}`, '', '  ', null, 'y'.repeat(170)]), owner: pick(OWNERS), origin: pick(ORIGINS) }
    if (variant === 0) {
      input.instanceId = `inst-${catalogId}`
      input.owner = OWNERS[0]
      input.origin = ORIGINS[0]
    }
    if (chance(0.5)) input.quantity = pick([1, 2, 999, 1_000, 0, -1, '3', 2.5, null])
    if (chance(0.4)) input.equipped = pick([true, false, 'true'])
    if (chance(0.4)) input.charges = pick([null, { current: 2, max: 5 }, { current: 99, max: 2_000 }, { max: 0 }, 'x', { current: -3, max: 3 }])
    if (chance(0.4)) input.lootable = pick([null, true, false, 'yes'])
    r.call('createItemInstance', I.createItemInstance, input)
    try {
      created.push(I.createItemInstance(input))
    } catch {
      // отказ уже записан
    }
  }
}
r.call('createItemInstance', I.createItemInstance, undefined)
r.call('createItemInstance', I.createItemInstance, {})

function snapshotJunk() {
  const snapshot = {}
  for (const key of ['catalog_id', 'catalog_schema_version', 'name', 'type', 'weight', 'description', 'base_price_cp', 'mechanics_status', 'rarity', 'combat',
    'passive_effects', 'spellcasting_focus', 'component_pouch', 'material_component', 'focus_mode', 'charges', 'recharge', 'requires_attunement', 'image', 'properties', 'secret']) {
    if (!chance(0.4)) continue
    snapshot[key] = {
      weight: pick([-1e9, 2, '3', 1e9, null, 'x', [4], 0.5]),
      base_price_cp: pick([1e15, -5, '40', 2.5, 300]),
      image: pick(['/assets/items/item-srd-5-2-1-dagger.png', '/generated/items/x.webp', '/assets/items/../../etc/passwd.png', '/generated/items/x.svg', 'javascript:alert(1)', '//evil.example/x.png', 7]),
      mechanics_status: pick(['verified', ' partial ', 'totally-verified', 'ruling-only', 3]),
      type: pick(['armor-of-my-choosing', 'Weapon', 'valuable', 4]),
      rarity: pick(['божественный', 'Редкий', 'сюжетный']),
      catalog_schema_version: pick([999, 'v1', true]),
      passive_effects: pick([[{ armor_class_bonus: 50 }, { schema_version: 1, effect_id: 'forged', group: 'forged', armor_class_bonus: 5_000 }], 'x', []]),
      spellcasting_focus: pick([['Wizard', 'wizard', '', 'cleric'], 'wizard', Array.from({ length: 20 }, (_, index) => `c${index}`)]),
      component_pouch: pick([true, 'true', 1]),
      material_component: pick([{ kind: 'Diamond', value_cp: 300, spell_ids: ['Revivify', 'revivify'] }, { kind: '', value_cp: 5 }, { kind: 'pearl', value_cp: 0 }, 'x', [1]]),
      focus_mode: pick(['HELD', 'worn', 'floating']),
      charges: pick([{ current: 1e9, max: 1e9 }, { current: 2, max: 3 }, { max: -1 }, 'x']),
      recharge: pick([{ schema_version: 1, trigger: 'dawn', formula: '1d6+1' }, { schema_version: 1, trigger: 'always', formula: '99d99' }]),
      combat: pick([{ kind: 'melee', armor: { base: 1e15 }, deep: { a: { b: { c: { d: { e: { f: 1 } } } } } } }, Array.from({ length: 70 }, (_, index) => index), { ' ': 1, 'ｋｅｙ': 'ｖａｌ', '１': 'индекс', [''.padStart(90, 'k')]: 2 }]),
    }[key] ?? J.junk(1)
  }
  return snapshot
}

for (const instance of created) {
  r.call('normalizeItemInstance', I.normalizeItemInstance, instance)
  if (chance(0.4)) {
    r.call('normalizeItemInstance', I.normalizeItemInstance, { ...instance, snapshot: { ...instance.snapshot, ...snapshotJunk() }, quantity: pick([0, 5_000, '7', null]) })
  }
}
for (let index = 0; index < 400; index += 1) {
  const source = {}
  if (chance(0.85)) source[pick(['item_instance_id', 'itemInstanceId'])] = pick([`i-${index}`, '', null, 'x'.repeat(170), 5])
  if (chance(0.85)) source[pick(['catalog_id', 'catalogId'])] = pick([...ALL_IDS.slice(0, 20), '', 'custom:x'])
  if (chance(0.8)) source.owner = pick(OWNERS)
  if (chance(0.8)) source.origin = pick(ORIGINS)
  if (chance(0.7)) source.snapshot = chance(0.8) ? snapshotJunk() : J.junk()
  if (chance(0.4)) source.quantity = J.atom()
  if (chance(0.3)) source.charges = J.charges()
  if (chance(0.3)) source.equipped = J.atom()
  if (chance(0.3)) source.lootable = J.atom()
  r.call('normalizeItemInstance', I.normalizeItemInstance, chance(0.95) ? source : J.junk())
}

for (let index = 0; index < 300; index += 1) {
  const minimum = pick([0, 1, 2, 5, 50, -3])
  const maximum = pick([0, 1, 4, 30, 99, 250, -1, 1_000_000])
  r.call('seededInteger', I.seededInteger, `seed-${index % 17}`, pick(['purse', 'thrown:srd_5_2_1:javelin', `consumable:${index}`, '']), minimum, maximum)
}
r.write('item-instances.json')
