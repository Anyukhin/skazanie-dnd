const PROFILE_VISIBILITIES = new Set(['public', 'party', 'gm_only'])
const DOSSIER_VISIBILITIES = new Set(['public', 'party', 'specific_player', 'gm_only'])
const PROMISE_DIRECTIONS = new Set(['npc_to_party', 'party_to_npc'])
const PROMISE_STATUSES = new Set(['open', 'fulfilled', 'broken', 'cancelled'])
const STANCES = new Set(['friendly', 'neutral', 'guarded', 'hostile'])
/**
 * Навыки социальной проверки. Список дублирует `NPC_SOCIAL_CHECK_SKILLS` из
 * `npc-social-check.mjs` намеренно: обратный импорт замкнул бы модули в цикл,
 * а расхождение ловит тест «ручная СЛ принимает ровно те же навыки».
 */
const SOCIAL_CHECK_SKILLS = new Set(['persuasion', 'deception', 'intimidation', 'insight'])
const SOCIAL_CHECK_DEGREES = new Set(['strong_success', 'success', 'failure', 'severe_failure'])
const WEEK_DAYS = new Set([0, 1, 2, 3, 4, 5, 6])

export const NPC_DOSSIER_PROFILE_LIMIT = 12
export const NPC_NARRATOR_DOSSIER_LIMITS = Object.freeze({
  npcs: 1,
  interactions: 3,
  promises: 2,
})

export const NPC_SOCIAL_COMMAND_TYPES = new Set([
  'UpsertNpcSocialProfile', 'RecordNpcSocialTurn', 'ResolveNpcPromise',
])

export class NpcSocialValidationError extends Error {
  constructor(message, code = 'NPC_SOCIAL_INVALID') {
    super(message)
    this.name = 'NpcSocialValidationError'
    this.code = code
  }
}

const clone = (value) => structuredClone(value)
const clean = (value, maximum = 500) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const strings = (value, maximum = 160, limit = 30) => [...new Set((Array.isArray(value) ? value : [])
  .map((item) => clean(item, maximum)).filter(Boolean))].slice(0, limit)
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback
const validIdentifier = (value) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(clean(value, 120))

function safeScheduleEntry(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = clean(value.id, 120)
  const location = clean(value.location, 180)
  const start = Number(value.start_minute)
  const end = Number(value.end_minute)
  if (!validIdentifier(id) || !location || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || start >= 1_440 || end <= start || end > 1_440) return null
  const days = [...new Set((Array.isArray(value.days) ? value.days : [])
    .filter((day) => Number.isSafeInteger(Number(day)) && WEEK_DAYS.has(Number(day)))
    .map(Number))].sort((left, right) => left - right)
  return {
    id,
    days,
    start_minute: start,
    end_minute: end,
    location,
    available: value.available !== false,
    summary: clean(value.summary, 300),
    visibility: PROFILE_VISIBILITIES.has(value.visibility) ? value.visibility : 'party',
  }
}

function scheduleDaysOverlap(left, right) {
  if (!left.days.length || !right.days.length) return true
  return left.days.some((day) => right.days.includes(day))
}

function safeSchedule(value) {
  const candidates = (Array.isArray(value) ? value : []).map(safeScheduleEntry).filter(Boolean)
    .sort((left, right) => left.start_minute - right.start_minute || left.end_minute - right.end_minute || left.id.localeCompare(right.id))
  const accepted = []
  const ids = new Set()
  for (const entry of candidates) {
    if (ids.has(entry.id)) continue
    const overlaps = accepted.some((other) => scheduleDaysOverlap(entry, other)
      && entry.start_minute < other.end_minute && other.start_minute < entry.end_minute)
    if (overlaps) continue
    ids.add(entry.id)
    accepted.push(entry)
    if (accepted.length >= 64) break
  }
  return accepted
}

function safeInventoryEntry(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = clean(value.id, 120)
  const name = clean(value.name, 160)
  const quantity = Number(value.quantity)
  if (!validIdentifier(id) || !name || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 9_999) return null
  return {
    id,
    name,
    quantity,
    description: clean(value.description, 500),
    visibility: PROFILE_VISIBILITIES.has(value.visibility) ? value.visibility : 'party',
  }
}

function safeInventory(value) {
  const inventory = []
  const ids = new Set()
  for (const item of Array.isArray(value) ? value : []) {
    const safe = safeInventoryEntry(item)
    if (!safe || ids.has(safe.id)) continue
    ids.add(safe.id)
    inventory.push(safe)
    if (inventory.length >= 100) break
  }
  return inventory
}

export function relationshipTier(value) {
  const score = Math.max(-100, Math.min(100, integer(value, 0)))
  if (score <= -50) return 'hostile'
  if (score <= -20) return 'unfriendly'
  if (score >= 50) return 'trusted'
  if (score >= 20) return 'friendly'
  return 'neutral'
}

export function campaignElapsedMinutes(state = {}) {
  const worldTime = state.mechanics?.world_time ?? {}
  if (worldTime.elapsed_minutes != null && Number.isSafeInteger(Number(worldTime.elapsed_minutes))) return Math.max(0, Number(worldTime.elapsed_minutes))
  const amount = Math.max(0, Number(worldTime.amount) || 0)
  const unit = clean(worldTime.unit, 20).toLocaleLowerCase('ru')
  if (['hour', 'hours', '\u0447\u0430\u0441', '\u0447\u0430\u0441\u0430', '\u0447\u0430\u0441\u043e\u0432'].includes(unit)) return Math.floor(amount * 60)
  if (['day', 'days', '\u0434\u0435\u043d\u044c', '\u0434\u043d\u044f', '\u0434\u043d\u0435\u0439'].includes(unit)) return Math.floor(amount * 1_440)
  return Math.floor(amount)
}

export function promiseDueOffsetMinutes(value) {
  const hint = clean(value, 240).toLocaleLowerCase('ru')
  if (!hint) return null
  if (/\b(?:tomorrow|next day)\b|\u0437\u0430\u0432\u0442\u0440\u0430/iu.test(hint)) return 1_440
  if (/\btonight\b|\u0441\u0435\u0433\u043e\u0434\u043d\u044f(?:\s+\u0432\u0435\u0447\u0435\u0440\u043e\u043c)?/iu.test(hint)) return 720
  if (/\bsoon\b|\u0441\u043a\u043e\u0440\u043e/iu.test(hint)) return 240
  const match = hint.match(/(?:\u0447\u0435\u0440\u0435\u0437|in)?\s*(\d{1,3})\s*(\u043c\u0438\u043d\u0443\u0442(?:\u0443|\u044b)?|\u043c\u0438\u043d|\u0447\u0430\u0441(?:\u0430|\u043e\u0432)?|\u0434\u043d(?:\u044f|\u0435\u0439)|minute(?:s)?|min|hour(?:s)?|hr|day(?:s)?)/iu)
  if (!match) return null
  const amount = Math.max(1, Math.min(90, integer(match[1], 1)))
  const unit = match[2].toLocaleLowerCase('ru')
  const multiplier = /^(?:\u0447\u0430\u0441|hour|hr)/iu.test(unit) ? 60 : /^(?:\u0434\u043d|day)/iu.test(unit) ? 1_440 : 1
  return Math.min(129_600, amount * multiplier)
}

