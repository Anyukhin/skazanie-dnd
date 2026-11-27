import '../../../fixtures-env.mjs'
// Эталоны задачи О1 (`sk-orchestrator`): `server/autonomous-orchestrator.mjs`.
//
//   node rust/crates/sk-orchestrator/fixtures/gen-o1.mjs [каталог корпуса]
//
// Источники случаев:
// 1. «тесты» — вызовы методов оркестратора и его чистых экспортов, записанные
//    при прогоне тестов JS (`capture-o1.mjs`): состояние журнала на входе,
//    аргументы и ответы внедрённых ролей; вызов переигрывается здесь на чистом
//    журнале с теми же ответами;
// 2. «корпус» — состояния `tmp/corpus-v1`: свободные действия (без судьи, с
//    судьёй на записывающей заглушке модели), шаги Режиссёра, автобой и
//    завершение встречи;
// 3. «миры» — авторские кампании (Асстохан со сценарием в обоих режимах
//    импровизации, Лига девяти приливов, придуманный мир): цикл «Режиссёр →
//    намерение → бой → итог встречи» с моделью-заглушкой (верные решения,
//    битые, отказ) и без модели, вперемешку со свободными действиями;
// 4. мусор.
//
// Каждый прогон — `FileEventStore` во временном каталоге, кости — mulberry32
// по сиду прогона, id событий, бросков, проверок и UUID движка — счётчики,
// часы — неподвижные. Сверяются ответы шагов (состояние — хешем без порядка
// ключей, события — хешами), запросы к модели (хешами) и итоговое состояние.
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

let uuidSerial = 0
globalThis.__skO1Uuid = () => `uuid-${++uuidSerial}`
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith('/server/rules-engine.mjs')) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    return { ...result, source: source.replace(/\brandomUUID\(\)/gu, 'globalThis.__skO1Uuid()') }
  },
})

const FIXED_NOW = '2026-08-01T10:00:00.000Z'
const FIXED_MS = Date.parse(FIXED_NOW)
Date.now = () => FIXED_MS

const O = await import('../../../../server/autonomous-orchestrator.mjs')
const { RulesEngine, normalizeCampaignState, applyGameEvent, resolveCommands } = await import('../../../../server/rules-engine.mjs')
const { DiceService } = await import('../../../../server/dice-service.mjs')
const { FileEventStore } = await import('../../../../server/event-store.mjs')
const { DirectorAgent } = await import('../../../../server/director-agent.mjs')
const { ActionAdjudicator } = await import('../../../../server/action-adjudicator.mjs')
const { Narrator } = await import('../../../../server/narrator.mjs')
const { LoreAuthor } = await import('../../../../server/lore-author.mjs')
const { RollRegistry } = await import('../../../../server/roll-registry.mjs')
const { CampaignBootstrapper } = await import('../../../../server/campaign-bootstrap.mjs')
const { SceneArchitectAgent } = await import('../../../../server/scene-architect.mjs')
const { scenarioLocationId } = await import('../../../../server/campaign-scenario.mjs')
const { interpretFreeAction } = await import('../../../../server/free-action-adjudication.mjs')

const corpusDir = process.argv[2] ?? process.env.SK_O1_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'

let seed = 0x0001_0c1e
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0
  let value = seed
  value = Math.imul(value ^ (value >>> 15), value | 1)
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296
}
const int = (n) => Math.floor(random() * n)
const pick = (list) => list[int(list.length)]
const chance = (p) => random() < p
const clone = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))
const sha = (value) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex')
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}
/** Метки времени решения отряда (`Date.now()` в `party-decision.mjs`) у Rust — настоящие часы. */
const MASK = new Set(['createdAt', 'expiresAt'])
function mask(value) {
  if (Array.isArray(value)) return value.map(mask)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !MASK.has(key)).map(([key, field]) => [key, mask(field)]))
  return value
}
const csha = (value) => sha(canonical(mask(clone(value))))
/** Поля хранилища, которые у журналов JS и Rust устроены по-разному (метаданные, кэш загрузки). */
const DROP = new Set(['metadata', 'reducer_version', 'events_applied', 'current_state_version'])
function summarize(value, key = '') {
  if (Array.isArray(value)) return key === 'events' ? value.map((entry) => csha(entry)) : value.map((entry) => summarize(entry))
  if (value && typeof value === 'object') {
    const out = {}
    for (const name of Object.keys(value).sort()) {
      if (DROP.has(name) || value[name] === undefined) continue
      out[name] = name === 'state' ? csha(value[name]) : summarize(value[name], name)
    }
    return out
  }
  return value
}

