import '../../../fixtures-env.mjs'
// Эталоны нормализации, диагностики и проекции для зрителя
// `server/world-memory.mjs` для sk-memory: `node gen-world-memory-normalize.mjs`.
//
// Память собирается случайно из «мусора» старых кампаний: пустые и лишние
// поля, числа строками, пробелы и полноширинные знаки, ключи-индексы героев,
// битые ссылки, повторы id, коллекции не того типа, старый индекс знаний
// рядом с журналом. Каждая память прогоняется через нормализацию (текущую и
// `legacy`), диагностику и проекцию для ведущего, героев и чужих читателей с
// историческим моментом. Отдельно — хеши большой памяти за прежними
// пределами коллекций (вход строит тот же цикл в Rust-тесте).
import { JUNK, collector, plain, rng, server, sha256, write } from './lib.mjs'

const M = await import(server('world-memory'))
const { withRetentionMode } = await import(server('retention-context'))

const random = rng(777)
const c = collector({ hashOver: 6_000 })

const ENTITY_IDS = ['npc:vela', 'location:ford', 'faction:wardens', 'item:seal', 'npc:keeper', '5', 'npc:missing', '', ' npc:vela ']
const FACT_IDS = ['fact:a', 'fact:b', 'fact:c', 'fact:d', 'fact:e', '1', '', 'fact:a ']
const HEROES = ['hero', 'rogue', '1', '2', '10', ' hero ', '']
const SHORT_TEXTS = ['Vela serves the Wardens.', 'Брод закрыт после паводка.', '  много   пробелов  ', 'Ｆｕｌｌ ｗｉｄｔｈ', 'ё и Ё', 'a\nb\tc', '', 5, null, undefined]
const LONG_TEXTS = ['x'.repeat(130), 'я'.repeat(1_100), 'слово '.repeat(400)]
const TEXTS = Symbol('TEXTS')
const VIS = ['public', 'party', 'gm_only', 'specific_player', '', 'PARTY', undefined, null, 3]

// Длинные строки редки: иначе эталон раздувается без пользы.
const pick = (list) => (list === TEXTS ? random.pick(random.chance(0.04) ? LONG_TEXTS : SHORT_TEXTS) : random.pick(list))
const maybe = (value, p = 0.7) => (random.chance(p) ? value : undefined)
const junkOr = (value, p = 0.12) => (random.chance(p) ? pick(JUNK) : value)
const someOf = (list, max) => random.some(list, max)
const minutes = () => pick([0, 0, 5, 10, 60, 120, '30', -3, 1.5, null, undefined, 2 ** 53])

function clock() {
  return pick([undefined, {}, { current: 1, max: 3, label: 'Rivals' }, { current: 9, max: 2 }, { current: -1, max: 200, label: 7 }, { current: '2', max: '4' }, { max: 0 }, 'x', []])
}

function history() {
  return pick([undefined, [], [{ schema_version: 1, event_id: 'event:q', previous: { status: 'active', summary: 'Было' }, knowledge_gate: { visibility: 'gm_only', recorded_at_minutes: 100, source_event_ids: ['event:death'], fact_ids: ['fact:a'] } }],
    [{ schema_version: 2, event_id: 'x', previous: {}, knowledge_gate: {} }, { schema_version: 1, event_id: 'y', previous: { title: 'Старое' }, knowledge_gate: { visibility: 'party' }, absent_fields: ['giver_npc_id'] }], 'не массив'])
}

