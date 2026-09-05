import { catalogItem, ITEM_CATALOG, materializeCatalogItem } from './item-catalog.mjs'
import { PHB_2014_TOOL_CATALOG } from './character-creation-class-options.mjs'

/**
 * Альтернатива классовому стартовому снаряжению из PHB 2014: игрок получает
 * подтверждённый бросок денег и покупает обычные предметы за него. Модуль не
 * бросает кости, не выдаёт магические предметы и не заменяет item catalog.
 */

export const PHB_STARTING_WEALTH = Object.freeze({
  barbarian: Object.freeze({ expression: '2d4', multiplier: 10 }),
  bard: Object.freeze({ expression: '5d4', multiplier: 10 }),
  cleric: Object.freeze({ expression: '5d4', multiplier: 10 }),
  druid: Object.freeze({ expression: '2d4', multiplier: 10 }),
  fighter: Object.freeze({ expression: '5d4', multiplier: 10 }),
  monk: Object.freeze({ expression: '5d4', multiplier: 1 }),
  paladin: Object.freeze({ expression: '5d4', multiplier: 10 }),
  ranger: Object.freeze({ expression: '5d4', multiplier: 10 }),
  rogue: Object.freeze({ expression: '4d4', multiplier: 10 }),
  sorcerer: Object.freeze({ expression: '3d4', multiplier: 10 }),
  warlock: Object.freeze({ expression: '4d4', multiplier: 10 }),
  wizard: Object.freeze({ expression: '4d4', multiplier: 10 }),
})

export const PHB_STARTING_WEALTH_PROVENANCE = Object.freeze({
  ruleset_id: 'dnd_5e_2014',
  source_book: "Player's Handbook (2014)",
  source_url: 'https://www.dndbeyond.com/sources/dnd/basic-rules-2014/equipment',
  secondary_source_url: 'https://www.dnd.su/articles/inventory/98-equipment/',
})

// Стоимость игровых и музыкальных инструментов в медных монетах. Транспорт
// намеренно отсутствует: PHB отмечает его цену как зависящую от конкретного
// средства, поэтому без цены его нельзя безопасно продавать через этот API.
const PHB_TOOL_PRICES_CP = Object.freeze({
  alchemists_supplies: 5_000, brewers_supplies: 2_000, calligraphers_supplies: 1_000,
  carpenters_tools: 800, cartographers_tools: 1_500, cobblers_tools: 500,
  cooks_utensils: 100, glassblowers_tools: 3_000, jewelers_tools: 2_500,
  leatherworkers_tools: 500, masons_tools: 1_000, painters_supplies: 1_000,
  potters_tools: 1_000, smiths_tools: 2_000, tinkers_tools: 5_000,
  weavers_tools: 100, woodcarvers_tools: 100,
  bagpipes: 3_000, drum: 600, dulcimer: 2_500, flute: 200, lute: 3_500,
  lyre: 3_000, horn: 300, pan_flute: 1_200, shawm: 200, viol: 3_000,
  dice_set: 10, dragonchess: 100, playing_cards: 50, three_dragon_ante: 100,
  disguise_kit: 2_500, forgery_kit: 1_500, herbalism_kit: 500,
  navigators_tools: 2_500, poisoners_kit: 5_000, thieves_tools: 2_500,
})

// В текущем сценовом каталоге пеньковая верёвка имеет вес из другого
// профильного набора. Для покупки по PHB 2014 сохраняем его цену, но
// исправляем вес 50-футовой верёвки до 10 фунтов.
const PHB_CATALOG_OVERRIDES = Object.freeze({
  'srd_5_2_1:rope-hempen-50-feet': Object.freeze({ price_cp: 100, weight: 10 }),
})

