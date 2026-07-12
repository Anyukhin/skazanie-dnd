import { SHOP_ASSEMBLER_LIMITS, SHOP_SETTLEMENT_TYPES, SHOP_THEMES } from './shop-assembler.mjs'

export const SCENE_COMMERCE_PLAN_VERSION = 'skazanie:scene-commerce-plan-v1'

const SETTLEMENT_TYPES = new Set(SHOP_SETTLEMENT_TYPES)
const THEMES = new Set(SHOP_THEMES)
const WILDERNESS_SHOPS = new Set(['outpost', 'traveling'])
const SHOP_INTENT_FIELDS = new Set(['action', 'settlement_type', 'theme', 'budget_cp', 'reason'])

const BUDGETS_CP = Object.freeze({
  village: 8_000,
  town: 20_000,
  city: 50_000,
  outpost: 12_000,
  traveling: 10_000,
})

function text(value, maximum = 240) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sceneText(sceneArgs = {}) {
  return [
    sceneArgs.location,
    sceneArgs.title,
    sceneArgs.theme,
    sceneArgs.map?.layout,
  ].map((value) => text(value, 240)).join(' ').toLocaleLowerCase('ru')
}

function isSettlement(value) {
  return /(?:^|\W)(?:город(?:ок|а|е|у|ом)?|деревн(?:я|и|ю|е)|пос[её]лок|поселени(?:е|я)|рынок|площадь|улиц(?:а|ы|е|у)|порт(?:а|у|ом)?|таверн(?:а|ы|е|у)|city|town|village|settlement|market|street|harbou?r)(?:$|\W)/iu.test(value)
}

function settlementType(value) {
  if (/(?:деревн|село|village)/iu.test(value)) return 'village'
  if (/(?:застав|форпост|гарнизон|outpost|garrison)/iu.test(value)) return 'outpost'
  if (/(?:столиц|мегапол|больш(?:ой|ого)\s+город|capital|metropolis|large\s+city)/iu.test(value)) return 'city'
  if (/(?:город|city)/iu.test(value)) return 'city'
  return 'town'
}

function shopTheme(value) {
  if (/(?:оруж|доспех|кузн|арсенал|гарнизон|weapon|armou?r|smith|forge|arsenal)/iu.test(value)) return 'arms'
  if (/(?:леч|целител|аптек|алхим|храм|лекар|healing|healer|apothecar|temple|hospital)/iu.test(value)) return 'healing'
  if (/(?:припас|провиант|снабжен|караван|тракт|дорог|порт|provision|supply|caravan|road|harbou?r)/iu.test(value)) return 'provisions'
  return 'general'
}

export function defaultSceneShopIntent(sceneArgs = {}) {
  const value = sceneText(sceneArgs)
  if (!isSettlement(value)) {
    return Object.freeze({
      version: SCENE_COMMERCE_PLAN_VERSION,
      action: 'none',
      settlement_type: 'traveling',
      theme: 'provisions',
      budget_cp: BUDGETS_CP.traveling,
      reason: 'В сцене не обнаружено поселение или постоянная торговая точка.',
    })
  }
  const settlement = settlementType(value)
  return Object.freeze({
    version: SCENE_COMMERCE_PLAN_VERSION,
    action: 'create',
    settlement_type: settlement,
    theme: shopTheme(value),
    budget_cp: BUDGETS_CP[settlement],
    reason: 'Новая сцена является поселением, поэтому Директор запросил базовую торговую точку.',
  })
}

/**
 * Normalizes an untrusted Director proposal. The Director may decide whether a
 * shop is useful and select a broad profile, but cannot provide prices, stock,
 * persona, secrets or arbitrary catalog identifiers here.
 */
export function normalizeSceneShopIntent(input, sceneArgs = {}) {
  const fallback = defaultSceneShopIntent(sceneArgs)
  if (input == null) return fallback
  if (!plainObject(input) || Object.keys(input).some((key) => !SHOP_INTENT_FIELDS.has(key))) return fallback

  const action = input.action === 'create' || input.action === 'none' ? input.action : fallback.action
  const settlement = SETTLEMENT_TYPES.has(input.settlement_type) ? input.settlement_type : fallback.settlement_type
  const theme = THEMES.has(input.theme) ? input.theme : fallback.theme
  const requestedBudget = Number(input.budget_cp)
  const budget = Number.isSafeInteger(requestedBudget)
    ? Math.max(SHOP_ASSEMBLER_LIMITS.minimum_budget_cp, Math.min(SHOP_ASSEMBLER_LIMITS.maximum_budget_cp, requestedBudget))
    : fallback.budget_cp
  const wilderness = fallback.action === 'none'
  const safeAction = action === 'create' && wilderness && !WILDERNESS_SHOPS.has(settlement) ? 'none' : action

  return Object.freeze({
    version: SCENE_COMMERCE_PLAN_VERSION,
    action: safeAction,
    settlement_type: settlement,
    theme,
    budget_cp: budget,
    reason: text(input.reason, 240) || fallback.reason,
  })
}
