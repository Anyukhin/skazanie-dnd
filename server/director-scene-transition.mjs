import { createHash } from 'node:crypto'

import { createSceneTransition } from './adventure-director.mjs'
import { locationsMatch } from './merchant-economy.mjs'
import { normalizeSceneShopIntent } from './scene-commerce.mjs'
import { assembleShop } from './shop-assembler.mjs'

export const DIRECTOR_TRANSITION_CONTRACT_VERSION = 'skazanie:director-transition-v1'

const SAFE_PARTY_DECISION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u

export class DirectorTransitionError extends Error {
  constructor(message, code = 'DIRECTOR_TRANSITION_FAILED') {
    super(message)
    this.name = 'DirectorTransitionError'
    this.code = code
  }
}

function compactText(value, maximum) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
}

function partyDecisionId(value, label) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!SAFE_PARTY_DECISION_ID.test(id)) {
    throw new DirectorTransitionError(`${label} должен быть безопасным идентификатором`, 'INVALID_PARTY_DECISION_REFERENCE')
  }
  return id
}

/**
 * Produces the immutable identity of the resolved vote consumed by a scene
 * transition. Persisted references are accepted for idempotent replay; room
 * interactions additionally have to be resolved and point at a real option.
 */
export function resolvedPartyDecisionReference(value, { required = true } = {}) {
  if (value == null) {
    if (!required) return null
    throw new DirectorTransitionError('Переход сцены требует подтверждённого решения группы', 'PARTY_DECISION_REQUIRED')
  }

  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  const explicit = source && (Object.hasOwn(source, 'interaction_id') || Object.hasOwn(source, 'resolved_option_id'))
  if (explicit) {
    return Object.freeze({
      interaction_id: partyDecisionId(source.interaction_id, 'interaction_id'),
      resolved_option_id: partyDecisionId(source.resolved_option_id, 'resolved_option_id'),
    })
  }

  const interaction = source?.agentInteraction ?? source
  if (!interaction || typeof interaction !== 'object' || Array.isArray(interaction)
    || interaction.status !== 'resolved' || !interaction.resolvedOptionId) {
    if (!required) return null
    throw new DirectorTransitionError('Переход сцены требует завершённого решения группы', 'PARTY_DECISION_REQUIRED')
  }
  const optionId = partyDecisionId(interaction.resolvedOptionId, 'resolved_option_id')
  const hasResolvedOption = Array.isArray(interaction.options)
    && interaction.options.some((option) => String(option?.id ?? '') === optionId)
  if (!hasResolvedOption) {
    throw new DirectorTransitionError('Выбранный вариант отсутствует в решении группы', 'INVALID_PARTY_DECISION_REFERENCE')
  }
  return Object.freeze({
    interaction_id: partyDecisionId(interaction.id, 'interaction_id'),
    resolved_option_id: optionId,
  })
}

const DUNGEON_SCENE = /(?:подзем|пещер|склеп|руин|храм|dungeon|cave|crypt|ruin)/iu
const SETTLEMENT_SCENE = /(?:город|деревн|село|пос[её]лок|поселени|рынок|площад|улиц|порт|таверн|застав|форпост|гарнизон|city|town|village|settlement|market|street|harbou?r|outpost|garrison)/iu
const ROAD_SCENE = /(?:тракт|дорог|путь|перевал|road|route|pass)/iu
const WILDERNESS_SCENE = /(?:лес|чащ|болот|роща|пустын|wilderness|forest|swamp|desert)/iu

/** Commerce proposals must never decide what kind of place the world contains. */
function sceneKind(sceneArgs, transition) {
  const theme = compactText(sceneArgs?.theme, 160)
  const place = [
    transition?.scene?.location,
    transition?.scene?.title,
    sceneArgs?.location,
    sceneArgs?.title,
  ].map((item) => compactText(item, 160)).join(' ')
  const layout = compactText(sceneArgs?.map?.layout, 40).toLocaleLowerCase('en')

  if (layout === 'rooms') return 'dungeon'
  if (SETTLEMENT_SCENE.test(theme) || layout === 'streets') return 'settlement'
  if (DUNGEON_SCENE.test(theme)) return 'dungeon'
  if (WILDERNESS_SCENE.test(theme)) return 'wilderness'
  if (ROAD_SCENE.test(theme)) return 'road'
  if (DUNGEON_SCENE.test(place)) return 'dungeon'
  if (SETTLEMENT_SCENE.test(place)) return 'settlement'
  if (ROAD_SCENE.test(place)) return 'road'
  if (WILDERNESS_SCENE.test(place)) return 'wilderness'
  return 'other'
}

function commerceForScene(shopIntent, kind) {
  if (kind === 'settlement') return shopIntent
  return Object.freeze({
    ...shopIntent,
    action: 'none',
    reason: 'Сцена не классифицирована как поселение; постоянная торговая точка не создаётся.',
  })
}

function lifecycleMerchantFromProposal(merchant) {
  const pricing = merchant?.pricing ?? {}
  return {
    id: merchant.id,
    name: merchant.name,
    title: merchant.title,
    description: merchant.description,
    greeting: merchant.greeting,
    voice: merchant.voice,
    location: merchant.location,
    available: merchant.available !== false,
    purse_cp: merchant.purse_cp,
    pricing: {
      mode: pricing.mode,
      buy_markup_bps: pricing.buy_markup_bps,
      sell_rate_bps: pricing.sell_rate_bps,
      bargain_dc: pricing.bargain_dc,
      success_discount_bps: pricing.success_discount_bps,
      failure_markup_bps: pricing.failure_markup_bps,
      agent_adjustment_bps: pricing.agent_adjustment_bps,
      agent_adjustment_limit_percent: pricing.agent_adjustment_limit_percent,
      description: pricing.description,
    },
    stock: (Array.isArray(merchant.stock) ? merchant.stock : []).map((item) => ({
      stock_id: item.stock_id,
      catalog_id: item.catalog_id,
      quantity: item.quantity,
      name: item.name,
      type: item.type,
      weight: item.weight,
      rarity: item.rarity,
      description: item.description,
      properties: item.properties,
    })),
  }
}

