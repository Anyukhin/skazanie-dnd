const ENTITY_KINDS = new Set(['location', 'npc', 'faction', 'item', 'event', 'concept'])
const QUEST_STATUSES = new Set(['hidden', 'active', 'completed', 'failed', 'abandoned'])
const VISIBILITIES = new Set(['public', 'party', 'gm_only'])

export const WORLD_MEMORY_COMMAND_TYPES = new Set([
  'UpsertWorldEntity', 'RecordWorldFact', 'RevealWorldFact', 'UpsertQuest', 'AdvanceQuestClock',
])

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
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback

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

function safeEntity(value = {}) {
  const kind = ENTITY_KINDS.has(text(value.kind, 30)) ? text(value.kind, 30) : 'concept'
  return {
    id: text(value.id, 120), kind, name: text(value.name, 160), summary: text(value.summary, 1_000),
    aliases: strings(value.aliases, 120, 20), visibility: VISIBILITIES.has(value.visibility) ? value.visibility : 'gm_only',
    tags: strings(value.tags, 60, 20),
  }
}

function safeFact(value = {}) {
  return {
    id: text(value.id, 120), subject_id: text(value.subject_id, 120), predicate: text(value.predicate, 120),
    object: text(value.object, 1_000), summary: text(value.summary, 1_000),
    visibility: VISIBILITIES.has(value.visibility) ? value.visibility : 'gm_only',
    source_event_ids: strings(value.source_event_ids, 120, 30),
    source_command_id: text(value.source_command_id, 160),
    supersedes_fact_id: text(value.supersedes_fact_id, 120),
    status: value.status === 'superseded' ? 'superseded' : 'active',
  }
}

function safeQuest(value = {}) {
  const maximum = Math.max(1, Math.min(100, integer(value.clock?.max, 4)))
  const current = Math.max(0, Math.min(maximum, integer(value.clock?.current, 0)))
  return {
    id: text(value.id, 120), title: text(value.title, 180), summary: text(value.summary, 1_000),
    status: QUEST_STATUSES.has(value.status) ? value.status : 'active',
    visibility: VISIBILITIES.has(value.visibility) ? value.visibility : 'party',
    entity_ids: strings(value.entity_ids, 120, 30), objectives: strings(value.objectives, 300, 20),
    clock: { current, max: maximum, label: text(value.clock?.label, 160), triggered: current >= maximum },
  }
}

