/**
 * Чистый каталог видимых моделей экипировки.
 *
 * Модуль намеренно не импортирует `item-catalog.mjs`: серверный каталог
 * импортируется большим графом правил, а этот небольшой whitelist нужен также
 * клиентскому рендереру. Поэтому здесь находятся только стабильные ключи,
 * которые уже проверены сборщиками моделей, и адресное сопоставление
 * каталожных id. Экономические и боевые свойства предмета сюда не попадают.
 */

export const EQUIPMENT_VISUAL_SCHEMA_VERSION = 2

export const EQUIPMENT_VISUAL_SLOTS = Object.freeze([
  'body',
  'main_hand',
  'off_hand',
  'cloak',
  'brooch',
  'ring-protection',
  'ring-fire-resistance',
])

export const EQUIPMENT_VISUAL_VARIANTS = Object.freeze([
  'default',
  'enchanted',
  'adamantine',
  'flaming',
])

const CATALOG_PREFIX = 'srd_5_2_1:'

const WEAPON_MODEL_KEYS = Object.freeze([
  'club', 'dagger', 'greatclub', 'handaxe', 'javelin', 'light-hammer', 'mace',
  'quarterstaff', 'sickle', 'spear', 'dart', 'light-crossbow', 'shortbow',
  'sling', 'battleaxe', 'flail', 'glaive', 'greataxe', 'greatsword', 'halberd',
  'lance', 'longsword', 'maul', 'morningstar', 'pike', 'rapier', 'scimitar',
  'shortsword', 'trident', 'warhammer', 'war-pick', 'whip', 'blowgun',
  'hand-crossbow', 'heavy-crossbow', 'longbow', 'musket', 'pistol',
])

const ARMOR_MODEL_KEYS = Object.freeze([
  'armor-padded', 'armor-leather', 'armor-studded', 'armor-hide',
  'armor-chainshirt', 'armor-scalemail', 'armor-breastplate',
  'armor-halfplate', 'armor-ringmail', 'armor-chainmail', 'armor-splint',
  'armor-plate',
])

const MISC_MODEL_KEYS = Object.freeze(['cloak', 'ring', 'brooch', 'wand', 'shield'])

const MODEL_KEYS = new Set([
  ...WEAPON_MODEL_KEYS,
  ...ARMOR_MODEL_KEYS,
  ...MISC_MODEL_KEYS,
])

const SLOT_MODEL_KEYS = Object.freeze({
  body: new Set(ARMOR_MODEL_KEYS),
  main_hand: new Set([...WEAPON_MODEL_KEYS, 'wand']),
  off_hand: new Set(['shield']),
  cloak: new Set(['cloak']),
  brooch: new Set(['brooch']),
  'ring-protection': new Set(['ring']),
  'ring-fire-resistance': new Set(['ring']),
})

const descriptor = (slot, model_key, variant = 'default') => Object.freeze({
  slot,
  model_key,
  variant,
})

const catalog = (id) => `${CATALOG_PREFIX}${id}`

