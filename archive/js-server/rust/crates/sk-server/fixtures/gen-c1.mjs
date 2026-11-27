import '../../../fixtures-env.mjs'
// Эталоны С1: последовательности «коммит → проекция → летопись» с
// `room.version` прогоном **самих функций** `server/index.mjs`
// (`persistAuthoritativeProjection`, `appendRoomJournal`, `journalEntry`,
// `reconcileCampaignProjection`, `persistInteractionProjection`,
// `reconcilePartyDecisionPresence`, `enableDefaultHouseRules`…). Они не
// экспортированы, поэтому тела вырезаются из исходника по имени и собираются
// `new Function` с теми же зависимостями, что в `index.mjs`: настоящие
// `FileEventStore` с редьюсером движка, `getRoom`/`saveRoom` из `store.mjs`
// (временный каталог), карточки летописи и решения отряда.
//
// Rust-тест (`tests/server_c1.rs`) повторяет шаги над `sk_store` и сверяет
// комнату (состояние без `timestamp` в летописи), её версию и отметку
// проекции журнала после каждого шага.
//
// Запуск: node rust/crates/sk-server/fixtures/gen-c1.mjs
import { registerHooks } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

// `store.mjs` импортирует `dotenv/config`, а `node_modules` в worktree нет.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'dotenv/config') return { url: 'data:text/javascript,', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..', '..')
const server = (name) => pathToFileURL(join(root, 'server', name)).href
const storage = mkdtempSync(join(tmpdir(), 'skazanie-gen-c1-'))
process.env.DND_STORAGE_DIR = storage

const store = await import(server('store.mjs'))
const { FileEventStore } = await import(server('event-store.mjs'))
const { GAME_REDUCER_VERSION, GAME_STATE_PROJECTOR_VERSION, RulesEngine, applyGameEvent, normalizeCampaignState } = await import(server('rules-engine.mjs'))
const { DiceService } = await import(server('dice-service.mjs'))
const { CANONICAL_PROJECTION_FIELDS, compareProjection, projectionHash } = await import(server('projection-integrity.mjs'))
const executorModule = await import(server('authoritative-executor.mjs'))
const { offscreenChronicleEntry } = await import(server('offscreen-world.mjs'))
const { courierLetterChronicleEntry } = await import(server('courier-letters.mjs'))
const { beastChronicleEntry } = await import(server('beast-taming.mjs'))
const { finishQuestDecision, questDecisionChronicleEntry } = await import(server('quest-decisions.mjs'))
const { campaignStoryChronicleEntry } = await import(server('campaign-stories.mjs'))
const { officeChronicleEntry } = await import(server('world-offices.mjs'))
const partyDecision = await import(server('party-decision.mjs'))
const campaignRuleset = await import(server('campaign-ruleset.mjs'))
const { DEFAULT_ON_HOUSE_RULE_IDS } = await import(server('ruleset-config.mjs'))

// --- вырезка функций из index.mjs -------------------------------------------

const source = readFileSync(join(root, 'server', 'index.mjs'), 'utf8').replaceAll('\r\n', '\n')
function extract(name) {
  const start = source.search(new RegExp(`^(async )?function ${name}\\(`, 'm'))
  if (start < 0) throw new Error(`Нет функции ${name} в index.mjs`)
  const end = source.indexOf('\n}\n', start)
  if (end < 0) throw new Error(`Нет конца функции ${name}`)
  return source.slice(start, end + 2)
}

const NAMES = [
  'combatMessageId', 'playerMessageId', 'playerNoteFrom', 'playerNoteAuthor', 'recentNarratorTexts',
  'journalRoll', 'journalStakes', 'journalOffscreen', 'journalLetter', 'journalBeast', 'journalEntry',
  'appendRoomJournal', 'journalCandidatesFor', 'persistAuthoritativeProjection', 'latestCampaignState',
  'reconcileCampaignProjection', 'enableDefaultHouseRules', 'persistInteractionProjection',
  'expirePartyDecisionIfNeeded', 'reconcilePartyDecisionPresence', 'partyVoterIdForAccount', 'partyVoterSnapshot',
]
// «Сейчас» сверки задаётся шагом эталона (истечение голосований).
const body = NAMES.map(extract).join('\n').replaceAll('Date.now()', '__now()')

