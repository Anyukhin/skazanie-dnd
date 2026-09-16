import { createHash } from 'node:crypto'
import {
  normalizeQuestKnowledgeHistory,
  normalizeQuestResponsibility,
  questForKnowledge,
  questGiverId,
  questIsImpossible,
  questInvalidationDraft,
  recordQuestKnowledge,
} from './quest-consequences.mjs'
import { retentionMode } from './retention-context.mjs'

const ENTITY_KINDS = new Set(['location', 'npc', 'faction', 'item', 'event', 'concept'])
const QUEST_STATUSES = new Set(['hidden', 'offered', 'active', 'completed', 'failed', 'abandoned'])
const THREAD_STATUSES = new Set(['hidden', 'active', 'resolved', 'failed', 'abandoned'])
const RELATION_STATUSES = new Set(['active', 'superseded'])
const EPISTEMIC_KINDS = new Set(['belief', 'rumor'])
const TRUTH_STATUSES = new Set(['unknown', 'confirmed', 'refuted'])
const SUMMARY_KINDS = new Set(['scene', 'session'])
const VISIBILITIES = new Set(['public', 'party', 'gm_only'])

export const WORLD_MEMORY_COMMAND_TYPES = new Set([
  'UpsertWorldEntity', 'RecordWorldFact', 'RevealWorldFact', 'RecordKnowledgeRevelation',
  'RecordWorldRelationship', 'UpsertQuest', 'AdvanceQuestClock', 'ResolveQuest', 'InvalidateQuest',
  'UpsertNarrativeThread', 'AdvanceNarrativeThreadClock',
  'RecordNpcBelief', 'RecordRumor', 'ResolveEpistemicClaim', 'RecordNarrativeSummary',
])

/** Закрытые статусы квеста: изменять часы и разрешать повторно уже нельзя. */
export const CLOSED_QUEST_STATUSES = Object.freeze(['completed', 'failed', 'abandoned'])
export const QUEST_ABANDONMENT_NEXT_OBJECTIVE = 'Выбрать дальнейшее занятие в текущей локации'

/**
 * Статус квеста по исходу его развязки. Одна таблица на команду, на событие и на
 * проектор: раньше отображение было записано трижды выражением
 * `outcome === 'success' ? 'completed' : 'failed'`, и третий исход в него не
 * помещался.
 *
 * @param {unknown} outcome
 * @returns {'completed'|'failed'|'abandoned'}
 */
export function questStatusForOutcome(outcome) {
  if (outcome === 'success') return 'completed'
  if (outcome === 'abandoned') return 'abandoned'
  return 'failed'
}

export class WorldMemoryValidationError extends Error {
  constructor(message, code = 'WORLD_MEMORY_INVALID') {
    super(message)
    this.name = 'WorldMemoryValidationError'
    this.code = code
  }
}

const clone = (value) => structuredClone(value)
const text = (value, maximum = 500) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const strings = (value, maximum = 120, limit = 30) => [...new Set((Array.isArray(value) ? value : [])
  .map((item) => text(item, maximum)).filter(Boolean))].slice(0, limit)
// Пределы относятся к проверке команды. После принятия записи её списковые
// поля являются частью долговечного состояния и не должны укорачиваться при
// нормализации снимка или replay.
const persistedStrings = (value, maximum = 120) => [...new Set((Array.isArray(value) ? value : [])
  .map((item) => text(item, maximum)).filter(Boolean))]
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback

function stableId(namespace, ...parts) {
  const digest = createHash('sha256').update(parts.map((part) => text(part, 1_000)).join('\0')).digest('hex').slice(0, 24)
  return `${namespace}:${digest}`
}

function id(value, field = 'id') {
  const result = text(value, 120)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(result)) {
    throw new WorldMemoryValidationError(`Некорректное поле ${field}`, 'WORLD_MEMORY_INVALID_ID')
  }
  return result
}

function visibility(value, fallback = 'gm_only') {
  const result = text(value || fallback, 30)
  if (!VISIBILITIES.has(result)) throw new WorldMemoryValidationError('Некорректная видимость памяти мира', 'WORLD_MEMORY_INVALID_VISIBILITY')
  return result
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorldMemoryValidationError(`${label} должен быть объектом`, 'WORLD_MEMORY_INVALID_SHAPE')
  }
  return value
}

function assertFields(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key))
  if (unexpected.length) throw new WorldMemoryValidationError(`${label} содержит запрещённые поля: ${unexpected.join(', ')}`, 'WORLD_MEMORY_UNKNOWN_FIELD')
}

function elapsedMinutes(state = {}) {
  const value = state?.mechanics?.world_time?.elapsed_minutes
  return Math.max(0, integer(value, 0))
}

function recordedAt(value, fallback = 0) {
  return Math.max(0, integer(value, fallback))
}

function clock(value = {}) {
  const maximum = Math.max(1, Math.min(100, integer(value.max, 4)))
  const current = Math.max(0, Math.min(maximum, integer(value.current, 0)))
  return { current, max: maximum, label: text(value.label, 160), triggered: current >= maximum }
}

function safeEntity(value = {}) {
  const kind = ENTITY_KINDS.has(text(value.kind, 30)) ? text(value.kind, 30) : 'concept'
  return {
    id: text(value.id, 120), kind, name: text(value.name, 160), summary: text(value.summary, 1_000),
    aliases: persistedStrings(value.aliases, 120), visibility: VISIBILITIES.has(value.visibility) ? value.visibility : 'gm_only',
    tags: persistedStrings(value.tags, 60),
  }
}

function safeFact(value = {}) {
  return {
    id: text(value.id, 120), subject_id: text(value.subject_id, 120), predicate: text(value.predicate, 120),
    object: text(value.object, 1_000), summary: text(value.summary, 1_000),
    visibility: VISIBILITIES.has(value.visibility) ? value.visibility : 'gm_only',
    source_event_ids: persistedStrings(value.source_event_ids, 120), source_command_id: text(value.source_command_id, 160),
    supersedes_fact_id: text(value.supersedes_fact_id, 120), status: value.status === 'superseded' ? 'superseded' : 'active',
    recorded_at_minutes: recordedAt(value.recorded_at_minutes),
  }
}

function safeRelationship(value = {}) {
  return {
    id: text(value.id, 120), from_entity_id: text(value.from_entity_id, 120), relation: text(value.relation, 120),
    to_entity_id: text(value.to_entity_id, 120), summary: text(value.summary, 1_000),
    visibility: VISIBILITIES.has(value.visibility) ? value.visibility : 'gm_only',
    source_event_ids: persistedStrings(value.source_event_ids, 120), source_command_id: text(value.source_command_id, 160),
    supersedes_relationship_id: text(value.supersedes_relationship_id, 120),
    status: RELATION_STATUSES.has(value.status) ? value.status : 'active',
    recorded_at_minutes: recordedAt(value.recorded_at_minutes),
  }
}

function safeQuest(value = {}) {
  const responsibility = normalizeQuestResponsibility(value.responsibility)
  return {
    id: text(value.id, 120), title: text(value.title, 180), summary: text(value.summary, 1_000),
    status: QUEST_STATUSES.has(value.status) ? value.status : 'active',
    visibility: VISIBILITIES.has(value.visibility) ? value.visibility : 'party',
    entity_ids: persistedStrings(value.entity_ids, 120), objectives: persistedStrings(value.objectives, 300),
    clock: clock(value.clock), recorded_at_minutes: recordedAt(value.recorded_at_minutes),
    ...(value.stay_in_location === true ? { stay_in_location: true } : {}),
    ...(responsibility ? { responsibility, giver_npc_id: text(value.giver_npc_id, 120) || null } : {}),
    ...(value.knowledge_history != null ? { knowledge_history: normalizeQuestKnowledgeHistory(value.knowledge_history) } : {}),
  }
}

function safeThread(value = {}) {
  return {
    id: text(value.id, 120), title: text(value.title, 180), summary: text(value.summary, 1_000),
    status: THREAD_STATUSES.has(value.status) ? value.status : 'active',
    visibility: VISIBILITIES.has(value.visibility) ? value.visibility : 'party',
    entity_ids: persistedStrings(value.entity_ids, 120), quest_ids: persistedStrings(value.quest_ids, 120),
    clock: clock(value.clock), source_event_ids: persistedStrings(value.source_event_ids, 120),
    source_command_id: text(value.source_command_id, 160), recorded_at_minutes: recordedAt(value.recorded_at_minutes),
  }
}

