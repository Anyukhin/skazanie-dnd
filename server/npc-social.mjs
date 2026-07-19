const PROFILE_VISIBILITIES = new Set(['public', 'party', 'gm_only'])
const PROMISE_DIRECTIONS = new Set(['npc_to_party', 'party_to_npc'])
const PROMISE_STATUSES = new Set(['open', 'fulfilled', 'broken', 'cancelled'])
const STANCES = new Set(['friendly', 'neutral', 'guarded', 'hostile'])
const SOCIAL_CHECK_SKILLS = new Set(['persuasion', 'deception', 'intimidation', 'insight'])
const SOCIAL_CHECK_DEGREES = new Set(['strong_success', 'success', 'failure', 'severe_failure'])

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

function safeProfile(value = {}) {
  return {
    id: clean(value.id, 120),
    name: clean(value.name, 160),
    role: clean(value.role, 160),
    location: clean(value.location, 180),
    public_summary: clean(value.public_summary, 1_000),
    voice: clean(value.voice, 500),
    goals: strings(value.goals, 300, 12),
    beliefs: strings(value.beliefs, 300, 20),
    known_fact_ids: strings(value.known_fact_ids, 120, 100),
    visibility: PROFILE_VISIBILITIES.has(value.visibility) ? value.visibility : 'party',
    available: value.available !== false,
    tags: strings(value.tags, 60, 20),
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
    visibility: value.visibility === 'specific_player' ? 'specific_player' : 'party',
    ...(safeSocialCheck(value.check) ? { check: safeSocialCheck(value.check) } : {}),
  }
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
  return { schema_version: 2, npcs, relationships, relationship_tiers, conversations, promises }
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
    tags: ['merchant'],
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

function normalizeProfileInput(input) {
  const value = object(input, 'npc')
  fields(value, new Set(['id', 'name', 'role', 'location', 'public_summary', 'voice', 'goals', 'beliefs', 'known_fact_ids', 'visibility', 'available', 'tags']), 'npc')
  const result = safeProfile({ ...value, id: identifier(value.id, 'npc.id') })
  if (!result.name) throw new NpcSocialValidationError('У NPC должно быть имя', 'NPC_SOCIAL_NAME_REQUIRED')
  if (!PROFILE_VISIBILITIES.has(value.visibility ?? 'party')) throw new NpcSocialValidationError('Некорректная видимость NPC', 'NPC_SOCIAL_VISIBILITY_INVALID')
  return result
}

function normalizeConversationInput(input, state, command, context = {}) {
  const value = object(input, 'conversation')
  fields(value, new Set(['id', 'npc_id', 'hero_id', 'player_message', 'npc_reply', 'stance', 'disclosed_fact_ids', 'relationship_delta', 'visibility', 'promise', 'check']), 'conversation')
  const social = ensureNpcSocialState(state.social, state)
  const npcId = identifier(value.npc_id, 'conversation.npc_id')
  const heroId = identifier(value.hero_id || command.actor_id, 'conversation.hero_id')
  const npc = social.npcs.find((candidate) => candidate.id === npcId)
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
  if (disclosed.some((factId) => !known.has(factId))) throw new NpcSocialValidationError('NPC попытался раскрыть неизвестный ему факт', 'NPC_SOCIAL_FACT_FORBIDDEN')
  const conversation = safeConversation({
    id: identifier(value.id, 'conversation.id'), npc_id: npcId, hero_id: heroId,
    player_message: value.player_message, npc_reply: value.npc_reply, stance,
    disclosed_fact_ids: disclosed, visibility: value.visibility,
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

export function npcSocialEvents(command, state = {}) {
  if (command.command_type === 'UpsertNpcSocialProfile') return [{ event_type: 'NpcSocialProfileUpserted', payload: { npc: clone(command.npc) }, target_ids: [], visibility: command.visibility }]
  if (command.command_type === 'RecordNpcSocialTurn') {
    const events = [{ event_type: 'NpcConversationRecorded', payload: { conversation: clone(command.conversation) }, target_ids: [command.conversation.npc_id], visibility: command.visibility }]
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
    const npc = safeProfile(payload.npc)
    social.npcs = [...social.npcs.filter((candidate) => candidate.id !== npc.id), npc]
  }
  if (event.event_type === 'NpcConversationRecorded') {
    const conversation = safeConversation(payload.conversation)
    social.conversations = [...social.conversations.filter((candidate) => candidate.id !== conversation.id), conversation].slice(-500)
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
  const npcs = social.npcs.filter((npc) => npc.visibility === 'public' || (npc.visibility === 'party' && viewer.isPartyMember !== false)).map((npc) => ({
    id: npc.id, name: npc.name, role: npc.role, location: npc.location,
    public_summary: npc.public_summary, voice: npc.voice, available: npc.available, tags: clone(npc.tags),
  }))
  const visibleNpcIds = new Set(npcs.map((npc) => npc.id))
  const conversations = social.conversations.filter((entry) => visibleNpcIds.has(entry.npc_id) && (entry.visibility === 'party' || entry.hero_id === playerId))
  const promises = social.promises.filter((entry) => visibleNpcIds.has(entry.npc_id) && (entry.visibility === 'party' || entry.hero_id === playerId))
  const relationships = Object.fromEntries([...visibleNpcIds].map((npcId) => [npcId, { [playerId]: social.relationships[npcId]?.[playerId] ?? 0 }]))
  const relationship_tiers = Object.fromEntries([...visibleNpcIds].map((npcId) => [npcId, { [playerId]: relationshipTier(relationships[npcId][playerId]) }]))
  return { schema_version: 2, npcs: clone(npcs), relationships, relationship_tiers, conversations: clone(conversations), promises: clone(promises) }
}

export function npcConversationNarration(events = []) {
  const event = events.find((candidate) => candidate.event_type === 'NpcConversationRecorded')
  if (!event?.payload?.conversation?.npc_reply) return null
  const conversation = event.payload.conversation
  const skillLabel = { persuasion: '\u0423\u0431\u0435\u0436\u0434\u0435\u043d\u0438\u0435', deception: '\u041e\u0431\u043c\u0430\u043d', intimidation: '\u0417\u0430\u043f\u0443\u0433\u0438\u0432\u0430\u043d\u0438\u0435', insight: '\u041f\u0440\u043e\u043d\u0438\u0446\u0430\u0442\u0435\u043b\u044c\u043d\u043e\u0441\u0442\u044c' }[conversation.check?.skill] ?? conversation.check?.skill
  const outcomeLabel = conversation.check?.success ? '\u0443\u0441\u043f\u0435\u0445' : '\u043f\u0440\u043e\u0432\u0430\u043b'
  const checkSummary = conversation.check ? '\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u00ab' + skillLabel + '\u00bb: ' + outcomeLabel + ' (' + conversation.check.total + ').\n' : ''
  return {
    narration: checkSummary + conversation.npc_reply,
    suggestions: ['Продолжить разговор', 'Уточнить, откуда NPC это знает'],
    provider: 'NpcSocialController',
    prompt_version: 'npc_controller/social-v1',
    verification: { valid: true, violations: [] },
  }
}