// Позиции таблиц Arcane/Druidic Focus, Holy Symbol, Adventuring Gear и
// Equipment Packs из Basic Rules 2014, которых нет в небольшом сценовом
// item-catalog. Цена хранится в cp, вес — в фунтах; тире в исходной таблице
// означает нулевой вес, а не неизвестное значение. Транспорт и животные с
// переменной ценой сюда не включены: они принадлежат отдельному owned_assets.
const PHB_MISSING_EQUIPMENT = Object.freeze([
  // Arcane Focus
  { id: 'crystal', name: 'Кристалл', type: 'focus', price_cp: 1_000, weight: 1 },
  { id: 'orb', name: 'Сфера', type: 'focus', price_cp: 2_000, weight: 3 },
  { id: 'rod', name: 'Жезл', type: 'focus', price_cp: 1_000, weight: 2 },
  { id: 'staff', name: 'Посох', type: 'focus', price_cp: 500, weight: 4 },
  { id: 'wand', name: 'Волшебная палочка', type: 'focus', price_cp: 1_000, weight: 1 },
  // Druidic Focus
  { id: 'sprig-of-mistletoe', name: 'Веточка омелы', type: 'focus', price_cp: 100, weight: 0 },
  { id: 'totem', name: 'Тотем', type: 'focus', price_cp: 100, weight: 0 },
  { id: 'wooden-staff', name: 'Деревянный посох', type: 'focus', price_cp: 500, weight: 4 },
  { id: 'yew-wand', name: 'Тисовая палочка', type: 'focus', price_cp: 1_000, weight: 1 },
  // Holy Symbol
  { id: 'amulet', name: 'Амулет', type: 'focus', price_cp: 500, weight: 1 },
  { id: 'emblem', name: 'Эмблема', type: 'focus', price_cp: 500, weight: 0 },
  { id: 'reliquary', name: 'Реликварий', type: 'focus', price_cp: 500, weight: 2 },
  // Other Adventuring Gear
  { id: 'abacus', name: 'Абак', type: 'other', price_cp: 200, weight: 2 },
  { id: 'barrel', name: 'Бочка', type: 'other', price_cp: 200, weight: 70 },
  { id: 'basket', name: 'Корзина', type: 'other', price_cp: 40, weight: 2 },
  { id: 'bell', name: 'Колокольчик', type: 'other', price_cp: 100, weight: 0 },
  { id: 'blanket', name: 'Одеяло', type: 'other', price_cp: 50, weight: 3 },
  { id: 'block-and-tackle', name: 'Блок и лебёдка', type: 'other', price_cp: 100, weight: 5 },
  { id: 'book', name: 'Книга', type: 'book', price_cp: 2_500, weight: 5 },
  { id: 'bottle-glass', name: 'Бутылка, стеклянная', type: 'other', price_cp: 200, weight: 2 },
  { id: 'bucket', name: 'Ведро', type: 'other', price_cp: 5, weight: 2 },
  { id: 'candle', name: 'Свеча', type: 'other', price_cp: 1, weight: 0 },
  { id: 'case-crossbow-bolt', name: 'Футляр для арбалетных болтов', type: 'container', price_cp: 100, weight: 1 },
  { id: 'case-map-or-scroll', name: 'Футляр для карты или свитка', type: 'container', price_cp: 100, weight: 1 },
  { id: 'chain-10-feet', name: 'Цепь, 10 футов', type: 'other', price_cp: 500, weight: 10 },
  { id: 'chalk', name: 'Мел', type: 'other', price_cp: 1, weight: 0 },
  { id: 'chest', name: 'Сундук', type: 'container', price_cp: 500, weight: 25 },
  { id: 'clothes-common', name: 'Обычная одежда', type: 'clothing', price_cp: 50, weight: 3 },
  { id: 'clothes-costume', name: 'Костюм', type: 'clothing', price_cp: 500, weight: 4 },
  { id: 'clothes-fine', name: 'Парадная одежда', type: 'clothing', price_cp: 1_500, weight: 6 },
  { id: 'clothes-travelers', name: 'Дорожная одежда', type: 'clothing', price_cp: 200, weight: 4 },
  { id: 'component-pouch', name: 'Мешочек с компонентами', type: 'focus', price_cp: 2_500, weight: 2 },
  { id: 'fishing-tackle', name: 'Рыболовные снасти', type: 'other', price_cp: 100, weight: 4 },
  { id: 'flask-or-tankard', name: 'Фляга или кружка', type: 'other', price_cp: 2, weight: 1 },
  { id: 'hammer', name: 'Молоток', type: 'tool', price_cp: 100, weight: 3 },
  { id: 'hammer-sledge', name: 'Кувалда', type: 'tool', price_cp: 200, weight: 10 },
  { id: 'hourglass', name: 'Песочные часы', type: 'other', price_cp: 2_500, weight: 1 },
  { id: 'ink', name: 'Чернила, флакон', type: 'other', price_cp: 1_000, weight: 0 },
  { id: 'ink-pen', name: 'Перо', type: 'other', price_cp: 2, weight: 0 },
  { id: 'jug-or-pitcher', name: 'Кувшин или кружка', type: 'other', price_cp: 2, weight: 4 },
  { id: 'ladder-10-feet', name: 'Лестница, 10 футов', type: 'other', price_cp: 10, weight: 25 },
  { id: 'lamp', name: 'Лампа', type: 'other', price_cp: 50, weight: 1 },
  { id: 'lantern-bullseye', name: 'Фонарь, направленный', type: 'other', price_cp: 1_000, weight: 2 },
  { id: 'lock', name: 'Замок', type: 'other', price_cp: 1_000, weight: 1 },
  { id: 'magnifying-glass', name: 'Увеличительное стекло', type: 'other', price_cp: 10_000, weight: 0 },
  { id: 'mess-kit', name: 'Кухонная утварь', type: 'other', price_cp: 20, weight: 1 },
  { id: 'mirror-steel', name: 'Зеркало, стальное', type: 'other', price_cp: 500, weight: 0.5 },
  { id: 'paper', name: 'Бумага, лист', type: 'other', price_cp: 20, weight: 0 },
  { id: 'parchment', name: 'Пергамент, лист', type: 'other', price_cp: 10, weight: 0 },
  { id: 'perfume', name: 'Духи, флакон', type: 'other', price_cp: 500, weight: 0 },
  { id: 'miners-pick', name: 'Кирка шахтёра', type: 'tool', price_cp: 200, weight: 10 },
  { id: 'piton', name: 'Питон', type: 'other', price_cp: 5, weight: 0.25 },
  { id: 'pole-10-feet', name: 'Шест, 10 футов', type: 'other', price_cp: 5, weight: 7 },
  { id: 'pot-iron', name: 'Горшок, железный', type: 'other', price_cp: 200, weight: 10 },
  { id: 'pouch', name: 'Поясной кошель', type: 'container', price_cp: 50, weight: 1 },
  { id: 'quiver', name: 'Колчан', type: 'container', price_cp: 100, weight: 1 },
  { id: 'ram-portable', name: 'Таран, переносной', type: 'other', price_cp: 400, weight: 35 },
  { id: 'robes', name: 'Одеяния', type: 'clothing', price_cp: 100, weight: 4 },
  { id: 'rope-silk-50-feet', name: 'Верёвка, шёлковая, 50 футов', type: 'other', price_cp: 1_000, weight: 5 },
  { id: 'sack', name: 'Мешок', type: 'container', price_cp: 1, weight: 0.5 },
  { id: 'scale-merchants', name: 'Весы, торговые', type: 'other', price_cp: 500, weight: 3 },
  { id: 'sealing-wax', name: 'Воск', type: 'other', price_cp: 50, weight: 0 },
  { id: 'shovel', name: 'Лопата', type: 'tool', price_cp: 200, weight: 5 },
  { id: 'signet-ring', name: 'Перстень с печаткой', type: 'jewelry', price_cp: 500, weight: 0 },
  { id: 'soap', name: 'Мыло', type: 'other', price_cp: 2, weight: 0 },
  { id: 'spellbook', name: 'Книга заклинаний', type: 'book', price_cp: 5_000, weight: 3 },
  { id: 'spikes-iron-10', name: 'Железные скобы, 10 штук', type: 'other', price_cp: 100, weight: 5 },
  { id: 'spyglass', name: 'Подзорная труба', type: 'other', price_cp: 100_000, weight: 1 },
  { id: 'tent-two-person', name: 'Палатка, двухместная', type: 'other', price_cp: 200, weight: 20 },
  { id: 'tinderbox', name: 'Огниво', type: 'other', price_cp: 50, weight: 1 },
  { id: 'vial', name: 'Флакон', type: 'other', price_cp: 100, weight: 0 },
  { id: 'whetstone', name: 'Точильный камень', type: 'other', price_cp: 1, weight: 1 },
  // Equipment Packs. Вес рассчитан по содержимому PHB; это один покупаемый
  // комплект и не превращает покупку в несколько несвязанных инстансов.
  { id: 'burglars-pack', name: 'Набор взломщика', type: 'pack', price_cp: 1_600, weight: 57.5 },
  { id: 'diplomats-pack', name: 'Набор дипломата', type: 'pack', price_cp: 3_900, weight: 35 },
  { id: 'dungeoneers-pack', name: 'Набор исследователя подземелий', type: 'pack', price_cp: 1_200, weight: 56.5 },
  { id: 'entertainers-pack', name: 'Набор артиста', type: 'pack', price_cp: 4_000, weight: 38 },
  { id: 'priests-pack', name: 'Набор священника', type: 'pack', price_cp: 1_900, weight: 24 },
  { id: 'scholars-pack', name: 'Набор учёного', type: 'pack', price_cp: 4_000, weight: 12 },
  // В таблице оружия PHB 2014 есть сеть; в сценовом catalog её пока нет.
  { id: 'net', name: 'Сеть', type: 'weapon', price_cp: 100, weight: 3 },
])

