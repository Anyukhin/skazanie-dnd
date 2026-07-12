import { randomUUID } from 'node:crypto'
import { parseDiceExpression } from './dice-service.mjs'
import { createSceneTransition, publicAdventureMemory } from './adventure-director.mjs'
import { assembleEncounter } from './encounter-assembler.mjs'
import {
  ECONOMY_CATALOG_VERSION,
  ECONOMY_POLICY_ID,
  DEFAULT_MERCHANT_PURSE_CP,
  MAX_CURRENCY_CP,
  MAX_STOCK_QUANTITY,
  MAX_TRANSACTION_QUANTITY,
  bargainFor,
  copperToCurrency,
  currencyToCopper,
  findMerchant,
  inventoryItemFromStock,
  inventoryStackKey,
  merchantIsAtLocation,
  normalizeCurrency,
  normalizeInventoryItem,
  normalizeMerchant,
  normalizeMerchantPurseCp,
  normalizeMerchantPricing,
  normalizeMerchants,
  quoteMerchantBuyUnit,
  quoteMerchantSellUnit,
  resolveCatalogPrice,
  sellability,
  trustedItemAppraisalFor,
  trustedStockAppraisalFor,
} from './merchant-economy.mjs'
import {
  CATEGORY_APPRAISAL_POLICY_ID,
  appraiseItem,
} from './item-appraisal.mjs'
import {
  combatSpellFor,
  combatSpellsFor,
  isPartySummon,
  spellSlotMaximumsFor,
} from './combat-spells.mjs'

export const DEFAULT_RULESET_ID = 'srd_5_2_1'

export const RULE_IDS = Object.freeze({
  abilityCheck: `${DEFAULT_RULESET_ID}:checks:ability-check`,
  savingThrow: `${DEFAULT_RULESET_ID}:checks:saving-throw`,
  advantage: `${DEFAULT_RULESET_ID}:core:advantage-disadvantage`,
  attack: `${DEFAULT_RULESET_ID}:combat:attack-roll`,
  armorClass: `${DEFAULT_RULESET_ID}:combat:armor-class`,
  criticalHit: `${DEFAULT_RULESET_ID}:combat:critical-hit`,
  damage: `${DEFAULT_RULESET_ID}:combat:damage`,
  healing: `${DEFAULT_RULESET_ID}:combat:healing`,
  temporaryHp: `${DEFAULT_RULESET_ID}:combat:temporary-hit-points`,
  zeroHp: `${DEFAULT_RULESET_ID}:combat:zero-hit-points`,
  resistance: `${DEFAULT_RULESET_ID}:combat:damage-modifiers`,
  resource: `${DEFAULT_RULESET_ID}:resources:spending`,
  economyCoins: `${DEFAULT_RULESET_ID}:economy:coins`,
  sellingEquipment: `${DEFAULT_RULESET_ID}:economy:selling-equipment`,
  conditions: `${DEFAULT_RULESET_ID}:conditions:common`,
  initiative: `${DEFAULT_RULESET_ID}:combat:initiative`,
  turns: `${DEFAULT_RULESET_ID}:combat:turn-economy`,
  actions: `${DEFAULT_RULESET_ID}:combat:turn-economy`,
  reaction: `${DEFAULT_RULESET_ID}:combat:reaction`,
  concentration: `${DEFAULT_RULESET_ID}:spells:concentration`,
})

const COMMAND_RULES = Object.freeze({
  MakeAbilityCheck: [RULE_IDS.abilityCheck],
  MakeSavingThrow: [RULE_IDS.savingThrow],
  MakeAttack: [RULE_IDS.attack],
  MakeAreaAttack: [RULE_IDS.attack, RULE_IDS.damage],
  ChangeWeapon: [RULE_IDS.actions],
  ApplyDamage: [RULE_IDS.damage],
  ApplyHealing: [RULE_IDS.healing],
  GrantTemporaryHitPoints: [RULE_IDS.temporaryHp],
  SpendResource: [RULE_IDS.resource],
  RestoreResource: [RULE_IDS.resource],
  AddCondition: [RULE_IDS.conditions],
  RemoveCondition: [RULE_IDS.conditions],
  CastSpell: [RULE_IDS.turns],
  MoveActor: [RULE_IDS.turns],
  StartCombat: [RULE_IDS.initiative],
  EndCombat: [RULE_IDS.initiative, RULE_IDS.turns],
  EndTurn: [RULE_IDS.turns],
  AdvanceTime: [],
  StartRest: [RULE_IDS.resource],
  CompleteRest: [RULE_IDS.resource],
  StartConcentration: [RULE_IDS.concentration],
  EndConcentration: [RULE_IDS.concentration],
  CreateEncounter: [],
  BargainWithMerchant: [],
  AppraiseItem: [],
  BuyItem: [RULE_IDS.economyCoins],
  SellItem: [RULE_IDS.economyCoins, RULE_IDS.sellingEquipment],
  CreateMerchant: [],
  ConfigureMerchant: [],
  RestockMerchant: [],
  MoveMerchant: [],
  SetMerchantAvailability: [],
  AdvanceScene: [],
})

export const ALLOWED_COMMAND_TYPES = new Set([
  'DeclareAction', 'MakeAbilityCheck', 'MakeSavingThrow', 'MakeAttack', 'ApplyDamage', 'ApplyHealing',
  'GrantTemporaryHitPoints', 'SpendResource', 'RestoreResource', 'AddCondition', 'RemoveCondition',
  'CastSpell', 'MoveActor', 'StartCombat', 'EndCombat', 'EndTurn', 'ChangeWeapon', 'MakeAreaAttack', 'AdvanceTime', 'StartRest', 'CompleteRest',
  'StartConcentration', 'EndConcentration', 'RevealArea', 'UpdateObjective', 'SpawnEntity', 'GrantItem',
  'RecordRuling', 'BargainWithMerchant', 'AppraiseItem', 'BuyItem', 'SellItem',
  'CreateMerchant', 'ConfigureMerchant', 'RestockMerchant', 'MoveMerchant', 'SetMerchantAvailability', 'CreateEncounter',
  'AdvanceScene',
])

const MERCHANT_LIFECYCLE_COMMAND_TYPES = new Set([
  'CreateMerchant', 'ConfigureMerchant', 'RestockMerchant', 'MoveMerchant', 'SetMerchantAvailability',
])
const ENCOUNTER_LIFECYCLE_COMMAND_TYPES = new Set(['CreateEncounter'])

const SCENE_ADVANCE_FIELDS = new Set([
  'title', 'location', 'mood', 'objective', 'transition', 'arrival', 'hook', 'theme', 'danger', 'seed',
  'completed_objective', 'objective_status', 'outcome', 'carry_unresolved', 'suggestions', 'map',
  'scene_kind', 'settlement_type',
])

const SCENE_MAP_FIELDS = new Set(['layout', 'width', 'height', 'openness', 'water', 'featureCount'])
const SCENE_KINDS = new Set(['settlement', 'wilderness', 'dungeon', 'road', 'other'])
const SCENE_SETTLEMENT_TYPES = new Set(['village', 'town', 'city', 'outpost', 'traveling'])
const SCENE_DANGER_LEVELS = new Set(['низкая', 'средняя', 'высокая'])
const SCENE_COMMERCE_FIELDS = new Set(['version', 'action', 'settlement_type', 'theme', 'budget_cp', 'reason', 'outcome', 'merchant_id'])
const SCENE_COMMERCE_ACTIONS = new Set(['create', 'none'])
const SCENE_COMMERCE_THEMES = new Set(['general', 'provisions', 'arms', 'healing'])
const SCENE_COMMERCE_OUTCOMES = new Set(['created', 'reused', 'not-requested'])
const SCENE_COMMERCE_PLAN_VERSION = 'skazanie:scene-commerce-plan-v1'
const PARTY_DECISION_REFERENCE_FIELDS = new Set(['interaction_id', 'resolved_option_id'])

const MERCHANT_CONFIGURATION_FIELDS = new Set(['name', 'title', 'description', 'greeting', 'voice', 'pricing', 'purse_cp'])
const MERCHANT_CREATE_FIELDS = new Set([...MERCHANT_CONFIGURATION_FIELDS, 'id', 'merchant_id', 'location', 'available', 'stock'])
const MERCHANT_PRICING_FIELDS = new Set([
  'mode', 'buy_markup_bps', 'sell_rate_bps', 'bargain_dc', 'success_discount_bps',
  'failure_markup_bps', 'agent_adjustment_bps', 'agent_adjustment_limit_percent', 'description',
])
const MERCHANT_STOCK_FIELDS = new Set([
  'stock_id', 'catalog_id', 'quantity', 'name', 'type', 'weight', 'rarity', 'description', 'properties',
])

export class RulesValidationError extends Error {
  constructor(message, code = 'RULES_VALIDATION_FAILED') {
    super(message)
    this.name = 'RulesValidationError'
    this.code = code
  }
}

function clone(value) {
  return structuredClone(value)
}

function safeInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : fallback
}

function uniqueStrings(value) {
  return [...new Set(Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [])]
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeSceneAdvanceArgs(value) {
  if (!plainObject(value)) {
    throw new RulesValidationError('Параметры перехода сцены должны быть объектом', 'INVALID_SCENE_ADVANCE_ARGS')
  }
  const args = Object.fromEntries(Object.entries(value)
    .filter(([key]) => SCENE_ADVANCE_FIELDS.has(key))
    .map(([key, item]) => [key, clone(item)]))
  if (Object.hasOwn(args, 'map')) {
    if (!plainObject(args.map)) throw new RulesValidationError('Параметры карты новой сцены должны быть объектом', 'INVALID_SCENE_MAP_ARGS')
    args.map = Object.fromEntries(Object.entries(args.map).filter(([key]) => SCENE_MAP_FIELDS.has(key)))
  }
  if (Object.hasOwn(args, 'theme') && typeof args.theme !== 'string') {
    throw new RulesValidationError('Тема новой сцены должна быть строкой', 'INVALID_SCENE_THEME')
  }
  if (Object.hasOwn(args, 'danger') && !SCENE_DANGER_LEVELS.has(args.danger)) {
    throw new RulesValidationError('Неизвестный уровень опасности новой сцены', 'INVALID_SCENE_DANGER')
  }
  if (Object.hasOwn(args, 'scene_kind') && !SCENE_KINDS.has(args.scene_kind)) {
    throw new RulesValidationError('Неизвестный тип новой сцены', 'INVALID_SCENE_KIND')
  }
  if (args.settlement_type != null && !SCENE_SETTLEMENT_TYPES.has(args.settlement_type)) {
    throw new RulesValidationError('Неизвестный тип поселения новой сцены', 'INVALID_SCENE_SETTLEMENT_TYPE')
  }
  const sceneKind = args.scene_kind ?? (args.settlement_type ? 'settlement' : 'other')
  if (args.settlement_type && sceneKind !== 'settlement') {
    throw new RulesValidationError('Тип поселения допустим только для сцены-поселения', 'INVALID_SCENE_SETTLEMENT_TYPE')
  }
  args.scene_kind = sceneKind
  args.settlement_type = args.settlement_type ?? null
  return args
}

function privateAdventureBuckets(value) {
  if (!plainObject(value)) return {}
  const privateFields = [
    'hidden_information', 'hiddenInformation',
    'gm_only', 'gmOnly', 'gm_notes', 'gmNotes',
    'npc_private', 'npcPrivate', 'private_notes', 'privateNotes',
    'specific_player', 'specificPlayer', 'party',
    'secret', 'secrets', 'unrevealed', 'true_state', 'trueState',
  ]
  return Object.fromEntries(privateFields
    .filter((key) => Object.hasOwn(value, key))
    .map((key) => [key, clone(value[key])]))
}

function canonicalSceneMetadata(args, transition) {
  const fallbackTheme = String(transition?.scene?.location || transition?.scene?.title || 'новая сцена')
  const theme = String(args.theme || fallbackTheme).replace(/\s+/g, ' ').trim().slice(0, 80) || fallbackTheme.slice(0, 80)
  return {
    theme,
    danger: SCENE_DANGER_LEVELS.has(args.danger) ? args.danger : 'средняя',
    scene_kind: args.scene_kind,
    settlement_type: args.settlement_type,
  }
}

function normalizeSceneCommerce(value) {
  if (value == null) return null
  if (!plainObject(value) || Object.keys(value).some((key) => !SCENE_COMMERCE_FIELDS.has(key))) {
    throw new RulesValidationError('План торговли новой сцены содержит недопустимые поля', 'INVALID_SCENE_COMMERCE')
  }
  if (value.version !== SCENE_COMMERCE_PLAN_VERSION
    || !SCENE_COMMERCE_ACTIONS.has(value.action)
    || !SCENE_SETTLEMENT_TYPES.has(value.settlement_type)
    || !SCENE_COMMERCE_THEMES.has(value.theme)
    || !SCENE_COMMERCE_OUTCOMES.has(value.outcome)) {
    throw new RulesValidationError('План торговли новой сцены не соответствует серверному контракту', 'INVALID_SCENE_COMMERCE')
  }
  if (!Number.isSafeInteger(value.budget_cp) || value.budget_cp < 100 || value.budget_cp > 1_000_000) {
    throw new RulesValidationError('Бюджет торговли новой сцены выходит за разрешённые границы', 'INVALID_SCENE_COMMERCE')
  }
  const reason = typeof value.reason === 'string'
    ? value.reason.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, 240)
    : ''
  if (!reason) throw new RulesValidationError('План торговли новой сцены должен содержать причину', 'INVALID_SCENE_COMMERCE')
  const merchantId = value.merchant_id == null
    ? null
    : lifecycleId(value.merchant_id, 'INVALID_SCENE_COMMERCE', 'merchant_id')
  if (value.outcome === 'reused' && !merchantId) {
    throw new RulesValidationError('Повторно используемый торговец должен иметь merchant_id', 'INVALID_SCENE_COMMERCE')
  }
  if (value.outcome !== 'reused' && merchantId) {
    throw new RulesValidationError('merchant_id допустим только при повторном использовании торговца', 'INVALID_SCENE_COMMERCE')
  }
  return {
    version: SCENE_COMMERCE_PLAN_VERSION,
    action: value.action,
    settlement_type: value.settlement_type,
    theme: value.theme,
    budget_cp: value.budget_cp,
    reason,
    outcome: value.outcome,
    merchant_id: merchantId,
  }
}

function normalizePartyDecisionReference(value, { required = false } = {}) {
  if (value == null) {
    if (required) throw new RulesValidationError('Director должен связать переход с решением группы', 'PARTY_DECISION_REQUIRED')
    return null
  }
  if (!plainObject(value) || Object.keys(value).some((key) => !PARTY_DECISION_REFERENCE_FIELDS.has(key))) {
    throw new RulesValidationError('Ссылка на решение группы содержит недопустимые поля', 'INVALID_PARTY_DECISION_REFERENCE')
  }
  return {
    interaction_id: lifecycleId(value.interaction_id, 'INVALID_PARTY_DECISION_REFERENCE', 'interaction_id'),
    resolved_option_id: lifecycleId(value.resolved_option_id, 'INVALID_PARTY_DECISION_REFERENCE', 'resolved_option_id'),
  }
}

function lifecycleObject(value, code, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RulesValidationError(`${label} должен быть объектом`, code)
  }
  return value
}

function assertLifecycleKeys(source, allowed, code, label) {
  const unexpected = Object.keys(source).filter((key) => !allowed.has(key))
  if (unexpected.length) throw new RulesValidationError(`${label}: недопустимые поля ${unexpected.join(', ')}`, code)
}

function lifecycleId(value, code, label) {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(result)) {
    throw new RulesValidationError(`${label} должен быть безопасным идентификатором`, code)
  }
  return result
}

function lifecycleText(value, maximum, { required = false, fallback = '', code = 'INVALID_MERCHANT_DATA', label = 'Поле' } = {}) {
  if (value == null) {
    if (required) throw new RulesValidationError(`${label} обязательно`, code)
    return fallback
  }
  if (typeof value !== 'string') throw new RulesValidationError(`${label} должно быть строкой`, code)
  const result = value.trim().slice(0, maximum)
  if (required && !result) throw new RulesValidationError(`${label} обязательно`, code)
  return result
}

function lifecycleInteger(value, minimum, maximum, fallback, code, label) {
  if (value == null) return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new RulesValidationError(`${label} должно быть целым числом`, code)
  return Math.max(minimum, Math.min(maximum, number))
}

function lifecyclePurseCp(value, fallback = DEFAULT_MERCHANT_PURSE_CP) {
  if (value == null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_CURRENCY_CP) {
    throw new RulesValidationError('Кошелёк торговца должен быть целым числом CP в допустимых пределах', 'INVALID_MERCHANT_PURSE')
  }
  return value
}

function normalizeLifecyclePricing(input = {}, current = {}) {
  const source = input == null ? {} : lifecycleObject(input, 'INVALID_MERCHANT_PRICING', 'Политика цен')
  assertLifecycleKeys(source, MERCHANT_PRICING_FIELDS, 'INVALID_MERCHANT_PRICING', 'Политика цен')
  const baseline = normalizeMerchantPricing(current)
  const mode = source.mode == null ? baseline.mode : source.mode
  if (!['catalog', 'catalog_with_agent_adjustment'].includes(mode)) {
    throw new RulesValidationError('Неизвестный режим политики цен', 'INVALID_MERCHANT_PRICING')
  }
  const adjustmentLimitPercent = lifecycleInteger(
    source.agent_adjustment_limit_percent,
    0,
    20,
    Math.min(20, safeInteger(baseline.agent_adjustment_limit_percent, 20)),
    'INVALID_MERCHANT_PRICING',
    'Лимит агентской корректировки',
  )
  const normalized = normalizeMerchantPricing({
    mode,
    catalog_id: ECONOMY_CATALOG_VERSION,
    buy_markup_bps: lifecycleInteger(source.buy_markup_bps, 1_000, 30_000, baseline.buy_markup_bps, 'INVALID_MERCHANT_PRICING', 'Наценка'),
    sell_rate_bps: lifecycleInteger(source.sell_rate_bps, 1_000, 30_000, baseline.sell_rate_bps, 'INVALID_MERCHANT_PRICING', 'Ставка выкупа'),
    bargain_dc: lifecycleInteger(source.bargain_dc, 5, 30, baseline.bargain_dc, 'INVALID_MERCHANT_PRICING', 'Сложность торга'),
    success_discount_bps: lifecycleInteger(source.success_discount_bps, 0, 5_000, baseline.success_discount_bps, 'INVALID_MERCHANT_PRICING', 'Скидка за успешный торг'),
    failure_markup_bps: lifecycleInteger(source.failure_markup_bps, 0, 5_000, baseline.failure_markup_bps, 'INVALID_MERCHANT_PRICING', 'Наценка за неудачный торг'),
    min_multiplier_bps: 1_000,
    max_multiplier_bps: 30_000,
    agent_adjustment_bps: lifecycleInteger(source.agent_adjustment_bps, -2_000, 2_000, baseline.agent_adjustment_bps, 'INVALID_MERCHANT_PRICING', 'Агентская корректировка'),
    agent_adjustment_limit_percent: adjustmentLimitPercent,
    description: lifecycleText(source.description, 500, {
      fallback: typeof baseline.description === 'string' ? baseline.description.slice(0, 500) : '',
      code: 'INVALID_MERCHANT_PRICING',
      label: 'Описание политики цен',
    }),
  })
  return {
    mode: normalized.mode,
    catalog_id: ECONOMY_CATALOG_VERSION,
    buy_markup_bps: normalized.buy_markup_bps,
    sell_rate_bps: normalized.sell_rate_bps,
    bargain_dc: normalized.bargain_dc,
    success_discount_bps: normalized.success_discount_bps,
    failure_markup_bps: normalized.failure_markup_bps,
    min_multiplier_bps: 1_000,
    max_multiplier_bps: 30_000,
    agent_adjustment_bps: normalized.agent_adjustment_bps,
    agent_adjustment_limit_percent: normalized.agent_adjustment_limit_percent,
    buy_markup_percent: normalized.buy_markup_percent,
    sell_rate_percent: normalized.sell_rate_percent,
    description: normalized.description,
  }
}

