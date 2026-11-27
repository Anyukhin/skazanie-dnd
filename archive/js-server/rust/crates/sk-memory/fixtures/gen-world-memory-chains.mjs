import '../../../fixtures-env.mjs'
// Эталоны цепочек памяти мира `server/world-memory.mjs` для sk-memory:
// `node gen-world-memory-chains.mjs`.
//
// Цепочка — состояние кампании и сотни шагов. Шаг `command` проходит путь
// Rules Engine: `validateWorldMemoryCommand` → `worldMemoryEvent` → событие с
// `event_id`/`command_id` → `applyWorldMemoryEvent` (обычный или
// подготовленный путь). Шаг `event` применяет готовое событие — в том числе
// старые схемы, события последствий с границей знания, мусор. Шаг `state`
// меняет состояние вокруг памяти: время мира, смерти NPC, отряд, должности.
// Цепочки идут в текущем режиме и в `legacy` (`withRetentionMode`), с
// мусорными старыми состояниями на входе.
//
// Для каждого шага записан итог: отказ (код и текст) или хеши проверенной
// команды и события, и хеш памяти после шага (sha256 `JSON.stringify`); у
// первых цепочек — полные значения, у всех — итоговая память.
import { JUNK, plain, rng, server, sha256, write } from './lib.mjs'

const M = await import(server('world-memory'))
const { withRetentionMode } = await import(server('retention-context'))

const random = rng(20261014)
const pick = (list) => random.pick(list)
const maybe = (value, p = 0.75) => (random.chance(p) ? value : undefined)
const hash = (value) => sha256(JSON.stringify(value))

const NAMES = ['Вела', 'Ash Ford', 'Road Wardens', 'Печать архива', 'Хранитель', 'Том Рыбак', '  Мара  Трижды-Мерная ', 'Ｇａｔｅ']
const TEXTS = ['Vela serves the Wardens.', 'Брод закрыт после паводка.', 'Смотритель гасит огонь, когда идут лодки.', '  пробелы   внутри  ', 'Ключ продан на базаре.', '']
const KINDS = ['location', 'npc', 'faction', 'item', 'event', 'concept']
const VIS = ['public', 'party', 'gm_only', 'gm_only', 'party']

let serial = 0
const fresh = (prefix) => `${prefix}:${(serial += 1)}`

function initialMemory() {
  const mode = random.int(0, 3)
  if (mode === 0) return undefined
  if (mode === 1) return {}
  if (mode === 2) return pick(JUNK)
  // Мусорное старое состояние: поля не той формы, лишние ключи, старый индекс.
  return plain({
    entities: [
      { id: 'npc:old', kind: 'npc', name: 'Старый знакомый', visibility: 'party', extra: 1 },
      { id: ' location:old ', kind: 'place', name: '  Старая  площадь ', aliases: ['площадь', 'площадь', 7] },
      { id: '', name: 'Без id' },
      { id: 'npc:old', kind: 'npc', name: 'Дубль', visibility: 'gm_only' },
    ],
    facts: [
      { id: 'fact:old', subject_id: 'npc:old', predicate: 'knows', object: 'Старое сведение', recorded_at_minutes: '15', source_event_ids: ['e0', 'e0', ''] },
      { id: 'fact:orphan', subject_id: 'npc:missing', predicate: 'knows', object: 'Сирота' },
    ],
    quests: [{ id: 'quest:old', title: 'Старое поручение', status: pick(['active', 'offered', 'done']), clock: { current: '1', max: '3' }, entity_ids: ['npc:old'], knowledge_history: 'мусор' }],
    knowledge: { hero: ['fact:old'], 2: { fact_ids: ['fact:old'] } },
    ...(random.chance(0.5) ? { knowledge_revealed: [{ hero_id: 'rogue', fact_id: 'fact:old' }] } : {}),
    summaries: 'не массив',
  })
}

