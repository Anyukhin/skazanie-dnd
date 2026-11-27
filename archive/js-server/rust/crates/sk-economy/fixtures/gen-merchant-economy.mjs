import '../../../fixtures-env.mjs'
// Эталоны `server/merchant-economy.mjs` для Rust-переноса (`sk-economy`).
//
// Два файла: `merchant-economy.json` — функции модуля на сотнях вещей,
// политик цены, услуг, складов и торговцев (в том числе мусорных записей из
// старых сохранений), котировки, часы лавки; `merchant-economy-states.json` —
// витрина, доступность и предложения услуг на состояниях кампании: собранных
// из мусора и сыгранных JS Rules Engine (торг на детерминированных костях,
// оценка, продажа и покупка), с репутацией, розыском, скупщиком, пленом и
// расписанием NPC.
//
// Где JS на мусоре падает `TypeError` (каталожный код-свойство прототипа при
// материализации, склад не массивом у сырой записи), случай пишется как
// исключение: Rust сознательно не падает, тест проверяет только, что вызов
// не паникует.
//
// Запуск: node rust/crates/sk-economy/fixtures/gen-merchant-economy.mjs
import { PROTOTYPE_KEYS, recorder, rng, viaJson } from './record.mjs'
import { junkFactory } from './junk.mjs'

const url = (path) => new URL(`../../../../server/${path}`, import.meta.url).href
const M = await import(url('merchant-economy.mjs'))
const C = await import(url('item-catalog.mjs'))
const A = await import(url('item-appraisal.mjs'))
const R = await import(url('rules-engine.mjs'))
const D = await import(url('dice-service.mjs'))

const ALL_IDS = [...Object.keys(C.ITEM_CATALOG), ...Object.keys(C.SCENARIO_ITEM_CATALOG)]
const SHOP_IDS = Object.keys(C.SRD_EQUIPMENT_CATALOG)
const random = rng(20261014)
const J = junkFactory(random, ALL_IDS)
const { pick, int, chance } = J

// ---------- входы ----------

function pricingInput() {
  if (chance(0.1)) return J.junk(1)
  const pricing = {}
  for (const [key, values] of [
    ['mode', ['catalog', 'catalog_with_agent_adjustment', 'free', null]],
    ['catalog_id', ['srd_5_2_1', '  srd  ', '', null, 7]],
    ['buy_markup_bps', [11_000, 10_750, 999_999, 50, '12000', 2.5, null, 'x']],
    ['buy_markup_percent', [10, -20, 1e300, 2.5, '15', 'x']],
    ['sell_rate_bps', [5_000, 4_000, 60_000, '3000', 2.5, null]],
    ['sell_rate_percent', [50, 33.3, 1e300, 'x']],
    ['bargain_dc', [15, 99, 2, '20', null]],
    ['success_discount_bps', [1_000, 9_000, -5]],
    ['failure_markup_bps', [500, 6_000, '200']],
    ['min_multiplier_bps', [1_000, 50, 40_000, '2000', null]],
    ['max_multiplier_bps', [30_000, 60_000, 500, '25000']],
    ['agent_adjustment_bps', [0, 2_000, -2_000, 999_999, -999_999, 1.5, '300', null]],
    ['agent_adjustment_percent', [5, -12.345, 0.004, -0.004, 1e307, 'x']],
    ['agent_adjustment_limit_percent', [20, 0, 999, '10', -5]],
    ['description', ['Каталожная цена', '']],
    ['secret_policy', ['не показывать']],
  ]) {
    if (chance(0.45)) pricing[key] = pick(values)
  }
  return pricing
}

function serviceInput(index) {
  if (chance(0.1)) return J.junk(1)
  const service = {}
  if (chance(0.8)) service[pick(['service_id', 'serviceId', 'id'])] = pick([`svc-${index % 4}`, '  repair  ', '', 'lodging', 7, null])
  if (chance(0.7)) service.name = pick(['Ремонт', '  ', 'Ночлег', 'z'.repeat(130)])
  if (chance(0.4)) service.description = pick(['Чинит доспех', ''])
  if (chance(0.7)) service.kind = pick(['repair', 'LODGING', 'transport', 'training', 'appraisal', 'other', 'heist', null])
  if (chance(0.8)) service[pick(['base_price_cp', 'basePriceCp'])] = pick([100, 0, 55, -1, 1e9, '40', 2.5, null])
  if (chance(0.5)) service[pick(['duration_minutes', 'durationMinutes'])] = pick([30, 0, 99_999, '60'])
  if (chance(0.3)) service.available = pick([true, false, 'no', null])
  if (chance(0.3)) service[pick(['requires_presence', 'requiresPresence'])] = pick([true, false, 'false'])
  if (chance(0.4)) service.tags = pick([['craft', 'craft', ''], 'craft', Array.from({ length: 15 }, (_, tag) => `t${tag % 13}`), [7, null, ' x ']])
  if (chance(0.15)) service.forged_secret = 'не переносить'
  return service
}