function safeEpistemicClaim(value = {}) {
  return {
    id: text(value.id, 120), kind: EPISTEMIC_KINDS.has(value.kind) ? value.kind : 'belief',
    holder_entity_id: text(value.holder_entity_id, 120), subject_entity_id: text(value.subject_entity_id, 120),
    predicate: text(value.predicate, 120), claim: text(value.claim, 1_000), summary: text(value.summary, 1_000),
    visibility: VISIBILITIES.has(value.visibility) ? value.visibility : 'gm_only',
    truth_status: TRUTH_STATUSES.has(value.truth_status) ? value.truth_status : 'unknown',
    source_event_ids: persistedStrings(value.source_event_ids, 120), source_command_id: text(value.source_command_id, 160),
    truth_source_event_ids: persistedStrings(value.truth_source_event_ids, 120),
    truth_source_command_id: text(value.truth_source_command_id, 160),
    recorded_at_minutes: recordedAt(value.recorded_at_minutes),
  }
}

function safeSummary(value = {}) {
  return {
    id: text(value.id, 120), kind: SUMMARY_KINDS.has(value.kind) ? value.kind : 'scene',
    title: text(value.title, 180), summary: text(value.summary, 2_000),
    visibility: VISIBILITIES.has(value.visibility) ? value.visibility : 'party',
    entity_ids: persistedStrings(value.entity_ids, 120), thread_ids: persistedStrings(value.thread_ids, 120),
    source_event_ids: persistedStrings(value.source_event_ids, 120), source_command_id: text(value.source_command_id, 160),
    recorded_at_minutes: recordedAt(value.recorded_at_minutes),
  }
}

function safeKnowledgeEntry(value = {}) {
  const heroId = text(value.hero_id, 120)
  const factId = text(value.fact_id, 120)
  const sourceKind = ['legacy', 'world_fact_revealed', 'knowledge_revealed', 'npc'].includes(text(value.source_kind, 40))
    ? text(value.source_kind, 40)
    : 'knowledge_revealed'
  return {
    id: text(value.id || stableId('knowledge', heroId, factId, value.revealed_event_id), 120),
    hero_id: heroId, fact_id: factId, summary: text(value.summary, 1_000),
    source_event_ids: persistedStrings(value.source_event_ids, 120), source_command_id: text(value.source_command_id, 160),
    revealed_event_id: text(value.revealed_event_id, 120), source_kind: sourceKind,
    recorded_at_minutes: recordedAt(value.recorded_at_minutes),
  }
}

function indexKnowledge(entries) {
  const byHero = new Map()
  for (const entry of entries) {
    if (!entry.hero_id || !entry.fact_id) continue
    let known = byHero.get(entry.hero_id)
    if (!known) byHero.set(entry.hero_id, known = new Set())
    known.add(entry.fact_id)
  }
  return Object.fromEntries([...byHero].map(([heroId, known]) => [heroId, [...known]]))
}

function currentLegacyKnowledgeEntries(source, persistedKeys) {
  const entries = []
  for (const [heroId, raw] of Object.entries(source.knowledge ?? {})) {
    const hero = text(heroId, 120)
    const ids = Array.isArray(raw) ? raw : raw?.fact_ids
    for (const factId of persistedStrings(ids, 120)) {
      if (!hero || persistedKeys.has(`${hero}\0${factId}`)) continue
      entries.push(safeKnowledgeEntry({
        id: stableId('knowledge-legacy', hero, factId), hero_id: hero, fact_id: factId,
        summary: '', source_event_ids: [], source_command_id: 'legacy-world-memory', source_kind: 'legacy',
      }))
    }
  }
  return entries
}

/**
 * Schema v2 keeps v1's `knowledge` index for compatibility and adds immutable
 * `knowledge_revealed` entries. Canonical truth remains in `facts`; NPC beliefs
 * and rumours deliberately live in the separate `epistemic_claims` collection.
 */
function normalizeWorldMemoryCurrent(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const entities = (Array.isArray(source.entities) ? source.entities : []).map(safeEntity)
  const facts = (Array.isArray(source.facts) ? source.facts : []).map(safeFact)
  const relationships = (Array.isArray(source.relationships) ? source.relationships : []).map(safeRelationship)
  const quests = (Array.isArray(source.quests) ? source.quests : []).map(safeQuest)
  const threads = (Array.isArray(source.threads) ? source.threads : []).map(safeThread)
  const epistemic_claims = (Array.isArray(source.epistemic_claims) ? source.epistemic_claims : []).map(safeEpistemicClaim)
  const summaries = (Array.isArray(source.summaries) ? source.summaries : []).map(safeSummary)

  const persistedLedger = Array.isArray(source.knowledge_ledger)
    ? source.knowledge_ledger
    // An explicitly absent v2 ledger means that a legacy snapshot is being
    // migrated. Do not accidentally preserve the derived compatibility alias.
    : Object.hasOwn(source, 'knowledge_ledger')
      ? []
      : Array.isArray(source.knowledge_revealed)
        ? source.knowledge_revealed
        : []
  // Some in-flight v1→v2 migrations can contain both a new empty ledger and
  // the old index. Preserve any old entry not yet represented by the ledger.
  const persistedKeys = new Set(persistedLedger.map((entry) => `${text(entry?.hero_id, 120)}\0${text(entry?.fact_id, 120)}`))
  const rawLedger = [...persistedLedger, ...currentLegacyKnowledgeEntries(source, persistedKeys)]
  const knownEntries = rawLedger.map(safeKnowledgeEntry)
  const knowledge_revealed = knownEntries
  return {
    schema_version: 2, entities, facts, relationships, quests, threads, epistemic_claims, summaries,
    knowledge: indexKnowledge(knowledge_revealed), knowledge_revealed, knowledge_ledger: knowledge_revealed,
  }
}

const legacyList = (value, maximum, limit) => persistedStrings(value, maximum).slice(0, limit)

function legacyEntity(value = {}) {
  const item = safeEntity(value)
  return { ...item, aliases: item.aliases.slice(0, 20), tags: item.tags.slice(0, 20) }
}

function legacyFact(value = {}) {
  const item = safeFact(value)
  return { ...item, source_event_ids: item.source_event_ids.slice(0, 30) }
}

function legacyRelationship(value = {}) {
  const item = safeRelationship(value)
  return { ...item, source_event_ids: item.source_event_ids.slice(0, 30) }
}

function legacyQuest(value = {}) {
  const item = safeQuest(value)
  const { knowledge_history: _knowledgeHistory, ...withoutHistory } = item
  return {
    ...withoutHistory,
    entity_ids: item.entity_ids.slice(0, 30), objectives: item.objectives.slice(0, 20),
  }
}

function legacyThread(value = {}) {
  const item = safeThread(value)
  return {
    ...item, entity_ids: item.entity_ids.slice(0, 30), quest_ids: item.quest_ids.slice(0, 30),
    source_event_ids: item.source_event_ids.slice(0, 30),
  }
}

function legacyClaim(value = {}) {
  const item = safeEpistemicClaim(value)
  return {
    ...item, source_event_ids: item.source_event_ids.slice(0, 30), truth_source_event_ids: item.truth_source_event_ids.slice(0, 30),
  }
}

function legacySummary(value = {}) {
  const item = safeSummary(value)
  return {
    ...item, entity_ids: item.entity_ids.slice(0, 30), thread_ids: item.thread_ids.slice(0, 30), source_event_ids: item.source_event_ids.slice(0, 50),
  }
}

function legacyKnowledgeEntry(value = {}) {
  const item = safeKnowledgeEntry(value)
  return { ...item, source_event_ids: item.source_event_ids.slice(0, 30) }
}

function legacyKnowledgeEntries(source, factIds) {
  const entries = []
  for (const [heroId, raw] of Object.entries(source.knowledge ?? {}).slice(0, 100)) {
    const hero = text(heroId, 120)
    const ids = Array.isArray(raw) ? raw : raw?.fact_ids
    for (const factId of legacyList(ids, 120, 2_000)) {
      if (!hero || !factIds.has(factId)) continue
      entries.push(legacyKnowledgeEntry({
        id: stableId('knowledge-legacy', hero, factId), hero_id: hero, fact_id: factId,
        summary: '', source_event_ids: [], source_command_id: 'legacy-world-memory', source_kind: 'legacy',
      }))
    }
  }
  return entries
}

