import 'dotenv/config'
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  campaignHasMemberships,
  campaignMembershipFor,
  createAdmin,
  createCampaignInvite,
  createSession,
  deleteSession,
  getCampaignAiSettings,
  getRoom,
  hasAdmin,
  listCampaignMemberships,
  listRoomCodes,
  listUsers,
  onRoomSaved,
  redeemCampaignInvite,
  registerUser,
  saveCampaignAiSettings,
  saveRoom,
  storageDir,
  updateUserAccess,
  upsertCampaignMembership,
  userForToken,
  verifyUser,
} from './store.mjs'
import { NARRATOR_STYLES, normalizeNarratorStyle, runWithCampaignAiSettings } from './campaign-ai-context.mjs'
import { DiceService } from './dice-service.mjs'
import { MapStore } from './map-store.mjs'
import { FileEventStore } from './event-store.mjs'
import { DIRECTOR_COMMAND_CAPABILITY, GameOrchestrator } from './game-orchestrator.mjs'
import { FallbackLLMClient, RouterAIClient } from './llm-client.mjs'
import { DurableUsageLedger, MeteredLLMClient } from './usage-ledger.mjs'
import { Narrator, deterministicNarration } from './narrator.mjs'
import { CreativeDirector } from './creative-director.mjs'
import { combatNarration as tacticalNarration } from './combat-narration.mjs'
import { NpcControllerAgent } from './npc-controller.mjs'
import { NpcSocialController } from './npc-social-controller.mjs'
import { RollRegistry } from './roll-registry.mjs'
import { loadRulePack } from './rule-pack.mjs'
import { createRuleRetriever } from './rule-retriever.mjs'
import { GAME_STATE_PROJECTOR_VERSION, RulesEngine, actorNameResolver, applyGameEvent, attackForecast, normalizeCampaignState } from './rules-engine.mjs'
import { runNpcTurnScheduler } from './npc-turn-scheduler.mjs'
import { CombatTurnCoordinator, combatTurnClockForState } from './combat-turn-coordinator.mjs'
import { FileTraceStore, buildTurnExplanation } from './trace-store.mjs'
import { createSceneTransition } from './adventure-director.mjs'
import { SceneArchitectAgent } from './scene-architect.mjs'
import { proposeAgentInteraction, resolvePartyDecision } from './agent-router.mjs'
import { CampaignBootstrapper } from './campaign-bootstrap.mjs'
import { AutonomousCampaignOrchestrator } from './autonomous-orchestrator.mjs'
import { ActionAdjudicator } from './action-adjudicator.mjs'
import { DirectorAgent } from './director-agent.mjs'
import {
  MAX_CURRENCY_CP,
  findMerchant,
  merchantEconomyClockEventFromPlan,
  merchantIsAtLocation,
  merchantRestockCommandFromPlan,
  merchantViewFor,
  planMerchantEconomyClock,
} from './merchant-economy.mjs'
import { assembleEncounter } from './encounter-assembler.mjs'
import { assembleShop } from './shop-assembler.mjs'
import { campaignStateForViewer, turnExplanationForViewer, turnResultForViewer } from './viewer-projection.mjs'
import { compactStateForTransport } from './reveal-transport.mjs'
import { isPartySummon } from './combat-spells.mjs'
import { assertCampaignPlayable, lifecycleEventForAction } from './campaign-lifecycle.mjs'
import {
  assertDirectorTransitionResult,
  buildDirectorTransitionCommands,
  directorTransitionFingerprint,
  resolvedPartyDecisionReference,
} from './director-scene-transition.mjs'
import {
  partyDecisionActiveVoterIds,
  partyDecisionExpiryEvents,
  partyDecisionOpenedEvent,
  partyDecisionPresenceEvents,
  resolvePartyAbstain,
  resolvePartyRoll,
  resolvePartyVote,
} from './party-decision.mjs'
import { compareProjection } from './projection-integrity.mjs'
import { characterCreationCatalog, createCharacterSlot } from './character-lifecycle.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'dist')
// Кампания на одного игрока — поддерживаемый режим; пять мест покрывают
// полный стол MVP, но не превращаются в обязательный состав.
const MIN_PARTY_SLOTS = 1
const MAX_PARTY_SLOTS = 5
const port = Number(process.env.AGENT_PORT || 8787)
const host = process.env.AGENT_HOST || '0.0.0.0'
const apiKey = process.env.ROUTERAI_API_KEY || ''
const baseUrl = (process.env.ROUTERAI_BASE_URL || 'https://routerai.ru/api/v1').replace(/\/$/, '')
const model = process.env.DND_AI_MODEL || 'deepseek/deepseek-v4-flash'
const fallbackModels = [...new Set(String(process.env.DND_AI_FALLBACK_MODELS || 'z-ai/glm-5.2,deepseek/deepseek-v4-flash,google/gemini-2.5-flash-lite,openai/gpt-4.1-nano')
  .split(',').map((value) => value.trim()).filter((value) => value && value !== model))].slice(0, 5)
const allowedAiModels = Object.freeze([model, ...fallbackModels])
const maxTokens = Number(process.env.DND_AI_MAX_TOKENS || 1200)
const modelTimeoutMs = Number(process.env.DND_AI_MODEL_TIMEOUT_MS || 9_000)
const modelProbeTimeoutMs = Number(process.env.DND_AI_PROBE_TIMEOUT_MS || 15_000)
const modelFailureCooldownMs = Number(process.env.DND_AI_FAILURE_COOLDOWN_MS || 120_000)
const combatTurnTimeoutMs = Number(process.env.DND_COMBAT_TURN_TIMEOUT_MS || 120_000)
const dailyTokenLimit = Number(process.env.DND_AI_DAILY_TOKEN_LIMIT || 2_000_000)
const imageModel = process.env.DND_IMAGE_MODEL || 'openai/gpt-image-1'
const generatedDir = join(storageDir, 'generated', 'items')
mkdirSync(generatedDir, { recursive: true })
const campaignStreams = new Map()
const campaignTyping = new Map()
const campaignEconomyJobs = new Map()
const TYPING_TTL_MS = 4_000
let campaignStreamSequence = 0

const diceService = new DiceService()
const rollRegistry = new RollRegistry({
  diceService,
  storageFile: join(storageDir, 'engine', 'roll-registry.json'),
})
const usageLedger = new DurableUsageLedger({
  storageFile: join(storageDir, 'engine', 'llm-usage.json'),
  dailyTokenLimit,
})
const llmClient = new FallbackLLMClient({
  clients: [model, ...fallbackModels].map((modelId) => new MeteredLLMClient({
    client: new RouterAIClient({
      apiKey, baseUrl, model: modelId, maxTokens, timeoutMs: modelTimeoutMs,
      reasoning: ['z-ai/glm-5.2', 'deepseek/deepseek-v4-flash'].includes(modelId) ? { enabled: false } : null,
    }),
    ledger: usageLedger,
  })),
  probeTimeoutMs: modelProbeTimeoutMs,
  failureCooldownMs: modelFailureCooldownMs,
})
if (apiKey) void llmClient.probe().catch(() => {})
const sceneArchitect = new SceneArchitectAgent({ llmClient: apiKey ? llmClient : null })
const rulePack = await loadRulePack(process.env.DND_DEFAULT_RULESET_ID || 'srd_5_2_1')
const ruleRetriever = createRuleRetriever([rulePack])
const rulesEngine = new RulesEngine({ diceService })
// Карты живут отдельно от снимков и адресуются хешем содержимого: снимок
// пишется каждые 25 событий, и карта в нём стоила бы больше самого состояния.
const mapStore = new MapStore({ rootDir: join(storageDir, 'engine') })
const eventStore = new FileEventStore({
  rootDir: join(storageDir, 'engine'),
  reducer: applyGameEvent,
  normalizeState: normalizeCampaignState,
  snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
  mapStore,
})
const traceStore = new FileTraceStore({ rootDir: join(storageDir, 'turn-traces') })
const narrator = new Narrator({ llmClient: apiKey ? llmClient : null })
const creativeDirector = new CreativeDirector({ narrator })
const npcController = new NpcControllerAgent({ llmClient: apiKey ? llmClient : null })
const npcSocialController = new NpcSocialController({ llmClient: apiKey ? llmClient : null })
const campaignBootstrapper = new CampaignBootstrapper({ llmClient: apiKey ? llmClient : null })
const actionAdjudicator = new ActionAdjudicator({ llmClient: apiKey ? llmClient : null })
const autonomousCampaign = new AutonomousCampaignOrchestrator({ eventStore, rulesEngine, narrator, actionAdjudicator })
const directorAgent = new DirectorAgent({ llmClient: apiKey ? llmClient : null })
const combatTurnCoordinator = new CombatTurnCoordinator({
  eventStore,
  rulesEngine,
  npcController,
  timeoutMs: combatTurnTimeoutMs,
  onCommitted: ({ campaignId, state, events }) => {
    persistAuthoritativeProjection(campaignId, state, events)
  },
  onClockChanged: (campaignId) => {
    broadcastCampaignRoom(campaignId)
  },
  onError: (error, campaignId) => {
    console.error(`[Сказание] Не удалось автоматически продолжить бой ${campaignId}:`, error?.message || error)
  },
})

function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Access-Control-Allow-Origin': 'http://127.0.0.1:4173',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Cache-Control': 'no-store',
  })
  res.end(data)
}

function cookies(req) {
  const result = {}
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=')
    if (index < 1) continue
    try { result[decodeURIComponent(part.slice(0, index).trim())] = decodeURIComponent(part.slice(index + 1).trim()) } catch { /* Игнорируем повреждённую cookie. */ }
  }
  return result
}

function sessionCookie(req, token = '', expired = false) {
  const forwardedHttps = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
  const secure = process.env.COOKIE_SECURE === 'true' || forwardedHttps ? '; Secure' : ''
  return `skazanie_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expired ? 0 : 2592000}${secure}`
}

function requireUser(req, res) {
  const user = userForToken(cookies(req).skazanie_session)
  if (!user) json(res, 401, { error: 'Нужно войти в аккаунт' })
  return user
}

function requireAdmin(req, res) {
  const user = requireUser(req, res)
  if (user && user.role !== 'admin') { json(res, 403, { error: 'Требуются права администратора' }); return null }
  return user
}

function campaignMembership(user, campaignId) {
  return user?.campaignMemberships?.find((membership) => String(membership.campaignId) === String(campaignId || '').toUpperCase()) ?? null
}

function campaignHeroIds(user, campaignId) {
  if (user?.role === 'admin') return user?.heroIds ?? []
  if (!String(campaignId || '').trim()) return user?.heroIds ?? []
  const membership = campaignMembership(user, campaignId)
  if (membership) return membership.heroIds ?? []
  return campaignHasMemberships(campaignId) ? [] : user?.heroIds ?? []
}

function canUseHero(user, heroId, campaignId) {
  return user?.role === 'admin' || campaignHeroIds(user, campaignId).includes(String(heroId || ''))
}

const PUBLIC_DIE_SIDES = new Set([4, 6, 8, 10, 12, 20, 100])
const PLAYER_COMBAT_COMMANDS = new Set(['StartCombat', 'MoveActor', 'MakeAttack', 'MakeAreaAttack', 'ChangeWeapon', 'CastSpell', 'UseCombatAction', 'IdentifyEnemy', 'OperateDoor', 'OperateSceneObject', 'EndTurn', 'ResolveHeroDeath'])
const PLAYER_CHARACTER_COMMANDS = new Set(['SetCharacterChoices', 'SetSpellSelections'])
const PLAYER_CHARACTER_LIFECYCLE_COMMANDS = new Set(['LevelUp', 'ImportCharacter'])
const PLAYER_ITEM_COMMANDS = new Set(['EquipItem', 'UseItem', 'TransferItem', 'AttuneItem'])
const PLAYER_MERCHANT_COMMANDS = new Set(['BargainWithMerchant', 'AppraiseItem', 'BuyItem', 'SellItem', 'PurchaseMerchantService'])
const ADMIN_MERCHANT_LIFECYCLE_COMMANDS = new Set(['CreateMerchant', 'ConfigureMerchant', 'RestockMerchant', 'MoveMerchant', 'SetMerchantAvailability'])
const SERVER_WORLD_COMMANDS = new Set(['AdvanceScene'])
const SERVER_ENCOUNTER_COMMANDS = new Set(['CreateEncounter'])

function commandPolicyError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function commandType(command) {
  return String(command?.command_type ?? command?.commandType ?? command?.type ?? '')
}

function merchantCommandFingerprint(command) {
  const type = commandType(command)
  const semantic = {
    type,
    actor_id: String(command?.actor_id ?? ''),
    merchant_id: String(command?.merchant_id ?? ''),
    ...(type === 'BuyItem' ? { stock_id: String(command?.stock_id ?? ''), quantity: Number(command?.quantity) } : {}),
    ...(type === 'SellItem' ? { item_id: String(command?.item_id ?? ''), quantity: Number(command?.quantity) } : {}),
    ...(type === 'AppraiseItem' ? { item_id: String(command?.item_id ?? '') } : {}),
    ...(type === 'PurchaseMerchantService' ? { service_id: String(command?.service_id ?? '') } : {}),
  }
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex')
}

function itemCommandFingerprint(command) {
  const type = commandType(command)
  const semantic = {
    type,
    actor_id: String(command?.actor_id ?? ''),
    item_id: String(command?.item_id ?? ''),
    ...(type === 'EquipItem' ? { equipped: command?.equipped !== false } : {}),
    ...(type === 'AttuneItem' ? { attuned: command?.attuned !== false } : {}),
    ...(type === 'UseItem' ? { target_id: String(command?.target_id ?? command?.actor_id ?? '') } : {}),
    ...(type === 'TransferItem' ? {
      recipient_id: String(command?.recipient_id ?? ''),
      quantity: Number(command?.quantity ?? 1),
    } : {}),
  }
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex')
}

const ITEM_PRIMARY_EVENT_TYPES = new Set(['ItemEquipped', 'ItemUnequipped', 'ItemTransferred', 'ItemAttunementChanged', 'ItemUsed'])

async function assertItemIdempotency(campaignId, idempotencyKey, command) {
  const duplicate = await eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
  if (!duplicate) return
  const fingerprints = new Set((duplicate.events ?? [])
    .filter((event) => ITEM_PRIMARY_EVENT_TYPES.has(event.event_type))
    .map((event) => event.payload?.request_fingerprint)
    .filter(Boolean)
    .map(String))
  if (fingerprints.size !== 1 || !fingerprints.has(itemCommandFingerprint(command))) {
    throw commandPolicyError('Этот ключ идемпотентности уже использован для другого действия с предметом', 'IDEMPOTENCY_CONFLICT')
  }
}

function assertItemResultFingerprint(result, command) {
  const event = (result?.mechanics ?? []).find((candidate) => ITEM_PRIMARY_EVENT_TYPES.has(candidate?.event_type))
  if (!event || String(event.payload?.request_fingerprint ?? '') !== itemCommandFingerprint(command)) {
    throw commandPolicyError('Результат действия с предметом не соответствует исходному запросу', 'IDEMPOTENCY_CONFLICT')
  }
}

function characterBuildFingerprint(command) {
  const semantic = commandType(command) === 'SetCharacterChoices'
    ? {
        command_type: 'SetCharacterChoices',
        actor_id: String(command.actor_id ?? ''),
        subclass: String(command.subclass ?? ''),
        class_skill_proficiencies: [...new Set(command.class_skill_proficiencies ?? [])].map(String).sort(),
        selected_feature_ids: [...new Set(command.selected_feature_ids ?? [])].map(String).sort(),
      }
    : {
        command_type: 'SetSpellSelections',
        actor_id: String(command.actor_id ?? ''),
        known_spell_ids: [...new Set(command.known_spell_ids ?? [])].map(String).sort(),
        prepared_spell_ids: [...new Set(command.prepared_spell_ids ?? [])].map(String).sort(),
      }
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex')
}

function assertCharacterBuildResultFingerprint(result, commands) {
  const expected = new Set(commands.map(characterBuildFingerprint))
  const actual = new Set((result?.mechanics ?? [])
    .filter((event) => ['CharacterChoicesUpdated', 'SpellSelectionsUpdated'].includes(event.event_type))
    .map((event) => String(event.payload?.request_fingerprint ?? '')))
  if (actual.size !== expected.size || [...expected].some((fingerprint) => !actual.has(fingerprint))) {
    throw commandPolicyError('Этот ключ идемпотентности уже использован для другого изменения персонажа', 'IDEMPOTENCY_CONFLICT')
  }
}

function encounterCommandFingerprint(command) {
  const semantic = {
    type: 'CreateEncounter',
    difficulty: String(command?.difficulty ?? ''),
    theme: String(command?.theme ?? ''),
    seed: String(command?.seed ?? ''),
  }
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex')
}

async function assertEncounterIdempotency(campaignId, idempotencyKey, command) {
  const duplicate = await eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
  if (!duplicate) return
  const fingerprints = new Set((duplicate.events ?? [])
    .filter((event) => event.event_type === 'EncounterCreated')
    .map((event) => event.payload?.request_fingerprint).filter(Boolean).map(String))
  if (fingerprints.size !== 1 || !fingerprints.has(encounterCommandFingerprint(command))) {
    throw commandPolicyError('Этот ключ идемпотентности уже использован для другого столкновения', 'IDEMPOTENCY_CONFLICT')
  }
}

function assertEncounterResultFingerprint(result, command) {
  const event = (result?.mechanics ?? []).find((candidate) => candidate?.event_type === 'EncounterCreated')
  if (!event || String(event.payload?.request_fingerprint ?? '') !== encounterCommandFingerprint(command)) {
    throw commandPolicyError('Результат столкновения не соответствует исходному запросу', 'IDEMPOTENCY_CONFLICT')
  }
}

async function assertMerchantIdempotency(campaignId, idempotencyKey, command) {
  const duplicate = await eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
  if (!duplicate) return
  const fingerprints = new Set((duplicate.events ?? []).map((event) => event.payload?.request_fingerprint).filter(Boolean).map(String))
  if (fingerprints.size !== 1 || !fingerprints.has(merchantCommandFingerprint(command))) {
    throw commandPolicyError('Этот ключ идемпотентности уже использован для другой торговой операции', 'IDEMPOTENCY_CONFLICT')
  }
}

function lifecycleText(value, maximum = 500) {
  return String(value ?? '').trim().slice(0, maximum)
}