const clock = () => new Date(1_760_000_000_000)
let ids = 0
const idFactory = () => `id-${String(++ids).padStart(6, '0')}`
const eventStore = new FileEventStore({
  rootDir: join(storage, 'engine'),
  reducer: applyGameEvent,
  normalizeState: normalizeCampaignState,
  reducerNormalizesInput: true,
  snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
  reducerVersion: GAME_REDUCER_VERSION,
  clock,
  idFactory,
})
const midRng = { randint: (minimum, maximum) => Math.ceil((minimum + maximum) / 2) }
const diceService = new DiceService({ rng: midRng, idFactory, now: () => clock().toISOString() })
const rulesEngine = new RulesEngine({ diceService })
const authoritativeExecutor = new executorModule.AuthoritativeExecutor({ eventStore, rulesEngine })

let now = 1_760_000_000_000
let connected = new Set()
const deps = {
  createHash,
  getRoom: store.getRoom,
  saveRoom: store.saveRoom,
  listCampaignMemberships: store.listCampaignMemberships,
  eventStore,
  authoritativeExecutor,
  compareProjection,
  normalizeCampaignState,
  CANONICAL_PROJECTION_FIELDS,
  GAME_STATE_PROJECTOR_VERSION,
  JOURNAL_HISTORY_LIMIT: 400,
  offscreenChronicleEntry,
  courierLetterChronicleEntry,
  beastChronicleEntry,
  questDecisionChronicleEntry,
  campaignStoryChronicleEntry,
  officeChronicleEntry,
  finishQuestDecision,
  partyDecisionExpiryEvents: partyDecision.partyDecisionExpiryEvents,
  partyDecisionOpenedEvent: partyDecision.partyDecisionOpenedEvent,
  partyDecisionPresenceEvents: partyDecision.partyDecisionPresenceEvents,
  partyDecisionActiveVoterIds: partyDecision.partyDecisionActiveVoterIds,
  PARTY_DECISION_CAPABILITY: executorModule.PARTY_DECISION_CAPABILITY,
  PRESENCE_CAPABILITY: executorModule.PRESENCE_CAPABILITY,
  CAMPAIGN_RULESET_CAPABILITY: executorModule.CAMPAIGN_RULESET_CAPABILITY,
  DEFAULT_ON_HOUSE_RULE_IDS,
  defaultHouseRuleEvent: campaignRuleset.defaultHouseRuleEvent,
  campaignHouseRuleMetadata: campaignRuleset.campaignHouseRuleMetadata,
  campaignHouseRuleSettings: campaignRuleset.campaignHouseRuleSettings,
  connectedHeroIdsForCampaign: () => new Set(connected),
  __now: () => now,
}
const logs = []
const quietConsole = { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) }
const fns = new Function(...Object.keys(deps), 'console', `${body}\nreturn { ${NAMES.join(', ')} }`)(...Object.values(deps), quietConsole)

// --- шаги -------------------------------------------------------------------

/** `stableJson` хранилища: ключи по возрастанию на всех уровнях. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).sort()) sorted[key] = stable(value[key])
    return sorted
  }
  return value
}
const hashOf = (value) => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')

/**
 * Комната без времени записей летописи (его ставят часы процесса): версия,
 * хеш состояния и хеши полей верхнего уровня (по ним Rust-тест называет
 * разошедшееся поле). Целиком — только с `C1_FULL=1` (отладка, ~20 МБ).
 */
function roomView(room) {
  if (!room) return null
  // JSON-круг: файл комнаты в JS — JSON, `undefined` в нём не живёт.
  const state = room.state ? JSON.parse(JSON.stringify(room.state)) : null
  for (const message of state?.messages ?? []) delete message.timestamp
  if (process.env.C1_FULL === '1') return { version: room.version, state }
  if (!state) return { version: room.version, hash: null, fields: null }
  return {
    version: room.version,
    hash: hashOf(state),
    fields: Object.fromEntries(Object.keys(state).sort().map((key) => [key, hashOf(state[key])])),
    messages: (state.messages ?? []).length,
  }
}

async function journalView(code) {
  try {
    const metadata = await eventStore.getMetadata(code)
    return { head: metadata.state_version, checkpoint: metadata.projection_checkpoint_version ?? 0, hash: metadata.projection_checkpoint_hash ?? null }
  } catch (error) {
    return { error: error.code ?? error.message }
  }
}