function appraisalFor(actorId, merchantId, item, { tamper = null } = {}) {
  const stackKey = M.inventoryStackKey(item)
  const digest = String(stackKey).split(':').at(-1) || 'custom'
  const appraisal = A.appraiseItem({
    homebrew_id: `homebrew:${digest}`,
    name: 'Предмет',
    category: pick(['treasure', 'weapon', 'tool', 'miscellaneous']),
    rarity: pick(['common', 'uncommon', 'rare']),
    condition: 'serviceable',
  }, { policyId: A.CATEGORY_APPRAISAL_POLICY_ID })
  const record = {
    ...appraisal,
    appraisal_id: `appraisal:${appraisal.appraisal_fingerprint.slice(0, 24)}`,
    actor_id: String(actorId),
    merchant_id: String(merchantId),
    item_id: String(item.id ?? item.item_id ?? ''),
    item_stack_key: stackKey,
  }
  if (tamper === 'fingerprint') record.appraisal_fingerprint = 'F'.repeat(64)
  if (tamper === 'stack') record.item_stack_key = 'custom:forged'
  if (tamper === 'actor') record.actor_id = 'someone-else'
  if (tamper === 'price') record.base_price_cp = 999_999_999
  if (tamper === 'policy') record.policy_id = 'agent:free'
  if (tamper === 'unit') {
    delete record.base_price_cp
    record.base_unit_price_cp = 777
  }
  return record
}

function stockEntry(merchantId, index) {
  const roll = random()
  if (roll < 0.08) return J.junk(1)
  if (roll < 0.18) {
    // Перепроданная вещь с подтверждённой (или подделанной) оценкой.
    const item = { id: `resale-${index}`, name: 'Осколок', type: 'treasure', quantity: 1 }
    const entry = { ...item, stock_id: chance(0.8) ? `resale-${index}` : '', quantity: pick([1, 2, 0]) }
    entry.appraisal = appraisalFor('hero', merchantId, { ...entry, catalog_id: '' }, { tamper: pick([null, null, 'fingerprint', 'stack', 'price', 'unit']) })
    return entry
  }
  if (roll < 0.28) {
    return { stock_id: pick([`nested-${index}`, 'dup', '']), quantity: pick([1, 3, '4', -2]), item: chance(0.8) ? J.inventoryItem(index) : J.junk(1) }
  }
  const entry = J.inventoryItem(index)
  if (chance(0.85)) entry[pick(['stock_id', 'stockId'])] = pick([`stock-${index}`, 'dup', 'dup', ' dup ', '', 'x'.repeat(130), null])
  if (chance(0.5)) entry.catalog_id = chance(0.8) ? pick(SHOP_IDS) : J.catalogRef()
  return entry
}

