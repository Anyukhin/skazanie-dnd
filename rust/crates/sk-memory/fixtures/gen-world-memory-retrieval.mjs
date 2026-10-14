import '../../../fixtures-env.mjs'
// Эталоны поиска по памяти мира `server/world-memory.mjs` для sk-memory:
// `node gen-world-memory-retrieval.mjs`.
//
// Память: граф из `test/world-memory-graph-retrieval.test.mjs` (Григ, Братство
// Ворона, лорд, рыбаки), мост Rules Engine из `test/world-memory-engine.test.mjs`
// (Вела, стража, слух о ключе), кампании авторских миров с добавленными
// отношениями, нитями, слухами и сводками, и случайная память. Сотни вопросов
// — имена и падежи, псевдонимы, синонимы, служебные слова, английский, числа,
// мусор — для ведущего, героев, чужого читателя и исторического момента, с
// разными пределами, без шага по графу и с честным пустым ответом.
import { JUNK, collector, plain, rng, server, write } from './lib.mjs'

const M = await import(server('world-memory'))
const { CampaignBootstrapper } = await import(server('campaign-bootstrap'))
const { listWorldTemplates } = await import(server('world-template-catalog'))

const random = rng(31337)
const pick = (list) => random.pick(list)
const c = collector({ hashOver: 12_000 })

function graphMemory() {
  const entity = (id, kind, name, visibility, aliases = []) => ({ id, kind, name, summary: '', aliases, visibility, tags: [] })
  const fact = (id, subject_id, summary, visibility = 'party', minutes = 0) => ({
    id, subject_id, predicate: 'note', object: summary.slice(0, 40), summary, visibility, source_event_ids: [`event:${id}`], status: 'active', recorded_at_minutes: minutes,
  })
  const relationship = (id, from_entity_id, relation, to_entity_id, visibility = 'party') => ({
    id, from_entity_id, relation, to_entity_id, summary: `${from_entity_id} ${relation} ${to_entity_id}`, visibility, source_event_ids: [`event:${id}`], status: 'active', recorded_at_minutes: 0,
  })
  return {
    schema_version: 2,
    entities: [
      entity('npc:grig', 'npc', 'Григ Одноглазый', 'party', ['Григ']), entity('faction:crows', 'faction', 'Братство Ворона', 'party'),
      entity('npc:lord', 'npc', 'лорд Воронов', 'public'), entity('npc:tom', 'npc', 'Том Рыбак', 'public', ['Том']),
      entity('location:caves', 'location', 'Пещеры Шёпота', 'party'), entity('location:inn', 'location', 'Таверна у моста', 'public'),
      entity('location:town', 'location', 'Город Солёный Мыс', 'public', ['Мыс', 'деревня']), entity('faction:guild', 'faction', 'Гильдия Сетей', 'gm_only'),
    ],
    facts: [
      fact('fact:grig-eye', 'npc:grig', 'Потерял глаз в поножовщине на причале.'), fact('fact:crows-wine', 'faction:crows', 'Возят контрабандное вино мимо таможни по ночам.'),
      fact('fact:lord-tax', 'npc:lord', 'Поднял пошлину на улов вдвое.', 'public'), fact('fact:caves-tracks', 'location:caves', 'У входа следы волочения и обрывок сети.'),
      fact('fact:inn-price', 'location:inn', 'Комната на ночь стоит серебряную монету.', 'public'), fact('fact:storm-rumor', 'location:inn', 'Жрец твердит, что буря была карой за жадность.', 'public'),
      fact('fact:town-road', 'location:town', 'Старый тракт к городу размыло, путь лежит через перевал.', 'public', 30),
      fact('fact:guild-threat', 'faction:guild', 'Гильдия угрожает рыбакам, которые продают улов мимо неё.', 'gm_only'),
      fact('fact:late', 'npc:tom', 'Том вернулся с промысла поздно ночью.', 'party', 120),
    ],
    relationships: [
      relationship('rel:grig-crows', 'npc:grig', 'member_of', 'faction:crows'), relationship('rel:grig-lord', 'npc:grig', 'secretly_serves', 'npc:lord', 'gm_only'),
      relationship('rel:tom-guild', 'npc:tom', 'owes', 'faction:guild', 'party'),
    ],
    quests: [{
      id: 'quest:fishers', title: 'Пропавшие рыбаки', summary: 'Найти тех, кто не вернулся с промысла.', status: 'active', visibility: 'party',
      entity_ids: ['npc:tom', 'location:caves'], objectives: ['Осмотреть пещеры'], clock: { current: 0, max: 4, label: '' }, recorded_at_minutes: 0,
      progress_fact_ids: ['fact:caves-tracks'],
    }, {
      id: 'quest:hidden', title: 'Тайна лорда', summary: 'Узнать, кому служит лорд.', status: 'hidden', visibility: 'party', entity_ids: ['npc:lord'], objectives: [], clock: { current: 0, max: 2, label: '' }, recorded_at_minutes: 0,
    }],
    threads: [{ id: 'thread:storm', title: 'Буря и жадность', summary: 'Жрец связывает бурю с пошлиной.', status: 'active', visibility: 'public', entity_ids: ['npc:lord', 'location:inn'], quest_ids: [], clock: { current: 0, max: 3, label: '' }, source_event_ids: [], source_command_id: '', recorded_at_minutes: 0 }],
    epistemic_claims: [
      { id: 'rumor:caves', kind: 'rumor', holder_entity_id: 'npc:tom', subject_entity_id: 'location:caves', predicate: 'heard', claim: 'В пещерах слышали пение по ночам.', summary: 'Слух о пении в пещерах.', visibility: 'party', truth_status: 'unknown', source_event_ids: ['event:talk'], source_command_id: '', truth_source_event_ids: [], truth_source_command_id: '', recorded_at_minutes: 0 },
      { id: 'belief:grig', kind: 'belief', holder_entity_id: 'npc:grig', subject_entity_id: '', predicate: 'thinks', claim: 'Григ думает, что за ним следят.', summary: '', visibility: 'gm_only', truth_status: 'unknown', source_event_ids: [], source_command_id: '', truth_source_event_ids: [], truth_source_command_id: '', recorded_at_minutes: 0 },
    ],
    summaries: [{ id: 'summary:session-1', kind: 'session', title: 'Первая ночь в Мысе', summary: 'Отряд узнал о пропавших рыбаках и пошлине лорда.', visibility: 'party', entity_ids: ['npc:tom'], thread_ids: [], source_event_ids: ['event:s1'], source_command_id: '', recorded_at_minutes: 60 }],
    knowledge_ledger: [{ id: 'knowledge:guild', hero_id: 'hero', fact_id: 'fact:guild-threat', summary: '', source_event_ids: [], source_command_id: '', revealed_event_id: '', source_kind: 'npc', recorded_at_minutes: 90 }],
  }
}