function failure(error) {
  if (error?.name === 'RulesValidationError') return { err: [error.code ?? null, String(error.message)] }
  return { fault: String(error?.name ?? 'Error'), code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 300) }
}

// --- состояния ------------------------------------------------------------------------

const blobs = []
const blobIndex = new Map()
const states = []
const stateIndex = new Map()
function addBlob(value) {
  const key = sha(value)
  if (!blobIndex.has(key)) {
    blobIndex.set(key, blobs.length)
    blobs.push(value)
  }
  return blobIndex.get(key)
}
function addState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { raw: clone(state) }
  const key = sha(state)
  if (stateIndex.has(key)) return stateIndex.get(key)
  const k = []
  const v = []
  for (const [name, value] of Object.entries(state)) {
    k.push(name)
    v.push(addBlob(value))
  }
  stateIndex.set(key, states.length)
  states.push({ k, v })
  return stateIndex.get(key)
}

// --- модель-заглушка ------------------------------------------------------------------

class RecordingLlm {
  constructor(role, calls, answers) {
    this.role = role
    this.calls = calls
    this.answers = answers
    this.index = 0
  }

  next(input) {
    this.calls.push({ role: this.role, input: csha(input) })
    const answer = this.answers[this.index++ % this.answers.length]
    if (answer === 'throw') throw Object.assign(new Error('модель недоступна'), { code: 'LLM_DOWN' })
    return clone(answer)
  }

  async completeJson(input) {
    return this.next(input)
  }
}

/** Летописец зовёт `complete` и читает `content`. */
class RecordingTextLlm extends RecordingLlm {
  async complete(input) {
    return { content: this.next(input) }
  }
}

const DIRECTOR_ANSWERS = [
  { type: 'continue_exploration', reason: 'Осмотреться внимательнее' },
  { type: 'offer_next_hook', hook: 'Следы ведут к старой мельнице за рекой' },
  'throw',
  { type: 'open_social_scene', reason: 'Поговорить с местными' },
  { type: 'request_encounter', theme: 'bandits', difficulty: 'easy' },
  { type: 'dance', reason: 'x' },
  { type: 'end_scene', destination: 'Старая мельница' },
  'не JSON',
  { type: 'advance_quest_clock', quest_id: 'quest:chapter:1' },
  { type: 'resolve_scene', resolution: 'objective' },
]
const baseReading = (text) => {
  const reading = clone(interpretFreeAction(text))
  delete reading.source
  return reading
}
const ADJUDICATOR_ANSWERS = [
  { ...baseReading('Осматриваю комнату в поисках следов'), success_detail: 'На полу видны свежие царапины.', surface_detail: 'Пыль лежит неровно.' },
  { ...baseReading('Иду дальше по дороге'), route: 'travel', destination: 'Красный Камень' },
  'throw',
  { ...baseReading('Говорю с трактирщиком'), route: 'talk', npc_hint: 'npc-unknown' },
  { ...baseReading('Делаю что-то странное'), route: 'clarify' },
  {},
  { ...baseReading('Лезу по скале наверх'), failure_detail: 'Камень крошится под пальцами.' },
  { ...baseReading('Толкаю врага в огонь'), effect: 'shove', effect_target: 'nobody-here' },
  { ...baseReading('Иду куда-нибудь'), route: 'travel', destination: 'куда-нибудь' },
]
const NARRATOR_ANSWERS = [{ narration: 'Пыль оседает на дороге, и отряд впервые за много дней смотрит на рассвет без тревоги.' }, 'throw']
const LORE_ANSWERS = ['Хроника арки: отряд прошёл равнины и вернулся с вестями.', 'throw']

// --- прогон ----------------------------------------------------------------------------

