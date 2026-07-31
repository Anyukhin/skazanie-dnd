import { createHash } from 'node:crypto'

import {
  ITEM_LOOT_CATALOG_IDS,
  catalogItem,
  materializeCatalogItem,
} from './item-catalog.mjs'

export const ENCOUNTER_LOOT_POLICY_ID = 'encounter-loot-v2'

const PREFIX = 'srd_5_2_1:'
const id = (slug) => `${PREFIX}${slug}`

export const LOOT_BY_THEME = Object.freeze({
  goblinoids: Object.freeze(['dagger', 'shortbow', 'arrows-20', 'javelin', 'shield', 'leather-armor', 'spear', 'torch', 'rations-one-day', 'chain-shirt'].map(id)),
  undead: Object.freeze(['mace', 'ring-mail', 'dagger', 'shortbow', 'arrows-20', 'shield', 'shortsword', 'torch', 'rope-hempen-50-feet'].map(id)),
  beasts: Object.freeze(['spear', 'javelin', 'shortbow', 'arrows-20', 'hide-armor', 'rope-hempen-50-feet', 'rations-one-day', 'healers-kit', 'torch', 'quarterstaff'].map(id)),
  raiders: Object.freeze(['dagger', 'handaxe', 'javelin', 'shortsword', 'light-crossbow', 'bolts-20', 'leather-armor', 'shield', 'rations-one-day', 'rope-hempen-50-feet', 'healers-kit', 'sickle', 'greataxe', 'chain-shirt'].map(id)),
  warband: Object.freeze(['battleaxe', 'chain-shirt', 'greataxe', 'shield', 'longsword', 'mace', 'ring-mail', 'spear', 'light-crossbow', 'bolts-20', 'healers-kit'].map(id)),
  vermin: Object.freeze(['club', 'dagger', 'sling', 'sling-bullets-20', 'torch', 'rations-one-day', 'rope-hempen-50-feet'].map(id)),
  ambush: Object.freeze(['dagger', 'dart', 'shortbow', 'arrows-20', 'light-crossbow', 'bolts-20', 'shortsword', 'leather-armor', 'rope-hempen-50-feet', 'healers-kit'].map(id)),
  crypt: Object.freeze(['mace', 'ring-mail', 'dagger', 'rope-hempen-50-feet', 'torch', 'shortbow', 'arrows-20', 'shield', 'shortsword'].map(id)),
  cave: Object.freeze(['club', 'greatclub', 'spear', 'javelin', 'war-pick', 'sling', 'sling-bullets-20', 'torch', 'rope-hempen-50-feet', 'rations-one-day', 'hide-armor', 'chain-shirt'].map(id)),
  wilderness: Object.freeze(['rations-one-day', 'rope-hempen-50-feet', 'torch', 'shortbow', 'arrows-20', 'spear', 'javelin', 'handaxe', 'dagger', 'healers-kit', 'hide-armor', 'quarterstaff', 'sickle'].map(id)),
  generic: Object.freeze(['rations-one-day', 'rope-hempen-50-feet', 'torch', 'dart', 'ring-mail', 'sling', 'dagger', 'arrows-20', 'club', 'chain-shirt', 'bolts-20', 'battleaxe', 'handaxe', 'healers-kit', 'hide-armor', 'javelin', 'leather-armor', 'light-crossbow', 'longsword', 'mace', 'quarterstaff', 'shield', 'shortbow', 'shortsword', 'sickle', 'sling-bullets-20', 'spear', 'war-pick', 'greataxe', 'greatclub'].map(id)),
})

const LOOT_IDS = new Set(ITEM_LOOT_CATALOG_IDS)
const DIFFICULTY_STACKS = Object.freeze({ easy: 1, medium: 2, hard: 3 })
const PRICE_TIERS = Object.freeze([
  Object.freeze({ minimum: 0, maximum: 500 }),
  Object.freeze({ minimum: 501, maximum: 2_500 }),
  Object.freeze({ minimum: 2_501, maximum: 7_500 }),
])
const AMMUNITION_PACKAGES = new Set([id('arrows-20'), id('bolts-20'), id('sling-bullets-20')])
const SUPPLY_QUANTITY = Object.freeze({ easy: 1, medium: 2, hard: 3 })
const AMMUNITION_QUANTITY = Object.freeze({ easy: 1, medium: 1, hard: 2 })

function offsetFor(theme, encounterId, length) {
  const digest = createHash('sha256').update(`loot:${theme}:${encounterId}`).digest('hex')
  return Number.parseInt(digest.slice(0, 8), 16) % length
}

function rotated(values, offset) {
  return [...values.slice(offset), ...values.slice(0, offset)]
}

function quantityFor(catalogId, difficulty) {
  if (catalogId === id('torch') || catalogId === id('rations-one-day')) return SUPPLY_QUANTITY[difficulty]
  if (AMMUNITION_PACKAGES.has(catalogId)) return AMMUNITION_QUANTITY[difficulty]
  return 1
}

function priceInTier(catalogId, tier) {
  const price = catalogItem(catalogId)?.base_price_cp
  return Number.isSafeInteger(price) && price >= tier.minimum && price <= tier.maximum
}

function chooseForTier(pool, tierIndex, used) {
  for (let fallback = tierIndex; fallback >= 0; fallback -= 1) {
    const found = pool.find((catalogId) => !used.has(catalogId) && priceInTier(catalogId, PRICE_TIERS[fallback]))
    if (found) return found
  }
  return null
}

export function serverEncounterLoot({ theme = 'generic', difficulty = 'medium', encounterId = '' } = {}) {
  const selectedTheme = Object.hasOwn(LOOT_BY_THEME, theme) ? theme : 'generic'
  const selectedDifficulty = Object.hasOwn(DIFFICULTY_STACKS, difficulty) ? difficulty : 'medium'
  const sourcePool = LOOT_BY_THEME[selectedTheme]
  const pool = rotated(sourcePool, offsetFor(selectedTheme, encounterId, sourcePool.length))
  const used = new Set()
  const result = []
  for (let tierIndex = 0; tierIndex < DIFFICULTY_STACKS[selectedDifficulty]; tierIndex += 1) {
    const catalogId = chooseForTier(pool, tierIndex, used)
    if (!catalogId) break
    if (!LOOT_IDS.has(catalogId)) throw new Error(`Catalog item ${catalogId} is not loot-eligible`)
    const item = catalogItem(catalogId)
    if (!item || !['verified', 'partial'].includes(item.mechanics_status)) {
      throw new Error(`Catalog item ${catalogId} is not mechanically eligible for encounter loot`)
    }
    used.add(catalogId)
    result.push(materializeCatalogItem(catalogId, {
      quantity: quantityFor(catalogId, selectedDifficulty),
      equipped: false,
    }))
  }
  return result
}