function bridgeMemory() {
  let memory = M.normalizeWorldMemory({})
  const state = { partyMemberIds: ['hero'], mechanics: { world_time: { elapsed_minutes: 0 } } }
  const commands = [
    { command_type: 'UpsertWorldEntity', entity: { id: 'npc:vela', kind: 'npc', name: 'Vela', visibility: 'party' } },
    { command_type: 'UpsertWorldEntity', entity: { id: 'faction:watch', kind: 'faction', name: 'Watch', visibility: 'party' } },
    { command_type: 'RecordWorldRelationship', relationship: { id: 'relationship:vela-watch', from_entity_id: 'npc:vela', relation: 'serves', to_entity_id: 'faction:watch', summary: 'Vela serves the Watch.', visibility: 'party', source_event_ids: ['event:appointment'] } },
    { command_type: 'UpsertNarrativeThread', thread: { id: 'thread:missing-key', title: 'The missing key', summary: 'The vault key is missing.', visibility: 'party', entity_ids: ['npc:vela'], clock: { current: 1, max: 4, label: 'Rivals close in' }, source_event_ids: ['event:key-lost'] } },
    { command_type: 'RecordNpcBelief', claim: { id: 'belief:vela-thief', holder_entity_id: 'npc:vela', subject_entity_id: 'faction:watch', predicate: 'suspects', claim: 'Vela suspects a Watch officer.', summary: 'Vela suspects an officer.', visibility: 'gm_only', source_event_ids: ['event:suspicion'] } },
    { command_type: 'RecordRumor', claim: { id: 'rumor:market-key', holder_entity_id: 'npc:vela', predicate: 'heard', claim: 'The key was sold in the market.', summary: 'A market rumor.', visibility: 'party', source_event_ids: ['event:gossip'] } },
    { command_type: 'RecordNarrativeSummary', summary: { id: 'summary:session-1', kind: 'session', title: 'Session one', summary: 'The party learned that the vault key is missing.', visibility: 'party', entity_ids: ['npc:vela'], thread_ids: ['thread:missing-key'], source_event_ids: ['event:key-lost'] } },
    { command_type: 'UpsertWorldEntity', entity: { id: 'npc:ashen-fox', kind: 'npc', name: 'Ashen Fox', summary: 'A masked courier.', visibility: 'gm_only' } },
    { command_type: 'RecordWorldFact', fact: { id: 'fact:fox-route', subject_id: 'npc:ashen-fox', predicate: 'uses_route', object: 'The courier uses the old aqueduct.', summary: 'Ashen Fox uses the old aqueduct.', visibility: 'gm_only' } },
    { command_type: 'RevealWorldFact', fact_id: 'fact:fox-route', target_ids: ['hero'] },
  ]
  for (const [index, raw] of commands.entries()) {
    const command = M.validateWorldMemoryCommand({ ...raw, command_id: `bridge:${index}` }, { ...state, worldMemory: memory }, { isDirector: true })
    memory = M.applyWorldMemoryEvent(memory, { ...M.worldMemoryEvent(command), event_id: `bridge-event:${index}`, command_id: command.command_id })
  }
  return plain(memory)
}

