import { randomUUID } from 'node:crypto'
import { parseDiceExpression } from './dice-service.mjs'
import { applyAutonomyEvent, normalizeAutonomyState } from './autonomous-campaign.mjs'
import { createSceneTransition, publicAdventureMemory } from './adventure-director.mjs'
import { ensureCampaignWorldMap } from './world-map.mjs'
import {
  WORLD_MEMORY_COMMAND_TYPES,
  WorldMemoryValidationError,
  applyWorldMemoryEvent,
  validateWorldMemoryCommand,
  worldMemoryEvent,
} from './world-memory.mjs'
import {
  ensureSceneWorldMemory,
  sceneWorldMemoryEventId,
  sceneWorldMemoryEvents,
} from './scene-memory.mjs'
import {
  NPC_SOCIAL_COMMAND_TYPES,
  NpcSocialValidationError,
  applyNpcSocialEvent,
  ensureNpcSocialState,
  npcPromiseDeadlineEvents,
  npcSocialEvents,
  validateNpcSocialCommand,
} from './npc-social.mjs'
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
  normalizedSpellSelectionsFor,
  spellSlotMaximumsFor,
} from './combat-spells.mjs'
import {
  combatActionFor,
  combatActionsFor,
  combatResourceMaximumsFor,
  combatResourceRecoveryFor,
  normalizedCombatSubclassFor,
} from './combat-actions.mjs'
import { characterClassKey, isSkillProficient, normalizedClassSkillProficiencies, normalizedSelectedFeatureIds, skillAbility } from './character-progression.mjs'

export const DEFAULT_RULESET_ID = 'srd_5_2_1'
export const GAME_STATE_PROJECTOR_VERSION = 2

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
  auraOfProtection: `${DEFAULT_RULESET_ID}:classes:paladin-aura-of-protection`,
  indomitable: `${DEFAULT_RULESET_ID}:classes:fighter-indomitable`,
})

const COMMAND_RULES = Object.freeze({
  MakeAbilityCheck: [RULE_IDS.abilityCheck],
  MakeSavingThrow: [RULE_IDS.savingThrow],
  MakeAttack: [RULE_IDS.attack],
  MakeAreaAttack: [RULE_IDS.attack, RULE_IDS.damage],
  ChangeWeapon: [RULE_IDS.actions],
  ApplyDamage: [RULE_IDS.damage],
  ApplyHealing: [RULE_IDS.healing],
  ReduceHitPointMaximum: [RULE_IDS.damage, RULE_IDS.conditions],
  ResolveHeroDeath: [RULE_IDS.zeroHp, RULE_IDS.healing],
  GrantTemporaryHitPoints: [RULE_IDS.temporaryHp],
  SpendResource: [RULE_IDS.resource],
  RestoreResource: [RULE_IDS.resource],
  AddCondition: [RULE_IDS.conditions],
  RemoveCondition: [RULE_IDS.conditions],
  CastSpell: [RULE_IDS.turns],
  UseCombatAction: [RULE_IDS.actions],
  MoveActor: [RULE_IDS.turns],
  StartCombat: [RULE_IDS.initiative],
  EndCombat: [RULE_IDS.initiative, RULE_IDS.turns],
  EndTurn: [RULE_IDS.turns],
  AdvanceTime: [RULE_IDS.resource],
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
  UpsertWorldEntity: [],
  RecordWorldFact: [],
  RevealWorldFact: [],
  UpsertQuest: [],
  AdvanceQuestClock: [],
  UpsertNpcSocialProfile: [],
  RecordNpcSocialTurn: [],
  ResolveNpcPromise: [],
})

export const ALLOWED_COMMAND_TYPES = new Set([
  'DeclareAction', 'MakeAbilityCheck', 'MakeSavingThrow', 'MakeAttack', 'ApplyDamage', 'ApplyHealing', 'ReduceHitPointMaximum',
  'ResolveHeroDeath',
  'GrantTemporaryHitPoints', 'SpendResource', 'RestoreResource', 'AddCondition', 'RemoveCondition',
  'CastSpell', 'UseCombatAction', 'MoveActor', 'StartCombat', 'EndCombat', 'EndTurn', 'ChangeWeapon', 'MakeAreaAttack', 'AdvanceTime', 'StartRest', 'CompleteRest',
  'StartConcentration', 'EndConcentration', 'RevealArea', 'UpdateObjective', 'SpawnEntity', 'GrantItem',
  'RecordRuling', 'BargainWithMerchant', 'AppraiseItem', 'BuyItem', 'SellItem',
  'CreateMerchant', 'ConfigureMerchant', 'RestockMerchant', 'MoveMerchant', 'SetMerchantAvailability', 'CreateEncounter',
  'AdvanceScene',
  'UpsertWorldEntity', 'RecordWorldFact', 'RevealWorldFact', 'UpsertQuest',
  'AdvanceQuestClock',
  'UpsertNpcSocialProfile', 'RecordNpcSocialTurn', 'ResolveNpcPromise',
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

function durationInMinutes(amount, unit = 'minute') {
  const value = Math.max(0, Number(amount) || 0)
  const normalized = String(unit || 'minute').trim().toLowerCase()
  const multiplier = ['hour', 'hours', 'hour(s)', 'час', 'часа', 'часов'].includes(normalized)
    ? 60
    : ['day', 'days', 'day(s)', 'день', 'дня', 'дней'].includes(normalized)
      ? 1_440
      : ['round', 'rounds', 'round(s)', 'раунд', 'раунда', 'раундов'].includes(normalized)
        ? 0.1
        : 1
  return Math.max(0, Math.floor(value * multiplier))
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
    resting: {},
    conditions: {},
    defenses: {},
    concentration: {},
    positions: {},
    item_appraisals: {},
    encounter: null,
    active_effects: [],
    death: {
      campaign_status: 'active',
      heroes: {},
      saving_throws: {},
    },
    combat: {
      active: false,
      round: 0,
      initiative: [],
      active_index: -1,
      action_economy: {},
      reaction_window: null,
    },
  }
}

export function normalizeCampaignState(input = {}) {
  const state = clone(input && typeof input === 'object' ? input : {})
  const mechanics = { ...defaultMechanics(), ...(state.mechanics && typeof state.mechanics === 'object' ? state.mechanics : {}) }
  mechanics.temporary_hp = { ...(state.mechanics?.temporary_hp ?? {}) }
  mechanics.resources = clone(state.mechanics?.resources ?? {})
  mechanics.resting = Object.fromEntries(Object.entries(clone(state.mechanics?.resting ?? {}))
    .filter(([id, rest]) => id && rest && typeof rest === 'object')
    .map(([id, rest]) => [id, {
      kind: rest.kind === 'long' ? 'long' : 'short',
      ...(rest.reason === 'knockout' ? {
        reason: 'knockout',
        recovery_minutes_remaining: Math.max(1, Math.min(60, safeInteger(rest.recovery_minutes_remaining, 60))),
      } : {}),
    }]))
  mechanics.conditions = clone(state.mechanics?.conditions ?? {})
  mechanics.defenses = clone(state.mechanics?.defenses ?? {})
  mechanics.concentration = clone(state.mechanics?.concentration ?? {})
  mechanics.positions = clone(state.mechanics?.positions ?? {})
  mechanics.item_appraisals = clone(state.mechanics?.item_appraisals ?? {})
  mechanics.encounter = state.mechanics?.encounter && typeof state.mechanics.encounter === 'object'
    ? clone(state.mechanics.encounter)
    : null
  mechanics.active_effects = Array.isArray(state.mechanics?.active_effects) ? clone(state.mechanics.active_effects) : []
  const rawWorldTime = state.mechanics?.world_time ?? {}
  const elapsedMinutes = rawWorldTime.elapsed_minutes != null && Number.isSafeInteger(Number(rawWorldTime.elapsed_minutes))
    ? Math.max(0, Number(rawWorldTime.elapsed_minutes))
    : durationInMinutes(rawWorldTime.amount, rawWorldTime.unit)
  mechanics.world_time = { amount: elapsedMinutes, unit: 'minute', elapsed_minutes: elapsedMinutes }
  mechanics.death = {
    campaign_status: state.mechanics?.death?.campaign_status === 'party_defeated' ? 'party_defeated' : 'active',
    heroes: Object.fromEntries(Object.entries(clone(state.mechanics?.death?.heroes ?? {}))
      .filter(([id, fate]) => id && fate && typeof fate === 'object')
      .map(([id, fate]) => [id, {
        status: fate.status === 'dead' ? 'dead' : 'resolved',
        resolution: ['resurrected', 'replaced'].includes(String(fate.resolution)) ? String(fate.resolution) : null,
        died_at: fate.died_at ?? null,
        resolved_at: fate.resolved_at ?? null,
        replacement_name: fate.replacement_name == null ? null : String(fate.replacement_name).slice(0, 120),
      }])),
    saving_throws: Object.fromEntries(Object.entries(clone(state.mechanics?.death?.saving_throws ?? {}))
      .filter(([id, tracker]) => id && tracker && typeof tracker === 'object')
      .map(([id, tracker]) => {
        const stable = tracker.stable === true
        const recoveryMinutes = Math.max(0, Math.min(1_440, safeInteger(tracker.recovery_minutes_remaining, 0)))
        return [id, {
          successes: Math.max(0, Math.min(2, safeInteger(tracker.successes, 0))),
          failures: Math.max(0, Math.min(2, safeInteger(tracker.failures, 0))),
          stable,
          ...(stable && recoveryMinutes > 0 ? { recovery_minutes_remaining: recoveryMinutes } : {}),
        }]
      })),
  }
  mechanics.combat = { ...defaultMechanics().combat, ...(state.mechanics?.combat ?? {}) }
  mechanics.combat.initiative = Array.isArray(mechanics.combat.initiative) ? clone(mechanics.combat.initiative) : []
  mechanics.combat.reaction_window = mechanics.combat.reaction_window && typeof mechanics.combat.reaction_window === 'object' ? clone(mechanics.combat.reaction_window) : null
  mechanics.combat.action_economy = Object.fromEntries(Object.entries(clone(mechanics.combat.action_economy ?? {})).map(([id, economy]) => [id, {
    ...actionEconomy(),
    ...(economy && typeof economy === 'object' ? economy : {}),
    movement_spent: Math.max(0, safeInteger(economy?.movement_spent ?? economy?.movementSpent, 0)),
    movement_bonus: Math.max(0, safeInteger(economy?.movement_bonus ?? economy?.movementBonus, 0)),
    extra_actions: Math.max(0, safeInteger(economy?.extra_actions ?? economy?.extraActions, 0)),
    surged_action_only: economy?.surged_action_only === true,
  }]))

  state.state_version = Math.max(0, safeInteger(state.state_version ?? state.stateVersion, 0))
  // `legacy` and `shadow` may still be present in old snapshots, but live
  // gameplay always uses the single authoritative engine.
  state.engine_mode = 'enforce'
  state.ruleset_id = String(state.ruleset_id || state.rulesetId || DEFAULT_RULESET_ID)
  state.ruleset_version = String(state.ruleset_version || state.rulesetVersion || '5.2.1')
  state.enabled_rule_packs = uniqueStrings(state.enabled_rule_packs ?? state.enabledRulePacks)
  if (!state.enabled_rule_packs.length) state.enabled_rule_packs = [state.ruleset_id]
  state.enabled_house_rules = uniqueStrings(state.enabled_house_rules ?? state.enabledHouseRules)
  state.ruleset_locked_at = state.ruleset_locked_at ?? state.rulesetLockedAt ?? null
  state.mechanics = mechanics
  state.players = Array.isArray(state.players) ? state.players.map((player) => {
    const normalizedPlayer = { ...player }
    if (Object.hasOwn(player, 'subclass')) normalizedPlayer.subclass = normalizedCombatSubclassFor(player) ?? undefined
    if (Object.hasOwn(player, 'classSkillProficiencies')) normalizedPlayer.classSkillProficiencies = normalizedClassSkillProficiencies(normalizedPlayer)
    if (Object.hasOwn(player, 'selectedFeatureIds')) normalizedPlayer.selectedFeatureIds = normalizedSelectedFeatureIds(normalizedPlayer)
    const spellSelections = normalizedSpellSelectionsFor(normalizedPlayer)
    if (Object.hasOwn(player, 'knownSpellIds')) normalizedPlayer.knownSpellIds = spellSelections.knownSpellIds ?? []
    if (Object.hasOwn(player, 'preparedSpellIds')) normalizedPlayer.preparedSpellIds = spellSelections.preparedSpellIds ?? []
    return {
      ...normalizedPlayer,
      hp: Math.max(0, safeInteger(player.hp, 0)),
      maxHp: Math.max(1, safeInteger(player.maxHp ?? player.max_hp, 1)),
      currency: normalizeCurrency(player.currency),
      inventory: normalizeInventory(player.inventory, String(player.id ?? 'actor')),
      combatSpells: combatSpellsFor(normalizedPlayer),
      combatActions: combatActionsFor(normalizedPlayer),
    }
  }) : []
  state.actors = Array.isArray(state.actors) ? state.actors.map((actor) => ({
    ...actor,
    id: String(actor.id ?? actor.actor_id ?? ''),
    hp: Math.max(0, safeInteger(actor.hp, 0)),
    maxHp: Math.max(1, safeInteger(actor.maxHp ?? actor.max_hp, 1)),
    alive: actor.alive !== false && safeInteger(actor.hp, 0) > 0,
  })).filter((actor) => actor.id) : []
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
    mechanics.resources[id] ??= {}
    for (const [resource, maximum] of Object.entries(spellSlotMaximumsFor(actor))) {
      if (!mechanics.resources[id][resource]) mechanics.resources[id][resource] = { current: maximum, max: maximum }
    }
    for (const [resource, maximum] of Object.entries(combatResourceMaximumsFor(actor))) {
      if (!mechanics.resources[id][resource]) mechanics.resources[id][resource] = { current: maximum, max: maximum }
    }
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
  state.worldMap = ensureCampaignWorldMap(state)
  state.worldMemory = ensureSceneWorldMemory(state.worldMemory, state)
  state.social = ensureNpcSocialState(state.social, state)
  state.autonomy = normalizeAutonomyState(state.autonomy)
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

function creatureTypeFor(actor) {
  const value = String(actor?.creature_type ?? actor?.creatureType ?? actor?.monster_type ?? actor?.monsterType ?? '').toLocaleLowerCase('ru')
  if (/construct|конструкт/u.test(value)) return 'construct'
  if (/undead|нежит/u.test(value)) return 'undead'
  if (/humanoid|гуманоид/u.test(value) || (!value && (actor?.character || actor?.characterClass))) return 'humanoid'
  return value
}

function understandsSpellLanguage(actor) {
  if (actor?.understands_language === false || actor?.understandsLanguage === false) return false
  if ((actor?.conditions ?? []).some((condition) => String(condition?.id ?? condition) === 'cannot-understand-language')) return false
  return true
}

function forcedPushPath(state, moverId, origin, distanceFeet) {
  const from = actorPosition(state, moverId)
  if (!from || !origin) return []
  const dx = from.x - origin.x
  const dy = from.y - origin.y
  if (!dx && !dy) return []
  const step = Math.abs(dx) >= Math.abs(dy)
    ? { x: Math.sign(dx), y: 0 }
    : { x: 0, y: Math.sign(dy) }
  const cells = tacticalCellMap(state)
  const occupied = occupiedPositions(state, moverId)
  const path = []
  let cursor = from
  for (let index = 0; index < Math.floor(Math.max(0, Number(distanceFeet) || 0) / 5); index += 1) {
    const next = { x: cursor.x + step.x, y: cursor.y + step.y }
    if (!isWalkableCell(cells.get(positionKey(next))) || occupied.has(positionKey(next))) break
    path.push(next)
    cursor = next
  }
  return path
}

function farthestSafeDestinationAwayFrom(state, moverId, origin, distanceFeet) {
  const from = actorPosition(state, moverId)
  if (!from || !origin) return null
  const cells = tacticalCellMap(state)
  const occupied = occupiedPositions(state, moverId)
  const maximumSteps = Math.floor(Math.max(0, Number(distanceFeet) || 0) / 5)
  const start = positionKey(from)
  const queue = [{ position: from, path: [] }]
  const visited = new Set([start])
  const candidates = []
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    candidates.push(current)
    if (current.path.length >= maximumSteps) continue
    for (const [x, y] of [[current.position.x + 1, current.position.y], [current.position.x - 1, current.position.y], [current.position.x, current.position.y + 1], [current.position.x, current.position.y - 1]]) {
      const next = { x, y }
      const key = positionKey(next)
      if (visited.has(key) || !isWalkableCell(cells.get(key)) || occupied.has(key)) continue
      if (activeAreaEffectsAt(state, next).some((effect) => effect.condition && effect.spell_id !== 'grease')) continue
      visited.add(key)
      queue.push({ position: next, path: [...current.path, next] })
    }
  }
  const distanceFromOrigin = (position) => Math.max(Math.abs(position.x - origin.x), Math.abs(position.y - origin.y))
  return candidates.sort((left, right) => distanceFromOrigin(right.position) - distanceFromOrigin(left.position)
    || right.path.length - left.path.length
    || positionKey(left.position).localeCompare(positionKey(right.position)))[0] ?? null
}

function diceExpression(dice, bonus, fallbackSides) {
  let expression = typeof dice === 'string' ? dice : `1d${safeInteger(dice, fallbackSides)}`
  let parsed
  try { parsed = parseDiceExpression(expression) }
  catch { parsed = parseDiceExpression(`1d${fallbackSides}`) }
  const modifier = parsed.modifier + safeInteger(bonus, 0)
  return `${parsed.count}d${parsed.sides}${modifier > 0 ? `+${modifier}` : modifier < 0 ? modifier : ''}`
}

function resolvedHealingRoll(state, targetId, expression, rolledAmount) {
  const rolled = Math.max(0, safeInteger(rolledAmount, 0))
  if (!expression || !conditionIdsFor(state, targetId).has('beacon-of-hope')) return { amount: rolled }
  try {
    const parsed = parseDiceExpression(String(expression))
    return {
      amount: Math.max(0, parsed.count * parsed.sides + parsed.modifier),
      rolled_amount: rolled,
      maximized_by: 'beacon-of-hope',
    }
  } catch {
    return { amount: rolled }
  }
}

function monsterTraitFor(actor, traitId) {
  return (Array.isArray(actor?.traits) ? actor.traits : []).find((trait) => String(trait?.id ?? trait) === String(traitId)) ?? null
}

function monsterActionFor(actor, actionId) {
  const actions = Array.isArray(actor?.action_profiles) ? actor.action_profiles : []
  if (actionId) return actions.find((action) => String(action?.id) === String(actionId)) ?? null
  return actions[0] ?? null
}

function trustedAttackProfile(state, actor, actionId = null) {
  const monsterAction = monsterActionFor(actor, actionId)
  const profile = monsterAction && typeof monsterAction === 'object'
    ? monsterAction
    : actor?.attack_profile && typeof actor.attack_profile === 'object'
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
  const explicitFlatDamage = profile.damage_amount ?? profile.damageAmount
  let expression
  let flatDamage = null
  if (Number.isFinite(Number(explicitFlatDamage))) {
    expression = null
    flatDamage = Math.max(0, safeInteger(explicitFlatDamage, 0))
  } else if (damageExpression) {
    try { expression = parseDiceExpression(damageExpression).canonical }
    catch { expression = diceExpression(damageDice, Number.isSafeInteger(Number(damageBonus)) ? Number(damageBonus) : strength, enemy ? 6 : 1) }
  } else if (!enemy && !Number.isSafeInteger(Number(damageDice))) {
    expression = null
    flatDamage = Math.max(0, 1 + strength)
  } else {
    expression = diceExpression(damageDice, Number.isSafeInteger(Number(damageBonus)) ? Number(damageBonus) : strength, 6)
  }
  const range = safeInteger(profile.range_feet ?? profile.rangeFeet ?? profile.range ?? actor?.attackRange ?? actor?.rangeFeet, 5)
  return {
    id: profile.id == null ? null : String(profile.id).slice(0, 120),
    name: String(profile.name ?? actor?.name ?? 'Атака').slice(0, 120),
    kind: profile.kind === 'ranged' ? 'ranged' : 'melee',
    modifier: Math.max(-100, Math.min(100, modifier)),
    damage_expression: expression,
    damage_amount: flatDamage,
    damage_type: String(profile.damage_type ?? profile.damageType ?? actor?.damageType ?? 'slashing').slice(0, 40),
    range_feet: Math.max(5, Math.min(600, range)),
    normal_range_feet: Math.max(5, Math.min(600, safeInteger(profile.normal_range_feet ?? profile.normalRangeFeet, range))),
    advantage: Boolean(profile.advantage ?? actor?.attackAdvantage),
    disadvantage: Boolean(profile.disadvantage ?? actor?.attackDisadvantage),
    on_hit: profile.on_hit && typeof profile.on_hit === 'object' ? clone(profile.on_hit) : null,
    uses: Math.max(0, safeInteger(profile.uses, 0)),
    tactical_priority: safeInteger(profile.tactical_priority, 0),
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

export function attackProfileFor(state, actorIdValue, actionId = null) {
  const actor = findActor(state, actorIdValue)
  return actor ? trustedAttackProfile(state, actor, actionId) : null
}

function distanceBetweenActors(state, firstActorId, secondActorId) {
  const first = actorPosition(state, firstActorId)
  const second = actorPosition(state, secondActorId)
  return first && second ? Math.max(Math.abs(first.x - second.x), Math.abs(first.y - second.y)) * 5 : null
}

const OPPORTUNITY_BLOCKING_CONDITIONS = new Set(['incapacitated', 'unconscious', 'stunned', 'paralyzed'])

function opportunityAttackProfile(state, actor) {
  const equippedMelee = (Array.isArray(actor?.inventory) ? actor.inventory : [])
    .find((item) => item?.equipped && item?.combat?.kind === 'melee' && Number(item?.quantity ?? 1) > 0)
  if (equippedMelee) {
    const profile = itemAttackProfile(state, actor, equippedMelee.id)
    return profile ? { profile, item_id: equippedMelee.id } : null
  }
  const profile = trustedAttackProfile(state, actor)
  return profile.range_feet <= 5 ? { profile, item_id: null } : null
}

function opportunityAttackers(state, moverId, from, path) {
  if (!state.mechanics.combat.active || !from || !path?.length) return []
  const moverConditions = conditionIdsFor(state, moverId)
  if (moverConditions.has('disengaged') || moverConditions.has('invisible') || moverConditions.has('zephyr-strike')) return []
  const moverIsEnemy = isEnemyActor(state, moverId)
  const initiativeOrder = new Map((state.mechanics.combat.initiative ?? []).map((entry, index) => [String(entry.actor_id), index]))
  return listActors(state)
    .filter((candidate) => {
      const candidateId = actorId(candidate)
      if (candidateId === moverId || !isLivingActor(candidate) || isEnemyActor(state, candidateId) === moverIsEnemy) return false
      if (state.mechanics.combat.action_economy[candidateId]?.reaction === false) return false
      const conditions = conditionIdsFor(state, candidateId)
      if ([...OPPORTUNITY_BLOCKING_CONDITIONS].some((condition) => conditions.has(condition))) return false
      const position = actorPosition(state, candidateId)
      if (!position || Math.max(Math.abs(position.x - from.x), Math.abs(position.y - from.y)) !== 1) return false
      if (!path.some((step) => Math.max(Math.abs(position.x - step.x), Math.abs(position.y - step.y)) > 1)) return false
      return Boolean(opportunityAttackProfile(state, candidate))
    })
    .sort((left, right) => (initiativeOrder.get(actorId(left)) ?? Number.MAX_SAFE_INTEGER) - (initiativeOrder.get(actorId(right)) ?? Number.MAX_SAFE_INTEGER)
      || actorId(left).localeCompare(actorId(right)))
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
  command.action_id = command.action_id == null && command.actionId == null ? null : String(command.action_id ?? command.actionId).slice(0, 120)
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
  if (command.command_type === 'ResolveHeroDeath') {
    command.resolution = String(command.resolution ?? '')
    command.replacement_name = command.replacement_name == null ? '' : String(command.replacement_name).trim().slice(0, 120)
  }
  command.expected_state_version = safeInteger(command.expected_state_version ?? command.expectedStateVersion, state.state_version)
  return command
}

function needsActor(type) {
  return new Set(['DeclareAction', 'MakeAbilityCheck', 'MakeSavingThrow', 'MakeAttack', 'MakeAreaAttack', 'ChangeWeapon', 'ApplyDamage', 'ApplyHealing', 'ReduceHitPointMaximum',
    'ResolveHeroDeath',
    'GrantTemporaryHitPoints', 'SpendResource', 'RestoreResource', 'AddCondition', 'RemoveCondition', 'CastSpell',
    'UseCombatAction', 'MoveActor', 'EndCombat', 'EndTurn', 'StartRest', 'CompleteRest', 'StartConcentration', 'EndConcentration', 'GrantItem',
    'BargainWithMerchant', 'AppraiseItem', 'BuyItem', 'SellItem']).has(type)
}

function skillProficiencyBonus(actor, skill) {
  return isSkillProficient(actor, skill) ? Math.max(0, safeInteger(actor?.proficiency, 0)) : 0
}

function targetFor(command) {
  return command.target_id || command.target_ids[0] || command.actor_id
}

function playerActor(state, id) {
  return (Array.isArray(state?.players) ? state.players : []).find((player) => String(player.id) === String(id ?? '')) ?? null
}

function deathSaveTracker(state, id) {
  const tracker = state?.mechanics?.death?.saving_throws?.[String(id)]
  return {
    successes: Math.max(0, Math.min(2, safeInteger(tracker?.successes, 0))),
    failures: Math.max(0, Math.min(2, safeInteger(tracker?.failures, 0))),
    stable: tracker?.stable === true,
  }
}

function isDeadHero(state, id) {
  return state?.mechanics?.death?.heroes?.[String(id)]?.status === 'dead'
}

function isDyingHero(state, id) {
  const actor = playerActor(state, id)
  return Boolean(actor) && actorHp(actor) === 0 && !isDeadHero(state, id)
}

function isUnstableDyingHero(state, id) {
  return isDyingHero(state, id) && !deathSaveTracker(state, id).stable
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

function assertTurn(command, state, context = {}) {
  const combat = state.mechanics.combat
  if (!combat.active || !['MakeAttack', 'MakeAreaAttack', 'ChangeWeapon', 'CastSpell', 'UseCombatAction', 'MoveActor', 'EndCombat', 'EndTurn'].includes(command.command_type)) return
  if (context.reactionResolution && command.command_type === 'MakeAttack') return
  if (context.spellMovement && command.command_type === 'MoveActor' && command.reaction_movement === true) return
  const current = combat.initiative[combat.active_index]
  if (current && String(current.actor_id) !== command.actor_id) {
    if (command.command_type === 'UseCombatAction') {
      const window = combat.reaction_window
      const action = combatActionFor(findActor(state, command.actor_id), command.action_id)
      const permitted = window && String(window.actor_id) === command.actor_id
        && (command.action_id === 'decline-reaction' || window.trigger === 'failed-saving-throw' && command.action_id === 'indomitable'
          || (window.action_ids ?? []).includes(command.action_id) && (command.action_id === 'opportunity-attack' || command.action_id.startsWith('cast:') || action?.actionType === 'reaction'))
      if (permitted) return
    }
    throw new RulesValidationError('Сейчас ход другого участника', 'OUT_OF_TURN')
  }
  const commandCondition = (state.mechanics.conditions[command.actor_id] ?? []).find((condition) => String(condition?.id ?? condition).startsWith('command:'))
  if (commandCondition) {
    const option = String(commandCondition.id).slice('command:'.length)
    const movementCommand = command.command_type === 'MoveActor'
    const endTurnCommand = command.command_type === 'EndTurn'
    if (['halt', 'drop', 'grovel'].includes(option) && !endTurnCommand) {
      throw new RulesValidationError('Существо должно исполнить наложенный приказ и окончить ход', 'COMMAND_RESTRICTS_TURN')
    }
    if (['approach', 'flee'].includes(option) && !movementCommand && !endTurnCommand) {
      throw new RulesValidationError('Существо должно потратить ход на перемещение согласно приказу', 'COMMAND_RESTRICTS_TURN')
    }
  }
  const actorConditions = state.mechanics.conditions[command.actor_id] ?? []
  if (actorConditions.some((condition) => String(condition?.id ?? condition) === 'incapacitated') && !['MoveActor', 'EndTurn'].includes(command.command_type)
    && !(command.command_type === 'UseCombatAction' && command.action_id === 'indomitable')) {
    throw new RulesValidationError('Недееспособное существо не может совершать действия и реакции', 'ACTOR_INCAPACITATED')
  }
  const charmedByTarget = actorConditions.find((condition) => String(condition?.id ?? condition) === 'charmed' && String(condition.source_actor ?? '') === String(targetFor(command)))
  if (charmedByTarget && ['MakeAttack', 'CastSpell', 'UseCombatAction'].includes(command.command_type)) {
    throw new RulesValidationError('Очарованное существо не может атаковать очаровавшего его', 'CHARMED_ATTACK_FORBIDDEN')
  }
  if (command.command_type === 'CastSpell') {
    const spell = combatSpellFor(findActor(state, command.actor_id), command.spell_id)
    const quickened = conditionIdsFor(state, command.actor_id).has('metamagic-quickened') && spell?.actionType === 'action'
    const resource = quickened || spell?.actionType === 'bonus_action' ? 'bonus_action' : spell?.actionType === 'reaction' ? 'reaction' : 'action'
    const economy = combat.action_economy[command.actor_id]
    if (resource === 'action' && economy?.surged_action_only) {
      throw new RulesValidationError('Дополнительное действие от Всплеска действий нельзя потратить на магию', 'ACTION_SURGE_MAGIC_FORBIDDEN')
    }
    if (economy && economy[resource] === false) {
      const label = resource === 'bonus_action' ? 'Бонусное действие' : resource === 'reaction' ? 'Реакция' : 'Действие'
      throw new RulesValidationError(`${label} на этом ходу уже потрачено`, resource === 'bonus_action' ? 'BONUS_ACTION_SPENT' : resource === 'reaction' ? 'REACTION_SPENT' : 'ACTION_SPENT')
    }
  } else if (command.command_type === 'UseCombatAction') {
    const action = combatActionFor(findActor(state, command.actor_id), command.action_id)
    const resource = action?.actionType === 'bonus_action' ? 'bonus_action' : action?.actionType === 'reaction' ? 'reaction' : action?.actionType === 'free' ? null : 'action'
    const economy = combat.action_economy[command.actor_id]
    if (resource && economy?.[resource] === false) {
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
  if (command.command_type === 'MakeAbilityCheck' && command.social_check != null) {
    const expected = context?.socialCheck
    if (context?.isSocialController !== true || !expected) {
      throw new RulesValidationError('Social checks can only be created by the server NPC controller', 'NPC_SOCIAL_CHECK_FORBIDDEN')
    }
    command.actor_id = String(expected.hero_id)
    command.target_id = command.actor_id
    command.target_ids = [command.actor_id]
    command.skill = String(expected.skill)
    command.ability = String(expected.ability)
    command.difficulty = safeInteger(expected.difficulty, 10)
    command.visibility = expected.visibility === 'specific_player' ? 'specific_player' : 'party'
    command.social_check = {
      check_id: String(expected.check_id),
      npc_id: String(expected.npc_id),
      skill: String(expected.skill),
      request_fingerprint: String(expected.request_fingerprint),
    }
    delete command.modifier
    command.advantage = Boolean(expected.advantage)
    command.disadvantage = Boolean(expected.disadvantage)
  }
  if (WORLD_MEMORY_COMMAND_TYPES.has(command.command_type)) {
    try {
      Object.assign(command, validateWorldMemoryCommand(command, state, context))
    } catch (error) {
      if (error instanceof WorldMemoryValidationError) {
        throw new RulesValidationError(error.message, error.code)
      }
      throw error
    }
  }
  if (NPC_SOCIAL_COMMAND_TYPES.has(command.command_type)) {
    try {
      Object.assign(command, validateNpcSocialCommand(command, state, context))
    } catch (error) {
      if (error instanceof NpcSocialValidationError) {
        throw new RulesValidationError(error.message, error.code)
      }
      throw error
    }
  }
  if (state.mechanics.death.campaign_status === 'party_defeated' && command.command_type !== 'EndCombat') {
    throw new RulesValidationError('Все герои погибли. Эта история завершена, продолжать игру в этом мире нельзя', 'WORLD_ENDED')
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
    if (['RevealArea', 'UpdateObjective', 'SpawnEntity', 'GrantItem', 'RecordRuling', ...NPC_SOCIAL_COMMAND_TYPES].includes(command.command_type)) break
    if (!findActor(state, id)) throw new RulesValidationError(`Цель ${id} не найдена`, 'TARGET_NOT_FOUND')
  }
  assertActorPermission(command, context, state)
  assertTurn(command, state, context)

  const actorFate = command.actor_id ? state.mechanics.death.heroes[command.actor_id] : null
  if (actorFate?.status === 'dead' && !['ResolveHeroDeath', 'EndCombat'].includes(command.command_type)) {
    throw new RulesValidationError('Погибший герой не может действовать, пока его не заменят или не воскресят', 'HERO_DEAD_UNRESOLVED')
  }
  if (command.command_type === 'ResolveHeroDeath') {
    if (!playerActor(state, command.actor_id)) throw new RulesValidationError('Разрешить судьбу можно только для героя группы', 'ACTOR_FORBIDDEN')
    if (actorFate?.status !== 'dead') throw new RulesValidationError('У этого героя нет неразрешённой смерти', 'HERO_DEATH_NOT_PENDING')
    if (!['resurrect', 'replace'].includes(command.resolution)) throw new RulesValidationError('Нужно выбрать воскрешение или нового героя', 'INVALID_DEATH_RESOLUTION')
    if (command.resolution === 'replace' && command.replacement_name.length < 2) {
      throw new RulesValidationError('Укажите имя нового героя', 'REPLACEMENT_NAME_REQUIRED')
    }
  }

  if (command.command_type === 'StartRest' || command.command_type === 'CompleteRest') {
    const kind = command.kind === 'long' ? 'long' : 'short'
    command.kind = kind
    if (state.mechanics.combat.active) {
      throw new RulesValidationError('Нельзя отдыхать во время активного боя', 'REST_DURING_COMBAT')
    }
    if (!isLivingActor(findActor(state, command.actor_id))) {
      throw new RulesValidationError('Отдых доступен только живому герою с хитами', 'REST_ACTOR_INCAPACITATED')
    }
    const activeRest = state.mechanics.resting[command.actor_id]
    if (command.command_type === 'StartRest' && activeRest) {
      throw new RulesValidationError('Герой уже отдыхает', 'REST_ALREADY_STARTED')
    }
    if (command.command_type === 'CompleteRest' && !activeRest) {
      throw new RulesValidationError('Сначала нужно начать отдых', 'REST_NOT_STARTED')
    }
    if (command.command_type === 'CompleteRest' && activeRest?.kind !== kind) {
      throw new RulesValidationError('Тип завершённого отдыха не совпадает с начатым', 'REST_KIND_MISMATCH')
    }
  }

  if (command.command_type === 'StartCombat' && state.mechanics.combat.active) {
    throw new RulesValidationError('Бой уже начат', 'COMBAT_ALREADY_ACTIVE')
  }
  if (command.command_type === 'EndCombat') {
    const memberIds = new Set(state.partyMemberIds?.length ? state.partyMemberIds.map(String) : state.players.map(actorId))
    const pending = state.players.some((hero) => memberIds.has(actorId(hero)) && isUnstableDyingHero(state, actorId(hero)))
    if (pending) throw new RulesValidationError('Нельзя завершить бой, пока герой делает спасброски от смерти', 'DEATH_SAVES_PENDING')
  }
  if (command.command_type === 'ApplyHealing' && isDeadHero(state, targetFor(command))) {
    throw new RulesValidationError('Обычное лечение не возвращает погибшего героя к жизни', 'HERO_DEAD_UNRESOLVED')
  }
  if (command.command_type === 'ReduceHitPointMaximum' && !context.isAdmin && !context.serverAuthoritativeCombat) {
    throw new RulesValidationError('Уменьшать максимум ОЗ может только доверенный серверный эффект', 'MAX_HP_REDUCTION_FORBIDDEN')
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
    if (!isLivingActor(target) && !isDyingHero(state, targetFor(command))) throw new RulesValidationError('Цель уже побеждена', 'TARGET_DEFEATED')
    if (command.item_id && !itemAttackProfile(state, actor, command.item_id)) throw new RulesValidationError('Выбранное оружие недоступно', 'INVALID_WEAPON')
    const attackProfile = command.item_id ? itemAttackProfile(state, actor, command.item_id) : trustedAttackProfile(state, actor, command.action_id)
    if (command.knock_out === true && attackProfile?.kind !== 'melee') {
      throw new RulesValidationError('Нокаутировать можно только ближней атакой', 'KNOCKOUT_REQUIRES_MELEE_ATTACK')
    }
    if (command.action_id && isEnemyActor(state, command.actor_id)) {
      const monsterAction = monsterActionFor(actor, command.action_id)
      if (!monsterAction) throw new RulesValidationError('Выбранное действие отсутствует в блоке статистики существа', 'MONSTER_ACTION_NOT_AVAILABLE')
      if (safeInteger(monsterAction.uses, 0) > 0 && conditionIdsFor(state, command.actor_id).has(`monster-action-used:${monsterAction.id}`)) {
        throw new RulesValidationError('Ограниченное действие существа уже использовано', 'MONSTER_ACTION_SPENT')
      }
    }
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
    if (command.knock_out === true && !(spell.kind === 'attack' && spell.attackKind === 'melee')) {
      throw new RulesValidationError('Нокаутировать можно только ближней атакой заклинанием', 'KNOCKOUT_REQUIRES_MELEE_ATTACK')
    }
    if (Array.isArray(spell.spellOptions) && spell.spellOptions.length && !spell.spellOptions.includes(String(command.spell_option ?? ''))) {
      if (isEnemyActor(state, command.actor_id) && command.spell_option == null) command.spell_option = spell.spellOptions[0]
      else throw new RulesValidationError('Для этого заклинания нужно выбрать вариант эффекта', 'SPELL_OPTION_REQUIRED')
    }
    if (spell.actionType === 'long_cast') throw new RulesValidationError('Это заклинание требует больше одного хода и недоступно на боевой панели', 'SPELL_CAST_TIME_TOO_LONG')
    const metamagic = conditionIdsFor(state, command.actor_id)
    const maximumSpellRange = metamagic.has('metamagic-distant') && spell.range > 0 ? spell.range * 2 : spell.range
    const from = actorPosition(state, command.actor_id)
    if (!from) throw new RulesValidationError('Заклинатель должен находиться на карте', 'MAP_POSITION_REQUIRED')
    if (spell.target === 'point') {
      const to = { x: Number(command.to?.x), y: Number(command.to?.y) }
      if (!Number.isSafeInteger(to.x) || !Number.isSafeInteger(to.y)) throw new RulesValidationError('Нужно выбрать клетку для заклинания', 'INVALID_DESTINATION')
      const cell = tacticalCellMap(state).get(positionKey(to))
      const needsEmptyCell = ['summon', 'teleport'].includes(spell.kind)
      if (!isWalkableCell(cell) || (needsEmptyCell && occupiedPositions(state).has(positionKey(to)))) throw new RulesValidationError('Выбранная клетка недоступна', 'INVALID_DESTINATION')
      const distance = Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) * 5
      if (distance > maximumSpellRange) throw new RulesValidationError('Клетка находится вне дальности заклинания', 'TARGET_OUT_OF_RANGE')
      assertClearTrajectory(state, from, to)
    } else if (spell.target !== 'self') {
      const requestedIds = command.target_ids?.length ? uniqueStrings(command.target_ids) : [targetFor(command)]
      const requestedSlotLevel = Math.max(spell.level, safeInteger(command.slot_level ?? command.slotLevel, spell.level))
      const maximumTargets = Math.max(1, safeInteger(spell.maxTargets, 1) + Math.max(0, requestedSlotLevel - Math.max(1, spell.level)) * Math.max(0, safeInteger(spell.upcastTargetsPerLevel, 0)))
      if (requestedIds.length > maximumTargets) throw new RulesValidationError('Слишком много целей для этого уровня ячейки', 'TOO_MANY_SPELL_TARGETS')
      for (const requestedId of requestedIds) {
        const target = findActor(state, requestedId)
        const canAffectDyingHero = Boolean(target && isDyingHero(state, requestedId) && ['healing', 'buff'].includes(spell.kind))
        if (!target || (!isLivingActor(target) && !canAffectDyingHero)) throw new RulesValidationError('Нужна допустимая цель заклинания', 'INVALID_SPELL_TARGET')
        const targetIsHostile = isEnemyActor(state, actorId(target)) !== isEnemyActor(state, command.actor_id)
        if (spell.target === 'enemy' && !targetIsHostile) throw new RulesValidationError('Это заклинание требует противника', 'INVALID_SPELL_TARGET')
        if (spell.target === 'ally' && targetIsHostile) throw new RulesValidationError('Это заклинание требует союзника', 'INVALID_SPELL_TARGET')
        const to = actorPosition(state, actorId(target))
        if (!to) throw new RulesValidationError('Цель должна находиться на карте', 'MAP_POSITION_REQUIRED')
        const distance = Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) * 5
        if (distance > maximumSpellRange) throw new RulesValidationError('Цель находится вне дальности заклинания', 'TARGET_OUT_OF_RANGE')
        if (distance > 5) assertClearTrajectory(state, from, to)
      }
    }
    if (spell.slotResource) {
      const slot = chooseSpellSlot(state, command.actor_id, spell, command.slot_level ?? command.slotLevel)
      if (!slot) throw new RulesValidationError('Нет доступной ячейки подходящего уровня', 'INSUFFICIENT_RESOURCE')
      command.spell_slot_resource = slot.resource
      command.slot_level = slot.level
    }
  }
  if (command.command_type === 'UseCombatAction' && (command.server_authoritative || context.serverAuthoritativeCombat)) {
    const actor = findActor(state, command.actor_id)
    const reactionWindow = context.indomitableResume === true && command.reaction_window
      ? command.reaction_window
      : state.mechanics.combat.reaction_window
    if (command.action_id === 'decline-reaction') {
      if (!reactionWindow || String(reactionWindow.actor_id) !== command.actor_id) throw new RulesValidationError('Нет ожидающей реакции', 'REACTION_NOT_AVAILABLE')
      command.reaction_window = reactionWindow
      return command
    }
    const reactionSpellId = String(command.action_id).startsWith('cast:') ? String(command.action_id).slice(5) : ''
    const reactionSpell = reactionSpellId ? combatSpellFor(actor, reactionSpellId) : null
    const reactionOption = reactionWindow?.action_options?.find((candidate) => candidate.id === command.action_id)
    const action = command.action_id === 'indomitable' ? {
      id: 'indomitable', name: 'Несгибаемый', category: 'class', target: 'self', actionType: 'free', range: 0,
      resource: 'indomitable', cost: 1, description: 'Перебросить проваленный спасбросок с бонусом, равным уровню воина.',
    } : command.action_id === 'opportunity-attack' ? {
      id: 'opportunity-attack', name: 'Атака по возможности', category: 'common', target: 'self', actionType: 'reaction', range: 5,
      description: 'Атаковать оружием противника, покидающего вашу досягаемость.',
    } : reactionSpell && reactionSpell.actionType === 'reaction' ? {
      id: `cast:${reactionSpell.id}`,
      name: reactionSpell.name,
      category: 'spell',
      target: ['hellish-rebuke', 'counterspell', 'silvery-barbs'].includes(reactionSpell.id) ? 'enemy' : 'self',
      actionType: 'reaction',
      range: reactionSpell.range,
      resource: reactionOption?.resource ?? reactionSpell.slotResource,
      cost: 1,
      spell: { ...reactionSpell, reactionSlotLevel: reactionOption?.slot_level ?? reactionSpell.level },
    } : combatActionFor(actor, command.action_id)
    if (!action) throw new RulesValidationError('Это действие недоступно активному герою', 'COMBAT_ACTION_NOT_AVAILABLE')
    if (!state.mechanics.combat.active && action.id !== 'indomitable') throw new RulesValidationError('Сначала нужно начать бой и определить инициативу', 'COMBAT_NOT_ACTIVE')
    if (!isLivingActor(actor) && !(action.id === 'indomitable' && actor && state.mechanics.death.saving_throws[command.actor_id])) throw new RulesValidationError('Побеждённый участник не может действовать', 'ACTOR_DEFEATED')
    if (action.id === 'indomitable') {
      if (!reactionWindow || reactionWindow.trigger !== 'failed-saving-throw' || String(reactionWindow.actor_id) !== command.actor_id || !(reactionWindow.action_ids ?? []).includes('indomitable')) throw new RulesValidationError('Сейчас нет проваленного спасброска для Indomitable', 'INDOMITABLE_NOT_AVAILABLE')
      command.reaction_window = reactionWindow
    } else if (action.actionType === 'reaction') {
      if (!reactionWindow || String(reactionWindow.actor_id) !== command.actor_id || !(reactionWindow.action_ids ?? []).includes(action.id)) throw new RulesValidationError('У этой реакции сейчас нет подходящего триггера', 'REACTION_NOT_AVAILABLE')
      command.reaction_window = reactionWindow
      if (action.target === 'enemy') command.target_id = String(reactionWindow.source_actor_id)
    }
    command.combat_action = action
    if (action.spell?.id === 'silvery-barbs') {
      const beneficiaryId = String(command.beneficiary_id ?? command.beneficiaryId ?? command.actor_id)
      const beneficiary = findActor(state, beneficiaryId)
      if (!beneficiary || !isLivingActor(beneficiary) || isEnemyActor(state, beneficiaryId) !== isEnemyActor(state, command.actor_id)) throw new RulesValidationError('Искусная острота требует живого союзника для преимущества', 'INVALID_REACTION_BENEFICIARY')
      const distance = distanceBetweenActors(state, command.actor_id, beneficiaryId)
      if (distance == null || distance > 60) throw new RulesValidationError('Союзник находится вне дистанции Искусной остроты', 'TARGET_OUT_OF_RANGE')
      command.beneficiary_id = beneficiaryId
    }
    if (action.resource) {
      const pool = resourcePool(state, command.actor_id, action.resource)
      if (pool.current < Math.max(1, safeInteger(action.cost, 1))) throw new RulesValidationError('Недостаточно классового ресурса', 'INSUFFICIENT_RESOURCE')
    }
    if (action.target !== 'self') {
      const target = findActor(state, targetFor(command))
      const canTargetDyingHero = Boolean(target && isDyingHero(state, actorId(target)) && (action.id === 'stabilize' || action.effect?.kind === 'heal'))
      if (!target || (!isLivingActor(target) && !canTargetDyingHero) || actorId(target) === command.actor_id) throw new RulesValidationError('Нужна другая допустимая цель действия', 'INVALID_COMBAT_ACTION_TARGET')
      const targetIsHostile = isEnemyActor(state, actorId(target)) !== isEnemyActor(state, command.actor_id)
      if (action.target === 'enemy' && !targetIsHostile) throw new RulesValidationError('Это действие требует противника', 'INVALID_COMBAT_ACTION_TARGET')
      if (action.target === 'ally' && targetIsHostile) throw new RulesValidationError('Это действие требует союзника', 'INVALID_COMBAT_ACTION_TARGET')
      const from = actorPosition(state, command.actor_id)
      const to = actorPosition(state, actorId(target))
      if (!from || !to) throw new RulesValidationError('Участники должны находиться на карте', 'MAP_POSITION_REQUIRED')
      const profile = action.requiresWeapon && command.item_id ? itemAttackProfile(state, actor, command.item_id) : action.requiresWeapon ? trustedAttackProfile(state, actor) : null
      const maximumRange = action.requiresWeapon ? Math.min(action.range, profile?.range_feet ?? 5) : action.range
      const distance = Math.max(Math.abs(from.x - to.x), Math.abs(from.y - to.y)) * 5
      if (distance < 5 || distance > maximumRange) throw new RulesValidationError('Цель находится вне дальности действия', 'TARGET_OUT_OF_RANGE')
      if (distance > 5) assertClearTrajectory(state, from, to)
    }
  }
  if (command.command_type === 'MoveActor') {
    const x = Number(command.to?.x)
    const y = Number(command.to?.y)
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) throw new RulesValidationError('Нужны целые координаты назначения', 'INVALID_DESTINATION')
    if (!isLivingActor(findActor(state, command.actor_id))) throw new RulesValidationError('Побеждённый участник не может двигаться', 'ACTOR_DEFEATED')
  }

  if (command.command_type === 'MoveActor' && conditionIdsFor(state, command.actor_id).has('restrained')) {
    throw new RulesValidationError('Опутанное существо не может перемещаться', 'ACTOR_RESTRAINED')
  }

  if (!command.source_rule_ids.length && !command.house_rule_id && !command.ruling_id && !['DeclareAction', 'RevealArea', 'UpdateObjective', 'SpawnEntity', 'GrantItem', 'RecordRuling', 'AdvanceScene', 'CreateEncounter', ...WORLD_MEMORY_COMMAND_TYPES, ...NPC_SOCIAL_COMMAND_TYPES].includes(command.command_type)) {
    throw new RulesValidationError('Для механического решения нужен rule_id, house_rule_id или ruling_id', 'PROVENANCE_REQUIRED')
  }
  if (['ApplyDamage', 'ApplyHealing', 'ReduceHitPointMaximum', 'GrantTemporaryHitPoints'].includes(command.command_type)) {
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
  const payloadRuleIds = [
    ...(payload?.resistance_cantrip_reduction || payload?.aura_of_life_source ? [RULE_IDS.resistance] : []),
    ...(payload?.aura_of_protection_source ? [RULE_IDS.auraOfProtection] : []),
    ...(payload?.indomitable_bonus ? [RULE_IDS.indomitable] : []),
  ]
  return {
    campaign_id: command.campaign_id ?? null,
    command_id: command.command_id,
    event_type: eventType,
    actor_id: command.actor_id,
    target_ids: uniqueStrings(targets),
    payload: clone(payload),
    source_rule_ids: [...new Set([...command.source_rule_ids, ...payloadRuleIds])],
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

function effectiveArmorClass(state, actor, id) {
  const conditions = conditionIdsFor(state, id)
  const listedArmor = Math.max(0, safeInteger(actor?.armor ?? actor?.armorClass, 10))
  const mageArmor = conditions.has('mage-armor') ? 13 + abilityModifier(actor?.abilities?.dex) : 0
  return Math.max(listedArmor, mageArmor)
    + (conditions.has('shielded') ? 5 : 0)
    + (conditions.has('shield-of-faith') ? 2 : 0)
}

function spellHpPoolExpression(baseExpression, upcastExpression, spellLevel, slotLevel) {
  const base = parseDiceExpression(String(baseExpression))
  const upcast = parseDiceExpression(String(upcastExpression))
  const levels = Math.max(0, safeInteger(slotLevel, spellLevel) - Math.max(1, safeInteger(spellLevel, 1)))
  if (base.sides !== upcast.sides) return String(baseExpression)
  const count = Math.min(100, base.count + upcast.count * levels)
  const modifier = base.modifier + upcast.modifier * levels
  return `${count}d${base.sides}${modifier > 0 ? `+${modifier}` : modifier < 0 ? modifier : ''}`
}

function immuneToMagicalSleep(state, actor) {
  const id = actorId(actor)
  const creatureType = String(actor?.creature_type ?? actor?.creatureType ?? actor?.type ?? '').toLowerCase()
  const immunities = uniqueStrings(actor?.condition_immunities ?? actor?.conditionImmunities).map((value) => value.toLowerCase())
  const conditions = conditionIdsFor(state, id)
  return creatureType === 'undead'
    || creatureType.includes('нежить')
    || immunities.some((value) => ['charmed', 'charm', 'очарование', 'очарованный'].includes(value))
    || conditions.has('charm-immune')
    || conditions.has('immune:charmed')
}

function defenseFor(state, id) {
  const defense = state.mechanics.defenses[id] ?? {}
  return {
    resistances: uniqueStrings(defense.resistances),
    vulnerabilities: uniqueStrings(defense.vulnerabilities),
    immunities: uniqueStrings(defense.immunities),
  }
}

function damagePayload(state, targetId, rawAmount, damageType = 'untyped', resistanceCantrip = null) {
  const actor = findActor(state, targetId)
  if (!actor) throw new RulesValidationError('Цель урона не найдена', 'TARGET_NOT_FOUND')
  const raw = Math.max(0, Math.floor(Number(rawAmount) || 0))
  const defenses = defenseFor(state, targetId)
  const immune = defenses.immunities.includes(damageType)
  const ragingResistance = conditionIdsFor(state, targetId).has('raging') && ['bludgeoning', 'piercing', 'slashing'].includes(damageType)
  const uncannyResistance = conditionIdsFor(state, targetId).has('uncanny-dodge')
  const absorbingResistance = conditionIdsFor(state, targetId).has(`absorbing-element:${damageType}`)
  const bladeWardResistance = conditionIdsFor(state, targetId).has('blade-ward') && ['bludgeoning', 'piercing', 'slashing'].includes(damageType)
  const auraOfLife = damageType === 'necrotic' ? activeAuraOfLifeSource(state, targetId) : null
  const resistant = defenses.resistances.includes(damageType) || ragingResistance || uncannyResistance || absorbingResistance || bladeWardResistance || Boolean(auraOfLife)
  const vulnerable = defenses.vulnerabilities.includes(damageType)
  let afterDefense = immune ? 0 : raw
  if (!immune && resistant && !vulnerable) afterDefense = Math.floor(afterDefense / 2)
  if (!immune && vulnerable && !resistant) afterDefense *= 2
  const resistanceCantripReduction = Math.min(afterDefense, Math.max(0, safeInteger(resistanceCantrip?.reduction, 0)))
  afterDefense -= resistanceCantripReduction
  const temporaryBefore = Math.max(0, safeInteger(state.mechanics.temporary_hp[targetId], 0))
  const absorbed = Math.min(temporaryBefore, afterDefense)
  const applied = afterDefense - absorbed
  const hpBefore = actorHp(actor)
  const deathWardTriggered = hpBefore > 0 && applied >= hpBefore && conditionIdsFor(state, targetId).has('death-ward')
  const hpAfter = deathWardTriggered ? 1 : Math.max(0, hpBefore - applied)
  return {
    damage_type: damageType,
    raw_amount: raw,
    applied_amount: applied,
    immune,
    resistant,
    vulnerable,
    ...(auraOfLife ? { aura_of_life_source: auraOfLife.source_id } : {}),
    ...(resistanceCantripReduction > 0 ? {
      resistance_cantrip_reduction: resistanceCantripReduction,
      resistance_cantrip_condition: String(resistanceCantrip.condition_id),
      resistance_cantrip_turn: String(resistanceCantrip.turn_key),
      resistance_cantrip_roll_id: resistanceCantrip.roll_id ?? null,
    } : {}),
    temporary_hp_before: temporaryBefore,
    temporary_hp_after: temporaryBefore - absorbed,
    temporary_hp_absorbed: absorbed,
    hp_before: hpBefore,
    hp_after: hpAfter,
    ...(deathWardTriggered ? { death_ward_triggered: true } : {}),
  }
}

function deathSavingThrowAtTurnStart(state, command, actorIdValue, diceService) {
  if (!isUnstableDyingHero(state, actorIdValue)) return { events: [], rolls: [] }
  const actor = playerActor(state, actorIdValue)
  const tracker = deathSaveTracker(state, actorIdValue)
  const conditionIds = conditionIdsFor(state, actorIdValue)
  const modifierRolls = []
  const modifierEvents = []
  const auraProtection = savingThrowModifierWithAura(state, actorIdValue, 0)
  let modifier = auraProtection.modifier
  if (conditionIds.has('bless-d4')) {
    const blessing = diceService.roll('1d4', 'spell:bless:death-saving-throw', actorIdValue, command.visibility ?? 'public')
    modifierRolls.push(blessing)
    modifierEvents.push(eventFrom(command, 'DieRolled', { ...blessing, modifier_source: 'bless' }, []))
    modifier += blessing.total
  }
  if (conditionIds.has('bane-d4')) {
    const bane = diceService.roll('1d4', 'spell:bane:death-saving-throw', actorIdValue, command.visibility ?? 'public')
    modifierRolls.push(bane)
    modifierEvents.push(eventFrom(command, 'DieRolled', { ...bane, modifier_source: 'bane' }, []))
    modifier -= bane.total
  }
  const advantage = conditionIds.has('beacon-of-hope')
  const roll = diceService.rollD20({ modifier, purpose: 'death_saving_throw', actorId: actorIdValue, advantage, visibility: command.visibility ?? 'public' })
  const natural = safeInteger(roll.kept, 0)
  if (natural === 20) {
    return {
      rolls: [...modifierRolls, roll],
      events: [
        ...modifierEvents,
        eventFrom(commandWithRules({ ...command, actor_id: actorIdValue }, RULE_IDS.zeroHp, RULE_IDS.savingThrow), 'DeathSavingThrowRolled', {
          ...roll,
          ...auraOfProtectionPayload(auraProtection.aura),
          natural_roll: natural,
          advantage,
          modifier_sources: [...(auraProtection.aura ? ['aura-of-protection'] : []), ...(conditionIds.has('bless-d4') ? ['bless'] : []), ...(conditionIds.has('bane-d4') ? ['bane'] : [])],
          success: true,
          successes_before: tracker.successes,
          successes_after: 0,
          failures_before: tracker.failures,
          failures_after: 0,
          result: 'revived',
        }, [actorIdValue]),
        eventFrom(commandWithRules({ ...command, actor_id: actorIdValue }, RULE_IDS.healing, RULE_IDS.zeroHp), 'HealingApplied', {
          requested_amount: 1,
          applied_amount: 1,
          hp_before: 0,
          hp_after: Math.min(1, actorMaxHp(actor)),
          reason: 'natural-20-death-save',
        }, [actorIdValue]),
      ],
    }
  }

  const success = natural !== 1 && roll.total >= 10
  const successesAfter = Math.min(3, tracker.successes + (success ? 1 : 0))
  const failuresAfter = Math.min(3, tracker.failures + (success ? 0 : natural === 1 ? 2 : 1))
  const result = successesAfter >= 3 ? 'stabilized' : failuresAfter >= 3 ? 'died' : success ? 'success' : 'failure'
  const events = [...modifierEvents, eventFrom(commandWithRules({ ...command, actor_id: actorIdValue }, RULE_IDS.zeroHp, RULE_IDS.savingThrow), 'DeathSavingThrowRolled', {
    ...roll,
    ...auraOfProtectionPayload(auraProtection.aura),
    natural_roll: natural,
    advantage,
    modifier_sources: [...(auraProtection.aura ? ['aura-of-protection'] : []), ...(conditionIds.has('bless-d4') ? ['bless'] : []), ...(conditionIds.has('bane-d4') ? ['bane'] : [])],
    success,
    successes_before: tracker.successes,
    successes_after: Math.min(2, successesAfter),
    failures_before: tracker.failures,
    failures_after: Math.min(2, failuresAfter),
    failure_increment: success ? 0 : natural === 1 ? 2 : 1,
    result,
  }, [actorIdValue])]
  if (successesAfter >= 3) {
    events.push(eventFrom(commandWithRules({ ...command, actor_id: actorIdValue }, RULE_IDS.zeroHp), 'HeroStabilized', {
      hero_name: String(actor?.character ?? actor?.name ?? actorIdValue),
      method: 'three-death-save-successes',
    }, [actorIdValue]))
  } else if (failuresAfter >= 3) {
    events.push(eventFrom(commandWithRules({ ...command, actor_id: actorIdValue }, RULE_IDS.zeroHp), 'HeroDied', {
      hero_name: String(actor?.character ?? actor?.name ?? actorIdValue),
      reason: 'three-death-save-failures',
    }, [actorIdValue]))
  }
  return { events, rolls: [...modifierRolls, roll] }
}

function zeroHitPointDamageConsequences(state, command, targetIdValue, payload, { critical = false } = {}) {
  if (safeInteger(payload?.applied_amount, 0) <= 0 || safeInteger(payload?.hp_after, -1) !== 0) return []
  const target = findActor(state, targetIdValue)
  if (!playerActor(state, targetIdValue)) {
    return [eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HitPointsReducedToZero', { condition: 'unconscious' }, [targetIdValue])]
  }
  if (isDeadHero(state, targetIdValue)) return []
  const hpBefore = Math.max(0, safeInteger(payload.hp_before, actorHp(target)))
  const applied = Math.max(0, safeInteger(payload.applied_amount, 0))
  const instantDeath = hpBefore > 0
    ? applied - hpBefore >= actorMaxHp(target)
    : applied >= actorMaxHp(target)
  if (instantDeath) {
    return [eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HeroDied', {
      hero_name: String(target?.character ?? target?.name ?? targetIdValue),
      reason: 'massive-damage',
      damage: applied,
      hp_before: hpBefore,
    }, [targetIdValue])]
  }
  if (hpBefore > 0) {
    return [eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HitPointsReducedToZero', {
      condition: 'unconscious',
      successes: 0,
      failures: 0,
    }, [targetIdValue])]
  }

  const tracker = deathSaveTracker(state, targetIdValue)
  const increment = critical ? 2 : 1
  const failuresAfter = Math.min(3, tracker.failures + increment)
  const events = [eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'DeathSaveFailureRecorded', {
    successes_before: tracker.successes,
    successes_after: tracker.successes,
    failures_before: tracker.failures,
    failures_after: Math.min(2, failuresAfter),
    failure_increment: increment,
    stable_before: tracker.stable,
    stable_after: false,
    critical,
    reason: 'damage-at-zero-hit-points',
  }, [targetIdValue])]
  if (failuresAfter >= 3) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HeroDied', {
    hero_name: String(target?.character ?? target?.name ?? targetIdValue),
    reason: 'three-death-save-failures',
  }, [targetIdValue]))
  return events
}

