import { createHash } from 'node:crypto'

import {
  ECONOMY_CATALOG_SOURCE,
  ECONOMY_CATALOG_VERSION,
  SRD_EQUIPMENT_CATALOG,
  normalizeMerchant,
} from './merchant-economy.mjs'

export const SHOP_PROPOSAL_VERSION = 'skazanie:shop-proposal-v1'

export const SHOP_ASSEMBLER_LIMITS = Object.freeze({
  minimum_budget_cp: 100,
  maximum_budget_cp: 1_000_000,
  maximum_location_length: 180,
  maximum_seed_length: 120,
  minimum_agent_adjustment_bps: -2_000,
  maximum_agent_adjustment_bps: 2_000,
})

const SETTLEMENTS = deepFreeze({
  village: { max_skus: 6, max_quantity_per_sku: 20, buy_markup_bps: 11_000, bargain_dc: 14 },
  town: { max_skus: 8, max_quantity_per_sku: 30, buy_markup_bps: 10_750, bargain_dc: 15 },
  city: { max_skus: 12, max_quantity_per_sku: 60, buy_markup_bps: 10_500, bargain_dc: 16 },
  outpost: { max_skus: 6, max_quantity_per_sku: 24, buy_markup_bps: 11_500, bargain_dc: 15 },
  traveling: { max_skus: 5, max_quantity_per_sku: 12, buy_markup_bps: 11_250, bargain_dc: 14 },
})

export const SHOP_SETTLEMENT_TYPES = Object.freeze(Object.keys(SETTLEMENTS))

const ALL_CATALOG_IDS = Object.freeze(Object.keys(SRD_EQUIPMENT_CATALOG))

const THEMES = deepFreeze({
  general: ALL_CATALOG_IDS,
  provisions: [
    'srd_5_2_1:explorers-pack',
    'srd_5_2_1:potion-of-healing',
    'srd_5_2_1:rations-one-day',
    'srd_5_2_1:rope-hempen-50-feet',
    'srd_5_2_1:torch',
    'srd_5_2_1:arrows-20',
  ],
  arms: [
    'srd_5_2_1:dagger',
    'srd_5_2_1:longsword',
    'srd_5_2_1:longbow',
    'srd_5_2_1:shortbow',
    'srd_5_2_1:leather-armor',
    'srd_5_2_1:shield',
    'srd_5_2_1:arrows-20',
  ],
  healing: [
    'srd_5_2_1:potion-of-healing',
    'srd_5_2_1:rations-one-day',
    'srd_5_2_1:explorers-pack',
    'srd_5_2_1:rope-hempen-50-feet',
    'srd_5_2_1:torch',
  ],
})

export const SHOP_THEMES = Object.freeze(Object.keys(THEMES))

// Presentation metadata is server-owned. The authoritative price is always
// copied separately from SRD_EQUIPMENT_CATALOG below.
const ITEM_PRESENTATION = deepFreeze({
  'srd_5_2_1:dagger': { name: 'Кинжал', type: 'weapon', properties: 'Простое рукопашное оружие.' },
  'srd_5_2_1:longsword': { name: 'Длинный меч', type: 'weapon', properties: 'Воинское рукопашное оружие.' },
  'srd_5_2_1:longbow': { name: 'Длинный лук', type: 'weapon', properties: 'Воинское дальнобойное оружие.' },
  'srd_5_2_1:shortbow': { name: 'Короткий лук', type: 'weapon', properties: 'Простое дальнобойное оружие.' },
  'srd_5_2_1:leather-armor': { name: 'Кожаный доспех', type: 'armor', properties: 'Лёгкий доспех.' },
  'srd_5_2_1:shield': { name: 'Щит', type: 'armor', properties: 'Защитное снаряжение.' },
  'srd_5_2_1:explorers-pack': { name: 'Набор путешественника', type: 'tool', properties: 'Комплект дорожного снаряжения.' },
  'srd_5_2_1:potion-of-healing': { name: 'Зелье лечения', type: 'consumable', properties: 'Восстанавливает 2к4 + 2 хита.' },
  'srd_5_2_1:rations-one-day': { name: 'Сухой паёк, 1 день', type: 'consumable', properties: 'Дорожная пища на один день.' },
  'srd_5_2_1:rope-hempen-50-feet': { name: 'Пеньковая верёвка, 50 футов', type: 'tool', properties: 'Пятьдесят футов пеньковой верёвки.' },
  'srd_5_2_1:torch': { name: 'Факел', type: 'tool', properties: 'Обычный источник света.' },
  'srd_5_2_1:arrows-20': { name: 'Стрелы, 20 штук', type: 'other', properties: 'Боеприпасы для лука.' },
})