/** Воспроизводит нормализацию до перехода на бессрочное хранение памяти. */
export function normalizeWorldMemoryLegacy(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const entities = (Array.isArray(source.entities) ? source.entities : []).map(legacyEntity).filter((item) => item.id && item.name).slice(0, 500)
  const entityIds = new Set(entities.map((item) => item.id))
  const facts = (Array.isArray(source.facts) ? source.facts : []).map(legacyFact)
    .filter((item) => item.id && item.subject_id && item.predicate && entityIds.has(item.subject_id)).slice(0, 2_000)
  const factIds = new Set(facts.map((item) => item.id))
  const relationships = (Array.isArray(source.relationships) ? source.relationships : []).map(legacyRelationship)
    .filter((item) => item.id && item.from_entity_id && item.relation && item.to_entity_id && entityIds.has(item.from_entity_id) && entityIds.has(item.to_entity_id)).slice(0, 2_000)
  const quests = (Array.isArray(source.quests) ? source.quests : []).map(legacyQuest).filter((item) => item.id && item.title).slice(0, 300)
  const questIds = new Set(quests.map((item) => item.id))
  const threads = (Array.isArray(source.threads) ? source.threads : []).map(legacyThread)
    .filter((item) => item.id && item.title && item.entity_ids.every((entityId) => entityIds.has(entityId)) && item.quest_ids.every((questId) => questIds.has(questId))).slice(0, 500)
  const threadIds = new Set(threads.map((item) => item.id))
  const epistemic_claims = (Array.isArray(source.epistemic_claims) ? source.epistemic_claims : []).map(legacyClaim)
    .filter((item) => item.id && item.holder_entity_id && item.claim && entityIds.has(item.holder_entity_id)
      && (!item.subject_entity_id || entityIds.has(item.subject_entity_id))).slice(0, 2_000)
  const summaries = (Array.isArray(source.summaries) ? source.summaries : []).map(legacySummary)
    .filter((item) => item.id && item.title && item.summary && item.entity_ids.every((entityId) => entityIds.has(entityId)) && item.thread_ids.every((threadId) => threadIds.has(threadId))).slice(-1_000)
  const legacyEntries = legacyKnowledgeEntries(source, factIds)
  const persistedLedger = Array.isArray(source.knowledge_ledger)
    ? source.knowledge_ledger
    : Object.hasOwn(source, 'knowledge_ledger')
      ? []
      : Array.isArray(source.knowledge_revealed)
        ? source.knowledge_revealed
        : []
  const persistedKeys = new Set(persistedLedger.map((entry) => `${text(entry?.hero_id, 120)}\0${text(entry?.fact_id, 120)}`))
  const rawLedger = [...persistedLedger, ...legacyEntries.filter((entry) => !persistedKeys.has(`${entry.hero_id}\0${entry.fact_id}`))]
  const knownEntries = rawLedger.map(legacyKnowledgeEntry)
    .filter((item) => item.id && item.hero_id && factIds.has(item.fact_id)).slice(-5_000)
  const knowledge_revealed = [...new Map(knownEntries.map((item) => [item.id, item])).values()]
  return {
    schema_version: 2, entities, facts, relationships, quests, threads, epistemic_claims, summaries,
    knowledge: indexKnowledge(knowledge_revealed), knowledge_revealed, knowledge_ledger: knowledge_revealed,
  }
}

export function normalizeWorldMemory(input = {}) {
  return retentionMode() === 'legacy' ? normalizeWorldMemoryLegacy(input) : normalizeWorldMemoryCurrent(input)
}

function memoryIssue(issues, collection, record, field, targetId, code = 'WORLD_MEMORY_BROKEN_REFERENCE', index = null) {
  issues.push({
    code, collection, id: text(record?.id, 120), field,
    ...(targetId == null ? {} : { target_id: text(targetId, 120) }),
    ...(index == null ? {} : { index }),
  })
}

/**
 * Возвращает детерминированную диагностику целостности, не изменяя каноническую
 * память. Битые записи остаются в нормализованном состоянии, чтобы оператор
 * мог исправить или восстановить их по ID, а не потерять при чтении.
 */
export function diagnoseWorldMemory(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const memory = normalizeWorldMemoryCurrent(source)
  const issues = []
  const collections = ['entities', 'facts', 'relationships', 'quests', 'threads', 'epistemic_claims', 'summaries', 'knowledge_ledger']
  for (const collection of collections) {
    if (Object.hasOwn(source, collection) && !Array.isArray(source[collection])) {
      memoryIssue(issues, collection, {}, null, null, 'WORLD_MEMORY_COLLECTION_INVALID')
    }
  }
  const ids = Object.fromEntries(collections.map((collection) => [collection, new Set()]))
  for (const collection of collections) {
    for (const [index, record] of memory[collection].entries()) {
      if (!record.id) memoryIssue(issues, collection, record, 'id', null, 'WORLD_MEMORY_RECORD_ID_INVALID', index)
      else if (ids[collection].has(record.id)) memoryIssue(issues, collection, record, 'id', record.id, 'WORLD_MEMORY_DUPLICATE_ID', index)
      else ids[collection].add(record.id)
    }
  }
  const checkRefs = (collection, records, field, targetCollection, getTargets) => {
    for (const [index, record] of records.entries()) {
      for (const targetId of getTargets(record)) {
        if (!targetId || !ids[targetCollection].has(targetId)) memoryIssue(issues, collection, record, field, targetId, undefined, index)
      }
    }
  }
  checkRefs('facts', memory.facts, 'subject_id', 'entities', (record) => [record.subject_id])
  checkRefs('facts', memory.facts, 'supersedes_fact_id', 'facts', (record) => record.supersedes_fact_id ? [record.supersedes_fact_id] : [])
  checkRefs('relationships', memory.relationships, 'from_entity_id', 'entities', (record) => [record.from_entity_id])
  checkRefs('relationships', memory.relationships, 'to_entity_id', 'entities', (record) => [record.to_entity_id])
  checkRefs('relationships', memory.relationships, 'supersedes_relationship_id', 'relationships', (record) => record.supersedes_relationship_id ? [record.supersedes_relationship_id] : [])
  checkRefs('quests', memory.quests, 'entity_ids', 'entities', (record) => record.entity_ids)
  checkRefs('threads', memory.threads, 'entity_ids', 'entities', (record) => record.entity_ids)
  checkRefs('threads', memory.threads, 'quest_ids', 'quests', (record) => record.quest_ids)
  checkRefs('epistemic_claims', memory.epistemic_claims, 'holder_entity_id', 'entities', (record) => [record.holder_entity_id])
  checkRefs('epistemic_claims', memory.epistemic_claims, 'subject_entity_id', 'entities', (record) => record.subject_entity_id ? [record.subject_entity_id] : [])
  checkRefs('summaries', memory.summaries, 'entity_ids', 'entities', (record) => record.entity_ids)
  checkRefs('summaries', memory.summaries, 'thread_ids', 'threads', (record) => record.thread_ids)
  checkRefs('knowledge_ledger', memory.knowledge_ledger, 'fact_id', 'facts', (record) => [record.fact_id])
  for (const [index, entity] of memory.entities.entries()) {
    if (!entity.name) memoryIssue(issues, 'entities', entity, 'name', null, 'WORLD_MEMORY_ENTITY_NAME_INVALID', index)
  }
  for (const [index, fact] of memory.facts.entries()) {
    if (!fact.predicate || (!fact.object && !fact.summary)) memoryIssue(issues, 'facts', fact, 'content', null, 'WORLD_MEMORY_FACT_CONTENT_INVALID', index)
  }
  for (const [index, relationship] of memory.relationships.entries()) {
    if (!relationship.relation || !relationship.summary) memoryIssue(issues, 'relationships', relationship, 'content', null, 'WORLD_MEMORY_RELATIONSHIP_CONTENT_INVALID', index)
  }
  for (const [index, quest] of memory.quests.entries()) {
    if (!quest.title) memoryIssue(issues, 'quests', quest, 'title', null, 'WORLD_MEMORY_QUEST_TITLE_INVALID', index)
  }
  for (const [index, thread] of memory.threads.entries()) {
    if (!thread.title) memoryIssue(issues, 'threads', thread, 'title', null, 'WORLD_MEMORY_THREAD_TITLE_INVALID', index)
  }
  for (const [index, claim] of memory.epistemic_claims.entries()) {
    if (!claim.claim) memoryIssue(issues, 'epistemic_claims', claim, 'claim', null, 'WORLD_MEMORY_CLAIM_INVALID', index)
  }
  for (const [index, summary] of memory.summaries.entries()) {
    if (!summary.title || !summary.summary) memoryIssue(issues, 'summaries', summary, 'content', null, 'WORLD_MEMORY_SUMMARY_INVALID', index)
  }
  return issues
}