function resourcePool(state, actorIdValue, resourceName, providedMax = 0) {
  const pool = state.mechanics.resources[actorIdValue]?.[resourceName]
  const maximum = Math.max(0, safeInteger(pool?.max, providedMax))
  return { current: Math.max(0, safeInteger(pool?.current, maximum)), max: maximum }
}

function actionEconomy() {
  return { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0, movement_bonus: 0, extra_actions: 0, surged_action_only: false }
}

function reactionOptionsAfterAttack(state, target, {
  hit = false,
  attackTotal = 0,
  armorClass = 10,
  damage = null,
  distanceFeet = null,
  allowParry = false,
  allowRiposte = false,
} = {}) {
  const targetId = actorId(target)
  const allowedActionIds = hit && damage?.applied_amount + safeInteger(damage?.temporary_hp_absorbed, 0) > 0
    ? ['uncanny-dodge', ...(allowParry ? ['parry'] : [])]
    : !hit && allowRiposte ? ['riposte'] : []
  const options = combatActionsFor(target)
    .filter((candidate) => candidate.actionType === 'reaction' && allowedActionIds.includes(candidate.id))
    .filter((candidate) => !candidate.resource || resourcePool(state, targetId, candidate.resource).current >= Math.max(1, safeInteger(candidate.cost, 1)))
    .map((candidate) => ({ id: candidate.id, name: candidate.name, description: candidate.description, resource: candidate.resource ?? null, cost: candidate.cost ?? 1 }))
  const elementalTypes = new Set(['acid', 'cold', 'fire', 'lightning', 'thunder'])
  for (const spell of combatSpellsFor(target)) {
    if (spell.actionType !== 'reaction' || spell.prepared === false) continue
    const slot = chooseSpellSlot(state, targetId, spell)
    if (spell.level > 0 && !slot) continue
    const damageTaken = safeInteger(damage?.applied_amount, 0) + safeInteger(damage?.temporary_hp_absorbed, 0)
    const available = spell.id === 'shield' && hit && attackTotal < armorClass + 5
      || spell.id === 'absorb-elements' && hit && damageTaken > 0 && elementalTypes.has(damage?.damage_type)
      || spell.id === 'hellish-rebuke' && hit && damageTaken > 0 && (distanceFeet == null || distanceFeet <= 60)
    if (available) options.push({ id: `cast:${spell.id}`, name: spell.name, description: spell.description, resource: slot?.resource ?? null, slot_level: slot?.level ?? spell.level, cost: 1, spell_id: spell.id })
  }
  return options
}

function counterspellReactionFor(state, casterId) {
  if (!isEnemyActor(state, casterId)) return null
  const initiativeOrder = new Map((state.mechanics.combat.initiative ?? []).map((entry, index) => [String(entry.actor_id), index]))
  return [...state.players, ...(state.actors ?? []).filter((candidate) => isPartySummon(candidate))]
    .filter((candidate) => isLivingActor(candidate) && state.mechanics.combat.action_economy[actorId(candidate)]?.reaction !== false)
    .map((candidate) => {
      const spell = combatSpellsFor(candidate).find((entry) => entry.id === 'counterspell' && entry.prepared !== false)
      const slot = spell ? chooseSpellSlot(state, actorId(candidate), spell) : null
      const distance = distanceBetweenActors(state, actorId(candidate), casterId)
      const from = actorPosition(state, actorId(candidate))
      const to = actorPosition(state, casterId)
      if (!spell || !slot || distance == null || distance > spell.range || !from || !to || !hasClearTrajectory(state, from, to)) return null
      return { actor: candidate, spell, slot }
    })
    .filter(Boolean)
    .sort((left, right) => (initiativeOrder.get(actorId(left.actor)) ?? Number.MAX_SAFE_INTEGER) - (initiativeOrder.get(actorId(right.actor)) ?? Number.MAX_SAFE_INTEGER)
      || actorId(left.actor).localeCompare(actorId(right.actor)))[0] ?? null
}

function silveryBarbsReactionFor(state, sourceActorId, preferredActorId = null) {
  const initiativeOrder = new Map((state.mechanics.combat.initiative ?? []).map((entry, index) => [String(entry.actor_id), index]))
  return [...state.players, ...(state.actors ?? []).filter((candidate) => isPartySummon(candidate))]
    .filter((candidate) => isLivingActor(candidate) && state.mechanics.combat.action_economy[actorId(candidate)]?.reaction !== false)
    .map((candidate) => {
      const spell = combatSpellsFor(candidate).find((entry) => entry.id === 'silvery-barbs' && entry.prepared !== false)
      const slot = spell ? chooseSpellSlot(state, actorId(candidate), spell) : null
      const distance = distanceBetweenActors(state, actorId(candidate), sourceActorId)
      const from = actorPosition(state, actorId(candidate))
      const to = actorPosition(state, sourceActorId)
      if (!spell || !slot || distance == null || distance > 60 || !from || !to || !hasClearTrajectory(state, from, to)) return null
      return { actor: candidate, spell, slot }
    })
    .filter(Boolean)
    .sort((left, right) => Number(actorId(right.actor) === preferredActorId) - Number(actorId(left.actor) === preferredActorId)
      || (initiativeOrder.get(actorId(left.actor)) ?? Number.MAX_SAFE_INTEGER) - (initiativeOrder.get(actorId(right.actor)) ?? Number.MAX_SAFE_INTEGER)
      || actorId(left.actor).localeCompare(actorId(right.actor)))[0] ?? null
}

function reducedReactionDamage(damage, preventedAmount) {
  const temporaryBefore = Math.max(0, safeInteger(damage?.temporary_hp_before, 0))
  const hpBefore = Math.max(0, safeInteger(damage?.hp_before, 0))
  const originalDamage = Math.max(0, safeInteger(damage?.temporary_hp_absorbed, 0) + safeInteger(damage?.applied_amount, 0))
  const prevented = Math.min(originalDamage, Math.max(0, safeInteger(preventedAmount, 0)))
  const reducedDamage = originalDamage - prevented
  const temporaryAfter = Math.max(0, temporaryBefore - reducedDamage)
  const hpAfter = Math.max(0, hpBefore - Math.max(0, reducedDamage - temporaryBefore))
  return {
    prevented_amount: prevented,
    hp_before: Math.max(0, safeInteger(damage?.hp_after, hpAfter)),
    hp_after: hpAfter,
    temporary_hp_before: Math.max(0, safeInteger(damage?.temporary_hp_after, temporaryAfter)),
    temporary_hp_after: temporaryAfter,
  }
}

function chooseSpellSlot(state, actorIdValue, spell, requestedLevel) {
  if (!spell || spell.level === 0 || !spell.slotResource) return null
  if (spell.slotResource === 'pact_slots' || spell.slotResource === 'mystic_arcanum_6') {
    const pool = resourcePool(state, actorIdValue, spell.slotResource)
    return pool.current > 0 ? { resource: spell.slotResource, level: spell.slotResource === 'mystic_arcanum_6' ? 6 : Math.max(1, safeInteger(requestedLevel, spell.level)), pool } : null
  }
  const requested = Number(requestedLevel)
  const levels = Number.isSafeInteger(requested) && requested >= spell.level && requested <= 6
    ? [requested]
    : Array.from({ length: 7 - spell.level }, (_, index) => spell.level + index)
  for (const level of levels) {
    const resource = `spell_slots_${level}`
    const pool = resourcePool(state, actorIdValue, resource)
    if (pool.current > 0) return { resource, level, pool }
  }
  return null
}

function scaledSpellDice(spell, actor, slotLevel) {
  if (!spell?.damage) return null
  let parsed
  try { parsed = parseDiceExpression(spell.damage) }
  catch { return spell.damage }
  let count = parsed.count
  if (spell.level === 0) {
    const level = Math.max(1, safeInteger(actor?.level, 1))
    count += level >= 5 ? 1 : 0
    count += level >= 11 ? 1 : 0
  } else if (spell.upcastDicePerLevel && safeInteger(slotLevel, spell.level) > spell.level) {
    count += safeInteger(spell.upcastDicePerLevel, 0) * (safeInteger(slotLevel, spell.level) - spell.level)
  }
  return `${count}d${parsed.sides}${parsed.modifier > 0 ? `+${parsed.modifier}` : parsed.modifier < 0 ? parsed.modifier : ''}`
}

function scaledDiceExpression(expression, extraLevels = 0, dicePerLevel = 0, maximumDice = 100) {
  let parsed
  try { parsed = parseDiceExpression(String(expression)) }
  catch { return String(expression) }
  const count = Math.min(Math.max(1, safeInteger(maximumDice, 100)), parsed.count + Math.max(0, safeInteger(extraLevels, 0)) * Math.max(0, safeInteger(dicePerLevel, 0)))
  return `${count}d${parsed.sides}${parsed.modifier > 0 ? `+${parsed.modifier}` : parsed.modifier < 0 ? parsed.modifier : ''}`
}

function isLargeOrLarger(actor) {
  const size = String(actor?.size ?? actor?.creature_size ?? actor?.creatureSize ?? '').toLocaleLowerCase('ru')
  return ['large', 'huge', 'gargantuan', 'большой', 'огромный', 'громадный'].some((value) => size.includes(value))
}

function positionInArea(position, center, radiusFeet, shape = 'sphere') {
  if (!position || !center) return false
  const dx = Number(position.x) - Number(center.x)
  const dy = Number(position.y) - Number(center.y)
  const distanceFeet = Math.max(Math.abs(dx), Math.abs(dy)) * 5
  if (shape === 'cube') return distanceFeet <= Math.max(0, Number(radiusFeet) || 0)
  return distanceFeet <= Math.max(0, Number(radiusFeet) || 0)
}

