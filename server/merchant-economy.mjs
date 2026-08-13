import { createHash } from 'node:crypto'

import {
  ITEM_CATALOG_SCHEMA_VERSION,
  ITEM_CATALOG_SOURCE,
  SRD_EQUIPMENT_CATALOG,
  catalogItem,
  hydrateCatalogItem as hydrateCatalogRecord,
  materializeCatalogItem,
  normalizeItemRechargeProfile,
} from './item-catalog.mjs'
import { reputationStandingFor } from './reputation-policy.mjs'

export const ECONOMY_POLICY_ID = 'skazanie:economy:merchant-policy-v1'
export const ECONOMY_CATALOG_VERSION = 'srd_5_2_1'
export const ECONOMY_CATALOG_SOURCE = ITEM_CATALOG_SOURCE
export { SRD_EQUIPMENT_CATALOG }

// The canonical representation uses platinum as its largest denomination.
// Keep the total cap aligned with the 9,000,000 PP per-field cap so round trips
// through copperToCurrency/normalizeCurrency never lose value.
export const MAX_CURRENCY_CP = 9_000_000_000
// Legacy campaign snapshots predate merchant liquidity. Give those merchants a
// bounded, deterministic reserve so upgrading does not silently disable sales.
// New merchants may override the reserve through the admin/director lifecycle.
export const DEFAULT_MERCHANT_PURSE_CP = 100_000
export const MAX_TRANSACTION_QUANTITY = 999
export const MAX_STOCK_QUANTITY = 999_999
export const MAX_UNIT_PRICE_CP = 100_000_000
export const ITEM_APPRAISAL_CONTRACT_VERSION = 'skazanie:item-appraisal:v1'
export const ITEM_APPRAISAL_POLICY_ID = 'skazanie:item-appraisal:category-rarity-condition:v1'
// Services and replenishment are explicit campaign policies. They deliberately
// use campaign minutes rather than wall-clock time so replay and a future job
// runner are deterministic.
export const MERCHANT_SERVICES_POLICY_ID = 'skazanie:economy:merchant-services-v1'
export const MERCHANT_RESTOCK_POLICY_ID = 'skazanie:economy:merchant-restock-v1'
export const MERCHANT_ECONOMY_CLOCK_EVENT_TYPE = 'MerchantEconomyClockAdvanced'
export const MIN_RESTOCK_INTERVAL_MINUTES = 60
export const MAX_RESTOCK_INTERVAL_MINUTES = 525_600
export const MAX_WORLD_MINUTE = 1_000_000_000
const ITEM_APPRAISAL_FINGERPRINT = /^[a-f0-9]{64}$/u

/**
 * Location identity is still string-based, so every merchant boundary must use
 * the same conservative key. Keep the original text for presentation while
 * normalizing compatibility differences introduced by agents/admin forms.
 */
export function canonicalLocationKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 180)
    .toLocaleLowerCase('ru')
}

export function canonicalLocationId(value) {
  return String(value ?? '').trim().slice(0, 120)
}

function locationReference(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  return {
    id: canonicalLocationId(source?.location_id ?? source?.locationId),
    key: canonicalLocationKey(source ? (source.location ?? source.name) : value),
  }
}

export function locationsMatch(left, right) {
  const leftReference = locationReference(left)
  const rightReference = locationReference(right)
  if (leftReference.id && rightReference.id) return leftReference.id === rightReference.id
  return leftReference.key === rightReference.key
}

/** An empty merchant location preserves the legacy "available everywhere" rule. */
export function merchantIsAtLocation(merchantLocation, sceneLocation) {
  const merchant = locationReference(merchantLocation)
  return (!merchant.id && !merchant.key) || locationsMatch(merchantLocation, sceneLocation)
}

function clone(value) {
  return structuredClone(value)
}

function safeInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : fallback
}

function clampInteger(value, minimum, maximum, fallback = minimum) {
  return Math.max(minimum, Math.min(maximum, safeInteger(value, fallback)))
}

function cleanId(value, fallback = '') {
  const result = String(value ?? '').trim().slice(0, 120)
  return result || fallback
}

function cleanText(value, maximum, fallback = '') {
  const result = String(value ?? '').trim().slice(0, maximum)
  return result || fallback
}

const INVENTORY_ITEM_TYPES = new Set(['weapon', 'armor', 'consumable', 'tool', 'quest', 'treasure', 'document', 'other'])
const MERCHANT_SERVICE_KINDS = new Set(['appraisal', 'lodging', 'repair', 'transport', 'training', 'other'])
const INVENTORY_ITEM_RARITIES = new Set(['обычный', 'необычный', 'редкий', 'очень редкий', 'легендарный', 'сюжетный'])

function normalizeItemType(value) {
  const type = cleanText(value, 40, 'other').toLowerCase()
  if (['trade_good', 'trade-good', 'valuable'].includes(type)) return 'treasure'
  return INVENTORY_ITEM_TYPES.has(type) ? type : 'other'
}

function normalizeItemRarity(value) {
  const rarity = cleanText(value, 60, 'обычный').toLocaleLowerCase('ru')
  return INVENTORY_ITEM_RARITIES.has(rarity) ? rarity : 'обычный'
}

function normalizePassiveEffects(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 32).flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    if (clampInteger(candidate.schema_version, 0, 1_000, 0) !== 1) return []
    const effectId = cleanId(candidate.effect_id)
    const group = cleanId(candidate.group)
    if (!effectId || !group) return []
    const armorClassBonus = clampInteger(candidate.armor_class_bonus, 0, 100, 0)
    const savingThrowBonus = clampInteger(candidate.saving_throw_bonus, 0, 100, 0)
    const damageResistances = [...new Set((Array.isArray(candidate.damage_resistances) ? candidate.damage_resistances : [])
      .slice(0, 32).map((entry) => cleanText(entry, 40).toLowerCase()).filter(Boolean))].sort()
    const spellImmunities = [...new Set((Array.isArray(candidate.spell_immunities) ? candidate.spell_immunities : [])
      .slice(0, 32).map((entry) => cleanText(entry, 80).toLowerCase()).filter(Boolean))].sort()
    const riderSource = candidate.weapon_damage_rider && typeof candidate.weapon_damage_rider === 'object' && !Array.isArray(candidate.weapon_damage_rider)
      ? candidate.weapon_damage_rider
      : null
    const riderExpression = cleanText(riderSource?.expression, 40).toLowerCase().replace(/\s+/gu, '')
    const riderDamageType = cleanText(riderSource?.damage_type, 40).toLowerCase()
    const weaponDamageRider = /^([1-9]|1\d|20)d(4|6|8|10|12)$/u.test(riderExpression) && riderDamageType
      ? { expression: riderExpression, damage_type: riderDamageType, critical_doubles: riderSource.critical_doubles === true }
      : null
    const preventsCriticalHits = candidate.prevents_critical_hits === true
    const initiativeAdvantage = candidate.initiative_advantage === true
    if (armorClassBonus === 0 && savingThrowBonus === 0 && !damageResistances.length && !spellImmunities.length
      && !preventsCriticalHits && !initiativeAdvantage && !weaponDamageRider) return []
    return [{
      schema_version: 1,
      effect_id: effectId,
      group,
      requires_equipped: candidate.requires_equipped === true,
      requires_attunement: candidate.requires_attunement === true,
      ...(candidate.requires_activated === true ? { requires_activated: true } : {}),
      armor_class_bonus: armorClassBonus,
      saving_throw_bonus: savingThrowBonus,
      ...(damageResistances.length ? { damage_resistances: damageResistances } : {}),
      ...(spellImmunities.length ? { spell_immunities: spellImmunities } : {}),
      ...(preventsCriticalHits ? { prevents_critical_hits: true } : {}),
      ...(initiativeAdvantage ? { initiative_advantage: true } : {}),
      ...(weaponDamageRider ? { weapon_damage_rider: weaponDamageRider } : {}),
    }]
  })
}