function initialState() {
  return plain({
    partyMemberIds: pick([['hero', 'rogue'], ['hero'], ['hero', 'rogue', '1'], []]),
    mechanics: { world_time: { elapsed_minutes: pick([0, 0, 30, '45', -5, undefined]) } },
    social: { npcs: [{ id: 'npc:keeper', name: 'Хранитель' }, { id: 'npc:vela', name: 'Вела' }, { id: 'npc:mayor', name: 'Бургомистр' }] },
    world_offices: { offices: [{ id: 'office:mayor', holder_npc_id: pick(['npc:mayor', 'npc:vela', undefined]) }] },
    npc_world: { vitals: {}, stances: {} },
    campaignConcept: random.chance(0.5) ? { story_quest_id: pick([null, 'quest:main', undefined]) } : undefined,
    worldMemory: initialMemory(),
  })
}

/** Что сейчас лежит в памяти — чтобы команды ссылались на настоящие записи. */
function pools(memory) {
  const normalized = M.normalizeWorldMemory(memory)
  return {
    entities: normalized.entities.map((entity) => entity.id).filter(Boolean),
    npcs: normalized.entities.filter((entity) => entity.kind === 'npc').map((entity) => entity.id),
    facts: normalized.facts.map((fact) => fact.id).filter(Boolean),
    activeFacts: normalized.facts.filter((fact) => fact.status === 'active').map((fact) => fact.id),
    relationships: normalized.relationships.map((item) => item.id),
    quests: normalized.quests.map((quest) => quest.id),
    questRecords: normalized.quests,
    threads: normalized.threads.map((thread) => thread.id),
    claims: normalized.epistemic_claims.map((claim) => claim.id),
    discovery: normalized.facts.filter((fact) => fact.predicate === 'discovery'),
  }
}

const orNew = (list, prefix, p = 0.5) => (list.length && random.chance(p) ? pick(list) : fresh(prefix))
const someOf = (list, max = 3) => [...new Set(random.some(list, max))]

