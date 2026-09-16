import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { cpus, platform, release, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { performance } from 'node:perf_hooks'

import 'dotenv/config'

import { FileEventStore } from '../server/event-store.mjs'
import {
  applyWorldMemoryEvent,
  normalizeWorldMemory,
  retrieveKnownWorldMemory,
  retrieveWorldMemory,
  worldMemoryForViewer,
} from '../server/world-memory.mjs'
import { campaignConceptForAgent, sceneContextForAgent } from '../server/agent-context.mjs'
import { loadRulePack } from '../server/rule-pack.mjs'
import { RuleRetriever } from '../server/rule-retriever.mjs'
import { applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

const OLD_LIMITS = Object.freeze({
  entities: 500,
  facts: 2_000,
  relationships: 2_000,
  quests: 300,
  threads: 500,
  epistemic_claims: 2_000,
  summaries: 1_000,
  knowledge_ledger: 5_000,
})

const DEFAULT_COUNTS = Object.freeze({
  entities: OLD_LIMITS.entities + 100,
  facts: OLD_LIMITS.facts + 501,
  relationships: OLD_LIMITS.relationships + 501,
  quests: OLD_LIMITS.quests + 100,
  threads: OLD_LIMITS.threads + 100,
  epistemic_claims: OLD_LIMITS.epistemic_claims + 501,
  summaries: OLD_LIMITS.summaries + 200,
  knowledge_ledger: OLD_LIMITS.knowledge_ledger + 1_001,
})

const DEFAULT_BATCH_SIZE = 50
const DEFAULT_SNAPSHOT_EVERY = 500
const CAMPAIGN_ID = 'world-data-measurement'
const FIXED_CLOCK = () => new Date('2026-09-16T00:00:00.000Z')

const clone = (value) => structuredClone(value)
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8')

function sortedObject(value) {
  if (Array.isArray(value)) return value.map(sortedObject)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedObject(value[key])]))
}

function stableJson(value) {
  return JSON.stringify(sortedObject(value))
}

function percentile(values, fraction) {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return Number(sorted[index].toFixed(3))
}

function summaryStats(values) {
  return {
    count: values.length,
    min_ms: values.length ? Number(Math.min(...values).toFixed(3)) : 0,
    p50_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
    max_ms: Number((Math.max(...values, 0)).toFixed(3)),
    mean_ms: values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)) : 0,
  }
}

function timed(operation) {
  const started = performance.now()
  const value = operation()
  return { value, elapsedMs: performance.now() - started }
}

async function timedAsync(operation) {
  const started = performance.now()
  const value = await operation()
  return { value, elapsedMs: performance.now() - started }
}

function memoryUsage() {
  const usage = process.memoryUsage()
  return {
    rss_bytes: usage.rss,
    heap_used_bytes: usage.heapUsed,
    heap_total_bytes: usage.heapTotal,
    external_bytes: usage.external,
    array_buffers_bytes: usage.arrayBuffers,
  }
}

function environmentMetrics() {
  const resource = typeof process.resourceUsage === 'function' ? process.resourceUsage() : null
  return {
    node: process.version, platform: platform(), os_release: release(), arch: process.arch,
    cpu_count: cpus().length, system_memory_bytes: totalmem(),
    max_rss_bytes: Number.isFinite(resource?.maxRSS) ? resource.maxRSS * 1_024 : null,
    run_shape: 'single synthetic measurement; not a p95 or concurrent load test',
  }
}

function maxMemory(left, right) {
  return Object.fromEntries(Object.keys(left).map((key) => [key, Math.max(left[key] ?? 0, right[key] ?? 0)]))
}

function collectFileSizes(rootDir) {
  const totals = { files: 0, bytes: 0, event_log_bytes: 0, snapshot_bytes: 0, metadata_bytes: 0, other_bytes: 0 }
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.isFile()) continue
      const bytes = statSync(path).size
      totals.files += 1
      totals.bytes += bytes
      if (path.includes(`${join('campaigns', '')}`) && path.includes(`${join('events', '')}`)) totals.event_log_bytes += bytes
      else if (path.includes(`${join('campaigns', '')}`) && path.includes(`${join('snapshots', '')}`)) totals.snapshot_bytes += bytes
      else if (path.endsWith('metadata.json')) totals.metadata_bytes += bytes
      else totals.other_bytes += bytes
    }
  }
  walk(rootDir)
  return totals
}

function countMemory(memory) {
  return Object.fromEntries(Object.keys(OLD_LIMITS).map((key) => [
    key,
    Array.isArray(memory?.[key]) ? memory[key].length : 0,
  ]))
}

function memoryState(initialMemory = {}) {
  return {
    state_version: 0,
    sessionCode: 'WORLD-DATA-MEASUREMENT',
    partyMemberIds: ['hero-1', 'hero-2'],
    activePlayerId: 'hero-1',
    campaignConcept: {
      preset: 'measurement',
      premise: 'Синтетическая кампания для измерения долговременной памяти.',
      tone: 'исследовательский',
      boundaries: 'Только синтетические записи.',
    },
    scene: {
      title: 'Измерительная палата',
      location: 'Синтетический архив',
      mood: 'спокойный',
      objective: 'Накопить историю сверх прежних пределов.',
    },
    worldMemory: normalizeWorldMemory(initialMemory),
  }
}

function reduceWorldMemoryState(state, event) {
  return {
    ...state,
    worldMemory: applyWorldMemoryEvent(state.worldMemory, event),
  }
}