const entries = [
  ...WEAPON_MODEL_KEYS.map((key) => [catalog(key), descriptor('main_hand', key)]),
  ['srd_5_2_1:padded-armor', descriptor('body', 'armor-padded')],
  ['srd_5_2_1:leather-armor', descriptor('body', 'armor-leather')],
  ['srd_5_2_1:studded-leather-armor', descriptor('body', 'armor-studded')],
  ['srd_5_2_1:hide-armor', descriptor('body', 'armor-hide')],
  ['srd_5_2_1:chain-shirt', descriptor('body', 'armor-chainshirt')],
  ['srd_5_2_1:scale-mail', descriptor('body', 'armor-scalemail')],
  ['srd_5_2_1:breastplate', descriptor('body', 'armor-breastplate')],
  ['srd_5_2_1:half-plate-armor', descriptor('body', 'armor-halfplate')],
  ['srd_5_2_1:ring-mail', descriptor('body', 'armor-ringmail')],
  ['srd_5_2_1:chain-mail', descriptor('body', 'armor-chainmail')],
  ['srd_5_2_1:splint-armor', descriptor('body', 'armor-splint')],
  ['srd_5_2_1:plate-armor', descriptor('body', 'armor-plate')],
  ['srd_5_2_1:shield', descriptor('off_hand', 'shield')],
  ['srd_5_2_1:cloak-of-protection', descriptor('cloak', 'cloak', 'enchanted')],
  ['srd_5_2_1:ring-of-protection', descriptor('ring-protection', 'ring', 'enchanted')],
  ['srd_5_2_1:ring-of-fire-resistance', descriptor('ring-fire-resistance', 'ring', 'enchanted')],
  ['srd_5_2_1:brooch-of-shielding', descriptor('brooch', 'brooch', 'enchanted')],
  ['srd_5_2_1:wand-of-magic-missiles', descriptor('main_hand', 'wand', 'enchanted')],
  // Магические варианты используют ту же геометрию, но сохраняют визуальную
  // семантику варианта для материала/эффекта в клиентском композиторе.
  ['srd_5_2_1:longsword-plus-1', descriptor('main_hand', 'longsword', 'enchanted')],
  ['srd_5_2_1:weapon-of-warning-longsword', descriptor('main_hand', 'longsword', 'enchanted')],
  ['srd_5_2_1:vicious-longsword', descriptor('main_hand', 'longsword', 'enchanted')],
  ['srd_5_2_1:flame-tongue-longsword', descriptor('main_hand', 'longsword', 'flaming')],
  ['srd_5_2_1:adamantine-chain-mail', descriptor('body', 'armor-chainmail', 'adamantine')],
]

const ITEM_VISUALS = Object.freeze(Object.fromEntries(entries))

if (Object.keys(ITEM_VISUALS).length !== 61) {
  throw new Error(`Каталог визуальной экипировки должен содержать 61 запись, получено ${Object.keys(ITEM_VISUALS).length}`)
}

export const EQUIPMENT_ITEM_VISUALS = ITEM_VISUALS
export const EQUIPMENT_VISUAL_MODEL_KEYS = Object.freeze([...MODEL_KEYS].sort())