function command(state, eventIds) {
  const pool = pools(state.worldMemory)
  const entity = () => (pool.entities.length && random.chance(0.85) ? pick(pool.entities) : pick(['npc:missing', 'bad id', '']))
  const sources = () => maybe(someOf([...eventIds.slice(-6), 'event:outside'], 3), 0.8)
  const type = pick([
    'UpsertWorldEntity', 'UpsertWorldEntity', 'RecordWorldFact', 'RecordWorldFact', 'RecordWorldFact', 'RevealWorldFact', 'RecordKnowledgeRevelation',
    'RecordWorldRelationship', 'UpsertQuest', 'UpsertQuest', 'AdvanceQuestClock', 'AdvanceQuestClock', 'ResolveQuest', 'InvalidateQuest',
    'UpsertNarrativeThread', 'AdvanceNarrativeThreadClock', 'RecordNpcBelief', 'RecordRumor', 'ResolveEpistemicClaim', 'RecordNarrativeSummary', 'MoveActor',
  ])
  const base = { command_type: type, ...(random.chance(0.9) ? { command_id: fresh('cmd') } : {}), ...(random.chance(0.1) ? { actor_id: 'hero' } : {}) }
  switch (type) {
    case 'UpsertWorldEntity':
      return { ...base, entity: random.chance(0.05) ? pick(JUNK) : {
        id: random.chance(0.15) ? pick(['npc:keeper', 'npc:vela']) : orNew(pool.entities, pick(['npc', 'location', 'faction', 'item']), 0.3),
        kind: random.chance(0.93) ? pick(KINDS) : 'god',
        name: random.chance(0.95) ? pick(NAMES) : '', summary: maybe(pick(TEXTS)), aliases: maybe(someOf(['брод', 'тракт', 'Вела', ' '], 4)),
        visibility: random.chance(0.95) ? pick(VIS) : 'secret', tags: maybe(someOf(['a', 'b'], 2)), ...(random.chance(0.04) ? { secret_prompt: 'leak' } : {}),
      } }
    case 'RecordWorldFact': {
      const supersedes = random.chance(0.25) ? orNew(pool.activeFacts.length ? pool.activeFacts : pool.facts, 'fact', 0.85) : undefined
      return { ...base, fact: random.chance(0.03) ? pick(JUNK) : {
        id: random.chance(0.06) && pool.facts.length ? pick(pool.facts) : fresh('fact'),
        subject_id: random.chance(0.2) && pool.entities.includes('npc:keeper') ? 'npc:keeper' : entity(),
        predicate: random.chance(0.95) ? pick(['discovery', 'discovery', 'died', 'uses_route', 'quest_progress', 'lore', 'party_deed:theft']) : '',
        object: maybe(pick(TEXTS)), summary: maybe(pick(TEXTS)), visibility: pick(VIS), source_event_ids: sources(),
        ...(supersedes ? { supersedes_fact_id: supersedes } : {}),
      } }
    }
    case 'RevealWorldFact':
    case 'RecordKnowledgeRevelation':
      return { ...base, fact_id: pool.activeFacts.length && random.chance(0.9) ? pick(pool.activeFacts) : 'fact:missing',
        target_ids: pick([['hero'], ['rogue'], ['hero', 'rogue'], ['hero', 'outsider'], [], 'hero', ['1']]), source_event_ids: sources() }
    case 'RecordWorldRelationship':
      return { ...base, relationship: {
        id: random.chance(0.05) && pool.relationships.length ? pick(pool.relationships) : fresh('rel'), from_entity_id: entity(),
        relation: pick(['serves', 'knows', 'fears', '']), to_entity_id: entity(), summary: pick(TEXTS), visibility: pick(VIS), source_event_ids: sources(),
        ...(random.chance(0.2) && pool.relationships.length ? { supersedes_relationship_id: pick(pool.relationships) } : {}),
      } }
    case 'UpsertQuest':
      return { ...base, quest: {
        id: orNew(pool.quests, 'quest', 0.4), title: random.chance(0.95) ? pick(['Найти печать', 'Пропавшие рыбаки', 'Cross Ash Ford', 'Тайна маяка']) : '',
        summary: maybe(pick(TEXTS)), status: maybe(random.chance(0.95) ? pick(['active', 'active', 'offered', 'hidden', 'completed']) : 'done'),
        visibility: maybe(pick(VIS)), entity_ids: maybe(someOf(pool.entities.length ? pool.entities : ['npc:missing'], 2)),
        objectives: maybe(someOf(['Осмотреть брод', 'Найти печать', 'Go to the vault'], 2)),
        clock: maybe(random.chance(0.95) ? { current: random.int(0, 3), max: random.int(1, 5), label: maybe('Rivals') } : pick([{ current: 1, extra: 2 }, 'x'])),
        ...(random.chance(0.25) ? { responsibility: pick([
          { type: 'npc', npc_id: 'npc:keeper', death_policy: 'impossible' }, { type: 'office', office_id: 'office:mayor', death_policy: 'transfer' },
          { type: 'npc', npc_id: 'npc:nobody', death_policy: 'impossible' }, { type: 'npc', npc_id: 'npc:keeper', death_policy: 'ignore' },
        ]) } : {}),
      } }
    case 'AdvanceQuestClock': {
      const quest = pool.questRecords.length ? pick(pool.questRecords) : null
      const proofs = pool.discovery.filter((fact) => quest?.entity_ids.includes(fact.subject_id)).map((fact) => fact.id)
      const amount = pick([1, 1, 2, 0, 21, '3', undefined, 1.5, quest ? quest.clock.max - quest.clock.current : 1])
      return { ...base, quest_id: quest?.id ?? 'quest:missing', ...(amount === undefined ? {} : { amount }),
        ...(random.chance(0.4) ? { proof_fact_ids: random.chance(0.8) ? someOf(proofs.length ? proofs : ['fact:none'], 2) : ['', ' '] } : {}),
        ...(random.chance(0.1) ? { proof_source_event_ids: ['forged'] } : {}) }
    }
    case 'ResolveQuest':
      return { ...base, quest_id: pool.quests.length ? pick(pool.quests) : 'quest:missing', outcome: pick(['success', 'failure', 'abandoned', 'abandoned', 'walked-away']),
        summary: random.chance(0.9) ? pick(TEXTS.filter(Boolean)) : '', next_objective: random.chance(0.9) ? 'Осмотреться в новом месте' : '', source_event_ids: sources(),
        ...(random.chance(0.3) ? { request_fingerprint: pick(['director-fingerprint', 'x'.repeat(200), 7]) } : {}) }
    case 'InvalidateQuest':
      return { ...base, quest_id: pool.quests.length ? pick(pool.quests) : 'quest:missing' }
    case 'UpsertNarrativeThread':
      return { ...base, thread: {
        id: orNew(pool.threads, 'thread', 0.4), title: random.chance(0.95) ? pick(['Клятва стражей', 'The warden oath']) : '', summary: maybe(pick(TEXTS)),
        status: maybe(random.chance(0.95) ? pick(['active', 'hidden', 'resolved']) : 'paused'), visibility: maybe(pick(VIS)),
        entity_ids: maybe(someOf(pool.entities, 2)), quest_ids: maybe(someOf(pool.quests.length ? pool.quests : ['quest:missing'], 2)),
        clock: maybe({ current: random.int(0, 2), max: random.int(2, 4), label: 'Trust' }), source_event_ids: sources(),
      } }
    case 'AdvanceNarrativeThreadClock':
      return { ...base, thread_id: pool.threads.length ? pick(pool.threads) : 'thread:missing', ...(random.chance(0.8) ? { amount: pick([1, 2, 0, 25, '2']) } : {}) }
    case 'RecordNpcBelief':
    case 'RecordRumor':
      return { ...base, claim: {
        id: random.chance(0.05) && pool.claims.length ? pick(pool.claims) : fresh(type === 'RecordRumor' ? 'rumor' : 'belief'),
        holder_entity_id: pool.npcs.length && random.chance(0.85) ? pick(pool.npcs) : entity(), ...(random.chance(0.5) ? { subject_entity_id: entity() } : {}),
        predicate: maybe(pick(['suspects', 'party_deed:theft', 'party_deed:theft', 'discovery', ''])), claim: random.chance(0.95) ? pick(TEXTS.filter(Boolean)) : '', summary: maybe(pick(TEXTS)), visibility: pick(VIS), source_event_ids: sources(),
      } }
    case 'ResolveEpistemicClaim':
      return { ...base, claim_id: pool.claims.length ? pick(pool.claims) : 'claim:missing', truth_status: pick(['confirmed', 'refuted', 'maybe']),
        source_event_ids: random.chance(0.85) ? someOf([...eventIds.slice(-3), 'event:proof'], 2) : [] }
    case 'RecordNarrativeSummary':
      return { ...base, summary: {
        id: fresh('summary'), kind: maybe(pick(['scene', 'session', 'arc'])), title: random.chance(0.95) ? 'У брода' : '', summary: pick(TEXTS),
        visibility: maybe(pick(VIS)), entity_ids: maybe(someOf(pool.entities, 2)), thread_ids: maybe(someOf(pool.threads.length ? pool.threads : ['thread:missing'], 1)),
        source_event_ids: random.chance(0.9) ? someOf([...eventIds.slice(-4), 'event:scene'], 3) : [],
      } }
    default:
      return { ...base, actor_id: 'hero', to: { x: 1, y: 1 } }
  }
}