const PERSONAS = deepFreeze([
  {
    template_id: 'careful-quartermaster',
    name: 'Элва Камнеключ',
    title: 'Снабженец с безупречным учётом',
    description: 'Проверяет каждую поставку и держит товары в образцовом порядке.',
    greeting: 'Смотрите спокойно. Всё, что лежит на прилавке, уже пересчитано.',
    voice: 'Говорит коротко, уверенно и называет точные условия сделки.',
    initials: 'ЭК',
  },
  {
    template_id: 'road-provisioner',
    name: 'Мартен Рыжий',
    title: 'Торговец дорожными припасами',
    description: 'Знает нужды путешественников и не обещает того, чего нет на складе.',
    greeting: 'Подходите. Сначала выберем товар, потом обсудим условия.',
    voice: 'Говорит живо и дружелюбно, но внимательно считает монеты.',
    initials: 'МР',
  },
  {
    template_id: 'guild-factor',
    name: 'Илара Медный Перст',
    title: 'Представитель торговой гильдии',
    description: 'Ценит надёжные сделки, происхождение товара и ясные договорённости.',
    greeting: 'Каталог перед вами. Если хотите торговаться — приводите доводы.',
    voice: 'Вежлива, наблюдательна и не меняет цену без причины.',
    initials: 'ИМ',
  },
  {
    template_id: 'frontier-trader',
    name: 'Торрен Вяз',
    title: 'Пограничный торговец',
    description: 'Собирает практичное снаряжение для опасных дорог и далёких застав.',
    greeting: 'Берите то, что поможет вернуться живыми. Остальное подождёт.',
    voice: 'Говорит негромко, прямо и без лишних обещаний.',
    initials: 'ТВ',
  },
])

const TOP_LEVEL_KEYS = new Set(['location', 'settlement_type', 'theme', 'seed', 'budget_cp', 'director_intent'])
const DIRECTOR_KEYS = new Set(['stock', 'agent_adjustment_bps'])
const DIRECTOR_STOCK_KEYS = new Set(['catalog_id', 'quantity'])

export class ShopAssemblyError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ShopAssemblyError'
    this.code = code
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function rejectUnexpectedKeys(value, allowed, code) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ShopAssemblyError('Вход содержит поле, не разрешённое контрактом сборщика магазина', code)
  }
}

function boundedText(value, maximum, code, label) {
  if (typeof value !== 'string') throw new ShopAssemblyError(`${label} должно быть строкой`, code)
  const result = value.trim()
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new ShopAssemblyError(`${label} не прошло проверку границ`, code)
  }
  return result
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function deterministicInteger(seed, label, maximumExclusive) {
  return Number.parseInt(digest(`${seed}\u0000${label}`).slice(0, 8), 16) % maximumExclusive
}

function deterministicOrder(values, seed, label) {
  return [...values].sort((left, right) => {
    const leftHash = digest(`${seed}\u0000${label}\u0000${left}`)
    const rightHash = digest(`${seed}\u0000${label}\u0000${right}`)
    return leftHash.localeCompare(rightHash) || left.localeCompare(right)
  })
}

function validateDirectorIntent(input, theme, settlement) {
  if (input == null) return null
  if (!isPlainObject(input)) throw new ShopAssemblyError('director_intent должен быть объектом', 'INVALID_DIRECTOR_INTENT')
  rejectUnexpectedKeys(input, DIRECTOR_KEYS, 'UNEXPECTED_DIRECTOR_FIELD')
  if (!Array.isArray(input.stock) || input.stock.length < 1) {
    throw new ShopAssemblyError('director_intent.stock должен быть непустым массивом', 'INVALID_DIRECTOR_STOCK')
  }
  if (input.stock.length > settlement.max_skus) {
    throw new ShopAssemblyError('Режиссёр запросил слишком много видов товара', 'DIRECTOR_SKU_LIMIT_EXCEEDED')
  }

  const allowedCatalogIds = new Set(THEMES[theme])
  const seen = new Set()
  const stock = Array.from(input.stock, (entry) => {
    if (!isPlainObject(entry)) throw new ShopAssemblyError('Запись stock должна быть объектом', 'INVALID_DIRECTOR_STOCK_ENTRY')
    rejectUnexpectedKeys(entry, DIRECTOR_STOCK_KEYS, 'UNEXPECTED_DIRECTOR_STOCK_FIELD')
    if (typeof entry.catalog_id !== 'string' || !allowedCatalogIds.has(entry.catalog_id)) {
      throw new ShopAssemblyError('catalog_id не входит в разрешённый каталог выбранной темы', 'CATALOG_ID_NOT_ALLOWED')
    }
    if (seen.has(entry.catalog_id)) throw new ShopAssemblyError('catalog_id повторяется', 'DUPLICATE_CATALOG_ID')
    seen.add(entry.catalog_id)
    if (!Number.isSafeInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > settlement.max_quantity_per_sku) {
      throw new ShopAssemblyError('Количество товара выходит за разрешённые границы', 'DIRECTOR_QUANTITY_OUT_OF_RANGE')
    }
    return { catalog_id: entry.catalog_id, quantity: entry.quantity }
  }).sort((left, right) => left.catalog_id.localeCompare(right.catalog_id))

  const adjustment = input.agent_adjustment_bps ?? 0
  if (!Number.isSafeInteger(adjustment)
    || adjustment < SHOP_ASSEMBLER_LIMITS.minimum_agent_adjustment_bps
    || adjustment > SHOP_ASSEMBLER_LIMITS.maximum_agent_adjustment_bps) {
    throw new ShopAssemblyError('Ценовое отклонение режиссёра выходит за разрешённые границы', 'DIRECTOR_ADJUSTMENT_OUT_OF_RANGE')
  }
  return { stock, agent_adjustment_bps: adjustment }
}