function normalizeLifecycleStockEntry(input, merchantId, index = 0) {
  const source = lifecycleObject(input, 'INVALID_MERCHANT_STOCK', 'Позиция склада')
  assertLifecycleKeys(source, MERCHANT_STOCK_FIELDS, 'INVALID_MERCHANT_STOCK', 'Позиция склада')
  const stockId = lifecycleId(source.stock_id, 'INVALID_STOCK_ID', 'stock_id')
  const catalogId = lifecycleId(source.catalog_id, 'INVALID_CATALOG_ITEM', 'catalog_id')
  const catalog = resolveCatalogPrice({ catalog_id: catalogId })
  if (!catalog) throw new RulesValidationError(`Товар ${catalogId} отсутствует в серверном каталоге`, 'CATALOG_ITEM_REQUIRED')
  const quantity = lifecycleInteger(source.quantity, 1, MAX_STOCK_QUANTITY, 1, 'INVALID_QUANTITY', 'Количество товара')
  const normalizedItem = normalizeInventoryItem({
    id: `${merchantId}:${stockId}`.slice(0, 120),
    catalog_id: catalogId,
    name: lifecycleText(source.name, 120, { fallback: catalogId, code: 'INVALID_MERCHANT_STOCK', label: 'Название товара' }),
    type: lifecycleText(source.type, 40, { fallback: 'other', code: 'INVALID_MERCHANT_STOCK', label: 'Тип товара' }),
    quantity,
    weight: source.weight,
    rarity: lifecycleText(source.rarity, 60, { fallback: undefined, code: 'INVALID_MERCHANT_STOCK', label: 'Редкость товара' }),
    description: lifecycleText(source.description, 1_000, { code: 'INVALID_MERCHANT_STOCK', label: 'Описание товара' }),
    properties: lifecycleText(source.properties, 500, { code: 'INVALID_MERCHANT_STOCK', label: 'Свойства товара' }),
    equipped: false,
  }, { idFallback: `${merchantId}-stock-${index + 1}`, preserveUnknown: false })
  return {
    stock_id: stockId,
    catalog_id: catalogId,
    name: normalizedItem.name,
    type: normalizedItem.type,
    quantity,
    base_price_cp: catalog.base_price_cp,
    weight: normalizedItem.weight,
    rarity: normalizedItem.rarity,
    description: normalizedItem.description,
    properties: normalizedItem.properties,
    equipped: false,
  }
}

function lifecycleStockFromCanonical(input, merchantId, index = 0) {
  return normalizeLifecycleStockEntry({
    stock_id: input?.stock_id,
    catalog_id: input?.catalog_id,
    quantity: input?.quantity,
    name: input?.name,
    type: input?.type,
    weight: input?.weight,
    rarity: input?.rarity,
    description: input?.description,
    properties: input?.properties,
  }, merchantId, index)
}

function normalizeLifecycleMerchant(input) {
  const source = lifecycleObject(input, 'INVALID_MERCHANT_DATA', 'Торговец')
  assertLifecycleKeys(source, MERCHANT_CREATE_FIELDS, 'INVALID_MERCHANT_DATA', 'Торговец')
  const id = lifecycleId(source.id ?? source.merchant_id, 'INVALID_MERCHANT_ID', 'id торговца')
  const stockInput = source.stock == null ? [] : source.stock
  if (!Array.isArray(stockInput) || stockInput.length > 500) {
    throw new RulesValidationError('Склад торговца должен содержать не более 500 позиций', 'INVALID_MERCHANT_STOCK')
  }
  const seen = new Set()
  const stock = stockInput.map((entry, index) => {
    const normalized = normalizeLifecycleStockEntry(entry, id, index)
    if (seen.has(normalized.stock_id)) throw new RulesValidationError('stock_id должен быть уникальным', 'DUPLICATE_STOCK_ID')
    seen.add(normalized.stock_id)
    return normalized
  })
  if (source.available != null && typeof source.available !== 'boolean') {
    throw new RulesValidationError('Доступность торговца должна быть логическим значением', 'INVALID_MERCHANT_AVAILABILITY')
  }
  const location = lifecycleText(source.location, 180, { required: true, code: 'INVALID_MERCHANT_LOCATION', label: 'Локация торговца' })
  const purseCp = lifecyclePurseCp(source.purse_cp)
  const pricing = normalizeLifecyclePricing(source.pricing)
  const normalized = normalizeMerchant({
    id,
    name: lifecycleText(source.name, 120, { required: true, code: 'INVALID_MERCHANT_DATA', label: 'Имя торговца' }),
    title: lifecycleText(source.title, 180, { code: 'INVALID_MERCHANT_DATA', label: 'Титул торговца' }),
    description: lifecycleText(source.description, 1_000, { code: 'INVALID_MERCHANT_DATA', label: 'Описание торговца' }),
    greeting: lifecycleText(source.greeting, 500, { code: 'INVALID_MERCHANT_DATA', label: 'Приветствие торговца' }),
    voice: lifecycleText(source.voice, 500, { code: 'INVALID_MERCHANT_DATA', label: 'Манера речи торговца' }),
    location,
    available: source.available !== false,
    purse_cp: purseCp,
    pricing,
    stock,
    bargains: {},
  })
  return {
    id: normalized.id,
    name: normalized.name,
    title: normalized.title,
    description: normalized.description,
    greeting: normalized.greeting,
    voice: normalized.voice,
    location: normalized.location,
    available: normalized.available,
    purse_cp: normalized.purse_cp,
    pricing,
    stock: normalized.stock.map((entry, index) => lifecycleStockFromCanonical(entry, id, index)),
    bargains: {},
  }
}

function lifecyclePricingFromCanonical(input, current = {}) {
  return normalizeLifecyclePricing({
    mode: input?.mode,
    buy_markup_bps: input?.buy_markup_bps,
    sell_rate_bps: input?.sell_rate_bps,
    bargain_dc: input?.bargain_dc,
    success_discount_bps: input?.success_discount_bps,
    failure_markup_bps: input?.failure_markup_bps,
    agent_adjustment_bps: input?.agent_adjustment_bps,
    agent_adjustment_limit_percent: input?.agent_adjustment_limit_percent,
    description: input?.description,
  }, current)
}

function lifecycleMerchantFromCanonical(input) {
  return normalizeLifecycleMerchant({
    id: input?.id ?? input?.merchant_id,
    name: input?.name,
    title: input?.title,
    description: input?.description,
    greeting: input?.greeting,
    voice: input?.voice,
    location: input?.location,
    available: input?.available,
    purse_cp: input?.purse_cp,
    pricing: {
      mode: input?.pricing?.mode,
      buy_markup_bps: input?.pricing?.buy_markup_bps,
      sell_rate_bps: input?.pricing?.sell_rate_bps,
      bargain_dc: input?.pricing?.bargain_dc,
      success_discount_bps: input?.pricing?.success_discount_bps,
      failure_markup_bps: input?.pricing?.failure_markup_bps,
      agent_adjustment_bps: input?.pricing?.agent_adjustment_bps,
      agent_adjustment_limit_percent: input?.pricing?.agent_adjustment_limit_percent,
      description: input?.pricing?.description,
    },
    stock: (Array.isArray(input?.stock) ? input.stock : []).map((entry) => ({
      stock_id: entry?.stock_id,
      catalog_id: entry?.catalog_id,
      quantity: entry?.quantity,
      name: entry?.name,
      type: entry?.type,
      weight: entry?.weight,
      rarity: entry?.rarity,
      description: entry?.description,
      properties: entry?.properties,
    })),
  })
}

function lifecycleConfigurationFromCanonical(input, merchant) {
  const source = {}
  for (const field of ['name', 'title', 'description', 'greeting', 'voice']) {
    if (Object.hasOwn(input ?? {}, field)) source[field] = input[field]
  }
  if (Object.hasOwn(input ?? {}, 'purse_cp')) source.purse_cp = input.purse_cp
  if (input?.pricing) source.pricing = {
    mode: input.pricing.mode,
    buy_markup_bps: input.pricing.buy_markup_bps,
    sell_rate_bps: input.pricing.sell_rate_bps,
    bargain_dc: input.pricing.bargain_dc,
    success_discount_bps: input.pricing.success_discount_bps,
    failure_markup_bps: input.pricing.failure_markup_bps,
    agent_adjustment_bps: input.pricing.agent_adjustment_bps,
    agent_adjustment_limit_percent: input.pricing.agent_adjustment_limit_percent,
    description: input.pricing.description,
  }
  return normalizeLifecycleConfiguration(source, merchant)
}

function normalizeLifecycleConfiguration(input, merchant) {
  const source = lifecycleObject(input, 'INVALID_MERCHANT_CONFIGURATION', 'Настройки торговца')
  assertLifecycleKeys(source, MERCHANT_CONFIGURATION_FIELDS, 'INVALID_MERCHANT_CONFIGURATION', 'Настройки торговца')
  const configuration = {}
  if (Object.hasOwn(source, 'name')) configuration.name = lifecycleText(source.name, 120, { required: true, code: 'INVALID_MERCHANT_CONFIGURATION', label: 'Имя торговца' })
  if (Object.hasOwn(source, 'title')) configuration.title = lifecycleText(source.title, 180, { code: 'INVALID_MERCHANT_CONFIGURATION', label: 'Титул торговца' })
  if (Object.hasOwn(source, 'description')) configuration.description = lifecycleText(source.description, 1_000, { code: 'INVALID_MERCHANT_CONFIGURATION', label: 'Описание торговца' })
  if (Object.hasOwn(source, 'greeting')) configuration.greeting = lifecycleText(source.greeting, 500, { code: 'INVALID_MERCHANT_CONFIGURATION', label: 'Приветствие торговца' })
  if (Object.hasOwn(source, 'voice')) configuration.voice = lifecycleText(source.voice, 500, { code: 'INVALID_MERCHANT_CONFIGURATION', label: 'Манера речи торговца' })
  if (Object.hasOwn(source, 'purse_cp')) configuration.purse_cp = lifecyclePurseCp(source.purse_cp)
  if (Object.hasOwn(source, 'pricing')) configuration.pricing = normalizeLifecyclePricing(source.pricing, merchant?.pricing)
  if (!Object.keys(configuration).length) throw new RulesValidationError('Не указаны изменения торговца', 'EMPTY_MERCHANT_CONFIGURATION')
  return configuration
}

function normalizeLifecycleRestock(input, merchant) {
  if (!Array.isArray(input) || !input.length || input.length > 500) {
    throw new RulesValidationError('Пополнение должно содержать от 1 до 500 позиций', 'INVALID_MERCHANT_STOCK')
  }
  const seen = new Set()
  let newPositions = 0
  const entries = input.map((raw, index) => {
    const source = lifecycleObject(raw, 'INVALID_MERCHANT_STOCK', 'Позиция пополнения')
    assertLifecycleKeys(source, MERCHANT_STOCK_FIELDS, 'INVALID_MERCHANT_STOCK', 'Позиция пополнения')
    const stockId = lifecycleId(source.stock_id, 'INVALID_STOCK_ID', 'stock_id')
    if (seen.has(stockId)) throw new RulesValidationError('stock_id должен быть уникальным в одной команде', 'DUPLICATE_STOCK_ID')
    seen.add(stockId)
    const added = lifecycleInteger(source.quantity, 1, MAX_STOCK_QUANTITY, 1, 'INVALID_QUANTITY', 'Количество пополнения')
    const existing = merchant.stock.find((stock) => String(stock.stock_id) === stockId)
    if (existing) {
      if (source.catalog_id != null && lifecycleId(source.catalog_id, 'INVALID_CATALOG_ITEM', 'catalog_id') !== String(existing.catalog_id)) {
        throw new RulesValidationError('Нельзя изменить catalog_id существующей позиции пополнением', 'STOCK_CATALOG_MISMATCH')
      }
      const before = Math.max(0, safeInteger(existing.quantity, 0))
      if (before + added > MAX_STOCK_QUANTITY) throw new RulesValidationError('Превышен предел количества товара', 'STOCK_LIMIT_EXCEEDED')
      const stock = lifecycleStockFromCanonical({ ...existing, quantity: before + added }, merchant.id, index)
      return { stock_id: stockId, catalog_id: stock.catalog_id, quantity_before: before, quantity_added: added, quantity_after: before + added, stock }
    }
    newPositions += 1
    const stock = normalizeLifecycleStockEntry(source, merchant.id, merchant.stock.length + index)
    return { stock_id: stockId, catalog_id: stock.catalog_id, quantity_before: 0, quantity_added: added, quantity_after: added, stock }
  })
  if (merchant.stock.length + newPositions > 500) throw new RulesValidationError('Склад торговца заполнен', 'MERCHANT_STOCK_FULL')
  return entries
}

function inferredItemCombat(item) {
  if (item?.combat && typeof item.combat === 'object') return clone(item.combat)
  const text = `${item?.name ?? ''} ${item?.properties ?? ''}`.toLocaleLowerCase('ru')
  if (/динамит|dynamite/u.test(text)) return { kind: 'thrown-area', ability: 'dex', damage: '3d6', damageType: 'fire', normalRange: 60, radius: 10, saveAbility: 'dex', saveDc: 12, halfOnSave: true }
  if (/гранат|бомб|grenade|bomb/u.test(text)) return { kind: 'thrown-area', ability: 'dex', damage: '2d6', damageType: 'fire', normalRange: 60, radius: 10, saveAbility: 'dex', saveDc: 12, halfOnSave: true }
  if (/арбалет|crossbow/u.test(text)) return { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 80, longRange: 320, twoHanded: true, ammunition: true }
  if (/длинн.{0,3}лук|longbow/u.test(text)) return { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 150, longRange: 600, twoHanded: true, ammunition: true }
  if (/лук|bow/u.test(text)) return { kind: 'ranged', ability: 'dex', damage: '1d6', damageType: 'piercing', normalRange: 80, longRange: 320, twoHanded: true, ammunition: true }
  return null
}

function normalizeInventory(input, ownerId) {
  const seen = new Set()
  return (Array.isArray(input) ? input : []).slice(0, 200).flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const quantity = safeInteger(raw.quantity, 1)
    if (quantity <= 0) return []
    const base = String(raw.id ?? `${ownerId}-item-${index + 1}`).trim().slice(0, 120) || `${ownerId}-item-${index + 1}`
    let id = base
    let suffix = index + 1
    while (seen.has(id)) id = `${base.slice(0, 108)}-${suffix++}`
    seen.add(id)
    const item = { ...raw, id, quantity: Math.min(MAX_STOCK_QUANTITY, quantity) }
    return [normalizeInventoryItem({
      ...item,
      ...(inferredItemCombat(item) ? { combat: inferredItemCombat(item) } : {}),
    }, { idFallback: id, preserveUnknown: true })]
  })
}

function actorId(actor) {
  return String(actor?.id ?? actor?.actor_id ?? '')
}

export function listActors(state) {
  const players = Array.isArray(state?.players) ? state.players : []
  const actors = Array.isArray(state?.actors) ? state.actors : []
  const enemies = Array.isArray(state?.enemies) ? state.enemies : []
  const byId = new Map()
  for (const actor of [...players, ...actors, ...enemies]) if (actorId(actor)) byId.set(actorId(actor), actor)
  return [...byId.values()]
}

export function findActor(state, id) {
  const expected = String(id ?? '')
  return listActors(state).find((actor) => actorId(actor) === expected) ?? null
}

function defaultMechanics() {
  return {
    schema_version: 1,
    temporary_hp: {},
    resources: {},
    conditions: {},
    defenses: {},
    concentration: {},
    positions: {},
    item_appraisals: {},
    encounter: null,
    active_effects: [],
    combat: {
      active: false,
      round: 0,
      initiative: [],
      active_index: -1,
      action_economy: {},
    },
  }
}

export function normalizeCampaignState(input = {}) {
  const state = clone(input && typeof input === 'object' ? input : {})
  const mechanics = { ...defaultMechanics(), ...(state.mechanics && typeof state.mechanics === 'object' ? state.mechanics : {}) }
  mechanics.temporary_hp = { ...(state.mechanics?.temporary_hp ?? {}) }
  mechanics.resources = clone(state.mechanics?.resources ?? {})
  mechanics.conditions = clone(state.mechanics?.conditions ?? {})
  mechanics.defenses = clone(state.mechanics?.defenses ?? {})
  mechanics.concentration = clone(state.mechanics?.concentration ?? {})
  mechanics.positions = clone(state.mechanics?.positions ?? {})
  mechanics.item_appraisals = clone(state.mechanics?.item_appraisals ?? {})
  mechanics.encounter = state.mechanics?.encounter && typeof state.mechanics.encounter === 'object'
    ? clone(state.mechanics.encounter)
    : null
  mechanics.active_effects = Array.isArray(state.mechanics?.active_effects) ? clone(state.mechanics.active_effects) : []
  mechanics.combat = { ...defaultMechanics().combat, ...(state.mechanics?.combat ?? {}) }
  mechanics.combat.initiative = Array.isArray(mechanics.combat.initiative) ? clone(mechanics.combat.initiative) : []
  mechanics.combat.action_economy = Object.fromEntries(Object.entries(clone(mechanics.combat.action_economy ?? {})).map(([id, economy]) => [id, {
    ...actionEconomy(),
    ...(economy && typeof economy === 'object' ? economy : {}),
    movement_spent: Math.max(0, safeInteger(economy?.movement_spent ?? economy?.movementSpent, 0)),
  }]))

  state.state_version = Math.max(0, safeInteger(state.state_version ?? state.stateVersion, 0))
  state.ruleset_id = String(state.ruleset_id || state.rulesetId || DEFAULT_RULESET_ID)
  state.ruleset_version = String(state.ruleset_version || state.rulesetVersion || '5.2.1')
  state.enabled_rule_packs = uniqueStrings(state.enabled_rule_packs ?? state.enabledRulePacks)
  if (!state.enabled_rule_packs.length) state.enabled_rule_packs = [state.ruleset_id]
  state.enabled_house_rules = uniqueStrings(state.enabled_house_rules ?? state.enabledHouseRules)
  state.ruleset_locked_at = state.ruleset_locked_at ?? state.rulesetLockedAt ?? null
  state.mechanics = mechanics
  state.players = Array.isArray(state.players) ? state.players.map((player) => ({
    ...player,
    hp: Math.max(0, safeInteger(player.hp, 0)),
    maxHp: Math.max(1, safeInteger(player.maxHp ?? player.max_hp, 1)),
    currency: normalizeCurrency(player.currency),
    inventory: normalizeInventory(player.inventory, String(player.id ?? 'actor')),
    combatSpells: combatSpellsFor(player),
  })) : []
  state.actors = Array.isArray(state.actors) ? state.actors.map((actor) => ({
    ...actor,
    id: String(actor.id ?? actor.actor_id ?? ''),
    hp: Math.max(0, safeInteger(actor.hp, 0)),
    maxHp: Math.max(1, safeInteger(actor.maxHp ?? actor.max_hp, 1)),
    alive: actor.alive !== false && safeInteger(actor.hp, 0) > 0,
  })).filter((actor) => actor.id) : []
  for (const player of state.players) {
    const id = actorId(player)
    mechanics.resources[id] ??= {}
    for (const [resource, maximum] of Object.entries(spellSlotMaximumsFor(player))) {
      if (!mechanics.resources[id][resource]) mechanics.resources[id][resource] = { current: maximum, max: maximum }
    }
  }
  const playerIds = new Set(state.players.map((player) => String(player.id)))
  state.partyName = String(state.partyName || 'Отряд героев').slice(0, 120)
  state.partyMemberIds = uniqueStrings(state.partyMemberIds).filter((id) => playerIds.has(id))
  if (!state.partyMemberIds.length) state.partyMemberIds = [...playerIds]
  state.enemies = Array.isArray(state.enemies) ? state.enemies.map((enemy) => ({
    ...enemy,
    hp: Math.max(0, safeInteger(enemy.hp, 0)),
    maxHp: Math.max(1, safeInteger(enemy.maxHp ?? enemy.max_hp, 1)),
    alive: enemy.alive !== false && safeInteger(enemy.hp, 0) > 0,
  })) : []
  state.merchants = normalizeMerchants(state.merchants)
  if (state.merchants.length && !state.enabled_house_rules.includes(ECONOMY_POLICY_ID)) {
    state.enabled_house_rules.push(ECONOMY_POLICY_ID)
  }
  for (const actor of listActors(state)) {
    const id = actorId(actor)
    const x = Number(actor?.x)
    const y = Number(actor?.y)
    if (!mechanics.positions[id] && Number.isSafeInteger(x) && Number.isSafeInteger(y)) mechanics.positions[id] = { x, y }
  }
  state.mapFeedback = Array.isArray(state.mapFeedback) ? clone(state.mapFeedback).slice(-6) : []
  state.battleLog = Array.isArray(state.battleLog) ? clone(state.battleLog).slice(-50) : []
  state.economyLog = Array.isArray(state.economyLog) ? clone(state.economyLog).slice(-50) : []
  const adventure = state.adventure && typeof state.adventure === 'object' ? state.adventure : {}
  state.adventure = {
    ...adventure,
    chapter: Math.max(1, safeInteger(adventure.chapter, 1)),
    history: Array.isArray(adventure.history) ? clone(adventure.history).slice(-20) : [],
    visitedLocations: uniqueStrings(adventure.visitedLocations ?? (state.scene?.location ? [state.scene.location] : [])).slice(-50),
  }
  return state
}

