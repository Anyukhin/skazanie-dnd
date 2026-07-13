import 'dotenv/config'
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createAdmin, createSession, deleteSession, getRoom, hasAdmin, listRoomCodes, listUsers, registerUser, saveRoom, storageDir, updateUserAccess, userForToken, verifyUser } from './store.mjs'
import { DiceService } from './dice-service.mjs'
import { EngineModeResolver } from './engine-mode.mjs'
import { FileEventStore } from './event-store.mjs'
import { DIRECTOR_COMMAND_CAPABILITY, GameOrchestrator } from './game-orchestrator.mjs'
import { RouterAIClient } from './llm-client.mjs'
import { Narrator } from './narrator.mjs'
import { CreativeDirector } from './creative-director.mjs'
import { NpcControllerAgent } from './npc-controller.mjs'
import { RollRegistry } from './roll-registry.mjs'
import { loadRulePack } from './rule-pack.mjs'
import { createRuleRetriever } from './rule-retriever.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from './rules-engine.mjs'
import { runNpcTurnScheduler } from './npc-turn-scheduler.mjs'
import { buildDataOnlyContext } from './security.mjs'
import { FileTraceStore, buildTurnExplanation } from './trace-store.mjs'
import { createSceneTransition } from './adventure-director.mjs'
import { SceneArchitectAgent } from './scene-architect.mjs'
import { decideTurnConsumption, isExplicitEndTurn } from './turn-policy.mjs'
import { answerKnownLore, proposeAgentInteraction, resolvePartyDecision, roleAllowsWorldTools, selectAgentRole } from './agent-router.mjs'
import { applyHazardEffects, createHazardEffect, createHazardResolution } from './persistent-hazards.mjs'
import { CampaignBootstrapper } from './campaign-bootstrap.mjs'
import { MAX_CURRENCY_CP, merchantIsAtLocation, merchantViewFor, publicMerchantFor } from './merchant-economy.mjs'
import { assembleEncounter } from './encounter-assembler.mjs'
import { assembleShop } from './shop-assembler.mjs'
import { campaignStateForViewer, turnResultForViewer } from './viewer-projection.mjs'
import { isPartySummon } from './combat-spells.mjs'
import {
  assertDirectorTransitionResult,
  buildDirectorTransitionCommands,
  directorTransitionFingerprint,
  resolvedPartyDecisionReference,
} from './director-scene-transition.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'dist')
const port = Number(process.env.AGENT_PORT || 8787)
const host = process.env.AGENT_HOST || '0.0.0.0'
const apiKey = process.env.ROUTERAI_API_KEY || ''
const baseUrl = (process.env.ROUTERAI_BASE_URL || 'https://routerai.ru/api/v1').replace(/\/$/, '')
const model = process.env.DND_AI_MODEL || 'qwen/qwen3.7-plus'
const maxTokens = Number(process.env.DND_AI_MAX_TOKENS || 1200)
const imageModel = process.env.DND_IMAGE_MODEL || 'openai/gpt-image-1'
const generatedDir = join(storageDir, 'generated', 'items')
mkdirSync(generatedDir, { recursive: true })

const diceService = new DiceService()
const rollRegistry = new RollRegistry({ diceService })
const engineModeResolver = new EngineModeResolver()
const llmClient = new RouterAIClient({ apiKey, baseUrl, model, maxTokens })
const sceneArchitect = new SceneArchitectAgent({ llmClient: apiKey ? llmClient : null })
const rulePack = await loadRulePack(process.env.DND_DEFAULT_RULESET_ID || 'srd_5_2_1')
const ruleRetriever = createRuleRetriever([rulePack])
const rulesEngine = new RulesEngine({ diceService })
const eventStore = new FileEventStore({
  rootDir: join(storageDir, 'engine'),
  reducer: applyGameEvent,
  normalizeState: normalizeCampaignState,
})
const traceStore = new FileTraceStore({ rootDir: join(storageDir, 'turn-traces') })
const narrator = new Narrator({ llmClient: apiKey ? llmClient : null })
const creativeDirector = new CreativeDirector({ narrator })
const npcController = new NpcControllerAgent({ llmClient: apiKey ? llmClient : null })
const campaignBootstrapper = new CampaignBootstrapper({ llmClient: apiKey ? llmClient : null })