function merchantInput(index) {
  if (chance(0.06)) return J.junk(1)
  const merchant = {}
  const id = pick([`merchant-${index}`, `merchant-${index}`, `merchant-${index % 7}`, ` trader-${index % 5} `, '', null, 42, 'x'.repeat(130)])
  if (chance(0.85)) merchant[chance(0.85) ? 'id' : 'merchant_id'] = id
  if (chance(0.8)) merchant.name = pick(['Мартен', '  Илара  ', '', null, 'n'.repeat(130)])
  for (const key of ['title', 'description', 'greeting', 'voice']) if (chance(0.3)) merchant[key] = pick(['Текст', '', null, 7])
  if (chance(0.7)) merchant.location = pick(['Рыночная площадь', 'РЫНОЧНАЯ   ПЛОЩАДЬ', '', ' Порт ', null, 'Ｍａｒｋｅｔ'])
  if (chance(0.3)) merchant[pick(['location_id', 'locationId'])] = pick(['market', ' port ', '', null])
  if (chance(0.5)) merchant.available = pick([true, false, 'no', null, 0])
  if (chance(0.5)) merchant[pick(['purse_cp', 'purseCp'])] = pick([12_345, 0, -1, 1.5, 9_000_000_001, '500', null, 99])
  if (chance(0.7)) merchant.pricing = pricingInput()
  if (chance(0.85)) merchant.stock = chance(0.92) ? Array.from({ length: int(0, 7) }, (_, stockIndex) => stockEntry(String(id), index * 10 + stockIndex)) : J.junk(1)
  if (chance(0.4)) {
    const bargains = {}
    for (let count = int(0, 3); count > 0; count -= 1) {
      bargains[pick(['hero', ' hero ', 'hero-2', '', '7', '0'])] = chance(0.85) ? {
        success: pick([true, false, 'yes']), status: pick(['success', 'failure', undefined]),
        roll_total: pick([12, 250, -200, '9']), total: pick([5, undefined]),
        natural_roll: pick([10, 25, 0, undefined]), kept: pick([3, undefined]),
        modifier: pick([5, 99, -99]), difficulty: pick([15, 2, 40]),
        pricing_adjustment_bps: pick([-1_000, 500, -9_999, 9_999, '200', null]),
        resolved_at: pick(['2026-07-12T00:00:00.000Z', null, 12345, 'r'.repeat(90), undefined]),
      } : J.junk(1)
    }
    merchant.bargains = chance(0.9) ? JSON.parse(JSON.stringify(bargains)) : J.junk(1)
  }
  if (chance(0.5)) merchant.services = chance(0.9) ? Array.from({ length: int(0, 4) }, (_, serviceIndex) => serviceInput(serviceIndex)) : J.junk(1)
  if (chance(0.5)) {
    const stockIds = (Array.isArray(merchant.stock) ? merchant.stock : []).map((entry) => entry?.stock_id ?? entry?.stockId).filter((value) => typeof value === 'string')
    const policy = {
      enabled: pick([true, true, false, 'true']),
      [pick(['interval_minutes', 'intervalMinutes'])]: pick([60, 1_440, 10, 999_999, '120', null]),
      targets: Array.from({ length: int(0, 4) }, () => (chance(0.85) ? {
        [pick(['stock_id', 'stockId'])]: chance(0.8) ? pick([...stockIds, 'forged']) : pick(['', null, 7]),
        [pick(['target_quantity', 'targetQuantity', 'quantity'])]: pick([5, 0, -1, 2_000_000, '3', 2.5]),
      } : J.junk(1))),
    }
    if (chance(0.5)) policy[pick(['last_restock_world_minute', 'lastRestockWorldMinute'])] = pick([0, 60, 1_440, -5, 2e9, '30', null])
    merchant[pick(['restock_policy', 'restockPolicy', 'restock'])] = chance(0.9) ? policy : J.junk(1)
  }
  if (chance(0.2)) merchant.secret_inventory_note = 'не показывать игроку'
  if (chance(0.1)) merchant.initials = 'МР'
  if (chance(0.05)) merchant['3'] = 'индекс'
  return JSON.parse(JSON.stringify(merchant))
}

// ---------- merchant-economy.json ----------

const r = recorder('server/merchant-economy.mjs')
for (const name of [
  'ECONOMY_POLICY_ID', 'ECONOMY_CATALOG_VERSION', 'ECONOMY_CATALOG_SOURCE', 'MAX_CURRENCY_CP', 'DEFAULT_MERCHANT_PURSE_CP',
  'MAX_TRANSACTION_QUANTITY', 'MAX_STOCK_QUANTITY', 'MAX_UNIT_PRICE_CP', 'ITEM_APPRAISAL_CONTRACT_VERSION', 'ITEM_APPRAISAL_POLICY_ID',
  'MERCHANT_SERVICES_POLICY_ID', 'MERCHANT_RESTOCK_POLICY_ID', 'MERCHANT_ECONOMY_CLOCK_EVENT_TYPE', 'MIN_RESTOCK_INTERVAL_MINUTES',
  'MAX_RESTOCK_INTERVAL_MINUTES', 'MAX_WORLD_MINUTE',
]) r.constant(name, M[name])

const LOCATIONS = [undefined, null, '', 'Рыночная площадь', '  РЫНОЧНАЯ \t ПЛОЩАДЬ ', 'Ｍａｒｋｅｔ  Square', 7, ['a', 'b'],
  { location: 'Порт' }, { name: ' порт ' }, { location: 'Порт', location_id: 'port' }, { locationId: ' port ' },
  { location_id: 'market', location: 'Порт' }, { location: null, name: 'Порт' }, {}, 'x'.repeat(200)]