export function normalizeWorldMemory(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const entities = (Array.isArray(source.entities) ? source.entities : []).map(safeEntity).filter((item) => item.id && item.name).slice(0, 500)
  const entityIds = new Set(entities.map((item) => item.id))
  const facts = (Array.isArray(source.facts) ? source.facts : []).map(safeFact)
    .filter((item) => item.id && item.subject_id && item.predicate && entityIds.has(item.subject_id)).slice(0, 2_000)
  const factIds = new Set(facts.map((item) => item.id))
  const quests = (Array.isArray(source.quests) ? source.quests : []).map(safeQuest).filter((item) => item.id && item.title).slice(0, 300)
  const knowledge = Object.fromEntries(Object.entries(source.knowledge ?? {}).slice(0, 100)
    .map(([actorId, ids]) => [text(actorId, 120), strings(ids, 120, 2_000).filter((factId) => factIds.has(factId))])
    .filter(([actorId]) => actorId))
  return { schema_version: 1, entities, facts, quests, knowledge }
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

function normalizeFactInput(input, memory, commandId) {
  const value = plainObject(input, 'fact')
  assertFields(value, new Set(['id', 'subject_id', 'predicate', 'object', 'summary', 'visibility', 'source_event_ids', 'supersedes_fact_id']), 'fact')
  const result = {
    id: id(value.id, 'fact.id'), subject_id: id(value.subject_id, 'fact.subject_id'), predicate: text(value.predicate, 120),
    object: text(value.object, 1_000), summary: text(value.summary, 1_000), visibility: visibility(value.visibility),
    source_event_ids: strings(value.source_event_ids, 120, 30), source_command_id: text(commandId, 160),
    supersedes_fact_id: value.supersedes_fact_id ? id(value.supersedes_fact_id, 'fact.supersedes_fact_id') : '', status: 'active',
  }
  if (!memory.entities.some((entity) => entity.id === result.subject_id)) throw new WorldMemoryValidationError('Сущность факта не найдена', 'WORLD_ENTITY_NOT_FOUND')
  if (!result.predicate || (!result.object && !result.summary)) throw new WorldMemoryValidationError('Факт должен содержать predicate и object/summary', 'WORLD_FACT_CONTENT_REQUIRED')
  if (memory.facts.some((fact) => fact.id === result.id)) throw new WorldMemoryValidationError('Факт с таким id уже существует; создайте новый факт с supersedes_fact_id', 'WORLD_FACT_ALREADY_EXISTS')
  if (result.supersedes_fact_id && !memory.facts.some((fact) => fact.id === result.supersedes_fact_id && fact.status === 'active')) throw new WorldMemoryValidationError('Заменяемый факт не найден', 'WORLD_FACT_NOT_FOUND')
  return result
}

function normalizeQuestInput(input, memory) {
  const value = plainObject(input, 'quest')
  assertFields(value, new Set(['id', 'title', 'summary', 'status', 'visibility', 'entity_ids', 'objectives', 'clock']), 'quest')
  if (value.clock != null) {
    plainObject(value.clock, 'quest.clock')
    assertFields(value.clock, new Set(['current', 'max', 'label']), 'quest.clock')
  }
  const maximum = Math.max(1, Math.min(100, integer(value.clock?.max, 4)))
  const current = Math.max(0, Math.min(maximum, integer(value.clock?.current, 0)))
  const result = {
    id: id(value.id, 'quest.id'), title: text(value.title, 180), summary: text(value.summary, 1_000),
    status: text(value.status || 'active', 30), visibility: visibility(value.visibility, 'party'),
    entity_ids: strings(value.entity_ids, 120, 30), objectives: strings(value.objectives, 300, 20),
    clock: { current, max: maximum, label: text(value.clock?.label, 160), triggered: current >= maximum },
  }
  if (!QUEST_STATUSES.has(result.status)) throw new WorldMemoryValidationError('Неизвестный статус квеста', 'WORLD_QUEST_STATUS_INVALID')
  if (!result.title) throw new WorldMemoryValidationError('У квеста должен быть заголовок', 'WORLD_QUEST_TITLE_REQUIRED')
  if (result.entity_ids.some((entityId) => !memory.entities.some((entity) => entity.id === entityId))) throw new WorldMemoryValidationError('Квест ссылается на неизвестную сущность', 'WORLD_ENTITY_NOT_FOUND')
  return result
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
    result.fact = normalizeFactInput(command.fact, memory, command.command_id)
    result.visibility = result.fact.visibility
  }
  if (command.command_type === 'RevealWorldFact') {
    result.fact_id = id(command.fact_id, 'fact_id')
    if (!memory.facts.some((fact) => fact.id === result.fact_id && fact.status === 'active')) throw new WorldMemoryValidationError('Факт не найден', 'WORLD_FACT_NOT_FOUND')
    result.target_ids = strings(command.target_ids, 120, 20)
    const partyIds = new Set((state.partyMemberIds ?? []).map(String))
    if (!result.target_ids.length || result.target_ids.some((actorId) => !partyIds.has(actorId))) throw new WorldMemoryValidationError('Знание можно открыть только конкретным героям группы', 'WORLD_KNOWLEDGE_TARGET_INVALID')
    result.visibility = 'specific_player'
  }
  if (command.command_type === 'UpsertQuest') {
    result.quest = normalizeQuestInput(command.quest, memory)
    result.visibility = result.quest.visibility
  }
  if (command.command_type === 'AdvanceQuestClock') {
    result.quest_id = id(command.quest_id, 'quest_id')
    const quest = memory.quests.find((item) => item.id === result.quest_id)
    if (!quest) throw new WorldMemoryValidationError('Квест не найден', 'WORLD_QUEST_NOT_FOUND')
    if (['completed', 'failed', 'abandoned'].includes(quest.status)) throw new WorldMemoryValidationError('Часы завершённого квеста нельзя изменять', 'WORLD_QUEST_CLOSED')
    result.amount = integer(command.amount, 1)
    if (result.amount < 1 || result.amount > 20) throw new WorldMemoryValidationError('Шаг часов должен быть от 1 до 20', 'WORLD_QUEST_CLOCK_INVALID')
    result.visibility = quest.visibility
  }
  return result
}