export function abilityModifier(score) {
  const safe = safeInteger(score, 10)
  return Math.floor((safe - 10) / 2)
}

export function isEnemyActor(state, id) {
  const expected = String(id ?? '')
  return (state?.enemies ?? []).some((enemy) => actorId(enemy) === expected)
}

export function isLivingActor(actor) {
  return Boolean(actor) && actorHp(actor) > 0 && actor?.alive !== false
}

export function actorPosition(state, id) {
  const actor = findActor(state, id)
  const stored = state?.mechanics?.positions?.[String(id)]
  const x = Number(stored?.x ?? actor?.x)
  const y = Number(stored?.y ?? actor?.y)
  return Number.isSafeInteger(x) && Number.isSafeInteger(y) ? { x, y } : null
}

function positionKey(position) {
  return `${position.x},${position.y}`
}

function tacticalCellMap(state) {
  return new Map((Array.isArray(state?.scene?.cells) ? state.scene.cells : [])
    .filter((cell) => Number.isSafeInteger(Number(cell?.x)) && Number.isSafeInteger(Number(cell?.y)))
    .map((cell) => [`${Number(cell.x)},${Number(cell.y)}`, cell]))
}

function isWalkableCell(cell) {
  if (!cell || cell.revealed === false) return false
  return ['floor', 'door'].includes(String(cell.type || 'floor').toLowerCase())
}

function occupiedPositions(state, exceptActorId = null) {
  const occupied = new Set()
  for (const actor of listActors(state)) {
    if (actorId(actor) === String(exceptActorId ?? '') || !isLivingActor(actor)) continue
    const position = actorPosition(state, actorId(actor))
    if (position) occupied.add(positionKey(position))
  }
  return occupied
}

/** Returns the shortest orthogonal path, excluding the starting square. */
export function shortestTacticalPath(state, actorIdValue, destination, { allowOccupiedDestination = false } = {}) {
  const from = actorPosition(state, actorIdValue)
  const to = { x: Number(destination?.x), y: Number(destination?.y) }
  if (!from || !Number.isSafeInteger(to.x) || !Number.isSafeInteger(to.y)) return null
  if (from.x === to.x && from.y === to.y) return []
  const cells = tacticalCellMap(state)
  const fromCell = cells.get(positionKey(from))
  if (!cells.size || !fromCell || fromCell.revealed === false || !isWalkableCell(cells.get(positionKey(to)))) return null
  const occupied = occupiedPositions(state, actorIdValue)
  const start = positionKey(from)
  const target = positionKey(to)
  const queue = [start]
  const previous = new Map([[start, null]])
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    if (current === target) break
    const [x, y] = current.split(',').map(Number)
    for (const [nextX, nextY] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const next = `${nextX},${nextY}`
      if (previous.has(next) || !isWalkableCell(cells.get(next))) continue
      if (occupied.has(next) && !(allowOccupiedDestination && next === target)) continue
      previous.set(next, current)
      queue.push(next)
    }
  }
  if (!previous.has(target)) return null
  const path = []
  for (let cursor = target; cursor && cursor !== start; cursor = previous.get(cursor)) {
    const [x, y] = cursor.split(',').map(Number)
    path.unshift({ x, y })
  }
  return path
}

function diceExpression(dice, bonus, fallbackSides) {
  let expression = typeof dice === 'string' ? dice : `1d${safeInteger(dice, fallbackSides)}`
  let parsed
  try { parsed = parseDiceExpression(expression) }
  catch { parsed = parseDiceExpression(`1d${fallbackSides}`) }
  const modifier = parsed.modifier + safeInteger(bonus, 0)
  return `${parsed.count}d${parsed.sides}${modifier > 0 ? `+${modifier}` : modifier < 0 ? modifier : ''}`
}

function trustedAttackProfile(state, actor) {
  const profile = actor?.attack_profile && typeof actor.attack_profile === 'object'
    ? actor.attack_profile
    : actor?.attackProfile && typeof actor.attackProfile === 'object'
      ? actor.attackProfile
      : {}
  const enemy = isEnemyActor(state, actorId(actor))
  const strength = abilityModifier(actor?.abilities?.str)
  const fallbackModifier = strength + Math.max(0, safeInteger(actor?.proficiency, 0))
  const explicitModifier = profile.attack_modifier ?? profile.attackModifier ?? actor?.attackBonus
  const modifier = Number.isSafeInteger(Number(explicitModifier)) ? Number(explicitModifier) : fallbackModifier
  const damageDice = profile.damage_dice ?? profile.damageDice ?? actor?.damageDice
  const damageBonus = profile.damage_bonus ?? profile.damageBonus ?? actor?.damageBonus
  const damageExpression = profile.damage_expression ?? profile.damageExpression ?? actor?.damageExpression
  let expression
  if (damageExpression) {
    try { expression = parseDiceExpression(damageExpression).canonical }
    catch { expression = diceExpression(damageDice, Number.isSafeInteger(Number(damageBonus)) ? Number(damageBonus) : strength, enemy ? 6 : 1) }
  } else {
    expression = diceExpression(damageDice, Number.isSafeInteger(Number(damageBonus)) ? Number(damageBonus) : strength, enemy ? 6 : 1)
  }
  const range = safeInteger(profile.range_feet ?? profile.rangeFeet ?? profile.range ?? actor?.attackRange ?? actor?.rangeFeet, 5)
  return {
    modifier: Math.max(-100, Math.min(100, modifier)),
    damage_expression: expression,
    damage_type: String(profile.damage_type ?? profile.damageType ?? actor?.damageType ?? 'slashing').slice(0, 40),
    range_feet: Math.max(5, Math.min(600, range)),
    advantage: Boolean(profile.advantage ?? actor?.attackAdvantage),
    disadvantage: Boolean(profile.disadvantage ?? actor?.attackDisadvantage),
  }
}

function combatItem(actor, itemId) {
  return (Array.isArray(actor?.inventory) ? actor.inventory : []).find((item) => String(item?.id) === String(itemId) && Number(item?.quantity ?? 1) > 0) ?? null
}

function itemAttackProfile(state, actor, itemId) {
  const item = combatItem(actor, itemId)
  const combat = item?.combat
  if (!item || !combat || !['melee', 'ranged'].includes(combat.kind)) return null
  const ability = combat.ability === 'dex' ? 'dex' : 'str'
  const abilityBonus = abilityModifier(actor?.abilities?.[ability])
  let damage
  try { damage = diceExpression(combat.damage, abilityBonus, combat.kind === 'ranged' ? 8 : 8) } catch { damage = `1d8${abilityBonus >= 0 ? '+' : ''}${abilityBonus}` }
  return {
    item,
    modifier: abilityBonus + Math.max(0, safeInteger(actor?.proficiency, 0)),
    damage_expression: damage,
    damage_type: String(combat.damageType || 'piercing').slice(0, 40),
    range_feet: Math.max(5, Math.min(600, safeInteger(combat.longRange ?? combat.normalRange, 5))),
    normal_range_feet: Math.max(5, Math.min(600, safeInteger(combat.normalRange, 5))),
    kind: combat.kind,
  }
}

function lineCells(from, to) {
  const result = []
  let x = from.x; let y = from.y
  const dx = Math.abs(to.x - x); const sx = x < to.x ? 1 : -1
  const dy = -Math.abs(to.y - y); const sy = y < to.y ? 1 : -1
  let error = dx + dy
  while (x !== to.x || y !== to.y) {
    const twice = 2 * error
    if (twice >= dy) { error += dy; x += sx }
    if (twice <= dx) { error += dx; y += sy }
    result.push({ x, y })
  }
  return result
}

function assertClearTrajectory(state, from, to) {
  const cells = tacticalCellMap(state)
  const trajectory = lineCells(from, to)
  if (trajectory.slice(0, -1).some((point) => String(cells.get(positionKey(point))?.type) === 'wall')) {
    throw new RulesValidationError('Траекторию перекрывает стена', 'TRAJECTORY_BLOCKED')
  }
  return trajectory
}

export function hasClearTrajectory(state, from, to) {
  try { assertClearTrajectory(state, from, to); return true } catch (error) {
    if (error instanceof RulesValidationError && error.code === 'TRAJECTORY_BLOCKED') return false
    throw error
  }
}

export function attackProfileFor(state, actorIdValue) {
  const actor = findActor(state, actorIdValue)
  return actor ? trustedAttackProfile(state, actor) : null
}

function sourceIdsFor(command) {
  const explicit = uniqueStrings(command.source_rule_ids ?? command.sourceRuleIds)
  return explicit.length ? explicit : (COMMAND_RULES[command.command_type] ?? [])
}

function normalizeCommand(input, state) {
  const command = { ...(input ?? {}) }
  command.command_type = String(command.command_type ?? command.type ?? '')
  command.command_id = String(command.command_id ?? command.commandId ?? randomUUID())
  command.actor_id = command.actor_id == null && command.actorId == null ? null : String(command.actor_id ?? command.actorId)
  command.target_id = command.target_id == null && command.targetId == null ? null : String(command.target_id ?? command.targetId)
  command.target_ids = uniqueStrings(command.target_ids ?? command.targetIds ?? (command.target_id ? [command.target_id] : []))
  command.source_rule_ids = sourceIdsFor(command)
  command.house_rule_id = command.house_rule_id ?? command.houseRuleId ?? null
  command.ruling_id = command.ruling_id ?? command.rulingId ?? null
  command.merchant_id = command.merchant_id == null && command.merchantId == null ? null : String(command.merchant_id ?? command.merchantId).slice(0, 120)
  command.stock_id = command.stock_id == null && command.stockId == null ? null : String(command.stock_id ?? command.stockId).slice(0, 120)
  command.item_id = command.item_id == null && command.itemId == null ? null : String(command.item_id ?? command.itemId).slice(0, 120)
  command.quantity = safeInteger(command.quantity, 1)
  command.request_fingerprint = command.request_fingerprint == null ? null : String(command.request_fingerprint).slice(0, 128)
  if (['BargainWithMerchant', 'AppraiseItem', 'BuyItem', 'SellItem'].includes(command.command_type) || MERCHANT_LIFECYCLE_COMMAND_TYPES.has(command.command_type)) {
    if (!command.house_rule_id) command.house_rule_id = ECONOMY_POLICY_ID
  }
  if (MERCHANT_LIFECYCLE_COMMAND_TYPES.has(command.command_type)) {
    command.actor_id = null
    command.target_id = null
    command.target_ids = []
  }
  if (ENCOUNTER_LIFECYCLE_COMMAND_TYPES.has(command.command_type)) {
    command.actor_id = null
    command.target_id = null
    command.target_ids = []
    command.difficulty = String(command.difficulty ?? '')
    command.theme = String(command.theme ?? '')
    command.seed = String(command.seed ?? '').slice(0, 120)
  }
  if (command.command_type === 'AdvanceScene') {
    command.actor_id = null
    command.target_id = null
    command.target_ids = []
    command.scene_args = command.scene_args ?? command.sceneArgs
    delete command.sceneArgs
    command.party_decision = command.party_decision ?? command.partyDecision
    delete command.partyDecision
  }
  command.expected_state_version = safeInteger(command.expected_state_version ?? command.expectedStateVersion, state.state_version)
  return command
}

function needsActor(type) {
  return new Set(['DeclareAction', 'MakeAbilityCheck', 'MakeSavingThrow', 'MakeAttack', 'MakeAreaAttack', 'ChangeWeapon', 'ApplyDamage', 'ApplyHealing',
    'GrantTemporaryHitPoints', 'SpendResource', 'RestoreResource', 'AddCondition', 'RemoveCondition', 'CastSpell',
    'MoveActor', 'EndCombat', 'EndTurn', 'StartConcentration', 'EndConcentration', 'GrantItem',
    'BargainWithMerchant', 'AppraiseItem', 'BuyItem', 'SellItem']).has(type)
}

function targetFor(command) {
  return command.target_id || command.target_ids[0] || command.actor_id
}

function playerActor(state, id) {
  return (Array.isArray(state?.players) ? state.players : []).find((player) => String(player.id) === String(id ?? '')) ?? null
}

function inventoryItem(actor, itemId) {
  return (Array.isArray(actor?.inventory) ? actor.inventory : []).find((item) => String(item?.id) === String(itemId ?? '')) ?? null
}

const APPRAISAL_RARITY = Object.freeze({
  'обычный': 'common',
  'необычный': 'uncommon',
  'редкий': 'rare',
  'очень редкий': 'very_rare',
  'легендарный': 'legendary',
  common: 'common',
  uncommon: 'uncommon',
  rare: 'rare',
  very_rare: 'very_rare',
  legendary: 'legendary',
})

function appraisalCategory(item) {
  const type = String(item?.type ?? '').toLowerCase()
  if (['weapon', 'armor', 'consumable', 'tool', 'treasure'].includes(type)) return type
  return 'miscellaneous'
}

function appraisalForInventoryItem(actor, merchant, item) {
  const stackKey = inventoryStackKey(item)
  const digest = String(stackKey).split(':').at(-1) || 'custom'
  const appraisal = appraiseItem({
    homebrew_id: `homebrew:${digest}`,
    name: String(item?.name ?? 'Предмет'),
    category: appraisalCategory(item),
    rarity: APPRAISAL_RARITY[String(item?.rarity ?? '').toLocaleLowerCase('ru')] ?? 'common',
    condition: 'serviceable',
  }, { policyId: CATEGORY_APPRAISAL_POLICY_ID })
  return {
    ...appraisal,
    appraisal_id: `appraisal:${appraisal.appraisal_fingerprint.slice(0, 24)}`,
    actor_id: String(actor.id),
    merchant_id: String(merchant.id),
    item_id: String(item.id),
    item_stack_key: stackKey,
  }
}

function appraisalBlocked(item) {
  return item?.quest_item === true
    || item?.sellable === false
    || String(item?.type || '').toLowerCase() === 'quest'
    || String(item?.rarity || '').toLocaleLowerCase('ru') === 'сюжетный'
}

function inventoryStackIndex(inventory, incoming) {
  const current = Array.isArray(inventory) ? inventory : []
  if (!incoming || incoming.equipped === true) return -1
  const incomingKey = inventoryStackKey(incoming)
  return current.findIndex((item) => item?.equipped !== true && inventoryStackKey(item) === incomingKey)
}

function merchantStock(merchant, stockId) {
  return (Array.isArray(merchant?.stock) ? merchant.stock : []).find((stock) => String(stock?.stock_id) === String(stockId ?? '')) ?? null
}

function checkedTransactionTotal(unitPrice, quantity) {
  const unit = safeInteger(unitPrice, 0)
  const count = safeInteger(quantity, 0)
  if (unit <= 0 || count <= 0 || count > MAX_TRANSACTION_QUANTITY || unit > Math.floor(MAX_CURRENCY_CP / count)) {
    throw new RulesValidationError('Некорректная сумма торговой операции', 'INVALID_TRANSACTION_TOTAL')
  }
  return unit * count
}

function persuasionCheckModifier(actor) {
  const explicitTotals = [actor?.skills?.persuasion_modifier, actor?.skillModifiers?.persuasion, actor?.persuasionModifier]
  const explicitTotal = explicitTotals.find((value) => Number.isSafeInteger(Number(value)))
  if (explicitTotal != null) return Math.max(-10, Math.min(20, safeInteger(explicitTotal, 0)))
  const bonuses = [actor?.skills?.persuasion_bonus, actor?.skillBonuses?.persuasion, actor?.persuasionBonus]
  const bonus = bonuses.find((value) => Number.isSafeInteger(Number(value)))
  return Math.max(-10, Math.min(20, abilityModifier(actor?.abilities?.cha) + safeInteger(bonus, 0)))
}

function assertActorPermission(command, context, state) {
  if (!command.actor_id || context?.isAdmin) return
  const allowed = Array.isArray(context?.allowedActorIds) ? context.allowedActorIds.map(String) : null
  const actor = findActor(state, command.actor_id)
  const delegatedOwner = String(actor?.controllerId ?? actor?.controller_id ?? actor?.ownerId ?? actor?.owner_id ?? '')
  if (allowed && !allowed.includes(command.actor_id) && !(isPartySummon(actor) && allowed.includes(delegatedOwner))) {
    throw new RulesValidationError('Игрок не может действовать от имени этого персонажа', 'ACTOR_FORBIDDEN')
  }
}

function assertTurn(command, state) {
  const combat = state.mechanics.combat
  if (!combat.active || !['MakeAttack', 'MakeAreaAttack', 'ChangeWeapon', 'CastSpell', 'MoveActor', 'EndCombat', 'EndTurn'].includes(command.command_type)) return
  const current = combat.initiative[combat.active_index]
  if (current && String(current.actor_id) !== command.actor_id) {
    throw new RulesValidationError('Сейчас ход другого участника', 'OUT_OF_TURN')
  }
  if (command.command_type === 'CastSpell') {
    const spell = combatSpellFor(findActor(state, command.actor_id), command.spell_id)
    const resource = spell?.actionType === 'bonus_action' ? 'bonus_action' : spell?.actionType === 'reaction' ? 'reaction' : 'action'
    const economy = combat.action_economy[command.actor_id]
    if (economy && economy[resource] === false) {
      const label = resource === 'bonus_action' ? 'Бонусное действие' : resource === 'reaction' ? 'Реакция' : 'Действие'
      throw new RulesValidationError(`${label} на этом ходу уже потрачено`, resource === 'bonus_action' ? 'BONUS_ACTION_SPENT' : resource === 'reaction' ? 'REACTION_SPENT' : 'ACTION_SPENT')
    }
  } else if (['MakeAttack', 'MakeAreaAttack', 'ChangeWeapon'].includes(command.command_type)) {
    const economy = combat.action_economy[command.actor_id]
    if (economy && economy.action === false) throw new RulesValidationError('Действие на этом ходу уже потрачено', 'ACTION_SPENT')
  }
}

function assembleEncounterFromState(state, command) {
  const memberIds = new Set(state.partyMemberIds?.length ? state.partyMemberIds.map(String) : state.players.map(actorId))
  const party = state.players.filter((actor) => memberIds.has(actorId(actor)) && isLivingActor(actor)).map((actor) => {
    const position = actorPosition(state, actorId(actor))
    return {
      id: actorId(actor),
      level: Math.max(1, Math.min(20, safeInteger(actor.level, 1))),
      x: position?.x,
      y: position?.y,
    }
  })
  const cells = (Array.isArray(state.scene?.cells) ? state.scene.cells : []).map((cell) => ({
    x: Number(cell?.x),
    y: Number(cell?.y),
    type: String(cell?.type ?? 'floor'),
    revealed: cell?.revealed === true,
    ...(cell?.feature == null ? {} : { feature: String(cell.feature) }),
  }))
  return assembleEncounter({
    scene: { cells },
    party,
    difficulty: command.difficulty,
    theme: command.theme,
    seed: command.seed,
  })
}