// Payload фаз growth уже нормализован. Append-only reducer позволяет большому
// срезу измерять persistence, а не тратить часы на повторную нормализацию тех
// же массивов после каждого события.
function reduceSyntheticWorldMemoryState(state, event) {
  const source = state.worldMemory ?? normalizeWorldMemory({})
  const memory = { ...source }
  const payload = event.payload ?? {}
  const replace = (key, value, id) => { memory[key] = [...(memory[key] ?? []).filter((item) => item.id !== id), value] }
  if (event.event_type === 'WorldEntityUpserted' && payload.entity) replace('entities', clone(payload.entity), payload.entity.id)
  if (event.event_type === 'WorldFactRecorded' && payload.fact) {
    const fact = clone(payload.fact)
    if (fact.supersedes_fact_id) memory.facts = (memory.facts ?? []).map((item) => item.id === fact.supersedes_fact_id ? { ...item, status: 'superseded' } : item)
    memory.facts = [...(memory.facts ?? []), fact]
  }
  if (event.event_type === 'WorldRelationshipRecorded' && payload.relationship) {
    const relationship = clone(payload.relationship)
    if (relationship.supersedes_relationship_id) memory.relationships = (memory.relationships ?? []).map((item) => item.id === relationship.supersedes_relationship_id ? { ...item, status: 'superseded' } : item)
    memory.relationships = [...(memory.relationships ?? []), relationship]
  }
  if (event.event_type === 'QuestUpserted' && payload.quest) replace('quests', clone(payload.quest), payload.quest.id)
  if (event.event_type === 'NarrativeThreadUpserted' && payload.thread) replace('threads', clone(payload.thread), payload.thread.id)
  if ((event.event_type === 'NpcBeliefRecorded' || event.event_type === 'RumorRecorded') && payload.claim) replace('epistemic_claims', clone(payload.claim), payload.claim.id)
  if (event.event_type === 'NarrativeSummaryRecorded' && payload.summary) replace('summaries', clone(payload.summary), payload.summary.id)
  if (event.event_type === 'KnowledgeRevealed' || event.event_type === 'WorldFactRevealed') {
    const entry = {
      id: `knowledge:${event.event_id}`,
      hero_id: String(event.target_ids?.[0] ?? 'hero-1'), fact_id: String(payload.fact_id ?? ''), summary: '',
      source_event_ids: clone(payload.source_event_ids ?? []), source_command_id: String(event.command_id ?? ''),
      revealed_event_id: String(event.event_id ?? ''), source_kind: event.event_type === 'WorldFactRevealed' ? 'world_fact_revealed' : 'knowledge_revealed',
      recorded_at_minutes: 0,
    }
    memory.knowledge_ledger = [...(memory.knowledge_ledger ?? []), entry]
    memory.knowledge_revealed = memory.knowledge_ledger
    memory.knowledge = {
      ...(memory.knowledge ?? {}),
      [entry.hero_id]: [...new Set([...(memory.knowledge?.[entry.hero_id] ?? []), entry.fact_id])],
    }
  }
  return { ...state, worldMemory: memory }
}

const preserveState = (state) => state

function materializeLongState(counts) {
  let state = memoryState()
  for (const event of phaseEvents(counts).flatMap((phase) => phase.events)) state = reduceSyntheticWorldMemoryState(state, event)
  return state
}

function productionTailEvents(counts, tailCount = 10) {
  const base = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0)
  return Array.from({ length: tailCount }, (_, offset) => eventFor('WorldFactRecorded', { fact: {
    id: `fact:measurement-production-tail-${offset + 1}`, subject_id: entityId(1), predicate: 'records_tail_measurement',
    object: `Подтверждённый production tail ${offset + 1}.`, summary: `Production tail ${offset + 1}.`, visibility: 'party',
    source_event_ids: [`production-tail-source-${offset + 1}`], source_command_id: `production-tail-command-${offset + 1}`,
    recorded_at_minutes: base + offset + 1,
  } }, base + offset + 1))
}

function normalizeWorldMemoryState(state) {
  const source = state && typeof state === 'object' ? state : {}
  return {
    ...source,
    worldMemory: normalizeWorldMemory(source.worldMemory),
  }
}

function eventFor(eventType, payload, sequence) {
  return {
    event_id: `measurement-event-${String(sequence).padStart(7, '0')}`,
    event_type: eventType,
    actor_id: null,
    target_ids: eventType === 'WorldFactRevealed' || eventType === 'KnowledgeRevealed' ? ['hero-1'] : [],
    source_rule_ids: [],
    payload,
  }
}

function entityId(index) {
  return `npc:measurement-${index}`
}

function factId(index) {
  return `fact:measurement-${index}`
}

function questId(index) {
  return `quest:measurement-${index}`
}

function threadId(index) {
  return `thread:measurement-${index}`
}

function claimId(index) {
  return `claim:measurement-${index}`
}

function summaryId(index) {
  return `summary:measurement-${index}`
}

function phaseEvents(counts = DEFAULT_COUNTS) {
  const events = []
  const append = (eventType, payload) => events.push(eventFor(eventType, payload, events.length + 1))
  const entityCount = Math.max(1, Number(counts.entities) || DEFAULT_COUNTS.entities)
  const factCount = Math.max(1, Number(counts.facts) || DEFAULT_COUNTS.facts)
  const questCount = Math.max(1, Number(counts.quests) || DEFAULT_COUNTS.quests)
  const threadCount = Math.max(1, Number(counts.threads) || DEFAULT_COUNTS.threads)

  const phases = []
  const addPhase = (name, start, end) => phases.push({ name, events: events.slice(start, end) })

  let start = events.length
  for (let index = 1; index <= entityCount; index += 1) {
    append('WorldEntityUpserted', { entity: {
      id: entityId(index), kind: 'npc', name: `Измерительный NPC ${index}`,
      summary: `Синтетическая запись персонажа ${index}.`,
      aliases: [`архивный персонаж ${index}`], visibility: index % 10 === 0 ? 'party' : 'gm_only', tags: ['measurement'],
    } })
  }
  addPhase('entities', start, events.length)

  start = events.length
  for (let index = 1; index <= factCount; index += 1) {
    append('WorldFactRecorded', { fact: {
      id: factId(index), subject_id: entityId(((index - 1) % entityCount) + 1), predicate: 'records_measurement',
      object: `Синтетическое наблюдение номер ${index} относится к долгой кампании.`,
      summary: `Наблюдение кампании ${index}.`, visibility: index % 10 === 0 ? 'party' : 'gm_only',
      source_event_ids: [`measurement-source-${index}`], source_command_id: `measurement-command-fact-${index}`,
      recorded_at_minutes: index,
    } })
  }
  addPhase('facts', start, events.length)

  start = events.length
  const relationshipCount = Math.max(1, Number(counts.relationships) || DEFAULT_COUNTS.relationships)
  for (let index = 1; index <= relationshipCount; index += 1) {
    const from = ((index - 1) % entityCount) + 1
    const to = (index % entityCount) + 1
    append('WorldRelationshipRecorded', { relationship: {
      id: `relationship:measurement-${index}`, from_entity_id: entityId(from), relation: 'travels_with',
      to_entity_id: entityId(to), summary: `Связь архивного маршрута ${index}.`, visibility: index % 10 === 0 ? 'party' : 'gm_only',
      source_event_ids: [`measurement-source-relation-${index}`], source_command_id: `measurement-command-relation-${index}`,
      recorded_at_minutes: index,
    } })
  }
  addPhase('relationships', start, events.length)

  start = events.length
  for (let index = 1; index <= questCount; index += 1) {
    append('QuestUpserted', { quest: {
      id: questId(index), title: `Измерительное поручение ${index}`,
      summary: `Задание долгой кампании ${index}.`, status: 'active', visibility: 'party',
      entity_ids: [entityId(((index - 1) % entityCount) + 1)], objectives: [`Проверить запись ${index}`],
      clock: { current: 0, max: 4, label: 'Измерение' }, recorded_at_minutes: index,
    } })
  }
  addPhase('quests', start, events.length)

  start = events.length
  for (let index = 1; index <= threadCount; index += 1) {
    append('NarrativeThreadUpserted', { thread: {
      id: threadId(index), title: `Сюжетная нить ${index}`, summary: `Нить истории ${index}.`, status: 'active', visibility: 'party',
      entity_ids: [entityId(((index - 1) % entityCount) + 1)], quest_ids: [questId(((index - 1) % questCount) + 1)],
      clock: { current: 0, max: 4, label: 'Измерение' }, source_event_ids: [`measurement-source-thread-${index}`],
      source_command_id: `measurement-command-thread-${index}`, recorded_at_minutes: index,
    } })
  }
  addPhase('threads', start, events.length)

  start = events.length
  const claimCount = Math.max(1, Number(counts.epistemic_claims) || DEFAULT_COUNTS.epistemic_claims)
  for (let index = 1; index <= claimCount; index += 1) {
    append(index % 2 === 0 ? 'RumorRecorded' : 'NpcBeliefRecorded', { claim: {
      id: claimId(index), kind: index % 2 === 0 ? 'rumor' : 'belief',
      holder_entity_id: entityId(((index - 1) % entityCount) + 1), subject_entity_id: entityId((index % entityCount) + 1),
      predicate: 'mentions_measurement', claim: `Архивный слух или взгляд номер ${index}.`, summary: `Эпистемическая запись ${index}.`,
      visibility: index % 10 === 0 ? 'party' : 'gm_only', truth_status: index % 2 === 0 ? 'unknown' : 'confirmed',
      source_event_ids: [`measurement-source-claim-${index}`], source_command_id: `measurement-command-claim-${index}`,
      recorded_at_minutes: index,
    } })
  }
  addPhase('epistemic_claims', start, events.length)

  start = events.length
  const summaryCount = Math.max(1, Number(counts.summaries) || DEFAULT_COUNTS.summaries)
  for (let index = 1; index <= summaryCount; index += 1) {
    append('NarrativeSummaryRecorded', { summary: {
      id: summaryId(index), kind: index % 2 === 0 ? 'session' : 'scene', title: `Сводка ${index}`,
      summary: `Синтетическая сводка долгой кампании номер ${index}.`, visibility: 'party',
      entity_ids: [entityId(((index - 1) % entityCount) + 1)], thread_ids: [threadId(((index - 1) % threadCount) + 1)],
      source_event_ids: [`measurement-source-summary-${index}`], source_command_id: `measurement-command-summary-${index}`,
      recorded_at_minutes: index,
    } })
  }
  addPhase('summaries', start, events.length)

  start = events.length
  const knowledgeCount = Math.max(1, Number(counts.knowledge_ledger) || DEFAULT_COUNTS.knowledge_ledger)
  for (let index = 1; index <= knowledgeCount; index += 1) {
    append('KnowledgeRevealed', { fact_id: factId(((index - 1) % factCount) + 1), source_event_ids: [`measurement-source-knowledge-${index}`] })
  }
  addPhase('knowledge_ledger', start, events.length)
  return phases
}