/**
 * Санитайзеры полей вещи открыты наружу намеренно: у приведения типа, редкости
 * и пассивных эффектов должен быть **один** владелец. Снимок экземпляра
 * (`server/item-instances.mjs`) приходит той же недоверенной дорогой — из
 * сохранения и payload события — и обязан чиститься тем же кодом, иначе
 * границы разойдутся молча.
 */
export {
  normalizeItemType as normalizeInventoryItemType,
  normalizeItemRarity as normalizeInventoryItemRarity,
  normalizePassiveEffects as normalizeInventoryPassiveEffects,
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

/**
 * A stack identity is always derived by the server. Client/snapshot stack_key
 * values are intentionally ignored so differently described or mechanically
 * different variants cannot be merged merely by reusing an id/catalog id.
 */
export function inventoryStackKey(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const catalogId = cleanId(source.catalog_id ?? source.catalogId)
  const basePriceCp = resolveCatalogBasePriceCp(source)
  const passiveEffects = normalizePassiveEffects(source.passive_effects)
  const recharge = normalizeItemRechargeProfile(source.recharge)
  const descriptor = stableValue({
    catalog_id: catalogId || null,
    base_price_cp: basePriceCp,
    name: cleanText(source.name, 120, 'Предмет'),
    type: normalizeItemType(source.type),
    weight: Number.isFinite(Number(source.weight)) ? Math.max(0, Number(source.weight)) : 0,
    rarity: normalizeItemRarity(source.rarity),
    description: cleanText(source.description, 1_000),
    properties: cleanText(source.properties, 500),
    combat: source.combat && typeof source.combat === 'object' ? source.combat : null,
    ...(passiveEffects.length ? { passive_effects: passiveEffects } : {}),
    ...(recharge ? { recharge } : {}),
    charges: source.charges && typeof source.charges === 'object' ? source.charges : null,
    requires_attunement: source.requires_attunement === true ? true : null,
    attuned_to: source.attuned_to == null ? null : cleanId(source.attuned_to),
    sellable: source.sellable === false ? false : null,
    quest_item: source.quest_item === true ? true : null,
    price_provenance: source.price_provenance == null ? null : cleanText(source.price_provenance, 60),
    appraisal_policy_id: source.appraisal_policy_id == null ? null : cleanText(source.appraisal_policy_id, 120),
  })
  const digest = createHash('sha256').update(JSON.stringify(descriptor)).digest('hex').slice(0, 32)
  return `${(catalogId || 'custom').slice(0, 80)}:${digest}`
}

/**
 * Server-side inventory shape shared by imported state and replay.
 * Catalog hydration is deliberately opt-in: replay of old event payloads must
 * not acquire new fields merely because the manifest grew.
 */
export function normalizeInventoryItem(input = {}, { idFallback = 'item', preserveUnknown = false, hydrateCatalog = false } = {}) {
  const original = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const source = hydrateCatalog ? hydrateCatalogRecord(original) : original
  const catalogId = cleanId(source.catalog_id ?? source.catalogId)
  const resolvedPrice = resolveCatalogBasePriceCp({ ...source, catalog_id: catalogId })
  const maxCharges = clampInteger(source.charges?.max, 0, 1_000_000, 0)
  const passiveEffects = normalizePassiveEffects(source.passive_effects)
  const recharge = catalogId && catalogItem(catalogId)
    ? normalizeItemRechargeProfile(catalogItem(catalogId)?.recharge)
    : normalizeItemRechargeProfile(source.recharge)
  const item = {
    ...(preserveUnknown ? clone(source) : {}),
    id: cleanId(source.item_id ?? source.id, idFallback),
    ...(catalogId ? { catalog_id: catalogId } : {}),
    ...(source.catalog_schema_version == null ? {} : {
      catalog_schema_version: cleanText(source.catalog_schema_version, 120, ITEM_CATALOG_SCHEMA_VERSION),
    }),
    ...(source.mechanics_status == null ? {} : {
      mechanics_status: cleanText(source.mechanics_status, 40),
    }),
    name: cleanText(source.name, 120, 'Предмет'),
    type: normalizeItemType(source.type),
    quantity: clampInteger(source.quantity, 1, MAX_STOCK_QUANTITY, 1),
    weight: Number.isFinite(Number(source.weight)) ? Math.max(0, Number(source.weight)) : 0,
    equipped: source.equipped === true,
    ...(source.activated === true ? { activated: true } : {}),
    rarity: normalizeItemRarity(source.rarity),
    description: cleanText(source.description, 1_000),
    properties: cleanText(source.properties, 500),
    image: cleanText(source.image, 500),
    ...(source.imagePosition == null ? {} : { imagePosition: cleanText(source.imagePosition, 80) }),
    ...(source.imagePrompt == null ? {} : { imagePrompt: cleanText(source.imagePrompt, 1_000) }),
    ...(source.imageStatus == null ? {} : { imageStatus: cleanText(source.imageStatus, 40) }),
    ...(source.combat && typeof source.combat === 'object' ? { combat: clone(source.combat) } : {}),
    ...(passiveEffects.length ? { passive_effects: passiveEffects } : {}),
    ...(source.charges && typeof source.charges === 'object' ? {
      charges: { current: clampInteger(source.charges.current, 0, maxCharges, 0), max: maxCharges },
    } : {}),
    ...(recharge ? { recharge } : {}),
    ...(source.requires_attunement === true ? { requires_attunement: true } : {}),
    ...(source.attuned_to == null ? {} : { attuned_to: cleanId(source.attuned_to) }),
    ...(source.sellable === false ? { sellable: false } : {}),
    ...(source.quest_item === true ? { quest_item: true } : {}),
    ...(source.price_provenance == null ? {} : { price_provenance: cleanText(source.price_provenance, 60) }),
    ...(source.appraisal_policy_id == null ? {} : { appraisal_policy_id: cleanText(source.appraisal_policy_id, 120) }),
    ...(resolvedPrice > 0 ? { base_price_cp: resolvedPrice } : {}),
  }
  if (!passiveEffects.length) delete item.passive_effects
  if (!recharge) delete item.recharge
  item.stack_key = inventoryStackKey(item)
  return item
}

export function normalizeCurrency(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const currency = {
    copper: clampInteger(source.copper, 0, 9_000_000_000, 0),
    silver: clampInteger(source.silver, 0, 900_000_000, 0),
    gold: clampInteger(source.gold, 0, 90_000_000, 0),
    platinum: clampInteger(source.platinum, 0, 9_000_000, 0),
  }
  const total = currency.copper + currency.silver * 10 + currency.gold * 100 + currency.platinum * 1_000
  return total <= MAX_CURRENCY_CP ? currency : canonicalCurrency(MAX_CURRENCY_CP)
}

export function currencyToCopper(input = {}) {
  const currency = normalizeCurrency(input)
  return currency.copper
    + currency.silver * 10
    + currency.gold * 100
    + currency.platinum * 1_000
}

function canonicalCurrency(input) {
  let remaining = clampInteger(input, 0, MAX_CURRENCY_CP, 0)
  const platinum = Math.floor(remaining / 1_000)
  remaining -= platinum * 1_000
  const gold = Math.floor(remaining / 100)
  remaining -= gold * 100
  const silver = Math.floor(remaining / 10)
  const copper = remaining - silver * 10
  return { copper, silver, gold, platinum }
}

export function copperToCurrency(input) {
  return canonicalCurrency(input)
}

export function normalizeMerchantPurseCp(value, fallback = DEFAULT_MERCHANT_PURSE_CP) {
  const safeFallback = clampInteger(fallback, 0, MAX_CURRENCY_CP, DEFAULT_MERCHANT_PURSE_CP)
  return clampInteger(value, 0, MAX_CURRENCY_CP, safeFallback)
}

export function resolveCatalogPrice(input = {}) {
  const catalogId = cleanId(input?.catalog_id ?? input?.catalogId)
  const catalog = SRD_EQUIPMENT_CATALOG[catalogId]
  if (catalog) return { ...catalog, provenance: 'catalog' }
  // Snapshot markers are not authority. Homebrew values remain unavailable
  // until a dedicated server-side appraisal event can attest their price.
  return null
}

export function resolveCatalogBasePriceCp(input = {}) {
  return resolveCatalogPrice(input)?.base_price_cp ?? 0
}

function trustedAppraisalRecord(input, item, actorId = null) {
  const appraisal = input && typeof input === 'object' && !Array.isArray(input) ? input : null
  if (!appraisal || !item || typeof item !== 'object') return null
  const basePriceCp = safeInteger(appraisal.base_price_cp ?? appraisal.base_unit_price_cp, 0)
  if (
    appraisal.authoritative !== true
    || appraisal.contract_version !== ITEM_APPRAISAL_CONTRACT_VERSION
    || appraisal.policy_id !== ITEM_APPRAISAL_POLICY_ID
    || appraisal.provenance !== 'server_appraisal_policy'
    || appraisal.currency !== 'cp'
    || !ITEM_APPRAISAL_FINGERPRINT.test(String(appraisal.appraisal_fingerprint ?? ''))
    || basePriceCp < 1
    || basePriceCp > MAX_UNIT_PRICE_CP
    || String(appraisal.item_id ?? '') !== String(item.id ?? item.item_id ?? '')
    || String(appraisal.item_stack_key ?? '') !== inventoryStackKey(item)
    || (actorId != null && String(appraisal.actor_id ?? '') !== String(actorId))
  ) return null
  return { ...clone(appraisal), base_price_cp: basePriceCp }
}

/** Returns only an event-attested appraisal that still matches this exact item. */
export function trustedItemAppraisalFor(state, actorId, item) {
  const actorRegistry = state?.mechanics?.item_appraisals?.[String(actorId ?? '')]
  const record = actorRegistry && typeof actorRegistry === 'object' && !Array.isArray(actorRegistry)
    ? actorRegistry[String(item?.id ?? '')]
    : null
  return trustedAppraisalRecord(record, item, actorId)
}

/** Appraised resale stock carries the same immutable attestation in the event stream. */
export function trustedStockAppraisalFor(stock) {
  return trustedAppraisalRecord(stock?.appraisal, stock)
}

function trustedBasePriceCp(item, appraisal = null) {
  return resolveCatalogBasePriceCp(item) || trustedAppraisalRecord(appraisal, item)?.base_price_cp || 0
}

export function normalizeMerchantPricing(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const percentMarkup = Number(source.buy_markup_percent)
  const percentSell = Number(source.sell_rate_percent)
  const limitPercent = clampInteger(source.agent_adjustment_limit_percent, 0, 50, 20)
  const adjustmentLimitBps = limitPercent * 100
  const requestedAgentAdjustment = safeInteger(source.agent_adjustment_bps,
    Number.isFinite(Number(source.agent_adjustment_percent)) ? Math.round(Number(source.agent_adjustment_percent) * 100) : 0)
  const buyMarkupBps = Number.isSafeInteger(Number(source.buy_markup_bps))
    ? Number(source.buy_markup_bps)
    : Number.isFinite(percentMarkup) ? 10_000 + Math.round(percentMarkup * 100) : 10_000
  const sellRateBps = Number.isSafeInteger(Number(source.sell_rate_bps))
    ? Number(source.sell_rate_bps)
    : Number.isFinite(percentSell) ? Math.round(percentSell * 100) : 5_000
  const minimum = clampInteger(source.min_multiplier_bps, 100, 30_000, 1_000)
  const maximum = clampInteger(source.max_multiplier_bps, minimum, 50_000, 30_000)
  const mode = source.mode === 'catalog' ? 'catalog' : 'catalog_with_agent_adjustment'
  return {
    ...clone(source),
    mode,
    catalog_id: cleanId(source.catalog_id, ECONOMY_CATALOG_VERSION),
    buy_markup_bps: clampInteger(buyMarkupBps, minimum, maximum, 10_000),
    sell_rate_bps: clampInteger(sellRateBps, minimum, maximum, 5_000),
    bargain_dc: clampInteger(source.bargain_dc, 5, 30, 15),
    success_discount_bps: clampInteger(source.success_discount_bps, 0, 5_000, 1_000),
    failure_markup_bps: clampInteger(source.failure_markup_bps, 0, 5_000, 500),
    min_multiplier_bps: minimum,
    max_multiplier_bps: maximum,
    agent_adjustment_bps: mode === 'catalog'
      ? 0
      : Math.max(-adjustmentLimitBps, Math.min(adjustmentLimitBps, requestedAgentAdjustment)),
    agent_adjustment_limit_percent: limitPercent,
    buy_markup_percent: Math.round((clampInteger(buyMarkupBps, minimum, maximum, 10_000) - 10_000) / 100),
    sell_rate_percent: Math.round(clampInteger(sellRateBps, minimum, maximum, 5_000) / 100),
  }
}

function normalizeBargains(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const entries = Object.entries(input).slice(0, 100).flatMap(([actorId, bargain]) => {
    if (!bargain || typeof bargain !== 'object') return []
    const id = cleanId(actorId)
    if (!id) return []
    const success = bargain.success === true || bargain.status === 'success'
    return [[id, {
      attempted: true,
      success,
      status: success ? 'success' : 'failure',
      roll_total: clampInteger(bargain.roll_total ?? bargain.total, -100, 200, 0),
      natural_roll: clampInteger(bargain.natural_roll ?? bargain.kept, 1, 20, 1),
      modifier: clampInteger(bargain.modifier, -30, 50, 0),
      difficulty: clampInteger(bargain.difficulty, 5, 30, 15),
      pricing_adjustment_bps: clampInteger(bargain.pricing_adjustment_bps, -5_000, 5_000, 0),
      resolved_at: bargain.resolved_at == null ? null : String(bargain.resolved_at).slice(0, 80),
    }]]
  })
  return Object.fromEntries(entries)
}

function normalizeMerchantService(input = {}, index = 0) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const serviceId = cleanId(source.service_id ?? source.serviceId ?? source.id, `service-${index + 1}`)
  const kind = cleanText(source.kind, 40, 'other').toLowerCase()
  return {
    service_id: serviceId,
    name: cleanText(source.name, 120, 'Услуга торговца'),
    description: cleanText(source.description, 1_000),
    kind: MERCHANT_SERVICE_KINDS.has(kind) ? kind : 'other',
    base_price_cp: clampInteger(source.base_price_cp ?? source.basePriceCp, 0, MAX_UNIT_PRICE_CP, 0),
    duration_minutes: clampInteger(source.duration_minutes ?? source.durationMinutes, 0, 10_080, 0),
    available: source.available !== false,
    requires_presence: source.requires_presence !== false && source.requiresPresence !== false,
    tags: [...new Set((Array.isArray(source.tags) ? source.tags : [])
      .map((tag) => cleanText(tag, 40))
      .filter(Boolean))].slice(0, 12),
    price_provenance: 'merchant_service_policy',
    policy_id: MERCHANT_SERVICES_POLICY_ID,
  }
}