function lifecycleId(value, field = 'merchant_id') {
  const id = lifecycleText(value, 120)
  if (!id) throw commandPolicyError(`Не указано поле ${field}`, 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
  return id
}

function lifecycleInteger(value, field, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw commandPolicyError(`Поле ${field} должно быть целым числом от ${minimum} до ${maximum}`, 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
  }
  return result
}

function lifecyclePricing(input) {
  if (input == null) return undefined
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw commandPolicyError('Политика цен должна быть объектом', 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
  const result = {}
  const bounds = {
    buy_markup_bps: [1_000, 30_000], sell_rate_bps: [1_000, 30_000], bargain_dc: [5, 30],
    success_discount_bps: [0, 5_000], failure_markup_bps: [0, 5_000], agent_adjustment_bps: [-2_000, 2_000],
    agent_adjustment_limit_percent: [0, 20],
  }
  for (const [key, [minimum, maximum]] of Object.entries(bounds)) {
    if (input[key] != null) result[key] = lifecycleInteger(input[key], `pricing.${key}`, { minimum, maximum })
  }
  if (input.mode != null) {
    const mode = lifecycleText(input.mode, 60)
    if (!['catalog', 'catalog_with_agent_adjustment'].includes(mode)) throw commandPolicyError('Неизвестный режим политики цен', 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
    result.mode = mode
  }
  if (input.description != null) result.description = lifecycleText(input.description, 500)
  return result
}

function lifecycleStockItem(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw commandPolicyError(`Позиция склада ${index + 1} должна быть объектом`, 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
  const item = {
    stock_id: lifecycleId(input.stock_id ?? input.stockId, `items[${index}].stock_id`),
    quantity: lifecycleInteger(input.quantity, `items[${index}].quantity`, { minimum: 1, maximum: 999_999 }),
  }
  if (input.catalog_id != null || input.catalogId != null) item.catalog_id = lifecycleId(input.catalog_id ?? input.catalogId, `items[${index}].catalog_id`)
  if (input.name != null) item.name = lifecycleText(input.name, 120)
  if (input.type != null) item.type = lifecycleText(input.type, 40)
  if (input.weight != null) {
    const weight = Number(input.weight)
    if (!Number.isFinite(weight) || weight < 0 || weight > 1_000_000) throw commandPolicyError(`Некорректный вес items[${index}].weight`, 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
    item.weight = weight
  }
  if (input.rarity != null) item.rarity = lifecycleText(input.rarity, 60)
  if (input.description != null) item.description = lifecycleText(input.description, 1_000)
  if (input.properties != null) item.properties = lifecycleText(input.properties, 500)
  return item
}

function lifecycleMerchant(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw commandPolicyError('Поле merchant должно быть объектом', 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
  const merchant = {
    id: lifecycleId(input.id ?? input.merchant_id, 'merchant.id'),
    name: lifecycleText(input.name, 120),
  }
  if (!merchant.name) throw commandPolicyError('У торговца должно быть имя', 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
  for (const [key, maximum] of [['title', 180], ['description', 1_000], ['greeting', 500], ['voice', 500], ['location', 180]]) {
    if (input[key] != null) merchant[key] = lifecycleText(input[key], maximum)
  }
  if (input.location_id != null || input.locationId != null) merchant.location_id = lifecycleText(input.location_id ?? input.locationId, 120)
  if (!merchant.location) throw commandPolicyError('У торговца должна быть локация', 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
  if (input.available != null) {
    if (typeof input.available !== 'boolean') throw commandPolicyError('merchant.available должен быть boolean', 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
    merchant.available = input.available
  }
  const pricing = lifecyclePricing(input.pricing)
  if (pricing) merchant.pricing = pricing
  if (input.purse_cp != null) merchant.purse_cp = lifecycleInteger(input.purse_cp, 'merchant.purse_cp', { minimum: 0, maximum: MAX_CURRENCY_CP })
  if (input.stock != null) {
    if (!Array.isArray(input.stock) || input.stock.length > 500) throw commandPolicyError('merchant.stock должен содержать не более 500 позиций', 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
    merchant.stock = input.stock.map(lifecycleStockItem)
  }
  if (input.services != null) {
    if (!Array.isArray(input.services) || input.services.length > 100) throw commandPolicyError('merchant.services должен содержать не более 100 услуг', 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
    merchant.services = input.services.map((service, index) => {
      if (!service || typeof service !== 'object' || Array.isArray(service)) throw commandPolicyError(`Некорректная услуга ${index}`, 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
      return {
        service_id: lifecycleId(service.service_id ?? service.id, `merchant.services[${index}].service_id`),
        name: lifecycleText(service.name, 120),
        description: lifecycleText(service.description, 1_000),
        kind: lifecycleText(service.kind, 40),
        base_price_cp: lifecycleInteger(service.base_price_cp, `merchant.services[${index}].base_price_cp`, { minimum: 0, maximum: 100_000_000 }),
        duration_minutes: lifecycleInteger(service.duration_minutes ?? 0, `merchant.services[${index}].duration_minutes`, { minimum: 0, maximum: 10_080 }),
        available: service.available !== false,
        requires_presence: service.requires_presence !== false,
        tags: (Array.isArray(service.tags) ? service.tags : []).slice(0, 12).map((tag) => lifecycleText(tag, 40)).filter(Boolean),
      }
    })
  }
  if (input.restock_policy != null) {
    const policy = input.restock_policy
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw commandPolicyError('merchant.restock_policy должен быть объектом', 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
    merchant.restock_policy = {
      enabled: policy.enabled === true,
      interval_minutes: lifecycleInteger(policy.interval_minutes ?? 1_440, 'merchant.restock_policy.interval_minutes', { minimum: 60, maximum: 525_600 }),
      ...(policy.last_restock_world_minute == null ? {} : {
        last_restock_world_minute: lifecycleInteger(policy.last_restock_world_minute, 'merchant.restock_policy.last_restock_world_minute', { minimum: 0, maximum: 1_000_000_000 }),
      }),
      targets: (Array.isArray(policy.targets) ? policy.targets : []).slice(0, 500).map((target, index) => ({
        stock_id: lifecycleId(target?.stock_id, `merchant.restock_policy.targets[${index}].stock_id`),
        target_quantity: lifecycleInteger(target?.target_quantity, `merchant.restock_policy.targets[${index}].target_quantity`, { minimum: 1, maximum: 999_999 }),
      })),
    }
  }
  return merchant
}

function lifecycleConfiguration(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw commandPolicyError('Поле configuration должно быть объектом', 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
  const configuration = {}
  for (const [key, maximum] of [['name', 120], ['title', 180], ['description', 1_000], ['greeting', 500], ['voice', 500]]) {
    if (input[key] != null) configuration[key] = lifecycleText(input[key], maximum)
  }
  const pricing = lifecyclePricing(input.pricing)
  if (pricing) configuration.pricing = pricing
  if (input.purse_cp != null) configuration.purse_cp = lifecycleInteger(input.purse_cp, 'configuration.purse_cp', { minimum: 0, maximum: MAX_CURRENCY_CP })
  if (!Object.keys(configuration).length) throw commandPolicyError('configuration не содержит разрешённых изменений', 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
  return configuration
}

function merchantLifecycleFingerprint(command) {
  const semantic = { ...command }
  delete semantic.request_fingerprint
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex')
}

function sanitizeMerchantLifecycleCommand(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw commandPolicyError('Нужна одна lifecycle-команда торговца', 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
  const type = commandType(input)
  if (!ADMIN_MERCHANT_LIFECYCLE_COMMANDS.has(type)) throw commandPolicyError('Эта команда не относится к жизненному циклу торговца', 'MERCHANT_LIFECYCLE_COMMAND_FORBIDDEN')
  const command = {
    command_type: type,
    expected_state_version: lifecycleInteger(input.expected_state_version ?? input.expectedStateVersion, 'expected_state_version'),
  }
  if (type === 'CreateMerchant') command.merchant = lifecycleMerchant(input.merchant)
  if (type === 'ConfigureMerchant') {
    command.merchant_id = lifecycleId(input.merchant_id ?? input.merchantId)
    command.configuration = lifecycleConfiguration(input.configuration)
  }
  if (type === 'RestockMerchant') {
    command.merchant_id = lifecycleId(input.merchant_id ?? input.merchantId)
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 500) throw commandPolicyError('items должен содержать от 1 до 500 позиций', 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
    command.items = input.items.map(lifecycleStockItem)
  }
  if (type === 'MoveMerchant') {
    command.merchant_id = lifecycleId(input.merchant_id ?? input.merchantId)
    command.location = lifecycleText(input.location, 180)
    command.location_id = lifecycleText(input.location_id ?? input.locationId, 120)
    if (!command.location) throw commandPolicyError('Не указана новая локация торговца', 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
  }
  if (type === 'SetMerchantAvailability') {
    command.merchant_id = lifecycleId(input.merchant_id ?? input.merchantId)
    if (typeof input.available !== 'boolean') throw commandPolicyError('available должен быть boolean', 'INVALID_MERCHANT_LIFECYCLE_COMMAND')
    command.available = input.available
  }
  command.request_fingerprint = merchantLifecycleFingerprint(command)
  return command
}

async function assertMerchantLifecycleIdempotency(campaignId, idempotencyKey, command) {
  const duplicate = await eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
  if (!duplicate) return
  const fingerprints = new Set((duplicate.events ?? []).map((event) => event.payload?.request_fingerprint).filter(Boolean).map(String))
  if (fingerprints.size !== 1 || !fingerprints.has(command.request_fingerprint)) {
    throw commandPolicyError('Этот ключ идемпотентности уже использован для другой lifecycle-команды торговца', 'IDEMPOTENCY_CONFLICT')
  }
}

function assertMerchantLifecycleResultFingerprint(result, command) {
  const fingerprints = new Set((result?.mechanics ?? []).map((event) => event.payload?.request_fingerprint).filter(Boolean).map(String))
  if (fingerprints.size !== 1 || !fingerprints.has(command.request_fingerprint)) {
    throw commandPolicyError('Конкурирующая lifecycle-команда использовала тот же ключ идемпотентности', 'IDEMPOTENCY_CONFLICT')
  }
}

async function executeMerchantLifecycleCommand({ campaignId, room, admin, command: commandInput, idempotencyKey, message = 'Административное изменение торговца' }) {
  const command = sanitizeMerchantLifecycleCommand(commandInput)
  await assertMerchantLifecycleIdempotency(campaignId, idempotencyKey, command)
  const result = await gameOrchestrator.handle({
    state: room.state,
    campaignId,
    playerId: String(room.state.activePlayerId || ''),
    message,
    commands: [command],
    idempotencyKey,
    user: admin,
    allowedActorIds: campaignHeroIds(admin, campaignId),
  })
  assertMerchantLifecycleResultFingerprint(result, command)
  const projected = result.authoritative_state
    ? persistAuthoritativeProjection(campaignId, result.authoritative_state, result.mechanics)
    : null
  return {
    ...result,
    authoritative_state: projected?.state ?? result.authoritative_state,
    room_version: projected?.version ?? room.version,
  }
}

function assertMerchantResultFingerprint(result, command) {
  const fingerprints = new Set((result?.mechanics ?? []).map((event) => event.payload?.request_fingerprint).filter(Boolean).map(String))
  if (fingerprints.size !== 1 || !fingerprints.has(merchantCommandFingerprint(command))) {
    throw commandPolicyError('Конкурирующая операция использовала тот же ключ идемпотентности', 'IDEMPOTENCY_CONFLICT')
  }
}

function sanitizePlayerCombatCommand(user, state, input) {
  const type = commandType(input)
  if (!PLAYER_COMBAT_COMMANDS.has(type)) throw commandPolicyError('Игроку доступен только безопасный набор боевых команд', 'PLAYER_COMMAND_FORBIDDEN')
  const actor = String(input?.actor_id ?? input?.actorId ?? '')
  const combatActor = [...(state.players ?? []), ...(state.actors ?? [])].find((candidate) => String(candidate.id ?? candidate.actor_id) === actor)
  const controller = String(combatActor?.controllerId ?? combatActor?.controller_id ?? combatActor?.ownerId ?? combatActor?.owner_id ?? '')
  const controlsActor = canUseHero(user, actor, state.sessionCode) || (isPartySummon(combatActor) && canUseHero(user, controller, state.sessionCode))
  if (!actor || !controlsActor) throw commandPolicyError('Команда доступна только владельцу героя или его призванного существа', 'ACTOR_FORBIDDEN')
  if (!combatActor) throw commandPolicyError('Боевой актёр не найден в кампании', 'ACTOR_FORBIDDEN')
  const expected = input?.expected_state_version ?? input?.expectedStateVersion
  const base = {
    command_type: type,
    actor_id: actor,
    server_authoritative: true,
    ...(expected == null ? {} : { expected_state_version: expected }),
  }
  if (type === 'MoveActor') return { ...base, to: { x: input?.to?.x, y: input?.to?.y } }
  if (type === 'MakeAttack') {
    const target = String(input?.target_id ?? input?.targetId ?? '')
    const enemy = (state.enemies ?? []).find((candidate) => String(candidate.id) === target)
    if (!enemy || enemy.alive === false || Number(enemy.hp) <= 0) throw commandPolicyError('Игрок может атаковать только живого противника', 'INVALID_ATTACK_TARGET')
    return { ...base, target_id: target, ...(input?.item_id ? { item_id: String(input.item_id) } : {}), ...(input?.knock_out === true ? { knock_out: true } : {}) }
  }
  if (type === 'IdentifyEnemy') {
    // Из запроса берётся только цель: навык, характеристику и СЛ выбирает
    // серверная таблица, и подставить их клиент не может.
    return { ...base, target_id: String(input?.target_id ?? input?.targetId ?? '').slice(0, 120) }
  }
  if (type === 'OperateDoor') {
    // Из запроса берутся только дверь и намерение. Ни сложность замка, ни
    // состояние двери, ни исход броска клиент подсказать не может: их знает
    // карта сцены и серверная таблица.
    const intent = String(input?.intent ?? 'open')
    return {
      ...base,
      door_id: String(input?.door_id ?? input?.doorId ?? '').slice(0, 120),
      intent: ['open', 'close', 'force'].includes(intent) ? intent : 'open',
    }
  }
  if (type === 'OperateSceneObject') {
    const intent = String(input?.intent ?? 'inspect')
    return {
      ...base,
      prop_id: String(input?.prop_id ?? input?.propId ?? '').slice(0, 120),
      intent: ['inspect', 'open', 'take', 'use'].includes(intent) ? intent : 'inspect',
      // Силовой подход приходит только от серверного разбора свободного текста.
      // Кнопка не может подменить обычное взаимодействие готовым исходом взлома.
      approach: 'hand',
    }
  }
  if (type === 'MakeAreaAttack') return { ...base, item_id: String(input?.item_id || ''), to: { x: input?.to?.x, y: input?.to?.y } }
  if (type === 'ChangeWeapon') return { ...base, item_id: String(input?.item_id || '') }
  if (type === 'CastSpell') {
    const spellId = String(input?.spell_id ?? input?.spellId ?? '').slice(0, 120)
    if (!spellId) throw commandPolicyError('Не выбрано заклинание', 'SPELL_NOT_AVAILABLE')
    const target = String(input?.target_id ?? input?.targetId ?? '')
    return {
      ...base,
      spell_id: spellId,
      ...(target ? { target_id: target } : {}),
      ...(input?.to ? { to: { x: input.to.x, y: input.to.y } } : {}),
      ...(input?.knock_out === true ? { knock_out: true } : {}),
    }
  }
  if (type === 'UseCombatAction') {
    const actionId = String(input?.action_id ?? input?.actionId ?? '').slice(0, 120)
    if (!actionId) throw commandPolicyError('Не выбрано боевое действие', 'COMBAT_ACTION_NOT_AVAILABLE')
    const target = String(input?.target_id ?? input?.targetId ?? '').slice(0, 120)
    return {
      ...base,
      action_id: actionId,
      ...(target ? { target_id: target } : {}),
      ...(input?.item_id ? { item_id: String(input.item_id).slice(0, 120) } : {}),
    }
  }
  if (type === 'ResolveHeroDeath') {
    const resolution = String(input?.resolution ?? '').slice(0, 20)
    return {
      ...base,
      resolution,
      ...(resolution === 'replace' ? { replacement_name: String(input?.replacement_name ?? input?.replacementName ?? '').trim().slice(0, 120) } : {}),
    }
  }
  return base
}

function sanitizePlayerCharacterCommand(user, state, input) {
  const type = commandType(input)
  if (!PLAYER_CHARACTER_COMMANDS.has(type) && !PLAYER_CHARACTER_LIFECYCLE_COMMANDS.has(type)) {
    throw commandPolicyError('Команда не относится к развитию персонажа', 'PLAYER_COMMAND_FORBIDDEN')
  }
  const actor = String(input?.actor_id ?? input?.actorId ?? '')
  if (!actor || !canUseHero(user, actor, state.sessionCode)) {
    throw commandPolicyError('Изменять развитие можно только у своего героя', 'ACTOR_FORBIDDEN')
  }
  if (!(state.players ?? []).some((candidate) => String(candidate.id) === actor)) {
    throw commandPolicyError('Герой не найден в кампании', 'ACTOR_FORBIDDEN')
  }
  const expected = input?.expected_state_version ?? input?.expectedStateVersion
  const base = {
    command_type: type,
    actor_id: actor,
    ...(expected == null ? {} : { expected_state_version: expected }),
  }
  if (type === 'LevelUp') {
    return {
      ...base,
      ...(input?.expected_level == null && input?.expectedLevel == null
        ? {}
        : { expected_level: input.expected_level ?? input.expectedLevel }),
    }
  }
  if (type === 'ImportCharacter') {
    return { ...base, document: input?.document }
  }
  const command = type === 'SetCharacterChoices'
    ? {
        ...base,
        subclass: String(input?.subclass ?? '').trim().slice(0, 160),
        class_skill_proficiencies: Array.isArray(input?.class_skill_proficiencies ?? input?.classSkillProficiencies)
          ? (input.class_skill_proficiencies ?? input.classSkillProficiencies).map(String)
          : [],
        selected_feature_ids: Array.isArray(input?.selected_feature_ids ?? input?.selectedFeatureIds)
          ? (input.selected_feature_ids ?? input.selectedFeatureIds).map(String)
          : [],
      }
    : {
        ...base,
        known_spell_ids: Array.isArray(input?.known_spell_ids ?? input?.knownSpellIds)
          ? (input.known_spell_ids ?? input.knownSpellIds).map(String)
          : [],
        prepared_spell_ids: Array.isArray(input?.prepared_spell_ids ?? input?.preparedSpellIds)
          ? (input.prepared_spell_ids ?? input.preparedSpellIds).map(String)
          : [],
      }
  return { ...command, request_fingerprint: characterBuildFingerprint(command) }
}

function sanitizePlayerItemCommand(user, state, input) {
  const type = commandType(input)
  if (!PLAYER_ITEM_COMMANDS.has(type)) {
    throw commandPolicyError('Команда не относится к действиям с предметами', 'PLAYER_COMMAND_FORBIDDEN')
  }
  const actor = String(input?.actor_id ?? input?.actorId ?? '')
  if (!actor || !canUseHero(user, actor, state.sessionCode)) {
    throw commandPolicyError('Действовать с предметами можно только от имени своего героя', 'ACTOR_FORBIDDEN')
  }
  const owner = (state.players ?? []).find((candidate) => String(candidate.id) === actor)
  if (!owner) throw commandPolicyError('Герой не найден в кампании', 'ACTOR_FORBIDDEN')
  const itemId = String(input?.item_id ?? input?.itemId ?? '').trim().slice(0, 120)
  if (!itemId || !(owner.inventory ?? []).some((item) => String(item.id) === itemId)) {
    throw commandPolicyError('Предмет не найден у героя', 'ITEM_NOT_FOUND')
  }
  const expected = input?.expected_state_version ?? input?.expectedStateVersion
  const base = {
    command_type: type,
    actor_id: actor,
    item_id: itemId,
    ...(expected == null ? {} : { expected_state_version: expected }),
  }
  const withFingerprint = (command) => ({ ...command, request_fingerprint: itemCommandFingerprint(command) })
  if (type === 'EquipItem') return withFingerprint({ ...base, equipped: input?.equipped !== false })
  if (type === 'AttuneItem') return withFingerprint({ ...base, attuned: input?.attuned !== false })
  if (type === 'UseItem') {
    const targetId = String(input?.target_id ?? input?.targetId ?? actor).trim().slice(0, 120)
    return withFingerprint({ ...base, target_id: targetId || actor, server_authoritative: true })
  }
  const recipientId = String(input?.recipient_id ?? input?.recipientId ?? input?.target_id ?? input?.targetId ?? '').trim().slice(0, 120)
  return withFingerprint({
    ...base,
    recipient_id: recipientId,
    quantity: Number(input?.quantity ?? 1),
  })
}

function sanitizeMerchantCommand(user, state, input, routeMerchantId = null) {
  const type = commandType(input)
  if (!PLAYER_MERCHANT_COMMANDS.has(type)) throw commandPolicyError('Для торговца доступна только оценка, покупка, продажа или попытка договориться о цене', 'PLAYER_COMMAND_FORBIDDEN')
  const actor = String(input?.actor_id ?? input?.actorId ?? '')
  if (!actor || !canUseHero(user, actor, state.sessionCode)) throw commandPolicyError('Торговать можно только от имени своего героя', 'ACTOR_FORBIDDEN')
  if (!(state.players ?? []).some((candidate) => String(candidate.id) === actor)) throw commandPolicyError('Герой не найден в кампании', 'ACTOR_FORBIDDEN')
  const merchantId = String(routeMerchantId ?? input?.merchant_id ?? input?.merchantId ?? '').slice(0, 120)
  if (!merchantId) throw commandPolicyError('Не указан торговец', 'MERCHANT_NOT_FOUND')
  const expected = Number(input?.expected_state_version ?? input?.expectedStateVersion)
  if (!Number.isSafeInteger(expected) || expected < 0) throw commandPolicyError('Перед сделкой нужно получить актуальные котировки', 'EXPECTED_STATE_VERSION_REQUIRED')
  const base = {
    command_type: type,
    actor_id: actor,
    merchant_id: merchantId,
    expected_state_version: expected,
  }
  if (type === 'BuyItem') {
    const result = { ...base, stock_id: String(input?.stock_id ?? input?.stockId ?? '').slice(0, 120), quantity: input?.quantity }
    return { ...result, request_fingerprint: merchantCommandFingerprint(result) }
  }
  if (type === 'SellItem') {
    const result = { ...base, item_id: String(input?.item_id ?? input?.itemId ?? '').slice(0, 120), quantity: input?.quantity }
    return { ...result, request_fingerprint: merchantCommandFingerprint(result) }
  }
  if (type === 'AppraiseItem') {
    const result = { ...base, item_id: String(input?.item_id ?? input?.itemId ?? '').slice(0, 120) }
    return { ...result, request_fingerprint: merchantCommandFingerprint(result) }
  }
  if (type === 'PurchaseMerchantService') {
    const result = { ...base, service_id: String(input?.service_id ?? input?.serviceId ?? '').slice(0, 120) }
    return { ...result, request_fingerprint: merchantCommandFingerprint(result) }
  }
  return { ...base, request_fingerprint: merchantCommandFingerprint(base) }
}

// Боевой текст переехал в server/combat-narration.mjs: в index.mjs он был
// непроверяем — импорт этого файла поднимает HTTP-слушателя.

function combatMessageId(idempotencyKey) {
  return `combat-${createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 20)}`
}

function merchantMessageId(idempotencyKey) {
  return `merchant-${createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 20)}`
}

function narrationMessageId(idempotencyKey) {
  return `narration-${createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 20)}`
}

function playerMessageId(idempotencyKey) {
  return `player-${createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 20)}`
}

function journalRoll(roll) {
  // Бросок хранится вместе с репликой: иначе после перезагрузки в летописи
  // оставался только текст, а карточка «d20: 11 + 0 → провал» исчезала.
  if (!roll || typeof roll !== 'object') return null
  const total = Number(roll.total)
  // Без исхода карточка нарисовала бы «осложнение» на любом броске, поэтому
  // сохраняем только разрешённые проверки.
  if (!Number.isFinite(total) || typeof roll.success !== 'boolean') return null
  return {
    value: Number(roll.value) || 0,
    modifier: Number(roll.modifier) || 0,
    total,
    label: String(roll.label || 'Проверка').slice(0, 80),
    success: roll.success,
  }
}

function journalStakes(stakes) {
  if (!stakes || typeof stakes !== 'object') return null
  const difficulty = Number(stakes.difficulty)
  if (!Number.isFinite(difficulty)) return null
  return {
    ...(stakes.skill ? { skill: String(stakes.skill).slice(0, 60) } : {}),
    ...(stakes.ability ? { ability: String(stakes.ability).slice(0, 20) } : {}),
    difficulty,
    ...(stakes.difficulty_category ? { difficulty_category: String(stakes.difficulty_category).slice(0, 40) } : {}),
    ...(stakes.on_failure ? { on_failure: String(stakes.on_failure).slice(0, 300) } : {}),
  }
}

function journalEntry({ id, speaker, author, text, turnConsumed = false, roll = null, stakes = null }) {
  const storedRoll = journalRoll(roll)
  const storedStakes = journalStakes(stakes)
  return {
    id: String(id),
    speaker: speaker === 'system' ? 'system' : speaker === 'player' ? 'player' : 'narrator',
    author: String(author || (speaker === 'system' ? 'Система боя' : 'Рассказчик')).slice(0, 80),
    timestamp: new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
    text: String(text).slice(0, 2000),
    turnConsumed: Boolean(turnConsumed),
    ...(storedRoll ? { roll: storedRoll } : {}),
    ...(storedStakes ? { stakes: storedStakes } : {}),
  }
}

// Летопись — часть снимка комнаты, а не поток событий (Рассказчик событий не
// создаёт). Раньше реплика сохранялась только вместе с проекцией
// authoritative_state, поэтому отыгрыш без механики и реплики самих игроков
// пропадали при первой же синхронизации комнаты.
const JOURNAL_HISTORY_LIMIT = 400

function appendRoomJournal(campaignId, entries) {
  const wanted = entries.filter((entry) => entry?.id && String(entry.text ?? '').trim())
  if (!wanted.length) return null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const room = getRoom(campaignId)
    if (!room.state) return null
    const existing = new Set((room.state.messages ?? []).map((message) => String(message.id)))
    // Через `journalEntry`, а не сырыми: иначе в летописи оказывается реплика
    // без автора и времени — ровно это и было видно как «narrator/undefined».
    const fresh = wanted.filter((entry) => !existing.has(String(entry.id))).map(journalEntry)
    if (!fresh.length) return room
    const messages = [...(room.state.messages ?? []), ...fresh].slice(-JOURNAL_HISTORY_LIMIT)
    const saved = saveRoom(campaignId, { ...room.state, messages }, room.version)
    if (!saved.conflict) return saved.room
  }
  return null
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'")
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}

function originAllowed(req) {
  const origin = String(req.headers.origin || '')
  if (!origin) return true
  if (/^https?:\/\/(?:127\.0\.0\.1|localhost):4173$/i.test(origin)) return true
  try { return new URL(origin).host === String(req.headers.host || '') }
  catch { return false }
}

function canAccessRoom(user, room) {
  if (!user) return false
  if (user.role === 'admin') return true
  const campaignId = String(room?.state?.sessionCode || '')
  const membership = campaignMembership(user, campaignId)
  if (membership) return true
  if (campaignId && campaignHasMemberships(campaignId)) return false
  const playerIds = Array.isArray(room?.state?.players) ? room.state.players.map((player) => String(player.id)) : []
  const memberIds = Array.isArray(room?.state?.partyMemberIds) && room.state.partyMemberIds.length
    ? room.state.partyMemberIds.map(String)
    : playerIds
  return (user.heroIds ?? []).some((id) => memberIds.includes(String(id)))
}

function streamConnections(campaignId) {
  const normalized = String(campaignId || '').toUpperCase()
  if (!campaignStreams.has(normalized)) campaignStreams.set(normalized, new Map())
  return campaignStreams.get(normalized)
}

function connectedHeroIdsForCampaign(campaignId) {
  return new Set([...streamConnections(campaignId).values()].flatMap((connection) => connection.heroIds))
}

function partyVoterIdForAccount(campaignId, userId) {
  return `account:${createHash('sha256').update(String(campaignId).toUpperCase()).update('\0').update(String(userId)).digest('hex').slice(0, 24)}`
}

function partyVoterSnapshot(campaignId, state, eligibleHeroIds) {
  const policy = state?.partyDecisionPolicy ?? {}
  const memberships = listCampaignMemberships(campaignId)
  const ownerByHeroId = new Map()
  for (const membership of memberships) {
    for (const heroId of membership.heroIds ?? []) {
      if (!ownerByHeroId.has(String(heroId))) ownerByHeroId.set(String(heroId), String(membership.userId))
    }
  }
  const voterByHeroId = Object.fromEntries([...new Set(eligibleHeroIds.map(String))].map((heroId) => [
    heroId,
    policy.voterScope === 'hero'
      ? `hero:${heroId}`
      : ownerByHeroId.has(heroId)
        ? partyVoterIdForAccount(campaignId, ownerByHeroId.get(heroId))
        : `hero:${heroId}`,
  ]))
  return {
    voterByHeroId,
    eligibleVoterIds: [...new Set(Object.values(voterByHeroId))],
  }
}

/**
 * Прогноз удара для интерфейса. Считается на сервере по доверенному состоянию:
 * игрок видит шанс попадания и его причины до клика, но не получает скрытые
 * параметры врага — КД раскрывается только там, где уже раскрыто здоровье.
 */
function withCombatForecast(projected, trustedState, viewerActorId) {
  if (!projected || !trustedState?.mechanics?.combat?.active) return projected
  const attackerId = String(trustedState.mechanics.combat.initiative?.[trustedState.mechanics.combat.active_index ?? 0]?.actor_id ?? '')
  if (!attackerId) return projected
  // Прогноз нужен только тому, кто сейчас ходит: чужой ход игрок не планирует.
  const controls = String(viewerActorId ?? '') === attackerId
    || (projected.players ?? []).some((player) => String(player.id) === attackerId)
  if (!controls) return projected
  const attacker = (trustedState.players ?? []).concat(trustedState.actors ?? []).find((actor) => String(actor.id) === attackerId)
  if (!attacker) return projected
  const options = [
    ...(attacker.inventory ?? []).filter((item) => item?.equipped && item?.combat?.kind).map((item) => ({ itemId: String(item.id), label: String(item.name ?? 'Оружие') })),
    { itemId: null, label: 'Базовая атака' },
  ].slice(0, 6)
  const forecast = {}
  for (const enemy of trustedState.enemies ?? []) {
    if (!enemy || enemy.alive === false || Number(enemy.hp) <= 0) continue
    const enemyId = String(enemy.id)
    const visible = (projected.enemies ?? []).find((candidate) => String(candidate.id) === enemyId)
    if (!visible) continue
    const exact = visible.healthKnown === 'exact'
    const entries = []
    for (const option of options) {
      const shot = attackForecast(trustedState, attackerId, enemyId, { itemId: option.itemId })
      if (!shot) continue
      entries.push({
        ...shot,
        label: option.label,
        item_id: option.itemId,
        ...(exact ? {} : { armor_class: null, cover_bonus: shot.cover_bonus }),
      })
    }
    if (entries.length) forecast[enemyId] = entries
  }
  return Object.keys(forecast).length ? { ...projected, combatForecast: { actor_id: attackerId, targets: forecast } } : projected
}

function viewerStateFor(state, user, actorId) {
  return withCombatForecast(campaignStateForViewer(state, user, actorId), state, actorId)
}

function stateWithLivePresence(state, campaignId) {
  if (!state || typeof state !== 'object') return state
  const connections = streamConnections(campaignId)
  const onlineHeroIds = connectedHeroIdsForCampaign(campaignId)
  const typingActorIds = typingActorIdsForCampaign(campaignId)
  const turnClock = combatTurnClockForState(state, combatTurnCoordinator.clockFor(campaignId))
  if ([...connections.values()].some((connection) => connection.controlsParty)) {
    for (const player of state.players ?? []) onlineHeroIds.add(String(player.id))
  }
  return {
    ...state,
    players: (state.players ?? []).map((player) => ({
      ...player,
      online: onlineHeroIds.has(String(player.id)),
    })),
    presence: {
      transport: 'sse',
      connected_users: new Set([...connections.values()].map((connection) => connection.userId)).size,
      connected_heroes: onlineHeroIds.size,
      online_hero_ids: [...onlineHeroIds].sort(),
      typing_actor_ids: typingActorIds,
    },
    turn_clock: turnClock,
  }
}

function typingActorIdsForCampaign(campaignId) {
  const normalized = String(campaignId || '').toUpperCase()
  const typing = campaignTyping.get(normalized) ?? new Map()
  const now = Date.now()
  for (const [userId, entry] of typing) {
    if (Number(entry.expiresAt) <= now) typing.delete(userId)
  }
  if (typing.size) campaignTyping.set(normalized, typing)
  else campaignTyping.delete(normalized)
  return [...new Set([...typing.values()].map((entry) => String(entry.actorId)))].sort()
}

function writeCampaignStream(connection, event, payload) {
  if (connection.closed || connection.res.destroyed) return false
  connection.res.write(`id: ${++campaignStreamSequence}\n`)
  connection.res.write(`event: ${event}\n`)
  connection.res.write(`data: ${JSON.stringify(payload)}\n\n`)
  return true
}

function broadcastCampaignTyping(campaignId) {
  const normalized = String(campaignId || '').toUpperCase()
  const typingActorIds = typingActorIdsForCampaign(normalized)
  for (const connection of streamConnections(normalized).values()) {
    writeCampaignStream(connection, 'presence', { typing_actor_ids: typingActorIds })
  }
}

function broadcastCampaignRoom(campaignId, suppliedRoom = null) {
  const normalized = String(campaignId || '').toUpperCase()
  const connections = streamConnections(normalized)
  if (!connections.size) return
  const room = suppliedRoom ?? getRoom(normalized)
  if (!room.state) return
  const state = stateWithLivePresence(normalizeCampaignState(room.state), normalized)
  for (const connection of connections.values()) {
    // Что закэшировано у клиента, соединение знает точно: оно само это и
    // отправило. Пока соединение живо, порядок сообщений сохраняется, а на
    // переподключении объект соединения новый и карта уходит целиком.
    const projected = viewerStateFor(state, connection.user, connection.actorId)
    const compacted = compactStateForTransport(projected, connection.mapHash)
    const written = writeCampaignStream(connection, 'room', {
      version: room.version,
      updatedAt: room.updatedAt,
      state: compacted.state,
    })
    if (written) connection.mapHash = compacted.hash
  }
}

function nudgeMerchantEconomyClock(campaignId) {
  const normalized = String(campaignId || '').toUpperCase()
  if (!normalized) return
  const entry = campaignEconomyJobs.get(normalized) ?? { running: false, pending: false }
  entry.pending = true
  campaignEconomyJobs.set(normalized, entry)
  if (entry.running) return
  entry.running = true
  queueMicrotask(() => {
    void (async () => {
      while (entry.pending) {
        entry.pending = false
        const result = await runMerchantEconomyClock(normalized)
        if (result.events.length) persistAuthoritativeProjection(normalized, result.state, result.events)
      }
    })()
      .catch((error) => {
        console.error(`[Сказание] Не удалось продвинуть экономические часы ${normalized}:`, error?.message || error)
      })
      .finally(() => {
        entry.running = false
        if (entry.pending) nudgeMerchantEconomyClock(normalized)
        else campaignEconomyJobs.delete(normalized)
      })
  })
}

onRoomSaved((campaignId, room) => {
  queueMicrotask(() => {
    broadcastCampaignRoom(campaignId, room)
    combatTurnCoordinator.nudge(campaignId)
    nudgeMerchantEconomyClock(campaignId)
  })
})

const costlyRequests = new Map()
function exceedsRate(key, limit, windowMs = 10 * 60 * 1000) {
  const now = Date.now()
  const recent = (costlyRequests.get(key) || []).filter((time) => now - time < windowMs)
  recent.push(now)
  costlyRequests.set(key, recent)
  return recent.length > limit
}

const loginAttempts = new Map()
function rateLimited(req) {
  const key = req.socket.remoteAddress || 'unknown'
  const now = Date.now()
  const recent = (loginAttempts.get(key) || []).filter((time) => now - time < 10 * 60 * 1000)
  recent.push(now)
  loginAttempts.set(key, recent)
  return recent.length > 20
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 1_000_000) throw new Error('Слишком большой запрос')
  }
  return JSON.parse(raw || '{}')
}

function executeTool(name, args, effects, state = {}) {
  if (name === 'request_party_decision') {
    if (effects.interaction) return { error: 'Одновременно разрешено только одно активное решение группы' }
    const options = (Array.isArray(args.options) ? args.options : []).map((option, index) => ({
      id: `option-${index + 1}`,
      label: String(option || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    })).filter((option) => option.label).slice(0, 4)
    if (options.length < 2) return { error: 'Для решения нужны хотя бы два варианта' }
    effects.interaction = {
      id: randomUUID(),
      type: ['vote', 'roll', 'choice'].includes(args.type) ? args.type : 'vote',
      title: String(args.title || 'Решение отряда').replace(/\s+/g, ' ').trim().slice(0, 100),
      description: String(args.description || '').replace(/\s+/g, ' ').trim().slice(0, 360),
      options,
      votes: {},
      status: 'open',
      difficulty: args.type === 'roll' ? Math.max(5, Math.min(25, Number(args.difficulty) || 12)) : undefined,
      resolutionPrompt: String(args.resolutionPrompt || '').replace(/\s+/g, ' ').trim().slice(0, 360),
      createdAt: Date.now(),
      policy: state.partyDecisionPolicy,
    }
    return { opened: true, interaction: effects.interaction }
  }
  if (name === 'advance_scene') {
    if (effects.scene) return { error: 'За один ход разрешён только один переход между сценами' }
    effects.scene = createSceneTransition(args, state)
    return { advanced: true, chapter: effects.scene.adventure.chapter, scene: effects.scene.scene, transition: effects.scene.transition, arrival: effects.scene.arrival }
  }
  return { error: 'Инструмент не разрешён' }
}

async function generateItemImage(prompt, aspectRatio = '1:1') {
  const response = await fetch(`${baseUrl}/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: imageModel,
      prompt: `Fantasy tabletop RPG inventory illustration. ${String(prompt).slice(0, 1600)}. No text, letters, logo, watermark, UI or characters.`,
      n: 1, aspect_ratio: aspectRatio, resolution: '1K', quality: 'low', output_format: 'webp',
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`Генератор изображений ответил ${response.status}`)
  const result = await response.json()
  const encoded = result.data?.[0]?.b64_json
  if (!encoded) throw new Error('Генератор не вернул изображение')
  const filename = `${randomUUID()}.webp`
  writeFileSync(join(generatedDir, filename), Buffer.from(encoded, 'base64'))
  return { url: `/generated/items/${filename}`, model: imageModel, cost: result.usage?.cost }
}

const gameOrchestrator = new GameOrchestrator({
  ruleRetriever,
  rulesEngine,
  eventStore,
  traceStore,
  narrator,
  npcSocialController,
  // Свободные действия судит тот же арбитр, что и автономный цикл: иначе у
  // одного вопроса появилось бы два разных ответа.
  unknownActionHandler: autonomousCampaign,
})

async function latestCampaignState(campaignId, fallbackState) {
  try {
    const loaded = await eventStore.load(campaignId)
    return normalizeCampaignState(loaded.state)
  } catch {
    return normalizeCampaignState(fallbackState)
  }
}

const PARTY_DECISION_MARKER = /^\s*\[РЕШЕНИЕ ГРУППЫ\]/iu
const directorDecisionLocks = new Map()

function isPartyDecisionAction(action) {
  return PARTY_DECISION_MARKER.test(String(action ?? '').normalize('NFKC'))
}

function directorDecisionLockKey(campaignId, reference) {
  return createHash('sha256')
    .update(String(campaignId))
    .update('\0')
    .update(reference.interaction_id)
    .update('\0')
    .update(reference.resolved_option_id)
    .digest('hex')
}

async function serializeDirectorDecision(key, operation) {
  const previous = directorDecisionLocks.get(key) ?? Promise.resolve()
  let release
  const current = new Promise((resolve) => { release = resolve })
  directorDecisionLocks.set(key, current)
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
    if (directorDecisionLocks.get(key) === current) directorDecisionLocks.delete(key)
  }
}

async function committedSceneForPartyDecision(campaignId, reference) {
  const events = await eventStore.getEvents(campaignId)
  return events.findLast((event) => event?.event_type === 'SceneAdvanced'
    && event.payload?.party_decision?.interaction_id === reference.interaction_id
    && event.payload?.party_decision?.resolved_option_id === reference.resolved_option_id) ?? null
}

async function committedSceneForFingerprint(campaignId, fingerprint) {
  const events = await eventStore.getEvents(campaignId)
  return events.findLast((event) => event?.event_type === 'SceneAdvanced'
    && event.payload?.request_fingerprint === fingerprint) ?? null
}

async function executeDirectorSceneTransition(input) {
  const { campaignId, room, idempotencyKey, resolution } = input
  const partyDecision = resolvedPartyDecisionReference(resolution?.partyDecision ?? room?.state)
  const lockKey = directorDecisionLockKey(campaignId, partyDecision)
  return serializeDirectorDecision(lockKey, async () => {
    const consumed = await committedSceneForPartyDecision(campaignId, partyDecision)
    if (consumed && String(consumed.idempotency_key) !== String(idempotencyKey)) {
      throw commandPolicyError('Это решение группы уже было исполнено переходом сцены', 'PARTY_DECISION_ALREADY_CONSUMED')
    }
    return executeDirectorSceneTransitionOnce({ ...input, partyDecision })
  })
}

async function executeDirectorSceneTransitionOnce({ campaignId, room, user, action, idempotencyKey, resolution, partyDecision }) {
  const authoritative = await latestCampaignState(campaignId, room.state)
  const planningState = normalizeCampaignState(authoritative)
  const canonicalDecisionAction = `[РЕШЕНИЕ ГРУППЫ] ${String(resolution.decision ?? '').replace(/\s+/gu, ' ').trim().slice(0, 500)}`
  const planned = await sceneArchitect.plan({
    action: canonicalDecisionAction,
    state: planningState,
    decision: resolution.decision,
    destinationHint: resolution.destinationHint,
  })
  const directorPlan = buildDirectorTransitionCommands({
    campaignId,
    action,
    state: planningState,
    sceneArgs: planned.sceneArgs,
    shopIntent: planned.shopIntent,
    partyDecision,
  })
  const result = await gameOrchestrator.handle({
    state: planningState,
    campaignId,
    playerId: String(planningState.activePlayerId || ''),
    message: action,
    commands: directorPlan.commands,
    commandCapability: DIRECTOR_COMMAND_CAPABILITY,
    idempotencyKey,
    user,
    allowedActorIds: campaignHeroIds(user, campaignId),
  })
  assertDirectorTransitionResult(result, directorPlan.fingerprint)
  const sceneEvent = (result.mechanics ?? []).find((event) => event.event_type === 'SceneAdvanced')
  const committedTransition = sceneEvent?.payload ? {
    scene: sceneEvent.payload.scene,
    adventure: sceneEvent.payload.adventure,
    worldMap: sceneEvent.payload.worldMap,
    transition: sceneEvent.payload.transition,
    arrival: sceneEvent.payload.arrival,
    entrance: sceneEvent.payload.entrance,
  } : directorPlan.transition
  const merchantEvent = (result.mechanics ?? []).find((event) => event.event_type === 'MerchantCreated')

  return {
    ...result,
    effects: { ...result.effects, scene: committedTransition },
    turn_consumed: true,
    action_kind: 'world',
    director_transition: {
      fingerprint: directorPlan.fingerprint,
      shop_action: directorPlan.shopIntent.action,
      shop_outcome: merchantEvent ? 'created' : directorPlan.existingMerchantId ? 'reused' : 'not-requested',
      merchant_id: merchantEvent?.payload?.merchant_id ?? directorPlan.existingMerchantId,
    },
    agent_trace: [
      { agent: 'AgentDirector', output: resolution },
      planned.trace,
      { agent: 'WorldEngine', output: { event: 'SceneAdvanced', cells: committedTransition.scene?.cells?.length ?? 0, entrance: committedTransition.entrance } },
      { agent: 'ShopAssembler', output: { action: directorPlan.shopIntent.action, merchant_id: merchantEvent?.payload?.merchant_id ?? directorPlan.existingMerchantId } },
    ],
  }
}

async function replayDirectorSceneTransition({ campaignId, room, user, action, idempotencyKey, duplicate, resolution }) {
  const result = await gameOrchestrator.handle({
    state: room.state,
    campaignId,
    playerId: String(room.state.activePlayerId || ''),
    message: action,
    // An empty structured plan makes the orchestrator read the committed batch
    // directly. No SceneArchitect/model call is needed for an idempotent replay.
    commands: [],
    commandCapability: DIRECTOR_COMMAND_CAPABILITY,
    idempotencyKey,
    user,
    allowedActorIds: campaignHeroIds(user, campaignId),
  })
  const sceneEvent = (result.mechanics ?? []).find((event) => event.event_type === 'SceneAdvanced')
  if (!sceneEvent?.payload) throw commandPolicyError('Повтор перехода не содержит SceneAdvanced', 'IDEMPOTENCY_CONFLICT')
  const committedTransition = {
    scene: sceneEvent.payload.scene,
    adventure: sceneEvent.payload.adventure,
    worldMap: sceneEvent.payload.worldMap,
    transition: sceneEvent.payload.transition,
    arrival: sceneEvent.payload.arrival,
    entrance: sceneEvent.payload.entrance,
  }
  const commerce = sceneEvent.payload.scene_commerce ?? {}
  const merchantEvent = (result.mechanics ?? []).find((event) => event.event_type === 'MerchantCreated')
  return {
    ...result,
    effects: { ...result.effects, scene: committedTransition },
    turn_consumed: true,
    action_kind: 'world',
    model: 'event-replay',
    director_transition: {
      fingerprint: sceneEvent.payload.request_fingerprint,
      shop_action: commerce.action ?? 'none',
      shop_outcome: commerce.outcome ?? (merchantEvent ? 'created' : 'not-requested'),
      merchant_id: merchantEvent?.payload?.merchant_id ?? commerce.merchant_id ?? null,
      replayed: true,
    },
    agent_trace: [
      { agent: 'AgentDirector', output: resolution },
      { agent: 'EventReplay', output: { idempotency_key: duplicate.idempotency_key, state_version: duplicate.state_version } },
      { agent: 'WorldEngine', output: { event: 'SceneAdvanced', cells: committedTransition.scene?.cells?.length ?? 0, entrance: committedTransition.entrance } },
      { agent: 'ShopAssembler', output: { action: commerce.action ?? 'none', merchant_id: merchantEvent?.payload?.merchant_id ?? commerce.merchant_id ?? null } },
    ],
  }
}

function persistAuthoritativeProjection(campaignId, engineState, events = [], journalMessage = null, { forceProjectorRefresh = false } = {}) {
  const proposedStateVersion = Number(engineState?.state_version ?? -1)
  if (!Number.isSafeInteger(proposedStateVersion)) return null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const room = getRoom(campaignId)
    if (!room.state) return null
    const currentStateVersion = Number(room.state.state_version ?? 0)
    if (proposedStateVersion < currentStateVersion) return room
    if (!forceProjectorRefresh && proposedStateVersion === currentStateVersion) {
      void eventStore.acknowledgeProjection(campaignId, proposedStateVersion).catch(() => {})
      return room
    }
    const eventTypes = new Set(events.map((event) => event.event_type))
    const merchantInventoryChanged = eventTypes.has('MerchantPurchaseCompleted')
      || eventTypes.has('MerchantSaleCompleted')
      || eventTypes.has('MerchantServicePurchased')
    const characterImported = eventTypes.has('CharacterImported')
    const refreshInventory = forceProjectorRefresh || merchantInventoryChanged || [
      'ItemGranted',
      'ItemEquipped',
      'ItemUnequipped',
      'ItemUsed',
      'ItemConsumed',
      'ItemChargesSpent',
      'ItemTransferred',
      'ItemAttunementChanged',
    ].some((type) => eventTypes.has(type)) || characterImported
    const characterBuildChanged = eventTypes.has('CharacterChoicesUpdated') || eventTypes.has('SpellSelectionsUpdated')
      || eventTypes.has('CharacterLeveledUp') || eventTypes.has('CharacterImported')
    const enginePlayers = new Map((engineState.players ?? []).map((player) => [String(player.id), player]))
    const players = (room.state.players ?? []).map((player) => {
      const authoritative = enginePlayers.get(String(player.id))
      if (!authoritative) return player
      return {
        ...player,
        hp: authoritative.hp,
        ...(forceProjectorRefresh || eventTypes.has('ExperienceAwarded') ? { experience: authoritative.experience } : {}),
        ...(refreshInventory ? { inventory: authoritative.inventory } : {}),
        ...(forceProjectorRefresh || merchantInventoryChanged || characterImported ? { currency: authoritative.currency } : {}),
        ...(forceProjectorRefresh || characterBuildChanged ? {
          level: authoritative.level,
          experience: authoritative.experience,
          maxHp: authoritative.maxHp,
          armor: authoritative.armor,
          speed: authoritative.speed,
          proficiency: authoritative.proficiency,
          abilities: authoritative.abilities,
          characterClass: authoritative.characterClass,
          hitPointIncreases: authoritative.hitPointIncreases,
          characterSheet: authoritative.characterSheet,
          subclass: authoritative.subclass,
          classSkillProficiencies: authoritative.classSkillProficiencies,
          selectedFeatureIds: authoritative.selectedFeatureIds,
          knownSpellIds: authoritative.knownSpellIds,
          preparedSpellIds: authoritative.preparedSpellIds,
          ...(characterImported ? {
            character: authoritative.character,
            name: authoritative.name,
            role: authoritative.role,
            species: authoritative.species,
            background: authoritative.background,
            alignment: authoritative.alignment,
            traits: authoritative.traits,
            ideals: authoritative.ideals,
            bonds: authoritative.bonds,
            flaws: authoritative.flaws,
            backstory: authoritative.backstory,
            notes: authoritative.notes,
            baseSpeed: authoritative.baseSpeed,
            abilityGeneration: authoritative.abilityGeneration,
            characterSetupRequired: authoritative.characterSetupRequired,
            initials: authoritative.initials,
          } : {}),
        } : {}),
        ...(forceProjectorRefresh || eventTypes.has('ActorMoved') || eventTypes.has('SceneAdvanced') ? { x: authoritative.x, y: authoritative.y } : {}),
      }
    })
    const sceneChanged = forceProjectorRefresh || ['SceneAdvanced', 'AreaRevealed', 'ObjectiveUpdated', 'EntitySpawned'].some((type) => eventTypes.has(type))
    const partyDecisionChanged = ['PartyDecisionOpened', 'PartyVoteCast', 'PartyDecisionAbstained', 'PartyDecisionResolved', 'PartyDecisionExpired', 'PartyDecisionConsumed'].some((type) => eventTypes.has(type))
    const messages = [...(room.state.messages ?? [])]
    for (const candidate of [journalMessage].flat()) {
      if (!candidate?.id || !String(candidate.text ?? '').trim()) continue
      if (messages.some((message) => String(message.id) === String(candidate.id))) continue
      messages.push(journalEntry(candidate))
    }
    if (messages.length > JOURNAL_HISTORY_LIMIT) messages.splice(0, messages.length - JOURNAL_HISTORY_LIMIT)
    let next = normalizeCampaignState({
      ...room.state,
      messages,
      players,
      merchants: engineState.merchants ?? room.state.merchants,
      worldMemory: engineState.worldMemory ?? room.state.worldMemory,
      social: engineState.social ?? room.state.social,
      enemies: engineState.enemies,
      actors: engineState.actors ?? room.state.actors,
      mechanics: engineState.mechanics,
      state_version: engineState.state_version,
      state_projector_version: GAME_STATE_PROJECTOR_VERSION,
      ruleset_id: engineState.ruleset_id,
      ruleset_version: engineState.ruleset_version,
      enabled_rule_packs: engineState.enabled_rule_packs,
      enabled_house_rules: engineState.enabled_house_rules,
      ruleset_locked_at: engineState.ruleset_locked_at,
      ...(sceneChanged || engineState.scene ? { scene: engineState.scene, entities: engineState.entities } : {}),
      ...(sceneChanged ? {
        adventure: engineState.adventure,
        worldMap: engineState.worldMap,
      } : {}),
      ...(sceneChanged || partyDecisionChanged ? { agentInteraction: engineState.agentInteraction ?? null } : {}),
      activePlayerId: engineState.activePlayerId ?? room.state.activePlayerId,
      tacticalTurn: engineState.tacticalTurn ?? room.state.tacticalTurn,
      battleLog: engineState.battleLog ?? room.state.battleLog,
      economyLog: engineState.economyLog ?? room.state.economyLog,
      mapFeedback: engineState.mapFeedback ?? room.state.mapFeedback,
      ...((forceProjectorRefresh || eventTypes.has('PublicDieRolled')) ? { lastDiceRoll: engineState.lastDiceRoll ?? null } : {}),
      ...(eventTypes.has('RulingRecorded') ? { rulings: engineState.rulings } : {}),
    })
    if (forceProjectorRefresh) {
      const onlineById = new Map((room.state.players ?? []).map((player) => [String(player.id), Boolean(player.online)]))
      next = normalizeCampaignState({
        ...room.state,
        ...engineState,
        agentInteraction: engineState.agentInteraction ?? null,
        players: (engineState.players ?? []).map((player) => ({
          ...player,
          ...(onlineById.has(String(player.id)) ? { online: onlineById.get(String(player.id)) } : {}),
        })),
        messages,
        state_projector_version: GAME_STATE_PROJECTOR_VERSION,
        engine_mode: 'enforce',
      })
    }
    const saved = saveRoom(campaignId, next, room.version)
    if (!saved.conflict) {
      if (compareProjection(engineState, saved.room.state).matched) {
        void eventStore.acknowledgeProjection(campaignId, proposedStateVersion, {
          projectionHash: compareProjection(engineState, saved.room.state).projected_hash,
        }).catch(() => {})
      }
      return saved.room
    }
  }
  const reconciled = getRoom(campaignId)
  if (Number(reconciled.state?.state_version ?? -1) >= proposedStateVersion
    && compareProjection(engineState, reconciled.state).matched) {
    void eventStore.acknowledgeProjection(campaignId, proposedStateVersion, {
      projectionHash: compareProjection(engineState, reconciled.state).projected_hash,
    }).catch(() => {})
    return reconciled
  }
  return null
}

async function reconcileCampaignProjection(campaignId) {
  try {
    await expirePartyDecisionIfNeeded(campaignId)
    const authoritative = await eventStore.load(campaignId)
    const pending = await eventStore.pendingProjection(campaignId)
    const room = getRoom(campaignId)
    const projectedVersion = Number(room.state?.state_version ?? -1)
    const comparison = compareProjection(authoritative.state, room.state)
    if (projectedVersion >= authoritative.state_version && comparison.matched) {
      if (pending) await eventStore.acknowledgeProjection(campaignId, authoritative.state_version, {
        projectionHash: comparison.projected_hash,
      })
      return room
    }
    return persistAuthoritativeProjection(
      campaignId,
      authoritative.state,
      pending?.events ?? [],
      null,
      { forceProjectorRefresh: true },
    )
  } catch (error) {
    if (error?.code === 'CAMPAIGN_NOT_FOUND') return getRoom(campaignId)
    throw error
  }
}

async function reconcileAllCampaignProjections() {
  for (const campaignId of listRoomCodes()) {
    try {
      await reconcileCampaignProjection(campaignId)
    } catch (error) {
      console.error(`[Сказание] Не удалось восстановить projection ${campaignId}:`, error)
    }
  }
}

async function persistInteractionProjection(campaignId, interaction) {
  if (!interaction || typeof interaction !== 'object' || Array.isArray(interaction)) return null
  const idempotencyKey = `party-decision-open:${String(interaction.id ?? '').slice(0, 120)}`
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const loaded = await eventStore.load(campaignId)
    if (loaded.state.agentInteraction) {
      if (String(loaded.state.agentInteraction.id) !== String(interaction.id)) return null
      return persistAuthoritativeProjection(campaignId, loaded.state, [], null, { forceProjectorRefresh: true })
    }
    const partyMembers = new Set((loaded.state.partyMemberIds?.length
      ? loaded.state.partyMemberIds
      : loaded.state.players?.map((player) => player.id) ?? []).map(String))
    const connected = connectedHeroIdsForCampaign(campaignId)
    const eligibleHeroIds = (connected.size
      ? [...connected]
      : (loaded.state.players ?? []).filter((player) => player.online).map((player) => String(player.id)))
      .filter((candidate) => partyMembers.has(String(candidate)))
    if (!eligibleHeroIds.length) eligibleHeroIds.push(...partyMembers)
    const voterSnapshot = partyVoterSnapshot(campaignId, loaded.state, eligibleHeroIds)
    try {
      const committed = await eventStore.commit({
        campaign_id: campaignId,
        expected_state_version: loaded.state_version,
        idempotency_key: idempotencyKey,
        command_id: idempotencyKey,
        events: [partyDecisionOpenedEvent(interaction, null, {
          eligibleHeroIds,
          eligibleVoterIds: voterSnapshot.eligibleVoterIds,
          voterByHeroId: voterSnapshot.voterByHeroId,
          policy: loaded.state.partyDecisionPolicy,
        })],
      })
      return persistAuthoritativeProjection(campaignId, committed.state, committed.events)
    } catch (error) {
      if (error?.code !== 'STATE_VERSION_CONFLICT' || attempt === 2) throw error
    }
  }
  return null
}

async function expirePartyDecisionIfNeeded(campaignId, now = Date.now()) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const loaded = await eventStore.load(campaignId)
    const expiration = partyDecisionExpiryEvents(loaded.state, { now })
    if (!expiration.events.length) return null
    const interactionId = String(loaded.state.agentInteraction?.id ?? '')
    const expiresAt = String(loaded.state.agentInteraction?.expiresAt ?? '')
    try {
      return await eventStore.commit({
        campaign_id: campaignId,
        expected_state_version: loaded.state_version,
        idempotency_key: `party-decision-expire:${interactionId}:${expiresAt}`,
        command_id: `party-decision-expire:${interactionId}:${expiresAt}`,
        events: expiration.events,
      })
    } catch (error) {
      if (error?.code !== 'STATE_VERSION_CONFLICT' || attempt === 2) throw error
    }
  }
  return null
}

async function reconcilePartyDecisionPresence(campaignId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const loaded = await eventStore.load(campaignId)
    const interaction = loaded.state.agentInteraction
    if (!interaction || interaction.status !== 'open' || loaded.state.partyDecisionPolicy?.disconnectAction !== 'abstain') return null
    const connectedHeroIds = connectedHeroIdsForCampaign(campaignId)
    const activeVoterIds = partyDecisionActiveVoterIds(interaction, [...connectedHeroIds])
    const presence = partyDecisionPresenceEvents(loaded.state, { activeVoterIds })
    if (!presence.events.length) return null
    const id = String(interaction.id)
    const activeKey = activeVoterIds.slice().sort().join(',') || 'none'
    try {
      const committed = await eventStore.commit({
        campaign_id: campaignId,
        expected_state_version: loaded.state_version,
        idempotency_key: `party-decision-presence:${id}:${activeKey}`,
        command_id: `party-decision-presence:${id}:${activeKey}`,
        events: presence.events,
      })
      persistAuthoritativeProjection(campaignId, committed.state, committed.events)
      return committed
    } catch (error) {
      if (error?.code !== 'STATE_VERSION_CONFLICT' || attempt === 2) throw error
    }
  }
  return null
}

async function runMerchantEconomyClock(campaignId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const loaded = await eventStore.load(campaignId)
    const plans = planMerchantEconomyClock(loaded.state)
    if (!plans.length) return { state: loaded.state, events: [], plans: [] }
    let projectedState = loaded.state
    const events = []
    for (const plan of plans) {
      const merchant = findMerchant(projectedState, plan.merchant_id)
      if (!merchant) continue
      const restockCommand = merchantRestockCommandFromPlan(merchant, plan)
      if (restockCommand) {
        const resolved = rulesEngine.resolve({
          ...restockCommand,
          command_id: `economy-restock:${plan.merchant_id}:${plan.processed_at_world_minute}`,
          expected_state_version: projectedState.state_version,
          request_fingerprint: `clock:${plan.scheduled_for_world_minute}:${plan.processed_at_world_minute}`,
        }, projectedState, { isAdmin: true, system: true })
        for (const event of resolved.events) {
          events.push(event)
          projectedState = applyGameEvent(projectedState, event)
        }
      }
      const clockEvent = merchantEconomyClockEventFromPlan(merchant, plan)
      if (clockEvent) {
        events.push(clockEvent)
        projectedState = applyGameEvent(projectedState, clockEvent)
      }
    }
    if (!events.length) return { state: loaded.state, events: [], plans: [] }
    try {
      const worldMinute = Number(loaded.state.mechanics?.world_time?.elapsed_minutes ?? 0)
      const committed = await eventStore.commit({
        campaign_id: campaignId,
        expected_state_version: loaded.state_version,
        idempotency_key: `merchant-economy-clock:${worldMinute}:${loaded.state_version}`,
        command_id: `merchant-economy-clock:${worldMinute}`,
        events,
      })
      return { state: committed.state, events: committed.events, plans }
    } catch (error) {
      if (error?.code !== 'STATE_VERSION_CONFLICT' || attempt === 2) throw error
    }
  }
  throw new Error('Не удалось синхронизировать экономические часы')
}

function serveStatic(req, res) {
  if (!existsSync(dist)) return json(res, 404, { error: 'Сначала выполните pnpm build' })
  let requested
  try { requested = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') }
  catch { return json(res, 400, { error: 'Некорректный путь' }) }
  let file = resolve(dist, requested)
  if (!(file === dist || file.startsWith(`${dist}${sep}`)) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html')
  const stats = statSync(file)
  // Раздача шла вообще без валидаторов, поэтому браузер тянул каждый файл заново:
  // у боевой панели свой PNG на действие, сотни картинок по 60 КБ повторялись на
  // каждой перерисовке. Событийный цикл стоял на этих потоках, и даже healthcheck
  // не укладывался в свои пять секунд — контейнер уходил в unhealthy.
  const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`
  // Имена сборки vite содержат хеш содержимого — их можно держать в кеше вечно.
  // Файлы из public/ имя не меняют, поэтому им нужна перепроверка по ETag: иначе
  // перерисованная иконка не доедет до экрана.
  const immutable = /^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(requested)
  // index.html держим на короткой цепи: он тянет за собой имена собранных чанков,
  // и после пересборки браузер обязан увидеть новые. Остальному из public/ хватает
  // часа — иначе пятьсот рисунков действий переспрашиваются на каждой перерисовке
  // боевой панели, а через проброс порта Docker Desktop это минуты ожидания.
  const cacheControl = file === join(dist, 'index.html') ? 'no-cache'
    : immutable ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600'
  const validators = { ETag: etag, 'Last-Modified': stats.mtime.toUTCString(), 'Cache-Control': cacheControl }
  const noneMatch = String(req.headers['if-none-match'] || '')
  const modifiedSince = Date.parse(req.headers['if-modified-since'] || '')
  const fresh = noneMatch
    ? noneMatch.split(',').some((tag) => tag.trim() === etag)
    : Number.isFinite(modifiedSince) && modifiedSince >= Math.floor(stats.mtimeMs / 1000) * 1000
  if (fresh) { res.writeHead(304, validators); return res.end() }
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' }
  res.writeHead(200, { ...validators, 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Content-Length': stats.size })
  createReadStream(file).pipe(res)
}

function serveGenerated(req, res) {
  const name = req.url.split('?')[0].replace('/generated/items/', '')
  if (!/^[a-f0-9-]+\.(png|webp|jpe?g)$/i.test(name)) return json(res, 404, { error: 'Файл не найден' })
  const file = join(generatedDir, name)
  if (!existsSync(file)) return json(res, 404, { error: 'Файл не найден' })
  res.writeHead(200, { 'Content-Type': name.endsWith('.webp') ? 'image/webp' : name.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' })
  createReadStream(file).pipe(res)
}

const server = createServer((req, res) => {
  const requestPath = new URL(req.url || '/', 'http://skazanie.local').pathname
  const campaignPathMatch = requestPath.match(/^\/api\/(?:campaigns|rooms)\/([A-Za-z0-9-]+)/)
  const requestCampaignId = campaignPathMatch?.[1]?.toUpperCase() ?? ''
  const storedAiSettings = requestCampaignId ? getCampaignAiSettings(requestCampaignId) : null
  const requestAiSettings = storedAiSettings
    ? { ...storedAiSettings, model: storedAiSettings.model || model }
    : null
  return runWithCampaignAiSettings(requestAiSettings, async () => {
  applySecurityHeaders(res)
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': 'http://127.0.0.1:4173', 'Access-Control-Allow-Headers': 'Content-Type, X-Idempotency-Key', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Credentials': 'true' }); return res.end() }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '') && !originAllowed(req)) return json(res, 403, { error: 'Запрос с другого источника отклонён' })
  if (req.url === '/api/health') return json(res, 200, {
    configured: Boolean(apiKey),
    provider: 'RouterAI',
    model,
    fallbackModels,
    models: llmClient.health(),
    imageModel,
    engineMode: 'enforce',
    rulesetId: rulePack.manifest.ruleset_id,
    ruleCount: rulePack.rules.length,
    characterCreation: characterCreationCatalog(),
    tools: [],
  })
  if (req.url === '/api/admin/usage' && req.method === 'GET') {
    const user = requireAdmin(req, res); if (!user) return
    return json(res, 200, { usage: usageLedger.report(), models: llmClient.health() })
  }
  if (req.url === '/api/auth/me' && req.method === 'GET') {
    const user = userForToken(cookies(req).skazanie_session)
    return json(res, 200, { user, setupRequired: !hasAdmin() })
  }
  if (req.url === '/api/auth/setup-admin' && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { error: 'Слишком много попыток. Попробуйте позже' })
    try {
      const body = await readBody(req)
      const user = await createAdmin(body, body.setupToken)
      const token = createSession(user.id)
      res.setHeader('Set-Cookie', sessionCookie(req, token))
      return json(res, 201, { user, setupRequired: false })
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : 'Не удалось создать администратора' }) }
  }
  if (req.url === '/api/auth/register' && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { error: 'Слишком много попыток. Попробуйте позже' })
    try {
      const user = await registerUser(await readBody(req))
      const token = createSession(user.id)
      res.setHeader('Set-Cookie', sessionCookie(req, token))
      return json(res, 201, { user })
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : 'Не удалось создать аккаунт' }) }
  }
  if (req.url === '/api/auth/login' && req.method === 'POST') {
    if (rateLimited(req)) return json(res, 429, { error: 'Слишком много попыток. Попробуйте позже' })
    const body = await readBody(req).catch(() => ({}))
    const user = await verifyUser(body.email, body.password)
    if (!user) return json(res, 401, { error: 'Неверная почта или пароль' })
    const token = createSession(user.id)
    res.setHeader('Set-Cookie', sessionCookie(req, token))
    return json(res, 200, { user })
  }
  if (req.url === '/api/auth/logout' && req.method === 'POST') {
    deleteSession(cookies(req).skazanie_session)
    res.setHeader('Set-Cookie', sessionCookie(req, '', true))
    return json(res, 200, { ok: true })
  }
  if (req.url === '/api/admin/users' && req.method === 'GET') {
    const admin = requireAdmin(req, res); if (!admin) return
    return json(res, 200, { users: listUsers() })
  }
  const adminUserMatch = req.url?.match(/^\/api\/admin\/users\/([a-f0-9-]+)$/i)
  if (adminUserMatch && req.method === 'PATCH') {
    const admin = requireAdmin(req, res); if (!admin) return
    try { return json(res, 200, { user: updateUserAccess(adminUserMatch[1], await readBody(req)) }) }
    catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : 'Не удалось обновить пользователя' }) }
  }

  const parsedUrl = new URL(req.url || '/', 'http://skazanie.local')
  const campaignTypingMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/presence\/typing$/)
  if (campaignTypingMatch && req.method === 'PUT') {
    const user = requireUser(req, res); if (!user) return
    const campaignId = campaignTypingMatch[1].toUpperCase()
    const room = getRoom(campaignId)
    if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
    if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
    const body = await readBody(req)
    const actorId = String(body.actor_id ?? '')
    if (!canUseHero(user, actorId, campaignId)) {
      return json(res, 403, { error: 'Индикатор ввода доступен только владельцу героя', code: 'ACTOR_FORBIDDEN' })
    }
    const key = String(user.id)
    const typing = campaignTyping.get(campaignId) ?? new Map()
    if (body.typing === true) typing.set(key, { actorId, expiresAt: Date.now() + TYPING_TTL_MS })
    else typing.delete(key)
    if (typing.size) campaignTyping.set(campaignId, typing)
    else campaignTyping.delete(campaignId)
    broadcastCampaignTyping(campaignId)
    return json(res, 200, { ok: true, typing: body.typing === true, ttl_ms: TYPING_TTL_MS })
  }
  const campaignStreamMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/stream$/)
  if (campaignStreamMatch && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return
    const campaignId = campaignStreamMatch[1].toUpperCase()
    const room = await reconcileCampaignProjection(campaignId)
    if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
    if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    const connectionId = `stream-${process.pid}-${++campaignStreamSequence}`
    const heroIds = campaignHeroIds(user, campaignId).map(String)
    const actorId = heroIds.find((id) => room.state.players?.some((player) => String(player.id) === id)) ?? ''
    // Администратор ведёт весь отряд, но за его аккаунтом герои не закреплены,
    // поэтому heroIds пуст и присутствие показывало «0 в сети».
    const controlsParty = user?.role === 'admin'
    const connection = { id: connectionId, userId: String(user.id), user, heroIds, actorId, controlsParty, res, closed: false, mapHash: '' }
    streamConnections(campaignId).set(connectionId, connection)
    const heartbeat = setInterval(() => {
      if (!connection.closed && !res.destroyed) res.write(`: heartbeat ${Date.now()}\n\n`)
    }, 20_000)
    const close = () => {
      if (connection.closed) return
      connection.closed = true
      clearInterval(heartbeat)
      streamConnections(campaignId).delete(connectionId)
      queueMicrotask(() => {
        void reconcilePartyDecisionPresence(campaignId)
          .catch((error) => console.error('[Сказание] Не удалось зафиксировать отключение участника:', error?.message || error))
          .finally(() => broadcastCampaignRoom(campaignId))
      })
    }
    req.once('close', close)
    req.once('aborted', close)
    broadcastCampaignRoom(campaignId)
    return
  }
  const partyVoteMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/party-decisions\/([A-Za-z0-9._:-]+)\/votes$/)
  if (partyVoteMatch && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return
    const campaignId = partyVoteMatch[1].toUpperCase()
    try {
      const room = await reconcileCampaignProjection(campaignId)
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
      if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
      const body = await readBody(req)
      const heroId = String(body.actor_id ?? '')
      if (!canUseHero(user, heroId, campaignId)) return json(res, 403, { error: 'Этот герой не принадлежит вашему аккаунту', code: 'ACTOR_FORBIDDEN' })
      const idempotencyKey = String(body.idempotency_key || req.headers['x-idempotency-key'] || randomUUID())
      let committed = await eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
      for (let attempt = 0; !committed && attempt < 3; attempt += 1) {
        const loaded = await eventStore.load(campaignId)
        const partyMembers = new Set((loaded.state.partyMemberIds?.length
          ? loaded.state.partyMemberIds
          : loaded.state.players?.map((player) => player.id) ?? []).map(String))
        const connected = connectedHeroIdsForCampaign(campaignId)
        const eligible = (connected.size
          ? [...connected]
          : (loaded.state.players ?? []).filter((player) => player.online).map((player) => String(player.id)))
          .filter((candidate) => partyMembers.has(String(candidate)))
        const vote = body.abstain === true
          ? resolvePartyAbstain(loaded.state, {
            interactionId: partyVoteMatch[2],
            heroId,
          })
          : resolvePartyVote(loaded.state, {
            interactionId: partyVoteMatch[2],
            heroId,
            optionId: body.option_id,
            eligibleHeroIds: eligible,
          })
        try {
          committed = await eventStore.commit({
            campaign_id: campaignId,
            expected_state_version: loaded.state_version,
            idempotency_key: idempotencyKey,
            command_id: idempotencyKey,
            events: vote.events,
          })
          break
        } catch (error) {
          if (error?.code !== 'STATE_VERSION_CONFLICT' || attempt === 2) throw error
        }
      }
      const projected = persistAuthoritativeProjection(campaignId, committed.state, committed.events)
      const latestRoom = projected ?? getRoom(campaignId)
      return json(res, 200, {
        version: latestRoom.version,
        updatedAt: latestRoom.updatedAt,
        state: viewerStateFor(stateWithLivePresence(latestRoom.state, campaignId), user, heroId),
        mechanics: committed.events,
        state_version: committed.state_version,
      })
    } catch (error) {
      const status = ['STATE_VERSION_CONFLICT', 'PARTY_DECISION_CONFLICT', 'PARTY_DECISION_CLOSED', 'PARTY_DECISION_ABSTAINED'].includes(error?.code) ? 409
        : error?.code === 'ACTOR_FORBIDDEN' ? 403 : 400
      return json(res, status, { error: error instanceof Error ? error.message : 'Не удалось записать голос', code: error?.code })
    }
  }
  const partyRollMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/party-decisions\/([A-Za-z0-9._:-]+)\/roll$/)
  if (partyRollMatch && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return
    const campaignId = partyRollMatch[1].toUpperCase()
    try {
      const room = await reconcileCampaignProjection(campaignId)
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
      if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
      const body = await readBody(req)
      const heroId = String(body.actor_id ?? '')
      if (!canUseHero(user, heroId, campaignId)) {
        return json(res, 403, { error: 'Этот герой не принадлежит вашему аккаунту', code: 'ACTOR_FORBIDDEN' })
      }
      const idempotencyKey = String(body.idempotency_key || req.headers['x-idempotency-key'] || randomUUID())
      let committed = await eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
      for (let attempt = 0; !committed && attempt < 3; attempt += 1) {
        const loaded = await eventStore.load(campaignId)
        const rolled = diceService.roll('1d20', 'party_decision', heroId, 'party')
        const resolution = resolvePartyRoll(loaded.state, {
          interactionId: partyRollMatch[2],
          heroId,
          roll: rolled,
        })
        try {
          committed = await eventStore.commit({
            campaign_id: campaignId,
            expected_state_version: loaded.state_version,
            idempotency_key: idempotencyKey,
            command_id: idempotencyKey,
            events: resolution.events,
          })
        } catch (error) {
          if (error?.code !== 'STATE_VERSION_CONFLICT' || attempt === 2) throw error
        }
      }
      const resolutionEvent = committed.events.find((event) => event.event_type === 'PartyDecisionResolved')
      const projected = persistAuthoritativeProjection(campaignId, committed.state, committed.events)
      const latestRoom = projected ?? getRoom(campaignId)
      return json(res, 200, {
        version: latestRoom.version,
        updatedAt: latestRoom.updatedAt,
        state: viewerStateFor(stateWithLivePresence(latestRoom.state, campaignId), user, heroId),
        mechanics: committed.events,
        state_version: committed.state_version,
        roll: resolutionEvent?.payload?.roll,
      })
    } catch (error) {
      const status = ['STATE_VERSION_CONFLICT', 'PARTY_DECISION_CONFLICT', 'PARTY_DECISION_CLOSED', 'PARTY_DECISION_ABSTAINED'].includes(error?.code) ? 409
        : error?.code === 'ACTOR_FORBIDDEN' ? 403 : 400
      return json(res, status, { error: error instanceof Error ? error.message : 'Не удалось выполнить общий бросок', code: error?.code })
    }
  }
  if (parsedUrl.pathname === '/api/rules/search' && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return
    try {
      const query = parsedUrl.searchParams.getAll('q').filter(Boolean)
      const rulesetId = parsedUrl.searchParams.get('ruleset_id') || rulePack.manifest.ruleset_id
      const enabled = (parsedUrl.searchParams.get('enabled_packs') || rulesetId).split(',').filter(Boolean)
      const result = await ruleRetriever.search({ queries: query, ruleset_id: rulesetId, enabled_packs: enabled, limit: Math.min(20, Number(parsedUrl.searchParams.get('limit')) || 10) })
      return json(res, 200, result)
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : 'Ошибка поиска правил' }) }
  }

  if (parsedUrl.pathname === '/api/campaigns' && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return
    try {
      const campaigns = listRoomCodes()
        .map((code) => ({ code, room: getRoom(code) }))
        .filter(({ room }) => room.state && canAccessRoom(user, room))
        .map(({ code, room }) => {
          const state = room.state
          const members = state.partyMemberIds?.length ? state.partyMemberIds : state.players?.map((player) => player.id) ?? []
          return {
            code,
            name: String(state.campaign || code),
            partyName: String(state.partyName || 'Без названия'),
            memberCount: members.length,
            playerCount: state.players?.length ?? 0,
            setting: [state.campaignConcept?.era, state.campaignConcept?.genre].filter(Boolean).join(' · '),
            lifecycleStatus: state.mechanics?.campaign_lifecycle?.status ?? (state.mechanics?.death?.campaign_status === 'party_defeated' ? 'failed' : 'active'),
            membershipRole: user.role === 'admin' ? 'admin' : campaignMembership(user, code)?.role ?? 'legacy',
            updatedAt: room.updatedAt,
          }
        })
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      return json(res, 200, { campaigns })
    } catch (error) { return json(res, 500, { error: error instanceof Error ? error.message : 'Не удалось загрузить кампании' }) }
  }

  if (parsedUrl.pathname === '/api/heroes' && req.method === 'GET') {
    const admin = requireAdmin(req, res); if (!admin) return
    try {
      const heroes = new Map()
      for (const code of listRoomCodes()) {
        const room = getRoom(code)
        for (const hero of room.state?.players ?? []) heroes.set(String(hero.id), hero)
      }
      return json(res, 200, { heroes: [...heroes.values()].sort((left, right) => String(left.character).localeCompare(String(right.character), 'ru')) })
    } catch (error) { return json(res, 500, { error: error instanceof Error ? error.message : 'Не удалось загрузить героев' }) }
  }

  if (parsedUrl.pathname === '/api/campaigns' && req.method === 'POST') {
    const creator = requireUser(req, res); if (!creator) return
    try {
      const body = await readBody(req)
      const code = String(body.code || '').toUpperCase()
      if (!/^[A-Z0-9-]{3,24}$/.test(code)) return json(res, 400, { error: 'Код кампании должен содержать 3–24 латинских символа, цифры или дефис' })
      if (getRoom(code).state) return json(res, 409, { error: 'Кампания с таким кодом уже существует' })
      // Размер отряда выбирает создатель: кампания на одного игрока —
      // законный режим, а верхняя граница покрывает стол на пятерых.
      const requestedSlotCount = Number(body.bootstrap?.slotCount ?? body.bootstrap?.players?.length ?? 0)
      if (creator.role !== 'admin' && (!body.bootstrap || !Number.isFinite(requestedSlotCount)
        || requestedSlotCount < MIN_PARTY_SLOTS || requestedSlotCount > MAX_PARTY_SLOTS)) {
        return json(res, 400, { error: `Число мест героев должно быть от ${MIN_PARTY_SLOTS} до ${MAX_PARTY_SLOTS}` })
      }
      if (creator.role !== 'admin' && body.state) return json(res, 403, { error: 'Обычный игрок создаёт кампанию только через проверенный мастер создания' })
      const usesServerSlots = creator.role !== 'admin' || !Array.isArray(body.bootstrap?.players) || body.bootstrap.players.length === 0
      const slotCount = Math.min(MAX_PARTY_SLOTS, Math.max(MIN_PARTY_SLOTS, Math.trunc(requestedSlotCount) || MAX_PARTY_SLOTS))
      const bootstrapPlayers = usesServerSlots
        ? Array.from({ length: slotCount }, (_, index) => createCharacterSlot({
            id: body.bootstrap?.players?.[index]?.id ?? `hero-slot-${index + 1}`,
            index,
          }))
        : body.bootstrap.players
      const generatedState = body.bootstrap ? await campaignBootstrapper.create({
        code,
        name: body.name,
        partyName: body.bootstrap.partyName,
        world: body.bootstrap.world,
        players: bootstrapPlayers,
      }) : null
      const state = normalizeCampaignState(generatedState ?? body.state ?? {
        sessionCode: code,
        campaign: String(body.name || 'Новая кампания').slice(0, 120),
        players: [], messages: [], activePlayerId: '', isNarrating: false, pendingCheck: null,
        scene: { title: 'Начало', location: '', mood: '', objective: '', turn: 0, cells: [] },
      })
      state.sessionCode = code
      state.engine_mode = 'enforce'
      const initialized = await eventStore.initializeCampaign({
        campaign_id: code,
        initial_state: state,
        ruleset_id: state.ruleset_id,
        ruleset_version: state.ruleset_version,
        enabled_rule_packs: state.enabled_rule_packs,
        enabled_house_rules: state.enabled_house_rules,
      })
      const room = saveRoom(code, { ...initialized.state, engine_mode: 'enforce', state_projector_version: GAME_STATE_PROJECTOR_VERSION }, 0)
      const ownerHeroIds = creator.role === 'admin'
        ? []
        : state.partyMemberIds.slice(0, 1)
      if (creator.role !== 'admin') {
        upsertCampaignMembership({ campaignId: code, userId: creator.id, role: 'owner', heroIds: ownerHeroIds })
      }
      const updatedCreator = userForToken(cookies(req).skazanie_session) ?? creator
      return json(res, 201, { ...room.room, user: updatedCreator })
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : 'Не удалось создать кампанию' }) }
  }

  const campaignAiSettingsMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/settings$/)
  if (campaignAiSettingsMatch && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return
    const campaignId = campaignAiSettingsMatch[1].toUpperCase()
    const room = getRoom(campaignId)
    if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
    if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
    const saved = getCampaignAiSettings(campaignId)
    return json(res, 200, {
      settings: {
        model: allowedAiModels.includes(saved.model) ? saved.model : model,
        narratorStyle: normalizeNarratorStyle(saved.narratorStyle),
      },
      availableModels: allowedAiModels,
      narratorStyles: Object.values(NARRATOR_STYLES).map(({ id, label }) => ({ id, label })),
      canManage: user.role === 'admin' || campaignMembershipFor(user.id, campaignId)?.role === 'owner',
    })
  }
  if (campaignAiSettingsMatch && req.method === 'PATCH') {
    const user = requireUser(req, res); if (!user) return
    const campaignId = campaignAiSettingsMatch[1].toUpperCase()
    const room = getRoom(campaignId)
    if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
    const membership = campaignMembershipFor(user.id, campaignId)
    if (user.role !== 'admin' && membership?.role !== 'owner') {
      return json(res, 403, { error: 'Настройки ИИ может менять только владелец кампании' })
    }
    try {
      const body = await readBody(req)
      const current = getCampaignAiSettings(campaignId)
      const requestedModel = body.model === undefined ? (current.model || model) : String(body.model).trim()
      const requestedStyle = body.narratorStyle === undefined ? current.narratorStyle : String(body.narratorStyle).trim().toLowerCase()
      if (!allowedAiModels.includes(requestedModel)) {
        return json(res, 400, { error: 'Эта модель не входит в серверный список разрешённых моделей', code: 'AI_MODEL_NOT_ALLOWED' })
      }
      if (!Object.hasOwn(NARRATOR_STYLES, requestedStyle)) {
        return json(res, 400, { error: 'Неизвестный стиль рассказчика', code: 'NARRATOR_STYLE_NOT_ALLOWED' })
      }
      const saved = saveCampaignAiSettings(campaignId, { model: requestedModel, narratorStyle: requestedStyle })
      return json(res, 200, {
        settings: { model: saved.model, narratorStyle: saved.narratorStyle },
        availableModels: allowedAiModels,
        narratorStyles: Object.values(NARRATOR_STYLES).map(({ id, label }) => ({ id, label })),
        canManage: true,
      })
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : 'Не удалось сохранить настройки ИИ кампании' })
    }
  }

  const campaignInviteMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/invites$/)
  if (campaignInviteMatch && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return
    try {
      const campaignId = campaignInviteMatch[1].toUpperCase()
      const room = getRoom(campaignId)
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
      const membership = campaignMembershipFor(user.id, campaignId)
      if (user.role !== 'admin' && membership?.role !== 'owner') return json(res, 403, { error: 'Создавать приглашения может только владелец кампании' })
      const body = await readBody(req)
      const partyIds = room.state.partyMemberIds?.length
        ? room.state.partyMemberIds.map(String)
        : room.state.players.map((hero) => String(hero.id))
      const assigned = new Set(listCampaignMemberships(campaignId).flatMap((item) => item.heroIds ?? []).map(String))
      const requested = Array.isArray(body.hero_ids) ? [...new Set(body.hero_ids.map(String))] : []
      if (requested.length > 1) return json(res, 400, { error: 'Одна ссылка закрепляет ровно одно место героя' })
      const heroIds = requested.length ? requested : partyIds.filter((heroId) => !assigned.has(heroId)).slice(0, 1)
      if (!heroIds.length) return json(res, 409, { error: 'В кампании не осталось свободных героев' })
      if (heroIds.some((heroId) => !partyIds.includes(heroId) || assigned.has(heroId))) {
        return json(res, 409, { error: 'Приглашение содержит недоступного или уже назначенного героя' })
      }
      const issued = createCampaignInvite({
        campaignId,
        createdBy: user.id,
        heroIds,
        expiresInMs: body.expires_in_ms,
      })
      return json(res, 201, {
        campaign_id: campaignId,
        token: issued.token,
        hero_ids: issued.invite.heroIds,
        expires_at: issued.invite.expiresAt,
      })
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : 'Не удалось создать приглашение' })
    }
  }

  const campaignJoinMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/join$/)
  if (campaignJoinMatch && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return
    try {
      const campaignId = campaignJoinMatch[1].toUpperCase()
      const room = getRoom(campaignId)
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
      const body = await readBody(req)
      const token = String(body.invite_token ?? body.inviteToken ?? '')
      if (!token) return json(res, 400, { error: 'Для входа нужна действующая ссылка-приглашение' })
      const redeemed = redeemCampaignInvite({ campaignId, token, userId: user.id })
      const partyIds = new Set((room.state.partyMemberIds?.length ? room.state.partyMemberIds : room.state.players.map((hero) => hero.id)).map(String))
      if (redeemed.membership.heroIds.some((heroId) => !partyIds.has(String(heroId)))) {
        return json(res, 409, { error: 'Приглашение ссылается на героя, которого нет в кампании' })
      }
      const updated = userForToken(cookies(req).skazanie_session) ?? user
      return json(res, 200, { code: campaignId, hero_ids: redeemed.membership.heroIds, user: updated, duplicate: redeemed.duplicate })
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : 'Не удалось присоединиться к кампании' }) }
  }

  const campaignLifecycleMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/lifecycle$/)
  if (campaignLifecycleMatch && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return
    const campaignId = campaignLifecycleMatch[1].toUpperCase()
    const room = getRoom(campaignId)
    if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
    if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
    return json(res, 200, { campaign_id: campaignId, lifecycle: normalizeCampaignState(room.state).mechanics.campaign_lifecycle })
  }
  if (campaignLifecycleMatch && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return
    const campaignId = campaignLifecycleMatch[1].toUpperCase()
    try {
      const room = getRoom(campaignId)
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
      const membership = campaignMembershipFor(user.id, campaignId)
      if (user.role !== 'admin' && membership?.role !== 'owner') return json(res, 403, { error: 'Управлять жизненным циклом может только владелец кампании' })
      const body = await readBody(req)
      const loaded = await eventStore.load(campaignId)
      const idempotencyKey = String(body.idempotency_key ?? req.headers['x-idempotency-key'] ?? randomUUID())
      const duplicate = await eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
      const lifecycleEvent = duplicate ? null : lifecycleEventForAction(body.action, loaded.state, {
        actorId: user.id,
        reason: body.reason,
      })
      const lifecycleEventId = `campaign-lifecycle:${createHash('sha256').update(`${campaignId}\0${idempotencyKey}`).digest('hex').slice(0, 24)}`
      if (lifecycleEvent) lifecycleEvent.event_id = lifecycleEventId
      const lifecycleEvents = lifecycleEvent ? [lifecycleEvent] : []
      if (lifecycleEvent?.event_type === 'CampaignCompleted') {
        lifecycleEvents.push({
          event_id: `session-summary:${createHash('sha256').update(`${campaignId}\0${idempotencyKey}\0summary`).digest('hex').slice(0, 24)}`,
          event_type: 'NarrativeSummaryRecorded',
          actor_id: user.id,
          target_ids: [],
          visibility: 'party',
          source_rule_ids: [],
          payload: {
            summary: {
              id: `campaign-summary:${createHash('sha256').update(`${campaignId}\0${idempotencyKey}`).digest('hex').slice(0, 24)}`,
              kind: 'session',
              title: String(loaded.state.campaign || 'Финал кампании').slice(0, 180),
              summary: String(lifecycleEvent.payload.epilogue || lifecycleEvent.payload.reason).slice(0, 2_000),
              visibility: 'party',
              entity_ids: [],
              thread_ids: (loaded.state.worldMemory?.threads ?? []).filter((thread) => thread.status === 'active').map((thread) => thread.id).slice(0, 30),
              source_event_ids: [lifecycleEventId],
              source_command_id: `campaign-lifecycle:${idempotencyKey}`,
              recorded_at_minutes: Math.max(0, Number(loaded.state.mechanics?.world_time?.elapsed_minutes) || 0),
            },
          },
        })
      }
      const committed = duplicate ?? await eventStore.commit({
          campaignId,
          expectedStateVersion: loaded.state_version,
          idempotencyKey,
          commandId: `campaign-lifecycle:${idempotencyKey}`,
          events: lifecycleEvents,
        })
      const projected = persistAuthoritativeProjection(campaignId, committed.state, committed.events)
      const actorId = campaignHeroIds(user, campaignId).find((id) => committed.state.players?.some((player) => String(player.id) === String(id))) ?? ''
      return json(res, 200, {
        campaign_id: campaignId,
        lifecycle: committed.state.mechanics.campaign_lifecycle,
        version: projected.version,
        state: viewerStateFor(committed.state, user, actorId),
      })
    } catch (error) {
      const status = ['STATE_VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'INVALID_CAMPAIGN_TRANSITION', 'CAMPAIGN_COMBAT_ACTIVE'].includes(error?.code) ? 409 : 400
      return json(res, status, { error: error instanceof Error ? error.message : 'Не удалось изменить состояние кампании', code: error?.code })
    }
  }

  const autonomyMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/autonomy\/intents$/)
  if (autonomyMatch && req.method === 'POST') {
    const user = requireAdmin(req, res); if (!user) return
    try {
      const body = await readBody(req)
      const campaignId = autonomyMatch[1]
      const room = getRoom(campaignId)
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
      if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
      assertCampaignPlayable(room.state)
      const key = String(body.idempotency_key ?? body.idempotencyKey ?? req.headers['x-idempotency-key'] ?? randomUUID())
      const result = await autonomousCampaign.runIntent({ campaignId, intent: body.intent, idempotencyKey: key })
      const events = []
      for (const stage of result.results ?? []) events.push(...(stage.events ?? []))
      if (body.run_combat === true && result.state.mechanics?.combat?.active) {
        const combat = await autonomousCampaign.runCombat(campaignId, { idempotencyPrefix: `${key}:combat` })
        if (!combat.state.mechanics?.combat?.active) await autonomousCampaign.completeEncounter({ campaignId, idempotencyKey: `${key}:completion` })
      }
      const authoritative = await autonomousCampaign.load(campaignId)
      persistAuthoritativeProjection(campaignId, authoritative.state, events)
      return json(res, 200, { intent: result.intent, state_version: authoritative.state_version, admin_commands: 0, state: viewerStateFor(authoritative.state, user, authoritative.state.activePlayerId) })
    } catch (error) {
      return json(res, error?.code === 'DIRECTOR_INTENT_NOT_ALLOWED' || error?.code === 'DIRECTOR_MECHANICS_FORBIDDEN' ? 400 : 409, { error: error instanceof Error ? error.message : 'Автономный ход не выполнен', code: error?.code })
    }
  }

  const autonomyAdvanceMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/autonomy\/advance$/)
  if (autonomyAdvanceMatch && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return
    try {
      const body = await readBody(req)
      const campaignId = autonomyAdvanceMatch[1]
      const room = getRoom(campaignId)
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
      if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
      const key = String(body.idempotency_key ?? req.headers['x-idempotency-key'] ?? '').slice(0, 120)
      if (!key) return json(res, 400, { error: 'Нужен idempotency_key', code: 'IDEMPOTENCY_KEY_REQUIRED' })
      const duplicate = await eventStore.getByIdempotencyKey(campaignId, `${key}:intent`)
      if (duplicate) {
        const current = await autonomousCampaign.load(campaignId)
        return json(res, 200, { duplicate: true, state_version: current.state_version, admin_commands: 0, state: viewerStateFor(current.state, user, current.state.activePlayerId) })
      }
      let loaded = await autonomousCampaign.load(campaignId)
      assertCampaignPlayable(loaded.state)
      const encounter = loaded.state.mechanics?.encounter
      const outcomeRecorded = encounter?.id && (loaded.state.autonomy?.encounter_outcomes ?? []).some((entry) => entry.encounter_id === encounter.id)
      const events = []
      let reward = null
      if (encounter?.status === 'ended' && !outcomeRecorded) {
        const completion = await autonomousCampaign.completeEncounter({ campaignId, outcome: encounter.outcome || 'enemies_defeated', idempotencyKey: `${key}:completion` })
        events.push(...(completion.events ?? []))
        reward = completion.reward
        loaded = await autonomousCampaign.load(campaignId)
      }
      if (loaded.state.mechanics?.combat?.active) return json(res, 409, { error: 'Сначала завершите активный бой через тактический интерфейс', code: 'COMBAT_ACTIVE' })
      const decision = await directorAgent.choose({ state: loaded.state, playerAction: body.player_action })
      const result = await autonomousCampaign.runIntent({ campaignId, intent: decision.intent, idempotencyKey: key })
      for (const stage of result.results ?? []) events.push(...(stage.events ?? []))
      const authoritative = await autonomousCampaign.load(campaignId)
      // Шаг Директора менял цель и сцену молча: в ленте не появлялось ни строки,
      // и игрок видел новую задачу про персонажа, которого ему не представили.
      const directorNarration = tacticalNarration(events, authoritative.state)
        || deterministicNarration(
          { visible_events: events, visible_state_changes: [], known_environment: {}, permitted_npc_reactions: [] },
          actorNameResolver(authoritative.state),
        ).narration
      persistAuthoritativeProjection(campaignId, authoritative.state, events, directorNarration ? {
        id: `director-${createHash('sha256').update(String(key)).digest('hex').slice(0, 20)}`,
        text: directorNarration,
        speaker: 'narrator',
        turnConsumed: false,
      } : null)
      return json(res, 200, {
        intent: result.intent, director_trace: decision.trace, reward,
        state_version: authoritative.state_version, admin_commands: 0,
        state: viewerStateFor(authoritative.state, user, authoritative.state.activePlayerId),
      })
    } catch (error) {
      return json(res, error?.code === 'DIRECTOR_INTENT_NOT_ALLOWED' || error?.code === 'DIRECTOR_MECHANICS_FORBIDDEN' ? 400 : 409, { error: error instanceof Error ? error.message : 'Director не смог продолжить приключение', code: error?.code })
    }
  }
  const explanationMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/turns\/([A-Za-z0-9._-]+)\/explanation$/)
  if (explanationMatch && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return
    const room = getRoom(explanationMatch[1])
    if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
    const trace = explanationMatch[2] === 'latest' ? traceStore.latest(explanationMatch[1]) : traceStore.get(explanationMatch[1], explanationMatch[2])
    const playerId = campaignHeroIds(user, explanationMatch[1]).map(String)
      .find((id) => room.state?.players?.some((player) => String(player.id) === id)) ?? ''
    const explanation = buildTurnExplanation(trace, {
      playerId,
      isPartyMember: true,
      role: user.role,
    })
    return explanation ? json(res, 200, turnExplanationForViewer(explanation, user, playerId, room.state)) : json(res, 404, { error: 'Трассировка хода не найдена' })
  }

  const engineModeMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/engine-mode$/)
  if (engineModeMatch && req.method === 'PATCH') {
    const admin = requireAdmin(req, res); if (!admin) return
    return json(res, 410, { error: 'Переключение движка удалено: enforce является единственным runtime', code: 'ENGINE_MODE_RETIRED' })
  }

  const merchantLifecycleMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/merchants\/commands$/)
  if (merchantLifecycleMatch && req.method === 'POST') {
    const admin = requireAdmin(req, res); if (!admin) return
    try {
      const room = getRoom(merchantLifecycleMatch[1])
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена', code: 'CAMPAIGN_NOT_FOUND' })
      if (exceedsRate(`merchant-lifecycle:${admin.id}`, 60)) {
        return json(res, 429, { error: 'Слишком много изменений торговцев. Подождите немного и повторите попытку', code: 'MERCHANT_LIFECYCLE_RATE_LIMITED' })
      }
      const body = await readBody(req)
      if (!body.command || typeof body.command !== 'object' || Array.isArray(body.command)) {
        return json(res, 400, { error: 'Нужна ровно одна lifecycle-команда торговца', code: 'INVALID_MERCHANT_LIFECYCLE_COMMAND' })
      }
      const idempotencyKey = String(body.idempotency_key ?? req.headers['x-idempotency-key'] ?? '').trim()
      if (!idempotencyKey || idempotencyKey.length > 200) {
        return json(res, 400, { error: 'Нужен X-Idempotency-Key или idempotency_key длиной до 200 символов', code: 'IDEMPOTENCY_KEY_REQUIRED' })
      }
      const result = await executeMerchantLifecycleCommand({
        campaignId: merchantLifecycleMatch[1], room, admin, command: body.command, idempotencyKey,
      })
      return json(res, 200, result)
    } catch (error) {
      const status = ['STATE_VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'MERCHANT_ALREADY_EXISTS'].includes(error?.code)
        ? 409
        : error?.code === 'MERCHANT_NOT_FOUND' ? 404
          : ['ACTOR_FORBIDDEN', 'PLAYER_COMMAND_FORBIDDEN', 'MERCHANT_LIFECYCLE_COMMAND_FORBIDDEN'].includes(error?.code) ? 403 : 400
      return json(res, status, { error: error instanceof Error ? error.message : 'Изменение торговца отклонено', code: error?.code })
    }
  }

  const merchantAssembleMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/merchants\/assemble$/)
  if (merchantAssembleMatch && req.method === 'POST') {
    const admin = requireAdmin(req, res); if (!admin) return
    try {
      const campaignId = merchantAssembleMatch[1]
      const room = getRoom(campaignId)
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена', code: 'CAMPAIGN_NOT_FOUND' })
      if (exceedsRate(`shop-assemble:${admin.id}`, 30)) {
        return json(res, 429, { error: 'Слишком много запросов сборки магазинов. Подождите немного и повторите попытку', code: 'SHOP_ASSEMBLY_RATE_LIMITED' })
      }
      const body = await readBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw commandPolicyError('Параметры сборки должны быть объектом', 'INVALID_SHOP_INPUT')
      const allowedKeys = new Set(['expected_state_version', 'settlement_type', 'theme', 'seed', 'budget_cp', 'director_intent', 'idempotency_key'])
      if (Object.keys(body).some((key) => !allowedKeys.has(key))) throw commandPolicyError('Запрос сборки содержит неизвестное поле', 'UNEXPECTED_SHOP_FIELD')
      const idempotencyKey = String(body.idempotency_key ?? req.headers['x-idempotency-key'] ?? '').trim()
      if (!idempotencyKey || idempotencyKey.length > 200) {
        return json(res, 400, { error: 'Нужен X-Idempotency-Key или idempotency_key длиной до 200 символов', code: 'IDEMPOTENCY_KEY_REQUIRED' })
      }
      const expectedStateVersion = lifecycleInteger(body.expected_state_version, 'expected_state_version')
      const authoritative = await latestCampaignState(campaignId, room.state)
      const location = String(authoritative.scene?.location ?? '').trim()
      if (!location) throw commandPolicyError('У текущей сцены не задана локация для магазина', 'INVALID_LOCATION')
      const settlementType = body.settlement_type ?? 'town'
      const theme = body.theme ?? 'general'
      const defaultSeed = createHash('sha256')
        .update(`${campaignId}\0${location}\0${settlementType}\0${theme}`)
        .digest('hex')
      const proposal = assembleShop({
        location,
        settlement_type: settlementType,
        theme,
        seed: body.seed ?? defaultSeed,
        budget_cp: body.budget_cp ?? 20_000,
        ...(body.director_intent == null ? {} : { director_intent: body.director_intent }),
      })
      const result = await executeMerchantLifecycleCommand({
        campaignId,
        room,
        admin,
        idempotencyKey,
        message: 'ShopAssembler создаёт торговца для текущей сцены',
        command: {
          command_type: 'CreateMerchant',
          expected_state_version: expectedStateVersion,
          merchant: proposal.merchant,
        },
      })
      return json(res, 200, { ...result, shop_proposal: proposal })
    } catch (error) {
      const status = ['STATE_VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'MERCHANT_ALREADY_EXISTS'].includes(error?.code) ? 409 : 400
      return json(res, status, { error: error instanceof Error ? error.message : 'Сборка магазина отклонена', code: error?.code })
    }
  }

  const encounterAssembleMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/encounters\/assemble$/)
  if (encounterAssembleMatch && req.method === 'POST') {
    const admin = requireAdmin(req, res); if (!admin) return
    try {
      const campaignId = encounterAssembleMatch[1]
      const room = getRoom(campaignId)
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена', code: 'CAMPAIGN_NOT_FOUND' })
      if (exceedsRate(`encounter-assemble:${admin.id}`, 30)) {
        return json(res, 429, { error: 'Слишком много запросов сборки столкновений', code: 'ENCOUNTER_ASSEMBLY_RATE_LIMITED' })
      }
      const body = await readBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw commandPolicyError('Параметры столкновения должны быть объектом', 'INVALID_ENCOUNTER_INPUT')
      const allowedKeys = new Set(['expected_state_version', 'difficulty', 'theme', 'seed', 'idempotency_key'])
      if (Object.keys(body).some((key) => !allowedKeys.has(key))) throw commandPolicyError('Запрос столкновения содержит неизвестное поле', 'UNEXPECTED_ENCOUNTER_FIELD')
      const idempotencyKey = String(body.idempotency_key ?? req.headers['x-idempotency-key'] ?? '').trim()
      if (!idempotencyKey || idempotencyKey.length > 200) {
        return json(res, 400, { error: 'Нужен X-Idempotency-Key или idempotency_key длиной до 200 символов', code: 'IDEMPOTENCY_KEY_REQUIRED' })
      }
      const authoritative = await latestCampaignState(campaignId, room.state)
      const expectedStateVersion = lifecycleInteger(body.expected_state_version, 'expected_state_version')
      const difficulty = String(body.difficulty ?? 'medium')
      const theme = String(body.theme ?? 'generic')
      const seed = String(body.seed ?? createHash('sha256').update(`${campaignId}\0${idempotencyKey}`).digest('hex')).slice(0, 120)
      const command = {
        command_type: 'CreateEncounter',
        expected_state_version: expectedStateVersion,
        difficulty,
        theme,
        seed,
      }
      command.request_fingerprint = encounterCommandFingerprint(command)
      await assertEncounterIdempotency(campaignId, idempotencyKey, command)

      // Build a preview from authoritative state. Rules Engine repeats this
      // derivation before the event, so neither HTTP nor an agent can inject a
      // stat block, combat number or spawn coordinate.
      const memberIds = new Set(authoritative.partyMemberIds?.length ? authoritative.partyMemberIds.map(String) : authoritative.players.map((player) => String(player.id)))
      const party = authoritative.players.filter((player) => memberIds.has(String(player.id)) && Number(player.hp) > 0).map((player) => {
        const position = authoritative.mechanics?.positions?.[String(player.id)] ?? player
        return { id: String(player.id), level: Math.max(1, Math.min(20, Number.isSafeInteger(Number(player.level)) ? Number(player.level) : 1)), x: Number(position.x), y: Number(position.y) }
      })
      // Тот же расчёт занятости, что и в Rules Engine: предпросмотр обязан
      // совпадать с тем, что движок повторит перед событием.
      const previewOccupiedCells = new Set([
        ...[...(authoritative.enemies ?? []), ...(authoritative.actors ?? [])]
          .filter((actor) => actor && actor.alive !== false && Number(actor.hp ?? 1) > 0)
          .map((actor) => {
            const position = authoritative.mechanics?.positions?.[String(actor.id)] ?? actor
            return `${Number(position?.x)},${Number(position?.y)}`
          }),
        ...(authoritative.entities ?? [])
          .filter((entity) => String(entity?.kind) === 'enemy')
          .map((entity) => `${Number(entity?.x)},${Number(entity?.y)}`),
      ])
      const proposalPreview = assembleEncounter({
        scene: { cells: (authoritative.scene?.cells ?? []).map((cell) => ({
          x: Number(cell.x), y: Number(cell.y), type: String(cell.type ?? 'floor'), revealed: cell.revealed === true,
          ...(cell.feature == null ? {} : { feature: String(cell.feature) }),
          ...(previewOccupiedCells.has(`${Number(cell.x)},${Number(cell.y)}`) ? { occupied: true } : {}),
        })) },
        party,
        difficulty,
        theme,
        seed,
      })
      const actorId = String(party[0]?.id ?? authoritative.activePlayerId ?? '')
      let result = await gameOrchestrator.handle({
        state: room.state,
        campaignId,
        playerId: actorId,
        message: 'EncounterAssembler создаёт столкновение и запускает инициативу',
        commands: [command, { command_type: 'StartCombat', actor_id: actorId, server_authoritative: true }],
        idempotencyKey,
        user: admin,
        allowedActorIds: campaignHeroIds(admin, campaignId),
      })
      assertEncounterResultFingerprint(result, command)
      const originalVersion = Number(result.state_version ?? result.authoritative_state?.state_version ?? 0)
      const scheduler = await runNpcTurnScheduler({ campaignId, eventStore, rulesEngine, npcController, advanceNpc: true })
      const latest = await eventStore.load(campaignId)
      const subsequentEvents = latest.state_version > originalVersion
        ? await eventStore.getEvents(campaignId, { after_version: originalVersion, up_to_version: latest.state_version })
        : []
      const mechanics = [...(result.mechanics ?? []), ...subsequentEvents]
        .filter((event, index, all) => all.findIndex((candidate) => String(candidate.event_id ?? `${candidate.state_version_after}:${candidate.event_type}`) === String(event.event_id ?? `${event.state_version_after}:${event.event_type}`)) === index)
      const narration = tacticalNarration(mechanics, latest.state) || result.narration
      result = { ...result, state_version: latest.state_version, authoritative_state: latest.state, mechanics, npc_turns: scheduler.turns, narration }
      const narrationMessageId = narration ? combatMessageId(idempotencyKey) : null
      const projected = persistAuthoritativeProjection(campaignId, latest.state, mechanics, narrationMessageId ? { id: narrationMessageId, text: narration, turnConsumed: false } : null)
      const responseState = projected?.state ?? latest.state
      const encounterEvent = mechanics.find((event) => event.event_type === 'EncounterCreated')
      return json(res, 200, turnResultForViewer({
        ...result,
        authoritative_state: responseState,
        encounter_proposal: encounterEvent?.payload?.encounter ?? proposalPreview,
        room_version: projected?.version ?? room.version,
      }, admin, actorId))
    } catch (error) {
      const status = ['STATE_VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'ENCOUNTER_ALREADY_PRESENT', 'ENCOUNTER_DURING_COMBAT'].includes(error?.code) ? 409
        : ['ENCOUNTER_MANAGEMENT_FORBIDDEN', 'ACTOR_FORBIDDEN'].includes(error?.code) ? 403 : 400
      return json(res, status, { error: error instanceof Error ? error.message : 'Сборка столкновения отклонена', code: error?.code })
    }
  }

  const merchantMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/merchants\/([^/]+)(?:\/commands)?$/)
  let routeMerchantId = null
  if (merchantMatch) {
    try { routeMerchantId = decodeURIComponent(merchantMatch[2]).slice(0, 120) }
    catch { return json(res, 400, { error: 'Некорректный id торговца', code: 'INVALID_MERCHANT_ID' }) }
  }
  if (merchantMatch && req.method === 'GET' && !parsedUrl.pathname.endsWith('/commands')) {
    const user = requireUser(req, res); if (!user) return
    const room = getRoom(merchantMatch[1])
    if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
    if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
    const actor = String(parsedUrl.searchParams.get('actor_id') || '')
    if (!actor || !canUseHero(user, actor, merchantMatch[1])) return json(res, 403, { error: 'Торговать можно только от имени своего героя', code: 'ACTOR_FORBIDDEN' })
    const state = await latestCampaignState(merchantMatch[1], room.state)
    const view = merchantViewFor(state, routeMerchantId, actor)
    if (!view) return json(res, 404, { error: 'Торговец или герой не найден', code: 'MERCHANT_NOT_FOUND' })
    if (view.merchant.available === false) return json(res, 409, { error: 'Торговец сейчас недоступен', code: 'MERCHANT_UNAVAILABLE' })
    if (!merchantIsAtLocation(view.merchant, state.scene)) {
      return json(res, 409, { error: 'Торговец находится в другой локации', code: 'MERCHANT_NOT_PRESENT' })
    }
    return json(res, 200, { merchant_view: view, room_version: room.version })
  }
  if (merchantMatch && req.method === 'POST' && parsedUrl.pathname.endsWith('/commands')) {
    const user = requireUser(req, res); if (!user) return
    try {
      const room = getRoom(merchantMatch[1])
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
      if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
      if (exceedsRate(`merchant-command:${user.id}`, 120)) {
        return json(res, 429, { error: 'Слишком много торговых операций. Подождите немного и повторите попытку', code: 'MERCHANT_RATE_LIMITED' })
      }
      const body = await readBody(req)
      if (!body.command || typeof body.command !== 'object' || Array.isArray(body.command)) return json(res, 400, { error: 'Нужна одна торговая command' })
      const authoritativeBefore = await latestCampaignState(merchantMatch[1], room.state)
      const command = sanitizeMerchantCommand(user, authoritativeBefore, body.command, routeMerchantId)
      const idempotencyKey = String(body.idempotency_key || req.headers['x-idempotency-key'] || randomUUID())
      await assertMerchantIdempotency(merchantMatch[1], idempotencyKey, command)
      const result = await gameOrchestrator.handle({
        state: room.state,
        campaignId: merchantMatch[1],
        playerId: command.actor_id,
        message: String(body.message || 'Торговая операция'),
        commands: [command],
        idempotencyKey,
        user,
        allowedActorIds: campaignHeroIds(user, merchantMatch[1]),
      })
      assertMerchantResultFingerprint(result, command)
      const narrationMessageId = result.narration ? merchantMessageId(idempotencyKey) : null
      const narrationMessage = narrationMessageId
        ? { id: narrationMessageId, text: result.narration, turnConsumed: false }
        : null
      const projected = result.authoritative_state
        ? persistAuthoritativeProjection(merchantMatch[1], result.authoritative_state, result.mechanics, narrationMessage)
        : null
      const responseState = projected?.state ?? result.authoritative_state
      const view = responseState ? merchantViewFor(responseState, routeMerchantId, command.actor_id) : null
      const responsePayload = {
        ...result,
        ...(narrationMessageId ? { narration_message_id: narrationMessageId } : {}),
        // Keep the internal state whole here. turnResultForViewer performs the
        // single public projection below; pre-projecting a partial merchant
        // state used to erase the scene and merchant list on the client.
        authoritative_state: responseState,
        merchant_view: view,
        room_version: projected?.version ?? room.version,
      }
      return json(res, 200, turnResultForViewer(responsePayload, user, command.actor_id))
    } catch (error) {
      const status = error?.code === 'STATE_VERSION_CONFLICT' || error?.code === 'IDEMPOTENCY_CONFLICT'
        ? 409
        : ['ACTOR_FORBIDDEN', 'PLAYER_COMMAND_FORBIDDEN'].includes(error?.code) ? 403
          : ['MERCHANT_NOT_FOUND', 'ITEM_NOT_FOUND', 'STOCK_NOT_FOUND'].includes(error?.code) ? 404 : 400
      return json(res, status, { error: error instanceof Error ? error.message : 'Торговая операция отклонена', code: error?.code })
    }
  }

  const commandMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/commands$/)
  if (commandMatch && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return
    try {
      const room = getRoom(commandMatch[1])
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
      if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
      const body = await readBody(req)
      let commands = Array.isArray(body.commands) ? body.commands : body.command ? [body.command] : []
      if (!commands.length) return json(res, 400, { error: 'Нужна command или commands' })
      const authoritativeBefore = await latestCampaignState(commandMatch[1], room.state)
      commands = commands.map((command) => {
        const type = commandType(command)
        if (PLAYER_MERCHANT_COMMANDS.has(type)) return sanitizeMerchantCommand(user, authoritativeBefore, command)
        if (PLAYER_CHARACTER_COMMANDS.has(type) || PLAYER_CHARACTER_LIFECYCLE_COMMANDS.has(type)) return sanitizePlayerCharacterCommand(user, authoritativeBefore, command)
        if (PLAYER_ITEM_COMMANDS.has(type)) return sanitizePlayerItemCommand(user, authoritativeBefore, command)
        if (user.role !== 'admin') return sanitizePlayerCombatCommand(user, authoritativeBefore, command)
        return PLAYER_COMBAT_COMMANDS.has(type) ? { ...command, server_authoritative: true } : command
      })
      const actor = String(commands[0]?.actor_id || room.state.activePlayerId || '')
      const commandActor = [...(room.state.players ?? []), ...(room.state.actors ?? [])].find((candidate) => String(candidate.id ?? candidate.actor_id) === actor)
      const controller = String(commandActor?.controllerId ?? commandActor?.controller_id ?? commandActor?.ownerId ?? commandActor?.owner_id ?? '')
      if (!canUseHero(user, actor, commandMatch[1]) && !(isPartySummon(commandActor) && canUseHero(user, controller, commandMatch[1]))) return json(res, 403, { error: 'Команда доступна только владельцу героя или его призванного существа', code: 'ACTOR_FORBIDDEN' })
      const idempotencyKey = String(body.idempotency_key || req.headers['x-idempotency-key'] || randomUUID())
      const types = new Set(commands.map(commandType))
      if ([...types].some((type) => SERVER_WORLD_COMMANDS.has(type))) {
        throw commandPolicyError('Переход сцены может создать только серверный контур Директора после подтверждённого решения группы', 'DIRECTOR_COMMAND_REQUIRED')
      }
      if ([...types].some((type) => ADMIN_MERCHANT_LIFECYCLE_COMMANDS.has(type))) {
        throw commandPolicyError('Lifecycle-команды торговцев принимаются только отдельным административным endpoint /merchants/commands', 'MERCHANT_LIFECYCLE_ENDPOINT_REQUIRED')
      }
      if ([...types].some((type) => SERVER_ENCOUNTER_COMMANDS.has(type))) {
        throw commandPolicyError('Создание столкновения принимается только endpoint /encounters/assemble', 'ENCOUNTER_LIFECYCLE_ENDPOINT_REQUIRED')
      }
      const merchantCommands = commands.filter((command) => PLAYER_MERCHANT_COMMANDS.has(commandType(command)))
      const characterCommands = commands.filter((command) => PLAYER_CHARACTER_COMMANDS.has(commandType(command)))
      const characterLifecycleCommands = commands.filter((command) => PLAYER_CHARACTER_LIFECYCLE_COMMANDS.has(commandType(command)))
      const itemCommands = commands.filter((command) => PLAYER_ITEM_COMMANDS.has(commandType(command)))
      const reactionActorId = String(room.state.mechanics?.combat?.reaction_window?.actor_id ?? '')
      const resolvesReaction = commands.some((command) => commandType(command) === 'UseCombatAction' && String(command.actor_id ?? '') === reactionActorId)
      if (merchantCommands.length) {
        if (exceedsRate(`merchant-command:${user.id}`, 120)) {
          return json(res, 429, { error: 'Слишком много торговых операций. Подождите немного и повторите попытку', code: 'MERCHANT_RATE_LIMITED' })
        }
        if (commands.length !== 1) throw commandPolicyError('Торговая операция должна быть отдельной атомарной командой', 'PLAYER_COMMAND_FORBIDDEN')
        await assertMerchantIdempotency(commandMatch[1], idempotencyKey, merchantCommands[0])
      }
      if (characterCommands.length && characterCommands.length !== commands.length) {
        throw commandPolicyError('Изменения развития персонажа нельзя смешивать с игровым ходом', 'PLAYER_COMMAND_FORBIDDEN')
      }
      if (characterLifecycleCommands.length && commands.length !== 1) {
        throw commandPolicyError('Повышение уровня или импорт листа выполняются отдельной атомарной командой', 'PLAYER_COMMAND_FORBIDDEN')
      }
      if (itemCommands.length && commands.length !== 1) {
        throw commandPolicyError('Действие с предметом должно быть отдельной атомарной командой', 'PLAYER_COMMAND_FORBIDDEN')
      }
      if (itemCommands.length) {
        await assertItemIdempotency(commandMatch[1], idempotencyKey, itemCommands[0])
      }
      let result = await gameOrchestrator.handle({ state: room.state, campaignId: commandMatch[1], playerId: actor, message: String(body.message || 'Структурированная команда'), commands, idempotencyKey, user, allowedActorIds: campaignHeroIds(user, commandMatch[1]) })
      if (merchantCommands.length) assertMerchantResultFingerprint(result, merchantCommands[0])
      if (characterCommands.length) assertCharacterBuildResultFingerprint(result, characterCommands)
      if (itemCommands.length) assertItemResultFingerprint(result, itemCommands[0])
      if (result.authoritative_state) {
        const originalVersion = Number(result.state_version ?? result.authoritative_state.state_version ?? 0)
        const shouldSettleCombat = [...types].some((type) => PLAYER_COMBAT_COMMANDS.has(type))
          || (types.has('UseItem') && Boolean(result.authoritative_state.mechanics?.combat?.active))
        const scheduler = shouldSettleCombat
          ? await runNpcTurnScheduler({
            campaignId: commandMatch[1], eventStore, rulesEngine, npcController,
            advanceNpc: types.has('StartCombat') || types.has('EndTurn') || resolvesReaction,
          })
          : { turns: [], events: [] }
        const latest = await eventStore.load(commandMatch[1])
        const subsequentEvents = latest.state_version > originalVersion
          ? await eventStore.getEvents(commandMatch[1], { after_version: originalVersion, up_to_version: latest.state_version })
          : []
        const mechanics = [...(result.mechanics ?? []), ...subsequentEvents]
          .filter((event, index, all) => all.findIndex((candidate) => String(candidate.event_id ?? `${candidate.state_version_after}:${candidate.event_type}`) === String(event.event_id ?? `${event.state_version_after}:${event.event_type}`)) === index)
        result = {
          ...result,
          state_version: latest.state_version,
          authoritative_state: latest.state,
          mechanics,
          npc_turns: scheduler.turns,
        }
      }
      const creativeMoment = result.authoritative_state
        ? await creativeDirector.renderCriticalMoment({
          events: result.mechanics,
          state: result.authoritative_state,
          viewer: { playerId: actor, partyIds: campaignHeroIds(user, commandMatch[1]), isPartyMember: true, role: user.role },
        })
        : null
      const tacticalLog = result.authoritative_state ? tacticalNarration(result.mechanics, result.authoritative_state) : ''
      const narration = creativeMoment?.narration || tacticalLog
      const narrationMessageId = narration
        ? combatMessageId(idempotencyKey)
        : merchantCommands.length && result.narration ? merchantMessageId(idempotencyKey) : null
      const journalNarration = narration || (merchantCommands.length ? String(result.narration || '') : '')
      if (narration) result = {
        ...result,
        narration,
        narration_message_id: narrationMessageId,
        narration_speaker: creativeMoment ? 'narrator' : 'system',
        narration_author: creativeMoment ? 'Рассказчик' : 'Система боя',
        creative_trigger: creativeMoment?.trigger ?? null,
        creative_provider: creativeMoment?.provider ?? null,
      }
      else if (journalNarration) result = { ...result, narration_message_id: narrationMessageId }
      const projected = result.authoritative_state
        ? persistAuthoritativeProjection(commandMatch[1], result.authoritative_state, result.mechanics, journalNarration ? {
          id: narrationMessageId,
          text: journalNarration,
          turnConsumed: types.has('EndTurn'),
          speaker: creativeMoment ? 'narrator' : 'system',
          author: creativeMoment ? 'Рассказчик' : 'Система боя',
        } : null)
        : null
      const responseState = projected?.state ?? result.authoritative_state
      const merchantCommand = commands.find((command) => PLAYER_MERCHANT_COMMANDS.has(commandType(command)))
      const merchantView = merchantCommand && responseState
        ? merchantViewFor(responseState, merchantCommand.merchant_id, merchantCommand.actor_id)
        : undefined
      const responsePayload = { ...result, authoritative_state: responseState, ...(merchantView ? { merchant_view: merchantView } : {}), room_version: projected?.version ?? room.version }
      return json(res, 200, turnResultForViewer(responsePayload, user, actor))
    } catch (error) {
      const status = ['STATE_VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT'].includes(error?.code) ? 409 : ['ACTOR_FORBIDDEN', 'PLAYER_COMMAND_FORBIDDEN'].includes(error?.code) ? 403 : 400
      return json(res, status, { error: error instanceof Error ? error.message : 'Команда отклонена', code: error?.code })
    }
  }

  const systemTickMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/system-tick$/)
  if (systemTickMatch && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return
    const campaignId = systemTickMatch[1].toUpperCase()
    try {
      let room = getRoom(campaignId)
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
      if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
      assertCampaignPlayable(room.state)
      const latest = await eventStore.load(campaignId)
      if (Number(room.state.state_projector_version ?? 1) < GAME_STATE_PROJECTOR_VERSION || Number(room.state.state_version ?? 0) < latest.state_version) {
        persistAuthoritativeProjection(campaignId, latest.state, [], null, { forceProjectorRefresh: true })
        room = getRoom(campaignId)
      }
      if (latest.state.mechanics?.combat?.active) {
        const scheduler = await runNpcTurnScheduler({
          campaignId,
          eventStore,
          rulesEngine,
          npcController,
          advanceNpc: true,
        })
        if (scheduler.events.length) {
          const advanced = await eventStore.load(campaignId)
          persistAuthoritativeProjection(campaignId, advanced.state, scheduler.events)
          room = getRoom(campaignId)
        }
      }
      const economyClock = await runMerchantEconomyClock(campaignId)
      if (economyClock.events.length) {
        persistAuthoritativeProjection(campaignId, economyClock.state, economyClock.events)
        room = getRoom(campaignId)
      }
      const actorId = campaignHeroIds(user, campaignId).find((id) => room.state.players?.some((player) => String(player.id) === String(id))) ?? ''
      return json(res, 200, {
        ...room,
        state: viewerStateFor(normalizeCampaignState(room.state), user, actorId),
        economy_clock_events: economyClock.events.length,
      })
    } catch (error) {
      if (['STATE_VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT'].includes(error?.code)) {
        const room = getRoom(campaignId)
        const actorId = campaignHeroIds(user, campaignId).find((id) => room.state?.players?.some((player) => String(player.id) === String(id))) ?? ''
        return json(res, 200, { ...room, state: viewerStateFor(normalizeCampaignState(room.state), user, actorId) })
      }
      return json(res, 400, { error: error instanceof Error ? error.message : 'Не удалось продолжить системный ход' })
    }
  }

  // Комната читается с параметром `map_hash`, поэтому маршрут сверяется с
  // путём, а не с сырым URL: со строкой запроса регулярка бы не совпала.
  const roomMatch = parsedUrl.pathname.match(/^\/api\/rooms\/([A-Za-z0-9-]+)$/)
  const roomDiceMatch = req.url?.match(/^\/api\/rooms\/([A-Za-z0-9-]+)\/dice$/)
  if (roomDiceMatch && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return
    try {
      const body = await readBody(req)
      const playerId = String(body.playerId || '')
      if (!canUseHero(user, playerId, roomDiceMatch[1])) return json(res, 403, { error: 'Бросок доступен только владельцу героя' })
      /* Набор костей закрыт и серверный: клиент выбирает из него, но подставить
         произвольную грань не может — общий бросок виден всем и должен быть
         обычной костью, а не выдумкой. */
      const sides = Number(body.sides ?? 20)
      if (!PUBLIC_DIE_SIDES.has(sides)) return json(res, 400, { error: 'Такой кости нет: доступны d4, d6, d8, d10, d12, d20 и d100' })

      const current = getRoom(roomDiceMatch[1])
      if (!current.state) return json(res, 409, { error: 'Комната ещё не готова — повторите бросок через секунду' })
      if (!canAccessRoom(user, current)) return json(res, 403, { error: 'Нет доступа к этой комнате' })
      assertCampaignPlayable(current.state)
      const player = Array.isArray(current.state.players)
        ? current.state.players.find((item) => item.id === playerId)
        : null
      if (!player) return json(res, 404, { error: 'Герой не найден в этой комнате' })

      const rolled = diceService.roll(`1d${sides}`, 'free_roll', playerId, 'public')
      const roll = {
        id: rolled.roll_id,
        kind: 'free',
        sides,
        value: rolled.dice[0],
        playerId,
        playerName: String(player.character || player.name || 'Игрок').slice(0, 80),
        rolledAt: Date.now(),
      }
      const loaded = await eventStore.load(roomDiceMatch[1])
      const committed = await eventStore.commit({
        campaign_id: roomDiceMatch[1],
        expected_state_version: loaded.state_version,
        idempotency_key: `public-die:${roll.id}`,
        command_id: `public-die-${roll.id}`,
        events: [{
          event_type: 'PublicDieRolled',
          actor_id: playerId,
          target_ids: [],
          payload: { roll },
          source_rule_ids: [],
          ruling_id: null,
          visibility: 'public',
        }],
      })
      const projected = persistAuthoritativeProjection(roomDiceMatch[1], committed.state, committed.events, null, { forceProjectorRefresh: true })
      if (!projected) return json(res, 409, { error: 'Не удалось обновить публичную проекцию броска' })
      return json(res, 200, {
        roll,
        ...projected,
        state: viewerStateFor(normalizeCampaignState(projected.state), user, playerId),
      })
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : 'Некорректный бросок' })
    }
  }
  if (roomMatch && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return
    const room = await reconcileCampaignProjection(roomMatch[1])
    if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой комнате' })
    if (!room.state) return json(res, 200, room)
    const actorId = campaignHeroIds(user, roomMatch[1]).map(String).find((id) => room.state.players?.some((player) => String(player.id) === id)) ?? ''
    const presentState = stateWithLivePresence(normalizeCampaignState(room.state), roomMatch[1])
    // Поле недоверенное: это лишь ключ поиска в кэше проекций. Неизвестный или
    // чужой хеш означает «карты у клиента нет» и карта уходит целиком.
    const clientMapHash = String(parsedUrl.searchParams.get('map_hash') ?? '').slice(0, 128)
    const projected = viewerStateFor(presentState, user, actorId)
    return json(res, 200, { ...room, state: compactStateForTransport(projected, clientMapHash).state })
  }
  if (roomMatch && req.method === 'PUT') {
    const user = requireUser(req, res); if (!user) return
    const existingRoom = getRoom(roomMatch[1])
    if (!existingRoom.state) return json(res, 404, { error: 'Кампания не найдена', code: 'CAMPAIGN_NOT_FOUND' })
    if (!canAccessRoom(user, existingRoom)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
    return json(res, 410, {
      error: 'Полная запись room state удалена. Используйте типизированные campaign commands',
      code: 'ROOM_MUTATION_RETIRED',
    })
  }
  if (req.url === '/api/roll' && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return
    try {
      const body = await readBody(req)
      const campaignId = String(body.campaignId ?? body.campaign_id ?? '')
      if (!campaignId || !canUseHero(user, body.playerId, campaignId)) return json(res, 403, { error: 'Бросок доступен только владельцу героя' })
      const room = getRoom(campaignId)
      if (!room.state || !canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
      assertCampaignPlayable(room.state)
      const issued = rollRegistry.issue({
        checkId: body.checkId ?? body.check_id,
        campaignId,
        actorId: body.playerId,
        label: body.label,
        modifier: Math.max(-5, Math.min(12, Number(body.modifier) || 0)),
        difficulty: Math.max(5, Math.min(30, Number(body.difficulty) || 10)),
      })
      return json(res, 200, { roll_id: issued.roll_id, value: issued.kept, modifier: issued.modifier, total: issued.total, difficulty: issued.difficulty, label: issued.label, success: issued.success, ability: issued.ability })
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : 'Некорректная проверка' }) }
  }
  if (req.url?.startsWith('/generated/items/') && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return
    return serveGenerated(req, res)
  }
  if (req.url === '/api/items/generate-image' && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return
    if (exceedsRate(`image:${user.id}`, 10)) return json(res, 429, { error: 'Слишком много запросов генерации изображений' })
    if (!apiKey) return json(res, 503, { error: 'Генератор изображений не настроен' })
    try {
      const body = await readBody(req)
      if (!body.prompt || String(body.prompt).length < 20) return json(res, 400, { error: 'Нужен подробный промпт' })
      return json(res, 200, await generateItemImage(body.prompt, body.aspectRatio === '16:9' ? '16:9' : '1:1'))
    } catch (error) { return json(res, 502, { error: error instanceof Error ? error.message : 'Ошибка генерации' }) }
  }
  if (req.url === '/api/agent-lab/scene-transition' && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return
    try {
      const body = await readBody(req)
      const campaignId = String(body.campaignId || body.campaign_id || '')
      const room = getRoom(campaignId)
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
      if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
      const decision = String(body.decision || '').replace(/\s+/g, ' ').trim().slice(0, 500)
      if (!decision) return json(res, 400, { error: 'Нужно решение группы' })
      const labState = normalizeCampaignState({
        ...room.state,
        scene: { ...room.state.scene, ...(body.scene ?? {}) },
        adventure: { ...room.state.adventure, ...(body.adventure ?? {}) },
        agentInteraction: { id: 'agent-lab', status: 'resolved', resolvedOptionId: 'option-1', options: [{ id: 'option-1', label: decision }] },
      })
      const action = `[РЕШЕНИЕ ГРУППЫ] ${decision}`
      const resolved = resolvePartyDecision(action, labState)
      if (resolved?.type !== 'scene_request') {
        return json(res, 200, { dry_run: true, transition: null, stages: [{ agent: 'AgentDirector', status: 'completed', output: resolved }], narration: resolved?.narration ?? 'Переход сцены не требуется.' })
      }
      const planned = await sceneArchitect.plan({ action, state: labState, decision: resolved.decision, destinationHint: resolved.destinationHint })
      const transition = createSceneTransition(planned.sceneArgs, labState)
      return json(res, 200, {
        dry_run: true,
        transition,
        stages: [
          { agent: 'AgentDirector', status: 'completed', output: { intent: 'advance_scene', decision: resolved.decision, destinationHint: resolved.destinationHint } },
          { agent: 'AgentCartographer', status: 'completed', output: { ...planned.trace, scene: planned.sceneArgs } },
          { agent: 'WorldEngine', status: 'completed', output: { cells: transition.scene.cells.length, width: Math.max(...transition.scene.cells.map((cell) => cell.x)) + 1, height: Math.max(...transition.scene.cells.map((cell) => cell.y)) + 1, entrance: transition.entrance } },
          { agent: 'AgentNarrator', status: 'completed', output: { narration: `${transition.transition} ${transition.arrival}` } },
        ],
      })
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : 'Не удалось выполнить тестовый прогон' }) }
  }
  if (req.url === '/api/narrate' && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return
    try {
      const body = await readBody(req)
      if (Object.hasOwn(body, 'state') || Object.hasOwn(body, 'player')
        || Object.hasOwn(body, 'engine_mode') || Object.hasOwn(body, 'engineMode')
        || Object.hasOwn(body, 'mode')) {
        return json(res, 400, {
          error: 'Legacy payload удалён: состояние, игрок и режим определяются сервером',
          code: 'LEGACY_PAYLOAD_RETIRED',
        })
      }
      if (body.roll && (typeof body.roll !== 'object' || Array.isArray(body.roll)
        || Object.keys(body.roll).some((key) => key !== 'roll_id'))) {
        return json(res, 400, {
          error: 'Разрешена только ссылка на серверный roll_id',
          code: 'UNVERIFIED_ROLL',
        })
      }
      const campaignId = String(body.campaignId || body.campaign_id || '')
      const room = await reconcileCampaignProjection(campaignId)
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
      if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
      assertCampaignPlayable(room.state)
      const trustedState = room.state
      const requestedPlayerId = String(body.actor_id ?? '')
      const playerId = requestedPlayerId || String(trustedState.activePlayerId || '')
      if (!canUseHero(user, playerId, campaignId)) return json(res, 403, { error: 'Этот герой не принадлежит вашему аккаунту' })
      const combatActorId = String(trustedState.mechanics?.combat?.initiative?.[trustedState.mechanics?.combat?.active_index ?? 0]?.actor_id ?? '')
      if (trustedState.mechanics?.combat?.active && combatActorId && playerId !== combatActorId) {
        return json(res, 409, { error: `Сейчас ходит другой участник: ${combatActorId}`, code: 'NOT_ACTIVE_ACTOR' })
      }
      if (trustedState.mechanics?.death?.campaign_status === 'party_defeated') {
        return json(res, 409, { error: 'Все герои погибли. Эта история завершена, продолжать игру в этом мире нельзя', code: 'WORLD_ENDED' })
      }
      if (trustedState.mechanics?.death?.heroes?.[playerId]?.status === 'dead') {
        return json(res, 409, { error: 'Сначала воскресите погибшего героя или замените его новым', code: 'HERO_DEAD_UNRESOLVED' })
      }
      if (exceedsRate(`narrate:${user.id}`, 40)) return json(res, 429, { error: 'Слишком много ходов за короткое время' })
      const mode = 'enforce'
      const idempotencyKey = String(body.idempotencyKey || body.idempotency_key || req.headers['x-idempotency-key'] || randomUUID())
      let verifiedRoll = null
      if (body.roll?.roll_id) {
        verifiedRoll = rollRegistry.consume(body.roll.roll_id, { campaignId, actorId: playerId, idempotencyKey })
      } else if (body.roll && mode === 'enforce') {
        return json(res, 400, { error: 'Enforce-режим принимает только серверный roll_id', code: 'UNVERIFIED_ROLL' })
      }
      const player = trustedState.players?.find((candidate) => String(candidate.id) === playerId)
      const action = String(body.action || '').trim().slice(0, 2_000)
      let directorResolution = null
      let directorReplay = null
      if (mode === 'enforce') {
        const duplicate = await eventStore.getByIdempotencyKey(campaignId, idempotencyKey)
        const duplicateScene = (duplicate?.events ?? []).find((event) => event.event_type === 'SceneAdvanced')
        if (duplicateScene) {
          const fingerprint = directorTransitionFingerprint({ campaignId, action })
          if (duplicateScene.payload?.request_fingerprint !== fingerprint) {
            throw commandPolicyError('Этот ключ идемпотентности уже использован для другого перехода сцены', 'IDEMPOTENCY_CONFLICT')
          }
          directorReplay = {
            duplicate,
            resolution: {
            type: 'scene_request',
            decision: action,
            destinationHint: '',
            partyDecision: resolvedPartyDecisionReference(duplicateScene.payload?.party_decision),
            },
          }
        } else if (trustedState.agentInteraction?.status === 'resolved' && trustedState.agentInteraction?.resolvedOptionId) {
          directorResolution = resolvePartyDecision(action, trustedState)
        } else if (isPartyDecisionAction(action)) {
          if (duplicate) {
            throw commandPolicyError('Этот ключ идемпотентности уже использован для другого игрового действия', 'IDEMPOTENCY_CONFLICT')
          }
          const fingerprint = directorTransitionFingerprint({ campaignId, action })
          const consumed = await committedSceneForFingerprint(campaignId, fingerprint)
          if (consumed) {
            throw commandPolicyError('Это решение группы уже было исполнено переходом сцены', 'PARTY_DECISION_ALREADY_CONSUMED')
          }
          throw commandPolicyError('Нет завершённого решения группы для перехода сцены', 'PARTY_DECISION_REQUIRED')
        }
      }
      const directorInteraction = mode === 'enforce' && !directorResolution && !directorReplay
        ? proposeAgentInteraction(action, trustedState)
        : null

      let result
      const campaignAiSettings = getCampaignAiSettings(campaignId)
      await runWithCampaignAiSettings({
        ...campaignAiSettings,
        model: allowedAiModels.includes(campaignAiSettings.model) ? campaignAiSettings.model : model,
      }, async () => {
        if (directorReplay) {
          result = await replayDirectorSceneTransition({
            campaignId, room, user, action, idempotencyKey,
            duplicate: directorReplay.duplicate,
            resolution: directorReplay.resolution,
          })
        } else if (directorResolution?.type === 'scene_request') {
          result = await executeDirectorSceneTransition({
            campaignId, room, user, action, idempotencyKey, resolution: directorResolution,
          })
        } else if (directorResolution?.type === 'narration') {
          result = {
            narration: directorResolution.narration,
            effects: { roll: null, reveal: [], spawn: [], objective: null, grantItems: [], scene: null, interaction: null },
            provider: 'AgentDirector', model: 'deterministic-policy', engine_mode: mode,
            state_version: trustedState.state_version, turn_consumed: false, action_kind: 'free', mechanics: [],
          }
        } else if (directorInteraction) {
          const effects = { roll: null, reveal: [], spawn: [], objective: null, grantItems: [], scene: null, interaction: null }
          executeTool('request_party_decision', directorInteraction, effects, trustedState)
          result = {
            narration: effects.interaction.description,
            effects,
            provider: 'AgentDirector', model: 'deterministic-policy', engine_mode: mode,
            state_version: trustedState.state_version, turn_consumed: false, action_kind: 'free', mechanics: [],
          }
        } else {
          result = await gameOrchestrator.handle({
            ...body,
            // `/api/narrate` accepts prose only. Structured commands and the
            // unforgeable Director capability are supplied by server branches.
            commands: undefined,
            commandCapability: undefined,
            state: trustedState,
            roomVersion: room.version,
            campaignId,
            playerId,
            playerName: player?.character ?? player?.name ?? body.player,
            message: action,
            idempotencyKey,
            verifiedRoll,
            user,
            allowedActorIds: campaignHeroIds(user, campaignId),
          })
        }
      })
      const interactionProjection = await persistInteractionProjection(campaignId, result.effects?.interaction)
      // Служебные команды (`/why`) — не часть истории отряда: реплику игрока не
      // сохраняем, а ответ подписываем разбором правил, а не Рассказчиком.
      const metaCommand = /^\s*\//u.test(action)
      const journalNarrationId = String(result.narration ?? '').trim() ? narrationMessageId(idempotencyKey) : null
      const narrationEntry = journalNarrationId ? {
        id: journalNarrationId,
        text: result.narration,
        speaker: metaCommand ? 'system' : 'narrator',
        author: metaCommand ? 'Разбор правил' : result.journal_author,
        turnConsumed: result.turn_consumed !== false && !metaCommand,
        roll: result.effects?.roll ?? null,
        stakes: result.stakes ?? null,
      } : null
      const playerEntry = !metaCommand && String(action ?? '').trim() ? {
        id: playerMessageId(idempotencyKey),
        text: action,
        speaker: 'player',
        author: player?.character ?? player?.name ?? 'Герой',
      } : null
      const projected = result.authoritative_state
        ? persistAuthoritativeProjection(campaignId, result.authoritative_state, result.mechanics)
        : null
      // Летопись пишется отдельным шагом и всегда. Раньше она ехала «прицепом»
      // к проекции и терялась дважды: на ходе без изменения состояния и на
      // ходе, чью проекцию уже успел записать кто-то другой (тогда
      // persistAuthoritativeProjection выходит раньше, чем дойдёт до messages).
      const journaled = appendRoomJournal(campaignId, [playerEntry, narrationEntry].filter(Boolean))
      const responsePayload = {
        ...result,
        ...(journalNarrationId ? { narration_message_id: journalNarrationId } : {}),
        ...(result.authoritative_state ? { authoritative_state: journaled?.state ?? projected?.state ?? result.authoritative_state } : {}),
        // Narration can outlive a concurrent room PUT. Returning the snapshot
        // version captured at request start would move the client's optimistic
        // locking cursor backwards and make it lose the completed turn.
        room_version: getRoom(campaignId).version,
      }
      return json(res, 200, turnResultForViewer(responsePayload, user, playerId))
    }
    catch (error) {
      const status = ['STATE_VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'PARTY_DECISION_ALREADY_CONSUMED'].includes(error?.code) ? 409 : error?.code === 'ROLL_ALREADY_USED' || error?.code === 'ROLL_FORBIDDEN' ? 400 : error?.code?.startsWith('LLM_') ? 502 : 400
      return json(res, status, { error: error instanceof Error ? error.message : 'Ошибка игрового оркестратора', code: error?.code })
    }
  }
  if (parsedUrl.pathname.startsWith('/api/')) return json(res, 404, { error: 'API endpoint не найден' })
  return serveStatic(req, res)
  })
})

await reconcileAllCampaignProjections()
server.listen(port, host, () => {
  console.log(`[Сказание] Сервер: http://${host}:${port} · ${apiKey ? `${model} + ${fallbackModels.length} fallback models` : 'демо-режим'}`)
  // После рестарта активной кампании NPC может потребовать заметного CPU ещё до
  // первого await. Сначала даём HTTP принять health-check, затем возобновляем
  // фоновые часы; игровое состояние и durable-дедлайны от этой паузы не меняются.
  const startupJobs = setTimeout(() => {
    for (const campaignId of listRoomCodes()) {
      combatTurnCoordinator.nudge(campaignId)
      nudgeMerchantEconomyClock(campaignId)
    }
  }, 250)
  startupJobs.unref()
})