export function createLongCampaignPlan(counts = DEFAULT_COUNTS) {
  const phases = phaseEvents({ ...DEFAULT_COUNTS, ...counts })
  return {
    counts: { ...DEFAULT_COUNTS, ...counts },
    old_limits: { ...OLD_LIMITS },
    phases: phases.map((phase) => ({ name: phase.name, event_count: phase.events.length })),
    events: phases.flatMap((phase) => phase.events),
  }
}

function phaseCounts(state) {
  return countMemory(state?.worldMemory)
}

function checkRetention(memory, expected) {
  const actual = countMemory(memory)
  const missing = Object.fromEntries(Object.keys(expected).flatMap((key) => {
    const delta = Number(expected[key] ?? 0) - Number(actual[key] ?? 0)
    return delta > 0 ? [[key, delta]] : []
  }))
  const extra = Object.fromEntries(Object.keys(expected).flatMap((key) => {
    const delta = Number(actual[key] ?? 0) - Number(expected[key] ?? 0)
    return delta > 0 ? [[key, delta]] : []
  }))
  return { expected: { ...expected }, actual, missing, extra, passed: Object.keys(missing).length === 0, exact: Object.keys(missing).length === 0 && Object.keys(extra).length === 0 }
}

function contextPayloads(state) {
  const viewer = { playerId: 'hero-1', isPartyMember: true }
  const partyProjection = worldMemoryForViewer(state.worldMemory, viewer)
  const adminProjection = worldMemoryForViewer(state.worldMemory, { isAdmin: true })
  const known = retrieveKnownWorldMemory(state.worldMemory, { viewer, query: 'наблюдение архив', limit: 8 })
  const scene = sceneContextForAgent(state, 'hero-1')
  const premise = campaignConceptForAgent(state)
  const npcContext = retrieveWorldMemory(state.worldMemory, { isAdmin: true }, { query: 'архивный персонаж', limit: 8 })
  const directorContext = retrieveWorldMemory(state.worldMemory, { isAdmin: true }, { query: 'долгой кампании', limit: 8 })
  return {
    client_projection: { bytes: jsonBytes(partyProjection), counts: countMemory(partyProjection) },
    admin_projection: { bytes: jsonBytes(adminProjection), counts: countMemory(adminProjection) },
    role_contexts: {
      worldkeeper: { bytes: jsonBytes({ campaign_premise: premise, known_memory: known }), record_count: known.length },
      npc: { bytes: jsonBytes({ campaign_premise: premise, scene, memory: npcContext }), record_count: npcContext.length },
      director: { bytes: jsonBytes({ campaign_premise: premise, scene, memory: directorContext }), record_count: directorContext.length },
      narrator: { bytes: jsonBytes({ campaign_premise: premise, scene }), record_count: 0 },
    },
  }
}

