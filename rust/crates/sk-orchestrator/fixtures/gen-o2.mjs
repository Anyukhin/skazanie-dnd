import '../../../fixtures-env.mjs'
// Эталоны задачи О2 (`sk-orchestrator`): `server/game-orchestrator.mjs`.
//
//   node rust/crates/sk-orchestrator/fixtures/gen-o2.mjs [каталог корпуса]
//
// Источники случаев:
// 1. «тесты» — внешние вызовы `handle(input)` и чистых экспортов, записанные
//    при прогоне тестов JS (`capture-o2.mjs`): состояние журнала на входе,
//    вход, ответы нестандартных ролей и снимок реестра уточнений; вызов
//    переигрывается здесь на чистом журнале дважды (второй раз — повтор
//    по тому же ключу);
// 2. «корпус» — состояния `tmp/corpus-v1`: сессии из реплик игроков
//    (`eval/player-phrases.json` и свои), ответов на уточнение, ручных
//    бросков, повторов, конфликтов ключа, вопросов, `/why` и команд из
//    хотбара; роли — с моделью-заглушкой и без;
// 3. «миры» — авторские кампании (Асстохан с переходами, Лига девяти
//    приливов, придуманный мир) теми же сессиями;
// 4. мусор.
//
// Каждый прогон — `FileEventStore` во временном каталоге, кости — mulberry32
// по сиду прогона, id событий, бросков, проверок, уточнений и UUID движка —
// счётчики, часы — неподвижные, время трасс — счётчик. Сверяются ответы шагов
// (состояние — хешем без порядка ключей, события — хешами), события живого
// рассказа, запросы к модели (хешами) и итоговое состояние журнала.
import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

let uuidSerial = 0
globalThis.__skO2Uuid = () => `uuid-${++uuidSerial}`
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith('/server/rules-engine.mjs')) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    return { ...result, source: source.replace(/\brandomUUID\(\)/gu, 'globalThis.__skO2Uuid()') }
  },
})

const FIXED_NOW = '2026-08-01T10:00:00.000Z'
const FIXED_MS = Date.parse(FIXED_NOW)
Date.now = () => FIXED_MS

const G = await import('../../../../server/game-orchestrator.mjs')
const { RulesEngine, normalizeCampaignState, resolveCommands, applyGameEvent } = await import('../../../../server/rules-engine.mjs')
const { DiceService } = await import('../../../../server/dice-service.mjs')
const { FileEventStore } = await import('../../../../server/event-store.mjs')
const { FileTraceStore } = await import('../../../../server/trace-store.mjs')
const { Narrator } = await import('../../../../server/narrator.mjs')
const { NpcSocialController } = await import('../../../../server/npc-social-controller.mjs')
const { LoreVoice } = await import('../../../../server/lore-voice.mjs')
const { ActionAdjudicator } = await import('../../../../server/action-adjudicator.mjs')
const { AutonomousCampaignOrchestrator } = await import('../../../../server/autonomous-orchestrator.mjs')
const { RollRegistry } = await import('../../../../server/roll-registry.mjs')
const { ClarificationRegistry } = await import('../../../../server/clarification-registry.mjs')
const { CampaignBootstrapper } = await import('../../../../server/campaign-bootstrap.mjs')
const { SceneArchitectAgent } = await import('../../../../server/scene-architect.mjs')
const { scenarioLocationId } = await import('../../../../server/campaign-scenario.mjs')

const corpusDir = process.argv[2] ?? process.env.SK_O2_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'
const phrasesFile = new URL('../../../../eval/player-phrases.json', import.meta.url)