for (const value of LOCATIONS) {
  r.call('canonicalLocationKey', M.canonicalLocationKey, value)
  r.call('canonicalLocationId', M.canonicalLocationId, value)
}
for (const left of LOCATIONS) {
  for (const right of LOCATIONS) {
    if (chance(0.5)) continue
    r.call('locationsMatch', M.locationsMatch, left, right)
    r.call('merchantIsAtLocation', M.merchantIsAtLocation, left, right)
  }
}

for (let index = 0; index < 250; index += 1) {
  r.call('normalizeInventoryItemType', M.normalizeInventoryItemType, chance(0.5) ? J.junk() : pick(['Weapon', ' trade-good ', 'VALUABLE', 'document', 'потрох', '']))
  r.call('normalizeInventoryItemRarity', M.normalizeInventoryItemRarity, chance(0.5) ? J.junk() : pick(['СЮЖЕТНЫЙ', ' редкий ', 'Очень редкий', 'rare', '']))
  r.call('normalizeInventoryPassiveEffects', M.normalizeInventoryPassiveEffects, chance(0.85) ? Array.from({ length: int(0, 4) }, J.passiveEffect) : J.junk())
}
r.call('normalizeInventoryPassiveEffects', M.normalizeInventoryPassiveEffects, Array.from({ length: 40 }, (_, index) => ({ schema_version: 1, effect_id: `e${index}`, group: 'g', armor_class_bonus: 1 })))

const OPTIONS = [undefined, { preserveUnknown: true }, { hydrateCatalog: true }, { idFallback: 'stock', preserveUnknown: true, hydrateCatalog: true }]
for (let index = 0; index < 700; index += 1) {
  const item = chance(0.93) ? J.inventoryItem(index) : J.junk()
  r.call('inventoryStackKey', M.inventoryStackKey, item)
  r.call('normalizeInventoryItem', M.normalizeInventoryItem, item, pick(OPTIONS))
}
for (const catalogId of ALL_IDS) {
  const item = C.materializeCatalogItem(catalogId, { id: `cat-${catalogId}`, quantity: 2, origin: pick(['stolen', 'purchased']) })
  r.call('normalizeInventoryItem', M.normalizeInventoryItem, item, pick(OPTIONS))
  r.call('normalizeInventoryItem', M.normalizeInventoryItem, { catalog_id: catalogId, id: 'raw' }, { hydrateCatalog: true })
}

for (let index = 0; index < 150; index += 1) {
  const currency = chance(0.8) ? {
    copper: pick([0, 8, 99, 9_000_000_000, -1, '12', 2.5]), silver: pick([0, 14, 900_000_001]),
    gold: pick([0, 37, 100, 90_000_000]), platinum: pick([0, 1, 9_000_000, 9_000_001]),
  } : J.junk()
  r.call('normalizeCurrency', M.normalizeCurrency, currency)
  r.call('currencyToCopper', M.currencyToCopper, currency)
}
for (const amount of [0, 1, 9, 10, 99, 100, 999, 1_000, 1_111, 123_456_789, M.MAX_CURRENCY_CP - 1, M.MAX_CURRENCY_CP, M.MAX_CURRENCY_CP + 1, -5, 2.5, '1234', null, undefined, 'abc', [5]]) {
  r.call('copperToCurrency', M.copperToCurrency, amount)
}
for (const value of [undefined, null, 0, 1, 500, -1, 1.5, '700', M.MAX_CURRENCY_CP + 1, 'x', [3]]) {
  r.call('normalizeMerchantPurseCp', M.normalizeMerchantPurseCp, value)
  for (const fallback of [0, 777, -5, 'x', null, M.MAX_CURRENCY_CP * 2]) r.call('normalizeMerchantPurseCp', M.normalizeMerchantPurseCp, value, fallback)
}

for (const id of [...ALL_IDS, ...PROTOTYPE_KEYS, '', ' srd_5_2_1:dagger ', 'custom:ring', 'srd_5_2_1:DAGGER']) {
  r.call('resolveCatalogPrice', M.resolveCatalogPrice, { catalog_id: id, base_price_cp: 1 })
  r.call('resolveCatalogBasePriceCp', M.resolveCatalogBasePriceCp, { catalogId: id })
}
for (const value of [undefined, null, 'srd_5_2_1:dagger', 7, { catalog_id: null, catalogId: 'srd_5_2_1:torch' }]) {
  r.call('resolveCatalogPrice', M.resolveCatalogPrice, value)
  r.call('resolveCatalogBasePriceCp', M.resolveCatalogBasePriceCp, value)
}