function generatedMemory(initial = {}) {
  return normalizeWorldMemory({
    entities: [
      { id: 'npc:ashen', kind: 'npc', name: 'Пепельный Лис', summary: 'Замаскированный курьер.', visibility: 'party', aliases: ['курьер в маске'] },
      { id: 'npc:vela', kind: 'npc', name: 'Вела', summary: 'Смотрительница переправы.', visibility: 'party' },
      { id: 'npc:edrik-a', kind: 'npc', name: 'Эдрик', summary: 'Эдрик у северных ворот.', visibility: 'party' },
      { id: 'npc:edrik-b', kind: 'npc', name: 'Эдрик', summary: 'Эдрик у южных ворот.', visibility: 'party' },
      { id: 'location:ford', kind: 'location', name: 'Старая переправа', summary: 'Затопленный тракт.', visibility: 'party' },
      ...(initial.entities ?? []),
    ],
    facts: [
      { id: 'fact:ashen-route', subject_id: 'npc:ashen', predicate: 'uses_route', object: 'Курьер в маске пользуется старым акведуком.', summary: 'Замаскированный курьер пользуется старым акведуком.', visibility: 'party', recorded_at_minutes: 90, source_event_ids: ['event:route'] },
      { id: 'fact:vela-promise', subject_id: 'npc:vela', predicate: 'promised_help', object: 'Вела обещала помочь отряду на переправе.', summary: 'Вела обещала помочь на переправе.', visibility: 'party', recorded_at_minutes: 100, source_event_ids: ['event:promise'] },
      { id: 'fact:old-dialogue', subject_id: 'npc:vela', predicate: 'said', object: 'В старом разговоре Вела сказала, что дамба удержит воду до рассвета.', summary: 'Старый разговор о дамбе и рассвете.', visibility: 'party', recorded_at_minutes: 20, source_event_ids: ['event:dialogue'] },
      { id: 'fact:old-route', subject_id: 'location:ford', predicate: 'route_status', object: 'Старый тракт затоплен.', summary: 'Устаревшее утверждение о старом тракте.', visibility: 'party', status: 'superseded', recorded_at_minutes: 10, source_event_ids: ['event:old-route'] },
      { id: 'fact:current-route', subject_id: 'location:ford', predicate: 'route_status', object: 'Отряд использует западную тропу.', summary: 'Текущий маршрут проходит по западной тропе.', visibility: 'party', supersedes_fact_id: 'fact:old-route', recorded_at_minutes: 200, source_event_ids: ['event:current-route'] },
      { id: 'fact:fire-tower', subject_id: 'location:ford', predicate: 'witnessed_event', object: 'У башни видели пожар после полуночи.', summary: 'Свидетели видели пожар у башни.', visibility: 'party', recorded_at_minutes: 120, source_event_ids: ['event:fire'] },
      { id: 'fact:private-seal', subject_id: 'npc:vela', predicate: 'keeps_secret', object: 'Вела скрывает тайну о печати.', summary: 'Тайна Велы о печати.', visibility: 'gm_only', recorded_at_minutes: 110, source_event_ids: ['event:secret'] },
      { id: 'fact:edrik-north', subject_id: 'npc:edrik-a', predicate: 'position', object: 'Эдрик стоит у северных ворот.', summary: 'Эдрик у северных ворот.', visibility: 'party', recorded_at_minutes: 130, source_event_ids: ['event:edrik-north'] },
      { id: 'fact:edrik-south', subject_id: 'npc:edrik-b', predicate: 'position', object: 'Эдрик стоит у южных ворот.', summary: 'Эдрик у южных ворот.', visibility: 'party', recorded_at_minutes: 130, source_event_ids: ['event:edrik-south'] },
      ...(initial.facts ?? []),
    ],
    epistemic_claims: [
      { id: 'rumor:old-smugglers', kind: 'rumor', holder_entity_id: 'npc:vela', subject_entity_id: 'location:ford', predicate: 'crossed', claim: 'Слух: контрабандисты идут через старую дорогу.', summary: 'Опровергнутый слух о контрабандистах.', visibility: 'party', truth_status: 'refuted', recorded_at_minutes: 30, source_event_ids: ['event:rumor'] },
      ...(initial.epistemic_claims ?? []),
    ],
    knowledge_ledger: [
      { id: 'knowledge:hero-secret', hero_id: 'hero-1', fact_id: 'fact:private-seal', summary: 'Тайна открыта герою.', source_event_ids: ['event:reveal'], source_command_id: 'command:reveal', revealed_event_id: 'event:reveal', source_kind: 'knowledge_revealed', recorded_at_minutes: 150 },
      ...(initial.knowledge_ledger ?? []),
    ],
  })
}

export function retrievalCorpus() {
  return {
    rules: [
      { id: 'rule-direct-advantage', category: 'direct', query: 'Как работает помеха?', expected_ids: ['srd_5_2_1:core:advantage-disadvantage'] },
      { id: 'rule-paraphrase-advantage', category: 'paraphrase', query: 'Бросаю два d20 и беру худший результат.', expected_ids: ['srd_5_2_1:core:advantage-disadvantage'] },
      { id: 'rule-dialogue-reaction', category: 'old_dialogue', query: 'После атаки врага можно ответить реакцией?', expected_ids: ['srd_5_2_1:combat:reaction'] },
      { id: 'rule-ambiguity-combat', category: 'ambiguity', query: 'Преимущество или реакция после атаки в бою?', expected_ids: ['srd_5_2_1:core:advantage-disadvantage', 'srd_5_2_1:combat:reaction'] },
      { id: 'rule-no-answer', category: 'no_answer', query: 'Правила для фиолетовых драконов на Луне.', expected_ids: [] },
    ],
    memory: [
      { id: 'memory-npc-description', category: 'npc_description', query: 'Кто из замаскированных курьеров пользуется древним водоводом?', expected_ids: ['fact:ashen-route'], viewer: { playerId: 'hero-1', isPartyMember: true } },
      { id: 'memory-promise-paraphrase', category: 'paraphrase', query: 'Она дала слово выручить нас у переправы.', expected_ids: ['fact:vela-promise'], viewer: { playerId: 'hero-1', isPartyMember: true } },
      { id: 'memory-old-dialogue', category: 'old_dialogue', query: 'Что Вела говорила о дамбе до рассвета?', expected_ids: ['fact:old-dialogue'], viewer: { playerId: 'hero-1', isPartyMember: true } },
      { id: 'memory-obsolete-rumor', category: 'obsolete', query: 'Слух про контрабандистов на старом тракте.', expected_ids: ['rumor:old-smugglers'], obsolete_ids: ['rumor:old-smugglers'], viewer: { playerId: 'hero-1', isPartyMember: true } },
      { id: 'memory-ambiguity-edrik', category: 'ambiguity', query: 'Где находится Эдрик у ворот?', expected_ids: ['fact:edrik-north', 'fact:edrik-south'], viewer: { playerId: 'hero-1', isPartyMember: true } },
      { id: 'memory-private-known', category: 'private_known', query: 'Какая тайна Велы связана с печатью?', expected_ids: ['fact:private-seal'], viewer: { playerId: 'hero-1', isPartyMember: true } },
      { id: 'memory-private-hidden', category: 'private_hidden', query: 'Какая тайна Велы связана с печатью?', expected_ids: [], forbidden_ids: ['fact:private-seal'], viewer: { playerId: 'rogue-1', isPartyMember: true } },
      { id: 'memory-no-answer', category: 'no_answer', query: 'Когда прилетят фиолетовые драконы?', expected_ids: [], viewer: { playerId: 'hero-1', isPartyMember: true } },
    ],
  }
}

function resultIds(results) {
  return (results ?? []).map((entry) => String(entry.rule_id ?? entry.id ?? ''))
}

