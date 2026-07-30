import { createHash } from 'node:crypto'

/**
 * Единая server-owned таблица предметной добычи. Все catalog_id существуют
 * в SRD_EQUIPMENT_CATALOG; генеративная модель содержимое находки не назначает.
 */
const LOOT_ITEMS = Object.freeze({
  torch: { catalog_id: 'srd_5_2_1:torch', name: 'Факел', type: 'tool' },
  rations: { catalog_id: 'srd_5_2_1:rations-one-day', name: 'Сухой паёк, 1 день', type: 'consumable' },
  rope: { catalog_id: 'srd_5_2_1:rope-hempen-50-feet', name: 'Пеньковая верёвка, 50 футов', type: 'tool' },
  arrows: { catalog_id: 'srd_5_2_1:arrows-20', name: 'Стрелы, 20 штук', type: 'other' },
  dagger: { catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', type: 'weapon' },
  shield: { catalog_id: 'srd_5_2_1:shield', name: 'Щит', type: 'armor' },
  leather: { catalog_id: 'srd_5_2_1:leather-armor', name: 'Кожаный доспех', type: 'armor' },
  longsword: { catalog_id: 'srd_5_2_1:longsword', name: 'Длинный меч', type: 'weapon' },
  potion: { catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье лечения', type: 'consumable' },
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