const scenarios = []
let scenario = null
let committed = null

function begin(code) {
  scenario = { code, steps: [] }
  scenarios.push(scenario)
  committed = null
}

async function record(step, run) {
  let outcome
  try {
    const value = await run()
    outcome = { room: roomView(value?.state !== undefined && value?.version !== undefined ? value : value?.room ?? null), conflict: value?.conflict ?? null }
  } catch (error) {
    outcome = { error: { message: error.message, code: error.code ?? null } }
  }
  scenario.steps.push({ ...step, outcome, current: roomView(store.getRoom(scenario.code)), journal: await journalView(scenario.code) })
}

function uniqueKeys(events, prefix) {
  return events.map((event, index) => ({ ...event, event_id: `${prefix}-${index + 1}` }))
}

/** Создание кампании как `POST /campaigns` (4555–4577). */
async function create(code, raw) {
  const state = normalizeCampaignState(raw)
  state.sessionCode = code
  state.engine_mode = 'enforce'
  scenario.steps.push({ op: 'create', state: raw })
  const initialized = await eventStore.initializeCampaign({
    campaign_id: code,
    initial_state: state,
    ruleset_id: state.ruleset_id,
    ruleset_version: state.ruleset_version,
    enabled_rule_packs: state.enabled_rule_packs,
    enabled_house_rules: state.enabled_house_rules,
  })
  const saved = store.saveRoom(code, {
    ...initialized.state,
    messages: Array.isArray(initialized.state?.messages) ? initialized.state.messages : [],
    engine_mode: 'enforce',
    state_projector_version: GAME_STATE_PROJECTOR_VERSION,
  }, 0)
  const last = scenario.steps.at(-1)
  last.outcome = { room: roomView(saved.room), value: 'room' }
  last.current = roomView(store.getRoom(code))
  last.journal = await journalView(code)
}

/** Команда через Rules Engine; в эталон уходят готовые события. */
async function command(label, cmd) {
  const loaded = await eventStore.load(scenario.code)
  const plan = rulesEngine.resolvePlan({ proposed_commands: [cmd] }, loaded.state, { isAdmin: true })
  const events = uniqueKeys(plan.events, `${scenario.code}-${label}`)
  committed = await eventStore.commit({
    campaign_id: scenario.code, expected_state_version: loaded.state_version, idempotency_key: `c1:${label}`, command_id: `c1:${label}`, events,
  })
  scenario.steps.push({ op: 'commit', key: `c1:${label}`, events, journal: await journalView(scenario.code) })
}

async function commitRaw(label, events) {
  const loaded = await eventStore.load(scenario.code)
  const keyed = uniqueKeys(events, `${scenario.code}-${label}`)
  committed = await eventStore.commit({
    campaign_id: scenario.code, expected_state_version: loaded.state_version, idempotency_key: `c1:${label}`, command_id: `c1:${label}`, events: keyed,
  })
  scenario.steps.push({ op: 'commit', key: `c1:${label}`, events: keyed, journal: await journalView(scenario.code) })
}

/** `persistAuthoritativeProjection` от головы, от прошлой версии или с чужими событиями. */
async function persist({ at = null, events = 'committed', message = null, force = false, awaitAck = false } = {}) {
  const engine = at === null ? (await eventStore.load(scenario.code)).state : (await eventStore.load(scenario.code, { atVersion: at })).state
  const list = events === 'committed' ? committed?.events ?? [] : events
  await record({ op: 'persist', at, events: events === 'committed' ? 'committed' : list, message, force, await: awaitAck }, async () => {
    const room = fns.persistAuthoritativeProjection(scenario.code, engine, list, message, { forceProjectorRefresh: force, awaitProjection: awaitAck })
    if (room?.projectionAck) await room.projectionAck
    return room
  })
}

async function append(entries) {
  await record({ op: 'append', entries }, async () => fns.appendRoomJournal(scenario.code, entries))
}

async function reconcile(at = now) {
  now = at
  await record({ op: 'reconcile', now: at }, async () => fns.reconcileCampaignProjection(scenario.code))
}