let seed = 0x0002_0c1e
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
/** Метки настоящих часов: решение отряда (`party-decision`), время рассказа у Rust. */
const MASK = new Set(['createdAt', 'expiresAt', 'elapsed_ms', 'recovered_at'])
function mask(value) {
  if (Array.isArray(value)) return value.map(mask)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !MASK.has(key)).map(([key, field]) => [key, mask(field)]))
  return value
}
const csha = (value) => sha(canonical(mask(clone(value))))
/** Поля хранилища, которые у журналов JS и Rust устроены по-разному. */
const DROP = new Set(['metadata', 'reducer_version', 'events_applied', 'current_state_version'])
/** Крупные списки — хешами по элементу. */
const HASHED = new Set(['events', 'mechanics', 'visible_state_changes', 'reveal', 'spawn'])
function summarize(value, key = '') {
  if (Array.isArray(value)) return HASHED.has(key) ? value.map((entry) => csha(entry)) : value.map((entry) => summarize(entry))
  if (value && typeof value === 'object') {
    const out = {}
    for (const name of Object.keys(value).sort()) {
      if (DROP.has(name) || MASK.has(name) || value[name] === undefined) continue
      out[name] = name === 'state' || name === 'authoritative_state' ? csha(value[name]) : summarize(value[name], name)
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
function stateFrom(reference) {
  if (reference?.raw !== undefined) return clone(reference.raw)
  const entry = states[reference]
  return entry ? Object.fromEntries(entry.k.map((name, index) => [name, clone(blobs[entry.v[index]])])) : null
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

  async completeJson(input) {
    this.calls.push({ role: this.role, input: csha(input) })
    if (this.dump) this.dump.push({ role: this.role, input: canonical(mask(clone(input))) })
    const answer = this.answers[this.index++ % this.answers.length]
    if (answer === 'throw') throw Object.assign(new Error('модель недоступна'), { code: 'LLM_DOWN' })
    return clone(answer)
  }
}

const NARRATOR_ANSWERS = [
  { narration: 'Пыль оседает, и в тишине слышно, как где-то капает вода.' },
  'throw',
  { narration: '' },
  { narration: 'Герой получает предмет: сияющий меч, и стража падает замертво.' },
  'не JSON',
]
const SOCIAL_ANSWERS = [
  { reply: 'Чужаков здесь не любят. Но вам, пожалуй, отвечу: дорога на север опасна.', stance: 'neutral', confidence: 0.8 },
  'throw',
  { reply: 'Уходите.', stance: 'hostile', relationship_delta: -1 },
  { reply: 'Помогу, если поможете мне.', stance: 'friendly', promise: { direction: 'npc_to_party', text: 'Покажу тропу', due_hint: 'на рассвете' } },
  { reply: 'x', unknown_field: 1 },
]
const LORE_ANSWERS = [{ answer: 'Говорят, в этих краях давно не видели дракона.' }, 'throw', { answer: '' }]
const ADJUDICATOR_ANSWERS = [
  { approach: 'investigation', goal_summary: 'найти следы', approach_summary: 'осматривает пол', skill: 'investigation', success_detail: 'На полу видны свежие царапины.', surface_detail: 'Пыль лежит неровно.', failure_detail: 'Ничего не разглядеть в полумраке.' },
  'throw',
  { route: 'talk', npc_hint: 'npc-unknown' },
  { route: 'clarify' },
  {},
  { narration: 'Можно попробовать подпереть дверь бочкой.', proposed_action: 'Подпираю дверь бочкой' },
]

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
    const entry = (entries ?? [])[Math.min(index++, (entries ?? []).length - 1)]
    if (!entry) throw new Error('нет записанного ответа роли')
    if (entry.err) throw Object.assign(new Error(entry.err.message), { name: entry.err.name, code: entry.err.code })
    return clone(entry.ok)
  }
}

/** Время трасс — счётчик: порядок `recent` не зависит от часов машины. */
class CountingTraceStore extends FileTraceStore {
  constructor(options) {
    super(options)
    this.serial = 0
  }

  save(input) {
    return super.save({ ...input, created_at: input.created_at || new Date(FIXED_MS + (++this.serial) * 1000).toISOString() })
  }
}

const runs = []
let caseSerial = 0

async function runCase(source, rawState, steps, config = {}) {
  const caseSeed = (++caseSerial * 7919 + 13) >>> 0
  const campaign = config.campaign ?? `O2-RUN-${runs.length + 1}`
  const entry = { src: source, campaign, s: addState(clone(rawState)), seed: caseSeed, config: clone(config), steps: [], o: [], calls: [], stream: [] }
  const dir = mkdtempSync(join(tmpdir(), 'sk-o2-run-'))
  uuidSerial = 0
  try {
    let serial = 0
    const store = new FileEventStore({
      rootDir: join(dir, 'events'), reducer: applyGameEvent, normalizeState: normalizeCampaignState,
      clock: () => new Date(FIXED_MS), idFactory: () => `o2-event-${++serial}`,
    })
    try {
      await store.initializeCampaign({ campaign_id: campaign, initial_state: clone(rawState) })
    } catch (error) {
      entry.setup = failure(error)
      return entry
    }
    let rollSerial = 0
    const engine = new RulesEngine({ diceService: new DiceService({ rng: seededRng(caseSeed), idFactory: () => `o2-roll-${++rollSerial}`, now: () => FIXED_NOW }) })
    let checkSerial = 0
    const registry = config.registry ? new RollRegistry({
      diceService: new DiceService({ rng: seededRng(caseSeed ^ 0x5bd1e995), idFactory: () => `o2-registry-roll-${++rollSerial}`, now: () => FIXED_NOW }),
      now: () => FIXED_MS, checkIdFactory: () => `o2-check-${++checkSerial}`,
    }) : null
    let clarificationSerial = 0
    let clarificationFile = null
    if (config.clarifications) {
      clarificationFile = join(dir, 'clarifications.json')
      writeFileSync(clarificationFile, JSON.stringify(config.clarifications))
    }
    const clarificationRegistry = new ClarificationRegistry({ storageFile: clarificationFile, now: () => FIXED_MS, idFactory: () => `o2-clar-${++clarificationSerial}` })
    const traceStore = config.trace ? new CountingTraceStore({ rootDir: join(dir, 'traces') }) : null
    const roles = config.roles ?? {}
    const dump = (process.env.SK_O2_DEBUG ?? '').split(',').includes(String(runs.length)) ? [] : null
    const llm = (role, answers) => Object.assign(new RecordingLlm(role, entry.calls, answers), { dump })
    // Судья свободного действия О1 и обсуждения.
    let adjudicator = null
    if (config.adjudicator === 'llm') adjudicator = new ActionAdjudicator({ llmClient: llm('adjudicator', ADJUDICATOR_ANSWERS) })
    if (config.adjudicator === 'plain') adjudicator = new ActionAdjudicator()
    if (config.adjudicator === 'replay') {
      adjudicator = { read: replayRole(roles.read) }
      if (config.awaits) adjudicator.llmClient = { completeJson: async () => ({}) }
    }
    let narrator
    if (config.narrator === 'llm') narrator = new Narrator({ llmClient: llm('narrator', NARRATOR_ANSWERS) })
    else if (config.narrator === 'plain') narrator = new Narrator()
    else if (config.narrator === 'replay') narrator = { render: replayRole(roles.render) }
    else narrator = null
    let social = null
    if (config.social === 'llm') social = new NpcSocialController({ llmClient: llm('social', SOCIAL_ANSWERS) })
    if (config.social === 'plain') social = new NpcSocialController()
    if (config.social === 'replay') social = { respond: replayRole(roles.respond) }
    let loreVoice = null
    if (config.lore === 'llm') loreVoice = new LoreVoice({ llmClient: llm('lore', LORE_ANSWERS) })
    if (config.lore === 'plain') loreVoice = new LoreVoice()
    if (config.lore === 'replay') loreVoice = { retell: replayRole(roles.retell) }
    const unknownActionHandler = config.unknown
      ? { handleUnknownAction: replayRole(roles.unknown) }
      : new AutonomousCampaignOrchestrator({ eventStore: store, rulesEngine: engine, rollRegistry: config.o1Registry === false ? null : registry, actionAdjudicator: adjudicator, now: () => FIXED_MS })
    let idSerial = 0
    const orchestrator = new G.GameOrchestrator({
      rulesEngine: engine,
      eventStore: store,
      traceStore,
      ...(config.narrator === 'default' ? {} : { narrator }),
      npcSocialController: social,
      unknownActionHandler,
      loreVoice,
      rollRegistry: registry,
      clarificationRegistry,
      ...(config.parser ? { intentParser: { parse: replayRole(roles.parse) } } : {}),
      ...(config.plan ? { adjudicator: { createPlan: replayRole(roles.plan) } } : {}),
      ...(config.retriever ? { ruleRetriever: { search: replayRole(roles.search) } } : {}),
      idFactory: () => `o2-id-${++idSerial}`,
      now: () => FIXED_MS,
    })
    if (config.discuss) orchestrator.actionAdjudicator = { discuss: replayRole(roles.discuss) }
    entry.debugCalls = dump
    const context = { orchestrator, store, registry, campaign, hero: config.hero ?? '', last: null, lastInput: null, stream: entry.stream }
    for (const step of steps) {
      const resolved = typeof step === 'function' ? await step(context) : step
      if (!resolved) continue
      entry.steps.push(clone(resolved))
      try {
        entry.o.push({ ok: summarize(await perform(resolved, context)) })
      } catch (error) {
        entry.o.push(failure(error))
      }
    }
    const final = await store.load(campaign)
    entry.final = { version: final.state_version, state: csha(final.state) }
  } catch (error) {
    entry.setup = failure(error)
  } finally {
    if ((process.env.SK_O2_DEBUG ?? '').split(',').includes(String(runs.length))) {
      console.log(`отладка: прогон ${runs.length} в ${dir}`)
      writeFileSync(join(dir, 'calls.json'), JSON.stringify(entry.debugCalls ?? null, null, 1))
    } else rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    delete entry.debugCalls
    runs.push(entry)
  }
  return entry
}

/** Вход шага: поля шага поверх текущего состояния журнала. */
async function inputFor(step, context) {
  const { store, registry, campaign } = context
  const loaded = await store.load(campaign)
  const base = { state: loaded.state, campaignId: campaign, playerId: step.playerId ?? context.hero, user: { role: step.admin ? 'admin' : 'player' } }
  const last = context.last
  switch (step.op) {
    case 'raw': {
      const fields = clone(step.input)
      if (step.stateRef != null) fields.state = stateFrom(step.stateRef)
      return fields
    }
    case 'handle':
      return { ...base, ...clone(step.fields) }
    case 'answer': {
      const id = last?.clarification?.id
      if (!id) return null
      return { ...base, message: step.message, clarificationId: id, idempotencyKey: step.key, manualRoll: Boolean(step.manualRoll) }
    }
    case 'roll': {
      const check = last?.check
      if (!check?.check_id || !registry) return null
      const actor = String(check.actor_id ?? base.playerId)
      const issued = registry.issue({ checkId: check.check_id, campaignId: campaign, actorId: actor })
      const verifiedRoll = registry.consume(issued.roll_id, { campaignId: campaign, actorId: actor, idempotencyKey: step.key })
      return { ...base, playerId: actor, message: last.resolved_action ?? context.lastInput?.message ?? '', verifiedRoll, manualRoll: true, idempotencyKey: step.key, ...(check.clarification_id ? { clarificationId: check.clarification_id } : {}) }
    }
    case 'confirm': {
      const id = last?.action_proposal?.id ?? last?.proposal_id
      if (!id || !context.lastInput) return null
      return { ...base, ...context.lastInput, state: loaded.state, confirmedProposalId: id, idempotencyKey: step.key }
    }
    case 'repeat':
      return context.lastInput ? { ...context.lastInput, state: loaded.state } : null
    case 'conflict':
      return context.lastInput?.idempotencyKey ? { ...context.lastInput, state: loaded.state, message: `${context.lastInput.message ?? ''} и ещё раз` } : null
    default:
      throw new Error(`неизвестный шаг ${step.op}`)
  }
}

async function perform(step, context) {
  const input = await inputFor(step, context)
  if (!input) return { skip: true }
  const director = Boolean(input.__director)
  delete input.__director
  if (director) input.commandCapability = G.DIRECTOR_COMMAND_CAPABILITY
  if (step.hooks?.start) input.onNarrationStart = (payload) => context.stream.push(['start', clone(payload)])
  if (step.hooks?.progress) input.onNarrationProgress = (text, payload) => context.stream.push(['progress', String(text), clone(payload)])
  const { state: _state, onNarrationStart: _start, onNarrationProgress: _progress, commandCapability: _capability, ...remembered } = input
  context.lastInput = remembered
  const result = await context.orchestrator.handle(input)
  context.last = result
  return result
}

// --- реплики ------------------------------------------------------------------------------

const PLAYER_PHRASES = JSON.parse(readFileSync(phrasesFile, 'utf8')).phrases
const OWN_PHRASES = [
  'Осматриваю комнату в поисках следов', 'Открываю дверь', 'Обыскиваю тело', 'Лезу по стене на крышу', 'Поджигаю бочку',
  'Иду в Красный Камень', 'Ищу ловушки у входа', 'Пытаюсь вскрыть замок сундука', 'Читаю надписи на алтаре',
  'Молюсь у святыни', 'Снимаю копию схемы со стены', 'Смотрим на дверь — выйдет ли кто-нибудь?', 'Вхожу внутрь маяка',
  'Осматриваю стол, затем открываю дверь', 'Подхожу к колодцу и потом осматриваю его', 'Прислушиваюсь к шорохам за дверью',
  'Атакую ближайшего врага мечом', 'Предлагаю переговоры — сложите оружие!', 'Заканчиваю свой ход', 'Отдыхаем до утра',
  'Ждём темноты', 'Перевязываю раны союзника', 'Краду кошелёк у купца', 'Подбрасываю монетку', 'Танцую на столе',
  'Сотворяю «Безмолвный образ»: иллюзия старухи у колодца', 'Читаю «Свет» и осматриваю подвал', 'это', 'ааааааааааа', '',
  'Нет, я имел в виду осмотреть стол', 'Да', 'Пригибаюсь за камнями и не свожу глаз с вершины маяка. «К двери пока не подходим»',
]
const QUESTIONS = ['Какая сейчас погода?', 'Который час?', 'Кто здесь главный?', 'Что мы знаем о драконе?', 'Сколько стоит комната?', 'Где мы?', 'Что я вижу вокруг?']
function npcNames(state) {
  const location = String(state?.scene?.location ?? '').trim().toLocaleLowerCase('ru')
  return (state?.social?.npcs ?? []).filter((npc) => npc?.name && npc.available !== false && (!location || !npc.location || String(npc.location).trim().toLocaleLowerCase('ru') === location)).map((npc) => ({ id: String(npc.id), name: String(npc.name) }))
}
function heroIdOf(state) {
  const party = state?.partyMemberIds?.length ? state.partyMemberIds : (state?.players ?? []).map((hero) => hero?.id)
  return String(party?.[0] ?? state?.players?.[0]?.id ?? '')
}
function otherHero(state, heroId) {
  return (state?.players ?? []).find((hero) => String(hero?.id) !== heroId)
}
function phraseFor(state, heroId) {
  const npcs = npcNames(state)
  const npc = npcs.length ? pick(npcs) : null
  const other = otherHero(state, heroId)
  const otherName = String(other?.character || other?.name || '')
  const roll = int(10)
  if (roll === 0 && npc) return pick([`Спрашиваю ${npc.name}: «Ты видел чужаков?»`, `«${npc.name}, скажи честно — кто сорит деньгами?»`, `Подхожу к ${npc.name} и говорю: «Мы пришли с миром.»`, `Сотворяю «Безмолвный образ» перед ${npc.name}. «${npc.name}, узнаёте её?»`])
  if (roll === 1 && otherName) return pick([`Говорю ${otherName}: «Я не уйду, пока не узнаю правду»`, `«${otherName}, прикрой меня!»`, `${otherName}, держись рядом.`])
  if (roll <= 4) return pick(PLAYER_PHRASES).text
  return pick(OWN_PHRASES)
}
function commandFor(state, heroId) {
  const props = state?.scene?.map?.props ?? []
  const altar = props.find((prop) => /altar|shrine|алтар|святын/iu.test(`${prop?.id ?? ''} ${prop?.kind ?? ''} ${prop?.label ?? ''}`))
  const npcs = npcNames(state)
  const enemy = (state?.enemies ?? [])[0]
  const options = [
    [{ command_type: 'MakeAbilityCheck', actor_id: heroId, ability: 'wis', skill: 'perception', difficulty: 12 }],
    [{ command_type: 'EndTurn', actor_id: heroId }],
    [{ command_type: 'ProposeParley', actor_id: heroId, skill: pick(['persuasion', 'intimidation']) }],
    [{ command_type: 'OperateSceneObject', actor_id: heroId, intent: 'pray', prop_id: String(altar?.id ?? props[0]?.id ?? 'prop-none') }],
    [{ command_type: 'PickpocketNpc', actor_id: heroId, npc_id: npcs[0]?.id ?? 'npc-none' }],
    [{ command_type: 'CalmBeast', actor_id: heroId, beast_id: 'beast:none' }],
    [{ command_type: 'ResolveGuardEncounter', actor_id: heroId, resolution: 'flee', skill: 'stealth' }],
    [{ command_type: 'AnswerTavernDiceRound', actor_id: heroId, approach: pick(['fair', 'cheat', 'watch']) }],
    [{ command_type: 'MakeAttack', actor_id: heroId, target_id: String(enemy?.id ?? 'nobody') }],
    'junk',
  ]
  const chosen = pick(options)
  return chosen === 'junk' ? 'не массив' : chosen
}

function sessionSteps(state, prefix) {
  const heroId = heroIdOf(state)
  const steps = []
  const count = 6 + int(5)
  for (let index = 0; index < count; index += 1) {
    const key = `${prefix}-${index}`
    const kind = int(14)
    if (kind <= 5) {
      steps.push({ op: 'handle', fields: { message: phraseFor(state, heroId), idempotencyKey: key, manualRoll: chance(0.4), ...(chance(0.1) ? { npcId: pick(npcNames(state))?.id ?? 'npc-none' } : {}) }, hooks: { start: chance(0.5), progress: chance(0.5) } })
      if (chance(0.6)) steps.push({ op: 'answer', message: pick(['Да', 'да', 'Нет, я имел в виду осмотреть стол', 'верёвкой', 'Осматриваю пол']), key: `${key}:a` })
      if (chance(0.6)) steps.push({ op: 'roll', key: `${key}:r` })
      if (chance(0.3)) steps.push({ op: 'confirm', key: `${key}:c` })
    } else if (kind === 6) {
      steps.push({ op: 'handle', fields: { message: pick(QUESTIONS), idempotencyKey: key, ...(chance(0.5) ? { requestKind: 'question' } : {}) } })
    } else if (kind === 7) {
      steps.push({ op: 'handle', fields: { message: pick(['Может, обойдём с тыла?', 'Я бы не спешил']), requestKind: 'discussion', idempotencyKey: key } })
    } else if (kind === 8) {
      steps.push({ op: 'handle', fields: { message: '/why', idempotencyKey: key } })
    } else if (kind === 9) {
      steps.push({ op: 'repeat' })
    } else if (kind === 10) {
      steps.push({ op: 'conflict' })
    } else {
      const commands = commandFor(state, heroId)
      steps.push({ op: 'handle', admin: chance(0.2), fields: { message: 'Структурированная команда', commands, requestCommands: commands, idempotencyKey: key, manualRoll: chance(0.6) } })
      if (chance(0.5)) steps.push({ op: 'roll', key: `${key}:r` })
    }
  }
  return steps
}

function sessionConfig(state) {
  return {
    hero: heroIdOf(state),
    narrator: pick(['none', 'plain', 'llm', 'llm']),
    social: pick(['none', 'plain', 'llm']),
    lore: pick(['none', 'llm']),
    adjudicator: pick(['none', 'plain', 'llm']),
    registry: chance(0.6),
    trace: chance(0.8),
  }
}

// --- 1. записи тестов -----------------------------------------------------------------

const TESTS = [
  'free-action', 'dialogue-interaction', 'npc-social', 'game-orchestrator', 'approach-attack', 'free-action-hazard-contact', 'compound-maneuver-preview',
  'free-action-discovery', 'free-action-wall-contact', 'trace-store', 'spell-by-words', 'intent-routing', 'world-memory-delivery',
  'game-flow-integration', 'combat-entry-routing', 'world-memory', 'narration-story-context', 'narration-npc-reactions', 'lore-voice', 'dm-dialogue-upgrade',
  'check-discovery-replay', 'action-sequence-roll', 'narrator-token-usage', 'tavern-life', 'blessings', 'beast-taming', 'player-request-router',
  'narrator-dialogue-routing', 'deterministic-narration', 'scene-summary',
]
function captureTests() {
  const root = new URL('../../../../', import.meta.url)
  const dir = mkdtempSync(join(tmpdir(), 'sk-o2-capture-'))
  const file = join(dir, 'capture.jsonl')
  try {
    try {
      execFileSync(process.execPath, [
        '--import', new URL('./capture-o2.mjs', import.meta.url).href,
        '--test', '--test-isolation=none', '--test-concurrency=1', '--test-reporter=dot',
        ...TESTS.map((name) => new URL(`test/${name}.test.mjs`, root).pathname.replace(/^\/([A-Za-z]:)/u, '$1')),
      ], {
        cwd: new URL('.', root),
        env: { ...process.env, ROUTERAI_API_KEY: '', SK_CAPTURE: file, SK_CAPTURE_LIMIT: process.env.SK_O2_CAPTURE_LIMIT ?? '220' },
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
const STATE_POSITIONS = { narrationStoryContext: [0], speechAddressee: [1], spellSpeechFollowUp: [1] }
function pureCase(source, fn, args) {
  const undef = []
  const values = args.map((value, index) => {
    if (value === undefined) undef.push(index)
    return value === undefined ? null : clone(value)
  })
  const call = values.map((value, index) => (undef.includes(index) ? undefined : clone(value)))
  let o
  try {
    o = { ok: clone(G[fn](...call)) ?? null }
  } catch (error) {
    o = failure(error)
  }
  const positions = STATE_POSITIONS[fn] ?? []
  pure.push({ src: source, fn, args: values.map((value, index) => (positions.includes(index) && !undef.includes(index) ? { state: addState(value) } : value)), ...(undef.length ? { undef } : {}), o })
}

const captured = existsSync(process.env.SK_O2_CAPTURE_FILE ?? '') ? readFileSync(process.env.SK_O2_CAPTURE_FILE, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : captureTests()
let testRuns = 0
for (const record of captured) {
  if (record.fn) {
    pureCase('tests', record.fn, record.args.map((value, index) => ((record.undef ?? []).includes(index) ? undefined : value)))
    continue
  }
  if (record.method !== 'handle') continue
  const { flags } = record
  const config = {
    campaign: record.campaignId,
    test: record.test,
    roles: record.roles,
    clarifications: record.clarifications,
    parser: flags.parser,
    plan: flags.adjudicator,
    narrator: flags.narrator === 'replay' ? 'replay' : flags.narrator === 'plain' ? 'plain' : 'none',
    social: flags.social,
    lore: flags.lore,
    discuss: flags.discuss,
    unknown: flags.unknown,
    adjudicator: flags.read,
    awaits: flags.awaits,
    retriever: flags.retriever,
    trace: flags.trace,
    registry: flags.registry || flags.o1Registry,
    o1Registry: flags.o1Registry,
  }
  const { state: inputState, ...input } = record.input ?? {}
  const step = { op: 'raw', input, ...(inputState !== undefined ? { stateRef: addState(inputState) } : {}), hooks: record.hooks }
  // Повтор того же шага — идемпотентность на чистом журнале.
  await runCase(`tests:${record.test}`, record.state, [step, step], config)
  testRuns += 1
}
console.log(`тесты: ${pure.length} вызовов чистых функций, ${testRuns} прогонов handle`)

// --- 2. корпус ----------------------------------------------------------------------------

const corpusStates = []
const STATE_LIMIT = Number(process.env.SK_O2_STATES ?? 70)
if (!existsSync(corpusDir)) throw new Error(`нет корпуса в ${corpusDir}`)
const stateDir = join(corpusDir, 'states')
const names = readdirSync(stateDir).sort()
const stride = Math.max(1, Math.floor(names.length / (STATE_LIMIT * 4)))
for (let index = 3; index < names.length && corpusStates.length < STATE_LIMIT; index += stride) {
  const file = join(stateDir, names[index])
  if (statSync(file).size > 80_000) continue
  let state
  try { state = JSON.parse(readFileSync(file, 'utf8')) } catch { continue }
  if (!state?.players?.length) continue
  corpusStates.push(state)
}
console.log(`корпус: ${corpusStates.length} состояний`)

const EVENT_SAMPLES = [
  { event_type: 'AbilityCheckResolved', actor_id: 'h', payload: { success: true, social_check: { npc_id: 'n1' } }, visibility: 'party' },
  { event_type: 'DamageApplied', actor_id: 'e', target_ids: ['h'], payload: { amount: 3 } },
  { event_type: 'NpcConversationRecorded', payload: { conversation: { id: 'c1', npc_id: 'n1' } } },
  { event_type: 'AreaRevealed', payload: { cells: [{ x: 1, y: 2 }] } },
  { event_type: 'ItemGranted', target_ids: ['h'], payload: { item: { id: 'i1', name: 'Верёвка' } } },
  { event_type: 'EntitySpawned', payload: {} },
  { event_type: 'ObjectiveUpdated', payload: { objective: 'Найти вход' } },
]
for (const state of corpusStates) {
  const heroId = heroIdOf(state)
  const events = EVENT_SAMPLES.filter(() => chance(0.5))
  pureCase('corpus', 'narrationStoryContext', [state, { playerId: heroId, partyIds: [heroId], isPartyMember: true }, events])
  const npcs = (state.social?.npcs ?? []).slice(0, 4).map((npc, index) => ({ id: npc.id, name: npc.name, relationship: pick(['trusted', 'neutral', 'hostile', 'unfriendly', 'weird', undefined]) ?? undefined, ...(index === 0 ? {} : {}) }))
  pureCase('corpus', 'narrationNpcReactions', [npcs, events, { heroDeed: chance(0.5), socialTarget: chance(0.5) ? { npcId: npcs[0]?.id, success: pick([true, false, 'yes']) } : null }])
  pureCase('corpus', 'withDetailReactions', [npcs.map((npc) => ({ npc_id: npc.id, name: npc.name, description: 'смотрит' })), [`${npcs[0]?.name ?? 'Мара'} бледнеет — лицо ей знакомо.`, '']])
  for (let index = 0; index < 4; index += 1) {
    const phrase = phraseFor(state, heroId)
    pureCase('corpus', 'speechAddressee', [phrase, state, heroId, { allowSpell: chance(0.3) }])
    pureCase('corpus', 'spellSpeechFollowUp', [phrase, state, heroId])
    pureCase('corpus', 'narrationRequestFingerprint', [{ campaignId: state.sessionCode, playerId: heroId, message: phrase, npcId: pick(['', 'n1']), requestKind: pick(['action', 'question']), operation: pick(['', 'message']) }])
  }
  const rolls = (state.mechanics?.roll_log ?? state.rolls ?? []).slice(0, 2)
  pureCase('corpus', 'eventsToClientEffects', [events, rolls.length ? rolls : [{ roll_id: 'r1', kept: 14, modifier: 2, total: 16, purpose: pick(['ability_check:wis', 'saving_throw:dex', 'attack_roll', 'mystery:x', 'Особый бросок']), success: true }]])
  pureCase('corpus', 'structuredCommandsFingerprint', [commandFor(state, heroId)])
}
for (const purpose of ['ability_check:WIS', 'ability_check:luck', 'saving_throw:con', 'saving_throw', 'attack', 'initiative', 'death_save', 'free_roll', 'weird-key', 'Бросок удачи', '', null, undefined, 42]) pureCase('corpus', 'rollPurposeLabel', [purpose])

let corpusRuns = 0
for (const [index, state] of corpusStates.entries()) {
  await runCase('corpus', state, sessionSteps(state, `corpus-${index}`), sessionConfig(state))
  corpusRuns += 1
}
console.log(`корпус: ${corpusRuns} прогонов`)

// --- 3. авторские миры ------------------------------------------------------------------------

const HEROES = [
  { id: 'o2-hero-1', character: 'Ирма', name: 'Игрок 1', role: 'Воин · ур. 3', species: 'Человек', background: 'Странник', level: 3, hp: 30, maxHp: 30, armor: 17, speed: 30 },
  { id: 'o2-hero-2', character: 'Тамир', name: 'Игрок 2', role: 'Жрец · ур. 3', species: 'Дварф', background: 'Прислужник', level: 3, hp: 24, maxHp: 24, armor: 16, speed: 25 },
]
async function world(templateId, code) {
  return normalizeCampaignState(await new CampaignBootstrapper().create({ code, worldTemplateId: templateId, players: clone(HEROES) }))
}
async function travel(state, locationId) {
  let current = state
  for (let hop = 0; hop < 8 && scenarioLocationId(current) !== locationId; hop += 1) {
    const { sceneArgs } = await new SceneArchitectAgent().plan({ state: current, decision: `Идём в ${locationId}`, destinationLocationId: locationId })
    const result = resolveCommands([{ command_id: `o2-travel-${hop}`, command_type: 'AdvanceScene', scene_args: sceneArgs }], current, { diceService: new DiceService({ rng: seededRng(hop + 1), idFactory: () => `o2-travel-roll-${hop}`, now: () => FIXED_NOW }), context: { isAdmin: true } })
    current = normalizeCampaignState(result.state)
  }
  return current
}

const worlds = []
try {
  const astohan = await world('astohan-plains', 'O2-ASTOHAN')
  worlds.push(['astohan', astohan])
  try { worlds.push(['astohan-redstone', await travel(astohan, 'astohan-redstone')]) } catch (error) { console.warn('путь до Красного Камня:', error.message) }
  try { worlds.push(['astohan-mittlayd', await travel(astohan, 'astohan-mittlayd')]) } catch (error) { console.warn('путь до Миттлайда:', error.message) }
} catch (error) { console.warn('Асстохан:', error.message) }
for (const [id, code] of [['league-nine-tides', 'O2-LEAGUE'], ['invented-world', 'O2-INVENTED']]) {
  try { worlds.push([id, await world(id, code)]) } catch (error) { console.warn(id, error.message) }
}
let worldRuns = 0
for (const [name, state] of worlds) {
  for (let variant = 0; variant < 4; variant += 1) {
    const config = sessionConfig(state)
    if (variant === 0) Object.assign(config, { narrator: 'none', social: 'none', lore: 'none', adjudicator: 'none' })
    if (variant === 1) Object.assign(config, { narrator: 'llm', social: 'llm', lore: 'llm', adjudicator: 'llm', registry: true })
    await runCase(`world:${name}`, state, sessionSteps(state, `${name}-${variant}`), config)
    worldRuns += 1
  }
}
console.log(`миры: ${worlds.map(([name]) => name).join(', ')}; ${worldRuns} прогонов`)

// --- 4. мусор ------------------------------------------------------------------------------------

const JUNK_STATES = [{}, { players: 'x' }, { players: [{ id: 1, hp: 'many' }], partyMemberIds: [1, null] }, { scene: { location: 5 }, social: { npcs: [{ id: 'n', name: 'Ив', location: 7 }] }, players: [{ id: 'h', hp: 5 }] }]
for (const state of JUNK_STATES) {
  pureCase('junk', 'narrationStoryContext', [state, {}, [null, { event_type: 'NpcConversationRecorded' }]])
  pureCase('junk', 'speechAddressee', ['«Ив, ты здесь?»', state, 'h', undefined])
  pureCase('junk', 'eventsToClientEffects', [[{ event_type: 'ItemGranted' }, { event_type: 'AreaRevealed', payload: { cells: [1, 2] } }], [null]])
  pureCase('junk', 'structuredCommandsFingerprint', [[null, 1, 'x', { command_id: 'a', b: undefined, c: [1, { z: 1, a: 2 }] }]])
  await runCase('junk', state, [
    { op: 'handle', fields: { message: 'Осматриваю комнату', idempotencyKey: 'junk-a', playerId: 'h' } },
    { op: 'handle', fields: { message: 'Структурированная команда', commands: 'x', idempotencyKey: 'junk-c' } },
    { op: 'handle', fields: { message: 'Структурированная команда', commands: [null], idempotencyKey: 'junk-d' } },
    { op: 'handle', fields: { message: '/why', turnId: '../bad' } },
    { op: 'handle', fields: { message: 'Какая погода?', requestKind: 'question', idempotencyKey: 'junk-q' } },
    { op: 'handle', fields: { message: 'Да', clarificationId: 'nope', idempotencyKey: 'junk-b' } },
  ], { hero: 'h', narrator: 'plain', trace: true, registry: true })
}

// --- запись -------------------------------------------------------------------------------------

const sections = { blobs, states, pure, runs, answers: [{ narrator: NARRATOR_ANSWERS, social: SOCIAL_ANSWERS, lore: LORE_ANSWERS, adjudicator: ADJUDICATOR_ANSWERS }] }
const lines = Object.entries(sections).map(([key, value]) => `${JSON.stringify(key)}: [\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`)
const text = `{\n${lines.join(',\n')}\n}\n`
const gz = gzipSync(text, { level: 9 })
writeFileSync(new URL('./o2.json.gz', import.meta.url), gz)
const failures = runs.reduce((count, run) => count + run.o.filter((entry) => !entry.ok).length, 0)
const skips = runs.reduce((count, run) => count + run.o.filter((entry) => entry.ok?.skip).length, 0)
console.log(`o2.json.gz: ${Object.entries(sections).map(([key, value]) => `${key} ${value.length}`).join(', ')}; шагов с отказом ${failures}, пропущено ${skips} (${(text.length / 1e6).toFixed(1)} МБ текста, ${(gz.length / 1e6).toFixed(2)} МБ gzip)`)