export function worldMemoryEvent(command) {
  if (command.command_type === 'UpsertWorldEntity') return { event_type: 'WorldEntityUpserted', payload: { entity: clone(command.entity) }, target_ids: [] }
  if (command.command_type === 'RecordWorldFact') return { event_type: 'WorldFactRecorded', payload: { fact: clone(command.fact) }, target_ids: [] }
  if (command.command_type === 'RevealWorldFact') return { event_type: 'WorldFactRevealed', payload: { fact_id: command.fact_id }, target_ids: clone(command.target_ids) }
  if (command.command_type === 'UpsertQuest') return { event_type: 'QuestUpserted', payload: { quest: clone(command.quest) }, target_ids: [] }
  if (command.command_type === 'AdvanceQuestClock') return { event_type: 'QuestClockAdvanced', payload: { quest_id: command.quest_id, amount: command.amount }, target_ids: [] }
  return null
}

export function applyWorldMemoryEvent(input, event) {
  const memory = normalizeWorldMemory(input)
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
  if (event.event_type === 'WorldFactRevealed') {
    for (const actorId of event.target_ids ?? []) {
      const key = text(actorId, 120)
      memory.knowledge[key] = [...new Set([...(memory.knowledge[key] ?? []), text(payload.fact_id, 120)])]
    }
  }
  if (event.event_type === 'QuestUpserted') {
    const quest = safeQuest(payload.quest)
    memory.quests = [...memory.quests.filter((item) => item.id !== quest.id), quest]
  }
  if (event.event_type === 'QuestClockAdvanced') {
    memory.quests = memory.quests.map((quest) => {
      if (quest.id !== payload.quest_id) return quest
      const current = Math.min(quest.clock.max, quest.clock.current + Math.max(1, integer(payload.amount, 1)))
      return { ...quest, clock: { ...quest.clock, current, triggered: current >= quest.clock.max } }
    })
  }
  return memory
}

function normallyVisible(item, viewer) {
  if (viewer.isAdmin) return true
  if (item.visibility === 'public') return true
  return item.visibility === 'party' && viewer.isPartyMember !== false
}

export function worldMemoryForViewer(input, viewer = {}) {
  const memory = normalizeWorldMemory(input)
  if (viewer.isAdmin) return memory
  const playerId = text(viewer.playerId, 120)
  const known = new Set(memory.knowledge[playerId] ?? [])
  const facts = memory.facts.filter((fact) => fact.status === 'active' && (normallyVisible(fact, viewer) || known.has(fact.id)))
  const quests = memory.quests.filter((quest) => quest.status !== 'hidden' && normallyVisible(quest, viewer))
  const referenced = new Set([...facts.map((fact) => fact.subject_id), ...quests.flatMap((quest) => quest.entity_ids)])
  const entities = memory.entities.filter((entity) => normallyVisible(entity, viewer) || referenced.has(entity.id))
  return { schema_version: 1, entities: clone(entities), facts: clone(facts), quests: clone(quests), knowledge: playerId ? { [playerId]: [...known].filter((factId) => facts.some((fact) => fact.id === factId)) } : {} }
}

export function knownWorldLore(input, query = '') {
  const memory = normalizeWorldMemory(input)
  const tokens = text(query, 500).toLocaleLowerCase('ru').split(/[^a-zа-яё0-9]+/iu).filter((token) => token.length >= 3)
  const entities = new Map(memory.entities.map((entity) => [entity.id, entity]))
  const score = (fact) => {
    const entity = entities.get(fact.subject_id)
    const haystack = `${entity?.name ?? ''} ${(entity?.aliases ?? []).join(' ')} ${fact.predicate} ${fact.object} ${fact.summary}`.toLocaleLowerCase('ru')
    return tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0)
  }
  const active = memory.facts.filter((fact) => fact.status === 'active')
  const ranked = active.map((fact) => ({ fact, score: score(fact) })).sort((left, right) => right.score - left.score || left.fact.id.localeCompare(right.fact.id))
  const selected = tokens.length && ranked.some((item) => item.score > 0) ? ranked.filter((item) => item.score > 0) : ranked
  return selected.slice(0, 8).map(({ fact }) => ({ ...clone(fact), entity: clone(entities.get(fact.subject_id) ?? null) }))
}