/** Кости прогона: mulberry32 от сида, `min + floor(r * (max - min + 1))`. */
function seededRng(caseSeed) {
  let state = caseSeed >>> 0
  return {
    randint(minimum, maximum) {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296
      return minimum + Math.floor(r * (maximum - minimum + 1))
    },
  }
}

/** Ответы роли из записи теста: по порядку, затем последний. */
function replayRole(entries) {
  let index = 0
  return async () => {
    const entry = entries[Math.min(index++, entries.length - 1)]
    if (!entry) throw new Error('нет записанного ответа роли')
    if (entry.err) throw Object.assign(new Error(entry.err.message), { name: entry.err.name, code: entry.err.code })
    return clone(entry.ok)
  }
}

const runs = []
let caseSerial = 0

async function runCase(source, rawState, steps, config = {}) {
  const caseSeed = (++caseSerial * 7919 + 11) >>> 0
  const campaign = config.campaign ?? `O1-RUN-${runs.length + 1}`
  const entry = { src: source, campaign, s: addState(clone(rawState)), seed: caseSeed, config: clone(config), steps: [], o: [], calls: [] }
  const dir = mkdtempSync(join(tmpdir(), 'sk-o1-run-'))
  uuidSerial = 0
  try {
    let serial = 0
    const store = new FileEventStore({
      rootDir: dir, reducer: applyGameEvent, normalizeState: normalizeCampaignState,
      clock: () => new Date(FIXED_MS), idFactory: () => `o1-event-${++serial}`,
    })
    try {
      await store.initializeCampaign({ campaign_id: campaign, initial_state: clone(rawState) })
    } catch (error) {
      entry.setup = failure(error)
      return entry
    }
    let rollSerial = 0
    const engine = new RulesEngine({ diceService: new DiceService({ rng: seededRng(caseSeed), idFactory: () => `o1-roll-${++rollSerial}`, now: () => FIXED_NOW }) })
    let checkSerial = 0
    const registry = config.registry ? new RollRegistry({
      diceService: new DiceService({ rng: seededRng(caseSeed ^ 0x5bd1e995), idFactory: () => `o1-registry-roll-${++rollSerial}`, now: () => FIXED_NOW }),
      now: () => FIXED_MS, checkIdFactory: () => `o1-check-${++checkSerial}`,
    }) : null
    const replay = config.replay ?? null
    let actionAdjudicator = null
    if (config.adjudicator === 'llm') actionAdjudicator = new ActionAdjudicator({ llmClient: new RecordingLlm('adjudicator', entry.calls, ADJUDICATOR_ANSWERS) })
    if (config.adjudicator === 'plain') actionAdjudicator = new ActionAdjudicator()
    if (config.adjudicator === 'replay') {
      actionAdjudicator = { read: replayRole(replay.reads) }
      if (replay.awaits) actionAdjudicator.llmClient = { completeJson: async () => ({}) }
    }
    let narrator = null
    if (config.narrator === 'llm') narrator = new Narrator({ llmClient: new RecordingLlm('narrator', entry.calls, NARRATOR_ANSWERS) })
    if (config.narrator === 'plain') narrator = new Narrator()
    if (config.narrator === 'replay') narrator = { render: replayRole(replay.renders) }
    let loreAuthor = null
    if (config.lore === 'llm') loreAuthor = new LoreAuthor({ llmClient: new RecordingTextLlm('lore', entry.calls, LORE_ANSWERS) })
    if (config.lore === 'replay') loreAuthor = { composeArcChronicle: replayRole(replay.chronicles) }
    const orchestrator = new O.AutonomousCampaignOrchestrator({ eventStore: store, rulesEngine: engine, narrator, actionAdjudicator, loreAuthor, rollRegistry: registry, now: () => FIXED_MS })
    const director = new DirectorAgent({ llmClient: config.director === 'llm' ? new RecordingLlm('director', entry.calls, DIRECTOR_ANSWERS) : null })
    for (const step of steps) {
      const resolved = typeof step === 'function' ? await step(orchestrator, store, campaign) : step
      if (!resolved) continue
      entry.steps.push(clone(resolved))
      try {
        entry.o.push({ ok: summarize(await perform(resolved, orchestrator, director, campaign)) })
      } catch (error) {
        entry.o.push(failure(error))
      }
    }
    const final = await store.load(campaign)
    entry.final = { version: final.state_version, state: csha(final.state) }
  } catch (error) {
    entry.setup = failure(error)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    runs.push(entry)
  }
  return entry
}

