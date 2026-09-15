import { createHash } from 'node:crypto'

import { factionIdsForNpc } from './reputation-policy.mjs'
import { npcProfileAtWorldTime } from './npc-social.mjs'
import { npcVitalFor } from './npc-positioning.mjs'

/**
 * Небольшой событийный реестр должностей мира.
 *
 * Конфигурация приходит из authored/bootstrap и описывает только известную
 * должность и одного заранее названного преемника. Здесь нет политики закона,
 * политической симуляции или генерации NPC: смерть владельца освобождает
 * должность, а мировой час один раз проверяет уже существующие данные NPC.
 */

export const WORLD_OFFICES_SCHEMA_VERSION = 1
export const WORLD_OFFICES_POLICY_ID = 'skazanie:world-offices-v1'
export const OFFICE_EVENT_SCHEMA_VERSION = 1
export const WORLD_OFFICES_EVENT_SCHEMA_VERSION = OFFICE_EVENT_SCHEMA_VERSION

export const WORLD_OFFICE_EVENT_TYPES = Object.freeze([
  'OfficeVacated', 'OfficeHolderInstalled', 'OfficeSuccessionSkipped',
])

const EVENT_TYPES = new Set(WORLD_OFFICE_EVENT_TYPES)
const OFFICE_STATUSES = new Set(['held', 'vacant'])
const SUCCESSION_OUTCOMES = new Set(['installed', 'skipped'])
const SKIP_REASONS = new Set([
  'no_successor_configured',
  'candidate_missing',
  'candidate_dead',
  'candidate_unavailable',
  'candidate_wrong_faction',
  'candidate_missing_tag',
  'office_occupied',
])

const MAX_OFFICES = 100
const MAX_SUCCESSION_HISTORY = 32
const MAX_REQUIRED_TAGS = 12
const MAX_DEFENDERS = 24
const MAX_DELAY_MINUTES = 525_600
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u

const clone = (value) => structuredClone(value)
const text = (value, maximum = 180) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback
const nonNegativeInteger = (value, fallback = 0) => Math.max(0, integer(value, fallback))

function validId(value) {
  return ID_PATTERN.test(text(value, 120))
}

function optionalId(value) {
  const result = text(value, 120)
  return result && ID_PATTERN.test(result) ? result : ''
}

function idList(value, maximum, label, { strict = false } = {}) {
  if (value == null) return []
  if (!Array.isArray(value)) {
    if (strict) throw new WorldOfficeValidationError(`${label} должен быть массивом`, 'WORLD_OFFICE_INVALID_SHAPE')
    return []
  }
  if (strict && value.length > maximum) {
    throw new WorldOfficeValidationError(`${label} должен содержать не более ${maximum} записей`, 'WORLD_OFFICE_LIMIT_EXCEEDED')
  }
  const result = []
  const seen = new Set()
  for (const raw of value.slice(0, maximum)) {
    const candidate = text(raw, 120)
    if (!candidate || !ID_PATTERN.test(candidate) || seen.has(candidate)) {
      if (strict && candidate && !ID_PATTERN.test(candidate)) {
        throw new WorldOfficeValidationError(`${label} содержит некорректный id`, 'WORLD_OFFICE_INVALID_ID')
      }
      continue
    }
    seen.add(candidate)
    result.push(candidate)
  }
  return result
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorldOfficeValidationError(`${label} должен быть объектом`, 'WORLD_OFFICE_INVALID_SHAPE')
  }
  return value
}

function assertFields(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key))
  if (unexpected.length) {
    throw new WorldOfficeValidationError(`${label} содержит запрещённые поля: ${unexpected.join(', ')}`, 'WORLD_OFFICE_UNKNOWN_FIELD')
  }
}

function knownIdSet(value) {
  if (value == null) return null
  const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : []
  return new Set(values.map((entry) => text(entry, 120)).filter(Boolean))
}

function assertKnown(id, known, label) {
  if (id && known && !known.has(id)) {
    throw new WorldOfficeValidationError(`${label} не найден`, 'WORLD_OFFICE_REFERENCE_NOT_FOUND')
  }
}