export function directorTransitionFingerprint({ campaignId, action }) {
  const campaign = compactText(campaignId, 120)
  const semanticAction = compactText(action, 2_000)
  if (!campaign || !semanticAction) {
    throw new DirectorTransitionError('Для перехода нужны campaignId и подтверждённое действие группы', 'INVALID_DIRECTOR_TRANSITION')
  }
  return createHash('sha256')
    .update(DIRECTOR_TRANSITION_CONTRACT_VERSION)
    .update('\0')
    .update(campaign)
    .update('\0')
    .update(semanticAction)
    .digest('hex')
}

export function directorDecisionFingerprint({ campaignId, partyDecision }) {
  const campaign = compactText(campaignId, 120)
  const reference = resolvedPartyDecisionReference(partyDecision)
  return createHash('sha256')
    .update(DIRECTOR_TRANSITION_CONTRACT_VERSION)
    .update('\0decision\0')
    .update(campaign)
    .update('\0')
    .update(reference.interaction_id)
    .update('\0')
    .update(reference.resolved_option_id)
    .digest('hex')
}

/**
 * Builds only server-derived commands. The scene architect may describe a
 * destination and request a broad shop profile; the server owns transition
 * topology, merchant identity, catalog entries, quantities and all prices.
 */
export function buildDirectorTransitionCommands({
  campaignId,
  action,
  state,
  sceneArgs,
  shopIntent,
  partyDecision,
} = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new DirectorTransitionError('Не найдено авторитетное состояние кампании', 'INVALID_DIRECTOR_TRANSITION_STATE')
  }
  const fingerprint = directorTransitionFingerprint({ campaignId, action })
  const resolvedDecision = resolvedPartyDecisionReference(partyDecision ?? state)
  const decisionFingerprint = directorDecisionFingerprint({ campaignId, partyDecision: resolvedDecision })
  const provisionalTransition = createSceneTransition(sceneArgs, state)
  const kind = sceneKind(sceneArgs, provisionalTransition)
  const normalizedShopIntent = commerceForScene(normalizeSceneShopIntent(shopIntent, sceneArgs), kind)
  const canonicalSceneArgs = {
    ...(sceneArgs && typeof sceneArgs === 'object' && !Array.isArray(sceneArgs) ? sceneArgs : {}),
    scene_kind: kind,
    settlement_type: kind === 'settlement' ? normalizedShopIntent.settlement_type : null,
  }
  const transition = createSceneTransition(canonicalSceneArgs, state)
  const shopRequested = kind === 'settlement' && normalizedShopIntent.action === 'create'
  const existingMerchant = shopRequested
    ? (Array.isArray(state.merchants) ? state.merchants : [])
      .find((merchant) => locationsMatch(merchant?.location, transition.scene.location)) ?? null
    : null

  const commands = [{
    command_type: 'AdvanceScene',
    expected_state_version: Number(state.state_version) || 0,
    scene_args: canonicalSceneArgs,
    scene_commerce: {
      ...normalizedShopIntent,
      outcome: !shopRequested
        ? 'not-requested'
        : existingMerchant ? 'reused' : 'created',
      merchant_id: existingMerchant?.id ?? null,
    },
    party_decision: resolvedDecision,
    request_fingerprint: fingerprint,
  }]

  let shopProposal = null
  if (shopRequested && !existingMerchant) {
    shopProposal = assembleShop({
      location: transition.scene.location,
      settlement_type: normalizedShopIntent.settlement_type,
      theme: normalizedShopIntent.theme,
      seed: `decision-${decisionFingerprint.slice(0, 48)}`,
      budget_cp: normalizedShopIntent.budget_cp,
    })
    commands.push({
      command_type: 'CreateMerchant',
      merchant: lifecycleMerchantFromProposal(shopProposal.merchant),
      request_fingerprint: fingerprint,
    })
  }

  return Object.freeze({
    fingerprint,
    decisionFingerprint,
    partyDecision: resolvedDecision,
    transition,
    shopIntent: normalizedShopIntent,
    shopProposal,
    existingMerchantId: existingMerchant?.id ?? null,
    commands: Object.freeze(commands.map((command) => Object.freeze(command))),
  })
}

export function assertDirectorTransitionResult(result, expectedFingerprint) {
  const events = Array.isArray(result?.mechanics) ? result.mechanics : []
  const sceneEvents = events.filter((event) => event?.event_type === 'SceneAdvanced')
  if (sceneEvents.length !== 1 || sceneEvents[0]?.payload?.request_fingerprint !== expectedFingerprint) {
    throw new DirectorTransitionError(
      'Ключ идемпотентности уже связан с другим переходом сцены',
      'IDEMPOTENCY_CONFLICT',
    )
  }
  for (const event of events.filter((candidate) => candidate?.event_type === 'MerchantCreated')) {
    if (event?.payload?.request_fingerprint !== expectedFingerprint) {
      throw new DirectorTransitionError(
        'Ключ идемпотентности уже связан с другим созданием торговца',
        'IDEMPOTENCY_CONFLICT',
      )
    }
  }
  return result
}