/** Комнату правят мимо проекции (расхождение для сверки). */
async function drift(set, remove = []) {
  const room = store.getRoom(scenario.code)
  const state = { ...room.state, ...set }
  for (const field of remove) delete state[field]
  await record({ op: 'save_room', set, remove, base: room.version }, async () => store.saveRoom(scenario.code, state, room.version))
  // Устаревшая версия — конфликт.
  await record({ op: 'save_room', set: {}, remove: [], base: room.version }, async () => store.saveRoom(scenario.code, room.state, room.version))
}

// --- начальные состояния ----------------------------------------------------

function heroes() {
  return [
    {
      id: 'fighter', character: 'Бран', characterClass: 'fighter', role: 'Воин · ур. 3', level: 3, online: false,
      hp: 12, maxHp: 30, armor: 16, experience: 900,
      abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 8 },
      inventory: [
        { id: 'sword-1', catalog_id: 'srd_5_2_1:longsword', name: 'Длинный меч', quantity: 1 },
        { id: 'ring-1', catalog_id: 'srd_5_2_1:ring-of-protection', name: 'Кольцо защиты', quantity: 1 },
        { id: 'potion-1', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье лечения', quantity: 2 },
      ],
    },
    {
      id: 'wizard', character: 'Мира', characterClass: 'wizard', role: 'Волшебник · ур. 3', level: 3, online: true,
      hp: 14, maxHp: 18, armor: 12, experience: 900,
      abilities: { str: 8, dex: 12, con: 10, int: 16, wis: 12, cha: 10 },
      inventory: [],
    },
  ]
}

function initialState(code, extra = {}) {
  return {
    state_version: 0,
    sessionCode: code,
    campaign: 'Эквивалентность проекции',
    activePlayerId: 'fighter',
    partyMemberIds: ['fighter', 'wizard'],
    players: heroes(),
    enemies: [], actors: [], messages: [], battleLog: [],
    scene: { location: 'Лагерь', cells: [], turn: 1 },
    mechanics: { resources: { fighter: {}, wizard: {} } },
    ...extra,
  }
}

const say = (id, text, extra = {}) => ({ id, speaker: 'player', author: 'Бран', text, ...extra })

// 1. Основной путь: команды из `room-projection-equivalence` с проекцией и
//    репликой игрока, быстрый путь, отставшая проекция, сверка.
begin('C1-FLOW')
await create('C1-FLOW', initialState('C1-FLOW'))
const flow = [
  ['equip', { command_type: 'EquipItem', actor_id: 'fighter', item_id: 'sword-1' }],
  ['equip-ring', { command_type: 'EquipItem', actor_id: 'fighter', item_id: 'ring-1' }],
  ['attune', { command_type: 'AttuneItem', actor_id: 'fighter', item_id: 'ring-1', attuned: true }],
  ['transfer', { command_type: 'TransferItem', actor_id: 'fighter', item_id: 'potion-1', recipient_id: 'wizard', quantity: 1 }],
  ['use-potion', { command_type: 'UseItem', actor_id: 'fighter', item_id: 'potion-1', target_id: 'fighter' }],
  ['rest-start', { command_type: 'StartRest', actor_id: 'fighter', kind: 'short' }],
]
for (const [label, cmd] of flow) {
  await command(label, cmd)
  await persist({ message: say(fns.playerMessageId(`flow:${label}`), `Бран: ${label}`), awaitAck: label === 'equip' })
  if (label === 'attune') await append([{ id: fns.combatMessageId(`flow:${label}`), speaker: 'narrator', text: 'Кольцо теплеет на пальце.' }])
}
// Повтор той же проекции без реплики — быстрый путь равной версии.
await persist({ events: [] })
// Повтор с той же репликой — не удваивается.
await persist({ message: say(fns.playerMessageId('flow:rest-start'), 'Бран: rest-start') })
// Отставшая проекция: состояние не пишется, летопись — да.
await persist({ at: 3, events: [], message: say('late-1', 'Запоздалая реплика') })
// Принудительное обновление (как при сверке).
await persist({ events: [], force: true })
await reconcile()
await append([{ id: 'late-1', text: 'дубль' }, { id: '', text: 'без id' }, { id: 'blank', text: '   ' }])
await append([])
await fns.enableDefaultHouseRules('C1-FLOW').then(() => null)
scenario.steps.push({ op: 'house_rules', current: roomView(store.getRoom('C1-FLOW')), journal: await journalView('C1-FLOW') })
await fns.enableDefaultHouseRules('C1-FLOW').then(() => null)
scenario.steps.push({ op: 'house_rules', current: roomView(store.getRoom('C1-FLOW')), journal: await journalView('C1-FLOW') })