const LEGACY_NAME_MODELS = Object.freeze({
  // Только точные имена, которые были однозначны в старых сохранениях. Общие
  // «меч», «лук» и «арбалет» сюда не входят: по ним нельзя выбрать геометрию.
  'длинный меч': descriptor('main_hand', 'longsword'),
  longsword: descriptor('main_hand', 'longsword'),
  'короткий меч': descriptor('main_hand', 'shortsword'),
  shortsword: descriptor('main_hand', 'shortsword'),
  скимитар: descriptor('main_hand', 'scimitar'),
  scimitar: descriptor('main_hand', 'scimitar'),
  рапира: descriptor('main_hand', 'rapier'),
  rapier: descriptor('main_hand', 'rapier'),
  кинжал: descriptor('main_hand', 'dagger'),
  dagger: descriptor('main_hand', 'dagger'),
  'длинный лук': descriptor('main_hand', 'longbow'),
  longbow: descriptor('main_hand', 'longbow'),
  'короткий лук': descriptor('main_hand', 'shortbow'),
  shortbow: descriptor('main_hand', 'shortbow'),
  'боевой посох': descriptor('main_hand', 'quarterstaff'),
  quarterstaff: descriptor('main_hand', 'quarterstaff'),
  посох: descriptor('main_hand', 'quarterstaff'),
  дубинка: descriptor('main_hand', 'club'),
  club: descriptor('main_hand', 'club'),
  'большая дубинка': descriptor('main_hand', 'greatclub'),
  greatclub: descriptor('main_hand', 'greatclub'),
  'ручной топор': descriptor('main_hand', 'handaxe'),
  handaxe: descriptor('main_hand', 'handaxe'),
  копье: descriptor('main_hand', 'spear'),
  копьё: descriptor('main_hand', 'spear'),
  spear: descriptor('main_hand', 'spear'),
  булава: descriptor('main_hand', 'mace'),
  mace: descriptor('main_hand', 'mace'),
  'лёгкий молот': descriptor('main_hand', 'light-hammer'),
  'легкий молот': descriptor('main_hand', 'light-hammer'),
  'light hammer': descriptor('main_hand', 'light-hammer'),
  'боевой молот': descriptor('main_hand', 'warhammer'),
  warhammer: descriptor('main_hand', 'warhammer'),
  молот: descriptor('main_hand', 'maul'),
  maul: descriptor('main_hand', 'maul'),
  щит: descriptor('off_hand', 'shield'),
  shield: descriptor('off_hand', 'shield'),
  'кожаный доспех': descriptor('body', 'armor-leather'),
  'стёганый доспех': descriptor('body', 'armor-padded'),
  'стеганый доспех': descriptor('body', 'armor-padded'),
  'клёпаный кожаный доспех': descriptor('body', 'armor-studded'),
  'клепаный кожаный доспех': descriptor('body', 'armor-studded'),
  'шкурный доспех': descriptor('body', 'armor-hide'),
  'кольчужная рубаха': descriptor('body', 'armor-chainshirt'),
  'чешуйчатый доспех': descriptor('body', 'armor-scalemail'),
  кираса: descriptor('body', 'armor-breastplate'),
  breastplate: descriptor('body', 'armor-breastplate'),
  полулаты: descriptor('body', 'armor-halfplate'),
  'half plate': descriptor('body', 'armor-halfplate'),
  'кольчатый доспех': descriptor('body', 'armor-ringmail'),
  кольчуга: descriptor('body', 'armor-chainmail'),
  'chain mail': descriptor('body', 'armor-chainmail'),
  'ламеллярный доспех': descriptor('body', 'armor-splint'),
  латы: descriptor('body', 'armor-plate'),
  plate: descriptor('body', 'armor-plate'),
})

const PRIVATE_KEYS = Object.freeze([
  'hidden', 'private', 'gm_only', 'npc_private', 'secret', 'unrevealed',
  'private_notes', 'gm_notes',
])
const VISIBILITY_KEYS = Object.freeze(['visibility', 'visibility_level', 'visibilityLevel'])

function clean(value, maximum = 160) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, maximum)
}

function normalizedLegacyName(value) {
  return clean(value, 160).toLocaleLowerCase('ru-RU').replace(/\s+/gu, ' ')
}