function memory() {
  const result = {}
  if (random.chance(0.9)) {
    result.entities = Array.from({ length: random.int(0, 7) }, () => ({
      id: junkOr(pick(ENTITY_IDS)), kind: junkOr(pick(['npc', 'location', 'faction', 'item', 'event', 'concept', 'god', ' npc '])),
      name: junkOr(pick(['Vela', 'Ash Ford', 'Road Wardens', 'Печать', 'Хранитель', '', '  Вела  '])), summary: maybe(pick(TEXTS)),
      aliases: maybe(junkOr(someOf(['old trail', 'брод', ' ', 'брод', 7, null], 25))), visibility: pick(VIS), tags: maybe(someOf(['a', 'b', 'a', '  c '], 25)),
      ...(random.chance(0.1) ? { extra: 'поле' } : {}),
    }))
  }
  if (random.chance(0.9)) {
    result.facts = Array.from({ length: random.int(0, 8) }, () => ({
      id: junkOr(pick(FACT_IDS)), subject_id: junkOr(pick(ENTITY_IDS)), predicate: junkOr(pick(['died', 'discovery', 'uses_route', '', 'gm_secret'])),
      object: maybe(pick(TEXTS)), summary: maybe(pick(TEXTS)), visibility: pick(VIS),
      source_event_ids: maybe(junkOr(someOf(['e1', 'e2', 'e1', '', ' e3 '], 35))), source_command_id: maybe(pick(['cmd', '', 7])),
      supersedes_fact_id: maybe(pick(FACT_IDS)), status: maybe(pick(['active', 'superseded', 'retired'])), recorded_at_minutes: minutes(),
    }))
  }
  if (random.chance(0.8)) {
    result.relationships = Array.from({ length: random.int(0, 6) }, () => ({
      id: junkOr(pick(['rel:1', 'rel:2', 'rel:1', ''])), from_entity_id: pick(ENTITY_IDS), relation: pick(['serves', 'knows', '']), to_entity_id: pick(ENTITY_IDS),
      summary: maybe(pick(TEXTS)), visibility: pick(VIS), source_event_ids: maybe(someOf(['e1', 'e2'], 35)), status: maybe(pick(['active', 'superseded', 'x'])),
      supersedes_relationship_id: maybe(pick(['rel:1', ''])), recorded_at_minutes: minutes(),
    }))
  }
  if (random.chance(0.85)) {
    result.quests = Array.from({ length: random.int(0, 6) }, () => ({
      id: junkOr(pick(['quest:1', 'quest:2', 'quest:1', '', 'quest:chapter:1'])), title: junkOr(pick(['Find the Seal', 'Пропавшие рыбаки', '', '  Брод  '])),
      summary: maybe(pick(TEXTS)), status: maybe(pick(['hidden', 'offered', 'active', 'completed', 'failed', 'abandoned', 'done'])), visibility: pick(VIS),
      entity_ids: maybe(junkOr(someOf(ENTITY_IDS, 35))), objectives: maybe(someOf(['Go to the vault', 'Найти печать', ''], 25)), clock: clock(),
      recorded_at_minutes: minutes(), ...(random.chance(0.2) ? { stay_in_location: pick([true, 'true', 1]) } : {}),
      ...(random.chance(0.3) ? { responsibility: pick([{ type: 'npc', npc_id: 'npc:keeper', death_policy: 'impossible' }, { type: 'office', office_id: 'office:mayor', death_policy: 'transfer', schema_version: 1 }, { type: 'npc', npc_id: 'bad id', death_policy: 'impossible' }, { schema_version: 2, type: 'npc' }, 'x']), giver_npc_id: maybe(pick(['npc:keeper', '', null])) } : {}),
      ...(random.chance(0.3) ? { progress_fact_ids: someOf(['fact:a', 'fact:b', ''], 3) } : {}),
      ...(random.chance(0.2) ? { progress_source_event_ids: someOf(['e1', 'e2'], 3) } : {}),
      ...(random.chance(0.3) ? { knowledge_history: history() } : {}),
    }))
  }
  if (random.chance(0.8)) {
    result.threads = Array.from({ length: random.int(0, 5) }, () => ({
      id: junkOr(pick(['thread:1', 'thread:2', ''])), title: pick(['The oath', 'Клятва', '']), summary: maybe(pick(TEXTS)),
      status: maybe(pick(['hidden', 'active', 'resolved', 'failed', 'abandoned', 'paused'])), visibility: pick(VIS),
      entity_ids: maybe(someOf(ENTITY_IDS, 35)), quest_ids: maybe(someOf(['quest:1', 'quest:2', 'quest:x'], 35)), clock: clock(),
      source_event_ids: maybe(someOf(['e1'], 2)), source_command_id: maybe('cmd'), recorded_at_minutes: minutes(),
    }))
  }
  if (random.chance(0.8)) {
    result.epistemic_claims = Array.from({ length: random.int(0, 6) }, () => ({
      id: junkOr(pick(['belief:1', 'rumor:1', 'belief:1', ''])), kind: maybe(pick(['belief', 'rumor', 'lie'])), holder_entity_id: pick(ENTITY_IDS),
      subject_entity_id: maybe(pick(ENTITY_IDS)), predicate: maybe('suspects'), claim: pick(['Smugglers crossed.', '', 'Вела подозревает стражу.']),
      summary: maybe(pick(TEXTS)), visibility: pick(VIS), truth_status: maybe(pick(['unknown', 'confirmed', 'refuted', 'maybe'])),
      source_event_ids: maybe(someOf(['e1', 'e2'], 35)), truth_source_event_ids: maybe(someOf(['e9'], 35)), recorded_at_minutes: minutes(),
    }))
  }
  if (random.chance(0.8)) {
    result.summaries = Array.from({ length: random.int(0, 5) }, () => ({
      id: junkOr(pick(['summary:1', 'summary:2', ''])), kind: maybe(pick(['scene', 'session', 'arc'])), title: pick(['At the ford', '', 'У брода']),
      summary: pick(TEXTS), visibility: pick(VIS), entity_ids: maybe(someOf(ENTITY_IDS, 35)), thread_ids: maybe(someOf(['thread:1', 'thread:x'], 35)),
      source_event_ids: maybe(someOf(['e1', 'e2'], 55)), recorded_at_minutes: minutes(),
    }))
  }
  const ledger = () => Array.from({ length: random.int(0, 8) }, () => ({
    ...(random.chance(0.8) ? { id: pick(['k1', 'k2', 'k1', '', 'k3']) } : {}), hero_id: pick(HEROES), fact_id: pick(FACT_IDS),
    summary: maybe(pick(TEXTS)), source_event_ids: maybe(someOf(['e1', 'e2'], 35)), source_command_id: maybe('cmd'),
    revealed_event_id: maybe(pick(['ev1', '', 7])), source_kind: maybe(pick(['legacy', 'world_fact_revealed', 'knowledge_revealed', 'npc', 'other'])), recorded_at_minutes: minutes(),
  }))
  const ledgerMode = random.int(0, 5)
  if (ledgerMode === 0) result.knowledge_ledger = ledger()
  if (ledgerMode === 1) result.knowledge_revealed = ledger()
  if (ledgerMode === 2) { result.knowledge_ledger = ledger(); result.knowledge_revealed = ledger() }
  if (ledgerMode === 3) { result.knowledge_ledger = pick([null, 'x', {}]); result.knowledge_revealed = ledger() }
  if (random.chance(0.5)) {
    result.knowledge = pick([
      { hero: someOf(FACT_IDS, 4), rogue: { fact_ids: someOf(FACT_IDS, 3) }, 2: ['fact:a'], 1: ['fact:b', 'fact:a'] },
      { ' hero ': ['fact:c'], '': ['fact:a'], hero: 'fact:a' },
      ['fact:a'], [['fact:b']], 'fact', 5, null,
    ])
  }
  if (random.chance(0.1)) result[pick(['entities', 'facts', 'quests', 'summaries', 'knowledge_ledger'])] = pick(['строка', 5, { id: 'x' }])
  if (random.chance(0.05)) result.schema_version = pick([1, 2, 'x'])
  return plain(result)
}