function identifier(value, field = 'id') {
  const result = clean(value, 120)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(result)) {
    throw new NpcSocialValidationError(`Некорректное поле ${field}`, 'NPC_SOCIAL_INVALID_ID')
  }
  return result
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NpcSocialValidationError(`${label} должен быть объектом`, 'NPC_SOCIAL_INVALID_SHAPE')
  }
  return value
}

function fields(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key))
  if (unexpected.length) throw new NpcSocialValidationError(`${label} содержит запрещённые поля: ${unexpected.join(', ')}`, 'NPC_SOCIAL_UNKNOWN_FIELD')
}

/**
 * Ручные СЛ социальных проверок этого NPC.
 *
 * `difficultyFor` в `server/npc-social-check.mjs` умел уважать это поле с
 * самого появления социальных проверок, но нормализатор профиля его не
 * переносил — allowlist полей его не знал, — и ветка была мёртвой: все СЛ
 * считались политикой, а авторская настройка молча пропадала.
 *
 * Диапазон тот же, что у политики (5–25): ручная СЛ уточняет сложность, а не
 * отменяет её границы. Поле приватное, как цели и убеждения: игроку СЛ до
 * броска не показывают, иначе исчезает сама проверка.
 */
function safeSocialDcs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = Object.entries(value)
    .filter(([skill]) => SOCIAL_CHECK_SKILLS.has(String(skill)))
    .map(([skill, dc]) => [String(skill), Number(dc)])
    .filter(([, dc]) => Number.isSafeInteger(dc))
    .map(([skill, dc]) => [skill, Math.max(5, Math.min(25, dc))])
  return Object.fromEntries(entries)
}

/**
 * Короткий server-owned речевой профиль NPC.
 *
 * Старые кампании хранят одно поле `voice`. Оно остаётся совместимым
 * источником, но нормализатор раскладывает его в три исполнимых признака:
 * темп, словарь и речевую привычку. Новые профили могут передать эти признаки
 * явно; они живут рядом с NPC, а не в общем списке характеров промпта.
 */
export function npcSpeechProfile(value = {}) {
  const explicit = value?.speech_profile && typeof value.speech_profile === 'object' && !Array.isArray(value.speech_profile)
    ? value.speech_profile
    : {}
  const voice = clean(value?.voice, 500)
  const role = clean(value?.role, 160)
  const style = `${voice} ${role}`.toLocaleLowerCase('ru')
  const pace = clean(explicit.pace, 100)
    || (/быстр|тороп|скороговор/iu.test(style)
      ? 'быстро, короткими фразами'
      : /медлен|нетороп|пауз/iu.test(style)
        ? 'медленно, с заметными паузами'
        : /коротк|лаконич|немногослов/iu.test(style)
          ? 'ровно, короткими фразами'
          : 'ровно, фразами средней длины')
  const lexicon = clean(explicit.lexicon, 180)
    || (/прибаут|послов|простореч|жаргон/iu.test(style)
      ? 'простые слова, поговорки и профессиональные присказки'
      : /архив|уч[её]н|книж|летопис|писар/iu.test(style)
        ? 'точные книжные слова и названия записей'
        : /торгов|купц|лавк|трактир|постоял/iu.test(style)
          ? 'бытовые и деловые слова своей работы'
          : role
            ? `предметные слова из роли «${role}»`
            : 'простые предметные слова')
  const mannerism = clean(explicit.mannerism, 180)
    || (/прибаут|послов/iu.test(style)
      ? 'вставляет одну короткую прибаутку, не повторяя её дословно'
      : /пауз|медлен|нетороп/iu.test(style)
        ? 'перед важным выводом делает короткую паузу'
        : /коротк|лаконич|немногослов/iu.test(style)
          ? 'заканчивает ответ без лишнего пояснения'
          : voice
            ? `сохраняет указанную манеру: ${voice}`
            : 'перед выводом задаёт один уточняющий вопрос')
  return { pace, lexicon, mannerism }
}

function safeNpcDossierEntry(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = clean(value.id, 120)
  const sourceConversationId = clean(value.provenance?.source_conversation_id, 120)
  const summary = clean(value.summary, 600)
  if (!id || !sourceConversationId || !summary) return null
  const disclosedClaimIds = strings(
    (Array.isArray(value.disclosed_claims) ? value.disclosed_claims : [])
      .map((claim) => claim?.id),
    120,
    12,
  )
  return {
    id,
    kind: 'recorded_exchange',
    hero_id: clean(value.hero_id, 120),
    summary,
    stance: STANCES.has(value.stance) ? value.stance : 'neutral',
    visibility: DOSSIER_VISIBILITIES.has(value.visibility) ? value.visibility : 'party',
    epistemic_status: disclosedClaimIds.length
      ? 'contains_unverified_claims'
      : 'recorded_dialogue_not_world_fact',
    disclosed_fact_ids: strings(value.disclosed_fact_ids, 120, 12),
    disclosed_claims: disclosedClaimIds.map((claimId) => ({
      id: claimId,
      truth_status: 'unknown',
    })),
    provenance: {
      source_kind: 'NpcConversationRecorded',
      source_conversation_id: sourceConversationId,
      source_event_ids: strings(value.provenance?.source_event_ids, 120, 8),
    },
  }
}

function safeNpcDossier(value) {
  const entries = new Map()
  for (const candidate of Array.isArray(value) ? value : []) {
    const entry = safeNpcDossierEntry(candidate)
    if (!entry) continue
    entries.delete(entry.id)
    entries.set(entry.id, entry)
  }
  return [...entries.values()].slice(-NPC_DOSSIER_PROFILE_LIMIT)
}

function safeProfile(value = {}) {
  return {
    id: clean(value.id, 120),
    name: clean(value.name, 160),
    role: clean(value.role, 160),
    location: clean(value.location, 180),
    public_summary: clean(value.public_summary, 1_000),
    voice: clean(value.voice, 500),
    speech_profile: npcSpeechProfile(value),
    goals: strings(value.goals, 300, 12),
    beliefs: strings(value.beliefs, 300, 20),
    known_fact_ids: strings(value.known_fact_ids, 120, 100),
    social_dcs: safeSocialDcs(value.social_dcs),
    visibility: PROFILE_VISIBILITIES.has(value.visibility) ? value.visibility : 'party',
    available: value.available !== false,
    tags: strings(value.tags, 60, 20),
    schedule: safeSchedule(value.schedule),
    inventory: safeInventory(value.inventory),
    dossier: safeNpcDossier(value.dossier),
  }
}