function caseMetrics(item, results, elapsedMs) {
  const ids = resultIds(results)
  const expected = new Set(item.expected_ids)
  const found = item.expected_ids.filter((id) => ids.includes(id))
  const irrelevant = ids.filter((id) => !expected.has(id)).length
  const obsoleteHits = (item.obsolete_ids ?? []).filter((id) => ids.includes(id))
  const privacyViolations = (item.forbidden_ids ?? []).filter((id) => ids.includes(id))
  return {
    id: item.id, category: item.category, query: item.query, expected_ids: [...item.expected_ids],
    result_ids: ids, recall_at_k: item.expected_ids.length ? found.length / item.expected_ids.length : null,
    top1_correct: item.expected_ids.length ? expected.has(ids[0]) : null,
    irrelevant_count: irrelevant, obsolete_hits: obsoleteHits, privacy_violations: privacyViolations,
    no_answer_expected: item.expected_ids.length === 0, no_answer_returned: ids.length === 0,
    latency_ms: Number(elapsedMs.toFixed(3)),
  }
}

function aggregateCaseMetrics(cases) {
  const withAnswer = cases.filter((item) => item.recall_at_k != null)
  const noAnswer = cases.filter((item) => item.no_answer_expected)
  return {
    case_count: cases.length,
    recall_at_k: withAnswer.length ? Number((withAnswer.reduce((sum, item) => sum + item.recall_at_k, 0) / withAnswer.length).toFixed(4)) : null,
    top1_accuracy: withAnswer.length ? Number((withAnswer.filter((item) => item.top1_correct).length / withAnswer.length).toFixed(4)) : null,
    mean_irrelevant_count: cases.length ? Number((cases.reduce((sum, item) => sum + item.irrelevant_count, 0) / cases.length).toFixed(3)) : 0,
    obsolete_hits: cases.reduce((sum, item) => sum + item.obsolete_hits.length, 0),
    privacy_violations: cases.reduce((sum, item) => sum + item.privacy_violations.length, 0),
    no_answer_expected: noAnswer.length,
    no_answer_correct: noAnswer.filter((item) => item.no_answer_returned).length,
    no_answer_rate: noAnswer.length ? Number((noAnswer.filter((item) => item.no_answer_returned).length / noAnswer.length).toFixed(4)) : null,
    latency: summaryStats(cases.map((item) => item.latency_ms)),
  }
}

async function evaluateRulesBaseline(pack, cases) {
  const retriever = new RuleRetriever(pack)
  const evaluated = []
  for (const item of cases) {
    const measured = await timedAsync(() => retriever.search({
      queries: [item.query], ruleset_id: pack.manifest.ruleset_id, enabled_packs: [pack.manifest.pack_id], limit: 5,
    }))
    evaluated.push(caseMetrics(item, measured.value.results, measured.elapsedMs))
  }
  return { summary: aggregateCaseMetrics(evaluated), cases: evaluated }
}

async function evaluateMemoryBaseline(memory, cases) {
  const evaluated = []
  for (const item of cases) {
    const measured = await timedAsync(() => retrieveWorldMemory(memory, item.viewer, { query: item.query, limit: 5 }))
    evaluated.push(caseMetrics(item, measured.value, measured.elapsedMs))
  }
  const campaignA = generatedMemory({ facts: [{ id: 'fact:campaign-a', subject_id: 'npc:ashen', predicate: 'campaign_marker', object: 'Маркер кампании А находится в северном архиве.', summary: 'Маркер кампании А.', visibility: 'party' }] })
  const campaignB = generatedMemory({ facts: [{ id: 'fact:campaign-b', subject_id: 'npc:ashen', predicate: 'campaign_marker', object: 'Маркер кампании Б находится в южном архиве.', summary: 'Маркер кампании Б.', visibility: 'party' }] })
  const isolationCases = []
  for (const [campaign, campaignMemory, ownId, foreignId] of [['A', campaignA, 'fact:campaign-a', 'fact:campaign-b'], ['B', campaignB, 'fact:campaign-b', 'fact:campaign-a']]) {
    const query = `маркер кампании ${campaign === 'A' ? 'А северный' : 'Б южный'}`
    const measured = await timedAsync(() => retrieveWorldMemory(campaignMemory, { playerId: 'hero-1', isPartyMember: true }, { query, limit: 5 }))
    const ids = resultIds(measured.value)
    isolationCases.push({ campaign, query, result_ids: ids, own_id_found: ids.includes(ownId), foreign_id_found: ids.includes(foreignId), latency_ms: Number(measured.elapsedMs.toFixed(3)) })
  }
  const isolation = {
    case_count: isolationCases.length,
    own_hits: isolationCases.filter((item) => item.own_id_found).length,
    foreign_leaks: isolationCases.filter((item) => item.foreign_id_found).length,
    cases: isolationCases,
  }
  return { summary: aggregateCaseMetrics(evaluated), cases: evaluated, campaign_isolation: isolation }
}

function embeddingCapability() {
  const settings = embeddingSettings()
  if (settings.apiKey) {
    return { status: 'configured', measured_by_default: false, protocol: 'OpenAI-compatible POST /embeddings', endpoint_configured: true, model_configured: true, credential_configured: true, endpoint_source: settings.endpointSource, model: settings.model }
  }
  return {
    status: 'unavailable', measured_by_default: false,
    reason: 'Endpoint и модель BGE-M3 доступны через существующий RouterAI API, но credential не настроен для eval.',
    protocol: 'OpenAI-compatible POST /embeddings',
    endpoint_configured: true, model_configured: true, credential_configured: false, endpoint_source: settings.endpointSource, model: settings.model,
  }
}

function embeddingSettings() {
  const baseUrl = String(process.env.ROUTERAI_BASE_URL || 'https://routerai.ru/api/v1').replace(/\/$/u, '')
  return {
    endpoint: process.env.DND_EMBEDDING_URL || `${baseUrl}/embeddings`,
    model: process.env.DND_EMBEDDING_MODEL || 'baai/bge-m3',
    apiKey: process.env.DND_EMBEDDING_API_KEY || process.env.ROUTERAI_API_KEY || '',
    endpointSource: process.env.DND_EMBEDDING_URL ? 'DND_EMBEDDING_URL' : 'RouterAI /embeddings',
  }
}

async function embeddingRequest(texts) {
  const settings = embeddingSettings()
  if (!settings.apiKey) throw new Error('Embedding credential is not configured')
  const response = await fetch(settings.endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ model: settings.model, input: texts, encoding_format: 'float' }),
  })
  if (!response.ok) throw new Error(`Embedding endpoint returned HTTP ${response.status}`)
  const payload = await response.json()
  if (!Array.isArray(payload.data) || payload.data.length !== texts.length) throw new Error('Embedding endpoint returned an unexpected data length')
  const vectors = [...payload.data].sort((left, right) => Number(left.index ?? 0) - Number(right.index ?? 0)).map((entry) => entry.embedding)
  if (vectors.some((vector) => !Array.isArray(vector) || !vector.length || vector.some((value) => !Number.isFinite(Number(value))))) throw new Error('Embedding endpoint returned an invalid vector')
  return { vectors, usage: payload.usage ?? null }
}

function cosine(left, right) {
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    dot += left[index] * right[index]
    leftMagnitude += left[index] * left[index]
    rightMagnitude += right[index] * right[index]
  }
  return leftMagnitude && rightMagnitude ? dot / Math.sqrt(leftMagnitude * rightMagnitude) : 0
}