function positionInCone(position, origin, toward, rangeFeet) {
  if (!position || !origin || !toward) return false
  const directionX = Number(toward.x) - Number(origin.x)
  const directionY = Number(toward.y) - Number(origin.y)
  const targetX = Number(position.x) - Number(origin.x)
  const targetY = Number(position.y) - Number(origin.y)
  if ((!directionX && !directionY) || (!targetX && !targetY)) return false
  if (Math.max(Math.abs(targetX), Math.abs(targetY)) * 5 > Math.max(0, Number(rangeFeet) || 0)) return false
  const dot = directionX * targetX + directionY * targetY
  const cross = Math.abs(directionX * targetY - directionY * targetX)
  return dot > 0 && cross * 2 <= dot
}

function positionInDirectedCube(position, origin, toward, edgeFeet) {
  if (!position || !origin || !toward) return false
  const directionX = Number(toward.x) - Number(origin.x)
  const directionY = Number(toward.y) - Number(origin.y)
  if (!directionX && !directionY) return false
  const targetX = Number(position.x) - Number(origin.x)
  const targetY = Number(position.y) - Number(origin.y)
  const cells = Math.max(1, Math.floor(Math.max(0, Number(edgeFeet) || 0) / 5))
  const halfWidth = Math.floor((cells - 1) / 2)
  if (Math.abs(directionX) >= Math.abs(directionY)) {
    const forward = targetX * Math.sign(directionX)
    return forward >= 1 && forward <= cells && Math.abs(targetY) <= halfWidth
  }
  const forward = targetY * Math.sign(directionY)
  return forward >= 1 && forward <= cells && Math.abs(targetX) <= halfWidth
}

function activeAreaEffectsAt(state, position) {
  return (state.mechanics.active_effects ?? []).filter((effect) => positionInArea(position, effect.center, effect.radius_feet, effect.area_shape))
}

function spellTargetsAt(state, command, spell) {
  if (spell.target === 'self' && ['area-save', 'area-damage'].includes(spell.kind)) {
    const center = actorPosition(state, command.actor_id)
    const radius = Math.max(0, safeInteger(spell.radius, 5))
    if (!center) return []
    return listActors(state).filter((candidate) => {
      if (!isLivingActor(candidate) || actorId(candidate) === command.actor_id) return false
      const at = actorPosition(state, actorId(candidate))
      return at && Math.max(Math.abs(at.x - center.x), Math.abs(at.y - center.y)) * 5 <= radius
    })
  }
  if (spell.target === 'self') return [findActor(state, command.actor_id)].filter(Boolean)
  if (spell.target !== 'point') {
    const requestedIds = command.target_ids?.length ? command.target_ids : [targetFor(command)]
    const maximum = Math.max(1, safeInteger(spell.maxTargets, 1) + Math.max(0, safeInteger(command.slot_level, spell.level) - Math.max(1, safeInteger(spell.level, 1))) * Math.max(0, safeInteger(spell.upcastTargetsPerLevel, 0)))
    return uniqueStrings(requestedIds).slice(0, maximum).map((id) => findActor(state, id)).filter(Boolean)
  }
  const to = { x: Number(command.to?.x), y: Number(command.to?.y) }
  const radius = Math.max(0, Math.min(600, safeInteger(spell.radius, spell.kind?.startsWith('area-') ? 5 : 0)))
  if (radius <= 0) return []
  if (spell.areaShape === 'cone' && spell.areaOrigin === 'self') {
    const origin = actorPosition(state, command.actor_id)
    if (!origin) return []
    return listActors(state).filter((actor) => isLivingActor(actor) && actorId(actor) !== command.actor_id && positionInCone(actorPosition(state, actorId(actor)), origin, to, radius))
  }
  if (spell.areaShape === 'cube' && spell.areaOrigin === 'self') {
    const origin = actorPosition(state, command.actor_id)
    if (!origin) return []
    return listActors(state).filter((actor) => isLivingActor(actor) && actorId(actor) !== command.actor_id && positionInDirectedCube(actorPosition(state, actorId(actor)), origin, to, radius))
  }
  return listActors(state).filter((actor) => {
    if (!isLivingActor(actor)) return false
    const at = actorPosition(state, actorId(actor))
    return at && Math.max(Math.abs(at.x - to.x), Math.abs(at.y - to.y)) * 5 <= radius
  })
}

function conditionIdsFor(state, id) {
  return new Set((state.mechanics.conditions[String(id)] ?? []).map((condition) => String(condition?.id ?? condition)))
}

function activeAuraOfLifeSource(state, targetId) {
  const target = findActor(state, targetId)
  if (!target) return null
  const targetIsEnemy = isEnemyActor(state, targetId)
  for (const source of listActors(state)) {
    const sourceId = actorId(source)
    if (isEnemyActor(state, sourceId) !== targetIsEnemy || !isLivingActor(source)) continue
    const sourceConditions = state.mechanics.conditions[sourceId] ?? []
    const aura = sourceConditions.find((condition) => String(condition?.id ?? condition) === 'aura-of-life')
    if (!aura) continue
    const sourceConditionIds = conditionIdsFor(state, sourceId)
    if (sourceConditionIds.has('unconscious') || sourceConditionIds.has('incapacitated') || sourceConditionIds.has('dead')) continue
    const concentration = state.mechanics.concentration[sourceId]
    if (!concentration || String(concentration.effect_id ?? '') !== String(aura.effect_id ?? '')) continue
    const distance = sourceId === String(targetId) ? 0 : distanceBetweenActors(state, sourceId, targetId)
    if (distance != null && distance <= 30) return { source_id: sourceId, effect_id: aura.effect_id ?? null }
  }
  return null
}

function activeAuraOfProtection(state, targetId) {
  const target = findActor(state, targetId)
  if (!target) return null
  const targetIsEnemy = isEnemyActor(state, targetId)
  const candidates = []
  for (const source of listActors(state)) {
    const sourceId = actorId(source)
    if (characterClassKey(source) !== 'paladin' || safeInteger(source?.level, 1) < 6) continue
    if (isEnemyActor(state, sourceId) !== targetIsEnemy || !isLivingActor(source)) continue
    const sourceConditions = conditionIdsFor(state, sourceId)
    if (sourceConditions.has('unconscious') || sourceConditions.has('incapacitated') || sourceConditions.has('stunned') || sourceConditions.has('paralyzed') || sourceConditions.has('dead')) continue
    const distance = sourceId === String(targetId) ? 0 : distanceBetweenActors(state, sourceId, targetId)
    if (distance == null || distance > 10) continue
    candidates.push({
      source_id: sourceId,
      bonus: Math.max(1, abilityModifier(source?.abilities?.cha)),
      radius_feet: 10,
    })
  }
  return candidates.sort((left, right) => right.bonus - left.bonus || left.source_id.localeCompare(right.source_id))[0] ?? null
}

function savingThrowModifierWithAura(state, targetId, baseModifier) {
  const aura = activeAuraOfProtection(state, targetId)
  return {
    modifier: safeInteger(baseModifier, 0) + (aura?.bonus ?? 0),
    aura,
  }
}

function auraOfProtectionPayload(aura) {
  return aura ? {
    aura_of_protection_source: aura.source_id,
    aura_of_protection_bonus: aura.bonus,
    aura_of_protection_radius_feet: aura.radius_feet,
  } : {}
}

const CLASS_SAVING_THROW_PROFICIENCIES = Object.freeze({
  barbarian: ['str', 'con'], bard: ['dex', 'cha'], cleric: ['wis', 'cha'], druid: ['int', 'wis'],
  fighter: ['str', 'con'], monk: ['str', 'dex'], paladin: ['wis', 'cha'], ranger: ['str', 'dex'],
  rogue: ['dex', 'int'], sorcerer: ['con', 'cha'], warlock: ['wis', 'cha'], wizard: ['int', 'wis'],
})

function isSavingThrowProficient(actor, ability) {
  const normalizedAbility = String(ability ?? '').toLowerCase()
  const explicit = [actor?.savingThrowProficiencies, actor?.saving_throw_proficiencies, actor?.saveProficiencies]
    .find(Array.isArray)
  if (explicit) return explicit.map((entry) => String(entry).toLowerCase()).includes(normalizedAbility)
  return (CLASS_SAVING_THROW_PROFICIENCIES[characterClassKey(actor)] ?? []).includes(normalizedAbility)
}

function rollSavingThrowD20(state, diceService, targetId, options = {}) {
  const auraProtection = savingThrowModifierWithAura(state, targetId, options.modifier)
  return {
    ...diceService.rollD20({ ...options, modifier: auraProtection.modifier, actorId: targetId }),
    ...auraOfProtectionPayload(auraProtection.aura),
  }
}