function safePromise(value = {}) {
  const deadline = value.deadline_minutes != null && Number.isSafeInteger(Number(value.deadline_minutes)) ? Math.max(0, Number(value.deadline_minutes)) : null
  const resolved = value.resolved_at_minutes != null && Number.isSafeInteger(Number(value.resolved_at_minutes)) ? Math.max(0, Number(value.resolved_at_minutes)) : null
  return {
    id: clean(value.id, 120),
    npc_id: clean(value.npc_id, 120),
    hero_id: clean(value.hero_id, 120),
    direction: PROMISE_DIRECTIONS.has(value.direction) ? value.direction : 'npc_to_party',
    text: clean(value.text, 500),
    due_hint: clean(value.due_hint, 240),
    status: PROMISE_STATUSES.has(value.status) ? value.status : 'open',
    visibility: value.visibility === 'specific_player' ? 'specific_player' : 'party',
    source_conversation_id: clean(value.source_conversation_id, 120),
    created_at_minutes: Math.max(0, integer(value.created_at_minutes, 0)),
    deadline_minutes: deadline,
    resolved_at_minutes: resolved,
    resolution_reason: ['manual', 'deadline'].includes(value.resolution_reason) ? value.resolution_reason : null,
    consequence_delta: Math.max(-25, Math.min(25, integer(value.consequence_delta, 0))),
  }
}

function safeSocialCheck(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const skill = clean(value.skill, 30)
  if (!SOCIAL_CHECK_SKILLS.has(skill)) return null
  return {
    check_id: clean(value.check_id, 120),
    npc_id: clean(value.npc_id, 120),
    skill,
    ability: clean(value.ability, 10),
    roll_id: clean(value.roll_id, 120),
    total: Math.max(-50, Math.min(100, integer(value.total, 0))),
    modifier: Math.max(-30, Math.min(30, integer(value.modifier, 0))),
    success: value.success === true,
    degree: SOCIAL_CHECK_DEGREES.has(value.degree) ? value.degree : value.success === true ? 'success' : 'failure',
  }
}

function safeConversation(value = {}) {
  return {
    id: clean(value.id, 120),
    npc_id: clean(value.npc_id, 120),
    hero_id: clean(value.hero_id, 120),
    player_message: clean(value.player_message, 1_000),
    npc_reply: clean(value.npc_reply, 1_000),
    stance: STANCES.has(value.stance) ? value.stance : 'neutral',
    disclosed_fact_ids: strings(value.disclosed_fact_ids, 120, 20),
    disclosed_claim_ids: strings(value.disclosed_claim_ids, 120, 20),
    visibility: value.visibility === 'specific_player' ? 'specific_player' : 'party',
    ...(safeSocialCheck(value.check) ? { check: safeSocialCheck(value.check) } : {}),
  }
}

function dossierEntryFromConversation(conversation, event = {}) {
  const heroLine = clean(conversation.player_message, 240)
  const npcLine = clean(conversation.npc_reply, 320)
  return safeNpcDossierEntry({
    id: `interaction:${conversation.id}`,
    hero_id: conversation.hero_id,
    summary: [
      heroLine ? `Герой сказал: «${heroLine}».` : '',
      npcLine ? `Ответ NPC: «${npcLine}».` : '',
    ].filter(Boolean).join(' '),
    stance: conversation.stance,
    visibility: conversation.visibility,
    disclosed_fact_ids: conversation.disclosed_fact_ids,
    disclosed_claims: conversation.disclosed_claim_ids.map((id) => ({ id })),
    provenance: {
      source_conversation_id: conversation.id,
      source_event_ids: [event.event_id],
    },
  })
}

export function normalizeNpcSocialState(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const npcs = (Array.isArray(source.npcs) ? source.npcs : []).map(safeProfile).filter((npc) => npc.id && npc.name).slice(0, 500)
  const npcIds = new Set(npcs.map((npc) => npc.id))
  const relationships = Object.fromEntries(Object.entries(source.relationships ?? {}).slice(0, 500)
    .filter(([npcId, value]) => npcIds.has(clean(npcId, 120)) && value && typeof value === 'object' && !Array.isArray(value))
    .map(([npcId, value]) => [clean(npcId, 120), Object.fromEntries(Object.entries(value).slice(0, 100)
      .map(([heroId, score]) => [clean(heroId, 120), Math.max(-100, Math.min(100, integer(score, 0)))])
      .filter(([heroId]) => heroId))]))
  const conversations = (Array.isArray(source.conversations) ? source.conversations : []).map(safeConversation)
    .filter((item) => item.id && npcIds.has(item.npc_id) && item.hero_id && item.npc_reply).slice(-500)
  const conversationIds = new Set(conversations.map((item) => item.id))
  const promises = (Array.isArray(source.promises) ? source.promises : []).map(safePromise)
    .filter((item) => item.id && npcIds.has(item.npc_id) && item.text && (!item.source_conversation_id || conversationIds.has(item.source_conversation_id))).slice(-500)
  const relationship_tiers = Object.fromEntries(Object.entries(relationships).map(([npcId, heroes]) => [npcId,
    Object.fromEntries(Object.entries(heroes).map(([heroId, score]) => [heroId, relationshipTier(score)]))]))
  return { schema_version: 4, npcs, relationships, relationship_tiers, conversations, promises }
}

function profileFromMerchant(merchant = {}) {
  return safeProfile({
    id: merchant.id,
    name: merchant.name,
    role: merchant.title || 'merchant',
    location: merchant.location,
    public_summary: merchant.description,
    voice: merchant.voice || merchant.greeting,
    goals: [], beliefs: [], known_fact_ids: [], visibility: 'party',
    available: merchant.available !== false,
    tags: ['merchant'], schedule: [], inventory: [],
  })
}

/** Adds safe profiles for persistent merchants and canonical NPC entities. */
export function ensureNpcSocialState(input, state = {}) {
  const social = normalizeNpcSocialState(input)
  const profiles = new Map(social.npcs.map((npc) => [npc.id, npc]))
  for (const merchant of state.merchants ?? []) {
    const profile = profileFromMerchant(merchant)
    if (!profile.id || !profile.name) continue
    profiles.set(profile.id, { ...profile, ...(profiles.get(profile.id) ?? {}), location: clean(merchant.location, 180), available: merchant.available !== false })
  }
  for (const entity of state.worldMemory?.entities ?? []) {
    if (entity?.kind !== 'npc' || !entity.id || !entity.name || profiles.has(String(entity.id))) continue
    profiles.set(String(entity.id), safeProfile({
      id: entity.id, name: entity.name, public_summary: entity.summary,
      location: '',
      visibility: entity.visibility === 'public' ? 'public' : entity.visibility === 'party' ? 'party' : 'gm_only',
      available: true,
      tags: entity.tags,
    }))
  }
  return normalizeNpcSocialState({ ...social, npcs: [...profiles.values()] })
}