export function validateCommand(input, rawState, context = {}) {
  const state = normalizeCampaignState(rawState)
  const command = normalizeCommand(input, state)
  if (!ALLOWED_COMMAND_TYPES.has(command.command_type)) {
    throw new RulesValidationError('Тип команды не разрешён', 'COMMAND_NOT_ALLOWED')
  }
  if (command.expected_state_version !== state.state_version) {
    throw new RulesValidationError('Состояние кампании изменилось; ход нужно повторить', 'STATE_VERSION_CONFLICT')
  }
  if (command.command_type === 'AdvanceScene') {
    if (context?.isAdmin !== true && context?.isDirector !== true) {
      throw new RulesValidationError('Переход между сценами доступен только системному контуру кампании', 'SCENE_ADVANCE_FORBIDDEN')
    }
    if (state.mechanics.combat.active) {
      throw new RulesValidationError('Нельзя сменить сцену до завершения активного боя', 'SCENE_ADVANCE_DURING_COMBAT')
    }
    command.scene_args = normalizeSceneAdvanceArgs(command.scene_args)
    command.scene_commerce = normalizeSceneCommerce(command.scene_commerce)
    command.party_decision = normalizePartyDecisionReference(command.party_decision, { required: context?.isDirector === true })
  }
  if (ENCOUNTER_LIFECYCLE_COMMAND_TYPES.has(command.command_type)) {
    if (context?.isAdmin !== true && context?.isDirector !== true) {
      throw new RulesValidationError('Создать столкновение может только системный контур кампании', 'ENCOUNTER_MANAGEMENT_FORBIDDEN')
    }
    if (state.mechanics.combat.active) {
      throw new RulesValidationError('Нельзя создать новое столкновение во время активного боя', 'ENCOUNTER_DURING_COMBAT')
    }
    if (state.enemies.some(isLivingActor) || ['staged', 'active'].includes(String(state.mechanics.encounter?.status ?? ''))) {
      throw new RulesValidationError('В текущей сцене уже есть незавершённое столкновение', 'ENCOUNTER_ALREADY_PRESENT')
    }
    try {
      command.encounter = assembleEncounterFromState(state, command)
    } catch (error) {
      throw new RulesValidationError(error instanceof Error ? error.message : 'Не удалось собрать столкновение', error?.code ?? 'ENCOUNTER_ASSEMBLY_REJECTED')
    }
  }
  if (MERCHANT_LIFECYCLE_COMMAND_TYPES.has(command.command_type)) {
    if (context?.isAdmin !== true && context?.isDirector !== true) {
      throw new RulesValidationError('Управлять торговцами может только администратор кампании', 'MERCHANT_MANAGEMENT_FORBIDDEN')
    }
    if (command.command_type === 'CreateMerchant') {
      if (state.merchants.length >= 100) throw new RulesValidationError('Достигнут предел количества торговцев', 'MERCHANT_LIMIT_EXCEEDED')
      command.merchant = normalizeLifecycleMerchant(command.merchant)
      command.merchant_id = command.merchant.id
      if (findMerchant(state, command.merchant_id)) throw new RulesValidationError('Торговец с таким id уже существует', 'MERCHANT_ALREADY_EXISTS')
    } else {
      command.merchant_id = lifecycleId(command.merchant_id, 'INVALID_MERCHANT_ID', 'merchant_id')
      const merchant = findMerchant(state, command.merchant_id)
      if (!merchant) throw new RulesValidationError('Торговец не найден', 'MERCHANT_NOT_FOUND')
      if (command.command_type === 'ConfigureMerchant') {
        command.configuration = normalizeLifecycleConfiguration(command.configuration, merchant)
        command.reset_bargains = Object.hasOwn(command.configuration, 'pricing')
      }
      if (command.command_type === 'RestockMerchant') {
        command.items = normalizeLifecycleRestock(command.items ?? command.stock, merchant)
      }
      if (command.command_type === 'MoveMerchant') {
        command.location = lifecycleText(command.location, 180, { required: true, code: 'INVALID_MERCHANT_LOCATION', label: 'Локация торговца' })
      }
      if (command.command_type === 'SetMerchantAvailability') {
        if (typeof command.available !== 'boolean') {
          throw new RulesValidationError('Доступность торговца должна быть логическим значением', 'INVALID_MERCHANT_AVAILABILITY')
        }
      }
    }
  }
  if (needsActor(command.command_type) && (!command.actor_id || !findActor(state, command.actor_id))) {
    throw new RulesValidationError('Действующий персонаж не найден', 'ACTOR_NOT_FOUND')
  }
  for (const id of command.target_ids) {
    if (['RevealArea', 'UpdateObjective', 'SpawnEntity', 'GrantItem', 'RecordRuling'].includes(command.command_type)) break
    if (!findActor(state, id)) throw new RulesValidationError(`Цель ${id} не найдена`, 'TARGET_NOT_FOUND')
  }
  assertActorPermission(command, context, state)
  assertTurn(command, state)

  if (command.command_type === 'StartCombat' && state.mechanics.combat.active) {
    throw new RulesValidationError('Бой уже начат', 'COMBAT_ALREADY_ACTIVE')
  }
  if (['BargainWithMerchant', 'AppraiseItem', 'BuyItem', 'SellItem'].includes(command.command_type)) {
    const actor = playerActor(state, command.actor_id)
    const merchant = findMerchant(state, command.merchant_id)
    if (!actor) throw new RulesValidationError('Торговать может только герой кампании', 'ACTOR_FORBIDDEN')
    if (!merchant) throw new RulesValidationError('Торговец не найден', 'MERCHANT_NOT_FOUND')
    if (merchant.available === false) throw new RulesValidationError('Торговец сейчас недоступен', 'MERCHANT_UNAVAILABLE')
    if (!merchantIsAtLocation(merchant.location, state.scene?.location)) {
      throw new RulesValidationError('Торговец находится в другой локации', 'MERCHANT_NOT_PRESENT')
    }
    if (state.mechanics.combat.active) throw new RulesValidationError('Во время боя торговля недоступна', 'COMBAT_ACTIVE')
    if (command.command_type === 'BargainWithMerchant') {
      if (bargainFor(merchant, actor.id)) throw new RulesValidationError('Условия с этим торговцем уже согласованы', 'BARGAIN_ALREADY_RESOLVED')
    } else if (['BuyItem', 'SellItem'].includes(command.command_type) && (!Number.isSafeInteger(command.quantity) || command.quantity < 1 || command.quantity > MAX_TRANSACTION_QUANTITY)) {
      throw new RulesValidationError('Количество должно быть положительным целым числом в допустимых пределах', 'INVALID_QUANTITY')
    }
    if (command.command_type === 'AppraiseItem') {
      const item = inventoryItem(actor, command.item_id)
      if (!item) throw new RulesValidationError('Предмет не найден в инвентаре героя', 'ITEM_NOT_FOUND')
      if (resolveCatalogPrice(item)) throw new RulesValidationError('Каталожный предмет уже имеет серверную цену', 'APPRAISAL_NOT_REQUIRED')
      if (appraisalBlocked(item)) throw new RulesValidationError('Этот предмет нельзя оценить для продажи', 'ITEM_NOT_APPRAISABLE')
      if (trustedItemAppraisalFor(state, actor.id, item)) throw new RulesValidationError('Предмет уже оценён', 'ITEM_ALREADY_APPRAISED')
    }
    if (command.command_type === 'BuyItem') {
      const stock = merchantStock(merchant, command.stock_id)
      if (!stock) throw new RulesValidationError('Товар не найден на складе торговца', 'STOCK_NOT_FOUND')
      if (safeInteger(stock.quantity, 0) < command.quantity) throw new RulesValidationError('У торговца недостаточно товара', 'INSUFFICIENT_STOCK')
      const quote = quoteMerchantBuyUnit(merchant, actor.id, stock)
      if (!quote) throw new RulesValidationError('Для товара не задана серверная цена', 'PRICE_UNAVAILABLE')
      const total = checkedTransactionTotal(quote.unit_price_cp, command.quantity)
      if (currencyToCopper(actor.currency) < total) throw new RulesValidationError('У героя недостаточно монет', 'INSUFFICIENT_FUNDS')
      if (normalizeMerchantPurseCp(merchant.purse_cp) + total > MAX_CURRENCY_CP) {
        throw new RulesValidationError('Кошелёк торговца не может вместить столько монет', 'MERCHANT_PURSE_LIMIT_EXCEEDED')
      }
      const purchased = inventoryItemFromStock(stock)
      const existingIndex = inventoryStackIndex(actor.inventory, purchased)
      const existing = existingIndex >= 0 ? actor.inventory[existingIndex] : null
      if (!existing && actor.inventory.length >= 200) throw new RulesValidationError('Инвентарь героя заполнен', 'INVENTORY_FULL')
      if (existing && safeInteger(existing.quantity, 1) + command.quantity > MAX_STOCK_QUANTITY) throw new RulesValidationError('Превышен предел количества предметов', 'INVENTORY_QUANTITY_EXCEEDED')
    }
    if (command.command_type === 'SellItem') {
      const item = inventoryItem(actor, command.item_id)
      if (!item) throw new RulesValidationError('Предмет не найден в инвентаре героя', 'ITEM_NOT_FOUND')
      if (safeInteger(item.quantity, 1) < command.quantity) throw new RulesValidationError('В инвентаре недостаточно предметов', 'INSUFFICIENT_ITEMS')
      const appraisal = trustedItemAppraisalFor(state, actor.id, item)
      const allowed = sellability(item, appraisal)
      if (!allowed.can_sell) throw new RulesValidationError(allowed.reason, item.equipped ? 'ITEM_EQUIPPED' : 'ITEM_NOT_SELLABLE')
      const quote = quoteMerchantSellUnit(merchant, actor.id, item, appraisal)
      if (!quote) throw new RulesValidationError('Для предмета не задана серверная цена', 'PRICE_UNAVAILABLE')
      const total = checkedTransactionTotal(quote.unit_price_cp, command.quantity)
      if (normalizeMerchantPurseCp(merchant.purse_cp) < total) {
        throw new RulesValidationError('У торговца недостаточно монет для выкупа предмета', 'INSUFFICIENT_MERCHANT_FUNDS')
      }
      if (currencyToCopper(actor.currency) + total > MAX_CURRENCY_CP) throw new RulesValidationError('Кошелёк героя не может вместить столько монет', 'CURRENCY_LIMIT_EXCEEDED')
      const itemStackKey = inventoryStackKey(item)
      const matchingStock = merchant.stock.find((stock) => inventoryStackKey(stock) === itemStackKey)
      if (matchingStock && safeInteger(matchingStock.quantity, 0) + command.quantity > MAX_STOCK_QUANTITY) throw new RulesValidationError('Склад торговца заполнен', 'STOCK_LIMIT_EXCEEDED')
      if (!matchingStock && merchant.stock.length >= 500) throw new RulesValidationError('Склад торговца заполнен', 'MERCHANT_STOCK_FULL')
    }
  }
  if (command.command_type === 'MakeAttack') {
    const actor = findActor(state, command.actor_id)
    const target = findActor(state, targetFor(command))
    const authoritativeCombat = Boolean(
      command.server_authoritative
      || context.serverAuthoritativeCombat
      || context.isNpcScheduler
      || isEnemyActor(state, command.actor_id)
      || isEnemyActor(state, targetFor(command)),
    )
    if (authoritativeCombat && !state.mechanics.combat.active) {
      throw new RulesValidationError('Сначала нужно начать бой и определить инициативу', 'COMBAT_NOT_ACTIVE')
    }
    if (!target || targetFor(command) === command.actor_id) throw new RulesValidationError('Нужна другая живая цель атаки', 'INVALID_ATTACK_TARGET')
    if (!isLivingActor(actor)) throw new RulesValidationError('Побеждённый участник не может атаковать', 'ACTOR_DEFEATED')
    if (!isLivingActor(target)) throw new RulesValidationError('Цель уже побеждена', 'TARGET_DEFEATED')
    if (command.item_id && !itemAttackProfile(state, actor, command.item_id)) throw new RulesValidationError('Выбранное оружие недоступно', 'INVALID_WEAPON')
    const selected = command.item_id ? combatItem(actor, command.item_id) : null
    const otherEquipped = (actor?.inventory ?? []).find((item) => item.type === 'weapon' && item.equipped && String(item.id) !== String(command.item_id))
    if (selected?.type === 'weapon' && !selected.equipped && otherEquipped) throw new RulesValidationError('Сначала уберите экипированное оружие; смена занимает действие', 'WEAPON_SWAP_REQUIRED')
  }
  if (command.command_type === 'ChangeWeapon') {
    const actor = findActor(state, command.actor_id)
    if (!combatItem(actor, command.item_id)?.combat || combatItem(actor, command.item_id)?.type !== 'weapon') throw new RulesValidationError('Оружие не найдено в инвентаре', 'INVALID_WEAPON')
  }
  if (command.command_type === 'MakeAreaAttack') {
    const actor = findActor(state, command.actor_id)
    const item = combatItem(actor, command.item_id)
    if (item?.combat?.kind !== 'thrown-area') throw new RulesValidationError('Метательный предмет недоступен', 'INVALID_THROWABLE')
    if (!Number.isSafeInteger(Number(command.to?.x)) || !Number.isSafeInteger(Number(command.to?.y))) throw new RulesValidationError('Нужна клетка броска', 'INVALID_DESTINATION')
    const targetCell = tacticalCellMap(state).get(`${Number(command.to.x)},${Number(command.to.y)}`)
    if (!targetCell || targetCell.revealed === false || targetCell.type === 'wall') throw new RulesValidationError('В эту клетку нельзя бросить предмет', 'INVALID_DESTINATION')
  }
  if (command.command_type === 'CastSpell' && (command.server_authoritative || context.serverAuthoritativeCombat)) {
    const actor = findActor(state, command.actor_id)
    const spell = combatSpellFor(actor, command.spell_id)
    if (!state.mechanics.combat.active) throw new RulesValidationError('Сначала нужно начать бой и определить инициативу', 'COMBAT_NOT_ACTIVE')
    if (!isLivingActor(actor)) throw new RulesValidationError('Побеждённый участник не может творить заклинания', 'ACTOR_DEFEATED')
    if (!spell) throw new RulesValidationError('Заклинание не найдено среди доступных герою', 'SPELL_NOT_AVAILABLE')
    const from = actorPosition(state, command.actor_id)
    if (!from) throw new RulesValidationError('Заклинатель должен находиться на карте', 'MAP_POSITION_REQUIRED')
    if (spell.target === 'point') {
      const to = { x: Number(command.to?.x), y: Number(command.to?.y) }
      if (!Number.isSafeInteger(to.x) || !Number.isSafeInteger(to.y)) throw new RulesValidationError('Нужно выбрать клетку для заклинания', 'INVALID_DESTINATION')
      const cell = tacticalCellMap(state).get(positionKey(to))
      if (!isWalkableCell(cell) || occupiedPositions(state).has(positionKey(to))) throw new RulesValidationError('Выбранная клетка недоступна', 'INVALID_DESTINATION')
      const distance = Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) * 5
      if (distance > spell.range) throw new RulesValidationError('Клетка находится вне дальности заклинания', 'TARGET_OUT_OF_RANGE')
      assertClearTrajectory(state, from, to)
    } else {
      const target = findActor(state, targetFor(command))
      if (!target || !isLivingActor(target)) throw new RulesValidationError('Нужна живая цель заклинания', 'INVALID_SPELL_TARGET')
      const targetIsEnemy = isEnemyActor(state, actorId(target))
      if (spell.target === 'enemy' && !targetIsEnemy) throw new RulesValidationError('Это заклинание требует противника', 'INVALID_SPELL_TARGET')
      if (spell.target === 'ally' && targetIsEnemy) throw new RulesValidationError('Это заклинание требует союзника', 'INVALID_SPELL_TARGET')
      const to = actorPosition(state, actorId(target))
      if (!to) throw new RulesValidationError('Цель должна находиться на карте', 'MAP_POSITION_REQUIRED')
      const distance = Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) * 5
      if (distance > spell.range) throw new RulesValidationError('Цель находится вне дальности заклинания', 'TARGET_OUT_OF_RANGE')
      if (distance > 5) assertClearTrajectory(state, from, to)
    }
    if (spell.slotResource) {
      const pool = resourcePool(state, command.actor_id, spell.slotResource)
      if (pool.current < 1) throw new RulesValidationError('Нет доступной ячейки нужного уровня', 'INSUFFICIENT_RESOURCE')
    }
  }
  if (command.command_type === 'MoveActor') {
    const x = Number(command.to?.x)
    const y = Number(command.to?.y)
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw new RulesValidationError('Нужны целые координаты назначения', 'INVALID_DESTINATION')
    if (!isLivingActor(findActor(state, command.actor_id))) throw new RulesValidationError('Побеждённый участник не может двигаться', 'ACTOR_DEFEATED')
  }

  if (!command.source_rule_ids.length && !command.house_rule_id && !command.ruling_id && !['DeclareAction', 'RevealArea', 'UpdateObjective', 'SpawnEntity', 'GrantItem', 'RecordRuling', 'AdvanceScene', 'CreateEncounter'].includes(command.command_type)) {
    throw new RulesValidationError('Для механического решения нужен rule_id, house_rule_id или ruling_id', 'PROVENANCE_REQUIRED')
  }
  if (['ApplyDamage', 'ApplyHealing', 'GrantTemporaryHitPoints'].includes(command.command_type)) {
    const amount = Number(command.amount)
    if ((!Number.isFinite(amount) || amount < 0) && !command.expression) throw new RulesValidationError('Нужно неотрицательное количество или формула костей', 'INVALID_AMOUNT')
  }
  if (['SpendResource', 'RestoreResource'].includes(command.command_type)) {
    if (!String(command.resource || '').trim()) throw new RulesValidationError('Не указан ресурс', 'RESOURCE_REQUIRED')
    if (!Number.isSafeInteger(Number(command.amount)) || Number(command.amount) <= 0) throw new RulesValidationError('Количество ресурса должно быть положительным целым', 'INVALID_AMOUNT')
  }
  if (command.command_type === 'AddCondition' && !String(command.condition || '').trim()) {
    throw new RulesValidationError('Не указано состояние', 'CONDITION_REQUIRED')
  }
  return command
}

function eventFrom(command, eventType, payload = {}, targets = command.target_ids) {
  return {
    campaign_id: command.campaign_id ?? null,
    command_id: command.command_id,
    event_type: eventType,
    actor_id: command.actor_id,
    target_ids: uniqueStrings(targets),
    payload: clone(payload),
    source_rule_ids: [...command.source_rule_ids],
    house_rule_id: command.house_rule_id,
    ruling_id: command.ruling_id,
    visibility: command.visibility ?? 'public',
  }
}

function commandWithRules(command, ...ruleIds) {
  return { ...command, source_rule_ids: [...new Set([...command.source_rule_ids, ...ruleIds.filter(Boolean)])] }
}

function criticalDamageExpression(expression) {
  const parsed = parseDiceExpression(expression)
  const count = Math.min(100, parsed.count * 2)
  return `${count}d${parsed.sides}${parsed.modifier > 0 ? `+${parsed.modifier}` : parsed.modifier < 0 ? parsed.modifier : ''}`
}

function actorHp(actor) {
  return Math.max(0, safeInteger(actor?.hp, 0))
}

function actorMaxHp(actor) {
  return Math.max(1, safeInteger(actor?.maxHp ?? actor?.max_hp, 1))
}

function defenseFor(state, id) {
  const defense = state.mechanics.defenses[id] ?? {}
  return {
    resistances: uniqueStrings(defense.resistances),
    vulnerabilities: uniqueStrings(defense.vulnerabilities),
    immunities: uniqueStrings(defense.immunities),
  }
}

function damagePayload(state, targetId, rawAmount, damageType = 'untyped') {
  const actor = findActor(state, targetId)
  if (!actor) throw new RulesValidationError('Цель урона не найдена', 'TARGET_NOT_FOUND')
  const raw = Math.max(0, Math.floor(Number(rawAmount) || 0))
  const defenses = defenseFor(state, targetId)
  const immune = defenses.immunities.includes(damageType)
  const resistant = defenses.resistances.includes(damageType)
  const vulnerable = defenses.vulnerabilities.includes(damageType)
  let afterDefense = immune ? 0 : raw
  if (!immune && resistant && !vulnerable) afterDefense = Math.floor(afterDefense / 2)
  if (!immune && vulnerable && !resistant) afterDefense *= 2
  const temporaryBefore = Math.max(0, safeInteger(state.mechanics.temporary_hp[targetId], 0))
  const absorbed = Math.min(temporaryBefore, afterDefense)
  const applied = afterDefense - absorbed
  const hpBefore = actorHp(actor)
  const hpAfter = Math.max(0, hpBefore - applied)
  return {
    damage_type: damageType,
    raw_amount: raw,
    applied_amount: applied,
    immune,
    resistant,
    vulnerable,
    temporary_hp_before: temporaryBefore,
    temporary_hp_after: temporaryBefore - absorbed,
    temporary_hp_absorbed: absorbed,
    hp_before: hpBefore,
    hp_after: hpAfter,
  }
}

function resourcePool(state, actorIdValue, resourceName, providedMax = 0) {
  const pool = state.mechanics.resources[actorIdValue]?.[resourceName]
  const maximum = Math.max(0, safeInteger(pool?.max, providedMax))
  return { current: Math.max(0, safeInteger(pool?.current, maximum)), max: maximum }
}