function validateInput(input) {
  if (!isPlainObject(input)) throw new ShopAssemblyError('Вход сборщика должен быть объектом', 'INVALID_SHOP_INPUT')
  rejectUnexpectedKeys(input, TOP_LEVEL_KEYS, 'UNEXPECTED_SHOP_FIELD')

  const location = boundedText(input.location, SHOP_ASSEMBLER_LIMITS.maximum_location_length, 'INVALID_LOCATION', 'location')
  const seed = boundedText(input.seed, SHOP_ASSEMBLER_LIMITS.maximum_seed_length, 'INVALID_SEED', 'seed')
  const settlementType = input.settlement_type
  const theme = input.theme
  if (typeof settlementType !== 'string' || !Object.hasOwn(SETTLEMENTS, settlementType)) {
    throw new ShopAssemblyError('Неизвестный тип поселения', 'SETTLEMENT_TYPE_NOT_ALLOWED')
  }
  if (typeof theme !== 'string' || !Object.hasOwn(THEMES, theme)) {
    throw new ShopAssemblyError('Неизвестная тема магазина', 'SHOP_THEME_NOT_ALLOWED')
  }
  if (!Number.isSafeInteger(input.budget_cp)
    || input.budget_cp < SHOP_ASSEMBLER_LIMITS.minimum_budget_cp
    || input.budget_cp > SHOP_ASSEMBLER_LIMITS.maximum_budget_cp) {
    throw new ShopAssemblyError('Бюджет магазина выходит за разрешённые границы', 'SHOP_BUDGET_OUT_OF_RANGE')
  }
  const settlement = SETTLEMENTS[settlementType]
  return {
    location,
    seed,
    settlement_type: settlementType,
    settlement,
    theme,
    budget_cp: input.budget_cp,
    director_intent: validateDirectorIntent(input.director_intent, theme, settlement),
  }
}

function desiredStock(validated, assemblySeed) {
  if (validated.director_intent) return validated.director_intent.stock
  const affordable = THEMES[validated.theme].filter((catalogId) => (
    SRD_EQUIPMENT_CATALOG[catalogId].base_price_cp <= validated.budget_cp
  ))
  const selected = deterministicOrder(affordable, assemblySeed, 'default-catalog')
    .slice(0, validated.settlement.max_skus)
  return selected.map((catalogId) => ({
    catalog_id: catalogId,
    quantity: 1 + deterministicInteger(assemblySeed, `quantity:${catalogId}`, validated.settlement.max_quantity_per_sku),
  }))
}

function allocateStock(desired, budgetCp, assemblySeed) {
  const byId = new Map(desired.map((entry) => [entry.catalog_id, entry]))
  const order = deterministicOrder([...byId.keys()], assemblySeed, 'allocation')
  const allocated = new Map(order.map((catalogId) => [catalogId, 0]))
  let remaining = budgetCp

  // Give every affordable requested SKU one unit before distributing extras.
  for (const catalogId of order) {
    const unit = SRD_EQUIPMENT_CATALOG[catalogId].base_price_cp
    if (unit <= remaining) {
      allocated.set(catalogId, 1)
      remaining -= unit
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const catalogId of order) {
      const target = byId.get(catalogId).quantity
      const current = allocated.get(catalogId)
      const unit = SRD_EQUIPMENT_CATALOG[catalogId].base_price_cp
      if (current < target && unit <= remaining) {
        allocated.set(catalogId, current + 1)
        remaining -= unit
        changed = true
      }
    }
  }
  return {
    entries: order.flatMap((catalogId) => {
      const quantity = allocated.get(catalogId)
      return quantity > 0 ? [{ catalog_id: catalogId, quantity }] : []
    }),
    spent_cp: budgetCp - remaining,
  }
}