function elapsedMinutesFor(value = {}) {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? Math.max(0, value)
    : campaignElapsedMinutes(value)
}

function viewerMaySee(visibility, viewer = {}) {
  return viewer.isAdmin === true || visibility === 'public' || (visibility === 'party' && viewer.isPartyMember !== false)
}

/** Returns the active daily schedule entry without mutating persisted NPC data. */
export function npcScheduleEntryAt(profile = {}, stateOrElapsedMinutes = {}) {
  const elapsed = elapsedMinutesFor(stateOrElapsedMinutes)
  const day = Math.floor(elapsed / 1_440) % 7
  const minute = elapsed % 1_440
  return (safeSchedule(profile.schedule) ?? []).find((entry) => (
    (!entry.days.length || entry.days.includes(day))
    && entry.start_minute <= minute && minute < entry.end_minute
  )) ?? null
}

/**
 * Projects a persistent profile into its deterministic current state. This is
 * deliberately derived, so crossing a schedule boundary never rewrites the
 * base location or availability saved in the event stream.
 */
export function npcProfileAtWorldTime(profile = {}, stateOrElapsedMinutes = {}) {
  const normalized = safeProfile(profile)
  const activeSchedule = npcScheduleEntryAt(normalized, stateOrElapsedMinutes)
  if (!activeSchedule) return normalized
  return { ...normalized, location: activeSchedule.location, available: activeSchedule.available }
}

/**
 * Белый список профиля NPC для игрока — **одна** функция на все каналы. Её
 * читает и проекция состояния (`npcSocialForViewer`), и канал событий
 * (`eventForViewer`, `server/viewer-projection.mjs`): `NpcSocialProfileUpserted`
 * несёт тот же профиль, и вторая форма отбора разошлась бы с первой молча.
 */
export function npcProfileForViewerAt(profile, viewer = {}) {
  const normalized = safeProfile(profile)
  const activeSchedule = npcScheduleEntryAt(normalized, viewer.state ?? viewer.elapsed_minutes ?? {})
  // An undisclosed schedule may affect play but must not reveal a private
  // location. The player sees only that this NPC cannot presently be engaged.
  const current = activeSchedule && !viewerMaySee(activeSchedule.visibility, viewer)
    ? { ...normalized, location: '', available: false }
    : npcProfileAtWorldTime(normalized, viewer.state ?? viewer.elapsed_minutes ?? {})
  return {
    id: current.id,
    name: current.name,
    role: current.role,
    location: current.location,
    public_summary: current.public_summary,
    voice: current.voice,
    available: current.available,
    tags: clone(current.tags),
    inventory: current.inventory
      .filter((item) => item.quantity > 0 && viewerMaySee(item.visibility, viewer))
      .map((item) => ({ id: item.id, name: item.name, quantity: item.quantity, description: item.description })),
    dossier: current.dossier
      .filter((entry) => (
        viewer.isAdmin === true
        || entry.visibility === 'public'
        || (entry.visibility === 'party' && viewer.isPartyMember !== false)
        || (entry.visibility === 'specific_player' && entry.hero_id === clean(viewer.playerId, 120))
      ))
      .map((entry) => {
        const { visibility: _visibility, ...visible } = entry
        return clone(visible)
      }),
  }
}

function strictScheduleInput(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 64) {
    throw new NpcSocialValidationError('NPC schedule must contain at most 64 entries', 'NPC_SOCIAL_SCHEDULE_INVALID')
  }
  for (const entry of value) {
    const item = object(entry, 'npc.schedule entry')
    fields(item, new Set(['id', 'days', 'start_minute', 'end_minute', 'location', 'available', 'summary', 'visibility']), 'npc.schedule entry')
    identifier(item.id, 'npc.schedule.id')
    if (!Array.isArray(item.days) || item.days.length > 7 || item.days.some((day) => !Number.isSafeInteger(Number(day)) || !WEEK_DAYS.has(Number(day)))) {
      throw new NpcSocialValidationError('NPC schedule days must be weekdays 0 through 6', 'NPC_SOCIAL_SCHEDULE_INVALID')
    }
    const start = Number(item.start_minute)
    const end = Number(item.end_minute)
    if (!clean(item.location, 180) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || start >= 1_440 || end <= start || end > 1_440) {
      throw new NpcSocialValidationError('NPC schedule interval is invalid', 'NPC_SOCIAL_SCHEDULE_INVALID')
    }
    if (item.visibility != null && !PROFILE_VISIBILITIES.has(item.visibility)) {
      throw new NpcSocialValidationError('NPC schedule visibility is invalid', 'NPC_SOCIAL_SCHEDULE_INVALID')
    }
  }
  const normalized = safeSchedule(value)
  if (normalized.length !== value.length) {
    throw new NpcSocialValidationError('NPC schedule has duplicate ids or overlapping intervals', 'NPC_SOCIAL_SCHEDULE_CONFLICT')
  }
  return normalized
}

function strictInventoryInput(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 100) {
    throw new NpcSocialValidationError('NPC inventory must contain at most 100 entries', 'NPC_SOCIAL_INVENTORY_INVALID')
  }
  for (const entry of value) {
    const item = object(entry, 'npc.inventory entry')
    fields(item, new Set(['id', 'name', 'quantity', 'description', 'visibility']), 'npc.inventory entry')
    identifier(item.id, 'npc.inventory.id')
    const quantity = Number(item.quantity)
    if (!clean(item.name, 160) || !Number.isSafeInteger(quantity) || quantity < 0 || quantity > 9_999) {
      throw new NpcSocialValidationError('NPC inventory item is invalid', 'NPC_SOCIAL_INVENTORY_INVALID')
    }
    if (item.visibility != null && !PROFILE_VISIBILITIES.has(item.visibility)) {
      throw new NpcSocialValidationError('NPC inventory visibility is invalid', 'NPC_SOCIAL_INVENTORY_INVALID')
    }
  }
  const normalized = safeInventory(value)
  if (normalized.length !== value.length) {
    throw new NpcSocialValidationError('NPC inventory has duplicate item ids', 'NPC_SOCIAL_INVENTORY_CONFLICT')
  }
  return normalized
}