// 2. Предел летописи: 450 записей — остаются последние 400.
begin('C1-LIMIT')
await create('C1-LIMIT', initialState('C1-LIMIT'))
for (let batch = 0; batch < 3; batch += 1) {
  await append(Array.from({ length: 150 }, (_, index) => ({ id: `line-${batch * 150 + index}`, speaker: index % 2 ? 'system' : 'narrator', text: `Строка ${batch * 150 + index}` })))
}
await commitRaw('note', [{ event_type: 'ObjectiveUpdated', payload: { objective: 'Дойти до моста' } }])
await persist({ message: Array.from({ length: 5 }, (_, index) => ({ id: `tail-${index}`, text: `Хвост ${index}` })) })

// 3. Карточки: бросок, ставка, письмо, зверь, знание; карточки из событий.
begin('C1-CARDS')
await create('C1-CARDS', initialState('C1-CARDS'))
await append([
  { id: 'roll-1', speaker: 'narrator', text: 'Бросок', turnConsumed: 1, roll: { value: '14', modifier: 3, total: 17, label: 'Атлетика', success: true }, stakes: { difficulty: 15, skill: 'Атлетика', ability: 'str', difficulty_category: 'средняя', on_failure: 'Сорвётся' } },
  { id: 'roll-2', speaker: 'system', author: '', text: 'Без исхода', roll: { total: 5 }, stakes: { difficulty: 'x' } },
  { id: 'letter-1', text: 'Письмо', letter: { kind: 'delivered', title: '', from: 'Бран', to: 'Мира', text: 'Дошло' }, beast: { kind: 'fed', name: 'Волк', diet_label: 'мясо', text: 'Ест' } },
  { id: 'letter-2', text: 'Плохое письмо', letter: { kind: 'lost', text: 'x' }, beast: { kind: 'tamed', text: '  ' } },
  { id: 'offscreen-1', text: 'Мир', offscreen: { lines: ['а', '', 'б', 'в', 'г'], day: '3', elapsed_minutes: -5 } },
  { id: 'gate-1', text: 'Знание', knowledge_gate: { audience: 'party' }, author: 'x'.repeat(100) },
  { id: 42, text: 'x'.repeat(2100) },
])
await commitRaw('note', [{ event_type: 'ObjectiveUpdated', payload: { objective: 'Найти письмо' } }])
await persist({
  events: [
    { event_id: 'q-1', event_type: 'QuestAccepted', payload: { schema_version: 1, summary: 'Отряд взялся за дело.' } },
    { event_id: 'q-2', event_type: 'QuestResolved', payload: { stay_in_location: true, summary: 'Дело сделано.' } },
    { event_id: 's-1', event_type: 'CampaignStoryCompleted', payload: { schema_version: 1, story_id: 'story-a', title: 'Мост', summary: 'Мост стоит.' } },
    { event_id: 'b-1', event_type: 'BeastFed', payload: { beast_id: 'wolf-1', beast_name: 'Волк', item_name: 'мясо' } },
    { event_id: 'l-1', event_type: 'CourierLetterDelivered', payload: { letter_id: 'letter-a', summary: 'Письмо у адресата.' } },
    { event_id: 'o-1', event_type: 'OfficeHolderInstalled', visibility: 'public', payload: { office_id: 'mayor', title: 'Староста' } },
    { event_id: 'o-2', event_type: 'OfficeVacated', visibility: 'gm_only', payload: { office_id: 'judge', title: 'Судья' } },
  ],
})

// 4. Расхождение комнаты и журнала: правка мимо проекции, снятое движком
//    каноническое поле, поле только комнаты; сверка переписывает.
begin('C1-DRIFT')
await create('C1-DRIFT', initialState('C1-DRIFT', { tacticalTurn: { round: 1 } }))
await drift({ partyName: 'Чужая правка', customNote: 'только комната' })
await reconcile()
await commitRaw('note', [{ event_type: 'ObjectiveUpdated', payload: { objective: 'Сверка' } }])
await drift({ tacticalTurn: { round: 9 } }, ['scene'])
await persist({})
await reconcile()