for (let index = 0; index < 300; index += 1) r.call('normalizeMerchantPricing', M.normalizeMerchantPricing, pricingInput())
for (let index = 0; index < 150; index += 1) {
  const services = chance(0.9) ? Array.from({ length: int(0, 6) }, (_, serviceIndex) => serviceInput(serviceIndex)) : J.junk()
  r.call('normalizeMerchantServices', M.normalizeMerchantServices, services)
}
r.call('normalizeMerchantServices', M.normalizeMerchantServices, Array.from({ length: 120 }, (_, index) => ({ service_id: `s${index}`, base_price_cp: index })))

// Торговцы.
const MERCHANTS = Array.from({ length: 450 }, (_, index) => merchantInput(index))
for (const [index, merchant] of MERCHANTS.entries()) {
  r.call('normalizeMerchant', M.normalizeMerchant, merchant, index % 9)
  if (merchant && typeof merchant === 'object' && !Array.isArray(merchant)) {
    r.call('normalizeMerchantRestockPolicy', M.normalizeMerchantRestockPolicy, merchant.restock_policy ?? merchant.restock, merchant.stock)
  }
}
r.call('normalizeMerchant', M.normalizeMerchant, undefined)
for (let index = 0; index < 60; index += 1) {
  r.call('normalizeMerchants', M.normalizeMerchants, Array.from({ length: int(0, 8) }, () => pick(MERCHANTS)))
}
r.call('normalizeMerchants', M.normalizeMerchants, Array.from({ length: 130 }, (_, index) => ({ id: `m${index}`, name: 'М' })))
r.call('normalizeMerchants', M.normalizeMerchants, 'не список')

for (const options of [undefined, {}, { location: 'Рынок' }, { location: null, location_id: 'market' }, { locationId: 'port' },
  { location: 'Порт', location_id: '', locationId: ' port ' }, { location: 7, location_id: 0, locationId: null }]) {
  r.call('createStarterMerchant', M.createStarterMerchant, options)
}

const NORMALIZED = M.normalizeMerchants(MERCHANTS).concat([M.createStarterMerchant({ location: "Рынок" })])
console.log(`нормализованных торговцев: ${NORMALIZED.length}`)
const ACTORS = [undefined, null, "hero", " hero ", "hero-2", "7", 7, "0", "toString"]
const MERCHANT_FNS = {
  bargainFor: M.bargainFor,
  quoteMerchantBuyUnit: M.quoteMerchantBuyUnit,
  quoteMerchantService: M.quoteMerchantService,
  quoteMerchantSellUnit: M.quoteMerchantSellUnit,
  findMerchantService: M.findMerchantService,
  publicMerchantFor: M.publicMerchantFor,
  planMerchantRestock: M.planMerchantRestock,
  merchantRestockCommandFromPlan: M.merchantRestockCommandFromPlan,
  merchantEconomyClockEventFromPlan: M.merchantEconomyClockEventFromPlan,
  applyMerchantRestockPlan: M.applyMerchantRestockPlan,
}
for (const [merchantIndex, merchant] of NORMALIZED.entries()) {
  if (merchantIndex % 3 === 0) r.call("findMerchant", M.findMerchant, { merchants: NORMALIZED.slice(0, 6).concat([merchant]) }, pick([merchant.id, ` ${merchant.id} `, "missing", undefined, null]))
  const calls = []
  for (const actorId of ACTORS) {
    if (chance(0.6)) continue
    calls.push(["bargainFor", actorId])
    const reputation = pick([undefined, 0, 500, -1_000, 5_000, -5_000, "250", null, "x"])
    for (const stock of merchant.stock) calls.push(["quoteMerchantBuyUnit", actorId, stock, reputation])
    for (const service of [...merchant.services, null, { name: "x" }, ["repair"]]) calls.push(["quoteMerchantService", actorId, service, reputation])
  }
  for (const serviceId of [...merchant.services.map((service) => service.service_id), "missing", undefined]) calls.push(["findMerchantService", serviceId])
  calls.push(["publicMerchantFor"])
  for (const minute of [undefined, null, 0, 59, 60, 61, 1_440, 1_441, 5_000, 100_000, -5, 2e9, "1500"]) {
    calls.push(["planMerchantRestock", minute])
    const plan = M.planMerchantRestock(merchant, minute)
    if (!plan) continue
    const tampered = { ...plan, entries: plan.entries.map((entry) => ({ ...entry, quantity_added: 999_999, quantity_after: 999_999 })) }
    calls.push(["merchantRestockCommandFromPlan", plan], ["merchantEconomyClockEventFromPlan", plan], ["applyMerchantRestockPlan", plan],
      ["applyMerchantRestockPlan", tampered], ["merchantRestockCommandFromPlan", { ...plan, merchant_id: "someone-else" }],
      ["merchantEconomyClockEventFromPlan", { ...plan, processed_at_world_minute: 0 }])
  }
  r.bundle("merchant", merchant, calls, MERCHANT_FNS)
  for (const stock of merchant.stock) {
    r.call("inventoryItemFromStock", M.inventoryItemFromStock, stock)
    r.call("trustedStockAppraisalFor", M.trustedStockAppraisalFor, stock)
  }
}
for (const merchant of MERCHANTS.slice(0, 120)) {
  r.bundle("merchant", merchant, [["planMerchantRestock", pick([60, 1_440, 10_000])], ["applyMerchantRestockPlan", { merchant_id: merchant?.id, processed_at_world_minute: 5_000 }]], MERCHANT_FNS)
}