function objectLike(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function publicVisualRecord(value) {
  if (!objectLike(value)) return false
  const declared = VISIBILITY_KEYS
    .filter((key) => value[key] != null)
    .map((key) => clean(value[key], 40).toLocaleLowerCase('ru-RU'))
  if (declared.some((visibility) => !['public', 'party'].includes(visibility))) return false
  return !PRIVATE_KEYS.some((key) => Boolean(value[key]))
}

function descriptorForSlot(slot, value) {
  if (!objectLike(value)) return null
  const modelKey = normalizeEquipmentModelKey(value.model_key ?? value.modelKey)
  const variant = normalizeEquipmentVisualVariant(value.variant)
  if (!modelKey || !variant || !SLOT_MODEL_KEYS[slot]?.has(modelKey)) return null
  return variant === 'default' ? { model_key: modelKey } : { model_key: modelKey, variant }
}

/** Приводит слот к закрытому публичному словарю. */
export function normalizeEquipmentVisualSlot(value) {
  const slot = clean(value, 40)
  return EQUIPMENT_VISUAL_SLOTS.includes(slot) ? slot : null
}

/** Приводит вариант материала к закрытому словарю. */
export function normalizeEquipmentVisualVariant(value, fallback = 'default') {
  const variant = clean(value, 40)
  if (!variant) return fallback
  return EQUIPMENT_VISUAL_VARIANTS.includes(variant) ? variant : null
}

/** Приводит ключ модели к закрытому локальному словарю. */
export function normalizeEquipmentModelKey(value) {
  const modelKey = clean(value, 80)
  return MODEL_KEYS.has(modelKey) ? modelKey : null
}

/**
 * Возвращает модель каталожного предмета. `null` означает, что предмет не
 * известен этому выпуску визуального каталога.
 */
export function itemVisualForCatalogId(catalogId) {
  const value = ITEM_VISUALS[clean(catalogId, 120)]
  if (!value) return null
  return value.variant === 'default'
    ? { slot: value.slot, model_key: value.model_key }
    : { slot: value.slot, model_key: value.model_key, variant: value.variant }
}

/** Псевдоним с более явным именем для серверных и клиентских потребителей. */
export const equipmentVisualForCatalogId = itemVisualForCatalogId

function legacyVisualForItem(item) {
  const exact = LEGACY_NAME_MODELS[normalizedLegacyName(item?.name)]
  if (exact) return exact
  // Fallback-слот нужен, чтобы открытая, но самодельная вещь могла честно
  // показать `null`: это надето, однако сервер не знает однозначной геометрии.
  if (item?.type === 'weapon' && objectLike(item.combat)) return { slot: 'main_hand', model_key: null }
  if (item?.type === 'armor') return { slot: 'body', model_key: null }
  return null
}

function visualForItem(item) {
  const catalogVisual = itemVisualForCatalogId(item?.catalog_id ?? item?.catalogId)
  if (catalogVisual) {
    const variant = catalogVisual.variant ?? 'default'
    if (item?.identified === false && variant !== 'default') return { ...catalogVisual, variant: 'default' }
    if (variant === 'flaming' && item?.activated !== true) return { ...catalogVisual, variant: 'enchanted' }
    return catalogVisual
  }
  return legacyVisualForItem(item)
}

/**
 * Строит публичную map экипированных слотов. Вход должен быть уже разрешённым
 * инвентарём; здесь повторно проверяется публичность каждой записи как защита
 * от прямого вызова с внутренним состоянием.
 *
 * Отсутствующий ключ означает «в слоте ничего не надето». `null` означает
 * «публично видно, что слот занят, но однозначной модели нет».
 */
export function publicLoadoutForItems(items, { additionalEquipped = [] } = {}) {
  const byId = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    if (objectLike(item)) byId.set(clean(item.id ?? item.item_id, 120), item)
  }
  for (const item of Array.isArray(additionalEquipped) ? additionalEquipped : []) {
    if (!objectLike(item)) continue
    const id = clean(item.id ?? item.item_id, 120)
    if (id) byId.set(id, { ...item, equipped: true })
  }

  const loadout = {}
  for (const item of byId.values()) {
    if (item.equipped !== true || !publicVisualRecord(item)) continue
    const visual = visualForItem(item)
    if (!visual?.slot) continue
    if (Object.hasOwn(loadout, visual.slot)) {
      // Невалидное старое состояние с двумя предметами одного слота не должно
      // заставлять зрителя выбрать один из них произвольно.
      loadout[visual.slot] = null
      continue
    }
    loadout[visual.slot] = visual.model_key
      ? descriptorForSlot(visual.slot, visual)
      : null
  }
  return loadout
}

/**
 * Нормализует пришедшую из состояния публичную loadout map, не пропуская
 * неизвестные слоты, URL, item ids и дополнительные поля.
 */
export function normalizePublicLoadout(value) {
  if (!objectLike(value)) return {}
  const result = {}
  for (const slot of EQUIPMENT_VISUAL_SLOTS) {
    if (!Object.hasOwn(value, slot)) continue
    const raw = value[slot]
    result[slot] = raw === null ? null : descriptorForSlot(slot, raw)
  }
  return result
}

/** Возвращает закрытый набор ключей моделей по слоту для тестов/рендерера. */
export function modelKeysForEquipmentSlot(slot) {
  const normalized = normalizeEquipmentVisualSlot(slot)
  return normalized ? Object.freeze([...SLOT_MODEL_KEYS[normalized]].sort()) : Object.freeze([])
}