function strictSpeechProfileInput(value) {
  if (value == null) return null
  const profile = object(value, 'npc.speech_profile')
  fields(profile, new Set(['pace', 'lexicon', 'mannerism']), 'npc.speech_profile')
  const normalized = {
    pace: clean(profile.pace, 100),
    lexicon: clean(profile.lexicon, 180),
    mannerism: clean(profile.mannerism, 180),
  }
  if (!normalized.pace || !normalized.lexicon || !normalized.mannerism) {
    throw new NpcSocialValidationError(
      'Речевой профиль NPC требует темп, словарь и привычку',
      'NPC_SOCIAL_SPEECH_PROFILE_INVALID',
    )
  }
  return normalized
}

function normalizeProfileInput(input) {
  const value = object(input, 'npc')
  fields(value, new Set(['id', 'name', 'role', 'location', 'public_summary', 'voice', 'speech_profile', 'goals', 'beliefs', 'known_fact_ids', 'social_dcs', 'visibility', 'available', 'tags', 'schedule', 'inventory', 'dossier']), 'npc')
  // Досье принадлежит серверу. Поле принимается только для round-trip
  // спроецированного профиля через админское редактирование: присланные записи
  // игнорируются, а reducer сохраняет событийную историю самого NPC.
  const { dossier: _untrustedDossier, ...editable } = value
  const result = safeProfile({
    ...editable,
    id: identifier(editable.id, 'npc.id'),
    ...(editable.speech_profile == null ? {} : { speech_profile: strictSpeechProfileInput(editable.speech_profile) }),
    schedule: strictScheduleInput(editable.schedule),
    inventory: strictInventoryInput(editable.inventory),
  })
  if (!result.name) throw new NpcSocialValidationError('У NPC должно быть имя', 'NPC_SOCIAL_NAME_REQUIRED')
  if (!PROFILE_VISIBILITIES.has(value.visibility ?? 'party')) throw new NpcSocialValidationError('Некорректная видимость NPC', 'NPC_SOCIAL_VISIBILITY_INVALID')
  return result
}

function normalizeConversationInput(input, state, command, context = {}) {
  const value = object(input, 'conversation')
  fields(value, new Set(['id', 'npc_id', 'hero_id', 'player_message', 'npc_reply', 'stance', 'disclosed_fact_ids', 'disclosed_claim_ids', 'relationship_delta', 'visibility', 'promise', 'check']), 'conversation')
  const social = ensureNpcSocialState(state.social, state)
  const npcId = identifier(value.npc_id, 'conversation.npc_id')
  const heroId = identifier(value.hero_id || command.actor_id, 'conversation.hero_id')
  const persistedNpc = social.npcs.find((candidate) => candidate.id === npcId)
  const npc = persistedNpc ? npcProfileAtWorldTime(persistedNpc, state) : null
  if (!npc || npc.available === false) throw new NpcSocialValidationError('NPC недоступен для разговора', 'NPC_SOCIAL_NPC_UNAVAILABLE')
  if (!(state.partyMemberIds ?? []).map(String).includes(heroId)) throw new NpcSocialValidationError('Герой разговора не входит в отряд', 'NPC_SOCIAL_HERO_INVALID')
  if (state.mechanics?.combat?.active) throw new NpcSocialValidationError('Развёрнутый разговор недоступен во время боя', 'NPC_SOCIAL_DURING_COMBAT')
  const sceneLocation = clean(state.scene?.location, 180).toLocaleLowerCase('ru')
  if (npc.location && sceneLocation && npc.location.toLocaleLowerCase('ru') !== sceneLocation) throw new NpcSocialValidationError('NPC находится в другой локации', 'NPC_SOCIAL_WRONG_LOCATION')
  const canonicalCheck = safeSocialCheck(context.socialCheckOutcome)
  const proposedCheck = safeSocialCheck(value.check)
  if (value.check != null && (!canonicalCheck || !proposedCheck
    || proposedCheck.check_id !== canonicalCheck.check_id
    || proposedCheck.npc_id !== canonicalCheck.npc_id
    || proposedCheck.skill !== canonicalCheck.skill
    || proposedCheck.success !== canonicalCheck.success)) {
    throw new NpcSocialValidationError('The conversation check does not match the server result', 'NPC_SOCIAL_CHECK_MISMATCH')
  }
  if (canonicalCheck && canonicalCheck.npc_id !== npcId) throw new NpcSocialValidationError('The social check belongs to another NPC', 'NPC_SOCIAL_CHECK_MISMATCH')

  const stance = STANCES.has(value.stance) ? value.stance : 'neutral'
  const known = new Set(npc.known_fact_ids)
  for (const fact of state.worldMemory?.facts ?? []) if (['public', 'party'].includes(fact.visibility)) known.add(String(fact.id))
  const disclosed = strings(value.disclosed_fact_ids, 120, 20)
  const activeFacts = new Set((state.worldMemory?.facts ?? []).filter((fact) => fact.status === 'active').map((fact) => String(fact.id)))
  if (disclosed.some((factId) => !known.has(factId) || !activeFacts.has(factId))) {
    throw new NpcSocialValidationError('NPC попытался раскрыть неизвестный или неактуальный факт', 'NPC_SOCIAL_FACT_FORBIDDEN')
  }
  const disclosedClaims = strings(value.disclosed_claim_ids, 120, 20)
  const speakableClaims = new Set((state.worldMemory?.epistemic_claims ?? [])
    .filter((claim) => String(claim.holder_entity_id) === npcId)
    .map((claim) => String(claim.id)))
  if (disclosedClaims.some((claimId) => !speakableClaims.has(claimId))) {
    throw new NpcSocialValidationError('NPC попытался раскрыть чужое убеждение или слух', 'NPC_SOCIAL_CLAIM_FORBIDDEN')
  }
  const conversation = safeConversation({
    id: identifier(value.id, 'conversation.id'), npc_id: npcId, hero_id: heroId,
    player_message: value.player_message, npc_reply: value.npc_reply, stance,
    disclosed_fact_ids: disclosed, disclosed_claim_ids: disclosedClaims, visibility: value.visibility,
    ...(canonicalCheck ? { check: canonicalCheck } : {}),
  })
  if (!conversation.player_message || !conversation.npc_reply) throw new NpcSocialValidationError('Разговор должен содержать реплику героя и ответ NPC', 'NPC_SOCIAL_CONTENT_REQUIRED')
  let relationshipDelta = Math.max(-2, Math.min(2, integer(value.relationship_delta, 0)))
  let promise = null
  if (value.promise != null) {
    const promiseValue = object(value.promise, 'promise')
    fields(promiseValue, new Set(['id', 'direction', 'text', 'due_hint', 'visibility']), 'promise')
    if (!PROMISE_DIRECTIONS.has(promiseValue.direction)) throw new NpcSocialValidationError('Некорректное направление обещания', 'NPC_PROMISE_DIRECTION_INVALID')
    promise = safePromise({
      id: identifier(promiseValue.id, 'promise.id'), npc_id: npcId, hero_id: heroId,
      direction: promiseValue.direction, text: promiseValue.text, due_hint: promiseValue.due_hint,
      visibility: promiseValue.visibility, status: 'open', source_conversation_id: conversation.id,
      created_at_minutes: campaignElapsedMinutes(state),
      deadline_minutes: promiseDueOffsetMinutes(promiseValue.due_hint) == null
        ? null
        : campaignElapsedMinutes(state) + promiseDueOffsetMinutes(promiseValue.due_hint),
    })
    if (!promise.text) throw new NpcSocialValidationError('Обещание не может быть пустым', 'NPC_PROMISE_TEXT_REQUIRED')
  }
  if (canonicalCheck?.skill === 'insight') {
    relationshipDelta = 0
    promise = null
  } else if (canonicalCheck && !canonicalCheck.success) {
    relationshipDelta = Math.min(0, relationshipDelta)
    promise = null
  }
  return { conversation, relationship_delta: relationshipDelta, promise }
}