function actionEconomy() {
  return { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
}

function sortedInitiative(entries) {
  return [...entries].sort((left, right) => right.total - left.total || right.modifier - left.modifier || String(left.actor_id).localeCompare(String(right.actor_id)))
}

function sceneAdvancePartyIds(state) {
  const playerIds = new Set((state.players ?? []).map((player) => actorId(player)))
  const requested = state.partyMemberIds?.length ? state.partyMemberIds : [...playerIds]
  return uniqueStrings(requested).filter((id) => playerIds.has(id))
}

function sceneAdvancePartyPositions(state, transition) {
  const partyIds = sceneAdvancePartyIds(state)
  const entrance = {
    x: safeInteger(transition?.entrance?.x, 0),
    y: safeInteger(transition?.entrance?.y, 0),
  }
  const seen = new Set()
  const cells = (Array.isArray(transition?.scene?.cells) ? transition.scene.cells : [])
    .filter((cell) => {
      const x = Number(cell?.x)
      const y = Number(cell?.y)
      const key = `${x},${y}`
      if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || seen.has(key)) return false
      if (!['floor', 'door'].includes(String(cell?.type || 'floor').toLowerCase())) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => {
      const leftDistance = Math.abs(Number(left.x) - entrance.x) + Math.abs(Number(left.y) - entrance.y)
      const rightDistance = Math.abs(Number(right.x) - entrance.x) + Math.abs(Number(right.y) - entrance.y)
      return leftDistance - rightDistance
        || Number(Boolean(left.feature)) - Number(Boolean(right.feature))
        || Number(left.y) - Number(right.y)
        || Number(left.x) - Number(right.x)
    })
  if (cells.length < partyIds.length) {
    throw new RulesValidationError('На входе новой сцены недостаточно проходимых клеток для отряда', 'SCENE_ENTRANCE_CAPACITY_EXCEEDED')
  }
  return partyIds.map((id, index) => ({ actor_id: id, x: Number(cells[index].x), y: Number(cells[index].y) }))
}

export function resolveCommand(input, rawState, { diceService, context = {} } = {}) {
  if (!diceService) throw new TypeError('RulesEngine требует DiceService')
  const state = normalizeCampaignState(rawState)
  const command = validateCommand(input, state, context)
  const events = []
  const rolls = []
  const targetId = targetFor(command)

  const rollAmount = (purpose, fallback = 0) => {
    if (!command.expression) return Math.max(0, Math.floor(Number(command.amount ?? fallback) || 0))
    const roll = diceService.roll(command.expression, purpose, command.actor_id, command.visibility ?? 'public')
    rolls.push(roll)
    events.push(eventFrom(command, 'DieRolled', roll, []))
    return Math.max(0, roll.total)
  }

  switch (command.command_type) {
    case 'DeclareAction':
      events.push(eventFrom(command, 'ActionDeclared', { action: String(command.action || '').slice(0, 1000) }, []))
      break
    case 'MakeAbilityCheck': {
      const actor = findActor(state, command.actor_id)
      const ability = String(command.ability || 'str').toLowerCase()
      const modifier = Number.isSafeInteger(Number(command.modifier))
        ? Number(command.modifier)
        : abilityModifier(actor?.abilities?.[ability]) + (command.proficient ? safeInteger(actor?.proficiency, 0) : 0)
      const roll = diceService.rollCheck({ modifier, difficulty: safeInteger(command.difficulty, 10), purpose: `ability_check:${ability}`, actorId: command.actor_id, advantage: Boolean(command.advantage), disadvantage: Boolean(command.disadvantage), visibility: command.visibility })
      rolls.push(roll)
      events.push(eventFrom(commandWithRules(command, command.advantage || command.disadvantage ? RULE_IDS.advantage : null), 'AbilityCheckResolved', { ability, ...roll }, [command.actor_id]))
      break
    }
    case 'MakeSavingThrow': {
      const actor = findActor(state, command.actor_id)
      const ability = String(command.ability || 'con').toLowerCase()
      const modifier = Number.isSafeInteger(Number(command.modifier))
        ? Number(command.modifier)
        : abilityModifier(actor?.abilities?.[ability]) + (command.proficient ? safeInteger(actor?.proficiency, 0) : 0)
      const roll = diceService.rollCheck({ modifier, difficulty: safeInteger(command.difficulty, 10), purpose: `saving_throw:${ability}`, actorId: command.actor_id, advantage: Boolean(command.advantage), disadvantage: Boolean(command.disadvantage), visibility: command.visibility })
      rolls.push(roll)
      events.push(eventFrom(commandWithRules(command, command.advantage || command.disadvantage ? RULE_IDS.advantage : null), 'SavingThrowResolved', { ability, ...roll }, [command.actor_id]))
      break
    }
    case 'MakeAttack': {
      const actor = findActor(state, command.actor_id)
      const target = findActor(state, targetId)
      const authoritative = Boolean(command.server_authoritative || context.serverAuthoritativeCombat || context.isNpcScheduler || isEnemyActor(state, command.actor_id) || isEnemyActor(state, targetId))
      const selectedProfile = authoritative && command.item_id ? itemAttackProfile(state, actor, command.item_id) : null
      const profile = selectedProfile ?? (authoritative ? trustedAttackProfile(state, actor) : null)
      if (profile) {
        command.attack_modifier = profile.modifier
        command.damage_expression = profile.damage_expression
        command.damage_type = profile.damage_type
        command.range_feet = profile.range_feet
        delete command.armor_class
        delete command.damage_amount
        delete command.advantage
        delete command.disadvantage
      }
      const armorClass = Math.max(0, safeInteger(target?.armor ?? target?.armorClass, 10))
      const actorAt = actorPosition(state, command.actor_id)
      const targetAt = actorPosition(state, targetId)
      const hasTacticalMap = tacticalCellMap(state).size > 0
      let distanceFeet = null
      if (authoritative && state.mechanics.combat.active && hasTacticalMap) {
        if (!actorAt || !targetAt) throw new RulesValidationError('Участники боя должны находиться на карте', 'MAP_POSITION_REQUIRED')
        distanceFeet = Math.max(Math.abs(actorAt.x - targetAt.x), Math.abs(actorAt.y - targetAt.y)) * 5
        if (distanceFeet < 5 || distanceFeet > profile.range_feet) throw new RulesValidationError('Цель находится вне дальности атаки', 'TARGET_OUT_OF_RANGE')
        if (profile.range_feet > 5) assertClearTrajectory(state, actorAt, targetAt)
      }
      const modifier = profile?.modifier ?? safeInteger(command.attack_modifier, 0)
      const enemyAdjacent = selectedProfile?.kind === 'ranged' && listActors(state).some((candidate) => isEnemyActor(state, actorId(candidate)) !== isEnemyActor(state, command.actor_id) && isLivingActor(candidate) && (() => { const at = actorPosition(state, actorId(candidate)); return at && actorAt && Math.max(Math.abs(at.x - actorAt.x), Math.abs(at.y - actorAt.y)) === 1 })())
      const longRange = selectedProfile && distanceFeet != null && distanceFeet > selectedProfile.normal_range_feet
      const advantage = profile ? Boolean(profile.advantage) : Boolean(command.advantage)
      const disadvantage = profile ? Boolean(profile.disadvantage || enemyAdjacent || longRange) : Boolean(command.disadvantage)
      const attack = diceService.rollD20({ modifier, purpose: 'attack', actorId: command.actor_id, advantage, disadvantage, visibility: command.visibility })
      const hit = attack.kept === 20 || (attack.kept !== 1 && attack.total >= armorClass)
      rolls.push(attack)
      const attackCommand = commandWithRules(command, RULE_IDS.armorClass, advantage || disadvantage ? RULE_IDS.advantage : null, attack.kept === 20 ? RULE_IDS.criticalHit : null)
      const configuredDamageExpression = profile?.damage_expression ?? command.damage_expression
      const damageType = profile?.damage_type ?? String(command.damage_type || 'untyped')
      events.push(eventFrom(attackCommand, 'AttackResolved', {
        ...attack,
        target_id: targetId,
        armor_class: armorClass,
        hit,
        critical: attack.kept === 20,
        range_feet: profile?.range_feet ?? null,
        distance_feet: distanceFeet,
        damage_expression: configuredDamageExpression ?? null,
        damage_type: damageType,
        item_id: selectedProfile?.item.id ?? null,
        item_name: selectedProfile?.item.name ?? null,
        trajectory: actorAt && targetAt ? lineCells(actorAt, targetAt) : [],
        long_range: Boolean(longRange),
      }, [targetId]))
      if (selectedProfile && !selectedProfile.item.equipped) events.splice(events.length - 1, 0, eventFrom(attackCommand, 'EquipmentChanged', { item_id: selectedProfile.item.id, item_name: selectedProfile.item.name, equipped: true, timing: 'before_attack', turns_spent: 0 }, [command.actor_id]))
      if (hit && (configuredDamageExpression || command.damage_amount != null)) {
        const damageExpression = configuredDamageExpression && attack.kept === 20 ? criticalDamageExpression(configuredDamageExpression) : configuredDamageExpression
        const damageRoll = damageExpression
          ? diceService.roll(damageExpression, 'damage', command.actor_id, command.visibility ?? 'public')
          : null
        if (damageRoll) { rolls.push(damageRoll); events.push(eventFrom(command, 'DieRolled', damageRoll, [])) }
        const raw = damageRoll?.total ?? Math.max(0, safeInteger(command.damage_amount, 0))
        const payload = damagePayload(state, targetId, raw, damageType)
        events.push(eventFrom(commandWithRules(attackCommand, RULE_IDS.damage, payload.immune || payload.resistant || payload.vulnerable ? RULE_IDS.resistance : null, payload.temporary_hp_absorbed ? RULE_IDS.temporaryHp : null), 'DamageApplied', payload, [targetId]))
        if (payload.hp_after === 0) events.push(eventFrom(commandWithRules(attackCommand, RULE_IDS.zeroHp), 'HitPointsReducedToZero', { condition: 'unconscious' }, [targetId]))
        if (state.mechanics.concentration[targetId] && payload.applied_amount > 0) events.push(eventFrom(commandWithRules(attackCommand, RULE_IDS.concentration), 'ConcentrationCheckRequired', { difficulty: Math.max(10, Math.floor(payload.applied_amount / 2)), damage: payload.applied_amount }, [targetId]))
      }
      break
    }
    case 'ChangeWeapon': {
      const actor = findActor(state, command.actor_id)
      const item = combatItem(actor, command.item_id)
      events.push(eventFrom(command, 'EquipmentChanged', { item_id: item.id, item_name: item.name, equipped: true, timing: 'action', turns_spent: 1 }, [command.actor_id]))
      break
    }
    case 'MakeAreaAttack': {
      const actor = findActor(state, command.actor_id)
      const item = combatItem(actor, command.item_id)
      const combat = item.combat
      const from = actorPosition(state, command.actor_id)
      const to = { x: Number(command.to.x), y: Number(command.to.y) }
      if (!from) throw new RulesValidationError('Метатель должен находиться на карте', 'MAP_POSITION_REQUIRED')
      const distanceFeet = Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) * 5
      if (distanceFeet > safeInteger(combat.normalRange, 20)) throw new RulesValidationError('Клетка находится вне дальности броска', 'TARGET_OUT_OF_RANGE')
      const trajectory = assertClearTrajectory(state, from, to)
      const radiusFeet = Math.max(5, Math.min(30, safeInteger(combat.radius, 5)))
      const affected = listActors(state).filter((candidate) => actorId(candidate) !== command.actor_id && isLivingActor(candidate) && (() => {
        const at = actorPosition(state, actorId(candidate))
        return at && Math.max(Math.abs(at.x - to.x), Math.abs(at.y - to.y)) * 5 <= radiusFeet
      })())
      events.push(eventFrom(command, 'AreaAttackResolved', { item_id: item.id, item_name: item.name, from, to, trajectory, radius_feet: radiusFeet, damage_expression: combat.damage, damage_type: combat.damageType, affected_ids: affected.map(actorId) }, affected.map(actorId)))
      const damageRoll = affected.length ? diceService.roll(combat.damage, 'area_damage', command.actor_id, command.visibility ?? 'public') : null
      if (damageRoll) { rolls.push(damageRoll); events.push(eventFrom(command, 'DieRolled', damageRoll, [])) }
      for (const target of affected) {
        const targetIdValue = actorId(target)
        const save = diceService.rollD20({ modifier: abilityModifier(target?.abilities?.[combat.saveAbility || 'dex']), purpose: `saving_throw:${combat.saveAbility || 'dex'}`, actorId: targetIdValue, visibility: command.visibility })
        rolls.push(save)
        events.push(eventFrom(command, 'DieRolled', save, [targetIdValue]))
        const saved = save.total >= safeInteger(combat.saveDc, 12)
        const raw = saved && combat.halfOnSave ? Math.floor(damageRoll.total / 2) : saved ? 0 : damageRoll.total
        events.push(eventFrom(commandWithRules(command, RULE_IDS.damage), 'DamageApplied', { ...damagePayload(state, targetIdValue, raw, String(combat.damageType || 'fire')), save_total: save.total, save_dc: safeInteger(combat.saveDc, 12), saved }, [targetIdValue]))
      }
      events.push(eventFrom(command, 'ItemConsumed', { item_id: item.id, item_name: item.name, quantity: 1 }, [command.actor_id]))
      break
    }
    case 'ApplyDamage': {
      const amount = rollAmount('damage')
      const payload = damagePayload(state, targetId, amount, String(command.damage_type || 'untyped'))
      events.push(eventFrom(commandWithRules(command, payload.immune || payload.resistant || payload.vulnerable ? RULE_IDS.resistance : null, payload.temporary_hp_absorbed ? RULE_IDS.temporaryHp : null), 'DamageApplied', payload, [targetId]))
      if (payload.hp_after === 0) {
        events.push(eventFrom({ ...command, source_rule_ids: [...new Set([...command.source_rule_ids, RULE_IDS.zeroHp])] }, 'HitPointsReducedToZero', { condition: 'unconscious' }, [targetId]))
      }
      if (state.mechanics.concentration[targetId] && amount > 0) {
        events.push(eventFrom({ ...command, source_rule_ids: [...new Set([...command.source_rule_ids, RULE_IDS.concentration])] }, 'ConcentrationCheckRequired', { difficulty: Math.max(10, Math.floor(amount / 2)), damage: amount }, [targetId]))
      }
      break
    }
    case 'ApplyHealing': {
      const actor = findActor(state, targetId)
      const amount = rollAmount('healing')
      const before = actorHp(actor)
      const after = Math.min(actorMaxHp(actor), before + amount)
      events.push(eventFrom(command, 'HealingApplied', { requested_amount: amount, applied_amount: after - before, hp_before: before, hp_after: after }, [targetId]))
      break
    }
    case 'GrantTemporaryHitPoints': {
      const amount = rollAmount('temporary_hit_points')
      const before = Math.max(0, safeInteger(state.mechanics.temporary_hp[targetId], 0))
      events.push(eventFrom(command, 'TemporaryHitPointsGranted', { offered: amount, temporary_hp_before: before, temporary_hp_after: Math.max(before, amount) }, [targetId]))
      break
    }
    case 'SpendResource': {
      const resource = String(command.resource)
      const pool = resourcePool(state, command.actor_id, resource, safeInteger(command.max, 0))
      const amount = safeInteger(command.amount, 0)
      if (pool.current < amount) throw new RulesValidationError('Недостаточно ресурса', 'INSUFFICIENT_RESOURCE')
      events.push(eventFrom(command, 'ResourceSpent', { resource, amount, before: pool.current, after: pool.current - amount, max: pool.max }, [command.actor_id]))
      break
    }
    case 'RestoreResource': {
      const resource = String(command.resource)
      const pool = resourcePool(state, command.actor_id, resource, safeInteger(command.max, 0))
      const amount = safeInteger(command.amount, 0)
      const after = Math.min(pool.max, pool.current + amount)
      events.push(eventFrom(command, 'ResourceRestored', { resource, amount: after - pool.current, before: pool.current, after, max: pool.max }, [command.actor_id]))
      break
    }
    case 'AddCondition':
      events.push(eventFrom(command, 'ConditionAdded', { condition: String(command.condition), duration: command.duration ?? null }, [targetId]))
      break
    case 'RemoveCondition':
      events.push(eventFrom(command, 'ConditionRemoved', { condition: String(command.condition) }, [targetId]))
      break
    case 'StartConcentration':
      events.push(eventFrom(command, 'ConcentrationStarted', { effect_id: String(command.effect_id || command.effectId || randomUUID()) }, [command.actor_id]))
      break
    case 'EndConcentration':
      events.push(eventFrom(command, 'ConcentrationEnded', { reason: String(command.reason || 'voluntary') }, [command.actor_id]))
      break
    case 'CastSpell': {
      const authoritative = Boolean(command.server_authoritative || context.serverAuthoritativeCombat)
      if (authoritative) {
        const actor = findActor(state, command.actor_id)
        const spell = combatSpellFor(actor, command.spell_id)
        const spellAbility = String(spell.spellcastingAbility || 'int')
        const spellModifier = abilityModifier(actor?.abilities?.[spellAbility])
        const spellAttackModifier = spellModifier + Math.max(0, safeInteger(actor?.proficiency, 0))
        const spellSaveDc = 8 + spellAttackModifier
        const effectId = `${spell.id}:${command.command_id}`
        if (spell.slotResource) {
          const pool = resourcePool(state, command.actor_id, spell.slotResource)
          events.push(eventFrom(commandWithRules(command, RULE_IDS.resource), 'ResourceSpent', {
            resource: spell.slotResource, amount: 1, before: pool.current, after: pool.current - 1, max: pool.max,
          }, [command.actor_id]))
        }
        const previous = state.mechanics.concentration[command.actor_id]
        if (spell.concentration && previous) {
          events.push(eventFrom(commandWithRules(command, RULE_IDS.concentration), 'ConcentrationEnded', { reason: 'replaced', effect_id: previous.effect_id }, [command.actor_id]))
          for (const summon of state.actors.filter((candidate) => isPartySummon(candidate) && String(candidate.sourceEffectId ?? candidate.source_effect_id ?? '') === String(previous.effect_id))) {
            events.push(eventFrom(commandWithRules(command, RULE_IDS.concentration), 'SummonedCreatureDismissed', { reason: 'concentration_replaced' }, [actorId(summon)]))
          }
        }
        events.push(eventFrom(command, 'SpellCast', {
          spell_id: spell.id,
          name: spell.name,
          kind: spell.kind,
          action_type: spell.actionType,
          level: spell.level,
          range_feet: spell.range,
          concentration: Boolean(spell.concentration),
        }, command.target_ids))
        if (spell.concentration) events.push(eventFrom(commandWithRules(command, RULE_IDS.concentration), 'ConcentrationStarted', { effect_id: effectId }, [command.actor_id]))

        if (spell.kind === 'attack') {
          const target = findActor(state, targetId)
          const armorClass = Math.max(0, safeInteger(target?.armor ?? target?.armorClass, 10))
          const attack = diceService.rollD20({ modifier: spellAttackModifier, purpose: `spell_attack:${spell.id}`, actorId: command.actor_id, visibility: command.visibility })
          const hit = attack.kept === 20 || (attack.kept !== 1 && attack.total >= armorClass)
          rolls.push(attack)
          const spellCommand = commandWithRules(command, RULE_IDS.attack, RULE_IDS.armorClass, attack.kept === 20 ? RULE_IDS.criticalHit : null)
          events.push(eventFrom(spellCommand, 'AttackResolved', {
            ...attack, target_id: targetId, armor_class: armorClass, hit, critical: attack.kept === 20,
            range_feet: spell.range, damage_expression: spell.damage, damage_type: spell.damageType,
            spell_id: spell.id, spell_name: spell.name,
          }, [targetId]))
          if (hit) {
            const expression = attack.kept === 20 ? criticalDamageExpression(spell.damage) : spell.damage
            const damageRoll = diceService.roll(expression, `spell_damage:${spell.id}`, command.actor_id, command.visibility ?? 'public')
            rolls.push(damageRoll)
            events.push(eventFrom(command, 'DieRolled', damageRoll, []))
            const payload = damagePayload(state, targetId, damageRoll.total, spell.damageType)
            events.push(eventFrom(commandWithRules(command, RULE_IDS.damage), 'DamageApplied', { ...payload, spell_id: spell.id }, [targetId]))
            if (payload.hp_after === 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HitPointsReducedToZero', { condition: 'unconscious' }, [targetId]))
          }
        } else if (spell.kind === 'save') {
          const target = findActor(state, targetId)
          const saveAbility = String(spell.saveAbility || 'dex')
          const save = diceService.rollD20({ modifier: abilityModifier(target?.abilities?.[saveAbility]), purpose: `spell_save:${spell.id}:${saveAbility}`, actorId: targetId, visibility: command.visibility })
          const saved = save.total >= spellSaveDc
          rolls.push(save)
          events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow), 'SpellSavingThrowResolved', { ...save, spell_id: spell.id, ability: saveAbility, difficulty: spellSaveDc, saved }, [targetId]))
          if (!saved) {
            const damageRoll = diceService.roll(spell.damage, `spell_damage:${spell.id}`, command.actor_id, command.visibility ?? 'public')
            rolls.push(damageRoll)
            events.push(eventFrom(command, 'DieRolled', damageRoll, []))
            const payload = damagePayload(state, targetId, damageRoll.total, spell.damageType)
            events.push(eventFrom(commandWithRules(command, RULE_IDS.damage), 'DamageApplied', { ...payload, spell_id: spell.id, save_total: save.total, save_dc: spellSaveDc, saved }, [targetId]))
            if (payload.hp_after === 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HitPointsReducedToZero', { condition: 'unconscious' }, [targetId]))
          }
        } else if (spell.kind === 'healing') {
          const target = findActor(state, targetId)
          const expression = spell.addAbilityModifier ? diceExpression(spell.healing, spellModifier, 4) : spell.healing
          const healingRoll = diceService.roll(expression, `spell_healing:${spell.id}`, command.actor_id, command.visibility ?? 'public')
          rolls.push(healingRoll)
          events.push(eventFrom(command, 'DieRolled', healingRoll, []))
          const before = actorHp(target)
          const after = Math.min(actorMaxHp(target), before + Math.max(0, healingRoll.total))
          events.push(eventFrom(commandWithRules(command, RULE_IDS.healing), 'HealingApplied', { spell_id: spell.id, requested_amount: healingRoll.total, applied_amount: after - before, hp_before: before, hp_after: after }, [targetId]))
        } else if (spell.kind === 'summon') {
          const to = { x: Number(command.to.x), y: Number(command.to.y) }
          const safeCommandId = String(command.command_id).replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 60)
          const summonId = `summon-${command.actor_id}-${safeCommandId}`.slice(0, 120)
          const definition = spell.summon
          const summon = {
            id: summonId,
            name: `${definition.name} · ${actor.character ?? actor.name ?? command.actor_id}`.slice(0, 120),
            kind: 'summon',
            faction: 'party',
            ownerId: command.actor_id,
            controllerId: command.actor_id,
            sourceSpellId: spell.id,
            sourceEffectId: effectId,
            turnRule: 'after-owner',
            hp: definition.hp,
            maxHp: definition.hp,
            armor: definition.armor,
            speed: definition.speed,
            x: to.x,
            y: to.y,
            alive: true,
            attack_profile: {
              name: definition.attackName,
              attack_modifier: spellAttackModifier,
              damage_expression: definition.damage,
              damage_type: definition.damageType,
              range_feet: definition.range,
            },
          }
          events.push(eventFrom(commandWithRules(command, RULE_IDS.initiative), 'SummonedCreatureCreated', { summon, turn_rule: 'after-owner' }, [summonId]))
        }
        break
      }
      if (command.resource && command.cost) {
        const pool = resourcePool(state, command.actor_id, String(command.resource), safeInteger(command.max, 0))
        const cost = safeInteger(command.cost, 0)
        if (pool.current < cost) throw new RulesValidationError('Недостаточно ресурса для заклинания', 'INSUFFICIENT_RESOURCE')
        events.push(eventFrom(command, 'ResourceSpent', { resource: String(command.resource), amount: cost, before: pool.current, after: pool.current - cost, max: pool.max }, [command.actor_id]))
      }
      events.push(eventFrom(command, 'SpellCast', { spell_id: command.spell_id ?? null, name: String(command.name || '') }, command.target_ids))
      if (command.concentration) events.push(eventFrom({ ...command, source_rule_ids: [...new Set([...command.source_rule_ids, RULE_IDS.concentration])] }, 'ConcentrationStarted', { effect_id: String(command.spell_id || command.name || randomUUID()) }, [command.actor_id]))
      break
    }
    case 'MoveActor': {
      const actor = findActor(state, command.actor_id)
      const authoritative = Boolean(command.server_authoritative || context.serverAuthoritativeCombat || context.isNpcScheduler || isEnemyActor(state, command.actor_id))
      const to = { x: Number(command.to.x), y: Number(command.to.y) }
      const from = actorPosition(state, command.actor_id)
      const cells = tacticalCellMap(state)
      let path = null
      let distance = 0
      let movementSpent = Math.max(0, safeInteger(state.mechanics.combat.action_economy[command.actor_id]?.movement_spent, 0))
      if (authoritative) {
        if (!from) throw new RulesValidationError('Участник должен находиться на карте', 'MAP_POSITION_REQUIRED')
        if (!cells.size) throw new RulesValidationError('Для перемещения нужна тактическая карта', 'TACTICAL_MAP_REQUIRED')
        if (!isWalkableCell(cells.get(positionKey(to))) || occupiedPositions(state, command.actor_id).has(positionKey(to))) {
          throw new RulesValidationError('Клетка назначения недоступна', 'INVALID_DESTINATION')
        }
        path = shortestTacticalPath(state, command.actor_id, to)
        if (!path?.length) throw new RulesValidationError('До клетки назначения нет свободного пути', 'PATH_BLOCKED')
        distance = path.length * 5
        const speed = Math.max(0, safeInteger(actor?.speed, 30))
        if (movementSpent + distance > speed) throw new RulesValidationError('Недостаточно скорости для этого перемещения', 'SPEED_EXCEEDED')
        movementSpent = state.mechanics.combat.active ? movementSpent + distance : distance
      } else {
        const legacyFrom = from ?? (command.from && Number.isSafeInteger(Number(command.from.x)) && Number.isSafeInteger(Number(command.from.y))
          ? { x: Number(command.from.x), y: Number(command.from.y) }
          : null)
        path = legacyFrom ? [to] : null
        distance = legacyFrom ? (Math.abs(legacyFrom.x - to.x) + Math.abs(legacyFrom.y - to.y)) * 5 : Math.max(0, Number(command.distance) || 0)
      }
      const speed = Math.max(0, safeInteger(actor?.speed, 30))
      events.push(eventFrom(command, 'ActorMoved', {
        from: from ?? command.from ?? null,
        to,
        path,
        distance,
        movement_spent: movementSpent,
        movement_remaining: Math.max(0, speed - movementSpent),
      }, [command.actor_id]))
      break
    }
    case 'CreateEncounter': {
      const encounterId = String(command.encounter.proposal_id).replace(/^encounter-proposal-/u, 'encounter-')
      const encounter = {
        ...clone(command.encounter),
        id: encounterId,
        encounter_id: encounterId,
        status: 'staged',
        location: String(state.scene?.location ?? '').slice(0, 180),
        enemy_ids: command.encounter.enemies.map((enemy) => String(enemy.id)),
      }
      events.push(eventFrom(command, 'EncounterCreated', {
        encounter,
        encounter_id: encounterId,
        proposal_id: command.encounter.proposal_id,
        request_fingerprint: command.request_fingerprint ?? null,
      }, encounter.enemy_ids))
      break
    }
    case 'StartCombat': {
      const memberIds = new Set(state.partyMemberIds?.length ? state.partyMemberIds.map(String) : state.players.map((player) => actorId(player)))
      const partyIds = state.players.filter((actor) => memberIds.has(actorId(actor)) && isLivingActor(actor)).map(actorId)
      const summons = state.actors.filter((actor) => isPartySummon(actor) && isLivingActor(actor) && memberIds.has(String(actor.ownerId ?? actor.owner_id)))
      const summonIds = summons.map(actorId)
      const encounterEnemyIds = new Set(Array.isArray(state.mechanics.encounter?.enemy_ids) ? state.mechanics.encounter.enemy_ids.map(String) : [])
      const enemyIds = state.enemies.filter((enemy) => isLivingActor(enemy) && (!encounterEnemyIds.size || encounterEnemyIds.has(actorId(enemy)))).map(actorId)
      const participantIds = uniqueStrings(enemyIds.length ? [...partyIds, ...summonIds, ...enemyIds] : [...partyIds, ...summonIds])
      if (participantIds.length < 2 || ((command.server_authoritative || context.serverAuthoritativeCombat) && !enemyIds.length)) {
        throw new RulesValidationError('Для боя нужны живые герои и противники', 'COMBAT_PARTICIPANTS_REQUIRED')
      }
      const entries = []
      for (const id of [...partyIds, ...enemyIds]) {
        const actor = findActor(state, id)
        if (!actor) throw new RulesValidationError(`Участник ${id} не найден`, 'TARGET_NOT_FOUND')
        const modifier = Number.isSafeInteger(Number(actor?.initiativeBonus))
          ? Math.max(-30, Math.min(30, Number(actor.initiativeBonus)))
          : abilityModifier(actor?.abilities?.dex)
        const roll = diceService.rollD20({ modifier, purpose: 'initiative', actorId: id, visibility: 'public' })
        rolls.push(roll)
        entries.push({ actor_id: id, total: roll.total, modifier, roll_id: roll.roll_id })
      }
      const initiative = sortedInitiative(entries)
      for (const summon of summons.sort((left, right) => actorId(left).localeCompare(actorId(right)))) {
        const ownerId = String(summon.ownerId ?? summon.owner_id)
        const ownerIndex = initiative.findIndex((entry) => String(entry.actor_id) === ownerId)
        if (ownerIndex < 0) continue
        let insertAt = ownerIndex + 1
        while (insertAt < initiative.length) {
          const queued = findActor(state, initiative[insertAt].actor_id)
          if (!isPartySummon(queued) || String(queued.ownerId ?? queued.owner_id) !== ownerId) break
          insertAt += 1
        }
        const ownerEntry = initiative[ownerIndex]
        initiative.splice(insertAt, 0, { actor_id: actorId(summon), total: ownerEntry.total, modifier: ownerEntry.modifier, shared_with: ownerId })
      }
      events.push(eventFrom(command, 'CombatStarted', { round: 1, initiative, active_index: initiative.length ? 0 : -1, party_ids: partyIds, enemy_ids: enemyIds }, participantIds))
      if (initiative.length) events.push(eventFrom(commandWithRules(command, RULE_IDS.turns), 'TurnStarted', { round: 1, active_index: 0 }, [initiative[0].actor_id]))
      break
    }
    case 'EndCombat': {
      const combat = state.mechanics.combat
      if (!combat.active) throw new RulesValidationError('Бой не начат', 'COMBAT_NOT_ACTIVE')
      events.push(eventFrom(command, 'CombatEnded', { round: combat.round, reason: String(command.reason || 'resolved').slice(0, 120) }, combat.initiative.map((entry) => entry.actor_id)))
      if (['staged', 'active'].includes(String(state.mechanics.encounter?.status ?? ''))) {
        const reason = String(command.reason || 'resolved').slice(0, 120)
        events.push(eventFrom(command, 'EncounterEnded', {
          encounter_id: state.mechanics.encounter.id ?? state.mechanics.encounter.encounter_id,
          outcome: reason,
          reason,
          enemy_ids: clone(state.mechanics.encounter.enemy_ids ?? []),
        }, state.mechanics.encounter.enemy_ids ?? []))
      }
      break
    }
    case 'EndTurn': {
      const combat = state.mechanics.combat
      if (!combat.active || !combat.initiative.length) throw new RulesValidationError('Бой не начат', 'COMBAT_NOT_ACTIVE')
      const nextIndex = (combat.active_index + 1) % combat.initiative.length
      const nextRound = nextIndex === 0 ? combat.round + 1 : combat.round
      const nextId = combat.initiative[nextIndex].actor_id
      events.push(eventFrom(command, 'TurnEnded', { round: combat.round }, [command.actor_id]))
      events.push(eventFrom(command, 'TurnStarted', { round: nextRound, active_index: nextIndex }, [nextId]))
      break
    }
    case 'BargainWithMerchant': {
      const actor = playerActor(state, command.actor_id)
      const merchant = findMerchant(state, command.merchant_id)
      const modifier = persuasionCheckModifier(actor)
      const difficulty = safeInteger(merchant.pricing?.bargain_dc, 15)
      const roll = diceService.rollCheck({
        modifier,
        difficulty,
        purpose: 'merchant_bargain',
        actorId: command.actor_id,
        visibility: 'public',
      })
      const adjustment = roll.success
        ? -Math.max(0, safeInteger(merchant.pricing?.success_discount_bps, 1_000))
        : Math.max(0, safeInteger(merchant.pricing?.failure_markup_bps, 500))
      rolls.push(roll)
      events.push(eventFrom(command, 'DieRolled', roll, []))
      events.push(eventFrom(command, 'MerchantBargainResolved', {
        merchant_id: merchant.id,
        success: roll.success,
        status: roll.success ? 'success' : 'failure',
        natural_roll: roll.kept,
        roll_total: roll.total,
        modifier,
        difficulty,
        pricing_adjustment_bps: adjustment,
        policy_id: ECONOMY_POLICY_ID,
        request_fingerprint: command.request_fingerprint ?? null,
      }, [command.actor_id]))
      break
    }
    case 'AppraiseItem': {
      const actor = playerActor(state, command.actor_id)
      const merchant = findMerchant(state, command.merchant_id)
      const item = inventoryItem(actor, command.item_id)
      const appraisal = appraisalForInventoryItem(actor, merchant, item)
      events.push(eventFrom({ ...command, visibility: 'specific_player' }, 'MerchantItemAppraised', {
        merchant_id: merchant.id,
        item_id: item.id,
        item_name: item.name,
        appraisal,
        base_unit_price_cp: appraisal.base_price_cp,
        price_provenance: appraisal.provenance,
        policy_id: appraisal.policy_id,
        request_fingerprint: command.request_fingerprint ?? null,
      }, [command.actor_id]))
      break
    }
    case 'BuyItem': {
      const actor = playerActor(state, command.actor_id)
      const merchant = findMerchant(state, command.merchant_id)
      const stock = merchantStock(merchant, command.stock_id)
      const quote = quoteMerchantBuyUnit(merchant, actor.id, stock)
      const total = checkedTransactionTotal(quote.unit_price_cp, command.quantity)
      const balanceBeforeCp = currencyToCopper(actor.currency)
      const merchantPurseBeforeCp = normalizeMerchantPurseCp(merchant.purse_cp)
      const item = inventoryItemFromStock(stock)
      item.quantity = command.quantity
      const existingIndex = inventoryStackIndex(actor.inventory, item)
      if (existingIndex >= 0) item.id = actor.inventory[existingIndex].id
      const stockAppraisal = trustedStockAppraisalFor(stock)
      const itemAppraisal = stockAppraisal ? {
        ...stockAppraisal,
        actor_id: String(actor.id),
        merchant_id: String(merchant.id),
        item_id: String(item.id),
        item_stack_key: inventoryStackKey(item),
      } : null
      const catalog = resolveCatalogPrice(stock)
      events.push(eventFrom(command, 'MerchantPurchaseCompleted', {
        merchant_id: merchant.id,
        stock_id: stock.stock_id,
        catalog_id: stock.catalog_id || null,
        item,
        ...(itemAppraisal ? { item_appraisal: itemAppraisal } : {}),
        quantity: command.quantity,
        base_unit_price_cp: quote.base_unit_price_cp,
        unit_price_cp: quote.unit_price_cp,
        total_price_cp: total,
        price_multiplier_bps: quote.multiplier_bps,
        price_provenance: catalog?.provenance ?? 'custom',
        price_source_version: catalog?.source_version ?? null,
        currency_before: normalizeCurrency(actor.currency),
        currency_after: copperToCurrency(balanceBeforeCp - total),
        balance_before_cp: balanceBeforeCp,
        balance_after_cp: balanceBeforeCp - total,
        merchant_purse_before_cp: merchantPurseBeforeCp,
        merchant_purse_after_cp: merchantPurseBeforeCp + total,
        policy_id: ECONOMY_POLICY_ID,
        request_fingerprint: command.request_fingerprint ?? null,
      }, [command.actor_id]))
      break
    }
    case 'SellItem': {
      const actor = playerActor(state, command.actor_id)
      const merchant = findMerchant(state, command.merchant_id)
      const item = inventoryItem(actor, command.item_id)
      const appraisal = trustedItemAppraisalFor(state, actor.id, item)
      const quote = quoteMerchantSellUnit(merchant, actor.id, item, appraisal)
      const total = checkedTransactionTotal(quote.unit_price_cp, command.quantity)
      const balanceBeforeCp = currencyToCopper(actor.currency)
      const merchantPurseBeforeCp = normalizeMerchantPurseCp(merchant.purse_cp)
      const catalog = resolveCatalogPrice(item)
      const itemStackKey = inventoryStackKey(item)
      const matchingStock = merchant.stock.find((stock) => inventoryStackKey(stock) === itemStackKey)
      const resaleStockId = matchingStock?.stock_id
        ?? `resale:${randomUUID()}`
      const resaleItem = inventoryItemFromStock({ ...item, item_id: item.id })
      resaleItem.quantity = command.quantity
      events.push(eventFrom(command, 'MerchantSaleCompleted', {
        merchant_id: merchant.id,
        stock_id: resaleStockId,
        catalog_id: item.catalog_id ?? null,
        item: resaleItem,
        ...(appraisal ? { appraisal } : {}),
        quantity: command.quantity,
        base_unit_price_cp: quote.base_unit_price_cp,
        unit_price_cp: quote.unit_price_cp,
        total_price_cp: total,
        price_multiplier_bps: quote.multiplier_bps,
        price_provenance: catalog?.provenance ?? appraisal?.provenance ?? 'custom',
        price_source_version: catalog?.source_version ?? null,
        currency_before: normalizeCurrency(actor.currency),
        currency_after: copperToCurrency(balanceBeforeCp + total),
        balance_before_cp: balanceBeforeCp,
        balance_after_cp: balanceBeforeCp + total,
        merchant_purse_before_cp: merchantPurseBeforeCp,
        merchant_purse_after_cp: merchantPurseBeforeCp - total,
        policy_id: ECONOMY_POLICY_ID,
        request_fingerprint: command.request_fingerprint ?? null,
      }, [command.actor_id]))
      break
    }
    case 'CreateMerchant':
      events.push(eventFrom(command, 'MerchantCreated', {
        merchant_id: command.merchant.id,
        merchant: command.merchant,
        policy_id: ECONOMY_POLICY_ID,
        request_fingerprint: command.request_fingerprint,
      }, []))
      break
    case 'ConfigureMerchant':
      events.push(eventFrom(command, 'MerchantConfigured', {
        merchant_id: command.merchant_id,
        configuration: command.configuration,
        changed_fields: Object.keys(command.configuration),
        reset_bargains: command.reset_bargains === true,
        policy_id: ECONOMY_POLICY_ID,
        request_fingerprint: command.request_fingerprint,
      }, []))
      break
    case 'RestockMerchant':
      events.push(eventFrom(command, 'MerchantRestocked', {
        merchant_id: command.merchant_id,
        entries: command.items,
        total_quantity_added: command.items.reduce((total, entry) => total + entry.quantity_added, 0),
        policy_id: ECONOMY_POLICY_ID,
        request_fingerprint: command.request_fingerprint,
      }, []))
      break
    case 'MoveMerchant': {
      const merchant = findMerchant(state, command.merchant_id)
      events.push(eventFrom(command, 'MerchantMoved', {
        merchant_id: command.merchant_id,
        location_before: merchant.location,
        location_after: command.location,
        policy_id: ECONOMY_POLICY_ID,
        request_fingerprint: command.request_fingerprint,
      }, []))
      break
    }
    case 'SetMerchantAvailability': {
      const merchant = findMerchant(state, command.merchant_id)
      events.push(eventFrom(command, 'MerchantAvailabilityChanged', {
        merchant_id: command.merchant_id,
        available_before: merchant.available !== false,
        available_after: command.available,
        policy_id: ECONOMY_POLICY_ID,
        request_fingerprint: command.request_fingerprint,
      }, []))
      break
    }
    case 'AdvanceScene': {
      const transition = createSceneTransition(command.scene_args, state)
      const metadata = canonicalSceneMetadata(command.scene_args, transition)
      const canonicalTransition = { ...transition, scene: { ...transition.scene, ...metadata } }
      const partyPositions = sceneAdvancePartyPositions(state, canonicalTransition)
      events.push(eventFrom(command, 'SceneAdvanced', {
        ...canonicalTransition,
        ...metadata,
        location_before: String(state.scene?.location ?? ''),
        location_after: String(canonicalTransition.scene?.location ?? ''),
        party_positions: partyPositions,
        scene_commerce: command.scene_commerce,
        party_decision: command.party_decision,
        request_fingerprint: command.request_fingerprint,
      }, partyPositions.map((position) => position.actor_id)))
      break
    }
    case 'AdvanceTime':
      events.push(eventFrom(command, 'TimeAdvanced', { amount: Math.max(0, Number(command.amount) || 0), unit: String(command.unit || 'minute') }, []))
      break
    case 'StartRest':
      events.push(eventFrom(command, 'RestStarted', { kind: command.kind === 'long' ? 'long' : 'short' }, [command.actor_id]))
      break
    case 'CompleteRest':
      events.push(eventFrom(command, 'RestCompleted', { kind: command.kind === 'long' ? 'long' : 'short' }, [command.actor_id]))
      break
    case 'RevealArea': {
      const cells = Array.isArray(command.cells) ? command.cells.slice(0, 100).map((cell) => ({ x: safeInteger(cell.x), y: safeInteger(cell.y) })) : []
      events.push(eventFrom(command, 'AreaRevealed', { cells }, []))
      break
    }
    case 'UpdateObjective':
      events.push(eventFrom(command, 'ObjectiveUpdated', { objective: String(command.objective || '').slice(0, 120) }, []))
      break
    case 'SpawnEntity':
      events.push(eventFrom(command, 'EntitySpawned', { entity: clone(command.entity ?? {}) }, []))
      break
    case 'GrantItem': {
      const item = clone(command.item ?? {})
      if (!item.id) item.id = randomUUID()
      events.push(eventFrom(command, 'ItemGranted', { item }, [command.actor_id]))
      break
    }
    case 'RecordRuling':
      events.push(eventFrom(command, 'RulingRecorded', { ruling: clone(command.ruling ?? {}) }, []))
      break
    default:
      throw new RulesValidationError('Команда пока не реализована', 'COMMAND_NOT_IMPLEMENTED')
  }

  return { command, events, rolls }
}