const WEALTH_CLASS_IDS = Object.freeze(Object.keys(PHB_STARTING_WEALTH))
const WEALTH_CLASS_SET = new Set(WEALTH_CLASS_IDS)

function isMagicItem(entry) {
  if (entry?.catalog_id === 'srd_5_2_1:potion-of-healing') return false
  return Boolean(entry?.magic_item) || entry?.rarity != null
}

function priceCp(entry) {
  const value = Number(entry?.price_cp ?? entry?.base_price_cp)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function weight(entry) {
  const value = Number(entry?.weight)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function catalogPurchaseEntry(catalogId, entry) {
  const override = PHB_CATALOG_OVERRIDES[catalogId] ?? {}
  const price = override.price_cp ?? priceCp(entry)
  const itemWeight = override.weight ?? weight(entry)
  if (!catalogId || !entry || isMagicItem(entry) || price == null || itemWeight == null) return null
  return {
    id: catalogId,
    catalog_id: catalogId,
    name: String(entry.name ?? entry.display_name ?? catalogId),
    type: String(entry.type ?? entry.category ?? 'other'),
    price_cp: price,
    weight: itemWeight,
    source: 'item_catalog',
    mechanics_status: String(entry.mechanics_status ?? 'partial'),
  }
}

function toolCatalogId(toolId) {
  const id = String(toolId).replaceAll('_', '-')
  return `srd_5_2_1:${id}`
}

function supplementalToolEntry(tool) {
  const price = PHB_TOOL_PRICES_CP[tool.id]
  if (!Number.isSafeInteger(price) || price <= 0 || !Number.isFinite(Number(tool.weight))) return null
  const knownCatalogId = toolCatalogId(tool.id)
  const known = catalogItem(knownCatalogId)
  if (known && !isMagicItem(known)) return catalogPurchaseEntry(knownCatalogId, known)
  const catalogId = `phb_2014:tool:${tool.id}`
  return {
    id: tool.id,
    catalog_id: catalogId,
    name: String(tool.label),
    type: 'tool',
    price_cp: price,
    weight: Number(tool.weight),
    source: 'phb_2014_tool_catalog',
    mechanics_status: 'partial',
  }
}

function buildPurchaseCatalog() {
  const entries = []
  for (const [catalogId, entry] of Object.entries(ITEM_CATALOG)) {
    const purchase = catalogPurchaseEntry(catalogId, entry)
    if (purchase) entries.push(purchase)
  }
  const existingIds = new Set(entries.map((entry) => entry.catalog_id))
  for (const tool of PHB_2014_TOOL_CATALOG) {
    const purchase = supplementalToolEntry(tool)
    if (purchase && !existingIds.has(purchase.catalog_id) && !entries.some((entry) => entry.id === purchase.id)) entries.push(purchase)
  }
  for (const item of PHB_MISSING_EQUIPMENT) {
    const catalogId = `phb_2014:equipment:${item.id}`
    if (existingIds.has(catalogId) || entries.some((entry) => entry.id === item.id)) continue
    entries.push({
      ...structuredClone(item),
      catalog_id: catalogId,
      source: 'phb_2014_equipment_table',
      mechanics_status: 'partial',
    })
  }
  // Животные и транспорт принадлежат герою, но не лежат в его рюкзаке.
  for (const [id, name, price, speed, capacity] of [
    ['camel', 'Верблюд', 50, 50, 480], ['mule', 'Мул или осёл', 8, 40, 420], ['elephant', 'Слон', 200, 40, 1320],
    ['draft-horse', 'Тягловая лошадь', 50, 40, 540], ['riding-horse', 'Верховая лошадь', 75, 60, 480],
    ['mastiff', 'Мастифф', 25, 40, 195], ['pony', 'Пони', 30, 40, 225], ['warhorse', 'Боевой конь', 400, 60, 540],
  ]) entries.push({ id: `mount:${id}`, name, type: 'mount', price_cp: price * 100, weight: null, speed_feet: speed, carrying_capacity_lb: capacity, owned_asset: true, mechanics_status: 'partial' })
  for (const [id, name, price, weight] of [
    ['carriage', 'Карета', 100, 600], ['cart', 'Повозка', 15, 200], ['chariot', 'Колесница', 250, 100], ['sled', 'Сани', 20, 300], ['wagon', 'Фургон', 35, 400],
    ['galley', 'Галера', 30000, null], ['keelboat', 'Килевая лодка', 3000, null], ['longship', 'Драккар', 10000, null], ['rowboat', 'Вёсельная лодка', 50, 100], ['sailing-ship', 'Парусник', 10000, null], ['warship', 'Военный корабль', 25000, null],
  ]) entries.push({ id: `vehicle:${id}`, name, type: 'vehicle', price_cp: price * 100, weight, owned_asset: true, mechanics_status: 'partial' })
  for (const [id, name, price_cp, weight] of [
    ['bit-bridle', 'Удила и уздечка', 200, 1], ['animal-feed', 'Корм на один день', 5, 10], ['saddlebags', 'Седельные сумки', 400, 8],
    ['saddle-pack', 'Вьючное седло', 500, 15], ['saddle-riding', 'Ездовое седло', 1000, 25], ['saddle-military', 'Военное седло', 2000, 30], ['saddle-exotic', 'Экзотическое седло', 6000, 40],
  ]) if (!entries.some((entry) => entry.id === id || entry.name === name)) entries.push({ id, catalog_id: `phb_2014:equipment:${id}`, name, type: 'other', price_cp, weight, mechanics_status: 'partial' })
  for (const entry of [...entries]) {
    const known = catalogItem(entry.catalog_id)
    if (known?.armor && known.armor.category !== 'shield') entries.push({ id: `barding:${entry.id}`, catalog_id: `phb_2014:barding:${entry.id}`, name: `Доспех животного: ${entry.name}`, type: 'other', price_cp: entry.price_cp * 4, weight: entry.weight * 2, mechanics_status: 'partial' })
  }
  entries.sort((left, right) => left.id.localeCompare(right.id))
  for (const entry of entries) {
    if (!entry.name || !Number.isSafeInteger(entry.price_cp) || entry.price_cp <= 0 || (!entry.owned_asset && !Number.isFinite(entry.weight))) {
      throw new TypeError(`Некорректный предмет в каталоге покупки: ${entry.id}`)
    }
  }
  return Object.freeze(entries.map((entry) => Object.freeze(entry)))
}

const PURCHASE_CATALOG = buildPurchaseCatalog()
const PURCHASE_BY_ID = new Map(PURCHASE_CATALOG.flatMap((entry) => [
  [entry.id, entry],
  [entry.catalog_id, entry],
]))
for (const tool of PHB_2014_TOOL_CATALOG) {
  const knownCatalogId = toolCatalogId(tool.id)
  const entry = PURCHASE_BY_ID.get(knownCatalogId)
  if (entry && !PURCHASE_BY_ID.has(tool.id)) PURCHASE_BY_ID.set(tool.id, entry)
}

export function startingPurchaseCatalog() {
  return structuredClone(PURCHASE_CATALOG)
}

function classIdFor(value) {
  const id = String(value ?? '').trim().toLocaleLowerCase('en')
  return WEALTH_CLASS_SET.has(id) ? id : null
}

function error(code, reason) {
  return { ok: false, code, reason, errors: [reason] }
}

function confirmedWealth(classId, wealthRoll) {
  if (!wealthRoll || typeof wealthRoll !== 'object' || Array.isArray(wealthRoll)) return error('WEALTH_ROLL_INVALID', 'Подтверждённое богатство должно быть объектом')
  if (String(wealthRoll.class_id ?? '').trim().toLocaleLowerCase('en') !== classId) return error('WEALTH_CLASS_MISMATCH', 'Бросок богатства принадлежит другому классу')
  const totalGp = Number(wealthRoll.total_gp)
  if (!Number.isSafeInteger(totalGp) || totalGp < 0) return error('WEALTH_TOTAL_INVALID', 'total_gp должен быть неотрицательным целым числом')
  const id = String(wealthRoll.id ?? '').trim()
  if (!id) return error('WEALTH_ROLL_ID_REQUIRED', 'У подтверждённого броска богатства должен быть id')
  return { ok: true, id, total_gp: totalGp, total_cp: totalGp * 100 }
}

function remainingCurrency(totalCp) {
  const gold = Math.floor(totalCp / 100)
  const afterGold = totalCp % 100
  const silver = Math.floor(afterGold / 10)
  const copper = afterGold % 10
  return {
    total_cp: totalCp,
    total_gp: totalCp / 100,
    gold,
    silver,
    copper,
  }
}

function instanceId(wealthRollId, index) {
  const safe = wealthRollId.replace(/[^a-z0-9_-]+/giu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || 'roll'
  return `starting-wealth-${safe}-${index + 1}`.slice(0, 120)
}

function materializePurchase(entry, quantity, wealthRollId, index) {
  const id = instanceId(wealthRollId, index)
  const known = entry.catalog_id?.startsWith('srd_5_2_1:') ? catalogItem(entry.catalog_id) : null
  if (known && !isMagicItem(known)) {
    const materialized = materializeCatalogItem(entry.catalog_id, { id, quantity, equipped: false })
    const override = PHB_CATALOG_OVERRIDES[entry.catalog_id]
    return {
      ...materialized,
      price_cp: entry.price_cp,
      ...(override ? { weight: override.weight, base_price_cp: override.price_cp } : {}),
    }
  }
  return {
    id,
    catalog_id: entry.catalog_id,
    name: entry.name,
    type: entry.type,
    quantity,
    weight: entry.weight,
    price_cp: entry.price_cp,
    description: 'Обычный предмет PHB 2014, добавленный покупкой за стартовое богатство.',
    properties: 'Механическое применение определяется базовыми правилами предмета.',
    mechanics_status: entry.mechanics_status,
    source: entry.source,
    sellable: true,
    equipped: false,
  }
}

/**
 * Проверяет уже подтверждённый сервером бросок денег и атомарно считает
 * покупки. При недостатке денег не возвращается частичный инвентарь.
 */
export function resolveStartingPurchases(classId, wealthRoll, purchases = []) {
  const key = classIdFor(classId)
  if (!key) return error('CLASS_UNSUPPORTED', 'Неизвестный класс PHB 2014')
  const wealth = confirmedWealth(key, wealthRoll)
  if (!wealth.ok) return wealth
  if (!Array.isArray(purchases)) return error('PURCHASES_INVALID', 'purchases должен быть массивом')

  let spentCp = 0
  const selected = []
  for (let index = 0; index < purchases.length; index += 1) {
    const purchase = purchases[index]
    if (!purchase || typeof purchase !== 'object' || Array.isArray(purchase)) return error('PURCHASE_INVALID', `Покупка ${index + 1} должна быть объектом`)
    const entry = PURCHASE_BY_ID.get(String(purchase.id ?? '').trim())
    if (!entry) return error('PURCHASE_UNKNOWN_ITEM', `Предмет покупки ${String(purchase.id ?? '')} отсутствует в каталоге PHB 2014`)
    const quantity = Number(purchase.quantity)
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100_000) return error('PURCHASE_QUANTITY_INVALID', `Количество предмета ${entry.name} должно быть целым числом от 1 до 100000`)
    const cost = entry.price_cp * quantity
    if (!Number.isSafeInteger(cost) || !Number.isSafeInteger(spentCp + cost)) return error('PURCHASE_TOTAL_INVALID', 'Стоимость покупок выходит за безопасный диапазон чисел')
    spentCp += cost
    selected.push({ entry, quantity })
  }
  if (spentCp > wealth.total_cp) return error('PURCHASES_OVER_BUDGET', 'Покупки превышают подтверждённое стартовое богатство')

  const inventory = selected.filter(({ entry }) => !entry.owned_asset).map(({ entry, quantity }, index) => materializePurchase(entry, quantity, wealth.id, index))
  const ownedAssets = selected.filter(({ entry }) => entry.owned_asset).map(({ entry, quantity }, index) => ({ ...entry, id: `${instanceId(wealth.id, index)}-asset`, catalog_id: entry.id, quantity }))
  return {
    ok: true,
    class_id: key,
    wealth_roll: { id: wealth.id, class_id: key, total_gp: wealth.total_gp, total_cp: wealth.total_cp },
    spent_cp: spentCp,
    inventory,
    owned_assets: ownedAssets,
    remaining_currency: remainingCurrency(wealth.total_cp - spentCp),
  }
}