export function validateNpcSocialCommand(command, state, context = {}) {
  if (!NPC_SOCIAL_COMMAND_TYPES.has(command.command_type)) return command
  const canManage = context.isAdmin === true || context.isDirector === true
  if (command.command_type === 'UpsertNpcSocialProfile') {
    if (!canManage) throw new NpcSocialValidationError('Профили NPC изменяет только системный контур', 'NPC_SOCIAL_FORBIDDEN')
    const npc = normalizeProfileInput(command.npc)
    return { ...command, actor_id: null, target_ids: [], npc, visibility: npc.visibility }
  }
  if (command.command_type === 'RecordNpcSocialTurn') {
    if (!canManage && context.isSocialController !== true) throw new NpcSocialValidationError('Социальный результат не подтверждён серверным контроллером', 'NPC_SOCIAL_FORBIDDEN')
    const normalized = normalizeConversationInput(command.conversation, state, command, context)
    return { ...command, ...normalized, actor_id: normalized.conversation.hero_id, target_ids: [normalized.conversation.npc_id], visibility: normalized.conversation.visibility }
  }
  if (!canManage && context.isSocialController !== true) throw new NpcSocialValidationError('Обещания NPC изменяет только системный контур', 'NPC_SOCIAL_FORBIDDEN')
  const social = ensureNpcSocialState(state.social, state)
  const promiseId = identifier(command.promise_id, 'promise_id')
  const promise = social.promises.find((candidate) => candidate.id === promiseId)
  if (!promise || promise.status !== 'open') throw new NpcSocialValidationError('Открытое обещание не найдено', 'NPC_PROMISE_NOT_FOUND')
  const status = clean(command.status, 30)
  if (!['fulfilled', 'broken', 'cancelled'].includes(status)) throw new NpcSocialValidationError('Некорректный итог обещания', 'NPC_PROMISE_STATUS_INVALID')
  return {
    ...command, actor_id: null, target_ids: [promise.hero_id], promise_id: promiseId, status,
    resolved_at_minutes: campaignElapsedMinutes(state), resolution_reason: 'manual',
    consequence_delta: promiseConsequence(promise, status), visibility: promise.visibility,
  }
}

function promiseConsequence(promise, status) {
  if (status === 'cancelled') return 0
  if (status === 'fulfilled') return promise.direction === 'party_to_npc' ? 8 : 4
  if (status === 'broken') return promise.direction === 'party_to_npc' ? -15 : -8
  return 0
}

function relationshipEvents(state, npcId, heroId, delta, reason, promiseId = '', scoreOverride = null) {
  const social = ensureNpcSocialState(state.social, state)
  const before = scoreOverride == null ? social.relationships[npcId]?.[heroId] ?? 0 : scoreOverride
  const boundedDelta = Math.max(-25, Math.min(25, integer(delta, 0)))
  if (!boundedDelta) return { events: [], after: before }
  const after = Math.max(-100, Math.min(100, before + boundedDelta))
  const tierBefore = relationshipTier(before)
  const tierAfter = relationshipTier(after)
  const payload = { npc_id: npcId, hero_id: heroId, delta: boundedDelta, score_before: before, score_after: after, tier_before: tierBefore, tier_after: tierAfter, reason: clean(reason, 80), promise_id: clean(promiseId, 120) }
  const events = [{ event_type: 'NpcRelationshipAdjusted', payload, target_ids: [heroId], visibility: 'specific_player' }]
  if (tierBefore !== tierAfter) events.push({ event_type: 'NpcRelationshipTierChanged', payload, target_ids: [heroId], visibility: 'specific_player' })
  return { events, after }
}

/**
 * Черновики событий отношения для тех, кто двигает его **не разговором**.
 *
 * Тонкая обёртка над `relationshipEvents` существует ради единственного
 * инварианта: арифметика отношения — границы дельты, потолок счёта и порог
 * смены ступени — живёт в одном месте. Дошедшее письмо (`server/courier-letters.mjs`)
 * — такое же социальное действие, как реплика в разговоре, и считать его своей
 * копией правил значило бы завести вторую таблицу ступеней, которая разойдётся с
 * первой на первой же правке порогов.
 *
 * Возвращаются именно черновики (`event_type`/`payload`/`target_ids`/`visibility`),
 * а не события: `event_id`, версию состояния и провенанс проставляет Rules Engine.
 *
 * @returns {Array<{ event_type: string, payload: any, target_ids: string[], visibility: string }>}
 */
export function npcRelationshipEventDrafts(state = {}, { npcId = '', heroId = '', delta = 0, reason = '', promiseId = '' } = {}) {
  const npc = clean(npcId, 120)
  const hero = clean(heroId, 120)
  if (!npc || !hero) return []
  return relationshipEvents(state, npc, hero, delta, reason, promiseId).events
}