function rawEvent(state, eventIds) {
  const pool = pools(state.worldMemory)
  const quest = pool.quests.length ? pick(pool.quests) : 'quest:missing'
  const gate = { visibility: pick(['gm_only', 'party']), recorded_at_minutes: random.int(0, 200), source_event_ids: someOf(eventIds.slice(-3), 2), fact_ids: someOf(pool.facts, 1) }
  const id = random.chance(0.8) ? fresh('event') : undefined
  const event = pick([
    { event_type: 'QuestAccepted', payload: { schema_version: pick([1, 2, 3, undefined]), quest_id: quest, ...(random.chance(0.4) ? { knowledge_gate: gate } : {}) } },
    { event_type: 'QuestAssignmentChanged', payload: { schema_version: pick([1, 2, 2, 3]), quest_id: quest, giver_npc_id: pick(['npc:vela', '', null, ' npc:mayor ']), ...(random.chance(0.6) ? { knowledge_gate: gate } : {}) } },
    { event_type: 'QuestInvalidated', payload: { schema_version: pick([1, 2, 2, 3]), quest_id: quest, outcome: 'failure', summary: pick(['Поручение стало невыполнимым.', '']), knowledge_gate: gate, ...(random.chance(0.3) ? { previous_view: { objective: 'Старая цель' } } : {}) } },
    { event_type: 'QuestResolved', payload: { quest_id: quest, outcome: pick(['success', 'failure', 'abandoned', undefined]), summary: pick(['Итог.', '', undefined]), ...(random.chance(0.4) ? { stay_in_location: true, event_schema_version: pick([2, 1]) } : {}) } },
    { event_type: 'QuestUpserted', payload: { schema_version: 2, ...(random.chance(0.5) ? { knowledge_gate: gate } : {}), quest: { id: quest, title: 'Обновлённое поручение', status: pick(['active', 'failed']), visibility: 'party', clock: { current: 0, max: 2 } } } },
    { event_type: 'QuestClockAdvanced', payload: { quest_id: quest, amount: pick([1, 2, -4, '3', undefined]), ...(random.chance(0.5) ? { schema_version: pick([2, 1]), proof_fact_ids: someOf(pool.facts, 2), proof_source_event_ids: someOf(eventIds.slice(-3), 2) } : {}), ...(random.chance(0.3) ? { knowledge_gate: gate } : {}) } },
    { event_type: 'WorldFactRevealed', target_ids: pick([['hero'], ['rogue', 'hero'], 'hero', [' ', 'hero'], undefined]), payload: { fact_id: pool.facts.length ? pick(pool.facts) : 'fact:x', ...(random.chance(0.3) ? { knowledge_id: pick(['k:custom', '']) } : {}), ...(random.chance(0.3) ? { summary: 'Узнал от Велы' } : {}), ...(random.chance(0.3) ? { source_kind: pick(['npc', 'legacy', 'bad']) } : {}), ...(random.chance(0.3) ? { revealed_at_minutes: pick([5, '7', -1]) } : {}) }, ...(random.chance(0.3) ? { recorded_at_minutes: random.int(0, 99) } : {}) },
    { event_type: 'KnowledgeRevealed', target_ids: pick([['hero'], ['1'], ['rogue']]), payload: { fact_id: pool.facts.length ? pick(pool.facts) : 'fact:x', source_event_ids: someOf(eventIds.slice(-2), 2) } },
    { event_type: 'NarrativeThreadClockAdvanced', payload: { thread_id: pool.threads.length ? pick(pool.threads) : 'thread:x', amount: pick([1, 3, '1', undefined]) } },
    { event_type: 'EpistemicClaimTruthResolved', payload: { claim_id: pool.claims.length ? pick(pool.claims) : 'claim:x', truth_status: pick(['confirmed', 'bogus']), source_event_ids: ['e', 'e', ' '] } },
    { event_type: 'WorldEntityUpserted', payload: {} },
    { event_type: 'WorldFactRecorded', payload: { fact: { id: fresh('fact'), subject_id: pick(pool.entities.length ? pool.entities : ['npc:x']), predicate: 'raw', object: 'Сырое событие', ...(random.chance(0.3) && pool.facts.length ? { supersedes_fact_id: pick(pool.facts) } : {}) } } },
    { event_type: 'NarrativeSummaryRecorded', payload: { summary: { id: pick(['summary:1', fresh('summary')]), title: 'Сводка', summary: 'Без источников' } } },
    { event_type: 'UnknownEvent', payload: { quest_id: quest } },
    { event_type: 'QuestAccepted' },
    { event_type: 'WorldEntityUpserted', payload: null },
  ])
  return { ...event, ...(id ? { event_id: id } : {}), ...(random.chance(0.5) ? { command_id: fresh('cmd') } : {}), ...(random.chance(0.4) ? { visibility: pick(['party', 'gm_only']) } : {}) }
}

