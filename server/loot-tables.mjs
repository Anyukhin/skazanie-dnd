import { createHash } from 'node:crypto'

import { ITEM_LOOT_CATALOG_IDS, materializeCatalogItem } from './item-catalog.mjs'

/**
 * Единая server-owned таблица предметной добычи. Все catalog_id существуют
 * в item catalog и явно разрешены для loot; генеративная модель содержимое
 * находки не назначает.
 */
const LOOT_IDS = new Set(ITEM_LOOT_CATALOG_IDS)
function lootItem(catalogId) {
  if (!LOOT_IDS.has(catalogId)) throw new Error(`Catalog item ${catalogId} is not loot-eligible`)
  return materializeCatalogItem(catalogId)
}

const LOOT_ITEMS = Object.freeze({
  torch: lootItem('srd_5_2_1:torch'),
  rations: lootItem('srd_5_2_1:rations-one-day'),
  rope: lootItem('srd_5_2_1:rope-hempen-50-feet'),
  arrows: lootItem('srd_5_2_1:arrows-20'),
  dagger: lootItem('srd_5_2_1:dagger'),
  shield: lootItem('srd_5_2_1:shield'),
  leather: lootItem('srd_5_2_1:leather-armor'),
  longsword: lootItem('srd_5_2_1:longsword'),
  potion: lootItem('srd_5_2_1:potion-of-healing'),
})

const LOOT_BY_THEME = Object.freeze({
  goblinoids: ['arrows', 'dagger', 'torch'],
  undead: ['torch', 'rope', 'dagger'],
  beasts: ['rations', 'rope', 'torch'],
  raiders: ['dagger', 'leather', 'arrows', 'shield'],
  warband: ['leather', 'shield', 'longsword', 'arrows'],
  vermin: ['rations', 'rope', 'torch'],
  ambush: ['dagger', 'arrows', 'rope'],
  crypt: ['dagger', 'rope', 'torch'],
  cave: ['rope', 'torch', 'rations'],
  wilderness: ['rations', 'rope', 'arrows'],
  generic: ['torch', 'rations', 'rope', 'dagger'],
})

const LOOT_POTIONS_BY_DIFFICULTY = Object.freeze({ easy: 0, medium: 1, hard: 2 })

export function serverEncounterLoot({ theme = 'generic', difficulty = 'medium', encounterId = '' } = {}) {
  const table = LOOT_BY_THEME[theme] ?? LOOT_BY_THEME.generic
  const offset = Number.parseInt(createHash('sha256').update(`loot:${theme}:${encounterId}`).digest('hex').slice(0, 8), 16)
  const flavour = LOOT_ITEMS[table[offset % table.length]]
  const potions = LOOT_POTIONS_BY_DIFFICULTY[difficulty] ?? 0
  return [
    ...(potions > 0 ? [{ ...LOOT_ITEMS.potion, quantity: potions }] : []),
    { ...flavour, quantity: 1 },
  ]
}