export class WorldOfficeValidationError extends Error {
  constructor(message, code = 'WORLD_OFFICE_INVALID') {
    super(message)
    this.name = 'WorldOfficeValidationError'
    this.code = code
  }
}

/**
 * Проверяет authored/bootstrap-конфигурацию одной должности.
 *
 * @param {Record<string, any>} input
 * @param {{knownNpcIds?: string[], knownFactionIds?: string[]}} [context]
 * @returns {Record<string, any>}
 */
export function validateOfficeConfiguration(input, context = {}) {
  const value = assertObject(input, 'office')
  assertFields(value, new Set([
    'id', 'title', 'faction_id', 'holder_npc_id', 'visibility', 'successor', 'defender_npc_ids',
  ]), 'office')

  const officeId = text(value.id, 120)
  if (!ID_PATTERN.test(officeId)) throw new WorldOfficeValidationError('office.id должен быть безопасным идентификатором', 'WORLD_OFFICE_INVALID_ID')
  const title = text(value.title, 180)
  if (!title) throw new WorldOfficeValidationError('У должности должно быть название', 'WORLD_OFFICE_TITLE_REQUIRED')
  const factionId = text(value.faction_id, 120)
  if (!ID_PATTERN.test(factionId)) throw new WorldOfficeValidationError('office.faction_id должен быть безопасным идентификатором', 'WORLD_OFFICE_INVALID_ID')

  const holder = value.holder_npc_id == null ? '' : text(value.holder_npc_id, 120)
  if (holder && !ID_PATTERN.test(holder)) throw new WorldOfficeValidationError('office.holder_npc_id должен быть безопасным идентификатором', 'WORLD_OFFICE_INVALID_ID')
  const visibility = value.visibility == null ? 'party' : text(value.visibility, 20)
  if (!['party', 'gm_only'].includes(visibility)) throw new WorldOfficeValidationError('Видимость должности должна быть party или gm_only', 'WORLD_OFFICE_VISIBILITY_INVALID')

  const knownNpcIds = knownIdSet(context.knownNpcIds)
  const knownFactionIds = knownIdSet(context.knownFactionIds)
  assertKnown(holder, knownNpcIds, 'office.holder_npc_id')
  assertKnown(factionId, knownFactionIds, 'office.faction_id')

  let successor = null
  if (value.successor != null) {
    const rawSuccessor = assertObject(value.successor, 'office.successor')
    assertFields(rawSuccessor, new Set(['npc_id', 'delay_minutes', 'required_tags']), 'office.successor')
    const successorId = text(rawSuccessor.npc_id, 120)
    if (!ID_PATTERN.test(successorId)) throw new WorldOfficeValidationError('office.successor.npc_id должен быть безопасным идентификатором', 'WORLD_OFFICE_INVALID_ID')
    if (successorId === holder && context.allowCurrentSuccessor !== true) {
      throw new WorldOfficeValidationError('Преемник должности не может совпадать с её держателем', 'WORLD_OFFICE_SUCCESSOR_INVALID')
    }
    const delayMinutes = integer(rawSuccessor.delay_minutes, Number.NaN)
    if (!Number.isSafeInteger(delayMinutes) || delayMinutes < 1 || delayMinutes > MAX_DELAY_MINUTES) {
      throw new WorldOfficeValidationError(`office.successor.delay_minutes должен быть от 1 до ${MAX_DELAY_MINUTES}`, 'WORLD_OFFICE_DELAY_INVALID')
    }
    const requiredTags = idList(rawSuccessor.required_tags, MAX_REQUIRED_TAGS, 'office.successor.required_tags', { strict: true })
    if (knownNpcIds && !knownNpcIds.has(successorId)) {
      throw new WorldOfficeValidationError('office.successor.npc_id не найден', 'WORLD_OFFICE_REFERENCE_NOT_FOUND')
    }
    successor = { npc_id: successorId, delay_minutes: delayMinutes, required_tags: requiredTags }
  }

  return {
    id: officeId,
    title,
    faction_id: factionId,
    holder_npc_id: holder || null,
    visibility,
    ...(successor ? { successor } : {}),
    defender_npc_ids: idList(value.defender_npc_ids, MAX_DEFENDERS, 'office.defender_npc_ids', { strict: true }),
  }
}