function normalizeEntityInput(input) {
  const value = plainObject(input, 'entity')
  assertFields(value, new Set(['id', 'kind', 'name', 'summary', 'aliases', 'visibility', 'tags']), 'entity')
  const kind = text(value.kind, 30)
  if (!ENTITY_KINDS.has(kind)) throw new WorldMemoryValidationError('Неизвестный тип сущности мира', 'WORLD_ENTITY_KIND_INVALID')
  const result = { id: id(value.id, 'entity.id'), kind, name: text(value.name, 160), summary: text(value.summary, 1_000), aliases: strings(value.aliases, 120, 20), visibility: visibility(value.visibility), tags: strings(value.tags, 60, 20) }
  if (!result.name) throw new WorldMemoryValidationError('У сущности мира должно быть имя', 'WORLD_ENTITY_NAME_REQUIRED')
  return result
}

function normalizeFactInput(input, memory, commandId, state = {}) {
  const value = plainObject(input, 'fact')
  assertFields(value, new Set(['id', 'subject_id', 'predicate', 'object', 'summary', 'visibility', 'source_event_ids', 'supersedes_fact_id']), 'fact')
  const result = {
    id: id(value.id, 'fact.id'), subject_id: id(value.subject_id, 'fact.subject_id'), predicate: text(value.predicate, 120),
    object: text(value.object, 1_000), summary: text(value.summary, 1_000), visibility: visibility(value.visibility),
    source_event_ids: strings(value.source_event_ids, 120, 30), source_command_id: text(commandId, 160),
    supersedes_fact_id: value.supersedes_fact_id ? id(value.supersedes_fact_id, 'fact.supersedes_fact_id') : '', status: 'active',
    recorded_at_minutes: elapsedMinutes(state),
  }
  if (!memory.entities.some((entity) => entity.id === result.subject_id)) throw new WorldMemoryValidationError('Сущность факта не найдена', 'WORLD_ENTITY_NOT_FOUND')
  if (!result.predicate || (!result.object && !result.summary)) throw new WorldMemoryValidationError('Факт должен содержать predicate и object/summary', 'WORLD_FACT_CONTENT_REQUIRED')
  if (memory.facts.some((fact) => fact.id === result.id)) throw new WorldMemoryValidationError('Факт с таким id уже существует; создайте новый факт с supersedes_fact_id', 'WORLD_FACT_ALREADY_EXISTS')
  if (result.supersedes_fact_id && !memory.facts.some((fact) => fact.id === result.supersedes_fact_id && fact.status === 'active')) throw new WorldMemoryValidationError('Заменяемый факт не найден', 'WORLD_FACT_NOT_FOUND')
  return result
}

function normalizeRelationshipInput(input, memory, commandId, state = {}) {
  const value = plainObject(input, 'relationship')
  assertFields(value, new Set(['id', 'from_entity_id', 'relation', 'to_entity_id', 'summary', 'visibility', 'source_event_ids', 'supersedes_relationship_id']), 'relationship')
  const result = {
    id: id(value.id, 'relationship.id'), from_entity_id: id(value.from_entity_id, 'relationship.from_entity_id'),
    relation: text(value.relation, 120), to_entity_id: id(value.to_entity_id, 'relationship.to_entity_id'), summary: text(value.summary, 1_000),
    visibility: visibility(value.visibility), source_event_ids: strings(value.source_event_ids, 120, 30), source_command_id: text(commandId, 160),
    supersedes_relationship_id: value.supersedes_relationship_id ? id(value.supersedes_relationship_id, 'relationship.supersedes_relationship_id') : '',
    status: 'active', recorded_at_minutes: elapsedMinutes(state),
  }
  if (!memory.entities.some((entity) => entity.id === result.from_entity_id) || !memory.entities.some((entity) => entity.id === result.to_entity_id)) throw new WorldMemoryValidationError('Сущность отношения не найдена', 'WORLD_ENTITY_NOT_FOUND')
  if (!result.relation || !result.summary) throw new WorldMemoryValidationError('Отношение должно содержать relation и summary', 'WORLD_RELATIONSHIP_CONTENT_REQUIRED')
  if (memory.relationships.some((relationship) => relationship.id === result.id)) throw new WorldMemoryValidationError('Отношение с таким id уже существует; создайте новое с supersedes_relationship_id', 'WORLD_RELATIONSHIP_ALREADY_EXISTS')
  if (result.supersedes_relationship_id && !memory.relationships.some((relationship) => relationship.id === result.supersedes_relationship_id && relationship.status === 'active')) throw new WorldMemoryValidationError('Заменяемое отношение не найдено', 'WORLD_RELATIONSHIP_NOT_FOUND')
  return result
}

function normalizeQuestInput(input, memory, state = {}) {
  const value = plainObject(input, 'quest')
  assertFields(value, new Set(['id', 'title', 'summary', 'status', 'visibility', 'entity_ids', 'objectives', 'clock', 'responsibility', 'giver_npc_id']), 'quest')
  if (value.clock != null) {
    plainObject(value.clock, 'quest.clock')
    assertFields(value.clock, new Set(['current', 'max', 'label']), 'quest.clock')
  }
  const result = {
    id: id(value.id, 'quest.id'), title: text(value.title, 180), summary: text(value.summary, 1_000),
    status: text(value.status || 'active', 30), visibility: visibility(value.visibility, 'party'),
    entity_ids: strings(value.entity_ids, 120, 30), objectives: strings(value.objectives, 300, 20),
    clock: clock(value.clock), recorded_at_minutes: elapsedMinutes(state),
  }
  if (!QUEST_STATUSES.has(result.status)) throw new WorldMemoryValidationError('Неизвестный статус квеста', 'WORLD_QUEST_STATUS_INVALID')
  if (!result.title) throw new WorldMemoryValidationError('У квеста должен быть заголовок', 'WORLD_QUEST_TITLE_REQUIRED')
  if (result.entity_ids.some((entityId) => !memory.entities.some((entity) => entity.id === entityId))) throw new WorldMemoryValidationError('Квест ссылается на неизвестную сущность', 'WORLD_ENTITY_NOT_FOUND')
  // Техническое обновление старого поручения не снимает его зависимость.
  const previous = memory.quests.find((quest) => quest.id === result.id)
  const responsibility = normalizeQuestResponsibility(value.responsibility ?? previous?.responsibility)
  if (value.responsibility != null && !responsibility) throw new WorldMemoryValidationError('Неизвестная политика ответственности по поручению', 'WORLD_QUEST_RESPONSIBILITY_INVALID')
  if (responsibility) {
    const exists = responsibility.type === 'npc'
      ? state.social?.npcs?.some((npc) => npc.id === responsibility.npc_id)
      : state.world_offices?.offices?.some((office) => office.id === responsibility.office_id)
    if (!exists) throw new WorldMemoryValidationError('Ответственный за поручение не найден', 'WORLD_QUEST_RESPONSIBILITY_INVALID')
    result.responsibility = responsibility
    result.giver_npc_id = questGiverId(state, responsibility)
    if (['active', 'offered'].includes(result.status) && questIsImpossible(state, result)) throw new WorldMemoryValidationError('Поручение невозможно: необходимый NPC погиб', 'WORLD_QUEST_IMPOSSIBLE')
  }
  return result
}

function normalizeThreadInput(input, memory, commandId, state = {}) {
  const value = plainObject(input, 'thread')
  assertFields(value, new Set(['id', 'title', 'summary', 'status', 'visibility', 'entity_ids', 'quest_ids', 'clock', 'source_event_ids']), 'thread')
  if (value.clock != null) {
    plainObject(value.clock, 'thread.clock')
    assertFields(value.clock, new Set(['current', 'max', 'label']), 'thread.clock')
  }
  const result = {
    id: id(value.id, 'thread.id'), title: text(value.title, 180), summary: text(value.summary, 1_000),
    status: text(value.status || 'active', 30), visibility: visibility(value.visibility, 'party'),
    entity_ids: strings(value.entity_ids, 120, 30), quest_ids: strings(value.quest_ids, 120, 30), clock: clock(value.clock),
    source_event_ids: strings(value.source_event_ids, 120, 30), source_command_id: text(commandId, 160), recorded_at_minutes: elapsedMinutes(state),
  }
  if (!THREAD_STATUSES.has(result.status)) throw new WorldMemoryValidationError('Неизвестный статус сюжетной нити', 'WORLD_THREAD_STATUS_INVALID')
  if (!result.title) throw new WorldMemoryValidationError('У сюжетной нити должен быть заголовок', 'WORLD_THREAD_TITLE_REQUIRED')
  if (result.entity_ids.some((entityId) => !memory.entities.some((entity) => entity.id === entityId))) throw new WorldMemoryValidationError('Нить ссылается на неизвестную сущность', 'WORLD_ENTITY_NOT_FOUND')
  if (result.quest_ids.some((questId) => !memory.quests.some((quest) => quest.id === questId))) throw new WorldMemoryValidationError('Нить ссылается на неизвестный квест', 'WORLD_QUEST_NOT_FOUND')
  return result
}