export function normalizeMerchantServices(input) {
  const seen = new Set()
  return (Array.isArray(input) ? input : []).slice(0, 100).flatMap((service, index) => {
    const normalized = normalizeMerchantService(service, index)
    if (seen.has(normalized.service_id)) return []
    seen.add(normalized.service_id)
    return [normalized]
  })
}

/**
 * A restock policy only targets existing, catalog-attested stock entries. It
 * cannot introduce a new SKU or change its catalog identity; that remains the
 * explicit merchant lifecycle command's responsibility.
 */
export function normalizeMerchantRestockPolicy(input = {}, stock = []) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const stockById = new Map((Array.isArray(stock) ? stock : []).map((entry) => [String(entry?.stock_id ?? ''), entry]))
  const seen = new Set()
  const targets = (Array.isArray(source.targets) ? source.targets : []).slice(0, 500).flatMap((target) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return []
    const stockId = cleanId(target.stock_id ?? target.stockId)
    if (!stockId || seen.has(stockId) || !stockById.has(stockId)) return []
    seen.add(stockId)
    const targetQuantity = clampInteger(
      target.target_quantity ?? target.targetQuantity ?? target.quantity,
      0,
      MAX_STOCK_QUANTITY,
      0,
    )
    if (targetQuantity < 1) return []
    return [{ stock_id: stockId, target_quantity: targetQuantity }]
  })
  const rawLastRestock = source.last_restock_world_minute ?? source.lastRestockWorldMinute
  const lastRestock = rawLastRestock == null
    ? null
    : clampInteger(rawLastRestock, 0, MAX_WORLD_MINUTE, 0)
  const enabled = source.enabled === true && targets.length > 0
  return {
    schema_version: 1,
    policy_id: MERCHANT_RESTOCK_POLICY_ID,
    enabled,
    interval_minutes: clampInteger(
      source.interval_minutes ?? source.intervalMinutes,
      MIN_RESTOCK_INTERVAL_MINUTES,
      MAX_RESTOCK_INTERVAL_MINUTES,
      1_440,
    ),
    last_restock_world_minute: lastRestock,
    targets,
  }
}