const VIEWERS = [
  { isAdmin: true }, { isAdmin: true, asOfMinutes: 30 }, { playerId: 'hero', isPartyMember: true }, { playerId: 'rogue', isPartyMember: true },
  { playerId: 'hero', isPartyMember: false }, { playerId: 'hero' }, { playerId: '1', isPartyMember: true, asOfMinutes: 10 },
  { playerId: 'hero', isPartyMember: true, asOfMinutes: 0 }, { playerId: 'hero', as_of_minutes: null }, { playerId: 'hero', asOfMinutes: '60' },
  { playerId: 'hero', asOfMinutes: -5 }, { playerId: 'hero', asOfMinutes: 2.5 }, {}, { isAdmin: 1 }, { playerId: ' hero ', isPartyMember: true },
]

for (let index = 0; index < 240; index += 1) {
  const input = random.chance(0.03) ? pick(JUNK) : memory()
  c.call('normalizeWorldMemory', M.normalizeWorldMemory, [input])
  c.call('normalizeWorldMemoryLegacy', M.normalizeWorldMemoryLegacy, [input])
  c.call('normalizeWorldMemory@legacy', (value) => withRetentionMode('legacy', () => M.normalizeWorldMemory(value)), [input])
  c.call('diagnoseWorldMemory', M.diagnoseWorldMemory, [input])
  let normalized
  try { normalized = plain(M.normalizeWorldMemory(input)) } catch { continue }
  c.call('normalizeWorldMemory', M.normalizeWorldMemory, [normalized])
  c.call('diagnoseWorldMemory', M.diagnoseWorldMemory, [normalized])
  for (const viewer of random.shuffle(VIEWERS).slice(0, 4)) {
    c.call('worldMemoryForViewer', M.worldMemoryForViewer, [random.chance(0.8) ? normalized : input, viewer])
  }
  c.call('worldMemoryForViewer@legacy', (value, viewer) => withRetentionMode('legacy', () => M.worldMemoryForViewer(value, viewer)), [input, pick(VIEWERS)])
}