function replaceActor(state, id, updater) {
  if (Array.isArray(state.players)) state.players = state.players.map((actor) => actorId(actor) === id ? updater(actor) : actor)
  if (Array.isArray(state.actors)) state.actors = state.actors.map((actor) => actorId(actor) === id ? updater(actor) : actor)
  if (Array.isArray(state.enemies)) state.enemies = state.enemies.map((actor) => actorId(actor) === id ? updater(actor) : actor)
}

function removeSummonedActor(state, id) {
  const expected = String(id ?? '')
  const initiative = state.mechanics?.combat?.initiative ?? []
  const removedIndex = initiative.findIndex((entry) => String(entry.actor_id) === expected)
  if (removedIndex >= 0) {
    initiative.splice(removedIndex, 1)
    if (removedIndex < state.mechanics.combat.active_index) state.mechanics.combat.active_index -= 1
    if (state.mechanics.combat.active_index >= initiative.length) state.mechanics.combat.active_index = initiative.length ? initiative.length - 1 : -1
  }
  state.actors = (state.actors ?? []).filter((actor) => actorId(actor) !== expected)
  delete state.mechanics.positions[expected]
  delete state.mechanics.combat.action_economy[expected]
}

function combatActorKind(state, id) {
  const actor = findActor(state, id)
  return isEnemyActor(state, id) ? 'enemy' : isPartySummon(actor) ? 'summon' : 'player'
}