function configurationSource(input, options = {}) {
  if (Array.isArray(options.offices)) return options.offices
  if (Array.isArray(options.configuration)) return options.configuration
  return Array.isArray(input?.offices) ? input.offices : []
}

function safePending(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const successionId = optionalId(value.succession_id)
  const candidateId = optionalId(value.candidate_npc_id)
  if (!successionId || !Number.isSafeInteger(Number(value.due_at_minutes))) return null
  return {
    succession_id: successionId,
    candidate_npc_id: candidateId || null,
    due_at_minutes: nonNegativeInteger(value.due_at_minutes),
    vacated_at_minutes: nonNegativeInteger(value.vacated_at_minutes, value.due_at_minutes),
    source_event_id: optionalId(value.source_event_id),
  }
}

function safeHistory(value) {
  const history = []
  const seen = new Set()
  for (const raw of Array.isArray(value) ? value : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const successionId = optionalId(raw.succession_id)
    if (!successionId || seen.has(successionId) || !SUCCESSION_OUTCOMES.has(text(raw.outcome, 20))) continue
    seen.add(successionId)
    history.push({
      succession_id: successionId,
      outcome: text(raw.outcome, 20),
      reason: text(raw.reason, 60),
      candidate_npc_id: optionalId(raw.candidate_npc_id) || null,
      at_minutes: nonNegativeInteger(raw.at_minutes),
      source_event_id: optionalId(raw.source_event_id),
    })
  }
  return history.slice(-MAX_SUCCESSION_HISTORY)
}

function safeOfficeState(raw, context = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const configSource = { ...raw }
  delete configSource.status
  delete configSource.pending
  delete configSource.succession_history
  delete configSource.history
  delete configSource.vacated_at_minutes
  delete configSource.last_succession
  let config
  try {
    config = validateOfficeConfiguration(configSource, { ...context, allowCurrentSuccessor: true })
  } catch {
    return null
  }

  const status = OFFICE_STATUSES.has(text(raw.status, 20))
    ? text(raw.status, 20)
    : config.holder_npc_id ? 'held' : 'vacant'
  const holder = status === 'vacant'
    ? null
    : (optionalId(raw.holder_npc_id) || config.holder_npc_id || null)
  // A pending operation may outlive an external holder update. Keeping it on a
  // held office lets the succession planner consume that stale operation with
  // `office_occupied` instead of retrying it forever.
  const pending = safePending(raw.pending)
  return {
    ...config,
    status: holder ? 'held' : 'vacant',
    holder_npc_id: holder,
    pending,
    succession_history: safeHistory(raw.succession_history ?? raw.history),
  }
}

/**
 * Нормализует optional world-office state. Отсутствующий реестр — пустой мир;
 * старые кампании от этого не получают должностей задним числом.
 *
 * @param {Record<string, any>} [input]
 * @param {{offices?: Record<string, any>[], configuration?: Record<string, any>[], knownNpcIds?: string[], knownFactionIds?: string[]}} [options]
 * @returns {Record<string, any>}
 */
export function normalizeWorldOfficesState(input = {}, options = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const knownNpcIds = options.knownNpcIds
  const knownFactionIds = options.knownFactionIds
  const offices = []
  const seen = new Set()
  for (const raw of configurationSource(source, options)) {
    const office = safeOfficeState(raw, { knownNpcIds, knownFactionIds })
    if (!office || seen.has(office.id)) continue
    seen.add(office.id)
    offices.push(office)
    if (offices.length >= MAX_OFFICES) break
  }
  return { schema_version: WORLD_OFFICES_SCHEMA_VERSION, offices }
}

// Короткое имя для bootstrap-пути. Оба имени описывают одну нормализацию;
// отдельной реализации или второго источника конфигурации здесь нет.
export const normalizeWorldOffices = normalizeWorldOfficesState

function officeStateFrom(value, options = {}) {
  if (value?.world_offices && typeof value.world_offices === 'object') {
    return normalizeWorldOfficesState(value.world_offices, options)
  }
  return normalizeWorldOfficesState(value, options)
}