const hero = { id: 'hero', character: 'Брам', name: 'Игрок', role: 'Жрец · ур. 1', characterClass: 'cleric', level: 1, hp: 11, maxHp: 11, armor: 18, speed: 25, proficiency: 2, abilities: { str: 10, dex: 14, con: 15, int: 12, wis: 16, cha: 8 }, inventory: [], x: 3, y: 2 }

async function worldMemory(template) {
  const state = await new CampaignBootstrapper().create({ code: `RET-${template.slice(0, 10).toUpperCase()}`, worldTemplateId: template, players: [hero] })
  const memory = plain(M.normalizeWorldMemory(state.worldMemory))
  const npcs = state.social?.npcs ?? []
  const entities = memory.entities
  // Отношения, нити, слухи и сводки поверх стартовой памяти мира.
  for (const [index, npc] of npcs.slice(0, 4).entries()) {
    const id = `npc:${index}`
    entities.push({ id, kind: 'npc', name: npc.name, summary: npc.role ?? '', aliases: [String(npc.name).split(' ')[0]], visibility: pick(['party', 'public', 'gm_only']), tags: [] })
    const target = pick(entities)
    memory.relationships.push({ id: `rel:${index}`, from_entity_id: id, relation: pick(['serves', 'fears', 'knows']), to_entity_id: target.id, summary: `${npc.name} и ${target.name}`, visibility: pick(['party', 'gm_only', 'public']), source_event_ids: [], source_command_id: '', supersedes_relationship_id: '', status: pick(['active', 'active', 'superseded']), recorded_at_minutes: random.int(0, 100) })
    memory.facts.push({ id: `fact:goal:${index}`, subject_id: id, predicate: 'goal', object: '', summary: (npc.goals ?? []).join('; '), visibility: pick(['party', 'public', 'gm_only']), source_event_ids: [`e:${index}`], source_command_id: '', supersedes_fact_id: '', status: 'active', recorded_at_minutes: random.int(0, 100) })
    memory.epistemic_claims.push({ id: `rumor:${index}`, kind: 'rumor', holder_entity_id: id, subject_entity_id: pick(entities).id, predicate: 'heard', claim: (npc.beliefs ?? ['Слухи ходят разные.'])[0], summary: '', visibility: pick(['party', 'gm_only']), truth_status: 'unknown', source_event_ids: [], source_command_id: '', truth_source_event_ids: [], truth_source_command_id: '', recorded_at_minutes: 0 })
  }
  memory.threads.push({ id: 'thread:main', title: state.campaignConcept?.hook ?? 'Главная нить', summary: String(state.campaignConcept?.premise ?? '').slice(0, 200), status: 'active', visibility: 'party', entity_ids: entities.slice(0, 2).map((entity) => entity.id), quest_ids: [], clock: { current: 0, max: 3, label: '' }, source_event_ids: [], source_command_id: '', recorded_at_minutes: 0 })
  memory.summaries.push({ id: 'summary:opening', kind: 'scene', title: state.scene?.title ?? 'Начало', summary: String(state.scene?.objective ?? 'Начало пути'), visibility: 'party', entity_ids: [], thread_ids: ['thread:main'], source_event_ids: ['e:opening'], source_command_id: '', recorded_at_minutes: 10 })
  memory.knowledge_ledger.push({ id: 'k:secret', hero_id: 'hero', fact_id: memory.facts.find((fact) => fact.predicate === 'gm_secret')?.id ?? 'none', summary: '', source_event_ids: [], source_command_id: '', revealed_event_id: '', source_kind: 'npc', recorded_at_minutes: 50 })
  return { memory: plain(M.normalizeWorldMemory(memory)), words: [...new Set([...entities.map((entity) => entity.name), ...memory.facts.map((fact) => fact.summary)].join(' ').split(/[^\p{L}]+/u).filter((word) => word.length >= 4))] }
}

