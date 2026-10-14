import '../../../fixtures-env.mjs'
// Эталоны `server/item-catalog.mjs` для Rust-переноса (`sk-items`).
//
// Два файла: `item-catalog.json` — константы целиком (каталог SRD, каталог
// сценариев, списки каналов, профили брони) и функции по каждой записи
// каталога; `item-catalog-inventories.json` — сотни инвентарей из
// каталожных, самодельных и мусорных вещей через материализацию, hydration,
// подсказки проекции и счёт боеприпасов.
//
// Где JS на мусоре падает `TypeError` (свойство прототипа вместо записи при
// материализации, неитерируемый список свойств оружия), случай пишется под
// именем `<fn>~TypeError`: Rust сознательно не падает, тест сверяет его
// запасной исход.
//
// Запуск: node rust/crates/sk-items/fixtures/gen-item-catalog.mjs
import { PROTOTYPE_KEYS, recorder, rng } from './record.mjs'
import { junkFactory } from './junk.mjs'

const C = await import(new URL('../../../../server/item-catalog.mjs', import.meta.url).href)

const SRD_IDS = Object.keys(C.ITEM_CATALOG)
const ALL_IDS = [...SRD_IDS, ...Object.keys(C.SCENARIO_ITEM_CATALOG)]
const RULESETS = ['', 'dnd_5e_2014', 'srd_5_2_1', 'dnd_5e_2024']
const random = rng(20261014)
const J = junkFactory(random, ALL_IDS)

// ---------- item-catalog.json ----------

const r = recorder('server/item-catalog.mjs')
for (const name of [
  'ITEM_CATALOG_SCHEMA_VERSION', 'ITEM_CATALOG_SOURCE', 'ITEM_MECHANICS_STATUSES', 'ITEM_ORIGIN_KINDS',
  'DEFAULT_ITEM_ORIGIN_KIND', 'PRIVATE_ITEM_ORIGIN_KINDS', 'ITEM_ORIGIN_LABELS', 'ITEM_AVAILABILITY_CHANNELS',
  'ITEM_RECHARGE_SCHEMA_VERSION', 'AMMUNITION_CATALOG_BY_WEAPON', 'ITEM_CATALOG', 'SCENARIO_ITEM_CATALOG',
  'ITEM_SHOP_CATALOG_IDS', 'ITEM_MAGIC_LOOT_CATALOG_IDS', 'ITEM_LOOT_CATALOG_IDS', 'ITEM_CRAFTING_CATALOG_IDS',
  'SRD_EQUIPMENT_CATALOG', 'ITEM_ARMOR_PROFILES',
]) r.constant(name, C[name])

const LOOKUPS = [...ALL_IDS, ...PROTOTYPE_KEYS, '', ' srd_5_2_1:dagger', 'srd_5_2_1:DAGGER', 'custom:compass', undefined, null, 7, ['srd_5_2_1:dagger'], { id: 1 }, true]
for (const id of LOOKUPS) {
  r.call('catalogItem', C.catalogItem, id)
  r.call('catalogItemTruthy', (value) => Boolean(C.catalogItem(value)), id)
}
for (const channel of ['shop', 'loot', 'crafting', 'magic_loot', 'unknown', '', 'SHOP']) r.call('catalogIdsFor', C.catalogIdsFor, channel)

for (const id of [...ALL_IDS, ...PROTOTYPE_KEYS, '', 'custom:compass', 'srd_5_2_1:unknown']) {
  for (const rulesetId of RULESETS) {
    r.call('itemLifecycleProfile', C.itemLifecycleProfile, id, { rulesetId })
  }
  r.call('itemLifecycleProfile', C.itemLifecycleProfile, id, undefined)
  r.call('itemRechargeProfile', C.itemRechargeProfile, id)
  r.call('ammunitionBundleAmount', C.ammunitionBundleAmount, id)
}
for (const id of [...ALL_IDS, '', 'custom:compass', undefined, null, ['srd_5_2_1:longbow']]) {
  r.call('ammunitionCatalogIdForWeapon', C.ammunitionCatalogIdForWeapon, id)
}

// Запись каталога сама по себе — тоже вход `offHandWeaponAllowed`.
for (const entry of Object.values({ ...C.ITEM_CATALOG, ...C.SCENARIO_ITEM_CATALOG })) {
  r.call('offHandWeaponAllowed', C.offHandWeaponAllowed, entry)
}

for (let index = 0; index < 400; index += 1) {
  r.call('normalizeItemRechargeProfile', C.normalizeItemRechargeProfile, J.rechargeProfile())
}
for (const value of [undefined, null, 'stolen', ' stolen ', 'STOLEN', 'украдено', '', ...C.ITEM_ORIGIN_KINDS]) {
  r.call('normalizeItemOriginKind', C.normalizeItemOriginKind, value)
  r.call('normalizeItemOriginKind', C.normalizeItemOriginKind, value, 'gifted')
}
for (let index = 0; index < 200; index += 1) {
  r.call('normalizeItemOriginKind', C.normalizeItemOriginKind, J.junk(), J.pick(['gifted', 'found', 'unknown']))
}

