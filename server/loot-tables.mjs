import { createHash } from 'node:crypto'

import {
  ITEM_LOOT_CATALOG_IDS,
  ITEM_MAGIC_LOOT_CATALOG_IDS,
  catalogItem,
  materializeCatalogItem,
} from './item-catalog.mjs'

export const ENCOUNTER_LOOT_POLICY_ID = 'encounter-loot-v2'
export const ENCOUNTER_MAGIC_LOOT_POLICY_ID = 'encounter-magic-loot-v1'

const PREFIX = 'srd_5_2_1:'
const id = (slug) => `${PREFIX}${slug}`

/**
 * **Порядок выдачи**, а не классификация вещи. Массивы упорядочены осознанно:
 * `chooseForTier` берёт первый подходящий по цене, а `rotated` вращает список
 * от идентификатора встречи, поэтому перестановка элементов меняет награду.
 *
 * Чем предмет является — записано в каталоге (`themes` в `item-catalog.mjs`).
 * Две таблицы держит вместе сторож в `test/enemy-loadouts.test.mjs`: каждый
 * предмет отсюда обязан нести соответствующую тему там.
 */
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

const MAGIC_LOOT_IDS = new Set(ITEM_MAGIC_LOOT_CATALOG_IDS)

/**
 * Порог редкости и шанс находки. Политика сервера, а не таблица SRD, и записана
 * так, чтобы её можно было прочитать целиком:
 *
 * - до 200 XP за встречу магии нет вовсе — иначе первая же стычка с крысами
 *   выдаёт кольцо, и прогресс перестаёт что-либо значить;
 * - `uncommon` открывается с 200 XP и выпадает примерно в четверти встреч;
 * - `rare` открывается с 700 XP и выпадает примерно в восьмой части.
 *
 * Больше одного магического предмета за встречу не выдаётся никогда.
 */
const MAGIC_LOOT_TIERS = Object.freeze([
  Object.freeze({ rarity: 'rare', minimumXp: 700, chance: 12 }),
  Object.freeze({ rarity: 'uncommon', minimumXp: 200, chance: 25 }),
])

function magicRarityOf(catalogId) {
  return String(catalogItem(catalogId)?.magic_item?.rarity ?? '')
}

/**
 * Находка выводится **детерминированно** из идентификатора встречи: тот же бой
 * после replay или падения даёт тот же предмет, а payload события всё равно
 * несёт материализованную вещь целиком, поэтому будущая версия каталога не
 * меняет старую награду.
 *
 * @param {{ encounterId?: string, totalXp?: number }} input
 * @returns {Array<Record<string, unknown>>} ноль или один предмет
 */
export function serverEncounterMagicLoot({ encounterId = '', totalXp = 0 } = {}) {
  const xp = Math.max(0, Number(totalXp) || 0)
  const digest = createHash('sha256').update(`magic-loot:${encounterId}`).digest('hex')
  const roll = Number.parseInt(digest.slice(0, 8), 16) % 100
  const tier = MAGIC_LOOT_TIERS.find((candidate) => xp >= candidate.minimumXp && roll < candidate.chance)
  if (!tier) return []
  const pool = [...MAGIC_LOOT_IDS].filter((catalogId) => magicRarityOf(catalogId) === tier.rarity).sort()
  if (!pool.length) return []
  const pick = Number.parseInt(digest.slice(8, 16), 16) % pool.length
  const catalogId = pool[pick]
  const item = catalogItem(catalogId)
  if (!item || !['verified', 'partial'].includes(item.mechanics_status)) {
    throw new Error(`Catalog item ${catalogId} is not mechanically eligible for magic loot`)
  }
  return [materializeCatalogItem(catalogId, { quantity: 1, equipped: false })]
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