function rollSavingThrowCheck(state, diceService, targetId, options = {}) {
  const auraProtection = savingThrowModifierWithAura(state, targetId, options.modifier)
  return {
    ...diceService.rollCheck({ ...options, modifier: auraProtection.modifier, actorId: targetId }),
    ...auraOfProtectionPayload(auraProtection.aura),
  }
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

function recordingDiceService(base, transcript) {
  const record = (method, args, result) => {
    transcript.push({ method, args: clone(args), result: clone(result) })
    return result
  }
  return {
    roll: (...args) => record('roll', args, base.roll(...args)),
    rollD20: (options) => record('rollD20', [options], base.rollD20(options)),
    rollCheck: (options) => record('rollCheck', [options], base.rollCheck(options)),
  }
}

function replayDiceService(base, transcript, replacements = null) {
  let index = 0
  const replacementMap = new Map((Array.isArray(replacements) ? replacements : replacements ? [replacements] : [])
    .map((replacement) => [String(replacement?.roll_id ?? ''), replacement]))
  const next = (method, options, invoke) => {
    const entry = transcript[index++]
    if (!entry || entry.method !== method) throw new RulesValidationError('Сохранённая последовательность бросков повреждена', 'INVALID_DICE_TRANSCRIPT')
    const original = clone(entry.result)
    const replacement = replacementMap.get(String(original.roll_id ?? ''))
    if (!replacement) return original
    if (!['rollD20', 'rollCheck'].includes(method)) throw new RulesValidationError('Indomitable может заменить только d20 спасброска', 'INVALID_INDOMITABLE_ROLL')
    const bonus = Math.max(1, safeInteger(replacement.bonus, 1))
    const rerolled = replacement.result ? clone(replacement.result) : invoke({ ...(options ?? {}), modifier: safeInteger(options?.modifier, 0) + bonus })
    return {
      ...rerolled,
      indomitable_bonus: bonus,
      indomitable_original_roll_id: original.roll_id,
      indomitable_original_total: safeInteger(original.total, 0),
    }
  }
  return {
    roll: (...args) => next('roll', null, () => base.roll(...args)),
    rollD20: (options) => next('rollD20', options, (nextOptions) => base.rollD20(nextOptions)),
    rollCheck: (options) => next('rollCheck', options, (nextOptions) => base.rollCheck(nextOptions)),
  }
}

function rollIndomitableReplacement(diceService, transcript, rollId, bonus) {
  const entry = transcript.find((candidate) => String(candidate?.result?.roll_id ?? '') === String(rollId ?? ''))
  if (!entry || !['rollD20', 'rollCheck'].includes(entry.method)) throw new RulesValidationError('Не найден исходный d20 спасброска', 'INVALID_INDOMITABLE_ROLL')
  const options = entry.args?.[0] && typeof entry.args[0] === 'object' ? entry.args[0] : {}
  const rerolled = diceService[entry.method]({ ...options, modifier: safeInteger(options.modifier, 0) + Math.max(1, safeInteger(bonus, 1)) })
  return {
    ...rerolled,
    indomitable_bonus: Math.max(1, safeInteger(bonus, 1)),
    indomitable_original_roll_id: entry.result.roll_id,
    indomitable_original_total: safeInteger(entry.result.total, 0),
  }
}

function failedSavingThrowEvent(event) {
  if (!event?.payload?.roll_id) return false
  if (event.event_type === 'SpellSavingThrowResolved' || event.event_type === 'ConcentrationSavingThrowResolved') return event.payload.saved === false
  if (event.event_type === 'SavingThrowResolved') return event.payload.success === false || event.payload.saved === false
  if (event.event_type === 'DeathSavingThrowRolled') return event.payload.success === false
  return false
}

function indomitableOpportunitiesFor(state, events, bypassActorIds = []) {
  const bypassed = new Set((Array.isArray(bypassActorIds) ? bypassActorIds : []).map(String))
  const queued = new Set()
  const opportunities = []
  for (const event of events) {
    if (!failedSavingThrowEvent(event)) continue
    const targetId = String(event.target_ids?.[0] ?? '')
    const actor = state.players.find((candidate) => actorId(candidate) === targetId)
    if (!actor || queued.has(targetId) || bypassed.has(targetId) || characterClassKey(actor) !== 'fighter' || safeInteger(actor.level, 1) < 9) continue
    const resource = resourcePool(state, targetId, 'indomitable', 1)
    if (resource.current < 1) continue
    queued.add(targetId)
    opportunities.push({ event, actor, target_id: targetId, resource })
  }
  return opportunities
}

export function resolveCommand(input, rawState, { diceService, context = {} } = {}) {
  if (!diceService) throw new TypeError('RulesEngine требует DiceService')
  const resolveDepth = Math.max(0, safeInteger(context.__resolve_depth, 0))
  context = { ...context, __resolve_depth: resolveDepth + 1 }
  const diceTranscript = []
  diceService = recordingDiceService(diceService, diceTranscript)
  const state = normalizeCampaignState(rawState)
  const command = validateCommand(input, state, context)
  const events = []
  const rolls = []
  const targetId = targetFor(command)
  const resistanceCantripUses = new Set()
  let nestedConsequencesResolved = false

  const damageTurnKey = (sourceState) => {
    const combat = sourceState.mechanics.combat
    if (!combat?.active) return `command:${command.command_id}`
    const activeActor = combat.initiative?.[safeInteger(combat.active_index, -1)]?.actor_id ?? command.actor_id
    return `combat:${safeInteger(combat.round, 1)}:${String(activeActor)}`
  }

  const resolveDamagePayload = (sourceState, resolvedTargetId, rawAmount, damageType, existingResistance = null) => {
    if (existingResistance?.reduction > 0) return damagePayload(sourceState, resolvedTargetId, rawAmount, damageType, existingResistance)
    const preliminary = damagePayload(sourceState, resolvedTargetId, rawAmount, damageType)
    if (preliminary.immune || preliminary.applied_amount + preliminary.temporary_hp_absorbed <= 0) return preliminary
    const turnKey = damageTurnKey(sourceState)
    const condition = (sourceState.mechanics.conditions[resolvedTargetId] ?? []).find((candidate) => {
      const id = String(candidate?.id ?? candidate)
      const key = `${resolvedTargetId}:${id}:${turnKey}`
      return id === `resistance-damage:${damageType}` && String(candidate?.last_used_turn ?? '') !== turnKey && !resistanceCantripUses.has(key)
    })
    if (!condition) return preliminary
    const conditionId = String(condition?.id ?? condition)
    const useKey = `${resolvedTargetId}:${conditionId}:${turnKey}`
    const reductionRoll = diceService.roll('1d4', `spell:resistance:damage:${damageType}`, resolvedTargetId, command.visibility ?? 'public')
    resistanceCantripUses.add(useKey)
    rolls.push(reductionRoll)
    events.push(eventFrom(commandWithRules(command, RULE_IDS.resistance), 'DieRolled', { ...reductionRoll, modifier_source: 'resistance', damage_type: damageType }, []))
    return damagePayload(sourceState, resolvedTargetId, rawAmount, damageType, {
      reduction: reductionRoll.total,
      condition_id: conditionId,
      turn_key: turnKey,
      roll_id: reductionRoll.roll_id,
    })
  }

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
      const skill = String(command.skill || '').toLowerCase()
      const ability = String(skillAbility(skill) || command.ability || 'str').toLowerCase()
      let modifier = Number.isSafeInteger(Number(command.modifier))
        ? Number(command.modifier)
        : abilityModifier(actor?.abilities?.[ability]) + (skill ? skillProficiencyBonus(actor, skill) : command.proficient ? safeInteger(actor?.proficiency, 0) : 0)
      if (conditionIdsFor(state, command.actor_id).has('guidance-d4')) {
        const guidance = diceService.roll('1d4', 'spell:guidance', command.actor_id, command.visibility ?? 'public')
        rolls.push(guidance)
        events.push(eventFrom(command, 'DieRolled', guidance, []), eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'guidance-d4' }, [command.actor_id]))
        modifier += guidance.total
      }
      const silveryFortune = conditionIdsFor(state, command.actor_id).has('silvery-fortune')
      const roll = diceService.rollCheck({ modifier, difficulty: safeInteger(command.difficulty, 10), purpose: `ability_check:${ability}`, actorId: command.actor_id, advantage: Boolean(command.advantage) || silveryFortune, disadvantage: Boolean(command.disadvantage), visibility: command.visibility })
      rolls.push(roll)
      events.push(eventFrom(commandWithRules(command, command.advantage || command.disadvantage ? RULE_IDS.advantage : null), 'AbilityCheckResolved', {
        ability, ...(skill ? { skill } : {}), ...roll,
        ...(command.social_check ? { social_check: {
          check_id: command.social_check.check_id, npc_id: command.social_check.npc_id,
          skill: command.social_check.skill, request_fingerprint: command.social_check.request_fingerprint,
        } } : {}),
      }, [command.actor_id]))
      if (silveryFortune) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'silvery-fortune' }, [command.actor_id]))
      break
    }
    case 'MakeSavingThrow': {
      const actor = findActor(state, command.actor_id)
      const ability = String(command.ability || 'con').toLowerCase()
      const baseModifier = Number.isSafeInteger(Number(command.modifier))
        ? Number(command.modifier)
        : abilityModifier(actor?.abilities?.[ability]) + (command.proficient ? safeInteger(actor?.proficiency, 0) : 0)
      const auraProtection = savingThrowModifierWithAura(state, command.actor_id, baseModifier)
      let modifier = auraProtection.modifier
      const savingConditions = conditionIdsFor(state, command.actor_id)
      if (savingConditions.has('bless-d4')) {
        const blessing = diceService.roll('1d4', 'spell:bless:saving-throw', command.actor_id, command.visibility ?? 'public')
        rolls.push(blessing)
        events.push(eventFrom(command, 'DieRolled', blessing, []))
        modifier += blessing.total
      }
      if (savingConditions.has('bane-d4')) {
        const bane = diceService.roll('1d4', 'spell:bane:saving-throw', command.actor_id, command.visibility ?? 'public')
        rolls.push(bane)
        events.push(eventFrom(command, 'DieRolled', bane, []))
        modifier -= bane.total
      }
      if (savingConditions.has('next-save-minus-d4')) {
        const penalty = diceService.roll('1d4', 'spell:mind-sliver', command.actor_id, command.visibility ?? 'public')
        rolls.push(penalty)
        events.push(eventFrom(command, 'DieRolled', penalty, []), eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'next-save-minus-d4' }, [command.actor_id]))
        modifier -= penalty.total
      }
      const silveryFortune = savingConditions.has('silvery-fortune')
      const roll = diceService.rollCheck({ modifier, difficulty: safeInteger(command.difficulty, 10), purpose: `saving_throw:${ability}`, actorId: command.actor_id, advantage: Boolean(command.advantage) || silveryFortune, disadvantage: Boolean(command.disadvantage), visibility: command.visibility })
      rolls.push(roll)
      events.push(eventFrom(commandWithRules(command, command.advantage || command.disadvantage ? RULE_IDS.advantage : null), 'SavingThrowResolved', { ability, ...roll, ...auraOfProtectionPayload(auraProtection.aura) }, [command.actor_id]))
      if (silveryFortune) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'silvery-fortune' }, [command.actor_id]))
      break
    }
    case 'MakeAttack': {
      const actor = findActor(state, command.actor_id)
      const target = findActor(state, targetId)
      const authoritative = Boolean(command.server_authoritative || context.serverAuthoritativeCombat || context.isNpcScheduler || isEnemyActor(state, command.actor_id) || isEnemyActor(state, targetId))
      const selectedProfile = authoritative && command.item_id ? itemAttackProfile(state, actor, command.item_id) : null
      const profile = selectedProfile ?? (authoritative ? trustedAttackProfile(state, actor, command.action_id) : null)
      if (profile) {
        command.attack_modifier = profile.modifier
        command.damage_expression = profile.damage_expression
        command.damage_amount = profile.damage_amount
        command.damage_type = profile.damage_type
        command.range_feet = profile.range_feet
        delete command.armor_class
        delete command.advantage
        delete command.disadvantage
      }
      const armorClass = effectiveArmorClass(state, target, targetId)
      const actorAt = actorPosition(state, command.actor_id)
      const targetAt = command.reaction_attack && command.reaction_target_position
        ? { x: Number(command.reaction_target_position.x), y: Number(command.reaction_target_position.y) }
        : actorPosition(state, targetId)
      const hasTacticalMap = tacticalCellMap(state).size > 0
      let distanceFeet = null
      if (authoritative && state.mechanics.combat.active && hasTacticalMap) {
        if (!actorAt || !targetAt) throw new RulesValidationError('Участники боя должны находиться на карте', 'MAP_POSITION_REQUIRED')
        distanceFeet = Math.max(Math.abs(actorAt.x - targetAt.x), Math.abs(actorAt.y - targetAt.y)) * 5
        if (distanceFeet < 5 || distanceFeet > profile.range_feet) throw new RulesValidationError('Цель находится вне дальности атаки', 'TARGET_OUT_OF_RANGE')
        if (profile.range_feet > 5) assertClearTrajectory(state, actorAt, targetAt)
      }
      let modifier = profile?.modifier ?? safeInteger(command.attack_modifier, 0)
      const enemyAdjacent = profile?.kind === 'ranged' && listActors(state).some((candidate) => isEnemyActor(state, actorId(candidate)) !== isEnemyActor(state, command.actor_id) && isLivingActor(candidate) && (() => { const at = actorPosition(state, actorId(candidate)); return at && actorAt && Math.max(Math.abs(at.x - actorAt.x), Math.abs(at.y - actorAt.y)) === 1 })())
      const longRange = profile && distanceFeet != null && distanceFeet > profile.normal_range_feet
      const actorConditions = conditionIdsFor(state, command.actor_id)
      const targetConditions = conditionIdsFor(state, targetId)
      const pendingWeaponHitCondition = (state.mechanics.conditions[command.actor_id] ?? []).find((condition) => String(condition?.id ?? condition).startsWith('next-weapon-hit:'))
      const pendingWeaponHitSpellId = pendingWeaponHitCondition
        ? String(pendingWeaponHitCondition.spell_id ?? pendingWeaponHitCondition.id).replace(/^next-weapon-hit:/u, '')
        : ''
      const pendingWeaponHitSpell = pendingWeaponHitSpellId ? combatSpellFor(actor, pendingWeaponHitSpellId) : null
      const pendingWeaponHit = pendingWeaponHitSpell?.nextWeaponHit ?? null
      const pendingWeaponHitMatches = Boolean(pendingWeaponHit && profile
        && (!pendingWeaponHit.meleeOnly || profile.kind === 'melee')
        && (!pendingWeaponHit.rangedOnly || profile.kind === 'ranged'))
      if (actorConditions.has('bless-d4')) {
        const blessing = diceService.roll('1d4', 'spell:bless:attack', command.actor_id, command.visibility ?? 'public')
        rolls.push(blessing)
        events.push(eventFrom(command, 'DieRolled', blessing, []))
        modifier += blessing.total
      }
      if (actorConditions.has('bane-d4')) {
        const bane = diceService.roll('1d4', 'spell:bane:attack', command.actor_id, command.visibility ?? 'public')
        rolls.push(bane)
        events.push(eventFrom(command, 'DieRolled', bane, []))
        modifier -= bane.total
      }
      const alliedSupport = listActors(state).some((candidate) => actorId(candidate) !== command.actor_id
        && isEnemyActor(state, actorId(candidate)) === isEnemyActor(state, command.actor_id)
        && isLivingActor(candidate)
        && (() => { const at = actorPosition(state, actorId(candidate)); return at && targetAt && Math.max(Math.abs(at.x - targetAt.x), Math.abs(at.y - targetAt.y)) === 1 })())
      const helped = actorConditions.has('helped')
      const hidden = actorConditions.has('hidden')
      const dodging = targetConditions.has('dodging')
      const reckless = actorConditions.has('reckless')
      const targetReckless = targetConditions.has('reckless')
      const steadyAim = actorConditions.has('steady-aim')
      const proneTarget = targetConditions.has('prone')
      const restrainedTarget = targetConditions.has('restrained')
      const packTactics = Boolean(monsterTraitFor(actor, 'pack-tactics') && alliedSupport)
      const trueStrike = actorConditions.has('true-strike')
      const silveryFortune = actorConditions.has('silvery-fortune')
      const guidingBoltAdvantage = targetConditions.has('guiding-bolt-advantage')
      const faerieFireAdvantage = targetConditions.has('faerie-fire')
      const advantage = profile ? Boolean(profile.advantage || helped || hidden || reckless || steadyAim || trueStrike || silveryFortune || guidingBoltAdvantage || faerieFireAdvantage || targetReckless || packTactics || restrainedTarget || (pendingWeaponHitMatches && pendingWeaponHit.advantage) || (proneTarget && distanceFeet != null && distanceFeet <= 5)) : Boolean(command.advantage || helped || hidden || reckless || steadyAim || trueStrike || silveryFortune || guidingBoltAdvantage || faerieFireAdvantage || targetReckless)
      const compelledAgainstOther = (state.mechanics.conditions[command.actor_id] ?? []).some((condition) => String(condition?.id ?? condition) === 'compelled-duel' && String(condition.source_actor ?? '') !== targetId)
      const oneShotDisadvantage = actorConditions.has('disadvantage-next-attack') || actorConditions.has('disadvantage-next-weapon-attack') || compelledAgainstOther
      const disadvantage = profile ? Boolean(profile.disadvantage || enemyAdjacent || longRange || dodging || oneShotDisadvantage || actorConditions.has('poisoned') || actorConditions.has('restrained') || actorConditions.has('frightened') || (proneTarget && distanceFeet != null && distanceFeet > 5)) : Boolean(command.disadvantage || dodging || oneShotDisadvantage || actorConditions.has('frightened'))
      const attack = diceService.rollD20({ modifier, purpose: 'attack', actorId: command.actor_id, advantage, disadvantage, visibility: command.visibility })
      const hit = attack.kept === 20 || (attack.kept !== 1 && attack.total >= armorClass)
      rolls.push(attack)
      const attackCommand = commandWithRules(command, RULE_IDS.armorClass, advantage || disadvantage ? RULE_IDS.advantage : null, attack.kept === 20 ? RULE_IDS.criticalHit : null)
      const configuredDamageExpression = profile?.damage_expression ?? command.damage_expression
      const damageType = profile?.damage_type ?? String(command.damage_type || 'untyped')
      let damageOutcome = null
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
        action_id: profile?.id ?? null,
        action_name: profile?.name ?? null,
        pack_tactics: packTactics,
        trajectory: actorAt && targetAt ? lineCells(actorAt, targetAt) : [],
        long_range: Boolean(longRange),
        reaction_attack: command.reaction_attack === true,
      }, [targetId]))
      if (selectedProfile && !selectedProfile.item.equipped) events.splice(events.length - 1, 0, eventFrom(attackCommand, 'EquipmentChanged', { item_id: selectedProfile.item.id, item_name: selectedProfile.item.name, equipped: true, timing: 'before_attack', turns_spent: 0 }, [command.actor_id]))
      if (actorConditions.has('disadvantage-next-attack')) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'disadvantage-next-attack' }, [command.actor_id]))
      if (actorConditions.has('disadvantage-next-weapon-attack')) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'disadvantage-next-weapon-attack' }, [command.actor_id]))
      if (trueStrike) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'true-strike' }, [command.actor_id]))
      if (silveryFortune) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'silvery-fortune' }, [command.actor_id]))
      if (guidingBoltAdvantage) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'guiding-bolt-advantage' }, [targetId]))
      if (profile?.uses > 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: `monster-action-used:${profile.id}`, source_actor: command.actor_id }, [command.actor_id]))
      if (helped) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'helped' }, [command.actor_id]))
      if (hidden) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'hidden' }, [command.actor_id]))
      if (hit && (configuredDamageExpression || command.damage_amount != null)) {
        const damageExpression = configuredDamageExpression && attack.kept === 20 ? criticalDamageExpression(configuredDamageExpression) : configuredDamageExpression
        const damageRoll = damageExpression
          ? diceService.roll(damageExpression, 'damage', command.actor_id, command.visibility ?? 'public')
          : null
        if (damageRoll) { rolls.push(damageRoll); events.push(eventFrom(command, 'DieRolled', damageRoll, [])) }
        const marked = targetConditions.has(`hunters-mark:${command.actor_id}`) || targetConditions.has('hunters-mark') || targetConditions.has('favored-foe')
        const markSides = targetConditions.has('favored-foe') ? (safeInteger(actor?.level, 1) >= 10 ? 8 : safeInteger(actor?.level, 1) >= 6 ? 6 : 4) : 6
        const markRoll = marked ? diceService.roll(attack.kept === 20 ? `2d${markSides}` : `1d${markSides}`, 'marked_target_damage', command.actor_id, command.visibility ?? 'public') : null
        if (markRoll) { rolls.push(markRoll); events.push(eventFrom(command, 'DieRolled', markRoll, [])) }
        const hexed = targetConditions.has(`hexed:${command.actor_id}`)
        const hexRoll = hexed ? diceService.roll(attack.kept === 20 ? '2d6' : '1d6', 'spell:hex:damage', command.actor_id, command.visibility ?? 'public') : null
        if (hexRoll) { rolls.push(hexRoll); events.push(eventFrom(command, 'DieRolled', { ...hexRoll, damage_type: 'necrotic' }, [])) }
        const divineFavor = actorConditions.has('divine-favor')
        const divineFavorRoll = divineFavor ? diceService.roll(attack.kept === 20 ? '2d4' : '1d4', 'spell:divine-favor:damage', command.actor_id, command.visibility ?? 'public') : null
        if (divineFavorRoll) { rolls.push(divineFavorRoll); events.push(eventFrom(command, 'DieRolled', { ...divineFavorRoll, damage_type: 'radiant' }, [])) }
        const rageBonus = actorConditions.has('raging') && (profile?.range_feet ?? 5) <= 5 ? (safeInteger(actor?.level, 1) >= 9 ? 3 : 2) : 0
        let raw = (damageRoll?.total ?? Math.max(0, safeInteger(command.damage_amount, 0))) + (markRoll?.total ?? 0) + (hexRoll?.total ?? 0) + (divineFavorRoll?.total ?? 0) + rageBonus
        const martialAdvantage = monsterTraitFor(actor, 'martial-advantage')
        const surpriseAttack = monsterTraitFor(actor, 'surprise-attack')
        const traitDamageExpression = martialAdvantage && alliedSupport
          ? String(martialAdvantage.damage_expression || '2d6')
          : surpriseAttack && hidden && safeInteger(state.mechanics.combat.round, 1) === 1
            ? String(surpriseAttack.damage_expression || '2d6')
            : null
        if (traitDamageExpression) {
          const traitDamage = diceService.roll(attack.kept === 20 ? criticalDamageExpression(traitDamageExpression) : traitDamageExpression, 'monster_trait_damage', command.actor_id, command.visibility ?? 'public')
          rolls.push(traitDamage)
          events.push(eventFrom(command, 'DieRolled', { ...traitDamage, trait_id: martialAdvantage && alliedSupport ? 'martial-advantage' : 'surprise-attack' }, []))
          raw += traitDamage.total
        }
        let pendingCondition = null
        const onHit = profile?.on_hit
        if (onHit) {
          let saved = false
          if (onHit.save_ability) {
            const saveAbility = String(onHit.save_ability)
            const saveDc = Math.max(1, safeInteger(onHit.save_dc, 10))
            const save = rollSavingThrowCheck(state, diceService, targetId, { modifier: abilityModifier(target?.abilities?.[saveAbility]), difficulty: saveDc, purpose: `monster_action_save:${profile.id}:${saveAbility}`, visibility: command.visibility })
            rolls.push(save)
            saved = save.success
            events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'SavingThrowResolved', { ...save, ability: saveAbility, action_id: profile.id }, [targetId]))
          }
          if (onHit.damage_expression) {
            const secondary = diceService.roll(String(onHit.damage_expression), 'monster_action_damage', command.actor_id, command.visibility ?? 'public')
            rolls.push(secondary)
            events.push(eventFrom(command, 'DieRolled', { ...secondary, action_id: profile.id, damage_type: String(onHit.damage_type || damageType) }, []))
            raw += saved && onHit.half_on_save ? Math.floor(secondary.total / 2) : saved ? 0 : secondary.total
          }
          if (onHit.condition && !saved) pendingCondition = { id: String(onHit.condition), duration: onHit.duration ?? null }
        }
        let payload = resolveDamagePayload(state, targetId, raw, damageType)
        const knockedOut = command.knock_out === true && profile?.kind === 'melee' && payload.hp_before > 0 && payload.hp_after === 0
        if (knockedOut) payload = {
          ...payload,
          hp_after: 1,
          applied_amount: Math.max(0, payload.hp_before - 1),
          knocked_out: true,
        }
        if (payload.hp_after === 0 && monsterTraitFor(target, 'undead-fortitude') && damageType !== 'radiant' && attack.kept !== 20) {
          const difficulty = 5 + payload.applied_amount
          const fortitude = rollSavingThrowCheck(state, diceService, targetId, { modifier: abilityModifier(target?.abilities?.con), difficulty, purpose: 'undead_fortitude', visibility: command.visibility })
          rolls.push(fortitude)
          events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'SavingThrowResolved', { ...fortitude, ability: 'con', trait_id: 'undead-fortitude' }, [targetId]))
          if (fortitude.success) payload = { ...payload, hp_after: 1, applied_amount: Math.max(0, payload.hp_before - 1), undead_fortitude: true, undead_fortitude_dc: difficulty }
        }
        damageOutcome = payload
        events.push(eventFrom(commandWithRules(attackCommand, RULE_IDS.damage, payload.immune || payload.resistant || payload.vulnerable ? RULE_IDS.resistance : null, payload.temporary_hp_absorbed ? RULE_IDS.temporaryHp : null), 'DamageApplied', payload, [targetId]))
        if (knockedOut) events.push(eventFrom(commandWithRules(attackCommand, RULE_IDS.zeroHp, RULE_IDS.conditions, RULE_IDS.resource), 'CreatureKnockedOut', {
          condition: 'unconscious',
          rest_kind: 'short',
          recovery_minutes: 60,
          attack_kind: 'melee',
        }, [targetId]))
        const agathys = (state.mechanics.conditions[targetId] ?? []).find((condition) => String(condition?.id ?? condition).startsWith('armor-of-agathys:'))
        const isMeleeHit = profile?.kind === 'melee'
        if (agathys && isMeleeHit && payload.temporary_hp_before > 0) {
          const retaliation = Math.max(0, safeInteger(String(agathys.id).slice('armor-of-agathys:'.length), 0))
          const retaliationPayload = resolveDamagePayload(state, command.actor_id, retaliation, 'cold')
          events.push(eventFrom(commandWithRules(command, RULE_IDS.damage), 'DamageApplied', { ...retaliationPayload, spell_id: 'armor-of-agathys', retaliation: true }, [command.actor_id]))
          if (retaliationPayload.hp_after === 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HitPointsReducedToZero', { condition: 'unconscious' }, [command.actor_id]))
        }
        if (agathys && payload.temporary_hp_after === 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: String(agathys.id) }, [targetId]))
        if (pendingCondition && payload.hp_after > 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: pendingCondition.id, duration: pendingCondition.duration, source_actor: command.actor_id, action_id: profile?.id ?? null }, [targetId]))
        if (targetConditions.has('uncanny-dodge')) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'uncanny-dodge' }, [targetId]))
        if (steadyAim) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'steady-aim' }, [command.actor_id]))
        events.push(...zeroHitPointDamageConsequences(state, attackCommand, targetId, payload, { critical: attack.kept === 20 }))
      }
      if (hit && pendingWeaponHitMatches && pendingWeaponHitCondition && pendingWeaponHitSpell) {
        const effectId = pendingWeaponHitCondition.effect_id ?? state.mechanics.concentration[command.actor_id]?.effect_id ?? null
        const saveDc = Math.max(1, safeInteger(pendingWeaponHitCondition.save_dc, 8 + Math.max(0, safeInteger(actor?.proficiency, 0)) + abilityModifier(actor?.abilities?.[pendingWeaponHitSpell.spellcastingAbility ?? 'cha'])))
        const slotLevel = Math.max(pendingWeaponHitSpell.level, safeInteger(pendingWeaponHitCondition.slot_level, pendingWeaponHitSpell.level))
        const extraLevels = Math.max(0, slotLevel - Math.max(1, pendingWeaponHitSpell.level))
        events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: pendingWeaponHitCondition.id, spell_id: pendingWeaponHitSpell.id, trigger: 'weapon-hit' }, [command.actor_id]))

        let hitEffectState = replayEvents(state, events)
        if (pendingWeaponHit.damage) {
          const baseExpression = scaledDiceExpression(pendingWeaponHit.damage, extraLevels, pendingWeaponHit.upcastDicePerLevel)
          const expression = attack.kept === 20 ? criticalDamageExpression(baseExpression) : baseExpression
          const bonusRoll = diceService.roll(expression, `spell:next-weapon-hit:${pendingWeaponHitSpell.id}`, command.actor_id, command.visibility ?? 'public')
          rolls.push(bonusRoll)
          events.push(eventFrom(command, 'DieRolled', { ...bonusRoll, spell_id: pendingWeaponHitSpell.id, damage_type: pendingWeaponHit.damageType ?? 'force' }, []))
          const bonusPayload = resolveDamagePayload(hitEffectState, targetId, bonusRoll.total, String(pendingWeaponHit.damageType ?? 'force'))
          const bonusEvent = eventFrom(commandWithRules(command, RULE_IDS.damage), 'DamageApplied', { ...bonusPayload, spell_id: pendingWeaponHitSpell.id, next_weapon_hit: true }, [targetId])
          events.push(bonusEvent)
          hitEffectState = applyGameEvent(hitEffectState, bonusEvent)
          if (bonusPayload.hp_after === 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HitPointsReducedToZero', { condition: 'unconscious', spell_id: pendingWeaponHitSpell.id }, [targetId]))
        }

        let saved = pendingWeaponHitSpell.id === 'wrathful-smite' && conditionIdsFor(hitEffectState, targetId).has('heroism')
        if (pendingWeaponHit.saveAbility && !saved && isLivingActor(findActor(hitEffectState, targetId))) {
          const ability = String(pendingWeaponHit.saveAbility)
          const save = rollSavingThrowD20(hitEffectState, diceService, targetId, {
            modifier: abilityModifier(target?.abilities?.[ability]),
            purpose: `spell_next_weapon_hit_save:${pendingWeaponHitSpell.id}:${ability}`,
            advantage: pendingWeaponHit.saveAdvantageForLarge === true && isLargeOrLarger(target),
            visibility: command.visibility,
          })
          saved = save.total >= saveDc
          rolls.push(save)
          events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow), 'SpellSavingThrowResolved', { ...save, spell_id: pendingWeaponHitSpell.id, ability, difficulty: saveDc, saved, trigger: 'next-weapon-hit' }, [targetId]))
        }

        if (!saved && isLivingActor(findActor(hitEffectState, targetId))) {
          const addLinkedCondition = (condition, extra = {}) => events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', {
            condition,
            duration: 'concentration',
            source_actor: command.actor_id,
            effect_id: effectId,
            spell_id: pendingWeaponHitSpell.id,
            save_dc: saveDc,
            ...extra,
          }, [targetId]))
          if (pendingWeaponHitSpell.id === 'searing-smite') {
            addLinkedCondition('searing-smite-flames', { start_turn_save: 'con', recurring_damage: '1d6', recurring_damage_type: 'fire' })
          } else if (pendingWeaponHitSpell.id === 'wrathful-smite') {
            addLinkedCondition('wrathful-smite-frightened', { escape_check_ability: 'wis' })
            addLinkedCondition('frightened')
          } else if (pendingWeaponHitSpell.id === 'ensnaring-strike') {
            const recurringDamage = scaledDiceExpression('1d6', extraLevels, 1)
            addLinkedCondition('ensnaring-strike', { recurring_damage: recurringDamage, recurring_damage_type: 'piercing' })
            addLinkedCondition('restrained', { escape_check_ability: 'str' })
          } else for (const condition of pendingWeaponHit.conditions ?? []) addLinkedCondition(condition)

          if (pendingWeaponHit.pushFeet > 0) {
            const path = forcedPushPath(hitEffectState, targetId, actorPosition(hitEffectState, command.actor_id), pendingWeaponHit.pushFeet)
            if (path.length) events.push(eventFrom(commandWithRules(command, RULE_IDS.turns), 'ActorMoved', {
              from: actorPosition(hitEffectState, targetId), to: path.at(-1), path, distance: path.length * 5,
              movement_cost: 0, movement_spent: 0, movement_remaining: safeInteger(target?.speed, 30),
              spend_movement: false, forced_movement: true, spell_id: pendingWeaponHitSpell.id, phase: 'combat',
            }, [targetId]))
          }
          if (pendingWeaponHit.proneOnFailedSave) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', {
            condition: 'prone', duration: null, source_actor: command.actor_id, spell_id: pendingWeaponHitSpell.id,
          }, [targetId]))
        }

        if (pendingWeaponHit.burst) {
          const burst = pendingWeaponHit.burst
          const targetPosition = actorPosition(hitEffectState, targetId)
          const burstTargets = targetPosition ? listActors(hitEffectState).filter((candidate) => {
            if (!isLivingActor(candidate)) return false
            const position = actorPosition(hitEffectState, actorId(candidate))
            return position && Math.max(Math.abs(position.x - targetPosition.x), Math.abs(position.y - targetPosition.y)) * 5 <= Math.max(0, safeInteger(burst.radius, 5))
          }) : []
          const expression = scaledDiceExpression(burst.damage, extraLevels, burst.upcastDicePerLevel, burst.maximumDice)
          const burstRoll = diceService.roll(expression, `spell:next-weapon-hit-burst:${pendingWeaponHitSpell.id}`, command.actor_id, command.visibility ?? 'public')
          rolls.push(burstRoll)
          events.push(eventFrom(command, 'DieRolled', { ...burstRoll, spell_id: pendingWeaponHitSpell.id, damage_type: burst.damageType, burst: true }, []))
          let burstState = replayEvents(state, events)
          for (const burstTarget of burstTargets) {
            const burstTargetId = actorId(burstTarget)
            const ability = String(burst.saveAbility)
            const save = rollSavingThrowD20(burstState, diceService, burstTargetId, { modifier: abilityModifier(burstTarget?.abilities?.[ability]), purpose: `spell_next_weapon_hit_burst_save:${pendingWeaponHitSpell.id}:${ability}`, visibility: command.visibility })
            const burstSaved = save.total >= saveDc
            rolls.push(save)
            events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow), 'SpellSavingThrowResolved', { ...save, spell_id: pendingWeaponHitSpell.id, ability, difficulty: saveDc, saved: burstSaved, trigger: 'next-weapon-hit-burst' }, [burstTargetId]))
            const amount = burstSaved ? (burst.halfOnSave ? Math.floor(burstRoll.total / 2) : 0) : burstRoll.total
            if (amount <= 0) continue
            const burstPayload = resolveDamagePayload(burstState, burstTargetId, amount, String(burst.damageType))
            const burstEvent = eventFrom(commandWithRules(command, RULE_IDS.damage), 'DamageApplied', { ...burstPayload, spell_id: pendingWeaponHitSpell.id, burst: true, saved: burstSaved }, [burstTargetId])
            events.push(burstEvent)
            burstState = applyGameEvent(burstState, burstEvent)
            if (burstPayload.hp_after === 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HitPointsReducedToZero', { condition: 'unconscious', spell_id: pendingWeaponHitSpell.id }, [burstTargetId]))
          }
        }

        if (pendingWeaponHit.speedBonus > 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.turns), 'CombatActionUsed', {
          action_id: `${pendingWeaponHitSpell.id}:speed-bonus`, name: pendingWeaponHitSpell.name, action_type: 'free', movement_bonus: pendingWeaponHit.speedBonus,
        }, [command.actor_id]))
        if (pendingWeaponHit.endConcentrationOnHit && effectId) events.push(eventFrom(commandWithRules(command, RULE_IDS.concentration), 'ConcentrationEnded', { reason: 'next-weapon-hit-resolved', effect_id: effectId }, [command.actor_id]))
      }
      if (!command.reaction_attack && !isEnemyActor(state, targetId) && isLivingActor(target) && (!damageOutcome || damageOutcome.hp_after > 0)) {
        let reactionActorId = targetId
        const actionOptions = reactionOptionsAfterAttack(state, target, {
          hit,
          attackTotal: attack.total,
          armorClass,
          damage: damageOutcome,
          distanceFeet,
          allowParry: distanceFeet == null || distanceFeet <= 5,
          allowRiposte: distanceFeet == null || distanceFeet <= 5,
        })
        const silvery = hit ? silveryBarbsReactionFor(state, command.actor_id, targetId) : null
        if (silvery && (actorId(silvery.actor) === targetId || actionOptions.length === 0)) {
          reactionActorId = actorId(silvery.actor)
          actionOptions.push({ id: 'cast:silvery-barbs', name: silvery.spell.name, description: silvery.spell.description, resource: silvery.slot.resource, slot_level: silvery.slot.level, cost: 1, spell_id: silvery.spell.id, requires_beneficiary: true })
        }
        const reactionEconomy = state.mechanics.combat.action_economy[reactionActorId]
        if (reactionEconomy?.reaction !== false && actionOptions.length) {
          events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction), 'ReactionWindowOpened', {
            id: `reaction:${command.command_id}`,
            trigger: hit ? 'attack-hit' : 'attack-missed',
            actor_id: reactionActorId,
            source_actor_id: command.actor_id,
            target_id: targetId,
            action_ids: actionOptions.map((candidate) => candidate.id),
            action_options: actionOptions,
            damage: damageOutcome ? {
              ...damageOutcome,
            } : null,
            trigger_roll: { kept: attack.kept, modifier: attack.modifier, total: attack.total, armor_class: armorClass, hit, critical: attack.kept === 20 },
          }, [reactionActorId]))
        }
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
        const save = rollSavingThrowD20(state, diceService, targetIdValue, { modifier: abilityModifier(target?.abilities?.[combat.saveAbility || 'dex']), purpose: `saving_throw:${combat.saveAbility || 'dex'}`, visibility: command.visibility })
        rolls.push(save)
        const saved = save.total >= safeInteger(combat.saveDc, 12)
        events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow), 'SavingThrowResolved', {
          ...save,
          ability: combat.saveAbility || 'dex',
          difficulty: safeInteger(combat.saveDc, 12),
          success: saved,
          saved,
          source: 'area-attack',
          item_id: item.id,
        }, [targetIdValue]))
        const raw = saved && combat.halfOnSave ? Math.floor(damageRoll.total / 2) : saved ? 0 : damageRoll.total
        events.push(eventFrom(commandWithRules(command, RULE_IDS.damage), 'DamageApplied', { ...resolveDamagePayload(state, targetIdValue, raw, String(combat.damageType || 'fire')), save_total: save.total, save_dc: safeInteger(combat.saveDc, 12), saved }, [targetIdValue]))
      }
      events.push(eventFrom(command, 'ItemConsumed', { item_id: item.id, item_name: item.name, quantity: 1 }, [command.actor_id]))
      break
    }
    case 'ApplyDamage': {
      const amount = rollAmount('damage')
      const payload = resolveDamagePayload(state, targetId, amount, String(command.damage_type || 'untyped'))
      events.push(eventFrom(commandWithRules(command, payload.immune || payload.resistant || payload.vulnerable ? RULE_IDS.resistance : null, payload.temporary_hp_absorbed ? RULE_IDS.temporaryHp : null), 'DamageApplied', payload, [targetId]))
      events.push(...zeroHitPointDamageConsequences(state, command, targetId, payload, { critical: command.critical_hit === true }))
      break
    }
    case 'ApplyHealing': {
      const actor = findActor(state, targetId)
      const healing = resolvedHealingRoll(state, targetId, command.expression, rollAmount('healing'))
      const amount = healing.amount
      const before = actorHp(actor)
      const after = Math.min(actorMaxHp(actor), before + amount)
      events.push(eventFrom(command, 'HealingApplied', { requested_amount: amount, applied_amount: after - before, hp_before: before, hp_after: after, ...healing }, [targetId]))
      break
    }
    case 'ReduceHitPointMaximum': {
      const target = findActor(state, targetId)
      const amount = Math.max(0, safeInteger(command.amount, 0))
      const maximumBefore = actorMaxHp(target)
      const hpBefore = actorHp(target)
      const aura = activeAuraOfLifeSource(state, targetId)
      if (aura && amount > 0) {
        events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'HitPointMaximumReductionPrevented', {
          attempted_amount: amount,
          maximum_hp_before: maximumBefore,
          maximum_hp_after: maximumBefore,
          aura_of_life_source: aura.source_id,
        }, [targetId]))
      } else {
        const maximumAfter = Math.max(0, maximumBefore - amount)
        const hpAfter = Math.min(hpBefore, maximumAfter)
        events.push(eventFrom(command, 'HitPointMaximumReduced', {
          requested_amount: amount,
          applied_amount: maximumBefore - maximumAfter,
          maximum_hp_before: maximumBefore,
          maximum_hp_after: maximumAfter,
          hp_before: hpBefore,
          hp_after: hpAfter,
        }, [targetId]))
        if (maximumAfter === 0 && playerActor(state, targetId) && !isDeadHero(state, targetId)) {
          events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HeroDied', {
            hero_name: String(target?.character ?? target?.name ?? targetId),
            reason: 'hit-point-maximum-reduced-to-zero',
          }, [targetId]))
        }
      }
      break
    }
    case 'ResolveHeroDeath': {
      const hero = playerActor(state, command.actor_id)
      if (command.resolution === 'resurrect') {
        events.push(eventFrom(command, 'HeroResurrected', {
          hp_after: 1,
          previous_name: String(hero.character ?? hero.name ?? command.actor_id),
        }, [command.actor_id]))
      } else {
        events.push(eventFrom(command, 'HeroReplaced', {
          hp_after: actorMaxHp(hero),
          previous_name: String(hero.character ?? hero.name ?? command.actor_id),
          replacement_name: command.replacement_name,
        }, [command.actor_id]))
      }
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
    case 'UseCombatAction': {
      const actor = findActor(state, command.actor_id)
      const reactionWindow = command.reaction_window ?? state.mechanics.combat.reaction_window
      const resumePendingSpell = () => {
        if (!reactionWindow?.pending_spell_command) return
        const resumedState = events.reduce(applyGameEvent, state)
        const pendingCommand = {
          ...clone(reactionWindow.pending_spell_command),
          counterspell_bypassed: true,
          expected_state_version: resumedState.state_version,
        }
        const pendingResult = resolveCommand(pendingCommand, resumedState, {
          diceService,
          context: { ...context, isAdmin: true, serverAuthoritativeCombat: true },
        })
        events.push(...pendingResult.events)
        rolls.push(...pendingResult.rolls)
        nestedConsequencesResolved = true
      }
      const resolveIndomitableChoice = (accepted) => {
        if (reactionWindow?.trigger !== 'failed-saving-throw' || !reactionWindow.pending_command || !Array.isArray(reactionWindow.pending_dice_transcript)) return
        const bonus = Math.max(1, safeInteger(reactionWindow.fighter_level, safeInteger(actor?.level, 9)))
        const failedRollId = String(reactionWindow.failed_roll_id ?? '')
        const rerolled = accepted
          ? rollIndomitableReplacement(diceService, reactionWindow.pending_dice_transcript, failedRollId, bonus)
          : null
        const decisions = [
          ...(Array.isArray(reactionWindow.indomitable_decisions) ? clone(reactionWindow.indomitable_decisions) : []),
          {
            actor_id: command.actor_id,
            accepted,
            roll_id: failedRollId,
            bonus,
            original_total: safeInteger(reactionWindow.trigger_roll?.total, 0),
            ...(rerolled ? { result: clone(rerolled) } : {}),
          },
        ]
        const queue = Array.isArray(reactionWindow.pending_indomitable_queue) ? clone(reactionWindow.pending_indomitable_queue) : []
        events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction, RULE_IDS.indomitable), 'ReactionWindowClosed', {
          id: reactionWindow.id,
          accepted,
          ...(accepted ? { action_id: 'indomitable' } : {}),
          deferred: queue.length > 0,
        }, [command.actor_id]))
        if (queue.length > 0) {
          const next = queue[0]
          const failedEvent = next.failed_event ?? {}
          const failed = failedEvent.payload ?? {}
          const nextLevel = Math.max(9, safeInteger(next.fighter_level, 9))
          events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow, RULE_IDS.indomitable), 'ReactionWindowOpened', {
            ...clone(reactionWindow),
            id: `indomitable:${String(reactionWindow.pending_command.command_id ?? command.command_id)}:${String(next.target_id)}`,
            actor_id: String(next.target_id),
            target_id: String(next.target_id),
            action_ids: ['indomitable'],
            action_options: [{
              id: 'indomitable', name: 'Несгибаемый', resource: 'indomitable', cost: 1,
              description: `Перебросить спасбросок с бонусом +${nextLevel}. Новый результат обязателен.`,
            }],
            trigger_roll: {
              kept: safeInteger(failed.kept ?? failed.natural_roll, 0),
              modifier: safeInteger(failed.modifier, 0),
              total: safeInteger(failed.total, 0),
              difficulty: safeInteger(failed.difficulty, failedEvent.event_type === 'DeathSavingThrowRolled' ? 10 : 0),
              ability: String(failed.ability ?? (failedEvent.event_type === 'DeathSavingThrowRolled' ? 'death' : '')),
              save_event_type: String(failedEvent.event_type ?? ''),
            },
            failed_roll_id: String(failed.roll_id ?? ''),
            fighter_level: nextLevel,
            pending_indomitable_queue: queue.slice(1),
            indomitable_decisions: decisions,
          }, [String(next.target_id)]))
          if (rerolled) rolls.push(rerolled)
          return
        }

        for (const decision of decisions.filter((candidate) => candidate.accepted === true)) {
          const decisionActorId = String(decision.actor_id)
          const decisionCommand = commandWithRules({ ...command, actor_id: decisionActorId }, RULE_IDS.resource, RULE_IDS.indomitable)
          const pool = resourcePool(state, decisionActorId, 'indomitable', 1)
          events.push(eventFrom(decisionCommand, 'ResourceSpent', {
            resource: 'indomitable', amount: 1, before: pool.current, after: pool.current - 1, max: pool.max,
          }, [decisionActorId]))
          events.push(eventFrom(decisionCommand, 'CombatActionUsed', {
            action_id: 'indomitable',
            name: 'Несгибаемый',
            category: 'class',
            action_type: 'free',
            reaction_window_id: reactionWindow.id,
            original_total: safeInteger(decision.original_total, 0),
            bonus: Math.max(1, safeInteger(decision.bonus, 1)),
            indomitable_bonus: Math.max(1, safeInteger(decision.bonus, 1)),
          }, [decisionActorId]))
        }
        context.indomitable_bypass_actor_ids = [...new Set([
          ...(context.indomitable_bypass_actor_ids ?? []),
          ...decisions.map((decision) => String(decision.actor_id)),
        ])]
        const resumedState = events.reduce(applyGameEvent, state)
        const replacements = decisions.filter((decision) => decision.accepted === true).map((decision) => ({
          roll_id: String(decision.roll_id),
          bonus: Math.max(1, safeInteger(decision.bonus, 1)),
          result: clone(decision.result),
        }))
        const pendingResult = resolveCommand({
          ...clone(reactionWindow.pending_command),
          expected_state_version: resumedState.state_version,
        }, resumedState, {
          diceService: replayDiceService(diceService, reactionWindow.pending_dice_transcript, replacements),
          context: { ...context, isAdmin: true, serverAuthoritativeCombat: true, indomitableResume: true },
        })
        events.push(...pendingResult.events)
        rolls.push(...pendingResult.rolls)
        nestedConsequencesResolved = true
      }
      if (command.action_id === 'decline-reaction') {
        if (reactionWindow.trigger === 'failed-saving-throw') {
          resolveIndomitableChoice(false)
        } else {
          events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction), 'ReactionWindowClosed', { id: reactionWindow.id, accepted: false }, [command.actor_id]))
          resumePendingSpell()
        }
        break
      }
      const action = command.combat_action ?? combatActionFor(actor, command.action_id)
      const actionTargetId = action.target === 'self' ? command.actor_id : targetId
      const actionEvent = (extra = {}) => eventFrom(command, 'CombatActionUsed', {
        action_id: action.id,
        name: action.name,
        category: action.category,
        action_type: action.actionType,
        ...extra,
      }, [actionTargetId])
      const spendActionResource = () => {
        if (!action.resource) return
        const pool = resourcePool(state, command.actor_id, action.resource)
        const amount = Math.max(1, safeInteger(action.cost, 1))
        events.push(eventFrom(commandWithRules(command, RULE_IDS.resource), 'ResourceSpent', {
          resource: action.resource, amount, before: pool.current, after: pool.current - amount, max: pool.max,
        }, [command.actor_id]))
      }

      if (action.id === 'indomitable' && reactionWindow) {
        resolveIndomitableChoice(true)
      } else if (action.spell && reactionWindow) {
        spendActionResource()
        let resumeSpell = false
        if (action.spell.id === 'shield') {
          const restored = Math.max(0, safeInteger(reactionWindow.damage?.applied_amount, 0) + safeInteger(reactionWindow.damage?.temporary_hp_absorbed, 0))
          events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction, RULE_IDS.damage), 'ReactionDamageReduced', { action_id: action.id, ...reducedReactionDamage(reactionWindow.damage, restored) }, [command.actor_id]))
          events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: 'shielded', duration: 'until-next-turn', source_actor: command.actor_id }, [command.actor_id]))
        } else if (action.spell.id === 'absorb-elements') {
          const originalDamage = Math.max(0, safeInteger(reactionWindow.damage?.applied_amount, 0) + safeInteger(reactionWindow.damage?.temporary_hp_absorbed, 0))
          const restored = reactionWindow.damage?.resistant ? 0 : Math.ceil(originalDamage / 2)
          events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction, RULE_IDS.damage), 'ReactionDamageReduced', { action_id: action.id, ...reducedReactionDamage(reactionWindow.damage, restored) }, [command.actor_id]))
          events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: `absorbing-element:${reactionWindow.damage?.damage_type ?? 'elemental'}`, duration: 'until-next-turn', source_actor: command.actor_id }, [command.actor_id]))
        } else if (action.spell.id === 'hellish-rebuke') {
          const source = findActor(state, reactionWindow.source_actor_id)
          const spellAbility = String(action.spell.spellcastingAbility || 'cha')
          const dc = 8 + Math.max(0, safeInteger(actor?.proficiency, 0)) + abilityModifier(actor?.abilities?.[spellAbility])
          const save = rollSavingThrowD20(state, diceService, String(reactionWindow.source_actor_id), { modifier: abilityModifier(source?.abilities?.dex), purpose: 'reaction:hellish-rebuke', visibility: command.visibility })
          const damageRoll = diceService.roll(action.spell.damage ?? '2d10', 'reaction:hellish-rebuke:damage', command.actor_id, command.visibility ?? 'public')
          rolls.push(save, damageRoll)
          events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow), 'SpellSavingThrowResolved', { ...save, spell_id: action.spell.id, ability: 'dex', difficulty: dc, saved: save.total >= dc }, [String(reactionWindow.source_actor_id)]))
          events.push(eventFrom(command, 'DieRolled', damageRoll, []))
          const raw = save.total >= dc ? Math.floor(damageRoll.total / 2) : damageRoll.total
          const payload = resolveDamagePayload(state, String(reactionWindow.source_actor_id), raw, 'fire')
          events.push(eventFrom(commandWithRules(command, RULE_IDS.damage), 'DamageApplied', { ...payload, spell_id: action.spell.id }, [String(reactionWindow.source_actor_id)]))
          if (payload.hp_after === 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HitPointsReducedToZero', { condition: 'unconscious' }, [String(reactionWindow.source_actor_id)]))
        } else if (action.spell.id === 'silvery-barbs') {
          const original = reactionWindow.trigger_roll ?? {}
          const reroll = diceService.rollD20({ modifier: safeInteger(original.modifier, 0), purpose: 'reaction:silvery-barbs', actorId: String(reactionWindow.source_actor_id), visibility: command.visibility })
          rolls.push(reroll)
          const kept = Math.min(safeInteger(original.kept, 20), safeInteger(reroll.kept, 20))
          const total = kept + safeInteger(original.modifier, 0)
          const armorClass = safeInteger(original.armor_class, 10)
          const hitAfterReroll = kept === 20 || (kept !== 1 && total >= armorClass)
          events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction, RULE_IDS.attack), 'AttackRerolled', {
            spell_id: action.spell.id,
            original_kept: safeInteger(original.kept, 0),
            rerolled_kept: reroll.kept,
            kept,
            modifier: safeInteger(original.modifier, 0),
            total,
            armor_class: armorClass,
            hit: hitAfterReroll,
          }, [String(reactionWindow.source_actor_id)]))
          if (!hitAfterReroll && reactionWindow.damage) {
            const restored = safeInteger(reactionWindow.damage.applied_amount, 0) + safeInteger(reactionWindow.damage.temporary_hp_absorbed, 0)
            events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction, RULE_IDS.damage), 'ReactionDamageReduced', { action_id: action.id, ...reducedReactionDamage(reactionWindow.damage, restored) }, [String(reactionWindow.target_id)]))
          }
          events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: 'silvery-fortune', duration: 'rounds:10', source_actor: command.actor_id }, [String(command.beneficiary_id ?? command.actor_id)]))
        } else if (action.spell.id === 'counterspell') {
          const pending = reactionWindow.pending_spell_command
          const source = findActor(state, reactionWindow.source_actor_id)
          const pendingSpell = combatSpellFor(source, pending?.spell_id)
          const castLevel = Math.max(0, safeInteger(pending?.slot_level, pendingSpell?.level ?? 0))
          const counterspellLevel = Math.max(3, safeInteger(action.spell.reactionSlotLevel, 3))
          let success = counterspellLevel >= castLevel
          if (!success) {
            const ability = String(action.spell.spellcastingAbility || 'int')
            const check = diceService.rollD20({ modifier: abilityModifier(actor?.abilities?.[ability]), purpose: 'reaction:counterspell', actorId: command.actor_id, visibility: command.visibility })
            rolls.push(check)
            success = check.total >= 10 + castLevel
            events.push(eventFrom(commandWithRules(command, RULE_IDS.abilityCheck, RULE_IDS.reaction), 'CounterspellCheckResolved', { ...check, difficulty: 10 + castLevel, spell_level: castLevel, counterspell_level: counterspellLevel, success }, [String(reactionWindow.source_actor_id)]))
          }
          if (success) {
            if (pending?.spell_slot_resource) {
              const sourcePool = resourcePool(state, String(reactionWindow.source_actor_id), pending.spell_slot_resource)
              events.push(eventFrom(commandWithRules(command, RULE_IDS.resource), 'ResourceSpent', { resource: pending.spell_slot_resource, amount: 1, before: sourcePool.current, after: sourcePool.current - 1, max: sourcePool.max }, [String(reactionWindow.source_actor_id)]))
            }
            events.push(eventFrom(commandWithRules({ ...command, actor_id: String(reactionWindow.source_actor_id) }, RULE_IDS.reaction), 'SpellCast', {
              spell_id: pendingSpell?.id ?? pending?.spell_id,
              name: pendingSpell?.name ?? pending?.spell_id,
              kind: pendingSpell?.kind ?? 'utility',
              action_type: pendingSpell?.actionType ?? 'action',
              level: pendingSpell?.level ?? castLevel,
              slot_level: castLevel,
              countered: true,
              source_url: pendingSpell?.sourceUrl,
            }, pending?.target_ids ?? []))
            events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction), 'SpellCountered', { spell_id: pendingSpell?.id ?? pending?.spell_id, spell_name: pendingSpell?.name ?? pending?.spell_id, spell_level: castLevel, counterspell_level: counterspellLevel }, [String(reactionWindow.source_actor_id)]))
          } else {
            resumeSpell = true
          }
        }
        events.push(actionEvent({ reaction_window_id: reactionWindow.id, spell_id: action.spell.id }))
        events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction), 'ReactionWindowClosed', { id: reactionWindow.id, accepted: true, action_id: action.id }, [command.actor_id]))
        if (resumeSpell) resumePendingSpell()
      } else if (action.id === 'uncanny-dodge' && reactionWindow) {
        const originalDamage = Math.max(0, safeInteger(reactionWindow.damage?.applied_amount, 0) + safeInteger(reactionWindow.damage?.temporary_hp_absorbed, 0))
        events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction, RULE_IDS.damage), 'ReactionDamageReduced', { action_id: action.id, ...reducedReactionDamage(reactionWindow.damage, Math.ceil(originalDamage / 2)) }, [command.actor_id]))
        events.push(actionEvent({ reaction_window_id: reactionWindow.id }))
        events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction), 'ReactionWindowClosed', { id: reactionWindow.id, accepted: true, action_id: action.id }, [command.actor_id]))
      } else if (action.id === 'parry' && reactionWindow) {
        const parryRoll = diceService.roll(diceExpression('1d8', Math.max(0, abilityModifier(actor?.abilities?.dex)), 8), 'reaction:parry', command.actor_id, command.visibility ?? 'public')
        rolls.push(parryRoll)
        events.push(eventFrom(command, 'DieRolled', parryRoll, []))
        spendActionResource()
        events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction, RULE_IDS.damage), 'ReactionDamageReduced', { action_id: action.id, ...reducedReactionDamage(reactionWindow.damage, parryRoll.total) }, [command.actor_id]))
        events.push(actionEvent({ reaction_window_id: reactionWindow.id }))
        events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction), 'ReactionWindowClosed', { id: reactionWindow.id, accepted: true, action_id: action.id }, [command.actor_id]))
      } else if (action.id === 'riposte' && reactionWindow) {
        spendActionResource()
        events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction), 'ReactionWindowClosed', { id: reactionWindow.id, accepted: true, action_id: action.id }, [command.actor_id]))
        const attackResult = resolveCommand({
          ...command,
          command_type: 'MakeAttack',
          target_id: String(reactionWindow.source_actor_id),
          target_ids: [String(reactionWindow.source_actor_id)],
          reaction_attack: true,
          source_rule_ids: [...new Set([...command.source_rule_ids, RULE_IDS.attack, RULE_IDS.reaction])],
        }, state, { diceService, context: { ...context, reactionResolution: true } })
        events.push(...attackResult.events, actionEvent({ reaction_window_id: reactionWindow.id, economy_consumed_by_attack: false }))
        rolls.push(...attackResult.rolls)
      } else if (action.id === 'opportunity-attack' && reactionWindow) {
        events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction), 'ReactionWindowClosed', { id: reactionWindow.id, accepted: true, action_id: action.id }, [command.actor_id]))
        const attackResult = resolveCommand({
          ...command,
          command_type: 'MakeAttack',
          target_id: String(reactionWindow.source_actor_id),
          target_ids: [String(reactionWindow.source_actor_id)],
          reaction_attack: true,
          reaction_target_position: reactionWindow.source_previous_position,
          source_rule_ids: [...new Set([...command.source_rule_ids, RULE_IDS.attack, RULE_IDS.reaction])],
        }, state, { diceService, context: { ...context, reactionResolution: true } })
        events.push(...attackResult.events, actionEvent({ reaction_window_id: reactionWindow.id, economy_consumed_by_attack: false }))
        rolls.push(...attackResult.rolls)
      } else if (action.id === 'stand-up') {
        if (!conditionIdsFor(state, command.actor_id).has('prone')) throw new RulesValidationError('Встать можно только из состояния «сбит с ног»', 'ACTOR_NOT_PRONE')
        const economy = state.mechanics.combat.action_economy[command.actor_id] ?? actionEconomy()
        const movementCost = Math.ceil(Math.max(0, safeInteger(actor?.speed, 30)) / 2)
        const available = Math.max(0, safeInteger(actor?.speed, 30) + safeInteger(economy.movement_bonus, 0) - safeInteger(economy.movement_spent, 0))
        if (available < movementCost) throw new RulesValidationError('Недостаточно оставшейся скорости, чтобы встать', 'SPEED_EXCEEDED')
        events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'prone' }, [command.actor_id]))
        events.push(actionEvent({ movement_spent: movementCost }))
      } else if (action.id === 'break-free') {
        const restrained = (state.mechanics.conditions[command.actor_id] ?? []).find((condition) => String(condition?.id ?? condition) === 'restrained')
        if (!restrained) throw new RulesValidationError('Высвобождаться можно только из удерживающего эффекта', 'ACTOR_NOT_RESTRAINED')
        const effect = (state.mechanics.active_effects ?? []).find((candidate) => String(candidate.effect_id ?? candidate.id ?? '') === String(restrained.effect_id ?? ''))
        const difficulty = Math.max(1, safeInteger(restrained.save_dc ?? effect?.save_dc, 10))
        const check = diceService.rollCheck({ modifier: abilityModifier(actor?.abilities?.str), difficulty, purpose: 'break_free:strength', actorId: command.actor_id, visibility: command.visibility })
        rolls.push(check)
        events.push(eventFrom(commandWithRules(command, RULE_IDS.abilityCheck), 'AbilityCheckResolved', { ability: 'str', ...check }, [command.actor_id]))
        if (check.success) {
          const sourceActorId = String(restrained.source_actor ?? '')
          const sourceConcentration = state.mechanics.concentration[sourceActorId]
          if (restrained.effect_id && String(sourceConcentration?.effect_id ?? '') === String(restrained.effect_id)) {
            events.push(eventFrom(commandWithRules({ ...command, actor_id: sourceActorId }, RULE_IDS.concentration), 'ConcentrationEnded', { reason: 'break-free', effect_id: restrained.effect_id }, [sourceActorId]))
          } else events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'restrained' }, [command.actor_id]))
        }
        events.push(actionEvent({ success: check.success, difficulty }))
      } else if (action.id === 'steady-nerves') {
        const fear = (state.mechanics.conditions[command.actor_id] ?? []).find((condition) => String(condition?.id ?? condition) === 'wrathful-smite-frightened')
        if (!fear) throw new RulesValidationError('Это действие доступно только испуганной «Гневной карой» цели', 'WRATHFUL_SMITE_NOT_ACTIVE')
        const difficulty = Math.max(1, safeInteger(fear.save_dc, 10))
        const check = diceService.rollCheck({ modifier: abilityModifier(actor?.abilities?.wis), difficulty, purpose: 'wrathful_smite:wisdom_check', actorId: command.actor_id, visibility: command.visibility })
        rolls.push(check)
        events.push(eventFrom(commandWithRules(command, RULE_IDS.abilityCheck), 'AbilityCheckResolved', { ability: 'wis', spell_id: 'wrathful-smite', ...check }, [command.actor_id]))
        if (check.success) {
          const sourceActorId = String(fear.source_actor ?? '')
          const sourceConcentration = state.mechanics.concentration[sourceActorId]
          if (fear.effect_id && String(sourceConcentration?.effect_id ?? '') === String(fear.effect_id)) {
            events.push(eventFrom(commandWithRules({ ...command, actor_id: sourceActorId }, RULE_IDS.concentration), 'ConcentrationEnded', { reason: 'steady-nerves', effect_id: fear.effect_id }, [sourceActorId]))
          } else {
            events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: fear.id }, [command.actor_id]))
            events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'frightened' }, [command.actor_id]))
          }
        }
        events.push(actionEvent({ success: check.success, difficulty }))
      } else if (action.id === 'extinguish-self' || action.id === 'extinguish-ally') {
        const extinguishTargetId = action.id === 'extinguish-self' ? command.actor_id : actionTargetId
        const flames = (state.mechanics.conditions[extinguishTargetId] ?? []).find((condition) => String(condition?.id ?? condition) === 'searing-smite-flames')
        if (!flames) throw new RulesValidationError('На цели нет пламени «Пылающей кары»', 'SEARING_SMITE_NOT_ACTIVE')
        const sourceActorId = String(flames.source_actor ?? '')
        const sourceConcentration = state.mechanics.concentration[sourceActorId]
        if (flames.effect_id && String(sourceConcentration?.effect_id ?? '') === String(flames.effect_id)) {
          events.push(eventFrom(commandWithRules({ ...command, actor_id: sourceActorId }, RULE_IDS.concentration), 'ConcentrationEnded', { reason: 'extinguished', effect_id: flames.effect_id }, [sourceActorId]))
        } else events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: flames.id }, [extinguishTargetId]))
        events.push(actionEvent({ extinguished: true, target_id: extinguishTargetId }))
      } else if (action.id === 'dash' || action.id === 'expeditious-retreat-dash') {
        if (action.id === 'expeditious-retreat-dash' && !conditionIdsFor(state, command.actor_id).has('expeditious-retreat')) {
          throw new RulesValidationError('«Стремительный рывок» доступен только пока активно «Поспешное отступление»', 'EXPEDITIOUS_RETREAT_NOT_ACTIVE')
        }
        events.push(actionEvent({ movement_bonus: Math.max(0, safeInteger(actor?.speed, 30)) }))
      } else if (action.id === 'disengage' || action.id === 'dodge') {
        const condition = action.id === 'dodge' ? 'dodging' : 'disengaged'
        events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition, duration: 'until-next-turn' }, [command.actor_id]))
        events.push(actionEvent())
      } else if (action.id === 'hide') {
        const modifier = abilityModifier(actor?.abilities?.dex) + skillProficiencyBonus(actor, 'stealth')
        const check = diceService.rollCheck({ modifier, difficulty: 12, purpose: 'combat_hide', actorId: command.actor_id, visibility: command.visibility })
        rolls.push(check)
        events.push(eventFrom(commandWithRules(command, RULE_IDS.abilityCheck), 'AbilityCheckResolved', { ability: 'dex', skill: 'stealth', ...check }, [command.actor_id]))
        if (check.success) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: 'hidden', duration: 'until-next-turn' }, [command.actor_id]))
        events.push(actionEvent({ success: check.success }))
      } else if (action.id === 'help') {
        events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: 'helped', duration: 'until-used', source_actor: command.actor_id }, [actionTargetId]))
        events.push(actionEvent())
      } else if (action.id === 'stabilize') {
        if (!isUnstableDyingHero(state, actionTargetId)) throw new RulesValidationError('Стабилизация нужна только союзнику с 0 ОЗ, который ещё делает спасброски от смерти', 'STABILIZATION_NOT_REQUIRED')
        const difficulty = 10
        const modifier = abilityModifier(actor?.abilities?.wis) + skillProficiencyBonus(actor, 'medicine')
        const check = diceService.rollCheck({ modifier, difficulty, purpose: 'stabilize:medicine', actorId: command.actor_id, visibility: command.visibility })
        rolls.push(check)
        events.push(eventFrom(commandWithRules(command, RULE_IDS.abilityCheck), 'AbilityCheckResolved', { ability: 'wis', skill: 'medicine', ...check }, [actionTargetId]))
        if (check.success) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HeroStabilized', {
          hero_name: String(playerActor(state, actionTargetId)?.character ?? playerActor(state, actionTargetId)?.name ?? actionTargetId),
          method: 'medicine-check',
          difficulty,
          check_total: check.total,
        }, [actionTargetId]))
        events.push(actionEvent({ success: check.success, difficulty }))
      } else if (action.id === 'first-aid') {
        const rest = state.mechanics.resting[actionTargetId]
        if (rest?.reason !== 'knockout' || !conditionIdsFor(state, actionTargetId).has('unconscious')) {
          throw new RulesValidationError('Первая помощь нужна только нокаутированному существу', 'FIRST_AID_NOT_REQUIRED')
        }
        const difficulty = 10
        const modifier = abilityModifier(actor?.abilities?.wis) + skillProficiencyBonus(actor, 'medicine')
        const check = diceService.rollCheck({ modifier, difficulty, purpose: 'first-aid:medicine', actorId: command.actor_id, visibility: command.visibility })
        rolls.push(check)
        events.push(eventFrom(commandWithRules(command, RULE_IDS.abilityCheck), 'AbilityCheckResolved', { ability: 'wis', skill: 'medicine', ...check }, [actionTargetId]))
        if (check.success) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions, RULE_IDS.resource), 'KnockoutEnded', {
          reason: 'first-aid',
          difficulty,
          check_total: check.total,
        }, [actionTargetId]))
        events.push(actionEvent({ success: check.success, difficulty }))
      } else if (action.id === 'shove') {
        const target = findActor(state, actionTargetId)
        const attackerModifier = abilityModifier(actor?.abilities?.str) + skillProficiencyBonus(actor, 'athletics')
        const defenderModifier = Math.max(
          abilityModifier(target?.abilities?.str) + skillProficiencyBonus(target, 'athletics'),
          abilityModifier(target?.abilities?.dex) + skillProficiencyBonus(target, 'acrobatics'),
        )
        const attackerRoll = diceService.rollD20({ modifier: attackerModifier, purpose: 'shove:athletics', actorId: command.actor_id, visibility: command.visibility })
        const defenderRoll = diceService.rollD20({ modifier: defenderModifier, purpose: 'shove:defense', actorId: actionTargetId, visibility: command.visibility })
        rolls.push(attackerRoll, defenderRoll)
        events.push(eventFrom(command, 'ContestedCheckResolved', { attacker: attackerRoll, defender: defenderRoll, success: attackerRoll.total >= defenderRoll.total }, [actionTargetId]))
        if (attackerRoll.total >= defenderRoll.total) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: 'prone', duration: 'until-next-turn' }, [actionTargetId]))
        events.push(actionEvent({ success: attackerRoll.total >= defenderRoll.total }))
      } else if (action.id === 'second-wind') {
        const expression = diceExpression('1d10', Math.max(1, safeInteger(actor?.level, 1)), 10)
        const healingRoll = diceService.roll(expression, 'second_wind', command.actor_id, command.visibility ?? 'public')
        rolls.push(healingRoll)
        events.push(eventFrom(command, 'DieRolled', healingRoll, []))
        const healing = resolvedHealingRoll(state, command.actor_id, expression, healingRoll.total)
        const before = actorHp(actor)
        const after = Math.min(actorMaxHp(actor), before + healing.amount)
        spendActionResource()
        events.push(eventFrom(commandWithRules(command, RULE_IDS.healing), 'HealingApplied', { requested_amount: healing.amount, applied_amount: after - before, hp_before: before, hp_after: after, ...healing }, [command.actor_id]))
        events.push(actionEvent())
      } else if (action.id === 'action-surge') {
        spendActionResource()
        events.push(actionEvent({ restore_action: true, surged_action: true }))
      } else if (action.id === 'trip-attack' || action.id === 'menacing-attack') {
        const attackResult = resolveCommand({
          ...command,
          command_type: 'MakeAttack',
          target_id: actionTargetId,
          target_ids: [actionTargetId],
          source_rule_ids: [...new Set([...command.source_rule_ids, RULE_IDS.attack])],
        }, state, { diceService, context })
        const attackEvent = attackResult.events.find((event) => event.event_type === 'AttackResolved')
        const hit = Boolean(attackEvent?.payload?.hit)
        if (hit) {
          spendActionResource()
          const superiorityRoll = diceService.roll(attackEvent.payload.critical ? '2d8' : '1d8', `maneuver_damage:${action.id}`, command.actor_id, command.visibility ?? 'public')
          rolls.push(superiorityRoll)
          attackResult.events.push(eventFrom(command, 'DieRolled', superiorityRoll, []))
          const damageEvent = attackResult.events.find((event) => event.event_type === 'DamageApplied' && event.target_ids.includes(actionTargetId))
          if (damageEvent) {
            const resistance = damageEvent.payload.resistance_cantrip_reduction ? {
              reduction: damageEvent.payload.resistance_cantrip_reduction,
              condition_id: damageEvent.payload.resistance_cantrip_condition,
              turn_key: damageEvent.payload.resistance_cantrip_turn,
              roll_id: damageEvent.payload.resistance_cantrip_roll_id,
            } : null
            damageEvent.payload = { ...damagePayload(state, actionTargetId, safeInteger(damageEvent.payload.raw_amount, 0) + superiorityRoll.total, damageEvent.payload.damage_type, resistance), maneuver_id: action.id, superiority_damage: superiorityRoll.total }
          }
          const saveAbility = action.id === 'trip-attack' ? 'str' : 'wis'
          const target = findActor(state, actionTargetId)
          const dc = 8 + Math.max(0, safeInteger(actor?.proficiency, 0)) + Math.max(abilityModifier(actor?.abilities?.str), abilityModifier(actor?.abilities?.dex))
          const save = rollSavingThrowD20(state, diceService, actionTargetId, { modifier: abilityModifier(target?.abilities?.[saveAbility]), purpose: `maneuver_save:${action.id}`, visibility: command.visibility })
          rolls.push(save)
          const saved = save.total >= dc
          attackResult.events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow), 'SavingThrowResolved', { ability: saveAbility, difficulty: dc, saved, ...save }, [actionTargetId]))
          if (!saved) attackResult.events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: action.id === 'trip-attack' ? 'prone' : 'frightened', duration: 'until-next-turn' }, [actionTargetId]))
        }
        events.push(...attackResult.events, actionEvent({ hit, economy_consumed_by_attack: true }))
        rolls.push(...attackResult.rolls)
      } else if (action.id === 'hunters-mark') {
        spendActionResource()
        const previous = state.mechanics.concentration[command.actor_id]
        if (previous) events.push(eventFrom(commandWithRules(command, RULE_IDS.concentration), 'ConcentrationEnded', { reason: 'replaced', effect_id: previous.effect_id }, [command.actor_id]))
        for (const candidate of listActors(state)) {
          if (conditionIdsFor(state, actorId(candidate)).has(`hunters-mark:${command.actor_id}`)) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: `hunters-mark:${command.actor_id}` }, [actorId(candidate)]))
        }
        events.push(eventFrom(commandWithRules(command, RULE_IDS.concentration), 'ConcentrationStarted', { effect_id: `hunters-mark:${command.command_id}` }, [command.actor_id]))
        events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: `hunters-mark:${command.actor_id}`, duration: 'concentration', source_actor: command.actor_id }, [actionTargetId]))
        events.push(actionEvent())
      } else if (action.id === 'divine-spark') {
        const target = findActor(state, actionTargetId)
        const modifier = abilityModifier(actor?.abilities?.wis)
        const expression = diceExpression('1d8', modifier, 8)
        const healingRoll = diceService.roll(expression, 'divine_spark', command.actor_id, command.visibility ?? 'public')
        rolls.push(healingRoll)
        events.push(eventFrom(command, 'DieRolled', healingRoll, []))
        const healing = resolvedHealingRoll(state, actionTargetId, expression, healingRoll.total)
        const before = actorHp(target)
        const after = Math.min(actorMaxHp(target), before + healing.amount)
        spendActionResource()
        events.push(eventFrom(commandWithRules(command, RULE_IDS.healing), 'HealingApplied', { requested_amount: healing.amount, applied_amount: after - before, hp_before: before, hp_after: after, ...healing }, [actionTargetId]))
        events.push(actionEvent())
      } else if (action.effect?.kind === 'dash') {
        spendActionResource()
        if (action.effect.addCondition) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: action.effect.addCondition, duration: 'until-next-turn', source_actor: command.actor_id }, [command.actor_id]))
        events.push(actionEvent({ movement_bonus: Math.floor(Math.max(0, safeInteger(actor?.speed, 30)) * Number(action.effect.multiplier ?? 1)) }))
      } else if (action.effect?.kind === 'condition') {
        spendActionResource()
        const effectId = `${action.id}:${command.command_id}`
        if (action.concentration) {
          const previous = state.mechanics.concentration[command.actor_id]
          if (previous) events.push(eventFrom(commandWithRules(command, RULE_IDS.concentration), 'ConcentrationEnded', { reason: 'replaced', effect_id: previous.effect_id }, [command.actor_id]))
          events.push(eventFrom(commandWithRules(command, RULE_IDS.concentration), 'ConcentrationStarted', { effect_id: effectId }, [command.actor_id]))
        }
        events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: action.effect.condition, duration: action.effect.duration ?? null, source_actor: command.actor_id, effect_id: effectId }, [actionTargetId]))
        events.push(actionEvent())
      } else if (action.effect?.kind === 'check') {
        spendActionResource()
        const ability = String(action.effect.ability ?? 'wis')
        const modifier = abilityModifier(actor?.abilities?.[ability]) + skillProficiencyBonus(actor, action.effect.skill)
        const check = diceService.rollCheck({ modifier, difficulty: safeInteger(action.effect.difficulty, 12), purpose: `combat_check:${action.id}`, actorId: command.actor_id, visibility: command.visibility })
        rolls.push(check)
        events.push(eventFrom(commandWithRules(command, RULE_IDS.abilityCheck), 'AbilityCheckResolved', { ability, skill: action.effect.skill, ...check }, [command.actor_id]))
        if (check.success && action.effect.skill === 'stealth') events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: 'hidden', duration: 'until-next-turn' }, [command.actor_id]))
        events.push(actionEvent({ success: check.success }))
      } else if (action.effect?.kind === 'contest') {
        spendActionResource()
        const target = findActor(state, actionTargetId)
        const attackerRoll = diceService.rollD20({ modifier: abilityModifier(actor?.abilities?.str) + skillProficiencyBonus(actor, 'athletics'), purpose: `${action.id}:athletics`, actorId: command.actor_id, visibility: command.visibility })
        const defenderRoll = diceService.rollD20({ modifier: Math.max(abilityModifier(target?.abilities?.str) + skillProficiencyBonus(target, 'athletics'), abilityModifier(target?.abilities?.dex) + skillProficiencyBonus(target, 'acrobatics')), purpose: `${action.id}:defense`, actorId: actionTargetId, visibility: command.visibility })
        rolls.push(attackerRoll, defenderRoll)
        const success = attackerRoll.total >= defenderRoll.total
        events.push(eventFrom(commandWithRules(command, RULE_IDS.abilityCheck), 'ContestedCheckResolved', { attacker: attackerRoll, defender: defenderRoll, success }, [actionTargetId]))
        if (success) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: action.effect.condition, duration: action.effect.condition === 'grappled' ? null : 'until-next-turn', source_actor: command.actor_id }, [actionTargetId]))
        events.push(actionEvent({ success }))
      } else if (action.effect?.kind === 'heal') {
        const target = findActor(state, actionTargetId)
        const bonus = (action.effect.addLevel ? Math.max(1, safeInteger(actor?.level, 1)) : 0)
          + (action.effect.addProficiency ? Math.max(0, safeInteger(actor?.proficiency, 0)) : 0)
          + (action.effect.ability ? abilityModifier(actor?.abilities?.[action.effect.ability]) : 0)
        let amount = Math.max(0, safeInteger(action.effect.amount, 0) + bonus)
        let healing = { amount }
        if (action.effect.dice) {
          const expression = diceExpression(action.effect.dice, bonus, 8)
          const healingRoll = diceService.roll(expression, `action_healing:${action.id}`, command.actor_id, command.visibility ?? 'public')
          rolls.push(healingRoll)
          events.push(eventFrom(command, 'DieRolled', healingRoll, []))
          healing = resolvedHealingRoll(state, actionTargetId, expression, healingRoll.total)
          amount = healing.amount
        }
        const before = actorHp(target)
        const after = Math.min(actorMaxHp(target), before + amount)
        spendActionResource()
        events.push(eventFrom(commandWithRules(command, RULE_IDS.healing), 'HealingApplied', { requested_amount: amount, applied_amount: after - before, hp_before: before, hp_after: after, ...healing }, [actionTargetId]))
        events.push(actionEvent())
      } else if (action.effect?.kind === 'weapon_attack') {
        spendActionResource()
        const level = Math.max(1, safeInteger(actor?.level, 1))
        const tier = Object.entries(action.effect.attacksByLevel ?? {}).sort(([left], [right]) => Number(right) - Number(left)).find(([minimum]) => level >= Number(minimum))
        const attacks = Math.max(1, safeInteger(tier?.[1] ?? action.effect.attacks, 1))
        let workingState = state
        let landed = false
        for (let index = 0; index < attacks; index += 1) {
          if (!isLivingActor(findActor(workingState, actionTargetId))) break
          const attackResult = resolveCommand({
            ...command,
            command_id: `${command.command_id}:attack:${index + 1}`,
            expected_state_version: workingState.state_version,
            command_type: 'MakeAttack',
            target_id: actionTargetId,
            target_ids: [actionTargetId],
            item_id: action.effect.unarmed ? undefined : command.item_id,
            source_rule_ids: [...new Set([...command.source_rule_ids, RULE_IDS.attack])],
          }, workingState, { diceService, context })
          const attackEvent = attackResult.events.find((event) => event.event_type === 'AttackResolved')
          const hit = Boolean(attackEvent?.payload?.hit)
          landed ||= hit
          if (hit) {
            let extraExpression = action.effect.extraDamage
            if (action.effect.extraDamageByLevel === 'sneak') extraExpression = `${Math.ceil(level / 2)}d6`
            if (extraExpression) {
              const extraRoll = diceService.roll(attackEvent.payload.critical ? criticalDamageExpression(extraExpression) : extraExpression, `action_damage:${action.id}`, command.actor_id, command.visibility ?? 'public')
              rolls.push(extraRoll)
              attackResult.events.push(eventFrom(command, 'DieRolled', extraRoll, []))
              const damageEvent = attackResult.events.find((event) => event.event_type === 'DamageApplied' && event.target_ids.includes(actionTargetId))
              if (damageEvent) {
                const resistance = damageEvent.payload.resistance_cantrip_reduction ? {
                  reduction: damageEvent.payload.resistance_cantrip_reduction,
                  condition_id: damageEvent.payload.resistance_cantrip_condition,
                  turn_key: damageEvent.payload.resistance_cantrip_turn,
                  roll_id: damageEvent.payload.resistance_cantrip_roll_id,
                } : null
                damageEvent.payload = { ...damagePayload(workingState, actionTargetId, safeInteger(damageEvent.payload.raw_amount, 0) + extraRoll.total, action.effect.damageType ?? damageEvent.payload.damage_type, resistance), action_id: action.id, extra_damage: extraRoll.total }
              }
            }
            if (action.effect.saveAbility && action.effect.condition) {
              const target = findActor(workingState, actionTargetId)
              const saveAbility = action.effect.saveAbility
              const dc = 8 + Math.max(0, safeInteger(actor?.proficiency, 0)) + Math.max(abilityModifier(actor?.abilities?.str), abilityModifier(actor?.abilities?.dex))
              const save = rollSavingThrowD20(workingState, diceService, actionTargetId, { modifier: abilityModifier(target?.abilities?.[saveAbility]), purpose: `action_save:${action.id}`, visibility: command.visibility })
              rolls.push(save)
              const saved = save.total >= dc
              attackResult.events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow), 'SavingThrowResolved', { ability: saveAbility, difficulty: dc, saved, ...save }, [actionTargetId]))
              if (!saved) attackResult.events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: action.effect.condition, duration: 'until-next-turn', source_actor: command.actor_id }, [actionTargetId]))
            } else if (action.effect.condition) {
              attackResult.events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: action.effect.condition, duration: 'until-next-turn', source_actor: command.actor_id }, [actionTargetId]))
            }
          }
          events.push(...attackResult.events)
          rolls.push(...attackResult.rolls)
          workingState = replayEvents(workingState, attackResult.events)
          if (workingState.mechanics.combat.action_economy[command.actor_id]) workingState.mechanics.combat.action_economy[command.actor_id].action = true
        }
        events.push(actionEvent({ hit: landed, attacks, economy_consumed_by_attack: true }))
      } else if (action.effect?.kind === 'save') {
        const target = findActor(state, actionTargetId)
        const saveAbility = String(action.effect.saveAbility ?? 'wis')
        const dc = 8 + Math.max(0, safeInteger(actor?.proficiency, 0)) + Math.max(abilityModifier(actor?.abilities?.wis), abilityModifier(actor?.abilities?.cha))
        const save = rollSavingThrowD20(state, diceService, actionTargetId, { modifier: abilityModifier(target?.abilities?.[saveAbility]), purpose: `action_save:${action.id}`, visibility: command.visibility })
        rolls.push(save)
        const saved = save.total >= dc
        spendActionResource()
        events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow), 'SavingThrowResolved', { ability: saveAbility, difficulty: dc, saved, ...save }, [actionTargetId]))
        if (!saved && action.effect.condition) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: action.effect.condition, duration: action.effect.duration ?? 'until-next-turn', source_actor: command.actor_id }, [actionTargetId]))
        events.push(actionEvent({ success: !saved }))
      } else if (action.effect?.kind === 'cleanse') {
        for (const condition of action.effect.conditions ?? []) if (conditionIdsFor(state, command.actor_id).has(condition)) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition }, [command.actor_id]))
        events.push(actionEvent())
      } else if (action.effect?.kind === 'restore_action') {
        spendActionResource()
        events.push(actionEvent({ restore_action: true, surged_action: true }))
      } else if (action.effect?.kind === 'restore_resource') {
        spendActionResource()
        const pool = resourcePool(state, command.actor_id, action.effect.resource)
        const amount = Math.max(1, safeInteger(action.effect.amount, 1))
        events.push(eventFrom(commandWithRules(command, RULE_IDS.resource), 'ResourceRestored', { resource: action.effect.resource, amount, before: pool.current, after: Math.min(pool.max, pool.current + amount), max: pool.max }, [command.actor_id]))
        events.push(actionEvent())
      } else if (action.effect?.kind === 'percent_check') {
        const check = diceService.roll('1d100', `percent_check:${action.id}`, command.actor_id, command.visibility ?? 'public')
        rolls.push(check)
        events.push(eventFrom(command, 'DieRolled', check, []), actionEvent({ success: check.total <= Math.max(1, safeInteger(actor?.level, 1)), roll: check.total }))
      } else if (action.effect?.kind === 'special') {
        events.push(actionEvent())
      } else {
        throw new RulesValidationError('Для действия нет серверного обработчика', 'COMBAT_ACTION_NOT_IMPLEMENTED')
      }
      break
    }
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
        if (!command.counterspell_bypassed) {
          const reaction = counterspellReactionFor(state, command.actor_id)
          if (reaction) {
            const option = {
              id: 'cast:counterspell',
              name: reaction.spell.name,
              description: reaction.spell.description,
              resource: reaction.slot.resource,
              slot_level: reaction.slot.level,
              cost: 1,
              spell_id: reaction.spell.id,
            }
            events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction), 'ReactionWindowOpened', {
              id: `reaction:${command.command_id}:counterspell`,
              trigger: 'spell-cast',
              actor_id: actorId(reaction.actor),
              source_actor_id: command.actor_id,
              target_id: command.actor_id,
              action_ids: [option.id],
              action_options: [option],
              pending_spell_command: clone(command),
              pending_spell: { id: spell.id, name: spell.name, level: spell.level, slot_level: command.slot_level ?? spell.level, source_url: spell.sourceUrl },
              damage: null,
            }, [actorId(reaction.actor)]))
            break
          }
        }
        const spellAbility = String(spell.spellcastingAbility || 'int')
        const spellModifier = abilityModifier(actor?.abilities?.[spellAbility])
        const spellAttackModifier = spellModifier + Math.max(0, safeInteger(actor?.proficiency, 0))
        const spellSaveDc = 8 + spellAttackModifier
        const effectId = `${spell.id}:${command.command_id}`
        const spentSlotResource = command.spell_slot_resource ?? spell.slotResource
        if (spentSlotResource) {
          const pool = resourcePool(state, command.actor_id, spentSlotResource)
          events.push(eventFrom(commandWithRules(command, RULE_IDS.resource), 'ResourceSpent', {
            resource: spentSlotResource, amount: 1, before: pool.current, after: pool.current - 1, max: pool.max,
          }, [command.actor_id]))
        }
        const previous = state.mechanics.concentration[command.actor_id]
        if (spell.concentration && previous) {
          events.push(eventFrom(commandWithRules(command, RULE_IDS.concentration), 'ConcentrationEnded', { reason: 'replaced', effect_id: previous.effect_id }, [command.actor_id]))
          for (const summon of state.actors.filter((candidate) => isPartySummon(candidate) && String(candidate.sourceEffectId ?? candidate.source_effect_id ?? '') === String(previous.effect_id))) {
            events.push(eventFrom(commandWithRules(command, RULE_IDS.concentration), 'SummonedCreatureDismissed', { reason: 'concentration_replaced' }, [actorId(summon)]))
          }
        }
        const affected = spellTargetsAt(state, command, spell)
        const affectedIds = affected.map(actorId)
        const woundedTarget = affected[0] && actorHp(affected[0]) < actorMaxHp(affected[0])
        const baseDamageExpression = woundedTarget && spell.damageIfTargetWounded ? spell.damageIfTargetWounded : spell.damage
        const damageExpression = scaledSpellDice({ ...spell, damage: baseDamageExpression }, actor, command.slot_level) ?? (['attack', 'save', 'area-save', 'damage', 'area-damage'].includes(spell.kind) && baseDamageExpression ? `${Math.max(1, spell.level + 1)}d6` : null)
        const metamagic = conditionIdsFor(state, command.actor_id)
        const allowedTransmutedTypes = new Set(['acid', 'cold', 'fire', 'lightning', 'poison', 'thunder'])
        const requestedTransmutedType = String(command.transmuted_damage_type ?? '')
        const selectedDamageType = (spell.spellOptions ?? []).includes(String(command.spell_option ?? ''))
          && allowedTransmutedTypes.has(String(command.spell_option))
          ? String(command.spell_option)
          : null
        const damageType = metamagic.has('metamagic-transmuted') && allowedTransmutedTypes.has(requestedTransmutedType)
          ? requestedTransmutedType
          : selectedDamageType ?? spell.damageType ?? spell.damageTypes?.[0] ?? 'force'
        const effectiveRange = metamagic.has('metamagic-distant') && spell.range > 0 ? spell.range * 2 : spell.range
        const effectiveActionType = metamagic.has('metamagic-quickened') && spell.actionType === 'action' ? 'bonus_action' : spell.actionType
        events.push(eventFrom(command, 'SpellCast', {
          spell_id: spell.id,
          name: spell.name,
          kind: spell.kind,
          action_type: effectiveActionType,
          level: spell.level,
          slot_level: command.slot_level ?? spell.level,
          range_feet: effectiveRange,
          concentration: Boolean(spell.concentration),
          source_url: spell.sourceUrl,
          spell_option: command.spell_option ?? null,
          damage_type: damageType,
        }, affectedIds.length ? affectedIds : command.target_ids))
        for (const condition of ['metamagic-careful', 'metamagic-distant', 'metamagic-empowered', 'metamagic-extended', 'metamagic-heightened', 'metamagic-quickened', 'metamagic-seeking', 'metamagic-subtle', 'metamagic-transmuted', 'metamagic-twinned']) {
          if (metamagic.has(condition)) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition }, [command.actor_id]))
        }
        if (spell.concentration) events.push(eventFrom(commandWithRules(command, RULE_IDS.concentration), 'ConcentrationStarted', { effect_id: effectId }, [command.actor_id]))
        if (spell.nextWeaponHit) {
          events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', {
            condition: `next-weapon-hit:${spell.id}`,
            duration: spell.concentration ? 'concentration' : spell.durationRounds ? `rounds:${spell.durationRounds}` : 'until-used',
            source_actor: command.actor_id,
            effect_id: effectId,
            spell_id: spell.id,
            save_dc: spellSaveDc,
            slot_level: Math.max(spell.level, safeInteger(command.slot_level, spell.level)),
          }, [command.actor_id]))
        }
        if (spell.grantsDashOnCast) events.push(eventFrom(commandWithRules(command, RULE_IDS.turns), 'CombatActionUsed', {
          action_id: `${spell.id}:initial-dash`, name: spell.name, action_type: 'free', movement_bonus: Math.max(0, safeInteger(actor?.speed, 30)),
        }, [command.actor_id]))
        const spellAreaCenter = spell.createsAreaEffect
          ? (spell.areaOrigin === 'self' || spell.target === 'self' ? actorPosition(state, command.actor_id) : command.to)
          : null
        if (spell.createsAreaEffect && spellAreaCenter) {
          events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'SpellAreaCreated', {
            effect: {
              id: effectId,
              effect_id: effectId,
              spell_id: spell.id,
              source_actor: command.actor_id,
              center: { x: Number(spellAreaCenter.x), y: Number(spellAreaCenter.y) },
              radius_feet: Math.max(0, safeInteger(spell.radius, 5)),
              area_shape: spell.areaShape ?? 'sphere',
              difficult_terrain: spell.createsAreaEffect.difficultTerrain === true,
              trigger_on_enter: spell.createsAreaEffect.triggerOnEnter === true,
              trigger_on_turn_end: spell.createsAreaEffect.triggerOnTurnEnd === true,
              save_ability: spell.createsAreaEffect.saveAbility ?? spell.saveAbility ?? null,
              save_dc: spellSaveDc,
              condition: spell.createsAreaEffect.condition ?? null,
              concentration: Boolean(spell.concentration),
              expires_round: spell.createsAreaEffect.permanent === true
                ? Number.MAX_SAFE_INTEGER
                : safeInteger(state.mechanics.combat.round, 1) + Math.max(1, safeInteger(spell.durationRounds, 1)),
            },
          }, []))
        }

        if (spell.id === 'magic-missile') {
          const target = affected[0]
          const resolvedTargetId = actorId(target)
          const slotLevel = Math.max(spell.level, safeInteger(command.slot_level, spell.level))
          const projectileCount = Math.max(1, safeInteger(spell.projectileCount, 3) + Math.max(0, slotLevel - spell.level) * Math.max(0, safeInteger(spell.upcastProjectilesPerLevel, 1)))
          const protectedByShield = conditionIdsFor(state, resolvedTargetId).has('shielded')
          const missileRoll = diceService.roll(String(spell.damage || '1d4+1'), `spell_damage:${spell.id}`, command.actor_id, command.visibility ?? 'public')
          rolls.push(missileRoll)
          events.push(eventFrom(command, 'DieRolled', { ...missileRoll, projectile_count: projectileCount }, []))
          const payload = resolveDamagePayload(state, resolvedTargetId, protectedByShield ? 0 : missileRoll.total * projectileCount, damageType)
          events.push(eventFrom(commandWithRules(command, RULE_IDS.damage), 'DamageApplied', {
            ...payload,
            spell_id: spell.id,
            projectile_count: projectileCount,
            damage_per_projectile: missileRoll.total,
            blocked_by_shield: protectedByShield,
            automatic_hit: true,
          }, [resolvedTargetId]))
          if (!protectedByShield && !isEnemyActor(state, resolvedTargetId) && payload.hp_after > 0 && state.mechanics.combat.action_economy[resolvedTargetId]?.reaction !== false) {
            const shield = combatSpellsFor(target).find((candidate) => candidate.id === 'shield' && candidate.prepared !== false)
            const shieldSlot = shield ? chooseSpellSlot(state, resolvedTargetId, shield) : null
            if (shield && shieldSlot) {
              const option = { id: 'cast:shield', name: shield.name, description: shield.description, resource: shieldSlot.resource, slot_level: shieldSlot.level, cost: 1, spell_id: shield.id }
              events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction), 'ReactionWindowOpened', {
                id: `reaction:${command.command_id}:magic-missile`,
                trigger: 'magic-missile-targeted',
                actor_id: resolvedTargetId,
                source_actor_id: command.actor_id,
                target_id: resolvedTargetId,
                action_ids: [option.id],
                action_options: [option],
                damage: { ...payload, spell_id: spell.id },
                trigger_roll: null,
              }, [resolvedTargetId]))
            }
          }
          if (payload.hp_after === 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HitPointsReducedToZero', { condition: 'unconscious' }, [resolvedTargetId]))
        } else if (spell.hitPointPoolDice) {
          const poolExpression = spellHpPoolExpression(spell.hitPointPoolDice || '5d8', spell.hitPointPoolUpcastDice || '2d8', spell.level, command.slot_level)
          const poolRoll = diceService.roll(poolExpression, `spell_pool:${spell.id}`, command.actor_id, command.visibility ?? 'public')
          rolls.push(poolRoll)
          events.push(eventFrom(command, 'DieRolled', { ...poolRoll, hit_point_pool: true }, []))
          let remaining = poolRoll.total
          const eligible = [...affected]
            .filter((candidate) => {
              const conditions = conditionIdsFor(state, actorId(candidate))
              if (conditions.has('unconscious')) return false
              if (spell.id === 'sleep' && immuneToMagicalSleep(state, candidate)) return false
              if (spell.id === 'color-spray' && (conditions.has('blinded') || conditions.has('cannot-see'))) return false
              return true
            })
            .sort((left, right) => actorHp(left) - actorHp(right) || actorId(left).localeCompare(actorId(right)))
          for (const target of eligible) {
            const hp = actorHp(target)
            if (hp > remaining) continue
            remaining -= hp
            const resolvedTargetId = actorId(target)
            if (spell.id === 'sleep') {
              events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: 'magical-sleep', duration: `rounds:${spell.durationRounds ?? 10}`, source_actor: command.actor_id, effect_id: effectId }, [resolvedTargetId]))
              events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: 'unconscious', duration: `rounds:${spell.durationRounds ?? 10}`, source_actor: command.actor_id, effect_id: effectId }, [resolvedTargetId]))
            } else for (const condition of spell.conditions ?? []) {
              events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition, duration: 'source-turns:2', source_actor: command.actor_id, effect_id: effectId }, [resolvedTargetId]))
            }
          }
        } else if (spell.kind === 'attack') {
          const target = affected[0]
          const resolvedTargetId = actorId(target)
          const equippedMelee = spell.requiresWeaponAttack ? (actor?.inventory ?? []).find((item) => item?.equipped && item?.combat?.kind === 'melee' && Number(item?.quantity ?? 1) > 0) : null
          const weaponProfile = equippedMelee ? itemAttackProfile(state, actor, equippedMelee.id) : spell.requiresWeaponAttack ? trustedAttackProfile(state, actor) : null
          if (spell.requiresWeaponAttack && (!weaponProfile || weaponProfile.kind !== 'melee')) throw new RulesValidationError('Для этого заговора требуется экипированное рукопашное оружие', 'MELEE_WEAPON_REQUIRED')
          const armorClass = effectiveArmorClass(state, target, resolvedTargetId)
          const spellAttackConditions = conditionIdsFor(state, command.actor_id)
          const compelledAgainstOther = (state.mechanics.conditions[command.actor_id] ?? []).some((condition) => String(condition?.id ?? condition) === 'compelled-duel' && String(condition.source_actor ?? '') !== resolvedTargetId)
          const attackDisadvantage = spellAttackConditions.has('disadvantage-next-attack') || spellAttackConditions.has('frightened') || compelledAgainstOther
          const trueStrike = spellAttackConditions.has('true-strike')
          const silveryFortune = spellAttackConditions.has('silvery-fortune')
          const targetAttackConditions = conditionIdsFor(state, resolvedTargetId)
          const guidingBoltAdvantage = targetAttackConditions.has('guiding-bolt-advantage')
          const faerieFireAdvantage = targetAttackConditions.has('faerie-fire')
          let effectiveAttackModifier = weaponProfile?.modifier ?? spellAttackModifier
          if (spellAttackConditions.has('bless-d4')) {
            const blessing = diceService.roll('1d4', 'spell:bless:attack', command.actor_id, command.visibility ?? 'public')
            rolls.push(blessing)
            events.push(eventFrom(command, 'DieRolled', blessing, []))
            effectiveAttackModifier += blessing.total
          }
          if (spellAttackConditions.has('bane-d4')) {
            const bane = diceService.roll('1d4', 'spell:bane:attack', command.actor_id, command.visibility ?? 'public')
            rolls.push(bane)
            events.push(eventFrom(command, 'DieRolled', bane, []))
            effectiveAttackModifier -= bane.total
          }
          const attack = diceService.rollD20({ modifier: effectiveAttackModifier, purpose: `spell_attack:${spell.id}`, actorId: command.actor_id, advantage: metamagic.has('metamagic-seeking') || trueStrike || silveryFortune || guidingBoltAdvantage || faerieFireAdvantage, disadvantage: attackDisadvantage, visibility: command.visibility })
          const hit = attack.kept === 20 || (attack.kept !== 1 && attack.total >= armorClass)
          rolls.push(attack)
          const spellCommand = commandWithRules(command, RULE_IDS.attack, RULE_IDS.armorClass, attack.kept === 20 ? RULE_IDS.criticalHit : null)
          events.push(eventFrom(spellCommand, 'AttackResolved', {
            ...attack, target_id: resolvedTargetId, armor_class: armorClass, hit, critical: attack.kept === 20,
            range_feet: effectiveRange, damage_expression: weaponProfile?.damage_expression ?? damageExpression, damage_type: weaponProfile?.damage_type ?? damageType,
            spell_id: spell.id, spell_name: spell.name,
          }, [resolvedTargetId]))
          if (attackDisadvantage) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'disadvantage-next-attack' }, [command.actor_id]))
          if (trueStrike) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'true-strike' }, [command.actor_id]))
          if (silveryFortune) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'silvery-fortune' }, [command.actor_id]))
          if (guidingBoltAdvantage) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'guiding-bolt-advantage' }, [resolvedTargetId]))
          if (hit) {
            const cantripLevel = Math.max(1, safeInteger(actor?.level, 1))
            const weaponCantripDice = cantripLevel >= 11 ? 2 : cantripLevel >= 5 ? 1 : 0
            const components = weaponProfile
              ? [
                  { expression: weaponProfile.damage_expression, amount: weaponProfile.damage_amount, type: weaponProfile.damage_type, purpose: `weapon_cantrip:${spell.id}:weapon` },
                  ...(weaponCantripDice > 0 ? [{ expression: `${weaponCantripDice}d8`, amount: null, type: damageType, purpose: `weapon_cantrip:${spell.id}:magic` }] : []),
                  ...(targetAttackConditions.has(`hexed:${command.actor_id}`) ? [{ expression: '1d6', amount: null, type: 'necrotic', purpose: 'spell:hex:damage' }] : []),
                ]
              : [
                  { expression: damageExpression, amount: null, type: damageType, purpose: `spell_damage:${spell.id}` },
                  ...(targetAttackConditions.has(`hexed:${command.actor_id}`) ? [{ expression: '1d6', amount: null, type: 'necrotic', purpose: 'spell:hex:damage' }] : []),
                ]
            let transientState = state
            const outcomes = []
            let knockedOut = false
            for (const component of components.filter((entry) => entry.expression || entry.amount != null)) {
              const expression = component.expression && attack.kept === 20 ? criticalDamageExpression(component.expression) : component.expression
              const damageRoll = expression ? diceService.roll(expression, component.purpose, command.actor_id, command.visibility ?? 'public') : null
              if (damageRoll) {
                rolls.push(damageRoll)
                events.push(eventFrom(command, 'DieRolled', damageRoll, []))
              }
              let payload = resolveDamagePayload(transientState, resolvedTargetId, damageRoll?.total ?? component.amount ?? 0, component.type)
              if (command.knock_out === true && spell.attackKind === 'melee' && payload.hp_before > 0 && payload.hp_after === 0) {
                payload = {
                  ...payload,
                  hp_after: 1,
                  applied_amount: Math.max(0, payload.hp_before - 1),
                  knocked_out: true,
                }
                knockedOut = true
              }
              const damageEvent = eventFrom(commandWithRules(command, RULE_IDS.damage), 'DamageApplied', { ...payload, spell_id: spell.id }, [resolvedTargetId])
              events.push(damageEvent)
              outcomes.push(payload)
              transientState = applyGameEvent(transientState, damageEvent)
              if (knockedOut) break
            }
            const firstOutcome = outcomes[0]
            const lastOutcome = outcomes.at(-1)
            const damageOutcome = outcomes.length ? {
              damage_type: outcomes.length === 1 ? firstOutcome.damage_type : 'mixed',
              raw_amount: outcomes.reduce((total, entry) => total + entry.raw_amount, 0),
              applied_amount: outcomes.reduce((total, entry) => total + entry.applied_amount, 0),
              temporary_hp_absorbed: outcomes.reduce((total, entry) => total + entry.temporary_hp_absorbed, 0),
              temporary_hp_before: firstOutcome.temporary_hp_before,
              temporary_hp_after: lastOutcome.temporary_hp_after,
              hp_before: firstOutcome.hp_before,
              hp_after: lastOutcome.hp_after,
              resistant: outcomes.every((entry) => entry.resistant),
            } : null
            if (knockedOut) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp, RULE_IDS.conditions, RULE_IDS.resource), 'CreatureKnockedOut', {
              condition: 'unconscious',
              rest_kind: 'short',
              recovery_minutes: 60,
              attack_kind: 'melee-spell',
              spell_id: spell.id,
            }, [resolvedTargetId]))
            if (damageOutcome?.hp_after === 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HitPointsReducedToZero', { condition: 'unconscious' }, [resolvedTargetId]))
            if (spell.weaponCantrip === 'booming-blade') {
              const moveDice = cantripLevel >= 11 ? 3 : cantripLevel >= 5 ? 2 : 1
              events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: `booming-blade-move:${moveDice}d8`, duration: 'until-next-turn', source_actor: command.actor_id, effect_id: effectId }, [resolvedTargetId]))
            }
            if (spell.weaponCantrip === 'green-flame-blade') {
              const targetAt = actorPosition(state, resolvedTargetId)
              const secondTarget = targetAt ? listActors(state)
                .filter((candidate) => actorId(candidate) !== resolvedTargetId && actorId(candidate) !== command.actor_id && isLivingActor(candidate))
                .filter((candidate) => isEnemyActor(state, actorId(candidate)) !== isEnemyActor(state, command.actor_id))
                .filter((candidate) => {
                  const at = actorPosition(state, actorId(candidate))
                  return at && Math.max(Math.abs(at.x - targetAt.x), Math.abs(at.y - targetAt.y)) === 1
                })
                .sort((left, right) => actorId(left).localeCompare(actorId(right)))[0] : null
              if (secondTarget) {
                const fireDice = cantripLevel >= 11 ? 2 : cantripLevel >= 5 ? 1 : 0
                const expression = fireDice > 0 ? `${fireDice}d8${spellModifier >= 0 ? '+' : ''}${spellModifier}` : null
                const fireRoll = expression ? diceService.roll(expression, 'weapon_cantrip:green-flame-blade:bounce', command.actor_id, command.visibility ?? 'public') : null
                if (fireRoll) {
                  rolls.push(fireRoll)
                  events.push(eventFrom(command, 'DieRolled', fireRoll, []))
                }
                const rawFire = fireRoll?.total ?? Math.max(0, spellModifier)
              const firePayload = resolveDamagePayload(state, actorId(secondTarget), rawFire, 'fire')
                events.push(eventFrom(commandWithRules(command, RULE_IDS.damage), 'DamageApplied', { ...firePayload, spell_id: spell.id, secondary: true }, [actorId(secondTarget)]))
                if (firePayload.hp_after === 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HitPointsReducedToZero', { condition: 'unconscious' }, [actorId(secondTarget)]))
              }
            }
            if (spell.onHitSaveAbility) {
              const ability = String(spell.onHitSaveAbility)
              const savingTarget = findActor(events.reduce(applyGameEvent, state), resolvedTargetId)
              if (isLivingActor(savingTarget)) {
                const savingState = events.reduce(applyGameEvent, state)
                const save = rollSavingThrowD20(savingState, diceService, resolvedTargetId, { modifier: abilityModifier(savingTarget?.abilities?.[ability]), purpose: `spell_on_hit_save:${spell.id}:${ability}`, visibility: command.visibility })
                const saved = save.total >= spellSaveDc
                rolls.push(save)
                events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow), 'SpellSavingThrowResolved', { ...save, spell_id: spell.id, ability, difficulty: spellSaveDc, saved, trigger: 'on-hit' }, [resolvedTargetId]))
                if (!saved) for (const condition of spell.onHitConditions ?? []) {
                  events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition, duration: spell.onHitConditionDuration ?? 'until-next-turn', source_actor: command.actor_id, effect_id: effectId }, [resolvedTargetId]))
                }
              }
            }
            for (const condition of spell.conditions ?? []) {
              events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition, duration: spell.durationRounds ? `rounds:${spell.durationRounds}` : 'until-next-turn', source_actor: command.actor_id, effect_id: effectId }, [resolvedTargetId]))
            }
            if (!isEnemyActor(state, resolvedTargetId) && damageOutcome?.hp_after > 0) {
              const distanceFeet = distanceBetweenActors(state, command.actor_id, resolvedTargetId)
              const actionOptions = reactionOptionsAfterAttack(state, target, {
                hit,
                attackTotal: attack.total,
                armorClass,
                damage: damageOutcome,
                distanceFeet,
                allowParry: distanceFeet == null || distanceFeet <= 5,
              })
              let reactionActorId = resolvedTargetId
              const silvery = silveryBarbsReactionFor(state, command.actor_id, resolvedTargetId)
              if (silvery && (actorId(silvery.actor) === resolvedTargetId || actionOptions.length === 0)) {
                reactionActorId = actorId(silvery.actor)
                actionOptions.push({ id: 'cast:silvery-barbs', name: silvery.spell.name, description: silvery.spell.description, resource: silvery.slot.resource, slot_level: silvery.slot.level, cost: 1, spell_id: silvery.spell.id, requires_beneficiary: true })
              }
              const reactionEconomy = state.mechanics.combat.action_economy[reactionActorId]
              if (reactionEconomy?.reaction !== false && actionOptions.length) events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction), 'ReactionWindowOpened', {
                id: `reaction:${command.command_id}`,
                trigger: 'spell-attack-hit',
                actor_id: reactionActorId,
                source_actor_id: command.actor_id,
                target_id: resolvedTargetId,
                action_ids: actionOptions.map((candidate) => candidate.id),
                action_options: actionOptions,
                damage: damageOutcome,
                trigger_roll: { kept: attack.kept, modifier: attack.modifier, total: attack.total, armor_class: armorClass, hit, critical: attack.kept === 20 },
              }, [reactionActorId]))
            }
          }
          if (spell.secondaryBurst) {
            const burst = spell.secondaryBurst
            let burstDamageExpression = String(burst.damage || '1d6')
            try {
              const parsed = parseDiceExpression(burstDamageExpression)
              const slotLevel = Math.max(spell.level, safeInteger(command.slot_level, spell.level))
              const count = parsed.count + Math.max(0, slotLevel - spell.level) * Math.max(0, safeInteger(burst.upcastDicePerLevel, 0))
              burstDamageExpression = `${count}d${parsed.sides}${parsed.modifier > 0 ? `+${parsed.modifier}` : parsed.modifier < 0 ? parsed.modifier : ''}`
            } catch {}
            const burstRoll = diceService.roll(burstDamageExpression, `spell_secondary_burst:${spell.id}`, command.actor_id, command.visibility ?? 'public')
            rolls.push(burstRoll)
            events.push(eventFrom(command, 'DieRolled', { ...burstRoll, secondary_burst: true, spell_id: spell.id }, []))
            let burstState = events.reduce(applyGameEvent, state)
            const center = actorPosition(burstState, resolvedTargetId) ?? actorPosition(state, resolvedTargetId)
            const burstTargets = listActors(burstState).filter((candidate) => {
              const at = actorPosition(burstState, actorId(candidate))
              return at && center && Math.max(Math.abs(at.x - center.x), Math.abs(at.y - center.y)) * 5 <= Math.max(0, safeInteger(burst.radius, 5))
                && (isLivingActor(candidate) || actorId(candidate) === resolvedTargetId)
            })
            for (const burstTarget of burstTargets) {
              const burstTargetId = actorId(burstTarget)
              const ability = String(burst.saveAbility || 'dex')
              const save = rollSavingThrowD20(burstState, diceService, burstTargetId, { modifier: abilityModifier(burstTarget?.abilities?.[ability]), purpose: `spell_secondary_save:${spell.id}:${ability}`, visibility: command.visibility })
              const saved = save.total >= spellSaveDc
              rolls.push(save)
              events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow), 'SpellSavingThrowResolved', { ...save, spell_id: spell.id, ability, difficulty: spellSaveDc, saved, trigger: 'secondary-burst' }, [burstTargetId]))
              const raw = saved ? (burst.halfOnSave ? Math.floor(burstRoll.total / 2) : 0) : burstRoll.total
              if (raw <= 0) continue
              const payload = resolveDamagePayload(burstState, burstTargetId, raw, String(burst.damageType || 'force'))
              const damageEvent = eventFrom(commandWithRules(command, RULE_IDS.damage), 'DamageApplied', { ...payload, spell_id: spell.id, secondary_burst: true, saved }, [burstTargetId])
              events.push(damageEvent)
              burstState = applyGameEvent(burstState, damageEvent)
              if (payload.hp_after === 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HitPointsReducedToZero', { condition: 'unconscious' }, [burstTargetId]))
            }
          }
        } else if (['save', 'area-save', 'debuff'].includes(spell.kind)) {
          const saveAbility = String(spell.saveAbility || 'dex')
          const carefulLimit = Math.max(1, abilityModifier(actor?.abilities?.cha))
          const carefulProtectedIds = new Set(metamagic.has('metamagic-careful')
            ? affected.filter((candidate) => actorId(candidate) !== command.actor_id && !isEnemyActor(state, actorId(candidate))).slice(0, carefulLimit).map(actorId)
            : [])
          let sharedDamageRoll = null
          if (damageExpression && affected.length) {
            sharedDamageRoll = diceService.roll(damageExpression, `spell_damage:${spell.id}`, command.actor_id, command.visibility ?? 'public')
            rolls.push(sharedDamageRoll)
            events.push(eventFrom(command, 'DieRolled', sharedDamageRoll, []))
          }
          for (const target of affected) {
            const resolvedTargetId = actorId(target)
            const targetConditions = conditionIdsFor(state, resolvedTargetId)
            const targetCreatureType = creatureTypeFor(target)
            const immuneByType = (spell.immuneCreatureTypes ?? []).includes(targetCreatureType)
              || ((spell.requiredCreatureTypes ?? []).length > 0 && !(spell.requiredCreatureTypes ?? []).includes(targetCreatureType))
              || (spell.minimumIntelligence != null && Number(target?.abilities?.int ?? 10) < Number(spell.minimumIntelligence))
            const immuneByLanguage = spell.requiresLanguage === true && (!understandsSpellLanguage(target) || targetConditions.has('cannot-understand-language'))
            const automaticSave = immuneByType || immuneByLanguage
              || ((spell.conditions ?? []).includes('frightened') && targetConditions.has('heroism'))
              || (spell.deafenedAutoSave === true && (targetConditions.has('deafened') || target?.deafened === true))
            let saveModifier = abilityModifier(target?.abilities?.[saveAbility])
            if (targetConditions.has('resistance-d4')) {
              const resistance = diceService.roll('1d4', 'spell:resistance', resolvedTargetId, command.visibility ?? 'public')
              rolls.push(resistance)
              events.push(eventFrom(command, 'DieRolled', resistance, []), eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'resistance-d4' }, [resolvedTargetId]))
              saveModifier += resistance.total
            }
            if (targetConditions.has('bless-d4')) {
              const blessing = diceService.roll('1d4', 'spell:bless:saving-throw', resolvedTargetId, command.visibility ?? 'public')
              rolls.push(blessing)
              events.push(eventFrom(command, 'DieRolled', blessing, []))
              saveModifier += blessing.total
            }
            if (targetConditions.has('bane-d4')) {
              const bane = diceService.roll('1d4', 'spell:bane:saving-throw', resolvedTargetId, command.visibility ?? 'public')
              rolls.push(bane)
              events.push(eventFrom(command, 'DieRolled', bane, []))
              saveModifier -= bane.total
            }
            if (targetConditions.has('next-save-minus-d4')) {
              const penalty = diceService.roll('1d4', 'spell:mind-sliver', resolvedTargetId, command.visibility ?? 'public')
              rolls.push(penalty)
              events.push(eventFrom(command, 'DieRolled', penalty, []), eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'next-save-minus-d4' }, [resolvedTargetId]))
              saveModifier -= penalty.total
            }
            const silveryFortune = targetConditions.has('silvery-fortune')
            const save = rollSavingThrowD20(state, diceService, resolvedTargetId, { modifier: saveModifier, purpose: `spell_save:${spell.id}:${saveAbility}`, advantage: silveryFortune || (spell.saveAdvantageIfHostile === true && state.mechanics.combat.active), disadvantage: metamagic.has('metamagic-heightened'), visibility: command.visibility })
            if (silveryFortune) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'silvery-fortune' }, [resolvedTargetId]))
            const saved = automaticSave || carefulProtectedIds.has(resolvedTargetId) || save.total >= spellSaveDc
            rolls.push(save)
            events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow), 'SpellSavingThrowResolved', { ...save, spell_id: spell.id, ability: saveAbility, difficulty: spellSaveDc, saved, automatic_success: automaticSave, immunity: immuneByType ? creatureTypeFor(target) : immuneByLanguage ? 'language' : spell.deafenedAutoSave === true && targetConditions.has('deafened') ? 'deafened' : null }, [resolvedTargetId]))
            const damage = sharedDamageRoll ? (saved ? (spell.halfOnSave ? Math.floor(sharedDamageRoll.total / 2) : 0) : sharedDamageRoll.total) : 0
            if (damage > 0) {
              const payload = resolveDamagePayload(state, resolvedTargetId, damage, damageType)
              events.push(eventFrom(commandWithRules(command, RULE_IDS.damage), 'DamageApplied', { ...payload, spell_id: spell.id, save_total: save.total, save_dc: spellSaveDc, saved }, [resolvedTargetId]))
              if (payload.hp_after === 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HitPointsReducedToZero', { condition: 'unconscious' }, [resolvedTargetId]))
            }
            if (!saved) for (const condition of spell.conditions ?? []) {
              const durationRounds = metamagic.has('metamagic-extended') ? Number(spell.durationRounds ?? 0) * 2 : Number(spell.durationRounds ?? 0)
              events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', {
                condition,
                duration: spell.concentration ? 'concentration' : durationRounds ? `rounds:${durationRounds}` : 'until-next-turn',
                source_actor: command.actor_id,
                effect_id: effectId,
                ...(spell.repeatSaveAtTurnEnd === true && condition === spell.conditions?.[0] ? { repeat_save_timing: 'turn-end', save_ability: saveAbility, save_dc: spellSaveDc, spell_id: spell.id } : {}),
                ...(spell.repeatSaveOnDamage === true && condition === spell.conditions?.[0] ? { repeat_save_on_damage: true, damage_save_advantage: spell.damageRepeatSaveAdvantage === true, save_ability: saveAbility, save_dc: spellSaveDc, spell_id: spell.id } : {}),
                ...(spell.breakOnDamageFromSourceAllies === true ? { break_on_damage_from_source_allies: true } : {}),
              }, [resolvedTargetId]))
            }
            if (!saved && spell.id === 'command') {
              events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', {
                condition: `command:${String(command.spell_option)}`,
                duration: 'command-next-turn',
                source_actor: command.actor_id,
                effect_id: effectId,
                spell_option: String(command.spell_option),
              }, [resolvedTargetId]))
            }
            if (!saved && spell.pushFeet > 0) {
              const origin = actorPosition(state, command.actor_id)
              const path = forcedPushPath(state, resolvedTargetId, origin, spell.pushFeet)
              if (path.length) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ActorMoved', {
                from: actorPosition(state, resolvedTargetId), to: path.at(-1), path, distance: path.length * 5,
                movement_cost: 0, movement_spent: 0, movement_remaining: safeInteger(target?.speed, 30),
                spend_movement: false, forced_movement: true, spell_id: spell.id, phase: 'combat',
              }, [resolvedTargetId]))
            }
            if (!saved && spell.reactionMoveAway === true) {
              let movementState = events.reduce(applyGameEvent, state)
              const reactionReady = movementState.mechanics.combat.action_economy[resolvedTargetId]?.reaction !== false
                && !conditionIdsFor(movementState, resolvedTargetId).has('no-reactions')
                && isLivingActor(findActor(movementState, resolvedTargetId))
              const origin = actorPosition(movementState, command.actor_id)
              const destination = reactionReady ? farthestSafeDestinationAwayFrom(movementState, resolvedTargetId, origin, safeInteger(target?.speed, 30)) : null
              if (destination?.path?.length) {
                const reactionEvent = eventFrom(commandWithRules({ ...command, actor_id: resolvedTargetId }, RULE_IDS.reaction), 'CombatActionUsed', {
                  action_id: 'dissonant-whispers-movement', name: spell.name, action_type: 'reaction', target_id: command.actor_id,
                }, [command.actor_id])
                events.push(reactionEvent)
                movementState = applyGameEvent(movementState, reactionEvent)
                const moveCommand = commandWithRules({
                  ...command,
                  command_id: `${command.command_id}:reaction-move:${resolvedTargetId}`,
                  expected_state_version: movementState.state_version,
                  command_type: 'MoveActor',
                  actor_id: resolvedTargetId,
                  target_id: '',
                  target_ids: [],
                  to: destination.position,
                  reaction_movement: true,
                  server_authoritative: true,
                }, RULE_IDS.reaction)
                const movement = resolveCommand(moveCommand, movementState, {
                  diceService,
                  context: { ...context, isAdmin: true, serverAuthoritativeCombat: true, spellMovement: true },
                })
                events.push(...movement.events)
                rolls.push(...movement.rolls)
              }
            }
          }
        } else if (['damage', 'area-damage'].includes(spell.kind)) {
          if (damageExpression && affected.length) {
            const damageRoll = diceService.roll(damageExpression, `spell_damage:${spell.id}`, command.actor_id, command.visibility ?? 'public')
            rolls.push(damageRoll)
            events.push(eventFrom(command, 'DieRolled', damageRoll, []))
            for (const target of affected) {
              const resolvedTargetId = actorId(target)
              const payload = resolveDamagePayload(state, resolvedTargetId, damageRoll.total, damageType)
              events.push(eventFrom(commandWithRules(command, RULE_IDS.damage), 'DamageApplied', { ...payload, spell_id: spell.id }, [resolvedTargetId]))
              if (payload.hp_after === 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HitPointsReducedToZero', { condition: 'unconscious' }, [resolvedTargetId]))
            }
          }
        } else if (spell.kind === 'healing') {
          const target = affected[0]
          const resolvedTargetId = actorId(target)
          const scaledHealing = scaledSpellDice({
            ...spell,
            damage: spell.healing,
            upcastDicePerLevel: spell.upcastHealingDicePerLevel,
          }, actor, command.slot_level) ?? spell.healing
          const expression = spell.addAbilityModifier ? diceExpression(scaledHealing, spellModifier, 4) : scaledHealing
          const healingRoll = diceService.roll(expression, `spell_healing:${spell.id}`, command.actor_id, command.visibility ?? 'public')
          rolls.push(healingRoll)
          events.push(eventFrom(command, 'DieRolled', healingRoll, []))
          const healing = resolvedHealingRoll(state, resolvedTargetId, expression, healingRoll.total)
          const before = actorHp(target)
          const after = conditionIdsFor(state, resolvedTargetId).has('healing-blocked') ? before : Math.min(actorMaxHp(target), before + healing.amount)
          events.push(eventFrom(commandWithRules(command, RULE_IDS.healing), 'HealingApplied', { spell_id: spell.id, requested_amount: healing.amount, applied_amount: after - before, hp_before: before, hp_after: after, ...healing }, [resolvedTargetId]))
        } else if (['buff', 'utility'].includes(spell.kind)) {
          const targets = affected.length ? affected : spell.target === 'self' ? [actor] : []
          const conditions = spell.id === 'resistance'
            ? [`resistance-damage:${command.spell_option}`]
            : spell.conditions?.length ? spell.conditions : spell.kind === 'buff' && !spell.nextWeaponHit ? [`spell-effect:${spell.id}`] : []
          for (const target of targets) {
            const resolvedTargetId = actorId(target)
            const slotLevel = Math.max(spell.level, safeInteger(command.slot_level, spell.level))
            let offeredTemporaryHp = 0
            if (spell.temporaryHpDice) {
              const temporaryRoll = diceService.roll(String(spell.temporaryHpDice), `spell_temporary_hp:${spell.id}`, command.actor_id, command.visibility ?? 'public')
              rolls.push(temporaryRoll)
              events.push(eventFrom(command, 'DieRolled', temporaryRoll, []))
              offeredTemporaryHp = temporaryRoll.total + Math.max(0, slotLevel - spell.level) * Math.max(0, safeInteger(spell.temporaryHpPerUpcastLevel, 0))
            } else if (spell.temporaryHp) {
              offeredTemporaryHp = Math.max(0, safeInteger(spell.temporaryHp, 0) + Math.max(0, slotLevel - spell.level) * Math.max(0, safeInteger(spell.temporaryHpPerSlotLevel, 0)))
            } else if (spell.temporaryHpAbilityModifier) {
              offeredTemporaryHp = Math.max(0, spellModifier)
            }
            if (offeredTemporaryHp > 0) {
              const before = Math.max(0, safeInteger(state.mechanics.temporary_hp[resolvedTargetId], 0))
              events.push(eventFrom(commandWithRules(command, RULE_IDS.temporaryHp), 'TemporaryHitPointsGranted', { spell_id: spell.id, offered: offeredTemporaryHp, temporary_hp_before: before, temporary_hp_after: Math.max(before, offeredTemporaryHp) }, [resolvedTargetId]))
            }
            for (const configuredCondition of conditions) {
              const condition = configuredCondition === 'hunters-mark' ? `hunters-mark:${command.actor_id}`
                : configuredCondition === 'hexed' ? `hexed:${command.actor_id}`
                  : configuredCondition
              events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', {
                condition, duration: spell.concentration ? 'concentration' : spell.durationRounds ? `rounds:${spell.durationRounds}` : null,
                source_actor: command.actor_id, effect_id: effectId, spell_id: spell.id,
                ...(spell.temporaryHpAbilityModifier ? { temporary_hp_amount: Math.max(0, spellModifier) } : {}),
              }, [resolvedTargetId]))
              if (condition === 'heroism') events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'frightened', reason: 'fear-immunity', spell_id: spell.id }, [resolvedTargetId]))
            }
            if (spell.meleeRetaliationDamage) {
              const retaliation = Math.max(0, safeInteger(spell.meleeRetaliationDamage, 0) + Math.max(0, slotLevel - spell.level) * Math.max(0, safeInteger(spell.meleeRetaliationDamagePerSlotLevel, 0)))
              events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: `armor-of-agathys:${retaliation}`, duration: spell.durationRounds ? `rounds:${spell.durationRounds}` : null, source_actor: command.actor_id, effect_id: effectId }, [resolvedTargetId]))
            }
          }
        } else if (spell.kind === 'teleport') {
          const to = { x: Number(command.to.x), y: Number(command.to.y) }
          const from = actorPosition(state, command.actor_id)
          events.push(eventFrom(commandWithRules(command, RULE_IDS.turns), 'ActorMoved', { from, to, path: [to], distance: 0, movement_spent: state.mechanics.combat.action_economy[command.actor_id]?.movement_spent ?? 0, movement_remaining: Math.max(0, safeInteger(actor?.speed, 30) - safeInteger(state.mechanics.combat.action_economy[command.actor_id]?.movement_spent, 0)), teleport: true }, [command.actor_id]))
        } else if (spell.kind === 'summon') {
          const to = { x: Number(command.to.x), y: Number(command.to.y) }
          const safeCommandId = String(command.command_id).replace(/[^A-Za-z0-9._-]/gu, '-').slice(0, 60)
          const summonId = `summon-${command.actor_id}-${safeCommandId}`.slice(0, 120)
          const definition = spell.summon ?? {
            name: spell.name,
            hp: 10 + Math.max(1, spell.level) * 5 + Math.max(1, safeInteger(actor?.level, 1)),
            armor: 11 + Math.ceil(Math.max(1, spell.level) / 2),
            speed: 30,
            attackName: 'Магическая атака',
            damage: `${Math.max(1, Math.ceil(Math.max(1, spell.level) / 2))}d8+${Math.max(0, spellModifier)}`,
            damageType,
            range: 5,
          }
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
      let movementCost = 0
      const reactionMovement = command.reaction_movement === true
      let movementSpent = reactionMovement ? 0 : Math.max(0, safeInteger(state.mechanics.combat.action_economy[command.actor_id]?.movement_spent, 0))
      if (authoritative) {
        if (!from) throw new RulesValidationError('Участник должен находиться на карте', 'MAP_POSITION_REQUIRED')
        if (!cells.size) throw new RulesValidationError('Для перемещения нужна тактическая карта', 'TACTICAL_MAP_REQUIRED')
        if (!isWalkableCell(cells.get(positionKey(to))) || occupiedPositions(state, command.actor_id).has(positionKey(to))) {
          throw new RulesValidationError('Клетка назначения недоступна', 'INVALID_DESTINATION')
        }
        path = shortestTacticalPath(state, command.actor_id, to)
        if (!path?.length) throw new RulesValidationError('До клетки назначения нет свободного пути', 'PATH_BLOCKED')
        if (!reactionMovement) {
          const movementConditions = state.mechanics.conditions[command.actor_id] ?? []
          const frightened = movementConditions.find((condition) => String(condition?.id ?? condition) === 'frightened' && condition.source_actor)
          const commandApproach = movementConditions.find((condition) => String(condition?.id ?? condition) === 'command:approach')
          const commandFlee = movementConditions.find((condition) => String(condition?.id ?? condition) === 'command:flee')
          const distanceTo = (position, sourceActor) => {
            const source = actorPosition(state, sourceActor)
            return source ? Math.max(Math.abs(position.x - source.x), Math.abs(position.y - source.y)) : null
          }
          if (frightened) {
            let previousDistance = distanceTo(from, frightened.source_actor)
            for (const step of path) {
              const nextDistance = distanceTo(step, frightened.source_actor)
              if (previousDistance != null && nextDistance != null && nextDistance < previousDistance) throw new RulesValidationError('Испуганное существо не может добровольно приблизиться к источнику страха', 'FRIGHTENED_CLOSER')
              previousDistance = nextDistance
            }
          }
          if (commandApproach && distanceTo(to, commandApproach.source_actor) >= distanceTo(from, commandApproach.source_actor)) {
            throw new RulesValidationError('Приказ «Подойди» требует приблизиться к заклинателю', 'COMMAND_MOVEMENT_DIRECTION')
          }
          if (commandFlee && distanceTo(to, commandFlee.source_actor) <= distanceTo(from, commandFlee.source_actor)) {
            throw new RulesValidationError('Приказ «Убегай» требует отдалиться от заклинателя', 'COMMAND_MOVEMENT_DIRECTION')
          }
        }
        distance = path.length * 5
        const difficultSteps = path.filter((step) => activeAreaEffectsAt(state, step).some((effect) => effect.difficult_terrain === true)).length
        const crawlingSteps = conditionIdsFor(state, command.actor_id).has('prone') ? path.length : 0
        movementCost = distance + difficultSteps * 5 + crawlingSteps * 5
        const speed = Math.max(0, safeInteger(actor?.speed, 30) - (conditionIdsFor(state, command.actor_id).has('speed-reduced-10') ? 10 : 0))
        const movementBonus = Math.max(0, safeInteger(state.mechanics.combat.action_economy[command.actor_id]?.movement_bonus, 0))
        const aggressiveBonus = command.monster_ability === 'aggressive'
          && context.isNpcScheduler
          && isEnemyActor(state, command.actor_id)
          && monsterTraitFor(actor, 'aggressive')
          && state.mechanics.combat.action_economy[command.actor_id]?.bonus_action !== false
          ? speed
          : 0
        // D&D limits speed per turn in combat. During adventure movement the GM
        // may summarise travel instead, so exploration is constrained by the map
        // and occupied cells, not by a combat turn that has not started.
        if (state.mechanics.combat.active && movementSpent + movementCost > speed + (reactionMovement ? 0 : movementBonus + aggressiveBonus)) {
          throw new RulesValidationError('Недостаточно скорости для этого перемещения', 'SPEED_EXCEEDED')
        }
        movementSpent = state.mechanics.combat.active && !reactionMovement ? movementSpent + movementCost : 0
      } else {
        const legacyFrom = from ?? (command.from && Number.isSafeInteger(Number(command.from.x)) && Number.isSafeInteger(Number(command.from.y))
          ? { x: Number(command.from.x), y: Number(command.from.y) }
          : null)
        path = legacyFrom ? [to] : null
        distance = legacyFrom ? (Math.abs(legacyFrom.x - to.x) + Math.abs(legacyFrom.y - to.y)) * 5 : Math.max(0, Number(command.distance) || 0)
        movementCost = distance
      }

      // A voluntary move out of a hostile creature's reach provokes one automatic
      // reaction attack, matching the default automation players expect from BG3.
      // Disengage, invisibility and reaction-denying conditions suppress it.
      let reactionState = state
      if (state.mechanics.combat.active && from && path?.length && !isEnemyActor(state, command.actor_id)) {
        for (const threateningActor of opportunityAttackers(state, command.actor_id, from, path)) {
          const threateningActorId = actorId(threateningActor)
          const opportunity = opportunityAttackProfile(reactionState, threateningActor)
          if (!opportunity || !isLivingActor(findActor(reactionState, command.actor_id))) break
          const reactionCommand = commandWithRules({
            ...command,
            command_id: `${command.command_id}:opportunity:${threateningActorId}`,
            command_type: 'MakeAttack',
            actor_id: threateningActorId,
            target_id: command.actor_id,
            target_ids: [command.actor_id],
            item_id: opportunity.item_id,
            reaction_attack: true,
            server_authoritative: true,
          }, RULE_IDS.attack, RULE_IDS.reaction)
          const actionEvent = eventFrom(reactionCommand, 'CombatActionUsed', {
            action_id: 'opportunity-attack',
            name: 'Атака по возможности',
            action_type: 'reaction',
            target_id: command.actor_id,
          }, [command.actor_id])
          events.push(actionEvent)
          reactionState = applyGameEvent(reactionState, actionEvent)
          reactionCommand.expected_state_version = reactionState.state_version
          const attackResult = resolveCommand(reactionCommand, reactionState, {
            diceService,
            context: { ...context, isAdmin: true, reactionResolution: true, serverAuthoritativeCombat: true },
          })
          events.push(...attackResult.events)
          rolls.push(...attackResult.rolls)
          reactionState = attackResult.events.reduce(applyGameEvent, reactionState)
        }
      }
      if (!isLivingActor(findActor(reactionState, command.actor_id))) break
      const aggressiveBonus = command.monster_ability === 'aggressive' && context.isNpcScheduler && monsterTraitFor(actor, 'aggressive') ? Math.max(0, safeInteger(actor?.speed, 30)) : 0
      const speed = Math.max(0, safeInteger(actor?.speed, 30) - (conditionIdsFor(state, command.actor_id).has('speed-reduced-10') ? 10 : 0)) + Math.max(0, safeInteger(state.mechanics.combat.action_economy[command.actor_id]?.movement_bonus, 0)) + aggressiveBonus
      events.push(eventFrom(command, 'ActorMoved', {
        from: from ?? command.from ?? null,
        to,
        path,
        distance,
        movement_cost: movementCost,
        movement_spent: movementSpent,
        movement_remaining: Math.max(0, speed - movementSpent),
        spend_movement: !reactionMovement,
        reaction_movement: reactionMovement,
        monster_ability: aggressiveBonus > 0 ? 'aggressive' : null,
        phase: state.mechanics.combat.active ? 'combat' : 'exploration',
      }, [command.actor_id]))
      const enteredAreaState = replayEvents(state, events)
      for (const effect of (state.mechanics.active_effects ?? []).filter((candidate) => candidate.trigger_on_enter === true && positionInArea(to, candidate.center, candidate.radius_feet, candidate.area_shape) && !positionInArea(from, candidate.center, candidate.radius_feet, candidate.area_shape))) {
        const ability = String(effect.save_ability || 'dex')
        const save = rollSavingThrowD20(enteredAreaState, diceService, command.actor_id, { modifier: abilityModifier(actor?.abilities?.[ability]), purpose: `spell_area_enter:${effect.spell_id}:${ability}`, visibility: command.visibility })
        const saved = save.total >= Math.max(1, safeInteger(effect.save_dc, 10))
        rolls.push(save)
        events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow), 'SpellSavingThrowResolved', { ...save, spell_id: effect.spell_id, ability, difficulty: effect.save_dc, saved, trigger: 'area-enter' }, [command.actor_id]))
        if (!saved && effect.condition) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: String(effect.condition), duration: 'until-next-turn', source_actor: effect.source_actor, effect_id: effect.effect_id }, [command.actor_id]))
      }
      const moverConditions = conditionIdsFor(state, command.actor_id)
      const boomingBlade = (state.mechanics.conditions[command.actor_id] ?? []).find((condition) => String(condition?.id ?? condition).startsWith('booming-blade-move:'))
      if (boomingBlade && distance > 0) {
        const expression = String(boomingBlade.id).slice('booming-blade-move:'.length)
        const damageRoll = diceService.roll(expression, 'spell:booming-blade:movement', String(boomingBlade.source_actor ?? command.actor_id), command.visibility ?? 'public')
        rolls.push(damageRoll)
        events.push(eventFrom(command, 'DieRolled', damageRoll, []))
        const payload = resolveDamagePayload(reactionState, command.actor_id, damageRoll.total, 'thunder')
        events.push(eventFrom(commandWithRules(command, RULE_IDS.damage), 'DamageApplied', { ...payload, spell_id: 'booming-blade', movement_triggered: true }, [command.actor_id]))
        events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: boomingBlade.id }, [command.actor_id]))
        if (payload.hp_after === 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HitPointsReducedToZero', { condition: 'unconscious' }, [command.actor_id]))
      }
      if (state.mechanics.combat.active && isEnemyActor(state, command.actor_id) && from && !moverConditions.has('disengaged') && !moverConditions.has('invisible') && !moverConditions.has('zephyr-strike')) {
        const initiativeOrder = new Map((state.mechanics.combat.initiative ?? []).map((entry, index) => [String(entry.actor_id), index]))
        const reactor = [...state.players, ...(state.actors ?? []).filter((candidate) => isPartySummon(candidate))]
          .filter((candidate) => isLivingActor(candidate) && state.mechanics.combat.action_economy[actorId(candidate)]?.reaction !== false)
          .filter((candidate) => {
            const conditions = conditionIdsFor(state, actorId(candidate))
            if ([...OPPORTUNITY_BLOCKING_CONDITIONS].some((condition) => conditions.has(condition))) return false
            const at = actorPosition(state, actorId(candidate))
            if (!at) return false
            const before = Math.max(Math.abs(at.x - from.x), Math.abs(at.y - from.y)) * 5
            const leavesReach = path?.some((step) => Math.max(Math.abs(at.x - step.x), Math.abs(at.y - step.y)) * 5 > 5)
            return before === 5 && leavesReach && Boolean(opportunityAttackProfile(state, candidate))
          })
          .sort((left, right) => (initiativeOrder.get(actorId(left)) ?? Number.MAX_SAFE_INTEGER) - (initiativeOrder.get(actorId(right)) ?? Number.MAX_SAFE_INTEGER)
            || actorId(left).localeCompare(actorId(right)))[0]
        if (reactor) events.push(eventFrom(commandWithRules(command, RULE_IDS.reaction), 'ReactionWindowOpened', {
          id: `reaction:${command.command_id}:opportunity`,
          trigger: 'enemy-left-reach',
          actor_id: actorId(reactor),
          source_actor_id: command.actor_id,
          target_id: command.actor_id,
          source_previous_position: from,
          action_ids: ['opportunity-attack'],
          action_options: [{ id: 'opportunity-attack', name: 'Атака по возможности', description: 'Атаковать оружием противника, покидающего вашу досягаемость.', resource: null, cost: 1 }],
          damage: null,
        }, [actorId(reactor)]))
      }
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
        entries.push({
          actor_id: id,
          total: roll.total,
          modifier,
          roll: roll.kept,
          dice: clone(roll.dice),
          roll_id: roll.roll_id,
        })
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
        initiative.splice(insertAt, 0, {
          actor_id: actorId(summon),
          total: ownerEntry.total,
          modifier: ownerEntry.modifier,
          roll: ownerEntry.roll,
          dice: clone(ownerEntry.dice ?? []),
          roll_id: ownerEntry.roll_id,
          shared_with: ownerId,
        })
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
      const endingActor = findActor(state, command.actor_id)
      const endingPosition = actorPosition(state, command.actor_id)
      for (const effect of (state.mechanics.active_effects ?? []).filter((candidate) => candidate.trigger_on_turn_end === true && positionInArea(endingPosition, candidate.center, candidate.radius_feet, candidate.area_shape))) {
        const ability = String(effect.save_ability || 'dex')
        const save = rollSavingThrowD20(state, diceService, command.actor_id, { modifier: abilityModifier(endingActor?.abilities?.[ability]), purpose: `spell_area_turn_end:${effect.spell_id}:${ability}`, visibility: command.visibility })
        const saved = save.total >= Math.max(1, safeInteger(effect.save_dc, 10))
        rolls.push(save)
        events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow), 'SpellSavingThrowResolved', { ...save, spell_id: effect.spell_id, ability, difficulty: effect.save_dc, saved, trigger: 'turn-end' }, [command.actor_id]))
        if (!saved && effect.condition) events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: String(effect.condition), duration: 'until-next-turn', source_actor: effect.source_actor, effect_id: effect.effect_id }, [command.actor_id]))
      }
      for (const condition of (state.mechanics.conditions[command.actor_id] ?? []).filter((candidate) => candidate.repeat_save_timing === 'turn-end')) {
        const ability = String(condition.save_ability || 'wis')
        let modifier = abilityModifier(endingActor?.abilities?.[ability])
        const conditionIds = conditionIdsFor(state, command.actor_id)
        if (conditionIds.has('bless-d4')) {
          const blessing = diceService.roll('1d4', 'spell:bless:repeat-save', command.actor_id, command.visibility ?? 'public')
          rolls.push(blessing)
          events.push(eventFrom(command, 'DieRolled', blessing, []))
          modifier += blessing.total
        }
        if (conditionIds.has('bane-d4')) {
          const bane = diceService.roll('1d4', 'spell:bane:repeat-save', command.actor_id, command.visibility ?? 'public')
          rolls.push(bane)
          events.push(eventFrom(command, 'DieRolled', bane, []))
          modifier -= bane.total
        }
        const save = rollSavingThrowD20(state, diceService, command.actor_id, { modifier, purpose: `spell_repeat_save:${condition.spell_id}:${ability}`, visibility: command.visibility })
        const difficulty = Math.max(1, safeInteger(condition.save_dc, 10))
        const saved = save.total >= difficulty
        rolls.push(save)
        events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow), 'SpellSavingThrowResolved', { ...save, spell_id: condition.spell_id, ability, difficulty, saved, trigger: 'turn-end-repeat' }, [command.actor_id]))
        if (saved) {
          const sourceConcentration = state.mechanics.concentration[String(condition.source_actor ?? '')]
          if (condition.effect_id && String(sourceConcentration?.effect_id ?? '') === String(condition.effect_id)) {
            events.push(eventFrom(commandWithRules({ ...command, actor_id: String(condition.source_actor) }, RULE_IDS.concentration), 'ConcentrationEnded', { reason: 'repeat-save', effect_id: condition.effect_id }, [String(condition.source_actor)]))
          } else events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: condition.id }, [command.actor_id]))
        }
      }
      const commanded = (state.mechanics.conditions[command.actor_id] ?? []).find((condition) => String(condition?.id ?? condition).startsWith('command:'))
      if (commanded) {
        if (String(commanded.id) === 'command:grovel') events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionAdded', { condition: 'prone', duration: 'until-next-turn', source_actor: commanded.source_actor, effect_id: commanded.effect_id }, [command.actor_id]))
        events.push(eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: commanded.id }, [command.actor_id]))
      }
      for (const [duelTargetId, conditions] of Object.entries(state.mechanics.conditions)) {
        const duel = (conditions ?? []).find((condition) => condition.id === 'compelled-duel' && String(condition.source_actor ?? '') === command.actor_id)
        if (duel && distanceBetweenActors(state, command.actor_id, duelTargetId) > 30) {
          events.push(eventFrom(commandWithRules(command, RULE_IDS.concentration), 'ConcentrationEnded', { reason: 'duelist-too-far', effect_id: duel.effect_id }, [command.actor_id]))
        }
      }
      const nextIndex = (combat.active_index + 1) % combat.initiative.length
      const nextRound = nextIndex === 0 ? combat.round + 1 : combat.round
      const nextId = combat.initiative[nextIndex].actor_id
      events.push(eventFrom(command, 'TurnEnded', { round: combat.round }, [command.actor_id]))
      events.push(eventFrom(command, 'TurnStarted', { round: nextRound, active_index: nextIndex }, [nextId]))
      let startTurnState = replayEvents(state, events)
      const auraSource = activeAuraOfLifeSource(startTurnState, nextId)
      const auraTarget = findActor(startTurnState, nextId)
      if (auraSource && actorHp(auraTarget) === 0 && !isDeadHero(startTurnState, nextId)) {
        const auraHealing = eventFrom(commandWithRules({ ...command, actor_id: auraSource.source_id }, RULE_IDS.healing), 'HealingApplied', {
          spell_id: 'aura-of-life',
          requested_amount: 1,
          applied_amount: 1,
          hp_before: 0,
          hp_after: Math.min(1, actorMaxHp(auraTarget)),
          trigger: 'turn-start',
          aura_of_life_source: auraSource.source_id,
        }, [nextId])
        events.push(auraHealing)
        startTurnState = applyGameEvent(startTurnState, auraHealing)
      }
      const deathSave = deathSavingThrowAtTurnStart(startTurnState, command, nextId, diceService)
      events.push(...deathSave.events)
      rolls.push(...deathSave.rolls)
      startTurnState = replayEvents(state, events)
      const startingActor = findActor(startTurnState, nextId)
      for (const condition of [...(startTurnState.mechanics.conditions[nextId] ?? []).filter((candidate) => candidate.recurring_damage)]) {
        let effectContinues = true
        if (condition.start_turn_save) {
          const ability = String(condition.start_turn_save)
          const difficulty = Math.max(1, safeInteger(condition.save_dc, 10))
          const save = rollSavingThrowD20(startTurnState, diceService, nextId, { modifier: abilityModifier(startingActor?.abilities?.[ability]), purpose: `spell_start_turn_save:${condition.spell_id}:${ability}`, visibility: command.visibility })
          const saved = save.total >= difficulty
          rolls.push(save)
          events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow), 'SpellSavingThrowResolved', { ...save, spell_id: condition.spell_id, ability, difficulty, saved, trigger: 'turn-start' }, [nextId]))
          if (saved) {
            effectContinues = false
            const sourceActorId = String(condition.source_actor ?? '')
            const sourceConcentration = startTurnState.mechanics.concentration[sourceActorId]
            const ended = condition.effect_id && String(sourceConcentration?.effect_id ?? '') === String(condition.effect_id)
              ? eventFrom(commandWithRules({ ...command, actor_id: sourceActorId }, RULE_IDS.concentration), 'ConcentrationEnded', { reason: 'turn-start-save', effect_id: condition.effect_id }, [sourceActorId])
              : eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: condition.id, trigger: 'turn-start-save', spell_id: condition.spell_id }, [nextId])
            events.push(ended)
            startTurnState = applyGameEvent(startTurnState, ended)
          }
        }
        if (!effectContinues || !isLivingActor(findActor(startTurnState, nextId))) continue
        const recurringRoll = diceService.roll(String(condition.recurring_damage), `spell_start_turn_damage:${condition.spell_id}`, String(condition.source_actor ?? nextId), command.visibility ?? 'public')
        rolls.push(recurringRoll)
        events.push(eventFrom(command, 'DieRolled', { ...recurringRoll, spell_id: condition.spell_id, damage_type: condition.recurring_damage_type }, []))
        const recurringPayload = resolveDamagePayload(startTurnState, nextId, recurringRoll.total, String(condition.recurring_damage_type ?? 'untyped'))
        const recurringEvent = eventFrom(commandWithRules({ ...command, actor_id: String(condition.source_actor ?? command.actor_id) }, RULE_IDS.damage), 'DamageApplied', { ...recurringPayload, spell_id: condition.spell_id, recurring: true, trigger: 'turn-start' }, [nextId])
        events.push(recurringEvent)
        startTurnState = applyGameEvent(startTurnState, recurringEvent)
        if (recurringPayload.hp_after === 0) events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'HitPointsReducedToZero', { condition: 'unconscious', spell_id: condition.spell_id }, [nextId]))
      }
      const heroism = (startTurnState.mechanics.conditions[nextId] ?? []).find((condition) => condition.id === 'heroism')
      if (heroism && isLivingActor(findActor(startTurnState, nextId))) {
        const offered = Math.max(0, safeInteger(heroism.temporary_hp_amount, 0))
        const before = Math.max(0, safeInteger(startTurnState.mechanics.temporary_hp[nextId], 0))
        if (offered > 0) events.push(eventFrom(commandWithRules({ ...command, actor_id: String(heroism.source_actor ?? command.actor_id) }, RULE_IDS.temporaryHp), 'TemporaryHitPointsGranted', {
          spell_id: 'heroism', offered, temporary_hp_before: before, temporary_hp_after: Math.max(before, offered), trigger: 'turn-start',
        }, [nextId]))
      }
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
      const sceneEventId = sceneWorldMemoryEventId(command.command_id)
      const sceneEvent = { ...eventFrom(command, 'SceneAdvanced', {
        ...canonicalTransition,
        ...metadata,
        location_before: String(state.scene?.location ?? ''),
        location_after: String(canonicalTransition.scene?.location ?? ''),
        party_positions: partyPositions,
        scene_commerce: command.scene_commerce,
        party_decision: command.party_decision,
        request_fingerprint: command.request_fingerprint,
      }, partyPositions.map((position) => position.actor_id)), event_id: sceneEventId }
      events.push(sceneEvent)
      for (const memoryEvent of sceneWorldMemoryEvents(state, canonicalTransition, { commandId: command.command_id, sourceEventId: sceneEventId })) {
        events.push(eventFrom({ ...command, visibility: memoryEvent.visibility }, memoryEvent.event_type, memoryEvent.payload, memoryEvent.target_ids))
      }
      break
    }
    case 'AdvanceTime': {
      const amount = Math.max(0, Number(command.amount) || 0)
      const unit = String(command.unit || 'minute')
      const elapsedMinutes = durationInMinutes(amount, unit)
      events.push(eventFrom(command, 'TimeAdvanced', { amount, unit, elapsed_minutes: elapsedMinutes }, []))
      if (elapsedMinutes <= 0) break
      for (const socialEvent of npcPromiseDeadlineEvents(state, elapsedMinutes)) {
        events.push(eventFrom({ ...command, visibility: socialEvent.visibility }, socialEvent.event_type, socialEvent.payload, socialEvent.target_ids))
      }
      for (const [heroId, rawTracker] of Object.entries(state.mechanics.death.saving_throws ?? {})) {
        const tracker = deathSaveTracker(state, heroId)
        const hero = playerActor(state, heroId)
        if (!tracker.stable || !hero || actorHp(hero) !== 0 || isDeadHero(state, heroId)) continue
        let remaining = Math.max(0, safeInteger(rawTracker?.recovery_minutes_remaining, 0))
        if (remaining <= 0) {
          const recoveryRoll = diceService.roll('1d4', 'stable-recovery-hours', heroId, command.visibility ?? 'public')
          rolls.push(recoveryRoll)
          remaining = recoveryRoll.total * 60
          events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'StableRecoveryScheduled', {
            ...recoveryRoll,
            recovery_hours: recoveryRoll.total,
            recovery_minutes: remaining,
          }, [heroId]))
        }
        if (elapsedMinutes >= remaining) {
          events.push(eventFrom(commandWithRules(command, RULE_IDS.healing, RULE_IDS.zeroHp), 'HealingApplied', {
            requested_amount: 1,
            applied_amount: Math.min(1, actorMaxHp(hero)),
            hp_before: 0,
            hp_after: Math.min(1, actorMaxHp(hero)),
            reason: 'stable-recovery-after-1d4-hours',
          }, [heroId]))
        } else {
          events.push(eventFrom(commandWithRules(command, RULE_IDS.zeroHp), 'StableRecoveryProgressed', {
            elapsed_minutes: elapsedMinutes,
            recovery_minutes_before: remaining,
            recovery_minutes_remaining: remaining - elapsedMinutes,
          }, [heroId]))
        }
      }
      for (const [targetIdValue, rest] of Object.entries(state.mechanics.resting ?? {})) {
        if (rest?.reason !== 'knockout') continue
        const remaining = Math.max(1, safeInteger(rest.recovery_minutes_remaining, 60))
        if (elapsedMinutes >= remaining) {
          events.push(eventFrom(commandWithRules(command, RULE_IDS.resource, RULE_IDS.conditions), 'RestCompleted', {
            kind: 'short',
            reason: 'knockout',
            automatic: true,
          }, [targetIdValue]))
        } else {
          events.push(eventFrom(commandWithRules(command, RULE_IDS.resource), 'KnockoutRecoveryProgressed', {
            elapsed_minutes: elapsedMinutes,
            recovery_minutes_before: remaining,
            recovery_minutes_remaining: remaining - elapsedMinutes,
          }, [targetIdValue]))
        }
      }
      break
    }
    case 'StartRest':
      events.push(eventFrom(command, 'RestStarted', { kind: command.kind }, [command.actor_id]))
      break
    case 'CompleteRest':
      if (command.kind === 'long' && state.mechanics.concentration[command.actor_id]) {
        events.push(eventFrom(commandWithRules(command, RULE_IDS.concentration), 'ConcentrationEnded', {
          reason: 'long-rest',
          effect_id: state.mechanics.concentration[command.actor_id].effect_id,
        }, [command.actor_id]))
      }
      events.push(eventFrom(command, 'RestCompleted', { kind: command.kind }, [command.actor_id]))
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
    case 'UpsertWorldEntity':
    case 'RecordWorldFact':
    case 'RevealWorldFact':
    case 'UpsertQuest':
    case 'AdvanceQuestClock': {
      const worldEvent = worldMemoryEvent(command)
      events.push(eventFrom(command, worldEvent.event_type, worldEvent.payload, worldEvent.target_ids))
      break
    }
    case 'UpsertNpcSocialProfile':
    case 'RecordNpcSocialTurn':
    case 'ResolveNpcPromise': {
      for (const socialEvent of npcSocialEvents(command, state)) {
        events.push(eventFrom({ ...command, visibility: socialEvent.visibility }, socialEvent.event_type, socialEvent.payload, socialEvent.target_ids))
      }
      break
    }
    case 'RecordRuling':
      events.push(eventFrom(command, 'RulingRecorded', { ruling: clone(command.ruling ?? {}) }, []))
      break
    default:
      throw new RulesValidationError('Команда пока не реализована', 'COMMAND_NOT_IMPLEMENTED')
  }

  let triggeredState = state
  for (const resolvedEvent of nestedConsequencesResolved ? [] : [...events]) {
    triggeredState = applyGameEvent(triggeredState, resolvedEvent)
    if (resolvedEvent.event_type === 'AttackResolved' || resolvedEvent.event_type === 'SpellCast') {
      const actingId = String(resolvedEvent.actor_id ?? '')
      for (const [duelTargetId, conditions] of Object.entries(triggeredState.mechanics.conditions)) {
        const duel = (conditions ?? []).find((condition) => condition.id === 'compelled-duel' && String(condition.source_actor ?? '') === actingId)
        if (!duel) continue
        const hostileOtherTargeted = (resolvedEvent.target_ids ?? []).some((id) => String(id) !== duelTargetId && isEnemyActor(triggeredState, String(id)) !== isEnemyActor(triggeredState, actingId))
        if (!hostileOtherTargeted) continue
        const ended = eventFrom(commandWithRules({ ...command, actor_id: actingId }, RULE_IDS.concentration), 'ConcentrationEnded', { reason: 'duel-violated', effect_id: duel.effect_id }, [actingId])
        events.push(ended)
        triggeredState = applyGameEvent(triggeredState, ended)
      }
    }
    if (resolvedEvent.event_type !== 'DamageApplied') continue
    const damageTaken = safeInteger(resolvedEvent.payload?.applied_amount, 0) + safeInteger(resolvedEvent.payload?.temporary_hp_absorbed, 0)
    if (damageTaken <= 0) continue
    const damagedActorId = String(resolvedEvent.target_ids?.[0] ?? '')
    if (!damagedActorId) continue
    const concentration = triggeredState.mechanics.concentration[damagedActorId]
    if (concentration) {
      const concentrationCommand = commandWithRules({
        ...command,
        actor_id: damagedActorId,
        visibility: resolvedEvent.visibility ?? command.visibility,
        source_rule_ids: [...new Set([...(resolvedEvent.source_rule_ids ?? []), ...(command.source_rule_ids ?? [])])],
      }, RULE_IDS.concentration, RULE_IDS.savingThrow)
      if (safeInteger(resolvedEvent.payload?.hp_after, actorHp(findActor(triggeredState, damagedActorId))) <= 0) {
        const ended = eventFrom(concentrationCommand, 'ConcentrationEnded', {
          reason: 'incapacitated', effect_id: concentration.effect_id, damage: damageTaken,
        }, [damagedActorId])
        events.push(ended)
        triggeredState = applyGameEvent(triggeredState, ended)
      } else {
        const difficulty = Math.max(10, Math.floor(damageTaken / 2))
        const actor = findActor(triggeredState, damagedActorId)
        const proficient = isSavingThrowProficient(actor, 'con')
        let modifier = abilityModifier(actor?.abilities?.con) + (proficient ? safeInteger(actor?.proficiency, 0) : 0)
        const savingConditions = conditionIdsFor(triggeredState, damagedActorId)
        for (const [conditionId, expression, purpose, sign] of [
          ['bless-d4', '1d4', 'spell:bless:concentration-save', 1],
          ['bane-d4', '1d4', 'spell:bane:concentration-save', -1],
          ['next-save-minus-d4', '1d4', 'spell:mind-sliver:concentration-save', -1],
        ]) {
          if (!savingConditions.has(conditionId)) continue
          const modifierRoll = diceService.roll(expression, purpose, damagedActorId, concentrationCommand.visibility ?? 'public')
          rolls.push(modifierRoll)
          events.push(eventFrom(concentrationCommand, 'DieRolled', modifierRoll, []))
          modifier += sign * modifierRoll.total
          if (conditionId === 'next-save-minus-d4') {
            const removed = eventFrom(commandWithRules(concentrationCommand, RULE_IDS.conditions), 'ConditionRemoved', { condition: conditionId }, [damagedActorId])
            events.push(removed)
            triggeredState = applyGameEvent(triggeredState, removed)
          }
        }
        const silveryFortune = savingConditions.has('silvery-fortune')
        const save = rollSavingThrowD20(triggeredState, diceService, damagedActorId, {
          modifier, difficulty, purpose: 'concentration:saving-throw', advantage: silveryFortune,
          visibility: concentrationCommand.visibility,
        })
        const saved = save.total >= difficulty
        rolls.push(save)
        const required = eventFrom(concentrationCommand, 'ConcentrationCheckRequired', { difficulty, damage: damageTaken }, [damagedActorId])
        const resolved = eventFrom(concentrationCommand, 'ConcentrationSavingThrowResolved', {
          ...save, ability: 'con', difficulty, saved, proficient,
        }, [damagedActorId])
        events.push(required, resolved)
        if (silveryFortune) {
          const removed = eventFrom(commandWithRules(concentrationCommand, RULE_IDS.conditions), 'ConditionRemoved', { condition: 'silvery-fortune' }, [damagedActorId])
          events.push(removed)
          triggeredState = applyGameEvent(triggeredState, removed)
        }
        if (!saved) {
          const ended = eventFrom(concentrationCommand, 'ConcentrationEnded', {
            reason: 'failed-saving-throw', effect_id: concentration.effect_id, difficulty, total: save.total, damage: damageTaken,
          }, [damagedActorId])
          events.push(ended)
          triggeredState = applyGameEvent(triggeredState, ended)
        }
      }
    }
    for (const condition of [...(triggeredState.mechanics.conditions[damagedActorId] ?? [])]) {
      const sourceActorId = String(condition.source_actor ?? '')
      const attackerId = String(resolvedEvent.actor_id ?? command.actor_id ?? '')
      const alliedWithSource = sourceActorId && attackerId
        && isEnemyActor(triggeredState, sourceActorId) === isEnemyActor(triggeredState, attackerId)
      if (condition.break_on_damage_from_source_allies === true && alliedWithSource && !(condition.id === 'compelled-duel' && attackerId === sourceActorId)) {
        const sourceConcentration = triggeredState.mechanics.concentration[sourceActorId]
        const removed = condition.effect_id && String(sourceConcentration?.effect_id ?? '') === String(condition.effect_id)
          ? eventFrom(commandWithRules({ ...command, actor_id: sourceActorId }, RULE_IDS.concentration), 'ConcentrationEnded', { reason: 'ally-damaged-duel-target', effect_id: condition.effect_id }, [sourceActorId])
          : eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: condition.id, trigger: 'damage', spell_id: condition.spell_id }, [damagedActorId])
        events.push(removed)
        triggeredState = applyGameEvent(triggeredState, removed)
        continue
      }
      if (condition.repeat_save_on_damage !== true || !isLivingActor(findActor(triggeredState, damagedActorId))) continue
      const ability = String(condition.save_ability || 'wis')
      let modifier = abilityModifier(findActor(triggeredState, damagedActorId)?.abilities?.[ability])
      const conditionIds = conditionIdsFor(triggeredState, damagedActorId)
      if (conditionIds.has('bless-d4')) {
        const blessing = diceService.roll('1d4', 'spell:bless:damage-repeat-save', damagedActorId, command.visibility ?? 'public')
        rolls.push(blessing)
        events.push(eventFrom(command, 'DieRolled', blessing, []))
        modifier += blessing.total
      }
      if (conditionIds.has('bane-d4')) {
        const bane = diceService.roll('1d4', 'spell:bane:damage-repeat-save', damagedActorId, command.visibility ?? 'public')
        rolls.push(bane)
        events.push(eventFrom(command, 'DieRolled', bane, []))
        modifier -= bane.total
      }
      const save = rollSavingThrowD20(triggeredState, diceService, damagedActorId, { modifier, purpose: `spell_damage_repeat_save:${condition.spell_id}:${ability}`, advantage: condition.damage_save_advantage === true, visibility: command.visibility })
      const difficulty = Math.max(1, safeInteger(condition.save_dc, 10))
      const saved = save.total >= difficulty
      rolls.push(save)
      events.push(eventFrom(commandWithRules(command, RULE_IDS.savingThrow), 'SpellSavingThrowResolved', { ...save, spell_id: condition.spell_id, ability, difficulty, saved, trigger: 'damage-repeat' }, [damagedActorId]))
      if (saved) {
        const sourceConcentration = triggeredState.mechanics.concentration[sourceActorId]
        const removed = condition.effect_id && String(sourceConcentration?.effect_id ?? '') === String(condition.effect_id)
          ? eventFrom(commandWithRules({ ...command, actor_id: sourceActorId }, RULE_IDS.concentration), 'ConcentrationEnded', { reason: 'damage-save', effect_id: condition.effect_id }, [sourceActorId])
          : eventFrom(commandWithRules(command, RULE_IDS.conditions), 'ConditionRemoved', { condition: condition.id, trigger: 'damage-save', spell_id: condition.spell_id }, [damagedActorId])
        events.push(removed)
        triggeredState = applyGameEvent(triggeredState, removed)
      }
    }
  }

  if (resolveDepth === 0 && context.indomitableResume !== true) {
    const opportunityState = replayEvents(state, events)
    const opportunities = indomitableOpportunitiesFor(opportunityState, events, context.indomitable_bypass_actor_ids)
    const opportunity = opportunities[0]
    if (opportunity) {
      const failed = opportunity.event.payload
      const option = {
        id: 'indomitable', name: 'Несгибаемый', resource: 'indomitable', cost: 1,
        description: `Перебросить спасбросок с бонусом +${safeInteger(opportunity.actor.level, 9)}. Новый результат обязателен.`,
      }
      const windowEvent = eventFrom(commandWithRules(command, RULE_IDS.savingThrow, RULE_IDS.indomitable), 'ReactionWindowOpened', {
        id: `indomitable:${command.command_id}`,
        trigger: 'failed-saving-throw',
        actor_id: opportunity.target_id,
        source_actor_id: String(command.actor_id ?? opportunity.event.actor_id ?? opportunity.target_id),
        target_id: opportunity.target_id,
        action_ids: ['indomitable'],
        action_options: [option],
        trigger_roll: {
          kept: safeInteger(failed.kept ?? failed.natural_roll, 0), modifier: safeInteger(failed.modifier, 0), total: safeInteger(failed.total, 0),
          difficulty: safeInteger(failed.difficulty, opportunity.event.event_type === 'DeathSavingThrowRolled' ? 10 : 0),
          ability: String(failed.ability ?? (opportunity.event.event_type === 'DeathSavingThrowRolled' ? 'death' : '')),
          save_event_type: opportunity.event.event_type,
        },
        pending_command: clone(command),
        pending_dice_transcript: clone(diceTranscript),
        failed_roll_id: String(failed.roll_id),
        fighter_level: Math.max(9, safeInteger(opportunity.actor.level, 9)),
        pending_indomitable_queue: opportunities.slice(1).map((candidate) => ({
          target_id: candidate.target_id,
          fighter_level: Math.max(9, safeInteger(candidate.actor.level, 9)),
          failed_event: clone(candidate.event),
        })),
        indomitable_decisions: [],
      }, [opportunity.target_id])
      return { command, events: [windowEvent], rolls: [] }
    }
  }

  return { command, events, rolls }
}