export function normalizeMerchant(input = {}, index = 0) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const merchantId = cleanId(source.id ?? source.merchant_id, `merchant-${index + 1}`)
  const seenStockIds = new Set()
  const stock = (Array.isArray(source.stock) ? source.stock : []).slice(0, 500).flatMap((entry, stockIndex) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry.item && typeof entry.item === 'object' ? { ...entry.item, ...entry } : entry
    const baseStockId = cleanId(entry.stock_id ?? entry.stockId, `${merchantId}-stock-${stockIndex + 1}`)
    let stockId = baseStockId
    let suffix = stockIndex + 1
    while (seenStockIds.has(stockId)) stockId = `${baseStockId.slice(0, 108)}-${suffix++}`
    seenStockIds.add(stockId)
    const catalogId = cleanId(entry.catalog_id ?? entry.catalogId ?? item.catalog_id ?? item.catalogId)
    const candidate = { ...item, catalog_id: catalogId }
    const stockAppraisal = trustedStockAppraisalFor(candidate)
    const basePrice = resolveCatalogBasePriceCp(candidate) || stockAppraisal?.base_price_cp || 0
    if (!stockId || !basePrice) return []
    return [{
      ...clone(item),
      stock_id: stockId,
      catalog_id: catalogId,
      name: cleanText(item.name, 120, 'Предмет'),
      type: cleanText(item.type, 40, 'other'),
      quantity: clampInteger(entry.quantity, 0, MAX_STOCK_QUANTITY, 0),
      base_price_cp: basePrice,
      ...(stockAppraisal ? { appraisal: stockAppraisal } : {}),
      ...(item.id == null ? {} : { item_id: cleanId(item.id) }),
      equipped: false,
    }]
  })
  return {
    ...clone(source),
    id: merchantId,
    name: cleanText(source.name, 120, 'Торговец'),
    title: cleanText(source.title, 180),
    description: cleanText(source.description, 1_000),
    greeting: cleanText(source.greeting, 500),
    voice: cleanText(source.voice, 500),
    location: cleanText(source.location, 180),
    location_id: canonicalLocationId(source.location_id ?? source.locationId),
    available: source.available !== false,
    purse_cp: normalizeMerchantPurseCp(source.purse_cp ?? source.purseCp),
    pricing: normalizeMerchantPricing(source.pricing),
    stock,
    bargains: normalizeBargains(source.bargains),
    services: normalizeMerchantServices(source.services),
    restock_policy: normalizeMerchantRestockPolicy(source.restock_policy ?? source.restockPolicy ?? source.restock, stock),
  }
}