function worldMinutes(state, options = {}) {
  const explicit = options.worldMinute ?? options.world_minute ?? options.atMinutes ?? options.at_minutes
  if (explicit != null && Number.isSafeInteger(Number(explicit))) return Math.max(0, Number(explicit))
  const current = nonNegativeInteger(state?.mechanics?.world_time?.elapsed_minutes, 0)
  if (options.elapsedMinutes != null || options.elapsed_minutes != null) {
    return current + nonNegativeInteger(options.elapsedMinutes ?? options.elapsed_minutes, 0)
  }
  return current
}

function eventIdentity(event) {
  return optionalId(event?.event_id) || optionalId(event?.command_id) || ''
}

function successionId(officeId, causeEventId, atMinutes) {
  const digest = createHash('sha256')
    .update(`${officeId}\0${causeEventId}\0${atMinutes}`)
    .digest('hex')
    .slice(0, 24)
  return `succession:${digest}`
}

function eventDraft(office, eventType, payload) {
  return {
    event_type: eventType,
    payload: {
      schema_version: OFFICE_EVENT_SCHEMA_VERSION,
      policy_id: WORLD_OFFICES_POLICY_ID,
      office_id: office.id,
      title: office.title,
      ...payload,
    },
    target_ids: [],
    // A skipped attempt is an internal eligibility decision. Revealing the
    // candidate or the reason through the event stream would expose policy
    // that the public office projection deliberately omits.
    visibility: eventType === 'OfficeSuccessionSkipped' ? 'gm_only' : office.visibility,
  }
}

function deathIds(events) {
  const result = []
  const seen = new Set()
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.event_type !== 'NpcDied') continue
    const npcId = optionalId(event.payload?.npc_id)
    if (!npcId || seen.has(npcId)) continue
    seen.add(npcId)
    result.push({ npcId, event })
  }
  return result
}

/**
 * Строит освобождения должностей по подтверждённым `NpcDied` событиям.
 * Список событий — уже собранная часть текущего commit, а не намерение клиента.
 */
export function planOfficeVacancyDrafts(state = {}, events = [], options = {}) {
  const offices = officeStateFrom(state, options)
  const atMinutes = worldMinutes(state, options)
  const drafts = []
  const occupied = new Set()
  for (const { npcId, event } of deathIds(events)) {
    for (const office of offices.offices) {
      if (office.holder_npc_id !== npcId || office.status !== 'held' || occupied.has(office.id)) continue
      occupied.add(office.id)
      const causeEventId = eventIdentity(event)
      const id = successionId(office.id, causeEventId, atMinutes)
      const delay = office.successor?.delay_minutes ?? 0
      drafts.push(eventDraft(office, 'OfficeVacated', {
        status: 'vacant',
        holder_npc_id: null,
        previous_holder_npc_id: npcId,
        succession_id: id,
        vacated_at_minutes: atMinutes,
        due_at_minutes: atMinutes + delay,
        source_event_id: causeEventId,
      }))
    }
  }
  return drafts
}

function candidateProfile(state, candidateId, atMinutes) {
  const profile = (state?.social?.npcs ?? []).find((npc) => String(npc?.id ?? '') === candidateId)
  if (!profile) return { profile: null, reason: 'candidate_missing' }
  if (!npcVitalFor(state, candidateId)?.alive) return { profile, reason: 'candidate_dead' }
  // Перепроверяем производные факты на той же авторитетной минуте, но
  // сохраняем весь снимок мира. В частности, расписание не должно сделать
  // доступным кандидата, который в этот момент участвует в бою.
  const stateAtTime = {
    ...state,
    mechanics: {
      ...(state?.mechanics && typeof state.mechanics === 'object' ? state.mechanics : {}),
      world_time: {
        ...(state?.mechanics?.world_time && typeof state.mechanics.world_time === 'object'
          ? state.mechanics.world_time
          : {}),
        elapsed_minutes: atMinutes,
      },
    },
  }
  const atTime = npcProfileAtWorldTime(profile, stateAtTime)
  if (atTime.available === false) return { profile: atTime, reason: 'candidate_unavailable' }
  return { profile: atTime, reason: '' }
}