// Выкуп и сбыт: вещи героя с оценками, репутация, скидка скупщика.
for (let group = 0; group < 70; group += 1) {
  const merchant = pick(NORMALIZED)
  const calls = []
  for (let index = 0; index < 8; index += 1) {
    const raw = chance(0.85) ? J.inventoryItem(group * 8 + index) : J.junk()
    const item = chance(0.6) && raw && typeof raw === "object" && !Array.isArray(raw) ? M.normalizeInventoryItem(raw) : raw
    const actorId = pick(["hero", "hero-2", undefined])
    const appraisal = item && typeof item === "object" && !Array.isArray(item) && chance(0.6)
      ? appraisalFor(actorId ?? "hero", merchant.id, item, { tamper: pick([null, null, null, "fingerprint", "stack", "actor", "price", "policy", "unit"]) })
      : pick([null, undefined, J.junk(1)])
    calls.push(["quoteMerchantSellUnit", actorId, item, appraisal, pick([undefined, 0, 250, -1_000, 2_000]), pick([undefined, 0, 4_000, 9_500, "1000", -5])])
    r.call("sellability", M.sellability, item, appraisal)
    r.call("trustedItemAppraisalFor", M.trustedItemAppraisalFor,
      { mechanics: { item_appraisals: { [actorId ?? "hero"]: { [String(item?.id ?? "")]: appraisal } } } }, actorId, item)
  }
  r.bundle("merchant", merchant, calls, MERCHANT_FNS)
}
for (const item of [undefined, null, 'x', [], { equipped: true }, { attuned_to: 'hero' }, { catalog_id: 'srd_5_2_1:dagger' }, { catalog_id: 'srd_5_2_1:dagger', type: 'Quest' }, { catalog_id: 'srd_5_2_1:dagger', rarity: 'Сюжетный' }]) {
  r.call('sellability', M.sellability, item)
}

r.write('merchant-economy.json')

// ---------- merchant-economy-states.json ----------

const s = recorder('server/merchant-economy.mjs (state)')

function lawFor(level) {
  const crimes = { 0: [], 1: ['theft'], 2: ['murder'], 3: ['murder', 'arson'] }[level]
  return {
    worldMap: { currentLocationId: 'village', locations: [{ id: 'village', name: 'Брод', kind: 'village', regionId: 'north' }], regions: [{ id: 'north', name: 'Север' }] },
    law: { crimes: crimes.map((kind, index) => ({ id: `crime-${index}`, kind, region_id: 'north', at_minutes: 0 })) },
  }
}

function inventoryFor(actorId, merchantId, index) {
  const items = Array.from({ length: int(0, 6) }, (_, itemIndex) => {
    const raw = J.inventoryItem(index * 10 + itemIndex)
    return chance(0.75) ? M.normalizeInventoryItem(raw) : raw
  })
  if (chance(0.5)) items.push(M.normalizeInventoryItem(C.materializeCatalogItem(pick(SHOP_IDS), { id: `bought-${index}`, quantity: int(1, 3), origin: pick(['stolen', 'purchased', 'found']) })))
  const appraisals = {}
  for (const item of items) {
    if (!item || typeof item !== 'object' || item.catalog_id || !chance(0.5)) continue
    appraisals[String(item.id ?? '')] = appraisalFor(actorId, merchantId, item, { tamper: pick([null, null, 'stack', 'actor']) })
  }
  return { items, appraisals }
}