function ruleEmbeddingDocuments(pack) {
  return pack.rules.map((rule) => ({ id: rule.id, text: [rule.title_ru, rule.title_en, rule.text_ru, rule.text_en, ...(rule.aliases_ru ?? []), ...(rule.aliases_en ?? [])].filter(Boolean).join(' ') }))
}

function memoryEmbeddingDocuments(memory, viewer) {
  const projected = worldMemoryForViewer(memory, viewer)
  const entities = new Map(projected.entities.map((entity) => [entity.id, entity.name]))
  return [
    ...projected.facts.map((fact) => ({ id: fact.id, text: `${entities.get(fact.subject_id) ?? ''} ${fact.predicate} ${fact.object} ${fact.summary}` })),
    ...projected.relationships.map((item) => ({ id: item.id, text: `${entities.get(item.from_entity_id) ?? ''} ${item.relation} ${entities.get(item.to_entity_id) ?? ''} ${item.summary}` })),
    ...projected.quests.map((item) => ({ id: item.id, text: `${item.title} ${item.summary} ${item.objectives.join(' ')}` })),
    ...projected.epistemic_claims.map((item) => ({ id: item.id, text: `${entities.get(item.holder_entity_id) ?? ''} ${item.claim} ${item.summary}` })),
    ...projected.summaries.map((item) => ({ id: item.id, text: `${item.title} ${item.summary}` })),
  ]
}

async function buildEmbeddingIndex(documents) {
  const measured = await timedAsync(() => embeddingRequest(documents.map((entry) => entry.text)))
  return { documents, vectors: measured.value.vectors, usage: measured.value.usage, elapsedMs: measured.elapsedMs }
}

async function embeddingSearch(index, query, limit, minimumScore) {
  const measured = await timedAsync(async () => {
    const queryResult = await embeddingRequest([query])
    const scored = index.documents.map((entry, documentIndex) => ({ id: entry.id, score: cosine(queryResult.vectors[0], index.vectors[documentIndex]) }))
      .filter((entry) => entry.score >= minimumScore).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id)).slice(0, limit)
    return { results: scored, usage: queryResult.usage }
  })
  return { ...measured.value, elapsedMs: measured.elapsedMs }
}

function usageSummary(usages) {
  const totals = {}
  for (const usage of usages.flatMap((entry) => entry == null ? [] : [entry])) {
    if (!usage || typeof usage !== 'object') continue
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === 'number' && Number.isFinite(value)) totals[key] = (totals[key] ?? 0) + value
    }
  }
  return { request_count: usages.filter((usage) => usage != null).length, ...(Object.keys(totals).length ? { totals } : { provider_did_not_return_numeric_usage: true }) }
}

async function evaluateTrainedEmbeddings(pack, corpus, memory, options = {}) {
  const capability = embeddingCapability()
  if (!options.enabled) return { ...capability, status: capability.status === 'configured' ? 'available_but_not_requested' : capability.status }
  if (capability.status !== 'configured') return capability
  const minimumScore = Number.isFinite(Number(options.minimumScore)) ? Number(options.minimumScore) : 0.35
  const usages = []
  const rulesIndex = await buildEmbeddingIndex(ruleEmbeddingDocuments(pack))
  usages.push(rulesIndex.usage)
  const rulesCases = []
  for (const item of corpus.rules) {
    const measured = await embeddingSearch(rulesIndex, item.query, 5, minimumScore)
    usages.push(measured.usage)
    rulesCases.push(caseMetrics(item, measured.results, measured.elapsedMs))
  }
  const memoryCases = []
  const memoryIndexes = new Map()
  const memoryIndexing = []
  for (const item of corpus.memory) {
    const key = JSON.stringify(item.viewer)
    if (!memoryIndexes.has(key)) {
      const index = await buildEmbeddingIndex(memoryEmbeddingDocuments(memory, item.viewer))
      memoryIndexes.set(key, index)
      memoryIndexing.push({ viewer: item.viewer, document_count: index.documents.length, indexing_ms: Number(index.elapsedMs.toFixed(3)) })
      usages.push(index.usage)
    }
    const measured = await embeddingSearch(memoryIndexes.get(key), item.query, 5, minimumScore)
    usages.push(measured.usage)
    memoryCases.push(caseMetrics(item, measured.results, measured.elapsedMs))
  }
  const trainedIsolationCases = []
  const isolationMemories = [
    ['A', generatedMemory({ facts: [{ id: 'fact:campaign-a', subject_id: 'npc:ashen', predicate: 'campaign_marker', object: 'Маркер кампании А находится в северном архиве.', summary: 'Маркер кампании А.', visibility: 'party' }] }), 'fact:campaign-a', 'fact:campaign-b'],
    ['B', generatedMemory({ facts: [{ id: 'fact:campaign-b', subject_id: 'npc:ashen', predicate: 'campaign_marker', object: 'Маркер кампании Б находится в южном архиве.', summary: 'Маркер кампании Б.', visibility: 'party' }] }), 'fact:campaign-b', 'fact:campaign-a'],
  ]
  for (const [campaign, campaignMemory, ownId, foreignId] of isolationMemories) {
    const query = `маркер кампании ${campaign === 'A' ? 'А северный' : 'Б южный'}`
    const index = await buildEmbeddingIndex(memoryEmbeddingDocuments(campaignMemory, { playerId: 'hero-1', isPartyMember: true }))
    usages.push(index.usage)
    const measured = await embeddingSearch(index, query, 5, minimumScore)
    usages.push(measured.usage)
    const ids = resultIds(measured.results)
    trainedIsolationCases.push({ campaign, query, result_ids: ids, own_id_found: ids.includes(ownId), foreign_id_found: ids.includes(foreignId), latency_ms: Number(measured.elapsedMs.toFixed(3)) })
  }
  return {
    status: 'measured', model: embeddingSettings().model, minimum_score: minimumScore, usage: usageSummary(usages),
    indexing: {
      rules: { document_count: rulesIndex.documents.length, indexing_ms: Number(rulesIndex.elapsedMs.toFixed(3)) },
      memory: memoryIndexing, total_ms: Number((rulesIndex.elapsedMs + memoryIndexing.reduce((sum, item) => sum + item.indexing_ms, 0)).toFixed(3)),
    },
    query_latency_ms: { rules: summaryStats(rulesCases.map((item) => item.latency_ms)), memory: summaryStats(memoryCases.map((item) => item.latency_ms)) },
    rules: { summary: aggregateCaseMetrics(rulesCases), cases: rulesCases },
    memory: { summary: aggregateCaseMetrics(memoryCases), cases: memoryCases },
    campaign_isolation: {
      case_count: trainedIsolationCases.length,
      own_hits: trainedIsolationCases.filter((item) => item.own_id_found).length,
      foreign_leaks: trainedIsolationCases.filter((item) => item.foreign_id_found).length,
      cases: trainedIsolationCases,
    },
  }
}