function candidateEligibility(state, office, atMinutes) {
  const candidateId = office.successor?.npc_id
  if (!candidateId) return { eligible: false, reason: 'no_successor_configured' }
  const { profile, reason } = candidateProfile(state, candidateId, atMinutes)
  if (reason) return { eligible: false, reason }
  const factions = factionIdsForNpc(profile)
  if (!factions.includes(office.faction_id)) return { eligible: false, reason: 'candidate_wrong_faction' }
  const requiredTags = office.successor?.required_tags ?? []
  if (requiredTags.some((tag) => !(profile.tags ?? []).includes(tag))) {
    return { eligible: false, reason: 'candidate_missing_tag' }
  }
  return { eligible: true, reason: '' }
}

/**
 * Выпускает ровно одну попытку преемства после наступления due minute.
 * При успехе или пропуске pending очищается reducer-ом, поэтому следующий
 * запрос часов не повторяет назначение и не назначает старого кандидата.
 */
export function planOfficeSuccessionDrafts(state = {}, options = {}) {
  const offices = officeStateFrom(state, options)
  const atMinutes = worldMinutes(state, options)
  const drafts = []
  for (const office of offices.offices) {
    const pending = office.pending
    if (!pending || pending.due_at_minutes > atMinutes) continue
    if (office.status !== 'vacant' || office.holder_npc_id) {
      drafts.push(eventDraft(office, 'OfficeSuccessionSkipped', {
        status: office.status,
        holder_npc_id: office.holder_npc_id,
        succession_id: pending.succession_id,
        skipped_at_minutes: atMinutes,
        reason: 'office_occupied',
        source_event_id: pending.source_event_id,
      }))
      continue
    }
    const eligibility = candidateEligibility(state, office, atMinutes)
    if (!eligibility.eligible) {
      drafts.push(eventDraft(office, 'OfficeSuccessionSkipped', {
        status: 'vacant',
        holder_npc_id: null,
        succession_id: pending.succession_id,
        skipped_at_minutes: atMinutes,
        reason: SKIP_REASONS.has(eligibility.reason) ? eligibility.reason : 'candidate_missing',
        source_event_id: pending.source_event_id,
      }))
      continue
    }
    drafts.push(eventDraft(office, 'OfficeHolderInstalled', {
      status: 'held',
      holder_npc_id: office.successor.npc_id,
      previous_holder_npc_id: null,
      succession_id: pending.succession_id,
      installed_at_minutes: atMinutes,
      source_event_id: pending.source_event_id,
    }))
  }
  return drafts
}

function historyHas(office, successionIdValue) {
  return office.succession_history.some((entry) => entry.succession_id === successionIdValue)
}

function withHistory(office, entry) {
  if (!entry.succession_id || historyHas(office, entry.succession_id)) return office.succession_history
  return [...office.succession_history, entry].slice(-MAX_SUCCESSION_HISTORY)
}

function eventSchemaIsSupported(event) {
  return EVENT_TYPES.has(String(event?.event_type ?? ''))
    && Number(event?.payload?.schema_version) === OFFICE_EVENT_SCHEMA_VERSION
}

/**
 * Применяет только валидные события должностей и всегда возвращает новый
 * объект. Историческое событие не перепроверяет живость кандидата: это уже
 * сделал planner до commit, а replay обязан сохранить подтверждённый исход.
 */