function junkState(index) {
  const merchants = Array.from({ length: int(1, 3) }, (_, merchantIndex) => merchantInput(index * 3 + merchantIndex))
  const normalized = chance(0.8) ? M.normalizeMerchants(merchants) : merchants
  const first = normalized.find((merchant) => merchant && typeof merchant === 'object') ?? {}
  const merchantId = String(first.id ?? 'merchant-1')
  const hero = inventoryFor('hero', merchantId, index)
  const players = [{
    id: 'hero', currency: pick([{ gold: 100 }, { gold: 1 }, { copper: 5 }, {}, { platinum: 2, silver: 3 }, null]),
    inventory: hero.items,
  }]
  if (chance(0.3)) players.push({ id: 7, currency: { gold: 3 }, inventory: [] })
  const state = {
    sessionCode: pick(['SHOP-UNIT', 'LAW', `S-${index}`]),
    state_version: pick([0, 3, 7, -2, '5', null]),
    scene: { location: pick([first.location, 'Рыночная площадь', 'Порт', '', undefined]), ...(chance(0.3) ? { location_id: pick(['market', 'port']) } : {}) },
    players,
    merchants: normalized,
    mechanics: { item_appraisals: { hero: hero.appraisals }, ...(chance(0.4) ? { world_time: { elapsed_minutes: pick([0, 60, 600, 1_500, 10_080]) } } : {}) },
  }
  if (chance(0.5)) {
    state.social = { npcs: [{
      id: merchantId, name: 'Купец', location: pick([first.location, 'Склад', '']), available: pick([true, false, undefined]),
      tags: pick([[], ['скупщик'], ['faction:guild'], ['faction:guild', 'faction:watch'], ['скупщик', 'faction:watch']]),
      ...(chance(0.4) ? { schedule: [{ id: 'away', days: [], start_minute: 0, end_minute: pick([30, 120]), location: pick(['Склад', first.location ?? '']), available: pick([true, false]) }] } : {}),
    }] }
  }
  if (chance(0.4)) state.autonomy = { reputations: { guild: pick([-80, -30, 0, 25, 60]), watch: pick([-60, 0, 55]) } }
  if (chance(0.15)) state.npc_world = { vitals: { [merchantId]: pick([{ hp: 0, alive: false }, { hp: 3 }, { hp: '0' }, 'x']) } }
  if (chance(0.15)) state.captives = pick([{ captives: [{ npc_id: merchantId, status: pick(['held', 'released']) }] }, [{ npc_id: merchantId, status: 'held' }]])
  if (chance(0.35)) Object.assign(state, lawFor(pick([0, 1, 2, 3])))
  return { state: viaJson(state), merchantId }
}

const STATE_FNS = {
  merchantViewFor: M.merchantViewFor,
  merchantTradeAvailabilityFor: M.merchantTradeAvailabilityFor,
  merchantServiceProposal: M.merchantServiceProposal,
  planMerchantEconomyClock: M.planMerchantEconomyClock,
}

function recordState(state, merchantIds) {
  const calls = []
  for (const merchantId of merchantIds) {
    for (const actorId of ["hero", 7, "missing"]) {
      if (actorId !== "hero" && chance(0.6)) continue
      calls.push(["merchantViewFor", merchantId, actorId])
    }
    for (const allowRemote of [false, true]) calls.push(["merchantTradeAvailabilityFor", merchantId, { allowRemote }])
    const merchant = M.findMerchant(state, merchantId)
    if (merchant) calls.push(["merchantTradeAvailabilityFor", merchant])
    for (const service of Array.isArray(merchant?.services) ? merchant.services : []) calls.push(["merchantServiceProposal", merchantId, "hero", service?.service_id])
    calls.push(["merchantServiceProposal", merchantId, "hero", "missing"])
  }
  calls.push(["planMerchantEconomyClock", pick([undefined, { worldMinute: 1_440 }, { worldMinute: "x" }, {}])])
  s.bundle("state", state, calls, STATE_FNS)
}

for (let index = 0; index < 200; index += 1) {
  const { state, merchantId } = junkState(index)
  recordState(state, [merchantId, 'missing'])
}
s.call('merchantTradeAvailabilityFor', M.merchantTradeAvailabilityFor, {}, undefined)
s.call('merchantTradeAvailabilityFor', M.merchantTradeAvailabilityFor, { scene: { location: 'Порт' } }, ['массив-торговец'])

// Сыгранные Rules Engine состояния: торг на серверном d20, оценка, сделки.
function dice(values) {
  let id = 0
  return new D.DiceService({ rng: new D.SequenceDiceRng(values), idFactory: () => `fixture-roll-${++id}`, now: () => '2026-07-12T00:00:00.000Z' })
}