export function npcSocialEvents(command, state = {}) {
  if (command.command_type === 'UpsertNpcSocialProfile') return [{ event_type: 'NpcSocialProfileUpserted', payload: { npc: clone(command.npc) }, target_ids: [], visibility: command.visibility }]
  if (command.command_type === 'RecordNpcSocialTurn') {
    const conversationEventId = `${command.command_id}:conversation`
    const events = [{
      event_id: conversationEventId,
      event_type: 'NpcConversationRecorded',
      payload: { conversation: clone(command.conversation) },
      target_ids: [command.conversation.npc_id, command.conversation.hero_id],
      visibility: command.visibility,
    }]
    for (const [index, factId] of command.conversation.disclosed_fact_ids.entries()) {
      events.push({
        event_id: `${command.command_id}:knowledge:${index + 1}`,
        event_type: 'KnowledgeRevealed',
        payload: {
          knowledge_id: `${command.conversation.id}:knowledge:${index + 1}`,
          hero_id: command.conversation.hero_id,
          fact_id: factId,
          source_event_ids: [conversationEventId],
          source_kind: 'npc',
          revealed_at_minutes: campaignElapsedMinutes(state),
        },
        target_ids: [command.conversation.hero_id],
        visibility: 'specific_player',
      })
    }
    events.push(...relationshipEvents(state, command.conversation.npc_id, command.conversation.hero_id, command.relationship_delta, 'conversation').events)
    if (command.promise) events.push({ event_type: 'NpcPromiseRecorded', payload: { promise: clone(command.promise) }, target_ids: [command.conversation.hero_id], visibility: command.promise.visibility })
    return events
  }
  if (command.command_type === 'ResolveNpcPromise') {
    const social = ensureNpcSocialState(state.social, state)
    const promise = social.promises.find((candidate) => candidate.id === command.promise_id)
    const events = [{ event_type: 'NpcPromiseResolved', payload: {
      promise_id: command.promise_id, status: command.status, resolved_at_minutes: command.resolved_at_minutes,
      resolution_reason: command.resolution_reason, consequence_delta: command.consequence_delta,
    }, target_ids: command.target_ids, visibility: command.visibility }]
    if (promise) events.push(...relationshipEvents(state, promise.npc_id, promise.hero_id, command.consequence_delta, `promise-${command.status}`, promise.id).events)
    return events
  }
  return []
}

export function npcPromiseDeadlineEvents(state = {}, elapsedMinutes = 0) {
  const social = ensureNpcSocialState(state.social, state)
  const start = campaignElapsedMinutes(state)
  const end = start + Math.max(0, integer(elapsedMinutes, 0))
  const scores = new Map()
  const events = []
  for (const promise of social.promises) {
    if (promise.status !== 'open' || promise.deadline_minutes == null || promise.deadline_minutes > end) continue
    const delta = promiseConsequence(promise, 'broken')
    events.push({ event_type: 'NpcPromiseResolved', payload: {
      promise_id: promise.id, status: 'broken', resolved_at_minutes: Math.max(start, promise.deadline_minutes),
      resolution_reason: 'deadline', consequence_delta: delta,
    }, target_ids: [promise.hero_id], visibility: promise.visibility })
    const key = `${promise.npc_id}\0${promise.hero_id}`
    const before = scores.has(key) ? scores.get(key) : social.relationships[promise.npc_id]?.[promise.hero_id] ?? 0
    const result = relationshipEvents(state, promise.npc_id, promise.hero_id, delta, 'promise-deadline', promise.id, before)
    events.push(...result.events)
    scores.set(key, result.after)
  }
  return events
}

export function applyNpcSocialEvent(input, event, state = {}) {
  const social = ensureNpcSocialState(input, state)
  const payload = event.payload ?? {}
  if (event.event_type === 'NpcSocialProfileUpserted') {
    const previous = social.npcs.find((candidate) => candidate.id === clean(payload.npc?.id, 120))
    const npc = safeProfile({ ...payload.npc, dossier: previous?.dossier })
    social.npcs = [...social.npcs.filter((candidate) => candidate.id !== npc.id), npc]
  }
  if (event.event_type === 'NpcConversationRecorded') {
    const conversation = safeConversation(payload.conversation)
    social.conversations = [...social.conversations.filter((candidate) => candidate.id !== conversation.id), conversation].slice(-500)
    const dossierEntry = dossierEntryFromConversation(conversation, event)
    if (dossierEntry) {
      social.npcs = social.npcs.map((npc) => npc.id === conversation.npc_id
        ? safeProfile({
            ...npc,
            dossier: [
              ...npc.dossier.filter((entry) => entry.id !== dossierEntry.id),
              dossierEntry,
            ],
          })
        : npc)
    }
  }
  if (event.event_type === 'NpcRelationshipAdjusted') {
    const npcId = clean(payload.npc_id, 120)
    const heroId = clean(payload.hero_id, 120)
    const before = social.relationships[npcId]?.[heroId] ?? 0
    social.relationships[npcId] = { ...(social.relationships[npcId] ?? {}), [heroId]: Math.max(-100, Math.min(100, before + Math.max(-25, Math.min(25, integer(payload.delta, 0))))) }
  }
  if (event.event_type === 'NpcPromiseRecorded') {
    const promise = safePromise(payload.promise)
    social.promises = [...social.promises.filter((candidate) => candidate.id !== promise.id), promise].slice(-500)
  }
  if (event.event_type === 'NpcPromiseResolved') {
    social.promises = social.promises.map((promise) => promise.id === payload.promise_id && promise.status === 'open' ? safePromise({
      ...promise, status: PROMISE_STATUSES.has(payload.status) ? payload.status : promise.status,
      resolved_at_minutes: payload.resolved_at_minutes, resolution_reason: payload.resolution_reason,
      consequence_delta: payload.consequence_delta,
    }) : promise)
  }
  return social
}

export function npcSocialForViewer(input, viewer = {}) {
  const social = normalizeNpcSocialState(input)
  if (viewer.isAdmin) return social
  const playerId = clean(viewer.playerId, 120)
  const npcs = social.npcs
    .filter((npc) => viewerMaySee(npc.visibility, viewer))
    .map((npc) => npcProfileForViewerAt(npc, viewer))
  const visibleNpcIds = new Set(npcs.map((npc) => npc.id))
  const conversations = social.conversations.filter((entry) => visibleNpcIds.has(entry.npc_id) && (entry.visibility === 'party' || entry.hero_id === playerId))
  const promises = social.promises.filter((entry) => visibleNpcIds.has(entry.npc_id) && (entry.visibility === 'party' || entry.hero_id === playerId))
  const relationships = Object.fromEntries([...visibleNpcIds].map((npcId) => [npcId, { [playerId]: social.relationships[npcId]?.[playerId] ?? 0 }]))
  const relationship_tiers = Object.fromEntries([...visibleNpcIds].map((npcId) => [npcId, { [playerId]: relationshipTier(relationships[npcId][playerId]) }]))
  return { schema_version: 4, npcs: clone(npcs), relationships, relationship_tiers, conversations: clone(conversations), promises: clone(promises) }
}

function narratorDossierText(value, maximum) {
  return clean(value, maximum)
}

function narratorDossierVisibilityAllowed(value) {
  return !['gm_only', 'gmOnly', 'npc_private', 'npcPrivate'].includes(String(value ?? ''))
}

function narratorDossierRecordVisible(record, viewerIds, viewerNames) {
  if (!narratorDossierVisibilityAllowed(record?.visibility)) return false
  if (record?.visibility !== 'specific_player') return true
  return viewerIds.has(String(record?.hero_id ?? ''))
    || viewerNames.has(narratorNpcKey(record?.hero))
}