export function normalizeMerchants(input) {
  const seen = new Set()
  return (Array.isArray(input) ? input : []).slice(0, 100).flatMap((merchant, index) => {
    const normalized = normalizeMerchant(merchant, index)
    if (seen.has(normalized.id)) return []
    seen.add(normalized.id)
    return [normalized]
  })
}

export function createStarterMerchant({ location = '', location_id = '', locationId = '' } = {}) {
  return normalizeMerchant({
    id: 'starter-provisioner',
    name: 'Мартен Рыжий',
    title: 'Странствующий торговец припасами',
    description: 'Проверенный поставщик обычного снаряжения и дорожных припасов.',
    greeting: 'Подходите ближе. Базовая цена известна заранее, а об условиях ещё можно поговорить.',
    voice: 'Говорит живо и дружелюбно, но внимательно считает каждую монету.',
    location,
    location_id: location_id || locationId,
    available: true,
    pricing: {
      mode: 'catalog_with_agent_adjustment',
      catalog_id: ECONOMY_CATALOG_VERSION,
      buy_markup_bps: 11_000,
      sell_rate_bps: 5_000,
      bargain_dc: 15,
      success_discount_bps: 1_000,
      failure_markup_bps: 500,
      min_multiplier_bps: 1_000,
      max_multiplier_bps: 30_000,
      agent_adjustment_limit_percent: 20,
      description: 'Каталожная SRD-цена с ограниченной политикой конкретного торговца.',
    },
    stock: [
      materializeCatalogItem('srd_5_2_1:potion-of-healing', {
        stock_id: 'starter-healing-potion', quantity: 3, description: 'Восстанавливает 2к4 + 2 хита.',
      }),
      materializeCatalogItem('srd_5_2_1:rope-hempen-50-feet', {
        stock_id: 'starter-hempen-rope', quantity: 4,
      }),
      materializeCatalogItem('srd_5_2_1:rations-one-day', {
        stock_id: 'starter-rations', quantity: 12,
      }),
      materializeCatalogItem('srd_5_2_1:torch', {
        stock_id: 'starter-torch', quantity: 10,
      }),
      materializeCatalogItem('srd_5_2_1:arrows-20', {
        stock_id: 'starter-arrows', quantity: 5,
        properties: 'Боеприпасы для лука; не являются самостоятельным оружием.',
      }),
    ],
    services: [{
      service_id: 'starter-courier',
      name: 'Доставка письма',
      description: 'Торговец передаст обычное письмо по ближайшему безопасному торговому маршруту.',
      kind: 'other',
      base_price_cp: 50,
      duration_minutes: 10,
    }],
    restock_policy: {
      enabled: true,
      interval_minutes: 1_440,
      targets: [
        { stock_id: 'starter-healing-potion', target_quantity: 3 },
        { stock_id: 'starter-hempen-rope', target_quantity: 4 },
        { stock_id: 'starter-rations', target_quantity: 12 },
        { stock_id: 'starter-torch', target_quantity: 10 },
        { stock_id: 'starter-arrows', target_quantity: 5 },
      ],
    },
  })
}

export function findMerchant(state, merchantId) {
  const expected = cleanId(merchantId)
  return (Array.isArray(state?.merchants) ? state.merchants : []).find((merchant) => String(merchant.id) === expected) ?? null
}

export function bargainFor(merchant, actorId) {
  return merchant?.bargains?.[String(actorId ?? '')] ?? null
}

/**
 * `reputationBps` — поправка от репутации отряда у фракций торговца
 * (`server/reputation-policy.mjs`). Она приходит извне, а не считается здесь:
 * ценообразование не должно знать про фракции, а репутация — про наценки.
 * Ноль по умолчанию сохраняет прежнее поведение для вызовов без состояния.
 * Итог всё равно зажат прежними `min/max_multiplier_bps`, поэтому репутация
 * не может увести цену за границы политики торговца.
 */
function pricingMultipliers(merchant, actorId, reputationBps = 0) {
  const pricing = normalizeMerchantPricing(merchant?.pricing)
  const bargain = bargainFor(merchant, actorId)
  const bargainAdjustment = clampInteger(bargain?.pricing_adjustment_bps, -5_000, 5_000, 0)
  const reputation = clampInteger(reputationBps, -1_000, 1_000, 0)
  const buyBeforeBargain = pricing.buy_markup_bps + pricing.agent_adjustment_bps + reputation
  const sellBeforeBargain = pricing.sell_rate_bps - pricing.agent_adjustment_bps - reputation
  return {
    pricing,
    bargain,
    bargainAdjustment,
    reputationBps: reputation,
    buy: Math.max(pricing.min_multiplier_bps, Math.min(pricing.max_multiplier_bps, buyBeforeBargain + bargainAdjustment)),
    sell: Math.max(pricing.min_multiplier_bps, Math.min(pricing.max_multiplier_bps, sellBeforeBargain - bargainAdjustment)),
    buyBeforeBargain,
    sellBeforeBargain,
  }
}

export function findMerchantService(merchant, serviceId) {
  const expected = cleanId(serviceId)
  return (Array.isArray(merchant?.services) ? merchant.services : [])
    .find((service) => String(service?.service_id ?? '') === expected) ?? null
}

/** Price a configured service with the same bounded merchant/bargain policy as goods. */
export function quoteMerchantService(merchant, actorId, service, reputationBps = 0) {
  if (!service || typeof service !== 'object' || Array.isArray(service)) return null
  const normalized = normalizeMerchantServices([service])[0]
  if (!normalized || !normalized.available) return null
  const multipliers = pricingMultipliers(merchant, actorId, reputationBps)
  return {
    service_id: normalized.service_id,
    base_price_cp: normalized.base_price_cp,
    price_cp: Math.ceil(normalized.base_price_cp * multipliers.buy / 10_000),
    merchant_adjustment_bps: multipliers.buyBeforeBargain - 10_000,
    bargain_adjustment_bps: multipliers.bargainAdjustment,
    reputation_adjustment_bps: multipliers.reputationBps,
    multiplier_bps: multipliers.buy,
    price_provenance: normalized.price_provenance,
    policy_id: MERCHANT_SERVICES_POLICY_ID,
  }
}

/**
 * Produces a deterministic, non-authoritative settlement proposal. The Rules
 * Engine must later validate and commit a dedicated service command because a
 * service effect (repair, travel, lodging, etc.) is domain-specific.
 */