function normalizeEpistemicClaimInput(input, memory, commandId, state = {}, kind = 'belief') {
  const value = plainObject(input, kind === 'rumor' ? 'rumor' : 'belief')
  assertFields(value, new Set(['id', 'holder_entity_id', 'subject_entity_id', 'predicate', 'claim', 'summary', 'visibility', 'source_event_ids']), kind === 'rumor' ? 'rumor' : 'belief')
  const result = {
    id: id(value.id, 'claim.id'), kind, holder_entity_id: id(value.holder_entity_id, 'claim.holder_entity_id'),
    subject_entity_id: value.subject_entity_id ? id(value.subject_entity_id, 'claim.subject_entity_id') : '', predicate: text(value.predicate, 120),
    claim: text(value.claim, 1_000), summary: text(value.summary, 1_000), visibility: visibility(value.visibility), truth_status: 'unknown',
    source_event_ids: strings(value.source_event_ids, 120, 30), source_command_id: text(commandId, 160),
    truth_source_event_ids: [], truth_source_command_id: '', recorded_at_minutes: elapsedMinutes(state),
  }
  const holder = memory.entities.find((entity) => entity.id === result.holder_entity_id)
  if (!holder || holder.kind !== 'npc') throw new WorldMemoryValidationError('Убеждение или слух должен принадлежать известному NPC', 'WORLD_NPC_BELIEF_HOLDER_INVALID')
  if (result.subject_entity_id && !memory.entities.some((entity) => entity.id === result.subject_entity_id)) throw new WorldMemoryValidationError('Сущность утверждения не найдена', 'WORLD_ENTITY_NOT_FOUND')
  if (!result.claim) throw new WorldMemoryValidationError('Убеждение или слух не может быть пустым', 'WORLD_EPISTEMIC_CLAIM_REQUIRED')
  if (memory.epistemic_claims.some((claim) => claim.id === result.id)) throw new WorldMemoryValidationError('Убеждение или слух с таким id уже существует', 'WORLD_EPISTEMIC_CLAIM_ALREADY_EXISTS')
  return result
}

function normalizeSummaryInput(input, memory, commandId, state = {}) {
  const value = plainObject(input, 'summary')
  assertFields(value, new Set(['id', 'kind', 'title', 'summary', 'visibility', 'entity_ids', 'thread_ids', 'source_event_ids']), 'summary')
  const result = {
    id: id(value.id, 'summary.id'), kind: text(value.kind || 'scene', 30), title: text(value.title, 180), summary: text(value.summary, 2_000),
    visibility: visibility(value.visibility, 'party'), entity_ids: strings(value.entity_ids, 120, 30), thread_ids: strings(value.thread_ids, 120, 30),
    source_event_ids: strings(value.source_event_ids, 120, 50), source_command_id: text(commandId, 160), recorded_at_minutes: elapsedMinutes(state),
  }
  if (!SUMMARY_KINDS.has(result.kind)) throw new WorldMemoryValidationError('Неизвестный тип summary', 'WORLD_SUMMARY_KIND_INVALID')
  if (!result.title || !result.summary) throw new WorldMemoryValidationError('Summary должен содержать title и summary', 'WORLD_SUMMARY_CONTENT_REQUIRED')
  if (!result.source_event_ids.length) throw new WorldMemoryValidationError('Summary требует source_event_ids', 'WORLD_SUMMARY_PROVENANCE_REQUIRED')
  if (memory.summaries.some((summary) => summary.id === result.id)) throw new WorldMemoryValidationError('Summary с таким id уже существует', 'WORLD_SUMMARY_ALREADY_EXISTS')
  if (result.entity_ids.some((entityId) => !memory.entities.some((entity) => entity.id === entityId))) throw new WorldMemoryValidationError('Summary ссылается на неизвестную сущность', 'WORLD_ENTITY_NOT_FOUND')
  if (result.thread_ids.some((threadId) => !memory.threads.some((thread) => thread.id === threadId))) throw new WorldMemoryValidationError('Summary ссылается на неизвестную нить', 'WORLD_THREAD_NOT_FOUND')
  return result
}

function validateKnowledgeTargets(targetIds, state) {
  const target_ids = strings(targetIds, 120, 20)
  const partyIds = new Set((state.partyMemberIds ?? []).map(String))
  if (!target_ids.length || target_ids.some((actorId) => !partyIds.has(actorId))) throw new WorldMemoryValidationError('Знание можно открыть только конкретным героям группы', 'WORLD_KNOWLEDGE_TARGET_INVALID')
  return target_ids
}

export function validateWorldMemoryCommand(command, state, context = {}) {
  if (!WORLD_MEMORY_COMMAND_TYPES.has(command.command_type)) return command
  if (context.isAdmin !== true && context.isDirector !== true) throw new WorldMemoryValidationError('Память мира изменяет только системный контур кампании', 'WORLD_MEMORY_FORBIDDEN')
  const memory = normalizeWorldMemory(state.worldMemory)
  const result = { ...command, actor_id: null }
  if (command.command_type === 'UpsertWorldEntity') {
    result.entity = normalizeEntityInput(command.entity)
    result.visibility = result.entity.visibility
  }
  if (command.command_type === 'RecordWorldFact') {
    result.fact = normalizeFactInput(command.fact, memory, command.command_id, state)
    result.visibility = result.fact.visibility
  }
  if (command.command_type === 'RecordWorldRelationship') {
    result.relationship = normalizeRelationshipInput(command.relationship, memory, command.command_id, state)
    result.visibility = result.relationship.visibility
  }
  if (command.command_type === 'RevealWorldFact' || command.command_type === 'RecordKnowledgeRevelation') {
    result.fact_id = id(command.fact_id, 'fact_id')
    if (!memory.facts.some((fact) => fact.id === result.fact_id && fact.status === 'active')) throw new WorldMemoryValidationError('Факт не найден', 'WORLD_FACT_NOT_FOUND')
    result.target_ids = validateKnowledgeTargets(command.target_ids, state)
    result.source_event_ids = strings(command.source_event_ids, 120, 30)
    result.visibility = 'specific_player'
  }
  if (command.command_type === 'UpsertQuest') {
    result.quest = normalizeQuestInput(command.quest, memory, state)
    result.visibility = result.quest.visibility
  }
  if (command.command_type === 'AdvanceQuestClock') {
    result.quest_id = id(command.quest_id, 'quest_id')
    const quest = memory.quests.find((item) => item.id === result.quest_id)
    if (!quest) throw new WorldMemoryValidationError('Квест не найден', 'WORLD_QUEST_NOT_FOUND')
    if (quest.status === 'offered') throw new WorldMemoryValidationError('Отряд ещё не принял это поручение', 'WORLD_QUEST_NOT_ACCEPTED')
    if (['completed', 'failed', 'abandoned'].includes(quest.status)) throw new WorldMemoryValidationError('Часы завершённого квеста нельзя изменять', 'WORLD_QUEST_CLOSED')
    result.amount = integer(command.amount, 1)
    if (result.amount < 1 || result.amount > 20) throw new WorldMemoryValidationError('Шаг часов должен быть от 1 до 20', 'WORLD_QUEST_CLOCK_INVALID')
    result.visibility = quest.visibility
  }
  if (command.command_type === 'ResolveQuest') {
    result.quest_id = id(command.quest_id, 'quest_id')
    const quest = memory.quests.find((item) => item.id === result.quest_id)
    if (!quest) throw new WorldMemoryValidationError('Квест не найден', 'WORLD_QUEST_NOT_FOUND')
    if (quest.status !== 'active') throw new WorldMemoryValidationError('Разрешить можно только активный квест', 'WORLD_QUEST_CLOSED')
    result.outcome = text(command.outcome, 20)
    if (!['success', 'failure', 'abandoned'].includes(result.outcome)) throw new WorldMemoryValidationError('Исход квеста должен быть success, failure или abandoned', 'WORLD_QUEST_OUTCOME_INVALID')
    // Отказ — единственный исход, не требующий заполненных часов: отряд закрывает
    // нить своим решением, а не её развязкой. Успех и провал по-прежнему
    // наступают только тогда, когда часы дошли до конца.
    if (result.outcome !== 'abandoned' && quest.clock?.triggered !== true) {
      throw new WorldMemoryValidationError('Квест нельзя разрешить до заполнения его часов', 'WORLD_QUEST_CLOCK_NOT_TRIGGERED')
    }
    result.summary = text(command.summary, 1_000)
    if (!result.summary) throw new WorldMemoryValidationError('Развязка квеста требует подтверждённого итога', 'WORLD_QUEST_RESOLUTION_REQUIRED')
    result.next_objective = text(command.next_objective, 300)
    if (!result.next_objective) throw new WorldMemoryValidationError('Развязка квеста требует следующей цели', 'WORLD_QUEST_NEXT_OBJECTIVE_REQUIRED')
    result.source_event_ids = strings(command.source_event_ids, 120, 30)
    result.visibility = quest.visibility
  }
  if (command.command_type === 'InvalidateQuest') {
    result.quest_id = id(command.quest_id, 'quest_id')
    const quest = memory.quests.find((entry) => entry.id === result.quest_id)
    const draft = questInvalidationDraft(state, quest, { primaryQuestId: state.campaignConcept?.story_quest_id })
    if (!draft) throw new WorldMemoryValidationError('Нет подтверждённой причины невозможности поручения', 'WORLD_QUEST_INVALIDATION_UNPROVEN')
    result.invalidation = draft.payload
    result.visibility = draft.visibility
  }
  if (command.command_type === 'UpsertNarrativeThread') {
    result.thread = normalizeThreadInput(command.thread, memory, command.command_id, state)
    result.visibility = result.thread.visibility
  }
  if (command.command_type === 'AdvanceNarrativeThreadClock') {
    result.thread_id = id(command.thread_id, 'thread_id')
    const thread = memory.threads.find((item) => item.id === result.thread_id)
    if (!thread) throw new WorldMemoryValidationError('Сюжетная нить не найдена', 'WORLD_THREAD_NOT_FOUND')
    if (['resolved', 'failed', 'abandoned'].includes(thread.status)) throw new WorldMemoryValidationError('Часы завершённой сюжетной нити нельзя изменять', 'WORLD_THREAD_CLOSED')
    result.amount = integer(command.amount, 1)
    if (result.amount < 1 || result.amount > 20) throw new WorldMemoryValidationError('Шаг часов должен быть от 1 до 20', 'WORLD_THREAD_CLOCK_INVALID')
    result.visibility = thread.visibility
  }
  if (command.command_type === 'RecordNpcBelief' || command.command_type === 'RecordRumor') {
    result.claim = normalizeEpistemicClaimInput(command.claim, memory, command.command_id, state, command.command_type === 'RecordRumor' ? 'rumor' : 'belief')
    result.visibility = result.claim.visibility
  }
  if (command.command_type === 'ResolveEpistemicClaim') {
    result.claim_id = id(command.claim_id, 'claim_id')
    const claim = memory.epistemic_claims.find((item) => item.id === result.claim_id)
    if (!claim) throw new WorldMemoryValidationError('Убеждение или слух не найден', 'WORLD_EPISTEMIC_CLAIM_NOT_FOUND')
    result.truth_status = text(command.truth_status, 30)
    if (!['confirmed', 'refuted'].includes(result.truth_status)) throw new WorldMemoryValidationError('Истину убеждения можно только подтвердить или опровергнуть', 'WORLD_TRUTH_STATUS_INVALID')
    result.source_event_ids = strings(command.source_event_ids, 120, 30)
    if (!result.source_event_ids.length) throw new WorldMemoryValidationError('Подтверждение истины требует source_event_ids', 'WORLD_TRUTH_PROVENANCE_REQUIRED')
    result.visibility = claim.visibility
  }
  if (command.command_type === 'RecordNarrativeSummary') {
    result.summary = normalizeSummaryInput(command.summary, memory, command.command_id, state)
    result.visibility = result.summary.visibility
  }
  return result
}