function engineState(index) {
  const merchant = {
    id: 'marten', name: 'Мартен', location: 'Рыночная площадь', available: true,
    purse_cp: pick([100_000, 12_500, 99, 6_249]),
    tags: chance(0.3) ? ['скупщик'] : [],
    pricing: { buy_markup_bps: pick([11_000, 10_500, 12_000]), sell_rate_bps: 5_000, bargain_dc: pick([12, 15, 18]), success_discount_bps: 1_000, failure_markup_bps: 500, min_multiplier_bps: 1_000, max_multiplier_bps: 30_000, agent_adjustment_bps: pick([0, 500, -500]) },
    stock: [
      { stock_id: 'potion-stock', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье лечения', type: 'consumable', quantity: pick([0, 1, 3]) },
      { stock_id: 'rope', catalog_id: 'srd_5_2_1:rope-hempen-50-feet', name: 'Верёвка', type: 'tool', quantity: 2 },
    ],
    services: chance(0.6) ? [{ service_id: 'repair', name: 'Ремонт', kind: 'repair', base_price_cp: pick([100, 250]), duration_minutes: 30 }] : [],
  }
  return R.normalizeCampaignState({
    sessionCode: `SHOP-${index}`,
    state_version: 0,
    engine_mode: 'enforce',
    scene: { location: 'рыночная площадь' },
    players: [{
      id: 'hero', hp: 10, maxHp: 10, armor: 12, abilities: { cha: pick([8, 10, 14, 16, 20]) },
      skills: { persuasion_bonus: pick([0, 2, 5]) },
      currency: { copper: 0, silver: 0, gold: pick([1, 20, 100]), platinum: 0 },
      inventory: [
        { id: 'hero-dagger', catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', type: 'weapon', quantity: 2, equipped: false, origin: pick(['purchased', 'stolen']) },
        { id: 'moon-shard', name: 'Осколок лунного клинка', type: 'treasure', rarity: pick(['редкий', 'обычный']), quantity: 2, equipped: false },
        { id: 'quest-letter', name: 'Письмо короля', type: 'document', rarity: 'сюжетный', quantity: 1, equipped: false },
      ],
    }],
    merchants: [merchant],
    ...(chance(0.4) ? { social: { npcs: [{ id: 'marten', name: 'Мартен', location: 'рыночная площадь', tags: merchant.tags }] } } : {}),
    ...(chance(0.3) ? lawFor(pick([1, 2])) : {}),
  })
}

function tryCommand(state, command, rolls) {
  try {
    const result = R.resolveCommand({ expected_state_version: state.state_version, ...command }, state, { diceService: dice(rolls), context: { allowedActorIds: ['hero'] } })
    return result.events.reduce(R.applyGameEvent, state)
  } catch {
    return state
  }
}

let engineCount = 0
for (let index = 0; index < 120; index += 1) {
  let state = engineState(index)
  const steps = []
  if (chance(0.8)) steps.push([{ command_type: 'BargainWithMerchant', actor_id: 'hero', merchant_id: 'marten' }, [int(1, 20)]])
  if (chance(0.6)) steps.push([{ command_type: 'AppraiseItem', actor_id: 'hero', merchant_id: 'marten', item_id: 'moon-shard' }, []])
  if (chance(0.4)) steps.push([{ command_type: 'SellItem', actor_id: 'hero', merchant_id: 'marten', item_id: pick(['moon-shard', 'hero-dagger']), quantity: int(1, 2) }, []])
  if (chance(0.4)) steps.push([{ command_type: 'BuyItem', actor_id: 'hero', merchant_id: 'marten', stock_id: pick(['potion-stock', 'rope']), quantity: 1 }, []])
  for (const [command, rolls] of steps) state = tryCommand(state, command, rolls)
  const json = viaJson({
    sessionCode: state.sessionCode, state_version: state.state_version, scene: state.scene,
    players: state.players.map((player) => ({ id: player.id, currency: player.currency, inventory: player.inventory })),
    merchants: state.merchants,
    mechanics: { item_appraisals: state.mechanics?.item_appraisals, world_time: state.mechanics?.world_time },
    social: state.social, autonomy: state.autonomy, law: state.law, worldMap: state.worldMap,
  })
  s.bundle("state", json, [["merchantViewFor", "marten", "hero"], ["merchantTradeAvailabilityFor", "marten", {}], ["merchantServiceProposal", "marten", "hero", "repair"]], STATE_FNS)
  engineCount += 1
}
console.log(`сыграно Rules Engine: ${engineCount}`)
s.write('merchant-economy-states.json')