function narratorNpcKey(value) {
  return narratorDossierText(value, 160).toLocaleLowerCase('ru')
}

/**
 * Нормализует явное event-sourced досье из уже спроецированного NarrationBrief.
 * Эта функция намеренно не восстанавливает его из `recent_interactions`: полное
 * досье профиля должен передать владелец story-context, иначе длинная история
 * снова незаметно сузится до окна последних разговоров.
 */
export function npcDossiersForNarrator(brief = {}) {
  const story = brief?.known_environment?.story_context ?? {}
  const present = (Array.isArray(story.present_npcs) ? story.present_npcs : [])
    .filter((npc) => npc?.id && npc?.name && narratorDossierVisibilityAllowed(npc.visibility))
    .slice(0, 4)
  if (!present.length) return []
  const presentById = new Map(present.map((npc) => [String(npc.id), npc]))
  const viewerHeroes = (Array.isArray(story.heroes) ? story.heroes : []).filter((hero) => hero?.is_viewer)
  const viewerIds = new Set(viewerHeroes.map((hero) => String(hero?.id ?? '')).filter(Boolean))
  const viewerNames = new Set(viewerHeroes.map((hero) => narratorNpcKey(hero?.name)).filter(Boolean))
  const dossiers = []
  for (const source of Array.isArray(story.npc_dossiers) ? story.npc_dossiers : []) {
    if (!narratorDossierRecordVisible(source, viewerIds, viewerNames)) continue
    const npc = presentById.get(String(source?.npc_id ?? ''))
    if (!npc) continue
    const interactionEntries = []
    const interactionKeys = new Set()
    for (const entry of Array.isArray(source?.interactions) ? source.interactions : []) {
      if (!narratorDossierRecordVisible(entry, viewerIds, viewerNames)) continue
      const sourceConversationId = narratorDossierText(entry?.provenance?.source_conversation_id, 120)
      const recordKey = narratorDossierText(entry?.id, 120) || sourceConversationId
      const summary = narratorDossierText(entry?.summary, 600)
      if (!recordKey || !summary || interactionKeys.has(recordKey)) continue
      interactionKeys.add(recordKey)
      interactionEntries.push({
        id: narratorDossierText(entry?.id, 120),
        kind: 'recorded_exchange',
        hero_id: narratorDossierText(entry?.hero_id, 120),
        summary,
        stance: narratorDossierText(entry?.stance, 40) || 'neutral',
        epistemic_status: entry?.epistemic_status === 'contains_unverified_claims'
          ? 'contains_unverified_claims'
          : 'recorded_dialogue_not_world_fact',
        disclosed_claims: (Array.isArray(entry?.disclosed_claims) ? entry.disclosed_claims : [])
          .map((claim) => ({
            id: narratorDossierText(claim?.id, 120),
            truth_status: 'unknown',
          }))
          .filter((claim) => claim.id)
          .slice(0, 12),
        provenance: {
          source_kind: 'NpcConversationRecorded',
          source_conversation_id: sourceConversationId,
          source_event_ids: (Array.isArray(entry?.provenance?.source_event_ids)
            ? entry.provenance.source_event_ids
            : [])
            .map((eventId) => narratorDossierText(eventId, 120))
            .filter(Boolean)
            .slice(0, 8),
        },
      })
    }
    const promiseEntries = []
    const promiseKeys = new Set()
    for (const promise of Array.isArray(source?.promises) ? source.promises : []) {
      if (!narratorDossierRecordVisible(promise, viewerIds, viewerNames)) continue
      const id = narratorDossierText(promise?.id, 120)
      const text = narratorDossierText(promise?.text, 280)
      if (!id || !text || promiseKeys.has(id)) continue
      promiseKeys.add(id)
      promiseEntries.push({
        id,
        direction: narratorDossierText(promise?.direction, 40),
        text,
        due_hint: narratorDossierText(promise?.due_hint, 160),
        status: 'open',
        provenance: {
          source_kind: 'event_reduced_promise',
          source_id: id,
          source_conversation_id: narratorDossierText(promise?.source_conversation_id, 120),
        },
      })
    }
    const relationship = narratorDossierText(source?.relationship?.tier, 40) || 'neutral'
    if (!interactionEntries.length && !promiseEntries.length && relationship === 'neutral') continue
    dossiers.push({
      npc_id: narratorDossierText(npc.id, 120),
      name: narratorDossierText(npc.name, 160),
      relationship: {
        tier: relationship,
        provenance: {
          source_kind: 'event_reduced_relationship',
          source_event_ids: (Array.isArray(source?.relationship?.provenance?.source_event_ids)
            ? source.relationship.provenance.source_event_ids
            : [])
            .map((eventId) => narratorDossierText(eventId, 120))
            .filter(Boolean)
            .slice(0, 8),
        },
      },
      interactions: interactionEntries.slice(-NPC_NARRATOR_DOSSIER_LIMITS.interactions),
      promises: promiseEntries.slice(-NPC_NARRATOR_DOSSIER_LIMITS.promises),
    })
    if (dossiers.length >= NPC_NARRATOR_DOSSIER_LIMITS.npcs) break
  }
  return dossiers
}

export function npcConversationNarration(events = [], state = {}) {
  const event = events.find((candidate) => candidate.event_type === 'NpcConversationRecorded')
  if (!event?.payload?.conversation?.npc_reply) return null
  const conversation = event.payload.conversation
  // Реплику NPC подписывает сам NPC, а не Рассказчик: иначе в ленте нельзя
  // отличить прямую речь собеседника от описания сцены.
  const npcName = clean(state?.social?.npcs?.find((entry) => entry.id === conversation.npc_id)?.name, 80)
  const skillLabel = { persuasion: '\u0423\u0431\u0435\u0436\u0434\u0435\u043d\u0438\u0435', deception: '\u041e\u0431\u043c\u0430\u043d', intimidation: '\u0417\u0430\u043f\u0443\u0433\u0438\u0432\u0430\u043d\u0438\u0435', insight: '\u041f\u0440\u043e\u043d\u0438\u0446\u0430\u0442\u0435\u043b\u044c\u043d\u043e\u0441\u0442\u044c' }[conversation.check?.skill] ?? conversation.check?.skill
  const outcomeLabel = conversation.check?.success ? '\u0443\u0441\u043f\u0435\u0445' : '\u043f\u0440\u043e\u0432\u0430\u043b'
  const checkSummary = conversation.check ? '\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u00ab' + skillLabel + '\u00bb: ' + outcomeLabel + ' (' + conversation.check.total + ').\n' : ''
  return {
    narration: checkSummary + conversation.npc_reply,
    ...(npcName ? { journal_author: npcName } : {}),
    provider: 'NpcSocialController',
    prompt_version: 'npc_controller/social-v3',
    verification: { valid: true, violations: [] },
  }
}