function stockEntry(catalogId, quantity, merchantId) {
  const catalog = SRD_EQUIPMENT_CATALOG[catalogId]
  const presentation = ITEM_PRESENTATION[catalogId]
  const shortId = catalogId.split(':').at(-1).replace(/[^a-z0-9-]/giu, '-').slice(0, 70)
  return {
    stock_id: `${merchantId}-${shortId}`.slice(0, 120),
    catalog_id: catalogId,
    name: presentation.name,
    type: presentation.type,
    quantity,
    rarity: 'обычный',
    description: '',
    properties: presentation.properties,
    base_price_cp: catalog.base_price_cp,
    price_provenance: 'catalog',
    price_source_version: catalog.source_version,
  }
}

export class ShopAssembler {
  assemble(input) {
    const validated = validateInput(input)
    const canonical = JSON.stringify({
      location: validated.location,
      settlement_type: validated.settlement_type,
      theme: validated.theme,
      seed: validated.seed,
      budget_cp: validated.budget_cp,
      director_intent: validated.director_intent,
    })
    const assemblySeed = digest(`${SHOP_PROPOSAL_VERSION}\u0000${canonical}`)
    const desired = desiredStock(validated, assemblySeed)
    const allocation = allocateStock(desired, validated.budget_cp, assemblySeed)
    if (allocation.entries.length === 0) {
      throw new ShopAssemblyError('Бюджет не позволяет выставить ни один выбранный товар', 'BUDGET_CANNOT_FUND_STOCK')
    }

    const proposalId = `shop-proposal-${assemblySeed.slice(0, 24)}`
    const merchantId = `shop-${assemblySeed.slice(0, 16)}`
    const persona = PERSONAS[deterministicInteger(assemblySeed, 'persona', PERSONAS.length)]
    const adjustment = validated.director_intent?.agent_adjustment_bps ?? 0
    const merchant = normalizeMerchant({
      id: merchantId,
      name: persona.name,
      title: persona.title,
      description: persona.description,
      greeting: persona.greeting,
      voice: persona.voice,
      initials: persona.initials,
      location: validated.location,
      available: true,
      // Liquidity is server-owned and deterministic. It scales with the shop
      // budget but remains bounded independently from catalog stock value.
      purse_cp: Math.max(100, Math.min(100_000, Math.floor(validated.budget_cp / 4))),
      pricing: {
        mode: 'catalog_with_agent_adjustment',
        catalog_id: ECONOMY_CATALOG_VERSION,
        buy_markup_bps: validated.settlement.buy_markup_bps,
        sell_rate_bps: 5_000,
        bargain_dc: validated.settlement.bargain_dc,
        success_discount_bps: 1_000,
        failure_markup_bps: 500,
        min_multiplier_bps: 1_000,
        max_multiplier_bps: 30_000,
        agent_adjustment_bps: adjustment,
        agent_adjustment_limit_percent: 20,
        description: 'Каталожная SRD-цена с ограниченной политикой конкретного торговца.',
      },
      stock: allocation.entries.map((entry) => stockEntry(entry.catalog_id, entry.quantity, merchantId)),
    })

    return deepFreeze({
      proposal_type: 'merchant',
      proposal_version: SHOP_PROPOSAL_VERSION,
      proposal_id: proposalId,
      source: 'deterministic-shop-assembler',
      seed_fingerprint: assemblySeed.slice(0, 16),
      catalog: {
        id: ECONOMY_CATALOG_VERSION,
        source_version: ECONOMY_CATALOG_SOURCE.source_version,
        source_sha256: ECONOMY_CATALOG_SOURCE.source_sha256,
      },
      constraints: {
        settlement_type: validated.settlement_type,
        theme: validated.theme,
        budget_cp: validated.budget_cp,
        allocated_base_value_cp: allocation.spent_cp,
        max_skus: validated.settlement.max_skus,
        max_quantity_per_sku: validated.settlement.max_quantity_per_sku,
        agent_adjustment_min_bps: SHOP_ASSEMBLER_LIMITS.minimum_agent_adjustment_bps,
        agent_adjustment_max_bps: SHOP_ASSEMBLER_LIMITS.maximum_agent_adjustment_bps,
      },
      persona_template_id: persona.template_id,
      merchant,
    })
  }
}

export const defaultShopAssembler = new ShopAssembler()

export function assembleShop(input) {
  return defaultShopAssembler.assemble(input)
}