// 5. Кампании без комнаты и без журнала.
begin('C1-NOROOM')
await eventStore.initializeCampaign({ campaign_id: 'C1-NOROOM', initial_state: normalizeCampaignState(initialState('C1-NOROOM')) })
scenario.steps.push({ op: 'init_only', state: initialState('C1-NOROOM'), journal: await journalView('C1-NOROOM') })
await reconcile()
await persist({ events: [] })
await append([{ id: 'x', text: 'Никуда' }])
begin('C1-NOJOURNAL')
await reconcile()

// 6. Голосование отряда: открытие, повтор, уход голосующего, истечение.
begin('C1-VOTE')
await create('C1-VOTE', initialState('C1-VOTE', { partyDecisionPolicy: { disconnectAction: 'abstain' } }))
const interaction = { id: 'decision-1', type: 'vote', prompt: 'Куда идти?', createdAt: 1_760_000_000_000, options: [{ id: 'left', label: 'Налево' }, { id: 'right', label: 'Направо' }] }
connected = new Set(['fighter', 'wizard'])
await record({ op: 'interaction', interaction, connected: [...connected] }, async () => fns.persistInteractionProjection('C1-VOTE', interaction))
await record({ op: 'interaction', interaction, connected: [...connected] }, async () => fns.persistInteractionProjection('C1-VOTE', interaction))
await record({ op: 'interaction', interaction: { ...interaction, id: 'decision-2' }, connected: [...connected] }, async () => fns.persistInteractionProjection('C1-VOTE', { ...interaction, id: 'decision-2' }))
connected = new Set(['fighter'])
await record({ op: 'presence', connected: [...connected] }, async () => {
  const result = await fns.reconcilePartyDecisionPresence('C1-VOTE')
  return result ? store.getRoom('C1-VOTE') : null
})
begin('C1-EXPIRE')
await create('C1-EXPIRE', initialState('C1-EXPIRE'))
connected = new Set()
await record({ op: 'interaction', interaction, connected: [] }, async () => fns.persistInteractionProjection('C1-EXPIRE', interaction))
await reconcile(1_760_000_000_000 + 1_000)
await reconcile(1_760_000_000_000 + 30 * 24 * 3_600_000)

// 7. Чистые помощники летописи — таблицей.
const helpers = {
  ids: ['k', 'flow:equip', '', 'ключ с пробелом'].map((key) => ({ key, combat: fns.combatMessageId(key), player: fns.playerMessageId(key) })),
  notes: [
    { player_note: '  За\u0000\u0001стражу!\u007f ' }, { player_note: '/why' }, {}, { player_note: 12 }, { player_note: null },
    { player_note: 'x'.repeat(2100) }, { player_note: '\n\tПривет\r\n' },
  ].map((body) => ({ body, note: fns.playerNoteFrom(body) })),
  authors: [
    [{ players: [{ id: 'a', character: 'Борин' }, { id: 'b', name: 'Мира' }] }, null, 'a'],
    [{ players: [{ id: 'a', character: 'Борин' }, { id: 'b', name: 'Мира' }] }, { controller_id: 'b' }, 'wolf'],
    [{ players: [{ id: 'a', character: 'Борин' }] }, { name: 'Волк' }, 'wolf'],
    [{ players: [{ id: 'a', character: '' }] }, null, 'a'],
    [{}, null, null],
    [{ players: [{ id: 1, character: 'Число' }] }, null, '1'],
  ].map(([state, actor, actorId]) => ({ state, actor, actorId, author: fns.playerNoteAuthor(state, actor, actorId) })),
  recent: [6, 1, 0].map((limit) => ({ limit, texts: fns.recentNarratorTexts({ messages: [{ speaker: 'narrator', text: 'a' }, { speaker: 'player', text: 'b' }, { speaker: 'narrator', text: ' ' }, { speaker: 'narrator', text: 'c' }] }, limit) })),
}

const output = { generated_by: 'rust/crates/sk-server/fixtures/gen-c1.mjs', scenarios, helpers, logs }
writeFileSync(join(here, 'c1.json'), `${JSON.stringify(output)}\n`)
rmSync(storage, { recursive: true, force: true })
console.log(`c1.json: ${scenarios.length} сценариев, ${scenarios.reduce((sum, item) => sum + item.steps.length, 0)} шагов`)