export function merchantServiceProposal(state, merchantId, actorId, serviceId) {
  const merchant = findMerchant(state, merchantId)
  const actor = (Array.isArray(state?.players) ? state.players : [])
    .find((player) => String(player?.id ?? '') === String(actorId ?? ''))
  const service = findMerchantService(merchant, serviceId)
  if (!merchant || !actor || !service || !merchant.available || !service.available) return null
  if (service.requires_presence && !merchantIsAtLocation(merchant, state?.scene)) return null
  const quote = quoteMerchantService(merchant, actor.id, service)
  if (!quote) return null
  const balance = normalizeCurrency(actor.currency)
  const balanceCp = currencyToCopper(balance)
  return {
    proposal_version: 1,
    command_type: 'PurchaseMerchantService',
    merchant_id: merchant.id,
    actor_id: String(actor.id),
    service_id: service.service_id,
    expected_state_version: Math.max(0, safeInteger(state?.state_version, 0)),
    price_cp: quote.price_cp,
    can_afford: balanceCp >= quote.price_cp,
    requires_presence: service.requires_presence,
    duration_minutes: service.duration_minutes,
    policy_id: MERCHANT_SERVICES_POLICY_ID,
  }
}

function normalizedWorldMinute(value) {
  return clampInteger(value, 0, MAX_WORLD_MINUTE, 0)
}

/**
 * Computes one due restock checkpoint. A large jump in campaign time restores
 * stock to target once, then writes the current minute as the checkpoint. This
 * prevents a server restart from multiplying stock for every missed interval.
 */
export function planMerchantRestock(merchant, worldMinute) {
  const normalized = normalizeMerchant(merchant)
  const policy = normalized.restock_policy
  const processedAt = normalizedWorldMinute(worldMinute)
  if (!policy.enabled) return null
  const baseline = policy.last_restock_world_minute ?? 0
  const scheduledFor = baseline + policy.interval_minutes
  if (processedAt < scheduledFor) return null
  const stockById = new Map(normalized.stock.map((entry) => [entry.stock_id, entry]))
  const entries = policy.targets.flatMap((target) => {
    const stock = stockById.get(target.stock_id)
    if (!stock) return []
    const before = clampInteger(stock.quantity, 0, MAX_STOCK_QUANTITY, 0)
    const after = Math.max(before, target.target_quantity)
    if (after === before) return []
    return [{
      stock_id: stock.stock_id,
      catalog_id: stock.catalog_id,
      quantity_before: before,
      quantity_added: after - before,
      quantity_after: after,
      stock: clone(stock),
    }]
  })
  return {
    schema_version: 1,
    policy_id: MERCHANT_RESTOCK_POLICY_ID,
    merchant_id: normalized.id,
    scheduled_for_world_minute: scheduledFor,
    processed_at_world_minute: processedAt,
    overdue_intervals: Math.max(1, Math.floor((processedAt - baseline) / policy.interval_minutes)),
    entries,
    total_quantity_added: entries.reduce((total, entry) => total + entry.quantity_added, 0),
  }
}

/** Returns every due merchant plan for a single authoritative campaign-time tick. */
export function planMerchantEconomyClock(state, { worldMinute } = {}) {
  const minute = normalizedWorldMinute(worldMinute ?? state?.mechanics?.world_time?.elapsed_minutes)
  return (Array.isArray(state?.merchants) ? state.merchants : [])
    .map((merchant) => planMerchantRestock(merchant, minute))
    .filter(Boolean)
}

/**
 * Creates the existing RestockMerchant payload when stock actually changes.
 * A no-op due plan still needs a separate clock checkpoint event to persist its
 * processed minute; `merchantEconomyClockEventFromPlan` supplies that contract.
 */
export function merchantRestockCommandFromPlan(merchant, plan) {
  const expected = planMerchantRestock(merchant, plan?.processed_at_world_minute)
  if (!expected || expected.merchant_id !== String(plan?.merchant_id ?? '') || !expected.entries.length) return null
  return {
    command_type: 'RestockMerchant',
    merchant_id: expected.merchant_id,
    items: expected.entries.map((entry) => ({
      stock_id: entry.stock_id,
      catalog_id: entry.catalog_id,
      quantity: entry.quantity_added,
      name: entry.stock.name,
      type: entry.stock.type,
      weight: entry.stock.weight,
      rarity: entry.stock.rarity,
      description: entry.stock.description,
      properties: entry.stock.properties,
    })),
  }
}

/** Event contract for the future reducer; it advances a due no-op checkpoint safely. */
export function merchantEconomyClockEventFromPlan(merchant, plan) {
  const expected = planMerchantRestock(merchant, plan?.processed_at_world_minute)
  if (!expected || expected.merchant_id !== String(plan?.merchant_id ?? '')) return null
  return {
    event_type: MERCHANT_ECONOMY_CLOCK_EVENT_TYPE,
    visibility: 'admin',
    payload: {
      policy_id: MERCHANT_RESTOCK_POLICY_ID,
      merchant_id: expected.merchant_id,
      scheduled_for_world_minute: expected.scheduled_for_world_minute,
      processed_at_world_minute: expected.processed_at_world_minute,
      overdue_intervals: expected.overdue_intervals,
    },
  }
}

/**
 * Pure replay helper for the future clock event. It intentionally recomputes
 * the plan instead of trusting caller-supplied quantities or stock data.
 */
export function applyMerchantRestockPlan(merchant, plan) {
  const normalized = normalizeMerchant(merchant)
  const expected = planMerchantRestock(normalized, plan?.processed_at_world_minute)
  if (!expected || expected.merchant_id !== String(plan?.merchant_id ?? '')) return normalized
  const byId = new Map(expected.entries.map((entry) => [entry.stock_id, entry]))
  const stock = normalized.stock.map((entry) => {
    const planned = byId.get(entry.stock_id)
    return planned ? { ...entry, quantity: planned.quantity_after } : entry
  })
  return normalizeMerchant({
    ...normalized,
    stock,
    restock_policy: {
      ...normalized.restock_policy,
      last_restock_world_minute: expected.processed_at_world_minute,
    },
  })
}

export function quoteMerchantBuyUnit(merchant, actorId, stockEntry, reputationBps = 0) {
  const base = resolveCatalogBasePriceCp(stockEntry) || trustedStockAppraisalFor(stockEntry)?.base_price_cp || 0
  if (!base) return null
  const multipliers = pricingMultipliers(merchant, actorId, reputationBps)
  return {
    base_unit_price_cp: base,
    unit_price_cp: Math.max(1, Math.ceil(base * multipliers.buy / 10_000)),
    merchant_adjustment_bps: multipliers.buyBeforeBargain - 10_000,
    bargain_adjustment_bps: multipliers.bargainAdjustment,
    reputation_adjustment_bps: multipliers.reputationBps,
    multiplier_bps: multipliers.buy,
  }
}