const tools = [
  {
    type: 'function',
    function: {
      name: 'roll_check',
      description: 'Совершить честную проверку d20, когда исход действия не очевиден.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['label', 'difficulty', 'ability'],
        properties: {
          label: { type: 'string', description: 'Название проверки по-русски' },
          actorId: { type: 'string', description: 'id персонажа; по умолчанию активный герой' },
          ability: { type: 'string', enum: ['str', 'dex', 'con', 'int', 'wis', 'cha'], description: 'Характеристика проверки' },
          proficient: { type: 'boolean', description: 'Добавить бонус мастерства, только если герой владеет подходящим навыком' },
          modifier: { type: 'integer', minimum: -5, maximum: 12, description: 'Запасной модификатор; игнорируется, если характеристика доступна в листе героя' },
          difficulty: { type: 'integer', minimum: 5, maximum: 30 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reveal_area',
      description: 'Открыть область карты после обнаружения нового прохода или помещения.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['x1', 'y1', 'x2', 'y2'],
        properties: { x1: { type: 'integer' }, y1: { type: 'integer' }, x2: { type: 'integer' }, y2: { type: 'integer' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_objective',
      description: 'Изменить текущую цель группы после сюжетного открытия.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['objective'],
        properties: { objective: { type: 'string', minLength: 3, maxLength: 120 } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_entity',
      description: 'Добавить на открытую клетку объект или угрозу, возникшую в сцене.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['x', 'y', 'kind', 'label'],
        properties: {
          x: { type: 'integer' }, y: { type: 'integer' },
          kind: { type: 'string', enum: ['enemy', 'chest', 'altar', 'rune', 'torch', 'stairs'] },
          label: { type: 'string', minLength: 2, maxLength: 80 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grant_item',
      description: 'Выдать конкретному герою новый предмет. Всегда придумай предмету самостоятельное атмосферное описание и полный промпт изображения.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['ownerId', 'name', 'type', 'quantity', 'rarity', 'description', 'properties', 'imagePrompt'],
        properties: {
          ownerId: { type: 'string', description: 'id персонажа из состояния мира' },
          name: { type: 'string', minLength: 2, maxLength: 80 },
          type: { type: 'string', enum: ['weapon', 'armor', 'consumable', 'tool', 'quest', 'treasure', 'document', 'other'] },
          quantity: { type: 'integer', minimum: 1, maximum: 99 },
          rarity: { type: 'string', enum: ['обычный', 'необычный', 'редкий', 'очень редкий', 'легендарный', 'сюжетный'] },
          description: { type: 'string', minLength: 20, maxLength: 700 },
          properties: { type: 'string', minLength: 3, maxLength: 400 },
          imagePrompt: { type: 'string', minLength: 30, maxLength: 1200, description: 'Полный визуальный промпт без текста и водяных знаков' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_hazard',
      description: 'Записать длительное опасное состояние среды, которое должно сохраняться между ходами: персонаж тонет, горит, зажат, отравлен средой или удерживается препятствием. Вызывай до того, как описать такую опасность.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['targetId', 'id', 'label', 'source', 'description', 'severity', 'escapeAbility', 'escapeDifficulty', 'endCondition'],
        properties: {
          targetId: { type: 'string', minLength: 1, maxLength: 80 },
          id: { type: 'string', minLength: 2, maxLength: 60 },
          label: { type: 'string', minLength: 2, maxLength: 100 },
          source: { type: 'string', minLength: 2, maxLength: 160 },
          description: { type: 'string', minLength: 3, maxLength: 360 },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          requiresCheck: { type: 'boolean' },
          escapeAbility: { type: 'string', enum: ['str', 'dex', 'con', 'int', 'wis', 'cha'] },
          escapeDifficulty: { type: 'integer', minimum: 5, maximum: 30 },
          endCondition: { type: 'string', minLength: 3, maxLength: 240 },
          ruleId: { type: 'string', maxLength: 120 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resolve_hazard',
      description: 'Снять активное опасное состояние только после выполнения его условия окончания. Если состояние требует проверку, сервер разрешит снятие лишь при подходящей успешной проверке с закреплённой характеристикой и достаточной СЛ.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['targetId', 'id', 'resolution'],
        properties: {
          targetId: { type: 'string', minLength: 1, maxLength: 80 },
          id: { type: 'string', minLength: 2, maxLength: 60 },
          resolution: { type: 'string', minLength: 3, maxLength: 240 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_party_decision',
      description: 'Открыть для игроков интерактивное решение: голосование, общий бросок судьбы или выбор из вариантов. Используй перед необратимым групповым решением, когда одного ответа активного героя недостаточно.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['type', 'title', 'description', 'options', 'resolutionPrompt'],
        properties: {
          type: { type: 'string', enum: ['vote', 'roll', 'choice'] },
          title: { type: 'string', minLength: 3, maxLength: 100 },
          description: { type: 'string', minLength: 10, maxLength: 360 },
          options: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string', minLength: 2, maxLength: 100 } },
          difficulty: { type: 'integer', minimum: 5, maximum: 25, description: 'Только для type=roll: сложность общего броска d20' },
          resolutionPrompt: { type: 'string', minLength: 10, maxLength: 360, description: 'Как рассказчик должен продолжить историю после решения' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'advance_scene',
      description: 'Бесшовно завершить текущую сцену и сразу открыть следующую локацию. Используй, когда цель сцены достигнута, конфликт исчерпан или герои явно уходят дальше. Не объявляй конец локации без этого инструмента.',
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['title', 'location', 'mood', 'objective', 'transition', 'arrival', 'hook', 'theme', 'danger', 'outcome', 'suggestions'],
        properties: {
          title: { type: 'string', minLength: 2, maxLength: 80 },
          location: { type: 'string', minLength: 2, maxLength: 120 },
          mood: { type: 'string', minLength: 3, maxLength: 160 },
          objective: { type: 'string', minLength: 3, maxLength: 160 },
          transition: { type: 'string', minLength: 10, maxLength: 500, description: 'Как герои физически добираются из текущей сцены в новую' },
          arrival: { type: 'string', minLength: 10, maxLength: 500, description: 'Первое чувственное описание новой локации' },
          hook: { type: 'string', minLength: 3, maxLength: 240, description: 'Связь новой сцены с незавершёнными нитями кампании' },
          theme: { type: 'string', minLength: 2, maxLength: 80 },
          danger: { type: 'string', enum: ['низкая', 'средняя', 'высокая'] },
          outcome: { type: 'string', minLength: 3, maxLength: 240, description: 'Что именно завершилось в прежней сцене' },
          completed_objective: { type: 'string', maxLength: 160 },
          objective_status: { type: 'string', enum: ['completed', 'unresolved', 'abandoned'] },
          carry_unresolved: { type: 'boolean' },
          map: {
            type: 'object', additionalProperties: false,
            properties: {
              layout: { type: 'string', enum: ['rooms', 'streets', 'open', 'winding', 'cavern', 'ruins', 'radial'] },
              width: { type: 'integer', minimum: 7, maximum: 25 },
              height: { type: 'integer', minimum: 7, maximum: 19 },
              openness: { type: 'number', minimum: 0.35, maximum: 0.85 },
              water: { type: 'number', minimum: 0, maximum: 0.3 },
              featureCount: { type: 'integer', minimum: 2, maximum: 12 },
            },
          },
          seed: { type: 'string', maxLength: 120 },
          suggestions: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string', minLength: 2, maxLength: 100 } },
        },
      },
    },
  },
]

const legacyRolePrompt = readFileSync(fileURLToPath(new URL('../prompts/legacy/v1.txt', import.meta.url)), 'utf8')
const worldkeeperRolePrompt = readFileSync(fileURLToPath(new URL('../prompts/worldkeeper/v1.txt', import.meta.url)), 'utf8')
const directorRolePrompt = readFileSync(fileURLToPath(new URL('../prompts/director/v1.txt', import.meta.url)), 'utf8')
const gameMasterRolePrompt = readFileSync(fileURLToPath(new URL('../prompts/game_master/v1.txt', import.meta.url)), 'utf8')
const systemPrompt = `${legacyRolePrompt}

Ты — Рассказчик русскоязычной кооперативной фэнтези-RPG «Сказание».
Правдоподобно отыгрывай ЛЮБОЕ разумное действие игрока в контексте мира. Не ограничивай игрока вариантами интерфейса.

Правила:
- Продолжай установленную сцену и не отменяй прошлые последствия.
- Не решай рискованный исход сам: вызови roll_check, затем опиши известный результат.
- Остальные инструменты используй только при реальном изменении состояния мира.
- Если в описании появляется новое физическое существо или объект на карте, сначала обязательно вызови spawn_entity. Не описывай появившуюся угрозу без этого инструмента.
- Если герой получает, находит или подбирает предмет, обязательно вызови grant_item. Описание должно раскрывать вид, материал, историю и заметные детали. imagePrompt должен точно показывать только этот предмет; для карты проси вид сверху и читаемые маршруты без современного текста.
- Координаты карты: x 0–12, y 0–8. Не раскрывай карту без сюжетной причины.
- ACTIVE_HAZARDS в состоянии — обязательные длительные факты. Не игнорируй их и не объявляй снятыми обычной репликой игрока.
- Если герой пытается устранить hazard с requiresCheck=true, сначала вызови roll_check с указанными escapeAbility и escapeDifficulty. После подтверждённого успеха вызови resolve_hazard; при провале состояние остаётся.
- Не управляй персонажем игрока и не приписывай ему решения.
- Пиши выразительно и конкретно, 2–5 предложений.
- После инструментов верни ТОЛЬКО JSON: {"narration":"...","suggestions":["...","..."],"action_kind":"free|minor|substantive|end_turn","turn_consumed":false}.
- Suggestions — идеи, а не ограничения.`

const checkPrompt = `${systemPrompt}

Сейчас ты оцениваешь намерение ДО броска. Если исход рискованный или неопределённый, вызови roll_check и не описывай результат действия. Не меняй мир другими инструментами до броска. Если проверка не нужна, сразу опиши естественное последствие.`

function roleSystemPrompt(role, suppliedRoll) {
  const specialized = role === 'worldkeeper' ? worldkeeperRolePrompt : role === 'game_master' ? gameMasterRolePrompt : directorRolePrompt
  return `${suppliedRoll ? systemPrompt : checkPrompt}\n\n${specialized}`
}

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

function canUseHero(user, heroId) {
  return user?.role === 'admin' || user?.heroIds?.includes(String(heroId || ''))
}

const PLAYER_COMBAT_COMMANDS = new Set(['StartCombat', 'MoveActor', 'MakeAttack', 'MakeAreaAttack', 'ChangeWeapon', 'CastSpell', 'UseCombatAction', 'EndTurn'])
const PLAYER_MERCHANT_COMMANDS = new Set(['BargainWithMerchant', 'AppraiseItem', 'BuyItem', 'SellItem'])
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
  }
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex')
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
    allowedActorIds: admin.heroIds,
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
  const controlsActor = canUseHero(user, actor) || (isPartySummon(combatActor) && canUseHero(user, controller))
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
    return { ...base, target_id: target, ...(input?.item_id ? { item_id: String(input.item_id) } : {}) }
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
  return base
}

function sanitizeMerchantCommand(user, state, input, routeMerchantId = null) {
  const type = commandType(input)
  if (!PLAYER_MERCHANT_COMMANDS.has(type)) throw commandPolicyError('Для торговца доступна только оценка, покупка, продажа или попытка договориться о цене', 'PLAYER_COMMAND_FORBIDDEN')
  const actor = String(input?.actor_id ?? input?.actorId ?? '')
  if (!actor || !canUseHero(user, actor)) throw commandPolicyError('Торговать можно только от имени своего героя', 'ACTOR_FORBIDDEN')
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
  return { ...base, request_fingerprint: merchantCommandFingerprint(base) }
}

function tacticalActorName(state, id) {
  const expected = String(id || '')
  const actor = [...(state?.players ?? []), ...(state?.enemies ?? []), ...(state?.actors ?? [])]
    .find((candidate) => String(candidate.id ?? candidate.actor_id ?? '') === expected)
  return String(actor?.character || actor?.name || expected || 'Участник')
}

function tacticalNarration(events, state) {
  const meaningful = []
  const turns = []
  for (const event of events ?? []) {
    const payload = event.payload ?? {}
    const actor = tacticalActorName(state, event.actor_id)
    const targetId = event.target_ids?.[0] ?? payload.target_id
    const target = tacticalActorName(state, targetId)
    if (event.event_type === 'EncounterCreated') {
      const names = (payload.encounter?.enemies ?? []).map((enemy) => String(enemy?.name ?? '')).filter(Boolean).slice(0, 12)
      meaningful.push(`На поле появляются противники: ${names.join(', ')}.`)
    } else if (event.event_type === 'EncounterEnded') {
      meaningful.push(`Столкновение завершено: ${String(payload.reason ?? payload.outcome ?? 'resolved')}.`)
    } else if (event.event_type === 'CombatStarted') {
      meaningful.push(`Бой начался, инициатива определена для ${(event.target_ids ?? []).length} участников.`)
    } else if (event.event_type === 'ActorMoved') {
      meaningful.push(`${actor} перемещается на ${Math.max(0, Number(payload.distance) || 0)} фт.`)
    } else if (event.event_type === 'AttackResolved') {
      meaningful.push(`${actor} атакует ${target}: ${Number(payload.total) || 0} против КД ${Number(payload.armor_class) || 0} — ${payload.hit ? 'попадание' : 'промах'}.`)
    } else if (event.event_type === 'AreaAttackResolved') {
      meaningful.push(`${actor} бросает ${payload.item_name || 'снаряд'} в область радиусом ${Number(payload.radius_feet) || 0} фт.`)
    } else if (event.event_type === 'SpellCast') {
      meaningful.push(`${actor} творит заклинание «${payload.name || payload.spell_id || 'магия'}».`)
    } else if (event.event_type === 'SummonedCreatureCreated') {
      meaningful.push(`${actor} призывает ${payload.summon?.name || 'помощника'}; его ход поставлен сразу после хозяина.`)
    } else if (event.event_type === 'SummonedCreatureDismissed') {
      meaningful.push(`${target} исчезает с поля боя.`)
    } else if (event.event_type === 'EquipmentChanged') {
      meaningful.push(`${actor} экипирует ${payload.item_name || 'оружие'}${payload.turns_spent ? ', затрачивая действие' : ' перед атакой'}.`)
    } else if (event.event_type === 'DamageApplied' && Number(payload.applied_amount) > 0) {
      meaningful.push(`${target} получает ${Number(payload.applied_amount)} урона; ОЗ ${Number(payload.hp_before) || 0} → ${Number(payload.hp_after) || 0}.`)
    } else if (event.event_type === 'HitPointsReducedToZero') {
      meaningful.push(`${target} выбывает из боя.`)
    } else if (event.event_type === 'ConditionAdded' && payload.condition === 'fled') {
      meaningful.push(`${target} отступает и покидает бой.`)
    } else if (event.event_type === 'ConditionAdded' && payload.condition === 'surrendered') {
      meaningful.push(`${target} прекращает сопротивление и сдаётся.`)
    } else if (event.event_type === 'CombatEnded') {
      meaningful.push(`Бой завершён в раунде ${Number(payload.round) || 1}.`)
    } else if (event.event_type === 'TurnEnded') {
      turns.push(`${actor} завершает ход.`)
    } else if (event.event_type === 'TurnStarted') {
      turns.push(`Начинается ход ${target}, раунд ${Number(payload.round) || 1}.`)
    }
  }
  const selected = meaningful.length ? meaningful : turns
  return selected.slice(0, 8).join(' ')
}

function combatMessageId(idempotencyKey) {
  return `combat-${createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 20)}`
}

function merchantMessageId(idempotencyKey) {
  return `merchant-${createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 20)}`
}

function narrationMessageId(idempotencyKey) {
  return `narration-${createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 20)}`
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
  const playerIds = Array.isArray(room?.state?.players) ? room.state.players.map((player) => String(player.id)) : []
  const memberIds = Array.isArray(room?.state?.partyMemberIds) && room.state.partyMemberIds.length
    ? room.state.partyMemberIds.map(String)
    : playerIds
  return (user.heroIds ?? []).some((id) => memberIds.includes(String(id)))
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function mergePartyDecisionVotes(user, currentState, proposedState) {
  const current = currentState.agentInteraction
  if (!current || current.status !== 'open') return current ?? null
  const proposed = proposedState.agentInteraction
  if (!proposed || String(proposed.id) !== String(current.id)) return current
  const optionIds = new Set((current.options ?? []).map((option) => String(option.id)))
  const owned = new Set((user.heroIds ?? []).map(String))
  const votes = { ...(current.votes ?? {}) }
  for (const [heroId, optionId] of Object.entries(proposed.votes ?? {})) {
    if (owned.has(String(heroId)) && optionIds.has(String(optionId))) votes[String(heroId)] = String(optionId)
  }
  const partyMembers = new Set((currentState.partyMemberIds?.length ? currentState.partyMemberIds : (currentState.players ?? []).map((player) => player.id)).map(String))
  const eligible = (currentState.players ?? []).filter((player) => player.online && partyMembers.has(String(player.id))).map((player) => String(player.id))
  const required = current.type === 'choice' ? 1 : Math.floor(Math.max(1, eligible.length) / 2) + 1
  const winner = (current.options ?? []).find((option) => Object.values(votes).filter((vote) => vote === String(option.id)).length >= required)
  return {
    ...current,
    votes,
    status: winner ? 'resolved' : 'open',
    ...(winner ? { resolvedOptionId: winner.id } : {}),
  }
}

function validateRoomUpdate(user, currentRoom, proposed, roomCode) {
  if (!proposed || typeof proposed !== 'object' || Array.isArray(proposed)) throw new Error('Некорректное состояние комнаты')
  if (!Array.isArray(proposed.players) || !Array.isArray(proposed.messages) || !proposed.scene || typeof proposed.scene !== 'object') throw new Error('Неполное состояние комнаты')
  if (String(proposed.sessionCode || '').toUpperCase() !== String(roomCode).toUpperCase()) throw new Error('Код комнаты в состоянии не совпадает с адресом')
  if (!currentRoom.state) {
    if (user.role !== 'admin') throw new Error('Только администратор может создать комнату')
    return normalizeCampaignState(proposed)
  }
  if (!canAccessRoom(user, currentRoom)) throw new Error('Нет доступа к этой комнате')

  const current = currentRoom.state
  const currentIds = Array.isArray(current.players) ? current.players.map((player) => String(player.id)) : []
  const proposedIds = proposed.players.map((player) => String(player.id))
  if (new Set(proposedIds).size !== proposedIds.length || !sameJson([...proposedIds].sort(), [...currentIds].sort())) throw new Error('Состав героев нельзя менять через синхронизацию комнаты')
  if (String(proposed.campaign || '') !== String(current.campaign || '') && user.role !== 'admin') throw new Error('Название кампании меняет только администратор')
  if (proposed.engine_mode !== current.engine_mode && user.role !== 'admin') throw new Error('Режим движка меняет только администратор')

  const players = proposed.players.map((player) => {
    const existing = current.players.find((candidate) => String(candidate.id) === String(player.id))
    if (!canUseHero(user, player.id)) return existing
    if (user.role !== 'admin' && current.engine_mode === 'enforce') {
      return {
        ...player,
        hp: existing.hp,
        maxHp: existing.maxHp,
        armor: existing.armor,
        abilities: existing.abilities,
        skills: existing.skills,
        skillModifiers: existing.skillModifiers,
        skillBonuses: existing.skillBonuses,
        persuasionModifier: existing.persuasionModifier,
        persuasionBonus: existing.persuasionBonus,
        proficiency: existing.proficiency,
        inventory: existing.inventory,
        currency: existing.currency,
      }
    }
    return player
  })
  if (user.role === 'admin') return normalizeCampaignState({ ...proposed, players })

  const ownsTurn = canUseHero(user, current.activePlayerId)
  const agentInteraction = mergePartyDecisionVotes(user, current, proposed)
  if (!ownsTurn) return normalizeCampaignState({ ...current, players, agentInteraction })
  proposed.partyName = current.partyName
  proposed.partyMemberIds = current.partyMemberIds
  if (!proposedIds.includes(String(proposed.activePlayerId || ''))) throw new Error('Активный герой не найден')
  const oldMessages = Array.isArray(current.messages) ? current.messages : []
  if (proposed.messages.length < oldMessages.length || proposed.messages.length - oldMessages.length > 3 || !oldMessages.every((message, index) => sameJson(message, proposed.messages[index]))) {
    throw new Error('Журнал можно только дополнять текущим ходом')
  }
  if (!Array.isArray(proposed.scene.cells) || proposed.scene.cells.length > 500) throw new Error('Некорректная карта сцены')
  const currentStateVersion = Number(current.state_version ?? 0)
  const proposedStateVersion = Number(proposed.state_version ?? currentStateVersion)
  if (!Number.isSafeInteger(proposedStateVersion) || proposedStateVersion < currentStateVersion) throw new Error('Версия механического состояния устарела')
  const mechanics = { ...(proposed.mechanics ?? {}), hazards: structuredClone(current.mechanics?.hazards ?? {}) }
  return normalizeCampaignState({ ...proposed, players, merchants: current.merchants, economyLog: current.economyLog, agentInteraction, mechanics })
}

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

function safeArgs(call) {
  try { return JSON.parse(call.function?.arguments || '{}') } catch { return {} }
}

function executeTool(name, args, effects, state = {}) {
  if (name === 'roll_check') {
    const ability = ['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(args.ability) ? args.ability : null
    const actorId = String(args.actorId || state.activePlayerId || '')
    const actor = [...(state.players ?? []), ...(state.actors ?? [])].find((candidate) => String(candidate.id) === actorId)
    const score = ability ? Number(actor?.abilities?.[ability]) : NaN
    const abilityModifier = Number.isFinite(score) ? Math.floor((score - 10) / 2) : Math.max(-5, Math.min(12, Number(args.modifier) || 0))
    const proficiency = args.proficient && actor ? Math.max(0, Number(actor.proficiency) || 0) : 0
    const modifier = Math.max(-5, Math.min(12, abilityModifier + proficiency))
    const difficulty = Math.max(5, Math.min(30, Number(args.difficulty) || 10))
    const result = diceService.rollCheck({ modifier, difficulty, purpose: String(args.label || 'Проверка') })
    effects.roll = { roll_id: result.roll_id, value: result.kept, modifier, total: result.total, difficulty, label: String(args.label || 'Проверка'), success: result.success, ability, actor_id: actorId }
    return effects.roll
  }
  if (name === 'reveal_area') {
    const x1 = Math.max(0, Math.min(12, Math.min(Number(args.x1), Number(args.x2))))
    const x2 = Math.max(0, Math.min(12, Math.max(Number(args.x1), Number(args.x2))))
    const y1 = Math.max(0, Math.min(8, Math.min(Number(args.y1), Number(args.y2))))
    const y2 = Math.max(0, Math.min(8, Math.max(Number(args.y1), Number(args.y2))))
    const cells = []
    for (let y = y1; y <= y2; y += 1) for (let x = x1; x <= x2; x += 1) cells.push({ x, y })
    effects.reveal.push(...cells.slice(0, 40))
    return { revealed: cells.length }
  }
  if (name === 'update_objective') {
    effects.objective = String(args.objective || '').slice(0, 120)
    return { objective: effects.objective }
  }
  if (name === 'spawn_entity') {
    const entity = {
      x: Math.max(0, Math.min(12, Number(args.x) || 0)),
      y: Math.max(0, Math.min(8, Number(args.y) || 0)),
      kind: ['enemy', 'chest', 'altar', 'rune', 'torch', 'stairs'].includes(args.kind) ? args.kind : 'enemy',
      label: String(args.label || 'Неизвестная сущность').slice(0, 80),
    }
    effects.spawn.push(entity)
    return entity
  }
  if (name === 'grant_item') {
    const item = {
      id: randomUUID(), ownerId: String(args.ownerId || ''), name: String(args.name || 'Неизвестный предмет').slice(0, 80),
      type: ['weapon', 'armor', 'consumable', 'tool', 'quest', 'treasure', 'document', 'other'].includes(args.type) ? args.type : 'other',
      quantity: Math.max(1, Math.min(99, Number(args.quantity) || 1)), weight: 0, equipped: false,
      rarity: ['обычный', 'необычный', 'редкий', 'очень редкий', 'легендарный', 'сюжетный'].includes(args.rarity) ? args.rarity : 'обычный',
      description: String(args.description || '').slice(0, 700), properties: String(args.properties || '').slice(0, 400),
      image: '', imagePrompt: String(args.imagePrompt || '').slice(0, 1200), imageStatus: 'queued',
    }
    effects.grantItems.push(item)
    return { granted: true, itemId: item.id, ownerId: item.ownerId, imageStatus: 'queued' }
  }
  if (name === 'apply_hazard') {
    const effect = createHazardEffect(args, state)
    if (effect.error) return effect
    ;(effects.hazards ??= []).push(effect)
    return { applied: true, targetId: effect.targetId, hazard: effect.hazard }
  }
  if (name === 'resolve_hazard') {
    const effect = createHazardResolution(args, state, effects.roll)
    if (effect.error) return effect
    ;(effects.hazards ??= []).push(effect)
    return { resolved: true, targetId: effect.targetId, hazardId: effect.hazard.id, roll_id: effect.roll_id }
  }
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

function parseFinal(content) {
  const clean = String(content || '').replace(/```json|```/gi, '').trim()
  try {
    const start = clean.indexOf('{')
    const end = clean.lastIndexOf('}')
    const parsed = JSON.parse(start >= 0 && end > start ? clean.slice(start, end + 1) : clean)
    return {
      narration: String(parsed.narration || ''),
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 3).map(String) : [],
      turn_consumed: typeof parsed.turn_consumed === 'boolean' ? parsed.turn_consumed : undefined,
      action_kind: ['free', 'minor', 'substantive', 'end_turn'].includes(parsed.action_kind) ? parsed.action_kind : undefined,
    }
  } catch {
    return { narration: clean || 'Мир на мгновение замирает, ожидая вашего решения.', suggestions: [] }
  }
}

function validateNarration(result, roll) {
  const text = String(result.narration || '').trim()
  const looksLikeModelLeak = /\bi(?:'m| am) (?:claude|an ai)|system message|system prompt|injection attack|conflicting directives|should i proceed|core values/i.test(text)
  if (text.length >= 20 && !looksLikeModelLeak) return result
  if (!roll) return { ...result, narration: 'Рассказчик на миг умолкает. Мир остаётся прежним, и вы можете действовать дальше.' }
  return {
    ...result,
    narration: roll.success
      ? `Замысел удаётся. Проверка «${roll.label}» открывает безопасный путь вперёд, и герой успевает воспользоваться преимуществом.`
      : `В последний момент что-то идёт не так. Проверка «${roll.label}» оборачивается осложнением: действие не достигает цели, а обстановка становится опаснее.`,
  }
}

async function callRouter(messages, availableTools = tools) {
  const result = await llmClient.complete({ messages, tools: availableTools, toolChoice: 'auto', temperature: 0.75, maxTokens })
  return { role: 'assistant', content: result.content, tool_calls: result.tool_calls.map((call) => ({ id: call.id, type: call.type, function: call.function })) }
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

async function narrate(body) {
  const state = body.state || {}
  const recent = Array.isArray(state.messages) ? state.messages.slice(-10).map((message) => `${message.author}: ${message.text}`).join('\n') : ''
  const world = {
    scene: state.scene?.title, location: state.scene?.location, objective: state.scene?.objective, turn: state.scene?.turn,
    mood: state.scene?.mood,
    adventure: state.adventure ? { chapter: state.adventure.chapter, currentHook: state.adventure.currentHook, visitedLocations: state.adventure.visitedLocations, recentHistory: state.adventure.history?.slice(-5) } : null,
    agentInteraction: state.agentInteraction ?? null,
    merchants: Array.isArray(state.merchants) ? state.merchants.filter((merchant) => merchant.available !== false).map((merchant) => ({ id: merchant.id, name: merchant.name, location: merchant.location })).slice(0, 30) : [],
    recentEconomy: Array.isArray(state.economyLog) ? state.economyLog.slice(-10) : [],
    activePlayer: body.player,
    party: Array.isArray(state.players) ? state.players.map((player) => ({ id: player.id, character: player.character, role: player.role, hp: `${player.hp}/${player.maxHp}`, x: player.x, y: player.y, inventory: Array.isArray(player.inventory) ? player.inventory.map((item) => item.name).slice(0, 20) : [], conditions: state.mechanics?.conditions?.[player.id] ?? [], activeHazards: state.mechanics?.hazards?.[player.id] ?? [] })) : [],
    revealedSpecials: Array.isArray(state.scene?.cells) ? state.scene.cells.filter((cell) => cell.revealed && cell.feature).map((cell) => ({ x: cell.x, y: cell.y, feature: cell.feature })) : [],
  }
  const rawRoll = body.verifiedRoll ?? body.roll
  const rawValue = rawRoll?.kept ?? rawRoll?.dice?.[0] ?? rawRoll?.value
  const suppliedRoll = rawRoll && Number.isFinite(Number(rawValue)) ? (() => {
    const value = Math.max(1, Math.min(20, Number(rawValue)))
    const modifier = Math.max(-5, Math.min(12, Number(rawRoll.modifier) || 0))
    const difficulty = Math.max(5, Math.min(30, Number(rawRoll.difficulty) || 10))
    return {
      roll_id: rawRoll.roll_id ?? null,
      value,
      modifier,
      difficulty,
      total: value + modifier,
      label: String(rawRoll.label || rawRoll.purpose || 'Проверка'),
      ability: rawRoll.ability ?? null,
      success: value + modifier >= difficulty,
    }
  })() : null
  const phaseInstruction = suppliedRoll
    ? `\n\nБРОСОК УЖЕ СОВЕРШЁН И НЕ МОЖЕТ БЫТЬ ИЗМЕНЁН:\n${JSON.stringify(suppliedRoll)}\nОпиши конкретное последствие с учётом успеха или неудачи. Не запрашивай новый бросок.`
    : ''
  const agentRole = selectAgentRole(body.action)
  const retrievedRules = (body.retrievedRules?.results ?? []).slice(0, 8).map((rule) => ({ rule_id: rule.rule_id, title: rule.title, summary: rule.summary ?? rule.text }))
  const messages = [
    { role: 'system', content: roleSystemPrompt(agentRole, suppliedRoll) },
    { role: 'user', content: `${buildDataOnlyContext({ agent_role: agentRole, world_state: world, recent_events: recent, player_action: String(body.action || '').slice(0, 2000), retrieved_rules: retrievedRules, verified_roll: suppliedRoll })}${phaseInstruction}` },
  ]
  const effects = { roll: suppliedRoll, reveal: [], spawn: [], objective: null, grantItems: [], scene: null, interaction: null }
  const availableTools = !roleAllowsWorldTools(agentRole) ? [] : suppliedRoll ? tools.filter((tool) => tool.function.name !== 'roll_check') : tools
  for (let step = 0; step < 4; step += 1) {
    const assistant = await callRouter(messages, availableTools)
    if (!assistant) throw new Error('RouterAI не вернул сообщение')
    messages.push(assistant)
    if (!assistant.tool_calls?.length) {
      const final = validateNarration(parseFinal(assistant.content), suppliedRoll)
      if (effects.scene && !final.narration.toLocaleLowerCase('ru').includes(effects.scene.scene.location.toLocaleLowerCase('ru'))) {
        final.narration = `${effects.scene.transition} ${effects.scene.arrival} ${final.narration}`.trim()
      }
      if (effects.scene && !final.suggestions.length) final.suggestions = effects.scene.suggestions
      return { ...final, effects, provider: 'RouterAI', model }
    }
    for (const call of assistant.tool_calls) {
      if (!suppliedRoll && call.function?.name === 'roll_check') {
        const args = safeArgs(call)
        const ability = ['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(args.ability) ? args.ability : null
        const actorId = String(args.actorId || state.activePlayerId || '')
        const actor = [...(state.players ?? []), ...(state.actors ?? [])].find((candidate) => String(candidate.id) === actorId)
        const score = ability ? Number(actor?.abilities?.[ability]) : NaN
        const abilityModifier = Number.isFinite(score) ? Math.floor((score - 10) / 2) : Math.max(-5, Math.min(12, Number(args.modifier) || 0))
        const proficiency = args.proficient && actor ? Math.max(0, Number(actor.proficiency) || 0) : 0
        const check = {
          label: String(args.label || 'Проверка навыка').slice(0, 80),
          modifier: Math.max(-5, Math.min(12, abilityModifier + proficiency)),
          difficulty: Math.max(5, Math.min(30, Number(args.difficulty) || 10)),
          ability, actorId,
          sides: 20,
        }
        return {
          narration: `Чтобы узнать, чем закончится это действие, нужна проверка «${check.label}». Брось d20.`,
          suggestions: [], check, effects, provider: 'RouterAI', model,
        }
      }
      const toolName = call.function?.name
      const result = executeTool(toolName, safeArgs(call), effects, state)
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) })
      // These tools already contain all player-facing copy needed for the next
      // UI state. Returning immediately avoids a second provider round-trip and
      // keeps a vote or location transition comfortably inside the browser timeout.
      if (toolName === 'request_party_decision' && effects.interaction) {
        return {
          narration: effects.interaction.description,
          suggestions: [],
          turn_consumed: false,
          action_kind: 'free',
          effects,
          provider: 'RouterAI',
          model,
        }
      }
      if (toolName === 'advance_scene' && effects.scene) {
        return {
          narration: `${effects.scene.transition} ${effects.scene.arrival}`.trim(),
          suggestions: effects.scene.suggestions,
          turn_consumed: true,
          action_kind: 'substantive',
          effects,
          provider: 'RouterAI',
          model,
        }
      }
    }
  }
  return { narration: 'События развиваются слишком стремительно. Уточните ваше действие.', suggestions: [], effects, provider: 'RouterAI', model }
}

async function legacyTurnHandler(input) {
  const partyResolution = resolvePartyDecision(input.message, input.state)
  if (partyResolution) {
    const effects = { roll: null, reveal: [], spawn: [], objective: null, grantItems: [], scene: null, interaction: null }
    if (partyResolution.type === 'scene_request') {
      const planned = await sceneArchitect.plan({ action: input.message, state: input.state, decision: partyResolution.decision, destinationHint: partyResolution.destinationHint })
      executeTool('advance_scene', planned.sceneArgs, effects, input.state)
      return {
        narration: effects.scene.transition + '\n\n' + effects.scene.arrival,
        suggestions: effects.scene.suggestions, effects, provider: 'AgentDirector', model: planned.trace.mode,
        agent_trace: [{ agent: 'AgentDirector', output: partyResolution }, planned.trace, { agent: 'WorldEngine', output: { cells: effects.scene.scene.cells.length, entrance: effects.scene.entrance } }],
        turn_consumed: true, action_kind: 'world',
      }
    }
    return { narration: partyResolution.narration, suggestions: partyResolution.suggestions, effects, provider: 'AgentDirector', model: 'deterministic-policy', turn_consumed: false, action_kind: 'free' }
  }

  const loreAnswer = answerKnownLore(input.message, input.state)
  if (loreAnswer) return loreAnswer

  const interactionProposal = proposeAgentInteraction(input.message, input.state)
  if (interactionProposal) {
    const effects = { roll: null, reveal: [], spawn: [], objective: null, grantItems: [], scene: null, interaction: null }
    executeTool('request_party_decision', interactionProposal, effects, input.state)
    return {
      narration: effects.interaction.description,
      suggestions: [],
      effects,
      provider: 'AgentDirector',
      model: 'deterministic-policy',
      turn_consumed: false,
      action_kind: 'free',
    }
  }
  if (isExplicitEndTurn(input.message)) {
    const hero = String(input.playerName ?? input.player ?? 'Герой').slice(0, 80)
    return {
      narration: `${hero} завершает свои действия и передаёт инициативу следующему герою.`,
      suggestions: [],
      effects: { roll: null, reveal: [], spawn: [], objective: null, grantItems: [], scene: null },
      provider: 'RulesEngine',
      model: 'deterministic',
      turn_consumed: true,
      action_kind: 'end_turn',
    }
  }
  const result = await narrate({
    ...input,
    state: input.state,
    action: input.message,
    player: input.playerName ?? input.player,
    verifiedRoll: input.verifiedRoll,
    roll: input.verifiedRoll ?? input.roll,
  })
  if (result.check) {
    const registered = rollRegistry.registerCheck({
      campaignId: input.campaignId ?? input.state?.sessionCode,
      actorId: input.playerId ?? input.state?.activePlayerId,
      label: result.check.label,
      modifier: result.check.modifier,
      difficulty: result.check.difficulty,
      ability: result.check.ability,
    })
    result.check = { ...result.check, check_id: registered.check_id }
  }
  result.turn_consumed = decideTurnConsumption({
    state: input.state,
    action: input.message,
    result,
    rollResolved: Boolean(input.verifiedRoll ?? input.roll),
  })
  return result
}

const gameOrchestrator = new GameOrchestrator({
  modeResolver: engineModeResolver,
  ruleRetriever,
  rulesEngine,
  eventStore,
  traceStore,
  narrator,
  legacyHandler: legacyTurnHandler,
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
  const planningState = normalizeCampaignState({
    ...authoritative,
    // Voting is still a compatibility-room concern. Only the resolved choice
    // is exposed to the planner; scene mechanics continue from event state.
    agentInteraction: room.state.agentInteraction ?? authoritative.agentInteraction ?? null,
  })
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
    allowedActorIds: user.heroIds,
  })
  assertDirectorTransitionResult(result, directorPlan.fingerprint)
  const sceneEvent = (result.mechanics ?? []).find((event) => event.event_type === 'SceneAdvanced')
  const committedTransition = sceneEvent?.payload ? {
    scene: sceneEvent.payload.scene,
    adventure: sceneEvent.payload.adventure,
    transition: sceneEvent.payload.transition,
    arrival: sceneEvent.payload.arrival,
    suggestions: sceneEvent.payload.suggestions ?? [],
    entrance: sceneEvent.payload.entrance,
  } : directorPlan.transition
  const merchantEvent = (result.mechanics ?? []).find((event) => event.event_type === 'MerchantCreated')

  return {
    ...result,
    effects: { ...result.effects, scene: committedTransition },
    suggestions: committedTransition.suggestions ?? result.suggestions ?? [],
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
    allowedActorIds: user.heroIds,
  })
  const sceneEvent = (result.mechanics ?? []).find((event) => event.event_type === 'SceneAdvanced')
  if (!sceneEvent?.payload) throw commandPolicyError('Повтор перехода не содержит SceneAdvanced', 'IDEMPOTENCY_CONFLICT')
  const committedTransition = {
    scene: sceneEvent.payload.scene,
    adventure: sceneEvent.payload.adventure,
    transition: sceneEvent.payload.transition,
    arrival: sceneEvent.payload.arrival,
    suggestions: sceneEvent.payload.suggestions ?? [],
    entrance: sceneEvent.payload.entrance,
  }
  const commerce = sceneEvent.payload.scene_commerce ?? {}
  const merchantEvent = (result.mechanics ?? []).find((event) => event.event_type === 'MerchantCreated')
  return {
    ...result,
    effects: { ...result.effects, scene: committedTransition },
    suggestions: committedTransition.suggestions ?? result.suggestions ?? [],
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

function merchantClientState(state, actorId) {
  const trusted = normalizeCampaignState(state)
  const location = String(trusted.scene?.location ?? '')
  const publicMerchants = trusted.merchants
    .filter((merchant) => merchant.available !== false && merchantIsAtLocation(merchant.location, location))
    .map(publicMerchantFor)
  const publicPlayers = trusted.players.map((player) => String(player.id) === String(actorId)
    ? player
    : {
      id: player.id,
      name: player.name,
      character: player.character,
      role: player.role,
      color: player.color,
      initials: player.initials,
      portrait: player.portrait,
      portraitPosition: player.portraitPosition,
      hp: player.hp,
      maxHp: player.maxHp,
      armor: player.armor,
      online: player.online,
      x: player.x,
      y: player.y,
    })
  return {
    sessionCode: trusted.sessionCode,
    campaign: trusted.campaign,
    partyName: trusted.partyName,
    partyMemberIds: trusted.partyMemberIds,
    state_version: trusted.state_version,
    ruleset_id: trusted.ruleset_id,
    ruleset_version: trusted.ruleset_version,
    enabled_rule_packs: trusted.enabled_rule_packs,
    enabled_house_rules: trusted.enabled_house_rules,
    engine_mode: trusted.engine_mode,
    activePlayerId: trusted.activePlayerId,
    tacticalTurn: trusted.tacticalTurn,
    players: publicPlayers,
    merchants: publicMerchants,
    economyLog: trusted.economyLog,
  }
}

function persistAuthoritativeProjection(campaignId, engineState, events = [], journalMessage = null) {
  const proposedStateVersion = Number(engineState?.state_version ?? -1)
  if (!Number.isSafeInteger(proposedStateVersion)) return null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const room = getRoom(campaignId)
    if (!room.state) return null
    const currentStateVersion = Number(room.state.state_version ?? 0)
    if (proposedStateVersion <= currentStateVersion) return room
    const eventTypes = new Set(events.map((event) => event.event_type))
    const merchantInventoryChanged = eventTypes.has('MerchantPurchaseCompleted') || eventTypes.has('MerchantSaleCompleted')
    const enginePlayers = new Map((engineState.players ?? []).map((player) => [String(player.id), player]))
    const players = (room.state.players ?? []).map((player) => {
      const authoritative = enginePlayers.get(String(player.id))
      if (!authoritative) return player
      return {
        ...player,
        hp: authoritative.hp,
        ...(eventTypes.has('ItemGranted') || merchantInventoryChanged ? { inventory: authoritative.inventory } : {}),
        ...(merchantInventoryChanged ? { currency: authoritative.currency } : {}),
        ...(eventTypes.has('ActorMoved') || eventTypes.has('SceneAdvanced') ? { x: authoritative.x, y: authoritative.y } : {}),
      }
    })
    const sceneChanged = ['SceneAdvanced', 'AreaRevealed', 'ObjectiveUpdated', 'EntitySpawned'].some((type) => eventTypes.has(type))
    const messages = [...(room.state.messages ?? [])]
    if (journalMessage?.id && journalMessage?.text && !messages.some((message) => String(message.id) === String(journalMessage.id))) {
      messages.push({
        id: String(journalMessage.id),
        speaker: journalMessage.speaker === 'system' ? 'system' : 'narrator',
        author: String(journalMessage.author || (journalMessage.speaker === 'system' ? 'Система боя' : 'Рассказчик')).slice(0, 80),
        timestamp: new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date()),
        text: String(journalMessage.text).slice(0, 2000),
        turnConsumed: Boolean(journalMessage.turnConsumed),
      })
    }
    const next = normalizeCampaignState({
      ...room.state,
      messages,
      players,
      merchants: engineState.merchants ?? room.state.merchants,
      enemies: engineState.enemies,
      actors: engineState.actors ?? room.state.actors,
      mechanics: engineState.mechanics,
      state_version: engineState.state_version,
      ruleset_id: engineState.ruleset_id,
      ruleset_version: engineState.ruleset_version,
      enabled_rule_packs: engineState.enabled_rule_packs,
      enabled_house_rules: engineState.enabled_house_rules,
      ruleset_locked_at: engineState.ruleset_locked_at,
      ...(sceneChanged || engineState.scene ? { scene: engineState.scene, entities: engineState.entities } : {}),
      ...(sceneChanged ? {
        adventure: engineState.adventure,
        suggestions: engineState.suggestions ?? room.state.suggestions,
        agentInteraction: engineState.agentInteraction ?? null,
      } : {}),
      activePlayerId: engineState.activePlayerId ?? room.state.activePlayerId,
      tacticalTurn: engineState.tacticalTurn ?? room.state.tacticalTurn,
      battleLog: engineState.battleLog ?? room.state.battleLog,
      economyLog: engineState.economyLog ?? room.state.economyLog,
      mapFeedback: engineState.mapFeedback ?? room.state.mapFeedback,
      ...(eventTypes.has('RulingRecorded') ? { rulings: engineState.rulings } : {}),
    })
    const saved = saveRoom(campaignId, next, room.version)
    if (!saved.conflict) return saved.room
  }
  const reconciled = getRoom(campaignId)
  return Number(reconciled.state?.state_version ?? -1) >= proposedStateVersion ? reconciled : null
}

function persistHazardProjection(campaignId, effects = []) {
  if (!Array.isArray(effects) || !effects.length) return null
  const room = getRoom(campaignId)
  if (!room.state) return null
  const next = normalizeCampaignState({ ...room.state, mechanics: applyHazardEffects(room.state.mechanics, effects) })
  const saved = saveRoom(campaignId, next, room.version)
  return saved.conflict ? null : saved.room
}

function persistInteractionProjection(campaignId, interaction) {
  if (!interaction || typeof interaction !== 'object' || Array.isArray(interaction)) return null
  const room = getRoom(campaignId)
  if (!room.state) return null
  if (room.state.agentInteraction) {
    return String(room.state.agentInteraction.id) === String(interaction.id) ? room : null
  }
  const next = normalizeCampaignState({ ...room.state, agentInteraction: interaction })
  const saved = saveRoom(campaignId, next, room.version)
  return saved.conflict ? null : saved.room
}

function serveStatic(req, res) {
  if (!existsSync(dist)) return json(res, 404, { error: 'Сначала выполните pnpm build' })
  let requested
  try { requested = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') }
  catch { return json(res, 400, { error: 'Некорректный путь' }) }
  let file = resolve(dist, requested)
  if (!(file === dist || file.startsWith(`${dist}${sep}`)) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html')
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' }
  res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' })
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

const server = createServer(async (req, res) => {
  applySecurityHeaders(res)
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': 'http://127.0.0.1:4173', 'Access-Control-Allow-Headers': 'Content-Type, X-Idempotency-Key', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Credentials': 'true' }); return res.end() }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '') && !originAllowed(req)) return json(res, 403, { error: 'Запрос с другого источника отклонён' })
  if (req.url === '/api/health') return json(res, 200, { configured: Boolean(apiKey), provider: 'RouterAI', model, imageModel, engineMode: engineModeResolver.resolve(), rulesetId: rulePack.manifest.ruleset_id, ruleCount: rulePack.rules.length, tools: tools.map((tool) => tool.function.name) })
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
    const admin = requireAdmin(req, res); if (!admin) return
    try {
      const body = await readBody(req)
      const code = String(body.code || '').toUpperCase()
      if (!/^[A-Z0-9-]{3,24}$/.test(code)) return json(res, 400, { error: 'Код кампании должен содержать 3–24 латинских символа, цифры или дефис' })
      if (getRoom(code).state) return json(res, 409, { error: 'Кампания с таким кодом уже существует' })
      const generatedState = body.bootstrap ? await campaignBootstrapper.create({
        code,
        name: body.name,
        partyName: body.bootstrap.partyName,
        world: body.bootstrap.world,
        players: body.bootstrap.players,
      }) : null
      const state = normalizeCampaignState(generatedState ?? body.state ?? {
        sessionCode: code,
        campaign: String(body.name || 'Новая кампания').slice(0, 120),
        players: [], messages: [], activePlayerId: '', isNarrating: false, pendingCheck: null, suggestions: [],
        scene: { title: 'Начало', location: '', mood: '', objective: '', turn: 0, cells: [] },
      })
      state.sessionCode = code
      state.engine_mode = 'enforce'
      const imported = await eventStore.importLegacySnapshot({ campaign_id: code, legacy_state: state, idempotency_key: `legacy-import:${code}`, ruleset_id: state.ruleset_id, ruleset_version: state.ruleset_version, enabled_rule_packs: state.enabled_rule_packs })
      const room = saveRoom(code, { ...imported.state, engine_mode: 'enforce' }, 0)
      return json(res, 201, room.room)
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : 'Не удалось создать кампанию' }) }
  }

  const explanationMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/turns\/([A-Za-z0-9._-]+)\/explanation$/)
  if (explanationMatch && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return
    const room = getRoom(explanationMatch[1])
    if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
    const trace = explanationMatch[2] === 'latest' ? traceStore.latest(explanationMatch[1]) : traceStore.get(explanationMatch[1], explanationMatch[2])
    const explanation = buildTurnExplanation(trace)
    return explanation ? json(res, 200, explanation) : json(res, 404, { error: 'Трассировка хода не найдена' })
  }

  const engineModeMatch = parsedUrl.pathname.match(/^\/api\/campaigns\/([A-Za-z0-9-]+)\/engine-mode$/)
  if (engineModeMatch && req.method === 'PATCH') {
    const admin = requireAdmin(req, res); if (!admin) return
    try {
      const room = getRoom(engineModeMatch[1])
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
      await readBody(req)
      const mode = 'enforce'
      let nextState = { ...room.state, engine_mode: mode }
      const synchronized = await gameOrchestrator.synchronizeLegacyState(engineModeMatch[1], nextState, `enforce-${room.version}`)
      nextState = { ...synchronized.state, engine_mode: mode }
      const result = saveRoom(engineModeMatch[1], nextState, room.version)
      return json(res, 200, { mode, room: result.room })
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : 'Некорректный режим' }) }
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
      const proposalPreview = assembleEncounter({
        scene: { cells: (authoritative.scene?.cells ?? []).map((cell) => ({
          x: Number(cell.x), y: Number(cell.y), type: String(cell.type ?? 'floor'), revealed: cell.revealed === true,
          ...(cell.feature == null ? {} : { feature: String(cell.feature) }),
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
        allowedActorIds: admin.heroIds,
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
    if (!actor || !canUseHero(user, actor)) return json(res, 403, { error: 'Торговать можно только от имени своего героя', code: 'ACTOR_FORBIDDEN' })
    const state = await latestCampaignState(merchantMatch[1], room.state)
    const view = merchantViewFor(state, routeMerchantId, actor)
    if (!view) return json(res, 404, { error: 'Торговец или герой не найден', code: 'MERCHANT_NOT_FOUND' })
    if (view.merchant.available === false) return json(res, 409, { error: 'Торговец сейчас недоступен', code: 'MERCHANT_UNAVAILABLE' })
    if (!merchantIsAtLocation(view.merchant.location, state.scene?.location)) {
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
        allowedActorIds: user.heroIds,
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
        authoritative_state: responseState ? merchantClientState(responseState, command.actor_id) : responseState,
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
      commands = commands.map((command) => {
        const type = commandType(command)
        if (PLAYER_MERCHANT_COMMANDS.has(type)) return sanitizeMerchantCommand(user, room.state, command)
        if (user.role !== 'admin') return sanitizePlayerCombatCommand(user, room.state, command)
        return PLAYER_COMBAT_COMMANDS.has(type) ? { ...command, server_authoritative: true } : command
      })
      const actor = String(commands[0]?.actor_id || room.state.activePlayerId || '')
      const commandActor = [...(room.state.players ?? []), ...(room.state.actors ?? [])].find((candidate) => String(candidate.id ?? candidate.actor_id) === actor)
      const controller = String(commandActor?.controllerId ?? commandActor?.controller_id ?? commandActor?.ownerId ?? commandActor?.owner_id ?? '')
      if (!canUseHero(user, actor) && !(isPartySummon(commandActor) && canUseHero(user, controller))) return json(res, 403, { error: 'Команда доступна только владельцу героя или его призванного существа', code: 'ACTOR_FORBIDDEN' })
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
      const reactionActorId = String(room.state.mechanics?.combat?.reaction_window?.actor_id ?? '')
      const resolvesReaction = commands.some((command) => commandType(command) === 'UseCombatAction' && String(command.actor_id ?? '') === reactionActorId)
      if (merchantCommands.length) {
        if (exceedsRate(`merchant-command:${user.id}`, 120)) {
          return json(res, 429, { error: 'Слишком много торговых операций. Подождите немного и повторите попытку', code: 'MERCHANT_RATE_LIMITED' })
        }
        if (commands.length !== 1) throw commandPolicyError('Торговая операция должна быть отдельной атомарной командой', 'PLAYER_COMMAND_FORBIDDEN')
        await assertMerchantIdempotency(commandMatch[1], idempotencyKey, merchantCommands[0])
      }
      let result = await gameOrchestrator.handle({ state: room.state, campaignId: commandMatch[1], playerId: actor, message: String(body.message || 'Структурированная команда'), commands, idempotencyKey, user, allowedActorIds: user.heroIds })
      if (merchantCommands.length) assertMerchantResultFingerprint(result, merchantCommands[0])
      if (result.authoritative_state) {
        const originalVersion = Number(result.state_version ?? result.authoritative_state.state_version ?? 0)
        const shouldSettleCombat = [...types].some((type) => PLAYER_COMBAT_COMMANDS.has(type))
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
          viewer: { playerId: actor, partyIds: user.heroIds ?? [], isPartyMember: true, role: user.role },
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
      const responsePayload = { ...result, authoritative_state: merchantCommand && responseState ? merchantClientState(responseState, merchantCommand.actor_id) : responseState, ...(merchantView ? { merchant_view: merchantView } : {}), room_version: projected?.version ?? room.version }
      return json(res, 200, turnResultForViewer(responsePayload, user, actor))
    } catch (error) {
      const status = ['STATE_VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT'].includes(error?.code) ? 409 : ['ACTOR_FORBIDDEN', 'PLAYER_COMMAND_FORBIDDEN'].includes(error?.code) ? 403 : 400
      return json(res, status, { error: error instanceof Error ? error.message : 'Команда отклонена', code: error?.code })
    }
  }

  const roomMatch = req.url?.match(/^\/api\/rooms\/([A-Za-z0-9-]+)$/)
  const roomDiceMatch = req.url?.match(/^\/api\/rooms\/([A-Za-z0-9-]+)\/dice$/)
  if (roomDiceMatch && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return
    try {
      const body = await readBody(req)
      const playerId = String(body.playerId || '')
      if (!canUseHero(user, playerId)) return json(res, 403, { error: 'Бросок доступен только владельцу героя' })
      if (Number(body.sides ?? 20) !== 20) return json(res, 400, { error: 'Сейчас доступен только d20' })

      const current = getRoom(roomDiceMatch[1])
      if (!current.state) return json(res, 409, { error: 'Комната ещё не готова — повторите бросок через секунду' })
      if (!canAccessRoom(user, current)) return json(res, 403, { error: 'Нет доступа к этой комнате' })
      const player = Array.isArray(current.state.players)
        ? current.state.players.find((item) => item.id === playerId)
        : null
      if (!player) return json(res, 404, { error: 'Герой не найден в этой комнате' })

      const rolled = diceService.roll('1d20', 'free_roll', playerId, 'public')
      const roll = {
        id: rolled.roll_id,
        kind: 'free',
        sides: 20,
        value: rolled.dice[0],
        playerId,
        playerName: String(player.character || player.name || 'Игрок').slice(0, 80),
        rolledAt: Date.now(),
      }
      const result = saveRoom(roomDiceMatch[1], { ...current.state, lastDiceRoll: roll }, current.version)
      if (result.conflict) return json(res, 409, { error: 'Кто-то бросил кость одновременно — попробуйте ещё раз' })
      return json(res, 200, { roll, ...result.room })
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : 'Некорректный бросок' })
    }
  }
  if (roomMatch && req.method === 'GET') {
    const user = requireUser(req, res); if (!user) return
    const room = getRoom(roomMatch[1])
    if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой комнате' })
    if (!room.state) return json(res, 200, room)
    const actorId = (user.heroIds ?? []).map(String).find((id) => room.state.players?.some((player) => String(player.id) === id)) ?? ''
    return json(res, 200, { ...room, state: campaignStateForViewer(normalizeCampaignState(room.state), user, actorId) })
  }
  if (roomMatch && req.method === 'PUT') {
    const user = requireUser(req, res); if (!user) return
    try {
      const body = await readBody(req)
      const existingRoom = getRoom(roomMatch[1])
      let nextState = validateRoomUpdate(user, existingRoom, body.state, roomMatch[1])
      const effectiveMode = engineModeResolver.resolve({ user, campaign: existingRoom.state ?? nextState })
      if (effectiveMode === 'enforce' && user.role !== 'admin') {
        const authoritative = await eventStore.load(roomMatch[1])
        const actors = new Map((authoritative.state.players ?? []).map((player) => [String(player.id), player]))
        const presentationFields = ['character', 'name', 'portrait', 'portraitPosition', 'color', 'notes', 'traits', 'ideals', 'bonds', 'flaws', 'backstory', 'online', 'subclass', 'selectedFeatureIds', 'classSkillProficiencies', 'knownSpellIds', 'preparedSpellIds']
        nextState = normalizeCampaignState({
          ...nextState,
          players: nextState.players.map((player) => {
            const actor = actors.get(String(player.id))
            if (!actor) return player
            const presentation = Object.fromEntries(presentationFields
              .filter((field) => Object.hasOwn(player, field))
              .map((field) => [field, player[field]]))
            return { ...actor, ...presentation }
          }),
          enemies: authoritative.state.enemies,
          actors: authoritative.state.actors,
          merchants: authoritative.state.merchants,
          mechanics: authoritative.state.mechanics,
          state_version: authoritative.state_version,
          activePlayerId: authoritative.state.activePlayerId,
          tacticalTurn: authoritative.state.tacticalTurn,
          battleLog: authoritative.state.battleLog,
          economyLog: authoritative.state.economyLog,
          mapFeedback: authoritative.state.mapFeedback,
          ruleset_id: authoritative.state.ruleset_id,
          ruleset_version: authoritative.state.ruleset_version,
          enabled_rule_packs: authoritative.state.enabled_rule_packs,
          enabled_house_rules: authoritative.state.enabled_house_rules,
          ruleset_locked_at: authoritative.state.ruleset_locked_at,
          scene: authoritative.state.scene ?? nextState.scene,
          adventure: authoritative.state.adventure ?? nextState.adventure,
        })
      }
      const result = saveRoom(roomMatch[1], nextState, body.baseVersion)
      return json(res, result.conflict ? 409 : 200, result.room)
    } catch (error) { return json(res, /доступ|администратор|героя|ход/i.test(error?.message || '') ? 403 : 400, { error: error instanceof Error ? error.message : 'Не удалось сохранить комнату' }) }
  }
  if (req.url === '/api/roll' && req.method === 'POST') {
    const user = requireUser(req, res); if (!user) return
    try {
      const body = await readBody(req)
      if (!canUseHero(user, body.playerId)) return json(res, 403, { error: 'Бросок доступен только владельцу героя' })
      const issued = rollRegistry.issue({
        checkId: body.checkId ?? body.check_id,
        campaignId: body.campaignId ?? body.campaign_id ?? '',
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
      const campaignId = String(body.campaignId || body.campaign_id || body.state?.sessionCode || '')
      const room = getRoom(campaignId)
      if (!room.state) return json(res, 404, { error: 'Кампания не найдена' })
      if (!canAccessRoom(user, room)) return json(res, 403, { error: 'Нет доступа к этой кампании' })
      const trustedState = room.state
      const playerId = String(trustedState.activePlayerId || '')
      if (!canUseHero(user, playerId)) return json(res, 403, { error: 'Этот герой не принадлежит вашему аккаунту' })
      if (exceedsRate(`narrate:${user.id}`, 40)) return json(res, 429, { error: 'Слишком много ходов за короткое время' })
      const mode = engineModeResolver.resolve({ user, campaign: trustedState })
      if (!apiKey && mode !== 'enforce') return json(res, 503, { error: 'AI не настроен', code: 'AI_NOT_CONFIGURED' })
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
          suggestions: directorResolution.suggestions ?? [],
          effects: { roll: null, reveal: [], spawn: [], objective: null, grantItems: [], scene: null, interaction: null },
          provider: 'AgentDirector', model: 'deterministic-policy', engine_mode: mode,
          state_version: trustedState.state_version, turn_consumed: false, action_kind: 'free', mechanics: [],
        }
      } else if (directorInteraction) {
        const effects = { roll: null, reveal: [], spawn: [], objective: null, grantItems: [], scene: null, interaction: null }
        executeTool('request_party_decision', directorInteraction, effects, trustedState)
        result = {
          narration: effects.interaction.description,
          suggestions: [], effects,
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
          allowedActorIds: user.heroIds,
        })
      }
      const interactionProjection = persistInteractionProjection(campaignId, result.effects?.interaction)
      const hazardProjection = persistHazardProjection(campaignId, result.effects?.hazards)
      const journalNarrationId = result.authoritative_state && String(result.narration ?? '').trim()
        ? narrationMessageId(idempotencyKey)
        : null
      const projected = result.authoritative_state ? persistAuthoritativeProjection(
        campaignId,
        result.authoritative_state,
        result.mechanics,
        journalNarrationId ? { id: journalNarrationId, text: result.narration, turnConsumed: result.turn_consumed !== false } : null,
      ) : null
      const responsePayload = {
        ...result,
        ...(journalNarrationId ? { narration_message_id: journalNarrationId } : {}),
        ...(result.authoritative_state ? { authoritative_state: projected?.state ?? result.authoritative_state } : {}),
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

server.listen(port, host, () => console.log(`[Сказание] Сервер: http://${host}:${port} · ${apiKey ? `${model} подключён` : 'демо-режим'}`))