async function perform(step, orchestrator, director, campaign) {
  switch (step.op) {
    case 'intent':
      return orchestrator.runIntent({ campaignId: campaign, intent: step.intent ?? undefined, idempotencyKey: step.key ?? undefined, playerAction: step.playerAction ?? undefined })
    case 'director': {
      const loaded = await orchestrator.load(campaign)
      const decision = await director.choose({ state: loaded.state, playerAction: step.playerAction ?? '', improvMode: step.improv })
      const result = await orchestrator.runIntent({ campaignId: campaign, intent: decision.intent, idempotencyKey: step.key, playerAction: step.playerAction ?? '' })
      return { decision: decision.intent, result }
    }
    case 'action':
      return orchestrator.handleUnknownAction({ campaignId: campaign, ...step.args })
    case 'combat':
      return orchestrator.runCombat(campaign, { idempotencyPrefix: step.prefix, maxTurns: step.maxTurns })
    case 'complete':
      return orchestrator.completeEncounter({ campaignId: campaign, outcome: step.outcome ?? undefined })
    case 'time':
      return orchestrator.advanceTime(campaign, { amount: step.amount, unit: step.unit ?? undefined, idempotencyKey: step.key })
    case 'bind':
      return orchestrator.bindPromise(campaign, { promiseId: step.promiseId, condition: step.condition ?? undefined, idempotencyKey: step.key ?? undefined })
    case 'witness':
      return orchestrator.propagateWitnesses(campaign, { sourceEventId: step.sourceEventId ?? undefined, outcome: step.outcome, severity: step.severity, idempotencyKey: step.key })
    case 'route':
      return { hint: orchestrator.takeRouteHint(campaign, step.key) }
    default:
      throw new Error(`неизвестный шаг ${step.op}`)
  }
}

/** Шаг после намерения: бой автобоем, затем итог встречи. */
function combatFollowUp(prefix) {
  return [
    async (orchestrator, store, campaign) => {
      const loaded = await store.load(campaign)
      return loaded.state.mechanics?.combat?.active ? { op: 'combat', prefix, maxTurns: 60 } : null
    },
    async (orchestrator, store, campaign) => {
      const loaded = await store.load(campaign)
      const encounter = loaded.state.mechanics?.encounter
      if (loaded.state.mechanics?.combat?.active || !(encounter?.id ?? encounter?.encounter_id)) return { op: 'route', key: `${prefix}:none` }
      return { op: 'complete', outcome: encounter?.outcome || 'enemies_defeated' }
    },
  ]
}

const PHRASES = [
  'Осматриваю комнату в поисках следов', 'Открываю дверь', 'Обыскиваю тело', 'Передаю зелье союзнику', 'Лезу по стене на крышу',
  'Поджигаю бочку', 'Иду в Красный Камень', 'Спрашиваю трактирщика о драконе', 'Прыгаю и бью врага мечом', 'это', 'ааааааааааа',
  'Взлетаю к звёздам без всякой магии', 'Ищу ловушки у входа', 'Пытаюсь вскрыть замок сундука', 'Читаю надписи на алтаре',
  'Карабкаюсь на утёс', 'Краду кошелёк у купца', 'Вхожу в таверну', 'Подхожу к колодцу и осматриваю его', 'Касаюсь огня рукой',
  'Бью кулаком в стену', 'Молюсь у святыни', 'Перевязываю раны союзника', 'Осматриваю сундук', 'Иду к маяку', 'Отправляюсь в путь',
  'Прислушиваюсь к шорохам за дверью', 'Изучаю повестку на стене', 'Бросаю камень в окно', 'Забираю добычу с тела',
]

function heroIdOf(state) {
  const party = state?.partyMemberIds?.length ? state.partyMemberIds : (state?.players ?? []).map((hero) => hero?.id)
  return String(party?.[0] ?? state?.players?.[0]?.id ?? '')
}
function actionStep(state, key, overrides = {}) {
  const combat = state?.mechanics?.combat
  const current = combat?.active ? combat.initiative?.[combat.active_index]?.actor_id : null
  const playerId = current && (state.players ?? []).some((hero) => String(hero.id) === String(current)) && chance(0.8) ? String(current) : heroIdOf(state)
  return { op: 'action', args: { action: pick(PHRASES), idempotencyKey: key, playerId, ...overrides } }
}