export function applyWorldOfficeEvent(input = {}, event = {}, options = {}) {
  if (!eventSchemaIsSupported(event)) return officeStateFrom(input, options)
  const current = officeStateFrom(input, options)
  const payload = event.payload ?? {}
  const officeId = optionalId(payload.office_id)
  if (!officeId) return current
  const officeIndex = current.offices.findIndex((office) => office.id === officeId)
  if (officeIndex < 0) return current
  const office = current.offices[officeIndex]
  const succession = optionalId(payload.succession_id)
  if (!succession) return current
  let next = office

  if (event.event_type === 'OfficeVacated') {
    const previousHolder = optionalId(payload.previous_holder_npc_id)
    if (office.status !== 'held' || !office.holder_npc_id || office.holder_npc_id !== previousHolder) return current
    if (office.pending?.succession_id === succession || historyHas(office, succession)) return current
    const due = nonNegativeInteger(payload.due_at_minutes, nonNegativeInteger(payload.vacated_at_minutes))
    next = {
      ...office,
      status: 'vacant',
      holder_npc_id: null,
      pending: {
        succession_id: succession,
        candidate_npc_id: office.successor?.npc_id ?? null,
        due_at_minutes: due,
        vacated_at_minutes: nonNegativeInteger(payload.vacated_at_minutes, due),
        source_event_id: optionalId(payload.source_event_id),
      },
    }
  }

  if (event.event_type === 'OfficeHolderInstalled') {
    const holder = optionalId(payload.holder_npc_id)
    if (!holder || office.successor?.npc_id !== holder || office.pending?.succession_id !== succession) return current
    if (office.status !== 'vacant' || office.holder_npc_id) return current
    next = {
      ...office,
      status: 'held',
      holder_npc_id: holder,
      pending: null,
      succession_history: withHistory(office, {
        succession_id: succession,
        outcome: 'installed',
        reason: 'successor_installed',
        candidate_npc_id: holder,
        at_minutes: nonNegativeInteger(payload.installed_at_minutes),
        source_event_id: optionalId(payload.source_event_id),
      }),
    }
  }

  if (event.event_type === 'OfficeSuccessionSkipped') {
    if (office.pending?.succession_id !== succession) return current
    const reason = SKIP_REASONS.has(text(payload.reason, 60)) ? text(payload.reason, 60) : 'candidate_missing'
    next = {
      ...office,
      // A stale skip may arrive after another holder was installed. Preserve
      // that holder while consuming only the old pending operation.
      status: office.status === 'held' && office.holder_npc_id ? 'held' : 'vacant',
      holder_npc_id: office.status === 'held' && office.holder_npc_id ? office.holder_npc_id : null,
      pending: null,
      succession_history: withHistory(office, {
        succession_id: succession,
        outcome: 'skipped',
        reason,
        candidate_npc_id: office.successor?.npc_id ?? null,
        at_minutes: nonNegativeInteger(payload.skipped_at_minutes),
        source_event_id: optionalId(payload.source_event_id),
      }),
    }
  }

  if (next === office) return current
  const result = current.offices.slice()
  result[officeIndex] = next
  return { schema_version: WORLD_OFFICES_SCHEMA_VERSION, offices: result }
}

/**
 * Игровая проекция должностей. Она намеренно не содержит successor,
 * defender_npc_ids, pending, history или причин пропуска.
 */
export function officesForViewer(input = {}, options = {}) {
  const state = officeStateFrom(input, options)
  const isAdmin = options.isAdmin === true || options.role === 'admin'
  const isPartyMember = options.isPartyMember !== false
  return state.offices
    .filter((office) => isAdmin || office.visibility === 'party' && isPartyMember)
    .map((office) => ({
      office_id: office.id,
      title: office.title,
      status: office.status,
      holder_npc_id: office.holder_npc_id,
    }))
}

/**
 * Короткая party-visible строка для журнала. Имена кандидатов, причины и
 * задержки намеренно не попадают в сообщение.
 */
export function officeChronicleEntry(event = {}, options = {}) {
  if (!EVENT_TYPES.has(String(event.event_type ?? ''))) return null
  if (event.visibility === 'gm_only' && options.isAdmin !== true) return null
  const payload = event.payload ?? {}
  const officeId = optionalId(payload.office_id)
  const title = text(payload.title, 180)
  const key = officeId && (title || officeId)
  if (!key) return null
  const status = event.event_type === 'OfficeHolderInstalled' ? 'held' : event.event_type === 'OfficeVacated' ? 'vacant' : text(payload.status, 20) || 'vacant'
  const textByStatus = status === 'held'
    ? `Должность «${title || officeId}» получила нового держателя.`
    : `Должность «${title || officeId}» остаётся вакантной.`
  return {
    id: `office:${event.event_type}:${event.event_id || event.command_id || officeId}`,
    speaker: 'narrator',
    author: 'Летопись мира',
    text: textByStatus,
    turnConsumed: false,
  }
}