// Материализация каждой записи: пустой экземпляр, поддельный и случайный.
for (const id of ALL_IDS) {
  r.call('materializeCatalogItem', C.materializeCatalogItem, id, undefined)
  r.call('materializeCatalogItem', C.materializeCatalogItem, id, {
    id: 'forged', quantity: 3, equipped: true, attuned_to: 'hero', name: '  Свой  ', weight: 999, type: 'consumable',
    base_price_cp: 1, combat: { kind: 'melee', damage: '99d99' }, rarity: 'сюжетный', charges: { current: 3, max: 999 },
    activated: true, secret: 'не переносить', origin: 'stolen', description: ' ', properties: 'Своё',
  })
  r.call('materializeCatalogItem', C.materializeCatalogItem, id, J.inventoryItem(0))
}
for (const instance of [null, [], 'строка', 7, true, { charges: 'много' }, { charges: { current: '4' } }, { charges: { current: 2.5 } }]) {
  r.call('materializeCatalogItem', C.materializeCatalogItem, 'srd_5_2_1:healers-kit', instance)
  r.call('materializeCatalogItem', C.materializeCatalogItem, 'custom:compass', instance)
}
r.write('item-catalog.json')

// ---------- item-catalog-inventories.json ----------

const inv = recorder('server/item-catalog.mjs')

function recordGuarded(rec, name, fn, ...args) {
  try {
    fn(...args)
  } catch (error) {
    if (error instanceof TypeError) {
      rec.cases.push({ fn: `${name}~TypeError`, args, result: null })
      return
    }
  }
  rec.call(name, fn, ...args)
}

const AMMO_IDS = ['srd_5_2_1:arrows-20', 'srd_5_2_1:bolts-20', 'srd_5_2_1:needles-50', 'srd_5_2_1:firearm-bullets-10', 'srd_5_2_1:sling-bullets-20']
let serial = 0
for (let inventory = 0; inventory < 300; inventory += 1) {
  const items = Array.from({ length: J.int(1, 6) }, () => J.inventoryItem(serial++, { prototypes: true }))
  // Колчаны отдельно: на них держится счёт выстрелов.
  if (J.chance(0.4)) {
    items.push({
      id: `quiver-${serial++}`,
      catalog_id: J.pick(AMMO_IDS),
      quantity: J.pick([1, 2, 3, 0, -1, '2', 2.5, null]),
      ...(J.chance(0.7) ? { charges: J.charges() } : {}),
    })
  }
  for (const item of items) {
    const rulesetId = J.pick(RULESETS)
    recordGuarded(inv, 'hydrateCatalogItem', C.hydrateCatalogItem, item)
    inv.call('itemViewerCapabilities', C.itemViewerCapabilities, item, { rulesetId })
    inv.call('ammunitionCapacity', C.ammunitionCapacity, item)
    inv.call('ammunitionShotsLeft', C.ammunitionShotsLeft, item)
    recordGuarded(inv, 'offHandWeaponAllowed', C.offHandWeaponAllowed, item)
  }
}
// Записи-подделки с `lifecycle`: offHand читает их как запись каталога.
for (let index = 0; index < 60; index += 1) {
  const forged = {
    lifecycle: J.pick([{ equippable: true }, true, 1, 'yes']),
    type: J.pick(['weapon', 'weapon', 'armor', null]),
    combat: J.pick([{ kind: 'melee' }, { kind: 'melee', twoHanded: true }, { kind: 'melee', properties: ['light'] }, { kind: 'ranged' }, null, { kind: 'melee', properties: 'light' }, { kind: 'melee', properties: 7 }]),
    weapon: J.pick([{ properties: ['light'] }, { properties: [['light']] }, { properties: null }, {}, { properties: { light: true } }, undefined]),
  }
  recordGuarded(inv, 'offHandWeaponAllowed', C.offHandWeaponAllowed, JSON.parse(JSON.stringify(forged)))
}
for (const value of [undefined, null, 0, '', 'srd_5_2_1:arrows-20', [], {}, true, 7]) {
  inv.call('ammunitionShotsLeft', C.ammunitionShotsLeft, value)
  inv.call('ammunitionCapacity', C.ammunitionCapacity, value)
  inv.call('itemViewerCapabilities', C.itemViewerCapabilities, value, undefined)
  recordGuarded(inv, 'hydrateCatalogItem', C.hydrateCatalogItem, value)
  inv.call('offHandWeaponAllowed', C.offHandWeaponAllowed, value)
}
for (const key of PROTOTYPE_KEYS) {
  recordGuarded(inv, 'hydrateCatalogItem', C.hydrateCatalogItem, { id: `proto-${key}`, catalog_id: key, quantity: 2 })
  recordGuarded(inv, 'materializeCatalogItem', C.materializeCatalogItem, key, { id: `proto-${key}`, quantity: 2 })
  inv.call('itemViewerCapabilities', C.itemViewerCapabilities, { id: `proto-${key}`, catalog_id: key }, { rulesetId: 'dnd_5e_2014' })
}
inv.write('item-catalog-inventories.json')