export async function measureRetrieval(options = {}) {
  const pack = await loadRulePack(options.rulesetId ?? 'srd_5_2_1')
  const corpus = retrievalCorpus()
  const memory = generatedMemory()
  const trained = await evaluateTrainedEmbeddings(pack, corpus, memory, options.trainedEmbeddings ?? {})
  return {
    schema_version: 1, generated_at: FIXED_CLOCK().toISOString(), environment: environmentMetrics(), corpus_version: 'world-data-ru-v1',
    corpus: {
      rules_documents: pack.rules.length,
      memory_records: countMemory(memory),
      labeled_cases: { rules: corpus.rules.length, memory: corpus.memory.length, campaign_isolation: 2 },
      limitation: 'Небольшой фиксированный синтетический набор; эти метрики не являются production quality или общей оценкой модели.',
    },
    domain_separation: { rules: 'RuleRetriever', memory: 'retrieveWorldMemory + worldMemoryForViewer' },
    embedding_capability: embeddingCapability(),
    baseline: { rules: await evaluateRulesBaseline(pack, corpus.rules), memory: await evaluateMemoryBaseline(memory, corpus.memory) },
    trained_embeddings: trained,
  }
}

export async function measureStorageGrowth(options = {}) {
  const counts = { ...DEFAULT_COUNTS, ...(options.counts ?? {}) }
  const batchSize = Math.max(1, Math.min(100, Number(options.batchSize) || DEFAULT_BATCH_SIZE))
  const snapshotEvery = Math.max(0, Number(options.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY) || 0)
  const keepStorage = options.keepStorage === true
  const productionNormalization = options.productionNormalization === true
  const rootDir = options.rootDir ? resolve(options.rootDir) : mkdtempSync(join(tmpdir(), 'skazanie-world-data-'))
  const ownRoot = !options.rootDir
  const phases = phaseEvents(counts)
  const state = memoryState()
  const memorySamples = []
  let peakMemory = memoryUsage()
  let idSequence = 0
  const store = new FileEventStore({
    rootDir,
    reducer: productionNormalization ? reduceWorldMemoryState : reduceSyntheticWorldMemoryState,
    normalizeState: productionNormalization ? normalizeWorldMemoryState : preserveState,
    initialStateFactory: () => memoryState(), snapshotEvery, maxEventsPerCommit: batchSize,
    clock: FIXED_CLOCK, idFactory: () => `measurement-id-${String(++idSequence).padStart(8, '0')}`,
  })
  const initialized = await timedAsync(() => store.initializeCampaign({ campaignId: CAMPAIGN_ID, initialState: state }))
  memorySamples.push({ phase: 'initial', ...memoryUsage() })
  peakMemory = maxMemory(peakMemory, memorySamples.at(-1))
  const commitDurations = []
  const point = (phase, value, memory) => ({ phase, counts: phaseCounts(value), state_bytes: jsonBytes(value), files: collectFileSizes(rootDir), memory })
  const points = [point('initial', initialized.value.state, memorySamples.at(-1))]
  let currentVersion = initialized.value.state_version
  let lastState = initialized.value.state
  const crossed = new Set()
  for (const phase of phases) {
    let phaseState = lastState
    for (let offset = 0; offset < phase.events.length; offset += batchSize) {
      const events = phase.events.slice(offset, offset + batchSize)
      const measured = await timedAsync(() => store.commit({
        campaignId: CAMPAIGN_ID, expectedStateVersion: currentVersion,
        idempotencyKey: `measurement:${phase.name}:${offset}`, commandId: `measurement-command:${phase.name}:${offset}`,
        events,
      }))
      commitDurations.push(measured.elapsedMs)
      currentVersion = measured.value.state_version
      phaseState = measured.value.state
      const sample = { phase: phase.name, offset: offset + events.length, ...memoryUsage() }
      memorySamples.push(sample)
      peakMemory = maxMemory(peakMemory, sample)
      const currentCounts = phaseCounts(phaseState)
      if (!crossed.has(phase.name) && currentCounts[phase.name] > OLD_LIMITS[phase.name]) {
        crossed.add(phase.name)
        points.push(point(`${phase.name}:crossed_old_limit`, phaseState, sample))
      }
    }
    lastState = phaseState
    points.push(point(phase.name, phaseState, memorySamples.at(-1)))
  }
  const loaded = await timedAsync(() => store.load(CAMPAIGN_ID))
  const normalized = timed(() => normalizeWorldMemory(loaded.value.state.worldMemory))
  const replayFull = await timedAsync(() => store.replay(CAMPAIGN_ID, { useSnapshots: false }))
  const replaySnapshot = await timedAsync(() => store.replay(CAMPAIGN_ID, { useSnapshots: true }))
  const finalFiles = collectFileSizes(rootDir)
  const retention = checkRetention(loaded.value.state.worldMemory, counts)
  const result = {
    schema_version: 1, generated_at: FIXED_CLOCK().toISOString(), environment: environmentMetrics(), campaign_id: CAMPAIGN_ID,
    storage_root: ownRoot && !keepStorage ? 'temporary_cleaned_after_run' : rootDir,
    config: { counts, old_limits: OLD_LIMITS, batch_size: batchSize, snapshot_every: snapshotEvery, reducer_mode: productionNormalization ? 'production_world_memory' : 'synthetic_append_only', gc_available: typeof globalThis.gc === 'function' },
    phases: points,
    final: {
      state_bytes: jsonBytes(loaded.value.state), state_counts: phaseCounts(loaded.value.state), files: finalFiles,
      memory: memoryUsage(), peak_memory: peakMemory, contexts: contextPayloads(loaded.value.state),
    },
    timings: {
      initialize_ms: Number(initialized.elapsedMs.toFixed(3)), commit: summaryStats(commitDurations),
      load_ms: Number(loaded.elapsedMs.toFixed(3)), normalize_ms: Number(normalized.elapsedMs.toFixed(3)),
      replay_full_ms: Number(replayFull.elapsedMs.toFixed(3)), replay_snapshot_ms: Number(replaySnapshot.elapsedMs.toFixed(3)),
    },
    retention, replay_identical: stableJson(replayFull.value.state) === stableJson(loaded.value.state),
    snapshot_replay_identical: stableJson(replaySnapshot.value.state) === stableJson(loaded.value.state),
  }
  if (ownRoot && !keepStorage) rmSync(rootDir, { recursive: true, force: true })
  return result
}