function replaceMerchant(state, id, updater) {
  if (Array.isArray(state.merchants)) state.merchants = state.merchants.map((merchant) => String(merchant.id) === String(id) ? updater(merchant) : merchant)
}

function addInventoryItem(inventory, incoming) {
  const current = Array.isArray(inventory) ? inventory : []
  const index = inventoryStackIndex(current, incoming)
  if (index < 0) return [...current, clone(incoming)]
  return current.map((item, itemIndex) => itemIndex === index
    ? { ...item, quantity: Math.min(MAX_STOCK_QUANTITY, safeInteger(item.quantity, 1) + safeInteger(incoming.quantity, 1)) }
    : item)
}

function eventJournalId(state, event) {
  return String(event.event_id ?? `${event.command_id ?? 'command'}:${event.event_type}:${state.state_version + 1}`)
}

function appendBattleLog(state, event, entry) {
  const id = eventJournalId(state, event)
  if (state.battleLog.some((item) => String(item.id) === id)) return
  state.battleLog = [...state.battleLog, { id, ...entry }].slice(-50)
}

function appendMapFeedback(state, event, entry) {
  const id = eventJournalId(state, event)
  if (state.mapFeedback.some((item) => String(item.id) === id)) return
  state.mapFeedback = [...state.mapFeedback, { id, ...entry }].slice(-6)
}

function appendEconomyLog(state, event, entry) {
  const id = eventJournalId(state, event)
  if (state.economyLog.some((item) => String(item.id) === id)) return
  state.economyLog = [...state.economyLog, { id, ...entry }].slice(-50)
}

function setItemAppraisal(state, actorIdValue, itemIdValue, appraisal) {
  const ownerId = String(actorIdValue ?? '')
  const itemId = String(itemIdValue ?? '')
  if (!ownerId || !itemId || !appraisal || typeof appraisal !== 'object' || Array.isArray(appraisal)) return
  state.mechanics.item_appraisals = {
    ...(state.mechanics.item_appraisals ?? {}),
    [ownerId]: {
      ...(state.mechanics.item_appraisals?.[ownerId] ?? {}),
      [itemId]: clone(appraisal),
    },
  }
}

function removeItemAppraisal(state, actorIdValue, itemIdValue) {
  const ownerId = String(actorIdValue ?? '')
  const itemId = String(itemIdValue ?? '')
  const current = state.mechanics.item_appraisals?.[ownerId]
  if (!current || typeof current !== 'object') return
  const next = { ...current }
  delete next[itemId]
  state.mechanics.item_appraisals = { ...(state.mechanics.item_appraisals ?? {}), [ownerId]: next }
}

function synchronizeTacticalTurn(state) {
  const combat = state.mechanics.combat
  if (!combat.active || !combat.initiative.length || combat.active_index < 0) return
  const activeId = String(combat.initiative[combat.active_index]?.actor_id ?? '')
  if (!activeId) return
  const economy = combat.action_economy[activeId] ?? actionEconomy()
  state.activePlayerId = activeId
  state.tacticalTurn = {
    sceneTurn: safeInteger(state.scene?.turn, combat.round),
    actorId: activeId,
    movementSpent: Math.max(0, safeInteger(economy.movement_spent, 0)),
    actionUsed: economy.action === false,
    round: combat.round,
    activeIndex: combat.active_index,
  }
}