const memories = [{ memory: graphMemory(), words: [] }, { memory: bridgeMemory(), words: [] }]
for (const template of listWorldTemplates().map((entry) => entry.id)) memories.push(await worldMemory(template))

const QUERIES = [
  'Чем промышляет Григ?', 'новости по делу о пропавших рыбаках', 'что это?', 'Что известно о драконах?', 'боевой грифон', 'Григ Братство Ворона лорд', '',
  'Григ', 'Григу', 'Григом', 'Одноглазый', 'Братство', 'ворон', 'лорд Воронов', 'пошлина', 'пошлину на улов', 'Том', 'Тома', 'Том Рыбак', 'рыбаки', 'рыбаков',
  'пещеры', 'Пещеры Шёпота', 'шепот', 'таверна', 'комната на ночь', 'серебряная монета', 'буря', 'жрец', 'жадность', 'город', 'деревня', 'столица', 'поселение',
  'дорога', 'путь', 'маршрут', 'тракт', 'route', 'trail', 'слух', 'молва', 'rumor', 'gossip', 'задание', 'квест', 'quest', 'цель', 'гильдия', 'орден', 'guild',
  'опасность', 'угроза', 'враг', 'enemy', 'Мыс', 'Солёный Мыс', 'контрабанда', 'вино', 'таможня', 'следы', 'сеть', 'пение',
  'слух о базаре ключ', 'market key', 'Vela', 'Watch officer', 'vault key', 'Ashen Fox', 'aqueduct', 'old aqueduct courier', 'session one', 'серой гнили',
  'реликвию', 'реликвия', 'organizations', 'routing', 'the and what', '123', 'год 1024', 'ещё раз о ней', 'расскажи про буря', 'кто такой лорд?',
  'Что я знаю про Ashen Fox?', 'ВОРОН', 'Ｇｒｉｇ', 'ёлка', 'Ёжик', 'а', 'ab', 'abc', 'вода, вода, вода', 'рыбак рыбак рыбак',
]

const VIEWERS = [
  { isAdmin: true }, { playerId: 'hero', isPartyMember: true }, { playerId: 'rogue', isPartyMember: true }, { playerId: 'hero', isPartyMember: false },
  { playerId: 'hero', isPartyMember: true, asOfMinutes: 20 }, { isAdmin: true, asOfMinutes: 0 }, {}, { playerId: 'hero' },
]

const OPTIONS = () => ({
  ...(random.chance(0.7) ? { limit: pick([1, 2, 3, 5, 8, 10, 30, 0, 100, '4', null, -1, 2.5]) } : {}),
  ...(random.chance(0.15) ? { neighbours: pick([false, 0, '', true]) } : {}),
  ...(random.chance(0.3) ? { whenUnmatched: pick(['none', 'all', 'other']) } : {}),
  ...(random.chance(0.15) ? { asOfMinutes: pick([0, 25, 100, null, '50']) } : {}),
})

for (const { memory, words } of memories) {
  const queries = [...QUERIES, ...Array.from({ length: 60 }, () => random.some(words, 4).join(' ')), ...JUNK]
  for (const query of queries) {
    for (const viewer of random.shuffle(VIEWERS).slice(0, 2)) {
      c.call('retrieveWorldMemory', M.retrieveWorldMemory, [memory, viewer, { query, ...OPTIONS() }])
    }
    if (random.chance(0.4)) {
      c.call('retrieveKnownWorldMemory', M.retrieveKnownWorldMemory, [memory, {
        viewer: pick(VIEWERS), query, ...(random.chance(0.6) ? { limit: pick([3, 8, 30, null]) } : {}),
        ...(random.chance(0.2) ? { atMinutes: pick([0, 60, null]) } : {}), ...(random.chance(0.2) ? { asOfMinutes: pick([10, 100, null]) } : {}),
      }])
    }
    if (random.chance(0.4)) c.call('knownWorldLore', M.knownWorldLore, random.chance(0.5) ? [memory, query] : [memory, query, pick(VIEWERS)])
  }
  c.call('retrieveWorldMemory', M.retrieveWorldMemory, [memory])
  c.call('retrieveWorldMemory', M.retrieveWorldMemory, [memory, null, { query: 'Григ' }])
  c.call('knownWorldLore', M.knownWorldLore, [memory])
  c.call('retrieveKnownWorldMemory', M.retrieveKnownWorldMemory, [memory])
}

write('world-memory-retrieval.json', { cases: c.cases, values: c.values, skipped: c.skipped })