// --- 1. записи тестов -----------------------------------------------------------------

const TESTS = [
  'agent-context-contract', 'authoritative-writers', 'autonomous-campaign', 'director-freedom-regression', 'director-three-scenes',
  'dm-dialogue-upgrade', 'encounter-rewards-ruleset', 'encounter-rewards-v2', 'evening-campaign', 'free-action-consequence',
  'free-action-discovery', 'free-action', 'improvised-combat-action', 'level-transition-phrase', 'offscreen-world', 'persistent-campaign',
  'post-combat-recovery', 'quest-progress-evidence', 'scenario-attention', 'scene-prop-improvisation', 'table-situations-doc', 'world-deeds',
]
function captureTests() {
  const root = new URL('../../../../', import.meta.url)
  const dir = mkdtempSync(join(tmpdir(), 'sk-o1-capture-'))
  const file = join(dir, 'capture.jsonl')
  try {
    try {
      execFileSync(process.execPath, [
        '--import', new URL('./capture-o1.mjs', import.meta.url).href,
        '--test', '--test-isolation=none', '--test-reporter=dot',
        ...TESTS.map((name) => new URL(`test/${name}.test.mjs`, root).pathname.replace(/^\/([A-Za-z]:)/u, '$1')),
      ], {
        cwd: new URL('.', root),
        env: { ...process.env, ROUTERAI_API_KEY: '', SK_CAPTURE: file, SK_CAPTURE_LIMIT: process.env.SK_O1_CAPTURE_LIMIT ?? '160' },
        stdio: ['ignore', 'ignore', 'inherit'],
        maxBuffer: 1 << 30,
      })
    } catch (error) {
      console.warn(`захват: тесты завершились с ошибкой (${error.status ?? error.message})`)
    }
    return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const pure = []
/** Позиции аргументов-состояний: они хранятся в таблице `states`. */
const STATE_POSITIONS = { partyOrderIds: [0], isUnresolvedDeadHero: [0], lootOwnerId: [0], sceneResolutionProof: [0], materialConsequenceCommands: [0], directorStepNarration: [2] }
function pureCase(source, fn, args) {
  const undef = []
  const values = args.map((value, index) => {
    if (value === undefined) undef.push(index)
    return value === undefined ? null : clone(value)
  })
  const call = values.map((value, index) => (undef.includes(index) ? undefined : clone(value)))
  let o
  try {
    o = { ok: clone(O[fn](...call)) ?? null }
  } catch (error) {
    o = failure(error)
  }
  const positions = STATE_POSITIONS[fn] ?? []
  pure.push({ src: source, fn, args: values.map((value, index) => (positions.includes(index) && !undef.includes(index) ? { state: addState(value) } : value)), ...(undef.length ? { undef } : {}), o })
}

const captured = existsSync(process.env.SK_O1_CAPTURE_FILE ?? '') ? readFileSync(process.env.SK_O1_CAPTURE_FILE, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : captureTests()
let testRuns = 0
for (const record of captured) {
  if (record.fn) {
    pureCase('tests', record.fn, record.args.map((value, index) => ((record.undef ?? []).includes(index) ? undefined : value)))
    continue
  }
  const args = record.args.map((value, index) => ((record.undef ?? []).includes(index) ? undefined : value))
  const config = {
    campaign: record.campaignId,
    adjudicator: record.adjudicator ? 'replay' : 'none',
    narrator: record.narrator ? 'replay' : 'none',
    lore: record.lore ? 'replay' : 'none',
    registry: record.registry,
    replay: { reads: record.reads, renders: record.renders, chronicles: record.chronicles, awaits: record.awaits },
    test: record.test,
  }
  const options = args[0] && typeof args[0] === 'object' ? args[0] : {}
  const second = args[1] && typeof args[1] === 'object' ? args[1] : {}
  let step
  switch (record.method) {
    case 'runIntent': step = { op: 'intent', intent: options.intent, key: options.idempotencyKey, playerAction: options.playerAction }; break
    case 'handleUnknownAction': {
      const { campaignId: _campaign, ...rest } = options
      step = { op: 'action', args: rest }
      break
    }
    case 'runCombat': step = { op: 'combat', prefix: second.idempotencyPrefix ?? 'autocombat', maxTurns: second.maxTurns ?? 200 }; break
    case 'completeEncounter': step = { op: 'complete', outcome: options.outcome }; break
    case 'advanceTime': step = { op: 'time', amount: second.amount, unit: second.unit, key: second.idempotencyKey ?? 'advance-time' }; break
    case 'bindPromise': step = { op: 'bind', promiseId: second.promiseId, condition: second.condition, key: second.idempotencyKey }; break
    case 'propagateWitnesses': step = { op: 'witness', sourceEventId: second.sourceEventId, outcome: second.outcome ?? 'neutral', severity: second.severity ?? 'minor', key: second.idempotencyKey ?? 'witnesses' }; break
    default: continue
  }
  // Повтор того же шага — идемпотентность на чистом журнале.
  await runCase(`tests:${record.method}`, record.state, [step, step], config)
  testRuns += 1
}
console.log(`тесты: ${pure.length} вызовов чистых функций, ${testRuns} прогонов методов`)

// --- 2. корпус ----------------------------------------------------------------------------

const corpusStates = []
const STATE_LIMIT = Number(process.env.SK_O1_STATES ?? 110)
if (!existsSync(corpusDir)) throw new Error(`нет корпуса в ${corpusDir}`)
const stateDir = join(corpusDir, 'states')
const names = readdirSync(stateDir).sort()
const stride = Math.max(1, Math.floor(names.length / (STATE_LIMIT * 4)))
for (let index = 0; index < names.length && corpusStates.length < STATE_LIMIT; index += stride) {
  const file = join(stateDir, names[index])
  if (statSync(file).size > 90_000) continue
  let state
  try { state = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
  if (!state?.players?.length) continue
  corpusStates.push(state)
}
console.log(`корпус: ${corpusStates.length} состояний`)

for (const state of corpusStates) {
  pureCase('corpus', 'partyOrderIds', [state])
  pureCase('corpus', 'lootOwnerId', [state])
  pureCase('corpus', 'isUnresolvedDeadHero', [state, heroIdOf(state)])
  for (const resolution of ['negotiation', 'objective', 'party_decision']) pureCase('corpus', 'sceneResolutionProof', [state, { type: 'resolve_scene', resolution }])
  const interaction = state.agentInteraction
  pureCase('corpus', 'transitionDecisionMatches', [interaction, { decisionId: interaction?.id, destination: interaction?.destinationLocationId }])
  const cells = (state.scene?.cells ?? []).filter((_, index) => index % 7 === 0).slice(0, 30).map((cell) => ({ x: cell.x, y: cell.y }))
  pureCase('corpus', 'directorStepNarration', [pick(['continue_exploration', 'offer_next_hook', 'end_scene']), chance(0.6) ? [{ event_type: 'AreaRevealed', payload: { cells } }] : [], state])
  const props = state.scene?.map?.props ?? []
  const events = [
    { event_id: 'e-door', event_type: 'DoorStateChanged', payload: { state: pick(['open', 'closed', 'broken', 'ajar']), previous_state: 'closed' }, visibility: pick(['party', 'public', undefined, 'gm_only']) },
    ...props.slice(0, 3).map((prop, index) => ({ event_id: `e-prop-${index}`, event_type: 'SceneObjectStateChanged', payload: { prop_id: prop.id, state: pick(['burning', 'toppled', 'open', 'weird']), success: chance(0.8) } })),
    { event_id: 'e-force', event_type: 'DoorForced', payload: { success: chance(0.5) } },
  ]
  pureCase('corpus', 'materialConsequenceCommands', [state, { succeeded: chance(0.85), committedEvents: events }])
  const hero = (state.players ?? [])[0]
  pureCase('corpus', 'incapacitatedActionRefusal', [hero, pick([null, 'unconscious', 'stunned', 'paralyzed', 'petrified', 'incapacitated', 'grappled'])])
}

let corpusRuns = 0
for (const [index, state] of corpusStates.entries()) {
  const adjudicator = pick(['none', 'none', 'llm', 'plain'])
  const registry = chance(0.25)
  const steps = []
  steps.push(actionStep(state, `corpus-${index}-a1`))
  steps.push(actionStep(state, `corpus-${index}-a2`))
  if (chance(0.2)) steps.push({ ...steps[0] })
  if (!state.mechanics?.combat?.active) {
    steps.push({ op: 'director', key: `corpus-${index}-d1`, playerAction: pick(['', 'Осмотреться', 'Перейти дальше', 'Нападаем!']), improv: pick(['story', 'chaos']) })
  }
  steps.push(...combatFollowUp(`corpus-${index}-c`))
  steps.push({ op: 'route', key: `corpus-${index}-a1` })
  if (chance(0.3)) steps.push({ op: 'time', amount: pick([30, 90, 480]), unit: 'minute', key: `corpus-${index}-t` })
  if (chance(0.25)) {
    const promise = (state.social?.promises ?? [])[0]
    steps.push({ op: 'bind', promiseId: promise?.id ?? 'promise-none', condition: { event_type: pick(['QuestClockAdvanced', 'EncounterOutcomeRecorded', 'Nope']), outcome: 'enemies_defeated' }, key: `corpus-${index}-b` })
  }
  if (chance(0.2)) steps.push({ op: 'witness', sourceEventId: 'e-source', outcome: pick(['helpful', 'harmful', 'neutral']), severity: pick(['minor', 'major']), key: `corpus-${index}-w` })
  await runCase('corpus', state, steps, { adjudicator, registry, director: chance(0.5) ? 'llm' : 'none', narrator: pick(['none', 'llm', 'plain']), lore: pick(['none', 'llm']) })
  corpusRuns += 1
}
console.log(`корпус: ${corpusRuns} прогонов`)

// --- 3. авторские миры ------------------------------------------------------------------------

const HEROES = [
  { id: 'o1-hero-1', character: 'Ирма', name: 'Игрок 1', role: 'Воин · ур. 3', species: 'Человек', background: 'Странник', level: 3, hp: 30, maxHp: 30, armor: 17, speed: 30 },
  { id: 'o1-hero-2', character: 'Тамир', name: 'Игрок 2', role: 'Жрец · ур. 3', species: 'Дварф', background: 'Прислужник', level: 3, hp: 24, maxHp: 24, armor: 16, speed: 25 },
]
async function world(templateId, code) {
  return normalizeCampaignState(await new CampaignBootstrapper().create({ code, worldTemplateId: templateId, players: clone(HEROES) }))
}
async function travel(state, locationId) {
  let current = state
  for (let hop = 0; hop < 8 && scenarioLocationId(current) !== locationId; hop += 1) {
    const { sceneArgs } = await new SceneArchitectAgent().plan({ state: current, decision: `Идём в ${locationId}`, destinationLocationId: locationId })
    const result = resolveCommands([{ command_id: `o1-travel-${hop}`, command_type: 'AdvanceScene', scene_args: sceneArgs }], current, { diceService: new DiceService({ rng: seededRng(hop + 1), idFactory: () => `o1-travel-roll-${hop}`, now: () => FIXED_NOW }), context: { isAdmin: true } })
    current = normalizeCampaignState(result.state)
  }
  return current
}

const worlds = []
try {
  const astohan = await world('astohan-plains', 'O1-ASTOHAN')
  worlds.push(['astohan', astohan])
  try { worlds.push(['astohan-redstone', await travel(astohan, 'astohan-redstone')]) } catch (error) { console.warn('путь до Красного Камня:', error.message) }
  try { worlds.push(['astohan-mittlayd', await travel(astohan, 'astohan-mittlayd')]) } catch (error) { console.warn('путь до Миттлайда:', error.message) }
} catch (error) { console.warn('Асстохан:', error.message) }
for (const [id, code] of [['league-nine-tides', 'O1-LEAGUE'], ['invented-world', 'O1-INVENTED']]) {
  try { worlds.push([id, await world(id, code)]) } catch (error) { console.warn(id, error.message) }
}

let worldRuns = 0
for (const [name, state] of worlds) {
  for (const improv of ['story', 'chaos']) {
    for (const director of ['none', 'llm']) {
      const steps = []
      for (let step = 0; step < 7; step += 1) {
        steps.push({ op: 'director', key: `${name}-${improv}-${step}`, playerAction: pick(['', '', 'Осмотреться', 'Перейти дальше', 'Нападаем!', 'Поговорить с местными']), improv })
        steps.push(...combatFollowUp(`${name}-${improv}-${step}-c`))
        if (chance(0.6)) steps.push(async (orchestrator, store, campaign) => actionStep((await store.load(campaign)).state, `${name}-${improv}-${step}-a`))
        if (chance(0.2)) steps.push({ op: 'director', key: `${name}-${improv}-${step}`, playerAction: '', improv })
      }
      await runCase(`world:${name}`, state, steps, { adjudicator: pick(['none', 'llm']), registry: chance(0.3), director, narrator: pick(['none', 'llm']), lore: pick(['none', 'llm']) })
      worldRuns += 1
    }
  }
}
console.log(`миры: ${worlds.map(([name]) => name).join(', ')}; ${worldRuns} прогонов`)

// --- 4. мусор ------------------------------------------------------------------------------------

const JUNK_STATES = [{}, { players: 'x' }, { players: [{ id: 1, hp: 'many' }], partyMemberIds: [1, null] }, { scene: { cells: [{ x: 'a', y: null, type: 'floor' }] }, players: [{ id: 'h', hp: 5 }] }]
for (const state of JUNK_STATES) {
  for (const fn of ['partyOrderIds', 'lootOwnerId']) pureCase('junk', fn, [state])
  pureCase('junk', 'isUnresolvedDeadHero', [state, undefined])
  pureCase('junk', 'sceneResolutionProof', [state, { type: 'resolve_scene', resolution: 'negotiation' }])
  pureCase('junk', 'materialConsequenceCommands', [state, { succeeded: true, committedEvents: [null, { event_type: 'DoorBarricaded' }, { event_id: 7, event_type: 'DoorBarricadeCleared', visibility: '' }] }])
  pureCase('junk', 'directorStepNarration', [undefined, undefined, undefined])
  pureCase('junk', 'directorStepNarration', ['continue_exploration', [{ event_type: 'AreaRevealed', payload: { cells: { x: 1 } } }], state])
  pureCase('junk', 'incapacitatedActionRefusal', [undefined, undefined])
  pureCase('junk', 'transitionDecisionMatches', [{ id: 'x', status: 'resolved', resolvedOptionId: 'continue', destinationLocationId: '', options: [{ id: 'continue' }] }, undefined])
  await runCase('junk', state, [
    { op: 'action', args: { action: 'Осматриваю комнату', idempotencyKey: 'junk-a', playerId: 'h' } },
    { op: 'intent', intent: { type: 'continue_exploration' }, key: 'junk-i' },
    { op: 'intent', intent: null, key: 'junk-null' },
    { op: 'intent', intent: { type: 'resolve_scene', resolution: 'objective' }, key: 'junk-r' },
    { op: 'combat', prefix: 'junk-c', maxTurns: 3 },
    { op: 'complete', outcome: 'fled' },
    { op: 'time', amount: 'x', key: 'junk-t' },
  ], { adjudicator: 'none' })
}

// --- запись -------------------------------------------------------------------------------------

const sections = { blobs, states, pure, runs, answers: [{ director: DIRECTOR_ANSWERS, adjudicator: ADJUDICATOR_ANSWERS, narrator: NARRATOR_ANSWERS, lore: LORE_ANSWERS }] }
const lines = Object.entries(sections).map(([key, value]) => `${JSON.stringify(key)}: [\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`)
const text = `{\n${lines.join(',\n')}\n}\n`
const gz = gzipSync(text, { level: 9 })
writeFileSync(new URL('./o1.json.gz', import.meta.url), gz)
const failures = runs.reduce((count, run) => count + run.o.filter((entry) => !entry.ok).length, 0)
console.log(`o1.json.gz: ${Object.entries(sections).map(([key, value]) => `${key} ${value.length}`).join(', ')}; шагов с отказом ${failures} (${(text.length / 1e6).toFixed(1)} МБ текста, ${(gz.length / 1e6).toFixed(2)} МБ gzip)`)