function statePatch(state, pool) {
  const kind = random.int(0, 3)
  if (kind === 0) return { mechanics: { world_time: { elapsed_minutes: (Number(state.mechanics?.world_time?.elapsed_minutes) || 0) + random.int(1, 90) } } }
  if (kind === 1) {
    const npc = pick(['npc:keeper', 'npc:vela'])
    return { npc_world: { vitals: { [npc]: { alive: random.chance(0.7) ? false : true } }, stances: {} } }
  }
  if (kind === 2) return { partyMemberIds: pick([['hero', 'rogue'], ['hero'], ['rogue', '1']]) }
  return { autonomy: { director_history: random.some([{ intent: { type: 'advance_quest_clock', quest_id: pick(pool.quests.length ? pool.quests : ['q']) } }, { type: 'advance_quest_clock', quest_id: 'x' }], 2) } }
}

const CONTEXTS = [...Array(10).fill({ isDirector: true }), { isAdmin: true }, { isAdmin: true }, {}, { isAdmin: 'true' }]

function runChain(index) {
  const full = index < 3
  const mode = index % 4 === 3 ? 'legacy' : 'current'
  const usePrepared = random.chance(0.6)
  const initial = initialState()
  let state = plain(initial)
  if (usePrepared) state.worldMemory = M.normalizeWorldMemory(state.worldMemory)
  const startState = plain(state)
  let memory = state.worldMemory
  const eventIds = []
  const steps = []
  const length = index < 4 ? random.int(280, 420) : random.int(40, 160)
  // Каждая третья цепочка проходит сценарий гибели получателя поручения:
  // сущность, поручение с ответственным NPC, смерть, факт смерти, невозможность.
  const keeperQuest = fresh('quest:keeper')
  const script = index % 3 === 0 ? new Map([
    [3, { command_type: 'UpsertWorldEntity', command_id: fresh('cmd'), entity: { id: 'npc:keeper', kind: 'npc', name: 'Хранитель', visibility: 'party' } }],
    [5, { command_type: 'UpsertQuest', command_id: fresh('cmd'), quest: { id: keeperQuest, title: 'Встретить хранителя', visibility: pick(['party', 'gm_only']), entity_ids: ['npc:keeper'], status: pick(['active', 'offered']), responsibility: { type: 'npc', npc_id: 'npc:keeper', death_policy: 'impossible' } } }],
    [20, { patch: { npc_world: { vitals: { 'npc:keeper': { alive: false } }, stances: {} } } }],
    [21, { command_type: 'RecordWorldFact', command_id: fresh('cmd'), fact: { id: fresh('fact:died'), subject_id: 'npc:keeper', predicate: 'died', object: 'У северных ворот', visibility: pick(['gm_only', 'party']), source_event_ids: ['event:death'] } }],
    [22, { command_type: 'InvalidateQuest', command_id: fresh('cmd'), quest_id: keeperQuest }],
    [23, { command_type: 'InvalidateQuest', command_id: fresh('cmd'), quest_id: keeperQuest }],
  ]) : new Map()
  for (let step = 0; step < length; step += 1) {
    const scripted = script.get(step)
    const roll = scripted ? (scripted.patch ? 0 : 1) : random.next()
    if (roll < 0.06) {
      const patch = plain(scripted?.patch ?? statePatch(state, pools(memory)))
      state = { ...state, ...patch }
      steps.push({ kind: 'state', patch })
      continue
    }
    const prepared = usePrepared && random.chance(0.7)
    if (roll < 0.22) {
      const event = plain(rawEvent({ ...state, worldMemory: memory }, eventIds))
      let next
      try {
        next = M.applyWorldMemoryEvent(plain(memory), plain(event), { prepared })
      } catch {
        continue
      }
      memory = plain(next)
      if (event.event_id) eventIds.push(event.event_id)
      steps.push({ kind: 'event', event, prepared, memory_hash: hash(memory), ...(full && step % 20 === 0 ? { memory } : {}) })
      continue
    }
    const raw = plain(scripted ?? command({ ...state, worldMemory: memory }, eventIds))
    const context = scripted ? { isDirector: true } : pick(CONTEXTS)
    let validated
    try {
      validated = M.validateWorldMemoryCommand(plain(raw), { ...state, worldMemory: memory }, context)
    } catch (error) {
      if (!error.code) continue
      steps.push({ kind: 'command', command: raw, context, throws: { code: error.code, message: error.message } })
      continue
    }
    validated = plain(validated)
    const emitted = M.worldMemoryEvent(plain(validated))
    const entry = { kind: 'command', command: raw, context, prepared, validated_hash: hash(validated), ...(full ? { validated } : {}) }
    if (!emitted) {
      steps.push({ ...entry, event_hash: null })
      continue
    }
    const eventId = fresh('memory-event')
    const event = plain({ ...emitted, event_id: eventId, command_id: validated.command_id })
    let next
    try {
      next = M.applyWorldMemoryEvent(plain(memory), plain(event), { prepared })
    } catch {
      continue
    }
    memory = plain(next)
    eventIds.push(eventId)
    steps.push({ ...entry, event_id: eventId, event_hash: hash(event), ...(full ? { event } : {}), memory_hash: hash(memory), ...(full && step % 20 === 0 ? { memory } : {}) })
  }
  const finalJson = JSON.stringify(memory)
  return { mode, initial: startState, steps, final_hash: sha256(finalJson), ...(finalJson.length < 80_000 ? { final: memory } : {}) }
}