export function worldMemoryEvent(command) {
  if (command.command_type === 'InvalidateQuest') return { event_type: 'QuestInvalidated', payload: clone(command.invalidation), target_ids: [] }
  if (command.command_type === 'UpsertWorldEntity') return { event_type: 'WorldEntityUpserted', payload: { entity: clone(command.entity) }, target_ids: [] }
  if (command.command_type === 'RecordWorldFact') return { event_type: 'WorldFactRecorded', payload: { fact: clone(command.fact) }, target_ids: [] }
  // Kept for existing event streams. The reducer now also records an immutable
  // knowledge_revealed entry from this legacy event.
  if (command.command_type === 'RevealWorldFact') return { event_type: 'WorldFactRevealed', payload: { fact_id: command.fact_id, source_event_ids: clone(command.source_event_ids ?? []) }, target_ids: clone(command.target_ids) }
  if (command.command_type === 'RecordKnowledgeRevelation') return { event_type: 'KnowledgeRevealed', payload: { fact_id: command.fact_id, source_event_ids: clone(command.source_event_ids ?? []) }, target_ids: clone(command.target_ids) }
  if (command.command_type === 'RecordWorldRelationship') return { event_type: 'WorldRelationshipRecorded', payload: { relationship: clone(command.relationship) }, target_ids: [] }
  if (command.command_type === 'UpsertQuest') return { event_type: 'QuestUpserted', payload: { schema_version: 2, quest: clone(command.quest) }, target_ids: [] }
  if (command.command_type === 'AdvanceQuestClock') return { event_type: 'QuestClockAdvanced', payload: { quest_id: command.quest_id, amount: command.amount }, target_ids: [] }
  if (command.command_type === 'ResolveQuest') return { event_type: 'QuestResolved', payload: {
    quest_id: command.quest_id,
    outcome: command.outcome,
    status: questStatusForOutcome(command.outcome),
    summary: command.summary,
    next_objective: command.next_objective,
    source_event_ids: clone(command.source_event_ids ?? []),
    // Поле появляется только у развязок, привязанных к запросу Режиссёра. Без
    // него payload собирается байт в байт как раньше, и уже записанные события
    // читаются без изменений.
    ...(command.request_fingerprint ? { request_fingerprint: String(command.request_fingerprint).slice(0, 128) } : {}),
  }, target_ids: [] }
  if (command.command_type === 'UpsertNarrativeThread') return { event_type: 'NarrativeThreadUpserted', payload: { thread: clone(command.thread) }, target_ids: [] }
  if (command.command_type === 'AdvanceNarrativeThreadClock') return { event_type: 'NarrativeThreadClockAdvanced', payload: { thread_id: command.thread_id, amount: command.amount }, target_ids: [] }
  if (command.command_type === 'RecordNpcBelief') return { event_type: 'NpcBeliefRecorded', payload: { claim: clone(command.claim) }, target_ids: [] }
  if (command.command_type === 'RecordRumor') return { event_type: 'RumorRecorded', payload: { claim: clone(command.claim) }, target_ids: [] }
  if (command.command_type === 'ResolveEpistemicClaim') return { event_type: 'EpistemicClaimTruthResolved', payload: { claim_id: command.claim_id, truth_status: command.truth_status, source_event_ids: clone(command.source_event_ids ?? []) }, target_ids: [] }
  if (command.command_type === 'RecordNarrativeSummary') return { event_type: 'NarrativeSummaryRecorded', payload: { summary: clone(command.summary) }, target_ids: [] }
  return null
}

function appendKnowledge(memory, event, factId, targetIds, payload = {}) {
  const availableFacts = new Set(memory.facts.map((fact) => fact.id))
  if (!availableFacts.has(factId)) return memory
  const entries = [...(memory.knowledge_ledger ?? memory.knowledge_revealed ?? [])]
  for (const heroId of targetIds ?? []) {
    const hero = text(heroId, 120)
    if (!hero) continue
    const entry = safeKnowledgeEntry({
      id: text(payload.knowledge_id || stableId('knowledge', event.event_id || event.command_id || 'legacy', hero, factId), 120),
      hero_id: hero, fact_id: factId, summary: payload.summary,
      source_event_ids: payload.source_event_ids ?? [], source_command_id: event.command_id,
      revealed_event_id: event.event_id || '', recorded_at_minutes: event.recorded_at_minutes ?? payload.revealed_at_minutes ?? payload.recorded_at_minutes,
      source_kind: payload.source_kind ?? (event.event_type === 'WorldFactRevealed' ? 'world_fact_revealed' : 'knowledge_revealed'),
    })
    if (!entries.some((candidate) => candidate.id === entry.id)) entries.push(entry)
  }
  memory.knowledge_revealed = retentionMode() === 'legacy' ? entries.slice(-5_000) : entries
  memory.knowledge_ledger = memory.knowledge_revealed
  memory.knowledge = indexKnowledge(memory.knowledge_revealed)
  return memory
}