export function applyGameEvent(rawState, event) {
  if (['LegacyStateImported', 'LegacyStateSynchronized'].includes(event?.event_type) && event.payload?.state && typeof event.payload.state === 'object') {
    const imported = normalizeCampaignState(event.payload.state)
    imported.state_version = Number.isSafeInteger(event.state_version_after) ? event.state_version_after : 1
    return imported
  }
  const state = normalizeCampaignState(rawState)
  const targets = uniqueStrings(event.target_ids)
  const target = targets[0] ?? event.actor_id
  const payload = event.payload ?? {}
  switch (event.event_type) {
    case 'SceneAdvanced': {
      state.scene = clone(plainObject(payload.scene) ? payload.scene : {})
      state.adventure = {
        ...privateAdventureBuckets(state.adventure),
        ...publicAdventureMemory(plainObject(payload.adventure) ? payload.adventure : state.adventure),
      }
      const partyIds = new Set(state.partyMemberIds ?? [])
      const walkable = new Set((Array.isArray(state.scene.cells) ? state.scene.cells : [])
        .filter((cell) => ['floor', 'door'].includes(String(cell?.type || 'floor').toLowerCase()))
        .map((cell) => `${Number(cell.x)},${Number(cell.y)}`))
      const usedActors = new Set()
      const usedCells = new Set()
      const positions = new Map()
      for (const entry of Array.isArray(payload.party_positions) ? payload.party_positions : []) {
        const id = String(entry?.actor_id ?? '')
        const x = Number(entry?.x)
        const y = Number(entry?.y)
        const key = `${x},${y}`
        if (!partyIds.has(id) || usedActors.has(id) || usedCells.has(key)
          || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || !walkable.has(key)) continue
        usedActors.add(id)
        usedCells.add(key)
        positions.set(id, { x, y })
      }
      state.scene.cells = (Array.isArray(state.scene.cells) ? state.scene.cells : []).map((cell) => (
        usedCells.has(`${Number(cell.x)},${Number(cell.y)}`) ? { ...cell, revealed: true } : cell
      ))
      state.players = state.players.map((player) => {
        const withoutOldPosition = { ...player }
        delete withoutOldPosition.x
        delete withoutOldPosition.y
        const position = positions.get(actorId(player))
        return position ? { ...withoutOldPosition, ...position } : withoutOldPosition
      })
      state.mechanics.positions = Object.fromEntries(positions)
      state.mechanics.combat = clone(defaultMechanics().combat)
      state.mechanics.encounter = null
      state.enemies = []
      state.actors = (state.actors ?? []).filter((actor) => !isPartySummon(actor))
      state.entities = []
      state.mapFeedback = []
      delete state.tacticalTurn
      if (state.agentInteraction?.status === 'resolved') state.agentInteraction = null
      state.suggestions = Array.isArray(payload.suggestions) ? payload.suggestions.map(String).slice(0, 3) : []
      if (!partyIds.has(String(state.activePlayerId ?? ''))) state.activePlayerId = state.partyMemberIds[0] ?? ''
      break
    }
    case 'DamageApplied':
      replaceActor(state, target, (actor) => {
        const hp = Math.max(0, safeInteger(payload.hp_after, actorHp(actor)))
        return { ...actor, hp, ...(isEnemyActor(state, target) ? { alive: hp > 0 } : {}) }
      })
      state.mechanics.temporary_hp[target] = Math.max(0, safeInteger(payload.temporary_hp_after, 0))
      for (let index = state.battleLog.length - 1; index >= 0; index -= 1) {
        const item = state.battleLog[index]
        if (item.type === 'attack' && item.targetId === target && item.actorId === event.actor_id && item.damage == null) {
          state.battleLog[index] = { ...item, damage: safeInteger(payload.applied_amount, 0), hpBefore: safeInteger(payload.hp_before, 0), hpAfter: safeInteger(payload.hp_after, 0) }
          break
        }
      }
      {
        const position = actorPosition(state, target)
        if (position) appendMapFeedback(state, event, { ...position, text: `−${safeInteger(payload.applied_amount, 0)}`, kind: payload.hp_after === 0 ? 'defeat' : 'damage' })
      }
      break
    case 'HealingApplied':
      replaceActor(state, target, (actor) => {
        const hp = Math.min(actorMaxHp(actor), Math.max(0, safeInteger(payload.hp_after, actorHp(actor))))
        return { ...actor, hp, ...(isEnemyActor(state, target) ? { alive: hp > 0 } : {}) }
      })
      break
    case 'TemporaryHitPointsGranted':
      state.mechanics.temporary_hp[target] = Math.max(0, safeInteger(payload.temporary_hp_after, 0))
      break
    case 'HitPointsReducedToZero': {
      const current = state.mechanics.conditions[target] ?? []
      if (!current.some((condition) => condition.id === 'unconscious')) current.push({ id: 'unconscious', source_rule_ids: event.source_rule_ids ?? [] })
      state.mechanics.conditions[target] = current
      if (isEnemyActor(state, target) && Array.isArray(state.scene?.cells)) {
        const position = actorPosition(state, target)
        if (position) state.scene.cells = state.scene.cells.map((cell) => cell.x === position.x && cell.y === position.y && cell.feature === 'enemy' ? { ...cell, feature: undefined } : cell)
      }
      const endedEffect = state.mechanics.concentration[target]?.effect_id
      if (endedEffect) {
        delete state.mechanics.concentration[target]
        for (const summon of [...(state.actors ?? [])]) {
          if (isPartySummon(summon) && String(summon.sourceEffectId ?? summon.source_effect_id ?? '') === String(endedEffect)) removeSummonedActor(state, actorId(summon))
        }
      }
      if (isPartySummon(findActor(state, target))) removeSummonedActor(state, target)
      break
    }
    case 'ResourceSpent':
    case 'ResourceRestored': {
      const id = target
      state.mechanics.resources[id] ??= {}
      state.mechanics.resources[id][payload.resource] = { current: safeInteger(payload.after, 0), max: Math.max(0, safeInteger(payload.max, 0)) }
      break
    }
    case 'ConditionAdded': {
      const current = state.mechanics.conditions[target] ?? []
      const condition = String(payload.condition)
      if (!current.some((item) => item.id === condition)) current.push({ id: condition, duration: payload.duration ?? null, source_rule_ids: event.source_rule_ids ?? [] })
      state.mechanics.conditions[target] = current
      break
    }
    case 'ConditionRemoved':
      state.mechanics.conditions[target] = (state.mechanics.conditions[target] ?? []).filter((condition) => condition.id !== String(payload.condition))
      break
    case 'ConcentrationStarted':
      state.mechanics.concentration[target] = { effect_id: payload.effect_id, source_rule_ids: event.source_rule_ids ?? [] }
      break
    case 'ConcentrationEnded': {
      const effectId = payload.effect_id ?? state.mechanics.concentration[target]?.effect_id
      delete state.mechanics.concentration[target]
      for (const summon of [...(state.actors ?? [])]) {
        if (isPartySummon(summon) && String(summon.sourceEffectId ?? summon.source_effect_id ?? '') === String(effectId ?? '')) removeSummonedActor(state, actorId(summon))
      }
      break
    }
    case 'AttackResolved': {
      if (state.mechanics.combat.active && event.actor_id) {
        state.mechanics.combat.action_economy[event.actor_id] = { ...(state.mechanics.combat.action_economy[event.actor_id] ?? actionEconomy()), action: false }
      }
      appendBattleLog(state, event, {
        sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round),
        round: state.mechanics.combat.round,
        type: 'attack',
        actorId: event.actor_id,
        actorKind: combatActorKind(state, event.actor_id),
        targetId: target,
        roll: {
          die: safeInteger(payload.kept, 0), modifier: safeInteger(payload.modifier, 0), total: safeInteger(payload.total, 0),
          difficulty: safeInteger(payload.armor_class, 10), hit: Boolean(payload.hit),
        },
        damage: payload.hit ? null : 0,
        itemId: payload.item_id ?? undefined,
        itemName: payload.item_name ?? undefined,
      })
      if (!payload.hit) {
        const position = actorPosition(state, target)
        if (position) appendMapFeedback(state, event, { ...position, text: 'Промах', kind: 'miss' })
      }
      break
    }
    case 'AreaAttackResolved': {
      if (state.mechanics.combat.active && event.actor_id) state.mechanics.combat.action_economy[event.actor_id] = { ...(state.mechanics.combat.action_economy[event.actor_id] ?? actionEconomy()), action: false }
      appendBattleLog(state, event, { sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round), round: state.mechanics.combat.round, type: 'area-attack', actorId: event.actor_id, actorKind: 'player', itemId: payload.item_id, itemName: payload.item_name, area: { ...payload.to, radiusFeet: safeInteger(payload.radius_feet, 5) } })
      break
    }
    case 'EquipmentChanged': {
      replaceActor(state, target, (actor) => ({ ...actor, inventory: (actor.inventory ?? []).map((item) => item.type === 'weapon' ? { ...item, equipped: String(item.id) === String(payload.item_id) } : item) }))
      if (payload.timing === 'action' && state.mechanics.combat.active && event.actor_id) state.mechanics.combat.action_economy[event.actor_id] = { ...(state.mechanics.combat.action_economy[event.actor_id] ?? actionEconomy()), action: false }
      appendBattleLog(state, event, { sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round), round: state.mechanics.combat.round, type: 'equipment', actorId: event.actor_id, actorKind: 'player', itemId: payload.item_id, itemName: payload.item_name })
      break
    }
    case 'ItemConsumed':
      replaceActor(state, target, (actor) => ({ ...actor, inventory: (actor.inventory ?? []).map((item) => String(item.id) === String(payload.item_id) ? { ...item, quantity: Math.max(0, safeInteger(item.quantity, 1) - safeInteger(payload.quantity, 1)) } : item).filter((item) => item.quantity > 0) }))
      break
    case 'MerchantCreated': {
      const merchant = lifecycleMerchantFromCanonical(payload.merchant)
      const existingIndex = state.merchants.findIndex((candidate) => String(candidate.id) === merchant.id)
      state.merchants = existingIndex < 0
        ? [...state.merchants, merchant]
        : state.merchants.map((candidate, index) => index === existingIndex ? merchant : candidate)
      if (!state.enabled_house_rules.includes(ECONOMY_POLICY_ID)) state.enabled_house_rules.push(ECONOMY_POLICY_ID)
      appendEconomyLog(state, event, {
        type: 'merchant-created', merchantId: merchant.id, location: merchant.location,
        stockPositions: merchant.stock.length, policyId: payload.policy_id ?? ECONOMY_POLICY_ID,
        requestFingerprint: payload.request_fingerprint ?? null,
      })
      break
    }
    case 'MerchantConfigured':
      replaceMerchant(state, payload.merchant_id, (merchant) => {
        const configuration = lifecycleConfigurationFromCanonical(payload.configuration, merchant)
        return {
          ...merchant,
          ...configuration,
          ...(configuration.pricing ? { pricing: lifecyclePricingFromCanonical(configuration.pricing, merchant.pricing) } : {}),
          ...(payload.reset_bargains === true ? { bargains: {} } : {}),
        }
      })
      appendEconomyLog(state, event, {
        type: 'merchant-configured', merchantId: payload.merchant_id,
        changedFields: uniqueStrings(payload.changed_fields), resetBargains: payload.reset_bargains === true,
        policyId: payload.policy_id ?? ECONOMY_POLICY_ID, requestFingerprint: payload.request_fingerprint ?? null,
      })
      break
    case 'MerchantRestocked':
      replaceMerchant(state, payload.merchant_id, (merchant) => {
        let stock = [...merchant.stock]
        for (const [index, entry] of (Array.isArray(payload.entries) ? payload.entries : []).entries()) {
          const normalized = lifecycleStockFromCanonical({ ...entry?.stock, quantity: entry?.quantity_after }, merchant.id, index)
          const existingIndex = stock.findIndex((candidate) => String(candidate.stock_id) === normalized.stock_id)
          stock = existingIndex < 0
            ? [...stock, normalized]
            : stock.map((candidate, stockIndex) => stockIndex === existingIndex ? normalized : candidate)
        }
        return { ...merchant, stock: stock.slice(0, 500) }
      })
      appendEconomyLog(state, event, {
        type: 'merchant-restocked', merchantId: payload.merchant_id,
        stockIds: (Array.isArray(payload.entries) ? payload.entries : []).map((entry) => String(entry?.stock_id ?? '')).filter(Boolean),
        totalQuantityAdded: Math.max(0, safeInteger(payload.total_quantity_added, 0)),
        policyId: payload.policy_id ?? ECONOMY_POLICY_ID, requestFingerprint: payload.request_fingerprint ?? null,
      })
      break
    case 'MerchantMoved':
      replaceMerchant(state, payload.merchant_id, (merchant) => ({
        ...merchant,
        location: lifecycleText(payload.location_after, 180, { required: true, code: 'INVALID_MERCHANT_LOCATION', label: 'Локация торговца' }),
      }))
      appendEconomyLog(state, event, {
        type: 'merchant-moved', merchantId: payload.merchant_id,
        locationBefore: payload.location_before ?? '', locationAfter: payload.location_after ?? '',
        policyId: payload.policy_id ?? ECONOMY_POLICY_ID, requestFingerprint: payload.request_fingerprint ?? null,
      })
      break
    case 'MerchantAvailabilityChanged':
      replaceMerchant(state, payload.merchant_id, (merchant) => ({ ...merchant, available: payload.available_after === true }))
      appendEconomyLog(state, event, {
        type: 'merchant-availability', merchantId: payload.merchant_id,
        availableBefore: payload.available_before === true, availableAfter: payload.available_after === true,
        policyId: payload.policy_id ?? ECONOMY_POLICY_ID, requestFingerprint: payload.request_fingerprint ?? null,
      })
      break
    case 'MerchantItemAppraised':
      setItemAppraisal(state, target, payload.item_id, payload.appraisal)
      appendEconomyLog(state, event, {
        type: 'appraisal', actorId: target, merchantId: payload.merchant_id,
        itemId: payload.item_id, itemName: payload.item_name,
        baseUnitPriceCp: safeInteger(payload.base_unit_price_cp, 0),
        priceProvenance: payload.price_provenance ?? 'server_appraisal_policy',
        policyId: payload.policy_id ?? CATEGORY_APPRAISAL_POLICY_ID,
        requestFingerprint: payload.request_fingerprint ?? null,
      })
      break
    case 'MerchantBargainResolved':
      replaceMerchant(state, payload.merchant_id, (merchant) => ({
        ...merchant,
        bargains: {
          ...(merchant.bargains ?? {}),
          [String(target)]: {
            attempted: true,
            success: payload.success === true,
            status: payload.success === true ? 'success' : 'failure',
            natural_roll: safeInteger(payload.natural_roll, 1),
            roll_total: safeInteger(payload.roll_total, 0),
            modifier: safeInteger(payload.modifier, 0),
            difficulty: safeInteger(payload.difficulty, 15),
            pricing_adjustment_bps: Math.max(-5_000, Math.min(5_000, safeInteger(payload.pricing_adjustment_bps, 0))),
            resolved_at: event.occurred_at ?? event.created_at ?? null,
          },
        },
      }))
      appendEconomyLog(state, event, {
        type: 'bargain', actorId: target, merchantId: payload.merchant_id,
        success: payload.success === true, rollTotal: safeInteger(payload.roll_total, 0), difficulty: safeInteger(payload.difficulty, 15),
        pricingAdjustmentBps: safeInteger(payload.pricing_adjustment_bps, 0), policyId: payload.policy_id ?? ECONOMY_POLICY_ID,
      })
      break
    case 'MerchantPurchaseCompleted':
      replaceActor(state, target, (actor) => ({
        ...actor,
        currency: normalizeCurrency(payload.currency_after),
        inventory: addInventoryItem(actor.inventory, payload.item),
      }))
      replaceMerchant(state, payload.merchant_id, (merchant) => ({
        ...merchant,
        purse_cp: Object.hasOwn(payload, 'merchant_purse_after_cp')
          ? normalizeMerchantPurseCp(payload.merchant_purse_after_cp)
          : normalizeMerchantPurseCp(merchant.purse_cp),
        stock: merchant.stock.map((stock) => String(stock.stock_id) === String(payload.stock_id)
          ? { ...stock, quantity: Math.max(0, safeInteger(stock.quantity, 0) - safeInteger(payload.quantity, 0)) }
          : stock),
      }))
      if (payload.item_appraisal) setItemAppraisal(state, target, payload.item?.id, payload.item_appraisal)
      appendEconomyLog(state, event, {
        type: 'purchase', actorId: target, merchantId: payload.merchant_id, stockId: payload.stock_id,
        catalogId: payload.catalog_id ?? null, itemId: payload.item?.id ?? null, itemName: payload.item?.name ?? null,
        quantity: safeInteger(payload.quantity, 0), unitPriceCp: safeInteger(payload.unit_price_cp, 0), totalPriceCp: safeInteger(payload.total_price_cp, 0),
        merchantPurseBeforeCp: safeInteger(payload.merchant_purse_before_cp, 0), merchantPurseAfterCp: safeInteger(payload.merchant_purse_after_cp, 0),
        priceProvenance: payload.price_provenance ?? 'custom', policyId: payload.policy_id ?? ECONOMY_POLICY_ID,
      })
      break
    case 'MerchantSaleCompleted':
      replaceActor(state, target, (actor) => ({
        ...actor,
        currency: normalizeCurrency(payload.currency_after),
        inventory: (actor.inventory ?? []).map((item) => String(item.id) === String(payload.item?.id)
          ? { ...item, quantity: Math.max(0, safeInteger(item.quantity, 1) - safeInteger(payload.quantity, 0)) }
          : item).filter((item) => safeInteger(item.quantity, 1) > 0),
      }))
      if (!inventoryItem(playerActor(state, target), payload.item?.id)) removeItemAppraisal(state, target, payload.item?.id)
      replaceMerchant(state, payload.merchant_id, (merchant) => {
        const purseCp = Object.hasOwn(payload, 'merchant_purse_after_cp')
          ? normalizeMerchantPurseCp(payload.merchant_purse_after_cp)
          : normalizeMerchantPurseCp(merchant.purse_cp)
        const existing = merchant.stock.find((stock) => String(stock.stock_id) === String(payload.stock_id))
        if (existing) return {
          ...merchant,
          purse_cp: purseCp,
          stock: merchant.stock.map((stock) => String(stock.stock_id) === String(payload.stock_id)
            ? { ...stock, quantity: Math.min(MAX_STOCK_QUANTITY, safeInteger(stock.quantity, 0) + safeInteger(payload.quantity, 0)) }
            : stock),
        }
        const item = clone(payload.item ?? {})
        delete item.id
        return {
          ...merchant,
          purse_cp: purseCp,
          stock: [...merchant.stock, {
            ...item,
            stock_id: String(payload.stock_id),
            item_id: String(payload.item?.id ?? ''),
            catalog_id: String(payload.catalog_id ?? item.catalog_id ?? ''),
            quantity: safeInteger(payload.quantity, 0),
            base_price_cp: safeInteger(payload.base_unit_price_cp, 0),
            ...(payload.appraisal ? { appraisal: clone(payload.appraisal) } : {}),
            equipped: false,
          }],
        }
      })
      appendEconomyLog(state, event, {
        type: 'sale', actorId: target, merchantId: payload.merchant_id, stockId: payload.stock_id,
        catalogId: payload.catalog_id ?? null, itemId: payload.item?.id ?? null, itemName: payload.item?.name ?? null,
        quantity: safeInteger(payload.quantity, 0), unitPriceCp: safeInteger(payload.unit_price_cp, 0), totalPriceCp: safeInteger(payload.total_price_cp, 0),
        merchantPurseBeforeCp: safeInteger(payload.merchant_purse_before_cp, 0), merchantPurseAfterCp: safeInteger(payload.merchant_purse_after_cp, 0),
        priceProvenance: payload.price_provenance ?? 'custom', policyId: payload.policy_id ?? ECONOMY_POLICY_ID,
      })
      break
    case 'SpellCast':
      if (state.mechanics.combat.active && event.actor_id) {
        const economy = state.mechanics.combat.action_economy[event.actor_id] ?? actionEconomy()
        const resource = payload.action_type === 'bonus_action' ? 'bonus_action' : payload.action_type === 'reaction' ? 'reaction' : 'action'
        state.mechanics.combat.action_economy[event.actor_id] = { ...economy, [resource]: false }
      }
      appendBattleLog(state, event, { sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round), round: state.mechanics.combat.round, type: 'spell', actorId: event.actor_id, actorKind: combatActorKind(state, event.actor_id), targetId: target, spellId: payload.spell_id, spellName: payload.name })
      break
    case 'SummonedCreatureCreated': {
      const summon = clone(payload.summon ?? {})
      if (!actorId(summon) || findActor(state, actorId(summon))) break
      state.actors = [...(state.actors ?? []), summon]
      state.mechanics.positions[actorId(summon)] = { x: safeInteger(summon.x, 0), y: safeInteger(summon.y, 0) }
      if (state.mechanics.combat.active) {
        const initiative = state.mechanics.combat.initiative
        const ownerId = String(summon.ownerId ?? summon.owner_id ?? event.actor_id)
        const ownerIndex = initiative.findIndex((entry) => String(entry.actor_id) === ownerId)
        let insertAt = ownerIndex < 0 ? initiative.length : ownerIndex + 1
        while (insertAt < initiative.length) {
          const queued = findActor(state, initiative[insertAt].actor_id)
          if (!isPartySummon(queued) || String(queued.ownerId ?? queued.owner_id) !== ownerId) break
          insertAt += 1
        }
        const ownerEntry = initiative[ownerIndex]
        initiative.splice(insertAt, 0, { actor_id: actorId(summon), total: ownerEntry?.total, modifier: ownerEntry?.modifier, shared_with: ownerId })
        state.mechanics.combat.action_economy[actorId(summon)] = actionEconomy()
      }
      appendBattleLog(state, event, { sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round), round: state.mechanics.combat.round, type: 'summon', actorId: event.actor_id, actorKind: combatActorKind(state, event.actor_id), targetId: actorId(summon), spellId: summon.sourceSpellId, spellName: summon.name })
      break
    }
    case 'SummonedCreatureDismissed':
      removeSummonedActor(state, target)
      appendBattleLog(state, event, { sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round), round: state.mechanics.combat.round, type: 'summon-end', actorId: event.actor_id, actorKind: combatActorKind(state, event.actor_id), targetId: target, reason: payload.reason })
      break
    case 'EncounterCreated': {
      const encounter = payload.encounter && typeof payload.encounter === 'object' ? clone(payload.encounter) : {}
      const oldEnemyIds = new Set(state.enemies.map(actorId))
      state.mechanics.positions = Object.fromEntries(Object.entries(state.mechanics.positions ?? {}).filter(([id]) => !oldEnemyIds.has(String(id))))
      state.enemies = (Array.isArray(encounter.enemies) ? encounter.enemies : []).map((enemy) => ({ ...clone(enemy), alive: true }))
      for (const enemy of state.enemies) {
        state.mechanics.positions[actorId(enemy)] = { x: safeInteger(enemy.x, 0), y: safeInteger(enemy.y, 0) }
      }
      state.mechanics.encounter = {
        ...encounter,
        id: String(encounter.id ?? encounter.encounter_id ?? payload.encounter_id ?? ''),
        encounter_id: String(encounter.encounter_id ?? encounter.id ?? payload.encounter_id ?? ''),
        status: 'staged',
        enemy_ids: state.enemies.map(actorId),
      }
      appendBattleLog(state, event, {
        type: 'encounter-created', encounterId: state.mechanics.encounter.id,
        participantIds: state.enemies.map(actorId), difficulty: encounter.difficulty, theme: encounter.theme,
      })
      break
    }
    case 'CombatStarted': {
      state.mechanics.combat = {
        active: true,
        round: safeInteger(payload.round, 1),
        initiative: clone(payload.initiative ?? []),
        active_index: safeInteger(payload.active_index, -1),
        action_economy: Object.fromEntries((payload.initiative ?? []).map((entry) => [entry.actor_id, actionEconomy()])),
      }
      if (state.mechanics.encounter && state.mechanics.encounter.status === 'staged') {
        state.mechanics.encounter = { ...state.mechanics.encounter, status: 'active', started_at: event.occurred_at ?? event.created_at ?? null }
      }
      appendBattleLog(state, event, { type: 'combat-start', round: safeInteger(payload.round, 1), participantIds: targets })
      break
    }
    case 'CombatEnded':
      appendBattleLog(state, event, { type: 'combat-end', round: safeInteger(payload.round, state.mechanics.combat.round), reason: String(payload.reason || 'resolved') })
      state.mechanics.combat = { active: false, round: safeInteger(payload.round, state.mechanics.combat.round), initiative: [], active_index: -1, action_economy: {} }
      break
    case 'EncounterEnded':
      if (state.mechanics.encounter) state.mechanics.encounter = {
        ...state.mechanics.encounter,
        status: 'ended',
        outcome: String(payload.outcome ?? payload.reason ?? 'resolved').slice(0, 120),
        ended_at: event.occurred_at ?? event.created_at ?? null,
      }
      appendBattleLog(state, event, {
        type: 'encounter-ended', encounterId: payload.encounter_id,
        participantIds: clone(payload.enemy_ids ?? []), reason: String(payload.reason ?? payload.outcome ?? 'resolved'),
      })
      break
    case 'TurnEnded':
      appendBattleLog(state, event, {
        sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round), round: safeInteger(payload.round, state.mechanics.combat.round),
        type: 'turn-end', actorId: event.actor_id, actorKind: combatActorKind(state, event.actor_id),
      })
      break
    case 'TurnStarted':
      state.mechanics.combat.round = safeInteger(payload.round, state.mechanics.combat.round)
      state.mechanics.combat.active_index = safeInteger(payload.active_index, state.mechanics.combat.active_index)
      if (target) state.mechanics.combat.action_economy[target] = actionEconomy()
      break
    case 'ActorMoved':
      state.mechanics.positions[target] = clone(payload.to)
      replaceActor(state, target, (actor) => payload.to && Number.isFinite(Number(payload.to.x)) && Number.isFinite(Number(payload.to.y))
        ? { ...actor, x: Number(payload.to.x), y: Number(payload.to.y) }
        : actor)
      if (state.mechanics.combat.active && event.actor_id) {
        const economy = state.mechanics.combat.action_economy[event.actor_id] ?? actionEconomy()
        state.mechanics.combat.action_economy[event.actor_id] = {
          ...economy,
          movement_spent: Math.max(0, safeInteger(payload.movement_spent, safeInteger(economy.movement_spent, 0) + safeInteger(payload.distance, 0))),
          movement: safeInteger(payload.movement_remaining, 0) > 0,
        }
      }
      appendBattleLog(state, event, {
        sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round), round: state.mechanics.combat.round,
        type: 'move', actorId: event.actor_id, actorKind: combatActorKind(state, event.actor_id),
        from: clone(payload.from), to: clone(payload.to), distanceFeet: safeInteger(payload.distance, 0),
      })
      break
    case 'TimeAdvanced':
      state.mechanics.world_time = { amount: (Number(state.mechanics.world_time?.amount) || 0) + (Number(payload.amount) || 0), unit: payload.unit }
      break
    case 'AreaRevealed':
      if (Array.isArray(state.scene?.cells)) state.scene.cells = state.scene.cells.map((cell) => payload.cells?.some((visible) => visible.x === cell.x && visible.y === cell.y) ? { ...cell, revealed: true } : cell)
      break
    case 'ObjectiveUpdated':
      if (state.scene) state.scene.objective = String(payload.objective || '')
      break
    case 'EntitySpawned': {
      const entity = payload.entity ?? {}
      if (Array.isArray(state.scene?.cells)) state.scene.cells = state.scene.cells.map((cell) => cell.x === entity.x && cell.y === entity.y ? { ...cell, feature: entity.kind, revealed: true } : cell)
      state.entities = [...(Array.isArray(state.entities) ? state.entities : []), clone(entity)]
      break
    }
    case 'ItemGranted':
      replaceActor(state, target, (actor) => ({ ...actor, inventory: [...(Array.isArray(actor.inventory) ? actor.inventory : []), clone(payload.item)] }))
      break
    case 'RulingRecorded':
      state.rulings = [...(Array.isArray(state.rulings) ? state.rulings : []), clone(payload.ruling)]
      break
    default:
      break
  }
  state.state_version = Number.isSafeInteger(event.state_version_after)
    ? event.state_version_after
    : state.state_version + 1
  synchronizeTacticalTurn(state)
  return state
}

export function replayEvents(initialState, events) {
  return (Array.isArray(events) ? events : []).reduce((state, event) => applyGameEvent(state, event), normalizeCampaignState(initialState))
}

export function resolveCommands(commands, initialState, options) {
  let state = normalizeCampaignState(initialState)
  const allEvents = []
  const allRolls = []
  const validatedCommands = []
  let commandIndex = 0
  for (const item of commands ?? []) {
    const hasExplicitExpected = item?.expected_state_version != null || item?.expectedStateVersion != null
    const expected = commandIndex === 0 && hasExplicitExpected
      ? (item.expected_state_version ?? item.expectedStateVersion)
      : state.state_version
    const result = resolveCommand({ ...item, expected_state_version: expected }, state, options)
    validatedCommands.push(result.command)
    for (const event of result.events) {
      allEvents.push(event)
      state = applyGameEvent(state, event)
    }
    allRolls.push(...result.rolls)
    commandIndex += 1
  }
  return { commands: validatedCommands, events: allEvents, rolls: allRolls, state }
}

export function eventSummary(event) {
  const payload = event.payload ?? {}
  switch (event.event_type) {
    case 'SceneAdvanced': return `Сцена перемещена из ${payload.location_before || 'прежней локации'} в ${payload.location_after || payload.scene?.location || 'новую локацию'}`
    case 'EncounterCreated': return `Создано столкновение: ${(payload.encounter?.enemies ?? []).map((enemy) => enemy.name).join(', ')}`
    case 'EncounterEnded': return `Столкновение завершено: ${payload.reason || payload.outcome || 'resolved'}`
    case 'CombatStarted': return `Бой начался; инициатива определена для ${(event.target_ids ?? []).length} участников`
    case 'ActorMoved': return `${event.actor_id || 'Участник'} перемещается на ${safeInteger(payload.distance, 0)} фт.`
    case 'TurnEnded': return `${event.actor_id || 'Участник'} завершает ход`
    case 'TurnStarted': return `Начинается ход ${(event.target_ids ?? [])[0] || 'следующего участника'}, раунд ${safeInteger(payload.round, 1)}`
    case 'DieRolled': return `Бросок ${payload.expression || 'кости'}: ${safeInteger(payload.total, 0)}`
    case 'DamageApplied': return `Урон: ${payload.applied_amount}; HP ${payload.hp_before} → ${payload.hp_after}`
    case 'HealingApplied': return `Лечение: ${payload.applied_amount}; HP ${payload.hp_before} → ${payload.hp_after}`
    case 'AttackResolved': return `Атака ${payload.hit ? 'попала' : 'не попала'}: ${payload.total} против КД ${payload.armor_class}`
    case 'AreaAttackResolved': return `${payload.item_name || 'Снаряд'} поражает область радиусом ${payload.radius_feet} фт.`
    case 'EquipmentChanged': return `${payload.item_name || 'Оружие'} экипировано`
    case 'MerchantBargainResolved': return payload.success ? 'Торговец согласился изменить условия сделки' : 'Торговец отказался уступать в цене'
    case 'MerchantItemAppraised': return `Торговец оценил предмет «${payload.item_name ?? payload.item_id}» в ${payload.base_unit_price_cp ?? 0} мм`
    case 'MerchantPurchaseCompleted': return `Покупка: ${payload.item?.name || payload.catalog_id || 'предмет'}, ${payload.quantity} шт. за ${payload.total_price_cp} мм.`
    case 'MerchantSaleCompleted': return `Продажа: ${payload.item?.name || payload.catalog_id || 'предмет'}, ${payload.quantity} шт. за ${payload.total_price_cp} мм.`
    case 'MerchantCreated': return `Создан торговец ${payload.merchant?.name || payload.merchant_id}`
    case 'MerchantConfigured': return `Обновлены настройки торговца ${payload.merchant_id}`
    case 'MerchantRestocked': return `Склад торговца ${payload.merchant_id} пополнен на ${safeInteger(payload.total_quantity_added, 0)} ед.`
    case 'MerchantMoved': return `Торговец ${payload.merchant_id} перемещён в ${payload.location_after}`
    case 'MerchantAvailabilityChanged': return `Торговец ${payload.merchant_id} ${payload.available_after ? 'доступен' : 'недоступен'}`
    case 'AbilityCheckResolved': return `Проверка ${payload.ability}: ${payload.total} против СЛ ${payload.difficulty}`
    case 'SavingThrowResolved': return `Спасбросок ${payload.ability}: ${payload.total} против СЛ ${payload.difficulty}`
    case 'ResourceSpent': return `${payload.resource}: ${payload.before} → ${payload.after}`
    case 'ConditionAdded': return `Добавлено состояние: ${payload.condition}`
    case 'ConditionRemoved': return `Снято состояние: ${payload.condition}`
    case 'HitPointsReducedToZero': return `${(event.target_ids ?? [])[0] || 'Цель'} выбывает из боя`
    case 'CombatEnded': return `Бой завершён в раунде ${payload.round}`
    default: return event.event_type
  }
}

export class RulesEngine {
  constructor({ diceService }) {
    if (!diceService) throw new TypeError('RulesEngine требует DiceService')
    this.diceService = diceService
  }

  validate(command, state, context) {
    return validateCommand(command, state, context)
  }

  resolve(command, state, context) {
    return resolveCommand(command, state, { diceService: this.diceService, context })
  }

  resolvePlan(plan, state, context) {
    return resolveCommands(plan?.proposed_commands ?? plan?.commands ?? [], state, { diceService: this.diceService, context })
  }
}