export async function measureProductionStorage(options = {}) {
  const counts = { ...DEFAULT_COUNTS, ...(options.counts ?? {}) }
  const tailCount = Math.max(5, Math.min(20, Number(options.productionTail ?? 10)))
  const snapshotEvery = Math.max(1, Number(options.snapshotEvery ?? tailCount) || tailCount)
  const keepStorage = options.keepStorage === true
  const rootDir = options.productionRootDir ? resolve(options.productionRootDir) : mkdtempSync(join(tmpdir(), 'skazanie-world-data-production-'))
  const ownRoot = !options.productionRootDir
  const materialized = materializeLongState(counts)
  // Не даём миграции памяти сцены добавить к ожидаемым synthetic counts
  // посторонние location/quest; production reducer остаётся активным для tail
  // и всех путей load/replay.
  const initialState = { ...materialized, scene: { ...materialized.scene, title: '', location: '', objective: '' } }
  const expectedCounts = { ...counts, facts: counts.facts + tailCount }
  let idSequence = 0
  const store = new FileEventStore({
    rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState,
    initialStateFactory: () => clone(initialState), snapshotEvery, maxEventsPerCommit: tailCount,
    clock: FIXED_CLOCK, idFactory: () => `production-measurement-id-${String(++idSequence).padStart(8, '0')}`,
  })
  const initialized = await timedAsync(() => store.initializeCampaign({ campaignId: CAMPAIGN_ID, initialState: initialState }))
  const initialMemory = memoryUsage()
  let peakMemory = initialMemory
  const sampleMemory = () => {
    const current = memoryUsage()
    peakMemory = maxMemory(peakMemory, current)
    return current
  }
  const initialFiles = collectFileSizes(rootDir)
  const tail = productionTailEvents(counts, tailCount)
  const committed = await timedAsync(() => store.commit({
    campaignId: CAMPAIGN_ID, expectedStateVersion: initialized.value.state_version,
    idempotencyKey: 'production-measurement:tail', commandId: 'production-measurement:tail-command', events: tail,
  }))
  sampleMemory()
  const loaded = await timedAsync(() => store.load(CAMPAIGN_ID))
  sampleMemory()
  const normalized = timed(() => normalizeCampaignState(loaded.value.state))
  sampleMemory()
  const replayFull = await timedAsync(() => store.replay(CAMPAIGN_ID, { useSnapshots: false }))
  sampleMemory()
  const replaySnapshot = await timedAsync(() => store.replay(CAMPAIGN_ID, { useSnapshots: true }))
  sampleMemory()
  const finalFiles = collectFileSizes(rootDir)
  const actualMemory = phaseCounts(loaded.value.state)
  const retention = checkRetention(loaded.value.state.worldMemory, expectedCounts)
  const contexts = contextPayloads(loaded.value.state)
  const finalMemory = sampleMemory()
  const result = {
    schema_version: 1, generated_at: FIXED_CLOCK().toISOString(), environment: environmentMetrics(), campaign_id: CAMPAIGN_ID,
    storage_root: ownRoot && !keepStorage ? 'temporary_cleaned_after_run' : rootDir,
    config: {
      initial_counts: counts, expected_final_counts: expectedCounts, old_limits: OLD_LIMITS, tail_events: tailCount,
      snapshot_every: snapshotEvery, reducer_mode: 'production_applyGameEvent_normalizeCampaignState',
    },
    initial: { state_bytes: jsonBytes(initialized.value.state), counts: phaseCounts(initialized.value.state), files: initialFiles, memory: initialMemory },
    final: { state_bytes: jsonBytes(loaded.value.state), state_counts: actualMemory, files: finalFiles, memory: finalMemory, peak_memory: peakMemory, contexts },
    timings: {
      initialize_ms: Number(initialized.elapsedMs.toFixed(3)), commit_ms: Number(committed.elapsedMs.toFixed(3)),
      load_ms: Number(loaded.elapsedMs.toFixed(3)), normalize_ms: Number(normalized.elapsedMs.toFixed(3)),
      replay_full_ms: Number(replayFull.elapsedMs.toFixed(3)), replay_snapshot_ms: Number(replaySnapshot.elapsedMs.toFixed(3)),
    },
    retention, replay_identical: stableJson(replayFull.value.state) === stableJson(loaded.value.state),
    snapshot_replay_identical: stableJson(replaySnapshot.value.state) === stableJson(loaded.value.state),
    limitation: 'Initial state is materialized synthetically, while tail commit, load and replay use the production campaign reducer and normalizer. The separate synthetic growth run measures append-only persistence throughput.',
  }
  if (ownRoot && !keepStorage) rmSync(rootDir, { recursive: true, force: true })
  return result
}

function parseArgs(argv) {
  const options = { mode: 'all', trained: false, keepStorage: false }
  for (const arg of argv) {
    if (arg === '--storage') options.mode = 'storage'
    else if (arg === '--retrieval') options.mode = 'retrieval'
    else if (arg === '--all') options.mode = 'all'
    else if (arg === '--trained') options.trained = true
    else if (arg === '--production-normalize') options.productionNormalization = true
    else if (arg === '--synthetic-storage') options.syntheticStorage = true
    else if (arg.startsWith('--production-tail=')) options.productionTail = Number(arg.slice('--production-tail='.length))
    else if (arg.startsWith('--trained-threshold=')) options.trainedThreshold = Number(arg.slice('--trained-threshold='.length))
    else if (arg === '--keep-storage') options.keepStorage = true
    else if (arg.startsWith('--root-dir=')) options.rootDir = arg.slice('--root-dir='.length)
    else if (arg.startsWith('--batch-size=')) options.batchSize = Number(arg.slice('--batch-size='.length))
    else if (arg.startsWith('--snapshot-every=')) options.snapshotEvery = Number(arg.slice('--snapshot-every='.length))
    else if (arg.startsWith('--output=')) options.output = arg.slice('--output='.length)
    else if (arg.startsWith('--scale=')) {
      const scale = Number(arg.slice('--scale='.length))
      if (Number.isFinite(scale) && scale > 0) options.counts = Object.fromEntries(Object.entries(DEFAULT_COUNTS).map(([key, value]) => [key, Math.max(1, Math.round(value * scale))]))
    }
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const report = { schema_version: 1, generated_at: FIXED_CLOCK().toISOString(), command: process.argv.slice(2) }
  if (options.mode === 'storage' || options.mode === 'all') {
    report.storage = { production: await measureProductionStorage(options) }
    if (options.syntheticStorage) report.storage.synthetic_microbenchmark = await measureStorageGrowth(options)
  }
  if (options.mode === 'retrieval' || options.mode === 'all') report.retrieval = await measureRetrieval({ trainedEmbeddings: { enabled: options.trained, minimumScore: options.trainedThreshold } })
  const encoded = `${JSON.stringify(report, null, 2)}\n`
  if (options.output) {
    writeFileSync(resolve(options.output), encoded, 'utf8')
  }
  process.stdout.write(encoded)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()

export {
  DEFAULT_COUNTS,
  OLD_LIMITS,
  countMemory,
  embeddingCapability,
  generatedMemory,
  memoryState,
  normalizeWorldMemoryState,
  phaseEvents,
  aggregateCaseMetrics as summarizeCaseMetrics,
}