const chains = []
for (let index = 0; index < 48; index += 1) {
  const mode = index % 4 === 3 ? 'legacy' : 'current'
  chains.push(mode === 'legacy' ? withRetentionMode('legacy', () => runChain(index)) : runChain(index))
}

// Прямые вызовы `worldMemoryEvent` и проверки на голых командах.
const direct = []
for (const command of [
  { command_type: 'ResolveQuest', quest_id: 'quest:find-seal', outcome: 'success', summary: 'Done.', next_objective: 'Next.', source_event_ids: [] },
  { command_type: 'ResolveQuest', quest_id: 'q', outcome: 'weird' },
  { command_type: 'ResolveQuest', request_fingerprint: 'f'.repeat(300) },
  { command_type: 'InvalidateQuest' }, { command_type: 'InvalidateQuest', invalidation: null }, { command_type: 'UpsertWorldEntity' },
  { command_type: 'RevealWorldFact', fact_id: 'f', target_ids: ['hero'] }, { command_type: 'RecordKnowledgeRevelation', fact_id: 'f', source_event_ids: null },
  { command_type: 'AdvanceQuestClock', quest_id: 'q', amount: 2, proof_fact_ids: ['a'] }, { command_type: 'AdvanceQuestClock', quest_id: 'q', proof_fact_ids: [] },
  { command_type: 'AdvanceQuestClock', quest_id: 'q', proof_fact_ids: 'ab' },
  { command_type: 'MoveActor' }, {}, { command_type: 7 },
]) direct.push({ command, event: M.worldMemoryEvent(plain(command)) ?? null })

const total = chains.reduce((sum, chain) => sum + chain.steps.length, 0)
write('world-memory-chains.json', { chains, direct, cases: [], skipped: 0 })
console.log(`цепочек ${chains.length}, шагов ${total}`)