export function quoteMerchantSellUnit(merchant, actorId, item, appraisal = null, reputationBps = 0) {
  const base = trustedBasePriceCp(item, appraisal)
  if (!base) return null
  const multipliers = pricingMultipliers(merchant, actorId, reputationBps)
  const valuable = ['treasure', 'trade_good', 'trade-good', 'valuable'].includes(String(item?.type || '').toLowerCase())
  // Ценности выкупают по каталогу, но репутация действует и здесь: она
  // описывает отношение, а не сорт товара.
  const sellBeforeBargain = (valuable ? 10_000 : multipliers.pricing.sell_rate_bps)
    - multipliers.pricing.agent_adjustment_bps - multipliers.reputationBps
  const sellMultiplier = Math.max(multipliers.pricing.min_multiplier_bps, Math.min(
    multipliers.pricing.max_multiplier_bps,
    sellBeforeBargain - multipliers.bargainAdjustment,
  ))
  return {
    base_unit_price_cp: base,
    unit_price_cp: Math.max(1, Math.floor(base * sellMultiplier / 10_000)),
    merchant_adjustment_bps: sellBeforeBargain - 10_000,
    bargain_adjustment_bps: -multipliers.bargainAdjustment,
    reputation_adjustment_bps: multipliers.reputationBps,
    multiplier_bps: sellMultiplier,
    value_class: valuable ? 'valuable' : 'equipment',
  }
}

export function inventoryItemFromStock(stockEntry) {
  const source = stockEntry && typeof stockEntry === 'object' && !Array.isArray(stockEntry) ? stockEntry : {}
  const materialized = materializeCatalogItem(source.catalog_id ?? source.catalogId, {
    ...source,
    id: source.item_id ?? source.id ?? source.catalog_id ?? source.stock_id,
    quantity: 1,
    equipped: false,
  })
  return normalizeInventoryItem(materialized, { idFallback: 'item', preserveUnknown: false })
}

export function sellability(item, appraisal = null) {
  if (!item || typeof item !== 'object') return { can_sell: false, reason: 'Предмет не найден' }
  if (item.equipped) return { can_sell: false, reason: 'Сначала снимите предмет' }
  if (item.attuned_to) return { can_sell: false, reason: 'Сначала разорвите настройку с предметом' }
  if (item.quest_item === true || item.sellable === false || String(item.type || '').toLowerCase() === 'quest' || String(item.rarity || '').toLocaleLowerCase('ru') === 'сюжетный') {
    return { can_sell: false, reason: 'Сюжетный предмет нельзя продать' }
  }
  if (!trustedBasePriceCp(item, appraisal)) return { can_sell: false, reason: 'Предмет нужно сначала оценить у торговца' }
  return { can_sell: true, reason: null }
}

function publicMerchant(merchant) {
  const pricing = normalizeMerchantPricing(merchant.pricing)
  const services = normalizeMerchantServices(merchant.services)
  const restockPolicy = normalizeMerchantRestockPolicy(merchant.restock_policy, merchant.stock)
  return {
    id: merchant.id,
    name: merchant.name,
    title: merchant.title,
    description: merchant.description,
    greeting: merchant.greeting,
    voice: merchant.voice,
    initials: merchant.initials,
    portrait: merchant.portrait,
    location: merchant.location,
    location_id: merchant.location_id,
    available: merchant.available,
    purse_cp: normalizeMerchantPurseCp(merchant.purse_cp),
    stock: merchant.stock.map((stock) => ({
      stock_id: stock.stock_id,
      catalog_id: stock.catalog_id,
      name: stock.name,
      type: stock.type,
      quantity: stock.quantity,
      base_price_cp: resolveCatalogBasePriceCp(stock) || trustedStockAppraisalFor(stock)?.base_price_cp || 0,
      price_provenance: resolveCatalogPrice(stock)?.provenance ?? (trustedStockAppraisalFor(stock) ? 'server_appraisal_policy' : null),
      weight: stock.weight,
      rarity: stock.rarity,
      description: stock.description,
      properties: stock.properties,
      image: stock.image,
      imagePosition: stock.imagePosition,
    })),
    services: services.map((service) => ({
      service_id: service.service_id,
      name: service.name,
      description: service.description,
      kind: service.kind,
      base_price_cp: service.base_price_cp,
      duration_minutes: service.duration_minutes,
      available: service.available,
      requires_presence: service.requires_presence,
      tags: service.tags,
      price_provenance: service.price_provenance,
      policy_id: service.policy_id,
    })),
    restock: {
      enabled: restockPolicy.enabled,
      interval_minutes: restockPolicy.interval_minutes,
      last_restock_world_minute: restockPolicy.last_restock_world_minute,
    },
    pricing: {
      mode: pricing.mode,
      catalog_id: pricing.catalog_id,
      buy_markup_percent: Math.round((pricing.buy_markup_bps - 10_000 + pricing.agent_adjustment_bps) / 100),
      sell_rate_percent: Math.round((pricing.sell_rate_bps - pricing.agent_adjustment_bps) / 100),
      agent_adjustment_limit_percent: pricing.agent_adjustment_limit_percent,
      description: pricing.description,
    },
  }
}

export function publicMerchantFor(merchant) {
  return publicMerchant(merchant)
}