// Тест «историческая проекция игрока скрывает последствие до раскрытия знания».
const consequence = {
  entities: [{ id: 'npc:keeper', kind: 'npc', name: 'Keeper', visibility: 'party' }],
  facts: [{ id: 'fact:keeper-dead', subject_id: 'npc:keeper', predicate: 'died', object: 'North Gate', summary: 'Keeper died at the North Gate.', visibility: 'gm_only', recorded_at_minutes: 100, source_event_ids: ['event:death'] }],
  quests: [{
    id: 'quest:keeper', title: 'Meet the keeper', summary: 'Find the keeper.', status: 'failed', visibility: 'party',
    knowledge_history: [{ schema_version: 1, event_id: 'event:quest-invalidated', previous: { status: 'active', summary: 'Find the keeper.' }, knowledge_gate: { visibility: 'gm_only', recorded_at_minutes: 100, source_event_ids: ['event:death'], fact_ids: ['fact:keeper-dead'] } }],
  }],
  knowledge_ledger: [{ id: 'knowledge:death', hero_id: 'hero', fact_id: 'fact:keeper-dead', recorded_at_minutes: 200, source_kind: 'knowledge_revealed' }],
}
for (const viewer of [...VIEWERS, { playerId: 'hero', isPartyMember: true, asOfMinutes: 150 }, { playerId: 'hero', isPartyMember: true, asOfMinutes: 250 }]) {
  c.call('worldMemoryForViewer', M.worldMemoryForViewer, [consequence, viewer])
}

// Большая память за прежними пределами коллекций (`test/world-memory.test.mjs`).
function bigMemory() {
  const entities = Array.from({ length: 501 }, (_, index) => ({ id: `npc:long-${index}`, kind: 'npc', name: `Long NPC ${index}`, visibility: 'gm_only' }))
  const facts = Array.from({ length: 2_001 }, (_, index) => ({ id: `fact:long-${index}`, subject_id: `npc:long-${index % entities.length}`, predicate: 'remembered', object: `Fact ${index}`, visibility: 'gm_only' }))
  const relationships = Array.from({ length: 2_001 }, (_, index) => ({ id: `relationship:long-${index}`, from_entity_id: `npc:long-${index % entities.length}`, relation: 'knows', to_entity_id: `npc:long-${(index + 1) % entities.length}`, summary: `Relationship ${index}`, visibility: 'gm_only' }))
  const quests = Array.from({ length: 301 }, (_, index) => ({ id: `quest:long-${index}`, title: `Quest ${index}`, summary: `Quest summary ${index}`, status: 'active', visibility: 'gm_only' }))
  const threads = Array.from({ length: 501 }, (_, index) => ({ id: `thread:long-${index}`, title: `Thread ${index}`, summary: `Thread summary ${index}`, status: 'active', visibility: 'gm_only' }))
  const claims = Array.from({ length: 2_001 }, (_, index) => ({ id: `belief:long-${index}`, holder_entity_id: `npc:long-${index % entities.length}`, claim: `Belief ${index}`, visibility: 'gm_only' }))
  const summaries = Array.from({ length: 1_001 }, (_, index) => ({ id: `summary:long-${index}`, kind: 'scene', title: `Summary ${index}`, summary: `Summary text ${index}`, visibility: 'gm_only' }))
  const knowledge_ledger = Array.from({ length: 5_001 }, (_, index) => ({ id: `knowledge:long-${index}`, hero_id: 'hero', fact_id: `fact:long-${index % facts.length}`, source_kind: 'knowledge_revealed' }))
  return { entities, facts, relationships, quests, threads, epistemic_claims: claims, summaries, knowledge_ledger }
}
const big = bigMemory()
const legacyIndex = { entities: big.entities, facts: big.facts, knowledge: { hero: big.facts.map((fact) => fact.id) } }
const hash = (value) => sha256(JSON.stringify(value))
const bigHashes = {
  current: hash(M.normalizeWorldMemory(big)),
  legacy: hash(M.normalizeWorldMemoryLegacy(big)),
  legacyIndex: hash(M.normalizeWorldMemory(legacyIndex)),
  diagnose: hash(M.diagnoseWorldMemory(big)),
  viewer: hash(M.worldMemoryForViewer(big, { playerId: 'hero', isPartyMember: true })),
}

write('world-memory-normalize.json', { bigHashes, cases: c.cases, values: c.values, skipped: c.skipped })