/** prepared разрешён только владельцу уже нормализованной приватной копии. */
export function applyWorldMemoryEvent(input, event, { prepared = false } = {}) {
  const owned = prepared && retentionMode() !== 'legacy'
  const normalize = retentionMode() === 'legacy' ? normalizeWorldMemoryLegacy : normalizeWorldMemory
  const memory = owned ? input : normalize(input)
  const payload = event.payload ?? {}
  if (event.event_type === 'WorldEntityUpserted') {
    const entity = safeEntity(payload.entity)
    memory.entities = [...memory.entities.filter((item) => item.id !== entity.id), entity]
  }
  if (event.event_type === 'WorldFactRecorded') {
    const fact = safeFact(payload.fact)
    if (fact.supersedes_fact_id) memory.facts = memory.facts.map((item) => item.id === fact.supersedes_fact_id ? { ...item, status: 'superseded' } : item)
    memory.facts.push(fact)
  }
  if (event.event_type === 'WorldRelationshipRecorded') {
    const relationship = safeRelationship(payload.relationship)
    if (relationship.supersedes_relationship_id) memory.relationships = memory.relationships.map((item) => item.id === relationship.supersedes_relationship_id ? { ...item, status: 'superseded' } : item)
    memory.relationships.push(relationship)
  }
  if (event.event_type === 'WorldFactRevealed' || event.event_type === 'KnowledgeRevealed') {
    appendKnowledge(memory, event, text(payload.fact_id, 120), event.target_ids ?? [], payload)
  }
  if (event.event_type === 'QuestUpserted') {
    const quest = safeQuest(payload.quest)
    const previous = memory.quests.find((item) => item.id === quest.id)
    const history = previous ? recordQuestKnowledge(previous, event).knowledge_history : null
    memory.quests = [...memory.quests.filter((item) => item.id !== quest.id), {
      ...quest,
      ...(history ? { knowledge_history: history } : {}),
    }]
  }
  if (event.event_type === 'QuestClockAdvanced') {
    memory.quests = memory.quests.map((quest) => {
      if (quest.id !== payload.quest_id) return quest
      const current = Math.min(quest.clock.max, quest.clock.current + Math.max(1, integer(payload.amount, 1)))
      return { ...recordQuestKnowledge(quest, event), clock: { ...quest.clock, current, triggered: current >= quest.clock.max } }
    })
  }
  if (event.event_type === 'QuestResolved' || event.event_type === 'QuestInvalidated' && [1, 2].includes(payload.schema_version)) {
    memory.quests = memory.quests.map((quest) => quest.id === payload.quest_id ? {
      ...recordQuestKnowledge(quest, event),
      status: questStatusForOutcome(payload.outcome),
      summary: text(payload.summary, 1_000) || quest.summary,
      ...(payload.stay_in_location === true && payload.event_schema_version === 2 ? { stay_in_location: true } : {}),
    } : quest)
  }
  if (event.event_type === 'QuestAssignmentChanged' && [1, 2].includes(payload.schema_version)) {
    memory.quests = memory.quests.map((quest) => quest.id === payload.quest_id ? {
      ...recordQuestKnowledge(quest, event), giver_npc_id: text(payload.giver_npc_id, 120) || null,
    } : quest)
  }
  if (event.event_type === 'QuestAccepted' && [1, 2].includes(payload.schema_version)) {
    memory.quests = memory.quests.map((quest) => quest.id === payload.quest_id ? { ...recordQuestKnowledge(quest, event), status: 'active' } : quest)
  }
  if (event.event_type === 'NarrativeThreadUpserted') {
    const thread = safeThread(payload.thread)
    memory.threads = [...memory.threads.filter((item) => item.id !== thread.id), thread]
  }
  if (event.event_type === 'NarrativeThreadClockAdvanced') {
    memory.threads = memory.threads.map((thread) => {
      if (thread.id !== payload.thread_id) return thread
      const current = Math.min(thread.clock.max, thread.clock.current + Math.max(1, integer(payload.amount, 1)))
      return { ...thread, clock: { ...thread.clock, current, triggered: current >= thread.clock.max } }
    })
  }
  if (event.event_type === 'NpcBeliefRecorded' || event.event_type === 'RumorRecorded') {
    const claim = safeEpistemicClaim(payload.claim)
    memory.epistemic_claims = [...memory.epistemic_claims.filter((item) => item.id !== claim.id), claim]
  }
  if (event.event_type === 'EpistemicClaimTruthResolved') {
    memory.epistemic_claims = memory.epistemic_claims.map((claim) => claim.id === payload.claim_id ? {
      ...claim, truth_status: TRUTH_STATUSES.has(payload.truth_status) ? payload.truth_status : claim.truth_status,
      truth_source_event_ids: persistedStrings(payload.source_event_ids, 120), truth_source_command_id: text(event.command_id, 160),
    } : claim)
  }
  if (event.event_type === 'NarrativeSummaryRecorded') {
    const summary = safeSummary(payload.summary)
    memory.summaries = [...memory.summaries.filter((item) => item.id !== summary.id), summary]
    if (retentionMode() === 'legacy') memory.summaries = memory.summaries.slice(-1_000)
  }
  return owned ? memory : normalize(memory)
}

function normallyVisible(item, viewer) {
  if (viewer.isAdmin) return true
  if (item.visibility === 'public') return true
  return item.visibility === 'party' && viewer.isPartyMember !== false
}

function asOfMinutes(viewer = {}) {
  const raw = viewer.asOfMinutes ?? viewer.as_of_minutes
  return Number.isSafeInteger(Number(raw)) && Number(raw) >= 0 ? Number(raw) : null
}

function inTime(item, maximum) {
  return maximum == null || recordedAt(item?.recorded_at_minutes) <= maximum
}

/** Filters canonical memory before it is sent to a player or a retrieval model. */
export function worldMemoryForViewer(input, viewer = {}) {
  const memory = normalizeWorldMemory(input)
  const maximum = asOfMinutes(viewer)
  if (viewer.isAdmin) {
    const admin = {
      ...memory,
      facts: memory.facts.filter((item) => inTime(item, maximum)), relationships: memory.relationships.filter((item) => inTime(item, maximum)),
      quests: memory.quests.filter((item) => inTime(item, maximum)), threads: memory.threads.filter((item) => inTime(item, maximum)),
      epistemic_claims: memory.epistemic_claims.filter((item) => inTime(item, maximum)), summaries: memory.summaries.filter((item) => inTime(item, maximum)),
      knowledge_revealed: memory.knowledge_revealed.filter((item) => inTime(item, maximum)),
    }
    return { ...clone(admin), knowledge: indexKnowledge(admin.knowledge_revealed), knowledge_ledger: clone(admin.knowledge_revealed) }
  }
  const playerId = text(viewer.playerId, 120)
  // Derive the known-fact index from the time-filtered append-only ledger.
  // Looking at the compatibility `knowledge` index here would reveal a fact
  // before the historical moment at which the character learned it.
  const playerKnowledge = (memory.knowledge_ledger ?? memory.knowledge_revealed ?? [])
    .filter((entry) => entry.hero_id === playerId && inTime(entry, maximum))
  const known = new Set(playerKnowledge.map((entry) => entry.fact_id))
  const facts = memory.facts.filter((fact) => fact.status === 'active' && inTime(fact, maximum) && (normallyVisible(fact, viewer) || known.has(fact.id)))
  // История последствий разрешается относительно знания, существовавшего в
  // запрошенный момент. Будущее раскрытие не должно менять старый скрытый
  // статус в исторической проекции.
  const knowledgeMemory = {
    ...memory,
    facts: memory.facts.filter((fact) => inTime(fact, maximum)),
    knowledge_ledger: playerKnowledge,
    knowledge_revealed: playerKnowledge,
  }
  const quests = memory.quests
    .map((quest) => questForKnowledge(quest, knowledgeMemory, viewer))
    .filter((quest) => quest.status !== 'hidden' && inTime(quest, maximum) && normallyVisible(quest, viewer))
  const threads = memory.threads.filter((thread) => thread.status !== 'hidden' && inTime(thread, maximum) && normallyVisible(thread, viewer))
  const referenced = new Set([...facts.map((fact) => fact.subject_id), ...quests.flatMap((quest) => quest.entity_ids), ...threads.flatMap((thread) => thread.entity_ids)])
  const entities = memory.entities.filter((entity) => normallyVisible(entity, viewer) || referenced.has(entity.id))
  const visibleEntityIds = new Set(entities.map((entity) => entity.id))
  const relationships = memory.relationships.filter((relationship) => relationship.status === 'active' && inTime(relationship, maximum)
    && normallyVisible(relationship, viewer) && visibleEntityIds.has(relationship.from_entity_id) && visibleEntityIds.has(relationship.to_entity_id))
  const epistemic_claims = memory.epistemic_claims.filter((claim) => inTime(claim, maximum) && normallyVisible(claim, viewer)
    && visibleEntityIds.has(claim.holder_entity_id) && (!claim.subject_entity_id || visibleEntityIds.has(claim.subject_entity_id)))
  const summaries = memory.summaries.filter((summary) => inTime(summary, maximum) && normallyVisible(summary, viewer))
  const visibleFactIds = new Set(facts.map((fact) => fact.id))
  const knowledge_revealed = playerKnowledge.filter((entry) => visibleFactIds.has(entry.fact_id))
  return {
    schema_version: 2, entities: clone(entities), facts: clone(facts), relationships: clone(relationships), quests: clone(quests), threads: clone(threads),
    epistemic_claims: clone(epistemic_claims), summaries: clone(summaries), knowledge: playerId ? { [playerId]: [...known].filter((factId) => visibleFactIds.has(factId)) } : {},
    knowledge_revealed: clone(knowledge_revealed), knowledge_ledger: clone(knowledge_revealed),
  }
}