export function merchantViewFor(state, merchantId, actorId) {
  const merchant = findMerchant(state, merchantId)
  const actor = (Array.isArray(state?.players) ? state.players : []).find((player) => String(player.id) === String(actorId ?? ''))
  if (!merchant || !actor) return null
  const balance = normalizeCurrency(actor.currency)
  const balanceCp = currencyToCopper(balance)
  const merchantPurseCp = normalizeMerchantPurseCp(merchant.purse_cp)
  const bargain = bargainFor(merchant, actor.id)
  // Витрина обязана считать той же формулой, что и сделка. Без этой поправки
  // игрок видел одну цену, а Rules Engine брал другую — ревью 2026-07-28
  // поймало расхождение сразу после подключения репутации к исполнению.
  const standing = reputationStandingFor(state, merchant.id)
  const reputationBps = standing.price_adjustment_bps
  const buyQuotes = merchant.stock.filter((stock) => stock.quantity > 0).flatMap((stock) => {
    const quote = quoteMerchantBuyUnit(merchant, actor.id, stock, reputationBps)
    if (!quote) return []
    const maxQuantity = Math.min(stock.quantity, Math.floor(balanceCp / quote.unit_price_cp), MAX_TRANSACTION_QUANTITY)
    return [{
      quote_id: `buy:${merchant.id}:${actor.id}:${stock.stock_id}`,
      state_version: Math.max(0, safeInteger(state?.state_version, 0)),
      expected_state_version: Math.max(0, safeInteger(state?.state_version, 0)),
      direction: 'buy',
      actor_id: actor.id,
      stock_id: stock.stock_id,
      catalog_id: stock.catalog_id,
      item: inventoryItemFromStock(stock),
      available_quantity: stock.quantity,
      quantity: 1,
      unit_price_cp: quote.unit_price_cp,
      total_price_cp: quote.unit_price_cp,
      can_afford: balanceCp >= quote.unit_price_cp,
      // Отказ по розыску виден в витрине, а не только в ошибке команды: игрок
      // должен понимать, почему лавка закрыта, до того как нажмёт кнопку.
      ...(standing.trade_available === false
        ? { can_buy: false, unavailable_reason: standing.trade_refusal_reason }
        : {}),
      max_quantity: standing.trade_available === false ? 0 : maxQuantity,
      price_provenance: resolveCatalogPrice(stock)?.provenance ?? (trustedStockAppraisalFor(stock) ? 'server_appraisal_policy' : null),
      breakdown: {
        catalog_base_unit_cp: quote.base_unit_price_cp,
        merchant_adjustment_percent: quote.merchant_adjustment_bps / 100,
        bargain_adjustment_percent: quote.bargain_adjustment_bps / 100,
        reputation_adjustment_percent: quote.reputation_adjustment_bps / 100,
        final_unit_price_cp: quote.unit_price_cp,
      },
    }]
  })
  const sellQuotes = (Array.isArray(actor.inventory) ? actor.inventory : []).flatMap((item) => {
    const appraisal = trustedItemAppraisalFor(state, actor.id, item)
    const quote = quoteMerchantSellUnit(merchant, actor.id, item, appraisal, reputationBps)
    const allowed = sellability(item, appraisal)
    const catalogPrice = resolveCatalogPrice(item)
    const appraisalBlocked = item?.quest_item === true || item?.sellable === false || String(item?.type || '').toLowerCase() === 'quest' || String(item?.rarity || '').toLocaleLowerCase('ru') === 'сюжетный'
    const appraisalRequired = !catalogPrice && !appraisal && !appraisalBlocked
    if (!quote && !item?.id) return []
    const quantity = clampInteger(item?.quantity, 1, MAX_STOCK_QUANTITY, 1)
    const affordableQuantity = quote ? Math.floor(merchantPurseCp / quote.unit_price_cp) : 0
    const canAfford = Boolean(quote) && affordableQuantity >= 1
    return [{
      quote_id: `sell:${merchant.id}:${actor.id}:${String(item.id)}`,
      state_version: Math.max(0, safeInteger(state?.state_version, 0)),
      expected_state_version: Math.max(0, safeInteger(state?.state_version, 0)),
      direction: 'sell',
      actor_id: actor.id,
      item_id: String(item.id),
      catalog_id: cleanId(item.catalog_id),
      item: clone(item),
      available_quantity: quantity,
      quantity: 1,
      unit_price_cp: quote?.unit_price_cp ?? 0,
      total_price_cp: quote?.unit_price_cp ?? 0,
      can_sell: allowed.can_sell && canAfford && standing.trade_available !== false,
      can_afford: canAfford,
      ...(standing.trade_available === false ? { unavailable_reason: standing.trade_refusal_reason } : {}),
      appraisal_required: appraisalRequired,
      can_appraise: appraisalRequired,
      price_provenance: catalogPrice?.provenance ?? appraisal?.provenance ?? null,
      ...(appraisal ? { appraisal_id: appraisal.appraisal_id ?? appraisal.appraisal_fingerprint } : {}),
      reason: allowed.reason ?? (canAfford ? null : 'У торговца недостаточно монет для выкупа предмета'),
      max_quantity: allowed.can_sell ? Math.min(quantity, affordableQuantity, MAX_TRANSACTION_QUANTITY) : 0,
      breakdown: quote ? {
        catalog_base_unit_cp: quote.base_unit_price_cp,
        merchant_adjustment_percent: quote.merchant_adjustment_bps / 100,
        bargain_adjustment_percent: quote.bargain_adjustment_bps / 100,
        reputation_adjustment_percent: quote.reputation_adjustment_bps / 100,
        final_unit_price_cp: quote.unit_price_cp,
      } : undefined,
    }]
  })
  const serviceQuotes = (Array.isArray(merchant.services) ? merchant.services : []).flatMap((service) => {
    const quote = quoteMerchantService(merchant, actor.id, service, reputationBps)
    if (!quote) return []
    return [{
      quote_id: `service:${merchant.id}:${actor.id}:${quote.service_id}`,
      state_version: Math.max(0, safeInteger(state?.state_version, 0)),
      expected_state_version: Math.max(0, safeInteger(state?.state_version, 0)),
      direction: 'service',
      actor_id: String(actor.id),
      merchant_id: merchant.id,
      service_id: quote.service_id,
      service: normalizeMerchantServices([service])[0],
      price_cp: quote.price_cp,
      can_afford: balanceCp >= quote.price_cp,
      // Отказ по славе виден в витрине, а не только в ошибке команды: кнопка
      // недоступна по объявленной причине, без невидимых сюжетных стен.
      available: merchant.available && service.available !== false && standing.services_available,
      ...(standing.services_available
        ? {}
        : { unavailable_reason: standing.trade_available === false
          ? standing.trade_refusal_reason
          : 'Торговец не станет оказывать услуги отряду с такой славой' }),
      price_provenance: quote.price_provenance,
      breakdown: {
        base_price_cp: quote.base_price_cp,
        merchant_adjustment_percent: quote.merchant_adjustment_bps / 100,
        bargain_adjustment_percent: quote.bargain_adjustment_bps / 100,
        reputation_adjustment_percent: quote.reputation_adjustment_bps / 100,
        final_price_cp: quote.price_cp,
      },
      policy_id: MERCHANT_SERVICES_POLICY_ID,
    }]
  })
  const pricing = normalizeMerchantPricing(merchant.pricing)
  return {
    state_version: Math.max(0, safeInteger(state?.state_version, 0)),
    expected_state_version: Math.max(0, safeInteger(state?.state_version, 0)),
    merchant: publicMerchant(merchant),
    actor_id: String(actor.id),
    balance,
    balance_cp: balanceCp,
    merchant_purse_cp: merchantPurseCp,
    buy_quotes: buyQuotes,
    sell_quotes: sellQuotes,
    service_quotes: serviceQuotes,
    bargain: bargain ? {
      attempted: true,
      success: bargain.success,
      discount_percent: bargain.success ? Math.abs(Math.min(0, bargain.pricing_adjustment_bps)) / 100 : 0,
      modifier_percent: -bargain.pricing_adjustment_bps / 100,
      message: bargain.success ? 'Торговец согласился на более выгодные условия.' : 'Торговец не уступил и немного ужесточил цену.',
      roll_total: bargain.roll_total,
      difficulty: bargain.difficulty,
      pricing_adjustment_bps: bargain.pricing_adjustment_bps,
    } : null,
    pricing_explanation: `Базовые цены: ${pricing.catalog_id}. Покупка и продажа рассчитаны сервером; продажа округляется вниз, а минимальная выплата 1 мм. является политикой ${ECONOMY_POLICY_ID}.`,
  }
}