function replaceActor(state, id, updater) {
  if (Array.isArray(state.players)) state.players = state.players.map((actor) => actorId(actor) === id ? updater(actor) : actor)
  if (Array.isArray(state.actors)) state.actors = state.actors.map((actor) => actorId(actor) === id ? updater(actor) : actor)
  if (Array.isArray(state.enemies)) state.enemies = state.enemies.map((actor) => actorId(actor) === id ? updater(actor) : actor)
}

function spendCombatEconomy(state, id, resource, { magic = false } = {}) {
  if (!state.mechanics.combat.active || !id) return
  const current = state.mechanics.combat.action_economy[id] ?? actionEconomy()
  if (resource !== 'action') {
    state.mechanics.combat.action_economy[id] = { ...current, [resource]: false }
    return
  }
  const extra = Math.max(0, safeInteger(current.extra_actions, 0))
  if (extra > 0) {
    state.mechanics.combat.action_economy[id] = magic
      ? { ...current, action: true, extra_actions: extra - 1, surged_action_only: true }
      : { ...current, action: true, extra_actions: extra - 1, surged_action_only: false }
    return
  }
  state.mechanics.combat.action_economy[id] = { ...current, action: false, surged_action_only: false }
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

function recentBattleSpellName(state, spellId) {
  if (!spellId) return undefined
  for (let index = state.battleLog.length - 1; index >= 0; index -= 1) {
    const entry = state.battleLog[index]
    if (entry.spellId === String(spellId) && entry.spellName) return entry.spellName
  }
  return undefined
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
      state.worldMap = clone(plainObject(payload.worldMap) ? payload.worldMap : ensureCampaignWorldMap({ ...state, scene: payload.scene }))
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
      if (payload.resistance_cantrip_condition && payload.resistance_cantrip_turn) {
        state.mechanics.conditions[target] = (state.mechanics.conditions[target] ?? []).map((condition) => {
          const id = String(condition?.id ?? condition)
          if (id !== String(payload.resistance_cantrip_condition)) return condition
          return { ...(typeof condition === 'object' ? condition : { id }), last_used_turn: String(payload.resistance_cantrip_turn) }
        })
      }
      if (payload.death_ward_triggered) {
        state.mechanics.conditions[target] = (state.mechanics.conditions[target] ?? []).filter((condition) => String(condition?.id ?? condition) !== 'death-ward')
      }
      if (safeInteger(payload.hp_after, 0) === 0 && state.mechanics.resting[target]?.reason === 'knockout') delete state.mechanics.resting[target]
      if (safeInteger(payload.raw_amount, 0) > 0 && conditionIdsFor(state, target).has('magical-sleep')) {
        state.mechanics.conditions[target] = (state.mechanics.conditions[target] ?? []).filter((condition) => !['magical-sleep', 'unconscious'].includes(String(condition?.id ?? condition)))
      }
      if (safeInteger(payload.temporary_hp_before, 0) > 0 && safeInteger(payload.temporary_hp_after, 0) === 0) {
        state.mechanics.conditions[target] = (state.mechanics.conditions[target] ?? []).filter((condition) => !String(condition?.id ?? condition).startsWith('armor-of-agathys:'))
      }
      let damageJournalUpdated = false
      for (let index = state.battleLog.length - 1; index >= 0; index -= 1) {
        const item = state.battleLog[index]
        if (item.type === 'attack' && item.targetId === target && item.actorId === event.actor_id && item.damage == null) {
          state.battleLog[index] = {
            ...item,
            damage: safeInteger(payload.applied_amount, 0),
            damageType: payload.damage_type ? String(payload.damage_type) : undefined,
            hpBefore: safeInteger(payload.hp_before, 0),
            hpAfter: safeInteger(payload.hp_after, 0),
          }
          damageJournalUpdated = true
          break
        }
      }
      if (!damageJournalUpdated && payload.spell_id) {
        for (let index = state.battleLog.length - 1; index >= 0; index -= 1) {
          const item = state.battleLog[index]
          if (item.type === 'spell-save' && item.targetId === target && item.spellId === String(payload.spell_id) && item.damage == null) {
            state.battleLog[index] = {
              ...item,
              damage: safeInteger(payload.applied_amount, 0),
              damageType: payload.damage_type ? String(payload.damage_type) : undefined,
              hpBefore: safeInteger(payload.hp_before, 0),
              hpAfter: safeInteger(payload.hp_after, 0),
            }
            damageJournalUpdated = true
            break
          }
        }
      }
      if (!damageJournalUpdated && payload.spell_id) {
        appendBattleLog(state, event, {
          sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round),
          round: state.mechanics.combat.round,
          type: 'spell-damage',
          actorId: event.actor_id,
          actorKind: combatActorKind(state, event.actor_id),
          targetId: target,
          spellId: String(payload.spell_id),
          spellName: recentBattleSpellName(state, payload.spell_id),
          damage: safeInteger(payload.applied_amount, 0),
          damageType: payload.damage_type ? String(payload.damage_type) : undefined,
          hpBefore: safeInteger(payload.hp_before, 0),
          hpAfter: safeInteger(payload.hp_after, 0),
        })
      }
      {
        const position = actorPosition(state, target)
        if (position) appendMapFeedback(state, event, { ...position, text: `−${safeInteger(payload.applied_amount, 0)}`, kind: payload.hp_after === 0 ? 'defeat' : 'damage' })
      }
      break
    case 'HitPointMaximumReduced':
      replaceActor(state, target, (actor) => {
        const maximumHp = Math.max(0, safeInteger(payload.maximum_hp_after, actorMaxHp(actor)))
        const hp = Math.min(maximumHp, Math.max(0, safeInteger(payload.hp_after, actorHp(actor))))
        return {
          ...actor,
          maxHp: maximumHp,
          ...(Object.hasOwn(actor, 'max_hp') ? { max_hp: maximumHp } : {}),
          hp,
          ...(isEnemyActor(state, target) ? { alive: maximumHp > 0 && hp > 0 } : {}),
        }
      })
      appendBattleLog(state, event, {
        type: 'max-hp-reduction', actorId: event.actor_id, targetId: target,
        maximumHpBefore: safeInteger(payload.maximum_hp_before, 0), maximumHpAfter: safeInteger(payload.maximum_hp_after, 0),
      })
      break
    case 'HitPointMaximumReductionPrevented':
      appendBattleLog(state, event, {
        type: 'max-hp-reduction-prevented', actorId: event.actor_id, targetId: target,
        maximumHpBefore: safeInteger(payload.maximum_hp_before, 0), maximumHpAfter: safeInteger(payload.maximum_hp_after, 0),
        spellId: 'aura-of-life',
      })
      break
    case 'HealingApplied':
      replaceActor(state, target, (actor) => {
        const hp = Math.min(actorMaxHp(actor), Math.max(0, safeInteger(payload.hp_after, actorHp(actor))))
        return { ...actor, hp, ...(isEnemyActor(state, target) ? { alive: hp > 0 } : {}) }
      })
      appendBattleLog(state, event, {
        sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round),
        round: state.mechanics.combat.round,
        type: 'healing',
        actorId: event.actor_id,
        actorKind: combatActorKind(state, event.actor_id),
        targetId: target,
        spellId: payload.spell_id ? String(payload.spell_id) : undefined,
        spellName: recentBattleSpellName(state, payload.spell_id),
        healing: safeInteger(payload.applied_amount, 0),
        hpBefore: safeInteger(payload.hp_before, 0),
        hpAfter: safeInteger(payload.hp_after, 0),
      })
      if (safeInteger(payload.hp_after, 0) > 0) {
        state.mechanics.conditions[target] = (state.mechanics.conditions[target] ?? []).filter((condition) => condition.id !== 'unconscious')
        delete state.mechanics.death.saving_throws[target]
        if (state.mechanics.resting[target]?.reason === 'knockout') delete state.mechanics.resting[target]
      }
      break
    case 'CreatureKnockedOut': {
      const current = state.mechanics.conditions[target] ?? []
      if (!current.some((condition) => condition.id === 'unconscious')) current.push({ id: 'unconscious', source_rule_ids: event.source_rule_ids ?? [] })
      state.mechanics.conditions[target] = current
      state.mechanics.resting[target] = {
        kind: 'short',
        reason: 'knockout',
        recovery_minutes_remaining: Math.max(1, Math.min(60, safeInteger(payload.recovery_minutes, 60))),
      }
      delete state.mechanics.death.saving_throws[target]
      break
    }
    case 'KnockoutRecoveryProgressed':
      if (state.mechanics.resting[target]?.reason === 'knockout') state.mechanics.resting[target] = {
        ...state.mechanics.resting[target],
        recovery_minutes_remaining: Math.max(1, Math.min(60, safeInteger(payload.recovery_minutes_remaining, 1))),
      }
      break
    case 'KnockoutEnded':
      state.mechanics.conditions[target] = (state.mechanics.conditions[target] ?? []).filter((condition) => condition.id !== 'unconscious')
      if (state.mechanics.resting[target]?.reason === 'knockout') delete state.mechanics.resting[target]
      break
    case 'DeathSavingThrowRolled':
      state.mechanics.death.saving_throws[target] = {
        successes: Math.max(0, Math.min(2, safeInteger(payload.successes_after, 0))),
        failures: Math.max(0, Math.min(2, safeInteger(payload.failures_after, 0))),
        stable: false,
      }
      appendBattleLog(state, event, {
        type: 'death-save', actorId: target, roll: { die: safeInteger(payload.natural_roll, 0), modifier: safeInteger(payload.modifier, 0), total: safeInteger(payload.total, 0), difficulty: 10, hit: payload.success === true },
        successes: safeInteger(payload.successes_after, 0), failures: safeInteger(payload.failures_after, 0), result: String(payload.result ?? ''),
        modifierSources: uniqueStrings(payload.modifier_sources),
        ...(payload.aura_of_protection_source ? {
          auraSourceId: String(payload.aura_of_protection_source),
          auraBonus: Math.max(1, safeInteger(payload.aura_of_protection_bonus, 1)),
        } : {}),
        ...(payload.indomitable_bonus ? {
          indomitableBonus: Math.max(1, safeInteger(payload.indomitable_bonus, 1)),
          indomitableOriginalTotal: safeInteger(payload.indomitable_original_total, 0),
        } : {}),
      })
      break
    case 'DeathSaveFailureRecorded':
      state.mechanics.death.saving_throws[target] = {
        successes: Math.max(0, Math.min(2, safeInteger(payload.successes_after, 0))),
        failures: Math.max(0, Math.min(2, safeInteger(payload.failures_after, 0))),
        stable: false,
      }
      appendBattleLog(state, event, {
        type: 'death-save-damage', actorId: target, successes: safeInteger(payload.successes_after, 0), failures: safeInteger(payload.failures_after, 0),
        critical: payload.critical === true,
      })
      break
    case 'StableRecoveryScheduled':
      state.mechanics.death.saving_throws[target] = {
        successes: 0,
        failures: 0,
        stable: true,
        recovery_minutes_remaining: Math.max(1, safeInteger(payload.recovery_minutes, 60)),
      }
      break
    case 'StableRecoveryProgressed':
      state.mechanics.death.saving_throws[target] = {
        successes: 0,
        failures: 0,
        stable: true,
        recovery_minutes_remaining: Math.max(1, safeInteger(payload.recovery_minutes_remaining, 1)),
      }
      break
    case 'HeroStabilized':
      state.mechanics.death.saving_throws[target] = { successes: 0, failures: 0, stable: true }
      appendBattleLog(state, event, { type: 'hero-stabilized', actorId: target, reason: String(payload.method ?? 'stabilized') })
      break
    case 'HeroDied': {
      delete state.mechanics.death.saving_throws[target]
      const endedEffect = state.mechanics.concentration[target]?.effect_id
      delete state.mechanics.concentration[target]
      delete state.mechanics.temporary_hp[target]
      if (endedEffect) {
        for (const summon of [...(state.actors ?? [])]) {
          if (isPartySummon(summon) && String(summon.sourceEffectId ?? summon.source_effect_id ?? '') === String(endedEffect)) removeSummonedActor(state, actorId(summon))
        }
      }
      state.mechanics.death.heroes[target] = {
        status: 'dead',
        resolution: null,
        died_at: event.occurred_at ?? event.created_at ?? null,
        resolved_at: null,
        replacement_name: null,
      }
      const current = state.mechanics.conditions[target] ?? []
      state.mechanics.conditions[target] = [
        ...current.filter((condition) => !['unconscious', 'dead'].includes(condition.id)),
        { id: 'dead', source_rule_ids: event.source_rule_ids ?? [] },
      ]
      const memberIds = state.partyMemberIds?.length ? state.partyMemberIds.map(String) : state.players.map(actorId)
      if (memberIds.length && memberIds.every((id) => state.mechanics.death.heroes[id]?.status === 'dead')) {
        state.mechanics.death.campaign_status = 'party_defeated'
      }
      break
    }
    case 'HeroResurrected':
    case 'HeroReplaced': {
      const replaced = event.event_type === 'HeroReplaced'
      replaceActor(state, target, (actor) => ({
        ...actor,
        ...(replaced ? { character: String(payload.replacement_name || actor.character || actor.name || target).slice(0, 120) } : {}),
        hp: Math.min(actorMaxHp(actor), Math.max(1, safeInteger(payload.hp_after, replaced ? actorMaxHp(actor) : 1))),
      }))
      state.mechanics.conditions[target] = []
      delete state.mechanics.concentration[target]
      delete state.mechanics.temporary_hp[target]
      delete state.mechanics.death.saving_throws[target]
      if (replaced) {
        for (const pool of Object.values(state.mechanics.resources[target] ?? {})) {
          if (pool && typeof pool === 'object') pool.current = Math.max(0, safeInteger(pool.max, 0))
        }
      }
      state.mechanics.death.heroes[target] = {
        ...(state.mechanics.death.heroes[target] ?? {}),
        status: 'resolved',
        resolution: replaced ? 'replaced' : 'resurrected',
        resolved_at: event.occurred_at ?? event.created_at ?? null,
        replacement_name: replaced ? String(payload.replacement_name || '').slice(0, 120) : null,
      }
      break
    }
    case 'TemporaryHitPointsGranted':
      state.mechanics.temporary_hp[target] = Math.max(0, safeInteger(payload.temporary_hp_after, 0))
      break
    case 'HitPointsReducedToZero': {
      const current = state.mechanics.conditions[target] ?? []
      if (!current.some((condition) => condition.id === 'unconscious')) current.push({ id: 'unconscious', source_rule_ids: event.source_rule_ids ?? [] })
      state.mechanics.conditions[target] = current
      if (playerActor(state, target)) state.mechanics.death.saving_throws[target] = { successes: 0, failures: 0, stable: false }
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
      if (!current.some((item) => item.id === condition)) current.push({
        id: condition,
        duration: payload.duration ?? null,
        source_actor: payload.source_actor ?? event.actor_id ?? null,
        effect_id: payload.effect_id ?? null,
        repeat_save_timing: payload.repeat_save_timing ?? null,
        repeat_save_on_damage: payload.repeat_save_on_damage === true,
        damage_save_advantage: payload.damage_save_advantage === true,
        break_on_damage_from_source_allies: payload.break_on_damage_from_source_allies === true,
        save_ability: payload.save_ability ?? null,
        save_dc: payload.save_dc ?? null,
        spell_id: payload.spell_id ?? null,
        spell_option: payload.spell_option ?? null,
        slot_level: payload.slot_level ?? null,
        start_turn_save: payload.start_turn_save ?? null,
        recurring_damage: payload.recurring_damage ?? null,
        recurring_damage_type: payload.recurring_damage_type ?? null,
        escape_check_ability: payload.escape_check_ability ?? null,
        temporary_hp_amount: payload.temporary_hp_amount ?? null,
        source_rule_ids: event.source_rule_ids ?? [],
      })
      state.mechanics.conditions[target] = current
      const pendingFleeReaction = condition === 'fled'
        && state.mechanics.combat.reaction_window?.trigger === 'enemy-left-reach'
        && String(state.mechanics.combat.reaction_window?.source_actor_id ?? '') === target
      if ((condition === 'fled' && !pendingFleeReaction) || condition === 'surrendered') {
        replaceActor(state, target, (actor) => ({ ...actor, alive: false }))
      }
      if (condition === 'no-reactions' && state.mechanics.combat.active) {
        const economy = state.mechanics.combat.action_economy[target] ?? actionEconomy()
        state.mechanics.combat.action_economy[target] = { ...economy, reaction: false }
      }
      break
    }
    case 'ConditionRemoved':
      state.mechanics.conditions[target] = (state.mechanics.conditions[target] ?? []).filter((condition) => condition.id !== String(payload.condition))
      break
    case 'SpellSavingThrowResolved':
      appendBattleLog(state, event, {
        sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round),
        round: state.mechanics.combat.round,
        type: 'spell-save',
        actorId: event.actor_id,
        actorKind: combatActorKind(state, event.actor_id),
        targetId: target,
        spellId: payload.spell_id ? String(payload.spell_id) : undefined,
        spellName: recentBattleSpellName(state, payload.spell_id),
        ability: payload.ability ? String(payload.ability) : undefined,
        roll: {
          die: safeInteger(payload.kept, 0),
          modifier: safeInteger(payload.modifier, 0),
          total: safeInteger(payload.total, 0),
          difficulty: safeInteger(payload.difficulty, 10),
          hit: payload.saved === true,
        },
        result: payload.saved === true ? 'success' : 'failure',
        automaticSuccess: payload.automatic_success === true,
        immunity: payload.immunity ? String(payload.immunity) : null,
      })
      break
    case 'ConcentrationSavingThrowResolved':
      appendBattleLog(state, event, {
        type: 'concentration-save', actorId: target,
        roll: { die: safeInteger(payload.kept, 0), modifier: safeInteger(payload.modifier, 0), total: safeInteger(payload.total, 0), difficulty: safeInteger(payload.difficulty, 10), hit: payload.saved === true },
        result: payload.saved === true ? 'success' : 'failure',
        ...(payload.aura_of_protection_source ? {
          auraSourceId: String(payload.aura_of_protection_source),
          auraBonus: Math.max(1, safeInteger(payload.aura_of_protection_bonus, 1)),
        } : {}),
        ...(payload.indomitable_bonus ? {
          indomitableBonus: Math.max(1, safeInteger(payload.indomitable_bonus, 1)),
          indomitableOriginalTotal: safeInteger(payload.indomitable_original_total, 0),
        } : {}),
      })
      break
    case 'ConcentrationStarted':
      state.mechanics.concentration[target] = { effect_id: payload.effect_id, source_rule_ids: event.source_rule_ids ?? [] }
      break
    case 'ConcentrationEnded': {
      const effectId = payload.effect_id ?? state.mechanics.concentration[target]?.effect_id
      delete state.mechanics.concentration[target]
      state.mechanics.active_effects = (state.mechanics.active_effects ?? []).filter((effect) => String(effect.effect_id ?? effect.id ?? '') !== String(effectId ?? ''))
      for (const [actorIdValue, conditions] of Object.entries(state.mechanics.conditions)) {
        const endingHeroism = (conditions ?? []).find((condition) => condition.id === 'heroism' && String(condition.effect_id ?? '') === String(effectId ?? ''))
        if (endingHeroism && safeInteger(state.mechanics.temporary_hp[actorIdValue], 0) <= Math.max(0, safeInteger(endingHeroism.temporary_hp_amount, 0))) delete state.mechanics.temporary_hp[actorIdValue]
        state.mechanics.conditions[actorIdValue] = (conditions ?? []).filter((condition) => String(condition.effect_id ?? '') !== String(effectId ?? ''))
      }
      for (const summon of [...(state.actors ?? [])]) {
        if (isPartySummon(summon) && String(summon.sourceEffectId ?? summon.source_effect_id ?? '') === String(effectId ?? '')) removeSummonedActor(state, actorId(summon))
      }
      appendBattleLog(state, event, { type: 'concentration-end', actorId: target, reason: String(payload.reason ?? 'ended'), spellId: effectId ? String(effectId) : undefined })
      break
    }
    case 'AttackResolved': {
      if (!payload.reaction_attack) spendCombatEconomy(state, event.actor_id, 'action')
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
        spellId: payload.spell_id ? String(payload.spell_id) : undefined,
        spellName: payload.spell_name ? String(payload.spell_name) : undefined,
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
      spendCombatEconomy(state, event.actor_id, 'action')
      appendBattleLog(state, event, { sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round), round: state.mechanics.combat.round, type: 'area-attack', actorId: event.actor_id, actorKind: 'player', itemId: payload.item_id, itemName: payload.item_name, area: { ...payload.to, radiusFeet: safeInteger(payload.radius_feet, 5) } })
      break
    }
    case 'EquipmentChanged': {
      replaceActor(state, target, (actor) => ({ ...actor, inventory: (actor.inventory ?? []).map((item) => item.type === 'weapon' ? { ...item, equipped: String(item.id) === String(payload.item_id) } : item) }))
      if (payload.timing === 'action') spendCombatEconomy(state, event.actor_id, 'action')
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
    case 'CombatActionUsed': {
      if (state.mechanics.combat.active && event.actor_id) {
        const economy = state.mechanics.combat.action_economy[event.actor_id] ?? actionEconomy()
        if (payload.restore_action) {
          const alreadyReady = economy.action !== false
          state.mechanics.combat.action_economy[event.actor_id] = {
            ...economy,
            action: true,
            extra_actions: Math.max(0, safeInteger(economy.extra_actions, 0)) + (alreadyReady ? 1 : 0),
            surged_action_only: !alreadyReady,
          }
        } else if (!payload.economy_consumed_by_attack) {
          const resource = payload.action_type === 'bonus_action' ? 'bonus_action' : payload.action_type === 'reaction' ? 'reaction' : payload.action_type === 'free' ? null : 'action'
          if (resource) spendCombatEconomy(state, event.actor_id, resource)
        }
        if (safeInteger(payload.movement_bonus, 0) > 0) {
          const updated = state.mechanics.combat.action_economy[event.actor_id] ?? economy
          state.mechanics.combat.action_economy[event.actor_id] = { ...updated, movement: true, movement_bonus: Math.max(0, safeInteger(updated.movement_bonus, 0)) + safeInteger(payload.movement_bonus, 0) }
        }
        if (safeInteger(payload.movement_spent, 0) > 0) {
          const updated = state.mechanics.combat.action_economy[event.actor_id] ?? economy
          const spent = Math.max(0, safeInteger(updated.movement_spent, 0) + safeInteger(payload.movement_spent, 0))
          const total = Math.max(0, safeInteger(findActor(state, event.actor_id)?.speed, 30) + safeInteger(updated.movement_bonus, 0))
          state.mechanics.combat.action_economy[event.actor_id] = { ...updated, movement_spent: spent, movement: spent < total }
        }
      }
      appendBattleLog(state, event, {
        sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round), round: state.mechanics.combat.round,
        type: 'action', actorId: event.actor_id, actorKind: combatActorKind(state, event.actor_id), targetId: target,
        actionId: payload.action_id, actionName: payload.name,
        ...(payload.indomitable_bonus ? {
          indomitableBonus: Math.max(1, safeInteger(payload.indomitable_bonus, 1)),
          indomitableOriginalTotal: safeInteger(payload.original_total, 0),
        } : {}),
      })
      break
    }
    case 'SpellAreaCreated': {
      const effect = payload.effect && typeof payload.effect === 'object' ? clone(payload.effect) : null
      if (effect?.id) state.mechanics.active_effects = [...(state.mechanics.active_effects ?? []).filter((candidate) => String(candidate.id) !== String(effect.id)), effect]
      break
    }
    case 'ReactionWindowOpened':
      state.mechanics.combat.reaction_window = clone(payload)
      break
    case 'ReactionWindowClosed': {
      const reactionWindow = state.mechanics.combat.reaction_window
      if (!payload.id || String(reactionWindow?.id ?? '') === String(payload.id)) {
        const fleeingActorId = reactionWindow?.trigger === 'enemy-left-reach'
          ? String(reactionWindow.source_actor_id ?? '')
          : ''
        if (fleeingActorId && conditionIdsFor(state, fleeingActorId).has('fled')) {
          replaceActor(state, fleeingActorId, (actor) => ({ ...actor, alive: false }))
        }
        state.mechanics.combat.reaction_window = null
      }
      break
    }
    case 'ReactionDamageReduced':
      replaceActor(state, target, (actor) => ({ ...actor, hp: Math.min(actorMaxHp(actor), Math.max(0, safeInteger(payload.hp_after, actorHp(actor)))) }))
      if (payload.temporary_hp_after != null) state.mechanics.temporary_hp[target] = Math.max(0, safeInteger(payload.temporary_hp_after, 0))
      for (let index = state.battleLog.length - 1; index >= 0; index -= 1) {
        const item = state.battleLog[index]
        if (item.type === 'attack' && item.targetId === target && item.damage != null) {
          state.battleLog[index] = { ...item, damage: Math.max(0, safeInteger(item.damage, 0) - safeInteger(payload.prevented_amount, 0)), hpAfter: safeInteger(payload.hp_after, item.hpAfter) }
          break
        }
      }
      appendBattleLog(state, event, { sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round), round: state.mechanics.combat.round, type: 'reaction', actorId: event.actor_id, actorKind: combatActorKind(state, event.actor_id), targetId: target, actionId: payload.action_id, preventedDamage: safeInteger(payload.prevented_amount, 0) })
      break
    case 'SpellCountered':
      appendBattleLog(state, event, { sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round), round: state.mechanics.combat.round, type: 'reaction', actorId: event.actor_id, actorKind: combatActorKind(state, event.actor_id), targetId: target, actionId: 'counterspell', spellId: payload.spell_id, spellName: payload.spell_name, countered: true })
      break
    case 'SpellCast':
      if (state.mechanics.combat.active && event.actor_id) {
        const resource = payload.action_type === 'bonus_action' ? 'bonus_action' : payload.action_type === 'reaction' ? 'reaction' : 'action'
        spendCombatEconomy(state, event.actor_id, resource, { magic: resource === 'action' })
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
        reaction_window: null,
      }
      if (state.mechanics.encounter && state.mechanics.encounter.status === 'staged') {
        state.mechanics.encounter = { ...state.mechanics.encounter, status: 'active', started_at: event.occurred_at ?? event.created_at ?? null }
      }
      appendBattleLog(state, event, { type: 'combat-start', round: safeInteger(payload.round, 1), participantIds: targets })
      break
    }
    case 'CombatEnded':
      appendBattleLog(state, event, { type: 'combat-end', round: safeInteger(payload.round, state.mechanics.combat.round), reason: String(payload.reason || 'resolved') })
      state.mechanics.combat = { active: false, round: safeInteger(payload.round, state.mechanics.combat.round), initiative: [], active_index: -1, action_economy: {}, reaction_window: null }
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
      for (const [actorIdValue, conditions] of Object.entries(state.mechanics.conditions)) {
        state.mechanics.conditions[actorIdValue] = (conditions ?? []).flatMap((condition) => {
          if (String(condition.source_actor ?? '') !== String(event.actor_id ?? '')) return [condition]
          const sourceTurns = String(condition.duration ?? '').match(/^source-turns:(\d+)$/u)
          if (!sourceTurns) return [condition]
          const remaining = Number(sourceTurns[1]) - 1
          return remaining > 0 ? [{ ...condition, duration: `source-turns:${remaining}` }] : []
        })
      }
      appendBattleLog(state, event, {
        sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round), round: safeInteger(payload.round, state.mechanics.combat.round),
        type: 'turn-end', actorId: event.actor_id, actorKind: combatActorKind(state, event.actor_id),
      })
      break
    case 'TurnStarted':
      state.mechanics.combat.round = safeInteger(payload.round, state.mechanics.combat.round)
      state.mechanics.combat.active_index = safeInteger(payload.active_index, state.mechanics.combat.active_index)
      state.mechanics.active_effects = (state.mechanics.active_effects ?? []).filter((effect) => safeInteger(effect.expires_round, Number.MAX_SAFE_INTEGER) > state.mechanics.combat.round)
      if (target) {
        state.mechanics.combat.action_economy[target] = actionEconomy()
        state.mechanics.conditions[target] = (state.mechanics.conditions[target] ?? []).flatMap((condition) => {
          if (condition.duration === 'until-next-turn') return []
          const rounds = String(condition.duration ?? '').match(/^rounds:(\d+)$/u)
          if (!rounds) return [condition]
          const remaining = Number(rounds[1]) - 1
          return remaining > 0 ? [{ ...condition, duration: `rounds:${remaining}` }] : []
        })
      }
      break
    case 'ActorMoved':
      state.mechanics.positions[target] = clone(payload.to)
      replaceActor(state, target, (actor) => payload.to && Number.isFinite(Number(payload.to.x)) && Number.isFinite(Number(payload.to.y))
        ? { ...actor, x: Number(payload.to.x), y: Number(payload.to.y) }
        : actor)
      if (state.mechanics.combat.active && event.actor_id && payload.spend_movement !== false) {
        const economy = state.mechanics.combat.action_economy[event.actor_id] ?? actionEconomy()
        state.mechanics.combat.action_economy[event.actor_id] = {
          ...economy,
          movement_spent: Math.max(0, safeInteger(payload.movement_spent, safeInteger(economy.movement_spent, 0) + safeInteger(payload.distance, 0))),
          movement: safeInteger(payload.movement_remaining, 0) > 0,
          ...(payload.monster_ability === 'aggressive' ? { bonus_action: false } : {}),
        }
      }
      appendBattleLog(state, event, {
        sceneTurn: safeInteger(state.scene?.turn, state.mechanics.combat.round), round: state.mechanics.combat.round,
        type: 'move', actorId: event.actor_id, actorKind: combatActorKind(state, event.actor_id),
        from: clone(payload.from), to: clone(payload.to), distanceFeet: safeInteger(payload.distance, 0),
      })
      break
    case 'RestStarted':
      state.mechanics.resting[target] = { kind: payload.kind === 'long' ? 'long' : 'short' }
      break
    case 'RestCompleted': {
      const actor = findActor(state, target)
      const kind = payload.kind === 'long' ? 'long' : 'short'
      const pools = state.mechanics.resources[target] ?? {}
      const recovery = actor ? combatResourceRecoveryFor(actor) : {}
      state.mechanics.resources[target] = Object.fromEntries(Object.entries(pools).map(([resource, pool]) => [resource, {
        ...pool,
        current: kind === 'long' || resource === 'pact_slots' || recovery[resource] === 'short_or_long'
          ? Math.max(0, safeInteger(pool.max, 0))
          : Math.max(0, safeInteger(pool.current, 0)),
      }]))
      if (kind === 'long' && actor) {
        replaceActor(state, target, (candidate) => ({ ...candidate, hp: actorMaxHp(candidate) }))
        state.mechanics.temporary_hp[target] = 0
        state.mechanics.conditions[target] = (state.mechanics.conditions[target] ?? []).filter((condition) => {
          const duration = String(condition?.duration ?? '').trim().toLowerCase()
          return !duration || ['permanent', 'until-removed', 'until-dispelled'].includes(duration)
        })
        delete state.mechanics.death.saving_throws[target]
      }
      if (payload.reason === 'knockout') state.mechanics.conditions[target] = (state.mechanics.conditions[target] ?? []).filter((condition) => condition.id !== 'unconscious')
      delete state.mechanics.resting[target]
      break
    }
    case 'NpcSocialProfileUpserted':
    case 'NpcConversationRecorded':
    case 'NpcRelationshipAdjusted':
    case 'NpcRelationshipTierChanged':
    case 'NpcPromiseRecorded':
    case 'NpcPromiseResolved':
      state.social = applyNpcSocialEvent(state.social, event, state)
      break
    case 'TimeAdvanced': {
      const elapsed = Math.max(0, safeInteger(payload.elapsed_minutes, durationInMinutes(payload.amount, payload.unit)))
      const total = Math.max(0, safeInteger(state.mechanics.world_time?.elapsed_minutes, 0) + elapsed)
      state.mechanics.world_time = { amount: total, unit: 'minute', elapsed_minutes: total }
      break
    }
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
    case 'ExperienceAwarded': {
      const recipientIds = uniqueStrings(Array.isArray(payload.recipients) ? payload.recipients : targets)
      const playerIds = new Set(state.players.map(actorId))
      const recipients = recipientIds.filter((id) => playerIds.has(id))
      const totalXp = Math.max(0, safeInteger(payload.total_xp, 0))
      if (recipients.length && totalXp > 0) {
        const share = Math.floor(totalXp / recipients.length)
        const remainder = totalXp % recipients.length
        const awards = new Map(recipients.map((id, index) => [id, share + (index < remainder ? 1 : 0)]))
        state.players = state.players.map((player) => ({
          ...player, experience: Math.max(0, safeInteger(player.experience, 0) + (awards.get(actorId(player)) ?? 0)),
        }))
      }
      break
    }
    case 'WorldEntityUpserted':
    case 'WorldFactRecorded':
    case 'WorldFactRevealed':
    case 'QuestUpserted':
    case 'QuestClockAdvanced':
      state.worldMemory = applyWorldMemoryEvent(state.worldMemory, event)
      break
    case 'RulingRecorded':
      state.rulings = [...(Array.isArray(state.rulings) ? state.rulings : []), clone(payload.ruling)]
      break
    default:
      break
  }
  state.autonomy = applyAutonomyEvent(state.autonomy, event)
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
    case 'NpcSocialProfileUpserted': return `NPC profile updated: ${payload.npc?.name || payload.npc?.id}`
    case 'NpcConversationRecorded': return `Conversation recorded with ${payload.conversation?.npc_id}`
    case 'NpcRelationshipAdjusted': return `NPC relationship changed by ${payload.delta}: ${payload.tier_before || 'neutral'} -> ${payload.tier_after || 'neutral'}`
    case 'NpcRelationshipTierChanged': return `NPC relationship tier changed: ${payload.tier_before} -> ${payload.tier_after}`
    case 'NpcPromiseRecorded': return `NPC promise recorded: ${payload.promise?.text || payload.promise?.id}`
    case 'NpcPromiseResolved': return `NPC promise ${payload.promise_id} resolved as ${payload.status}`
    case 'WorldEntityUpserted': return `World entity updated: ${payload.entity?.name || payload.entity?.id}`
    case 'WorldFactRecorded': return `World fact recorded: ${payload.fact?.summary || payload.fact?.object || payload.fact?.id}`
    case 'WorldFactRevealed': return `Fact ${payload.fact_id} revealed to ${(event.target_ids ?? []).length} heroes`
    case 'QuestUpserted': return `Quest updated: ${payload.quest?.title || payload.quest?.id}`
    case 'QuestClockAdvanced': return `Quest clock ${payload.quest_id} advanced by ${payload.amount}`
    case 'SceneAdvanced': return `Сцена перемещена из ${payload.location_before || 'прежней локации'} в ${payload.location_after || payload.scene?.location || 'новую локацию'}`
    case 'EncounterCreated': return `Создано столкновение: ${(payload.encounter?.enemies ?? []).map((enemy) => enemy.name).join(', ')}`
    case 'EncounterEnded': return `Столкновение завершено: ${payload.reason || payload.outcome || 'resolved'}`
    case 'CombatStarted': return `Бой начался; инициатива определена для ${(event.target_ids ?? []).length} участников`
    case 'ActorMoved': return `${event.actor_id || 'Участник'} перемещается на ${safeInteger(payload.distance, 0)} фт.`
    case 'TurnEnded': return `${event.actor_id || 'Участник'} завершает ход`
    case 'TurnStarted': return `Начинается ход ${(event.target_ids ?? [])[0] || 'следующего участника'}, раунд ${safeInteger(payload.round, 1)}`
    case 'DieRolled': return `Бросок ${payload.expression || 'кости'}: ${safeInteger(payload.total, 0)}`
    case 'DamageApplied': return payload.death_ward_triggered
      ? `Урон: ${payload.applied_amount}; Death Ward удерживает цель на 1 HP`
      : payload.resistance_cantrip_reduction
        ? `Урон снижен Resistance на ${payload.resistance_cantrip_reduction}; HP ${payload.hp_before} → ${payload.hp_after}`
        : `Урон: ${payload.applied_amount}; HP ${payload.hp_before} → ${payload.hp_after}`
    case 'HealingApplied': return `Лечение: ${payload.applied_amount}; HP ${payload.hp_before} → ${payload.hp_after}`
    case 'HitPointMaximumReduced': return `Максимум HP снижен: ${payload.maximum_hp_before} → ${payload.maximum_hp_after}`
    case 'HitPointMaximumReductionPrevented': return `Aura of Life предотвращает снижение максимума HP`
    case 'AttackResolved': return `Атака ${payload.hit ? 'попала' : 'не попала'}: ${payload.total} против КД ${payload.armor_class}`
    case 'AreaAttackResolved': return `${payload.item_name || 'Снаряд'} поражает область радиусом ${payload.radius_feet} фт.`
    case 'EquipmentChanged': return `${payload.item_name || 'Оружие'} экипировано`
    case 'CombatActionUsed': return `${event.actor_id || 'Участник'} использует ${payload.name || payload.action_id || 'боевое действие'}`
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
    case 'SavingThrowResolved': return `Спасбросок ${payload.ability}: ${payload.total} против СЛ ${payload.difficulty}${payload.aura_of_protection_bonus ? ` (Аура защиты +${payload.aura_of_protection_bonus})` : ''}${payload.indomitable_bonus ? ` (Несгибаемый +${payload.indomitable_bonus}; исходный итог ${payload.indomitable_original_total})` : ''}`
    case 'SpellSavingThrowResolved': return `Спасбросок от ${payload.spell_id || 'заклинания'}: ${payload.total} против СЛ ${payload.difficulty} — ${payload.saved ? 'успех' : 'провал'}${payload.indomitable_bonus ? ` (Несгибаемый +${payload.indomitable_bonus}; исходный итог ${payload.indomitable_original_total})` : ''}`
    case 'ConcentrationSavingThrowResolved': return `Концентрация: ${payload.total} против СЛ ${payload.difficulty} — ${payload.saved ? 'сохранена' : 'потеряна'}${payload.aura_of_protection_bonus ? ` (Аура защиты +${payload.aura_of_protection_bonus})` : ''}${payload.indomitable_bonus ? ` (Несгибаемый +${payload.indomitable_bonus}; исходный итог ${payload.indomitable_original_total})` : ''}`
    case 'ConcentrationEnded': return `Концентрация прекращена: ${payload.reason || 'эффект завершён'}`
    case 'ResourceSpent': return `${payload.resource}: ${payload.before} → ${payload.after}`
    case 'ConditionAdded': return `Добавлено состояние: ${payload.condition}`
    case 'ConditionRemoved': return `Снято состояние: ${payload.condition}`
    case 'HitPointsReducedToZero': return `${(event.target_ids ?? [])[0] || 'Цель'} выбывает из боя`
    case 'DeathSavingThrowRolled': return `Спасбросок от смерти ${(event.target_ids ?? [])[0] || 'героя'}: ${payload.natural_roll} — ${payload.result}${payload.aura_of_protection_bonus ? ` (Аура защиты +${payload.aura_of_protection_bonus})` : ''}${payload.indomitable_bonus ? ` (Несгибаемый +${payload.indomitable_bonus}; исходный итог ${payload.indomitable_original_total})` : ''}`
    case 'DeathSaveFailureRecorded': return `${(event.target_ids ?? [])[0] || 'Герой'} получает ${payload.failure_increment || 1} провал спасброска от смерти из-за урона`
    case 'HeroStabilized': return `${payload.hero_name || (event.target_ids ?? [])[0] || 'Герой'} стабилизирован`
    case 'CreatureKnockedOut': return `${(event.target_ids ?? [])[0] || 'Существо'} нокаутировано и начинает короткий отдых`
    case 'KnockoutRecoveryProgressed': return `До пробуждения ${(event.target_ids ?? [])[0] || 'существа'} осталось ${payload.recovery_minutes_remaining || 0} мин.`
    case 'KnockoutEnded': return `${(event.target_ids ?? [])[0] || 'Существо'} приходит в сознание после первой помощи`
    case 'StableRecoveryScheduled': return `${(event.target_ids ?? [])[0] || 'Герой'} восстановит 1 ОЗ через ${payload.recovery_hours || 1} ч.`
    case 'StableRecoveryProgressed': return `До восстановления ${(event.target_ids ?? [])[0] || 'героя'} осталось ${payload.recovery_minutes_remaining || 0} мин.`
    case 'HeroDied': return `${payload.hero_name || (event.target_ids ?? [])[0] || 'Герой'} погибает`
    case 'HeroResurrected': return `${(event.target_ids ?? [])[0] || 'Герой'} возвращается к жизни`
    case 'HeroReplaced': return `${payload.replacement_name || 'Новый герой'} присоединяется к группе`
    case 'RestStarted': return `${event.actor_id || 'Герой'} начинает ${payload.kind === 'long' ? 'продолжительный' : 'короткий'} отдых`
    case 'RestCompleted': return `${event.actor_id || 'Герой'} завершает ${payload.kind === 'long' ? 'продолжительный' : 'короткий'} отдых`
    case 'TimeAdvanced': return `Проходит ${payload.amount || 0} ${payload.unit || 'мин.'}`
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