function tokenize(value) {
  return text(value, 8_000).toLocaleLowerCase('ru').split(/[^a-zа-яё0-9]+/iu).filter((token) => token.length >= 3).slice(0, 240)
}

function stem(token) {
  let value = text(token, 120).toLocaleLowerCase('ru')
  if (/^[а-яё]+$/u.test(value)) value = value.replace(/(?:иями|ями|ами|ого|ему|ыми|ими|иях|иях|ость|ости|ение|ений|ать|ять|ить|ешь|ете|ают|яют|ого|ему|ами|ях|ах|ов|ев|ий|ый|ая|ое|ие|ам|ом|ую|ы|и|а|я|е|о|у)$/u, '')
  else value = value.replace(/(?:ization|ations|ation|ments|ment|ingly|ingly|ing|edly|ed|ies|es|s)$/u, '')
  return value.length >= 3 ? value : text(token, 120).toLocaleLowerCase('ru')
}

const SYNONYM_GROUPS = [
  ['город', 'поселение', 'столица', 'деревня', 'town', 'city', 'settlement'],
  ['дорога', 'путь', 'маршрут', 'тракт', 'trail', 'route'],
  ['слух', 'молва', 'rumor', 'gossip'],
  ['задание', 'квест', 'цель', 'quest', 'objective'],
  ['гильдия', 'орден', 'фракция', 'союз', 'guild', 'faction'],
  ['опасность', 'угроза', 'враг', 'enemy', 'threat'],
]

const SYNONYM_INDEX = new Map(SYNONYM_GROUPS.flatMap((group, index) => group.map((word) => [stem(word), index])))

function vector(tokens) {
  const counts = new Map()
  for (const token of tokens) {
    const key = stem(token)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function vectorCosine(left, right) {
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (const value of left.values()) leftMagnitude += value * value
  for (const value of right.values()) rightMagnitude += value * value
  for (const [key, value] of left) dot += value * (right.get(key) ?? 0)
  return leftMagnitude && rightMagnitude ? dot / Math.sqrt(leftMagnitude * rightMagnitude) : 0
}

function semanticScore(queryTokens, documentTokens) {
  if (!queryTokens.length) return 0
  const queryStems = queryTokens.map(stem)
  const documentStems = documentTokens.map(stem)
  const documentSet = new Set(documentStems)
  let exact = 0
  let synonym = 0
  for (const queryStem of queryStems) {
    if (documentSet.has(queryStem)) exact += 1
    const group = SYNONYM_INDEX.get(queryStem)
    if (group != null && documentStems.some((candidate) => SYNONYM_INDEX.get(candidate) === group)) synonym += 1
  }
  return exact * 12 + synonym * 4 + Math.round(vectorCosine(vector(queryTokens), vector(documentTokens)) * 10_000) / 1_000
}

function retrievalRecords(memory) {
  const entities = new Map(memory.entities.map((entity) => [entity.id, entity]))
  const entityName = (entityId) => entities.get(entityId)?.name ?? ''
  return [
    ...memory.facts.map((fact) => ({ kind: 'fact', id: fact.id, summary: fact.summary || fact.object, source_event_ids: fact.source_event_ids, fact, entity: entities.get(fact.subject_id) ?? null, search: `${entityName(fact.subject_id)} ${(entities.get(fact.subject_id)?.aliases ?? []).join(' ')} ${fact.predicate} ${fact.object} ${fact.summary}` })),
    ...memory.relationships.map((relationship) => ({ kind: 'relationship', id: relationship.id, summary: relationship.summary, source_event_ids: relationship.source_event_ids, relationship, search: `${entityName(relationship.from_entity_id)} ${relationship.relation} ${entityName(relationship.to_entity_id)} ${relationship.summary}` })),
    ...memory.quests.map((quest) => ({ kind: 'quest', id: quest.id, summary: quest.summary, source_event_ids: [], quest, search: `${quest.title} ${quest.summary} ${quest.objectives.join(' ')}` })),
    ...memory.threads.map((thread) => ({ kind: 'thread', id: thread.id, summary: thread.summary, source_event_ids: thread.source_event_ids, thread, search: `${thread.title} ${thread.summary} ${thread.entity_ids.map(entityName).join(' ')}` })),
    ...memory.epistemic_claims.map((claim) => ({ kind: claim.kind, id: claim.id, summary: claim.summary || claim.claim, source_event_ids: claim.source_event_ids, claim, search: `${entityName(claim.holder_entity_id)} ${entityName(claim.subject_entity_id)} ${claim.predicate} ${claim.claim} ${claim.summary}` })),
    ...memory.summaries.map((summary) => ({ kind: `${summary.kind}_summary`, id: summary.id, summary: summary.summary, source_event_ids: summary.source_event_ids, narrative_summary: summary, search: `${summary.title} ${summary.summary}` })),
  ]
}

/**
 * Deterministic, semantic-like retrieval. Visibility and time filtering happen
 * in worldMemoryForViewer before aliases, stems, synonym groups and cosine
 * scoring are evaluated, so ranking cannot become a hidden-fact side channel.
 */
export function retrieveWorldMemory(input, viewer = {}, { query = '', limit = 8, asOfMinutes: requestedTime } = {}) {
  const memory = worldMemoryForViewer(input, { ...viewer, ...(requestedTime == null ? {} : { asOfMinutes: requestedTime }) })
  const queryTokens = tokenize(query)
  const records = retrievalRecords(memory).map((record) => ({ ...record, score: semanticScore(queryTokens, tokenize(record.search)) }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
  const matched = queryTokens.length && records.some((record) => record.score > 0) ? records.filter((record) => record.score > 0) : records
  return matched.slice(0, Math.max(1, Math.min(30, integer(limit, 8)))).map(({ search, ...record }) => clone(record))
}

/**
 * Player-facing compatibility API. It deliberately filters the canonical
 * projection before ranking and returns provenance only for records already
 * visible to that hero.
 */
export function retrieveKnownWorldMemory(input, { viewer = {}, query = '', limit = 8, atMinutes, asOfMinutes } = {}) {
  const memory = worldMemoryForViewer(input, {
    ...viewer,
    ...(atMinutes == null && asOfMinutes == null ? {} : { asOfMinutes: atMinutes ?? asOfMinutes }),
  })
  const knowledgeEntries = memory.knowledge_ledger ?? memory.knowledge_revealed ?? []
  const knownByFact = new Map()
  for (const entry of knowledgeEntries) {
    const entries = knownByFact.get(entry.fact_id) ?? []
    entries.push(entry)
    knownByFact.set(entry.fact_id, entries)
  }
  return retrieveWorldMemory(memory, { isAdmin: true }, { query, limit, asOfMinutes: atMinutes ?? asOfMinutes })
    .filter((entry) => entry.kind === 'fact')
    .map((entry) => ({
      ...clone(entry.fact), entity: clone(entry.entity),
      citation: {
        fact_id: entry.fact.id,
        source_event_ids: clone(entry.fact.source_event_ids ?? []),
        knowledge_entry_ids: (knownByFact.get(entry.fact.id) ?? []).map((item) => item.id),
      },
    }))
}

/** Compatibility API used by the deterministic Worldkeeper. */
export function knownWorldLore(input, query = '', viewer = { isAdmin: true }) {
  return retrieveWorldMemory(input, viewer, { query, limit: 30 })
    .filter((entry) => entry.kind === 'fact')
    .map((entry) => ({ ...clone(entry.fact), entity: clone(entry.entity) }))
}
