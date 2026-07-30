import { reputationTier } from './reputation-policy.mjs'
import { MAX_CAMPAIGN_ARCS, campaignArcClimaxSatisfied, campaignArcPlan } from './campaign-loop-policy.mjs'

const STATUSES = new Set(['setup', 'active', 'paused', 'completed', 'failed', 'archived'])
const TERMINAL = new Set(['completed', 'failed', 'archived'])
const VISIBLE_TO_PARTY = new Set(['public', 'party'])
const RESOLVED_QUEST_STATUSES = new Set(['completed', 'failed'])
const RESOLVED_PROMISE_STATUSES = new Set(['fulfilled', 'broken'])

const clean = (value, maximum = 500) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const visibleToParty = (entry, fallback = 'party') => VISIBLE_TO_PARTY.has(clean(entry?.visibility || fallback, 30))
const withoutTerminalPunctuation = (value, maximum = 500) => clean(value, maximum).replace(/[.!?…]+$/u, '')

function requestedEpilogueOutcome(state, input) {
  const requested = typeof input === 'string' ? input : input?.outcome
  if (['failed', 'failure', 'defeat'].includes(clean(requested, 30).toLowerCase())) return 'failed'
  if (['completed', 'complete', 'success', 'victory'].includes(clean(requested, 30).toLowerCase())) return 'completed'
  const lifecycle = normalizeCampaignLifecycle(state?.mechanics?.campaign_lifecycle, state?.mechanics?.death?.campaign_status)
  return lifecycle.status === 'failed' || state?.mechanics?.death?.campaign_status === 'party_defeated' ? 'failed' : 'completed'
}

function locationKey(id, name) {
  const stableId = clean(id, 120)
  if (stableId) return `location:${stableId}`
  const normalizedName = clean(name, 180).toLocaleLowerCase('ru')
  return normalizedName ? `location-name:${normalizedName}` : ''
}

/**
 * Собирает единственный party-visible набор подтверждённых данных для обеих
 * форм эпилога. Ключи позволяют тестам проверять происхождение без привязки к
 * художественной формулировке.
 */
export function collectEpilogueFacts(state = {}, outcomeOrOptions = undefined) {
  const outcome = requestedEpilogueOutcome(state, outcomeOrOptions)
  const worldMemory = state?.worldMemory && typeof state.worldMemory === 'object' ? state.worldMemory : {}
  const visibleEntities = (Array.isArray(worldMemory.entities) ? worldMemory.entities : [])
    .filter((entity) => visibleToParty(entity, 'gm_only'))
  const entitiesById = new Map(visibleEntities.map((entity) => [clean(entity?.id, 120), entity]))

  const heroes = (Array.isArray(state?.players) ? state.players : []).slice(0, 12).map((hero) => {
    const id = clean(hero?.id, 120)
    const status = state?.mechanics?.death?.heroes?.[id]?.status === 'dead' ? 'dead' : 'living'
    return {
      key: `hero:${id}`,
      hero_id: id,
      name: clean(hero?.character || hero?.name || id, 120),
      status,
    }
  }).filter((hero) => hero.hero_id && hero.name)

  const quests = (Array.isArray(worldMemory.quests) ? worldMemory.quests : [])
    .filter((quest) => visibleToParty(quest) && RESOLVED_QUEST_STATUSES.has(clean(quest?.status, 30)))
    .slice(-6)
    .map((quest) => ({
      key: `quest:${clean(quest?.id, 120)}`,
      quest_id: clean(quest?.id, 120),
      title: clean(quest?.title, 180),
      status: clean(quest?.status, 30),
      summary: clean(quest?.summary, 240),
    }))
    .filter((quest) => quest.quest_id && quest.title)

  const visibleNpcs = new Map((Array.isArray(state?.social?.npcs) ? state.social.npcs : [])
    .filter(visibleToParty)
    .map((npc) => [clean(npc?.id, 120), npc]))
  const promises = (Array.isArray(state?.social?.promises) ? state.social.promises : [])
    .filter((promise) => visibleToParty(promise)
      && RESOLVED_PROMISE_STATUSES.has(clean(promise?.status, 30))
      && visibleNpcs.has(clean(promise?.npc_id, 120)))
    .slice(-6)
    .map((promise) => {
      const npcId = clean(promise?.npc_id, 120)
      const npc = visibleNpcs.get(npcId)
      return {
        key: `promise:${clean(promise?.id, 120)}`,
        promise_id: clean(promise?.id, 120),
        npc_id: npcId,
        npc_name: clean(npc?.name || npcId, 120),
        direction: clean(promise?.direction, 40),
        status: clean(promise?.status, 30),
        text: clean(promise?.text, 220),
      }
    })
    .filter((promise) => promise.promise_id && promise.text)

  const visibleFacts = (Array.isArray(worldMemory.facts) ? worldMemory.facts : [])
    .filter((fact) => visibleToParty(fact, 'gm_only') && clean(fact?.status, 30) === 'active')
    .slice(-8)
    .map((fact) => {
      const subjectId = clean(fact?.subject_id, 120)
      const subject = entitiesById.get(subjectId)
      return {
        key: `world_fact:${clean(fact?.id, 120)}`,
        fact_id: clean(fact?.id, 120),
        subject_id: subjectId,
        subject_kind: clean(subject?.kind, 30),
        subject_name: clean(subject?.name, 160),
        predicate: clean(fact?.predicate, 120),
        summary: clean(fact?.summary || fact?.object, 240),
      }
    })
    .filter((fact) => fact.fact_id && fact.summary)
  const npc_fates = visibleFacts.filter((fact) => fact.subject_kind === 'npc')
  const world_facts = visibleFacts.filter((fact) => fact.subject_kind !== 'npc')

  const visibleFactions = new Map(visibleEntities
    .filter((entity) => clean(entity?.kind, 30) === 'faction')
    .map((entity) => [clean(entity?.id, 120), entity]))
  const reputations = state?.autonomy?.reputations && typeof state.autonomy.reputations === 'object' && !Array.isArray(state.autonomy.reputations)
    ? state.autonomy.reputations
    : {}
  const faction_reputations = Object.entries(reputations)
    .map(([factionId, rawScore]) => ({
      faction_id: clean(factionId, 120),
      score: Math.max(-100, Math.min(100, Number.isSafeInteger(Number(rawScore)) ? Number(rawScore) : 0)),
    }))
    .filter((entry) => entry.score !== 0 && visibleFactions.has(entry.faction_id))
    .sort((left, right) => Math.abs(right.score) - Math.abs(left.score) || left.faction_id.localeCompare(right.faction_id))
    .slice(0, 6)
    .map((entry) => ({
      key: `reputation:${entry.faction_id}`,
      faction_id: entry.faction_id,
      faction_name: clean(visibleFactions.get(entry.faction_id)?.name || entry.faction_id, 160),
      tier: reputationTier(entry.score),
    }))

  const visitedLocations = new Map()
  const addVisitedLocation = (id, name) => {
    const locationName = clean(name, 180)
    const key = locationKey(id, locationName)
    if (!key || !locationName || visitedLocations.has(key)) return
    visitedLocations.set(key, { key, location_id: clean(id, 120), name: locationName })
  }
  const visibleVisitedByName = new Map()
  for (const entity of visibleEntities) {
    if (clean(entity?.kind, 30) !== 'location' || !(Array.isArray(entity?.tags) && entity.tags.includes('visited'))) continue
    visibleVisitedByName.set(clean(entity?.name, 180).toLocaleLowerCase('ru'), entity)
  }
  const worldMapVisitedByName = new Map()
  for (const location of Array.isArray(state?.worldMap?.locations) ? state.worldMap.locations : []) {
    if (location?.visited !== true) continue
    worldMapVisitedByName.set(clean(location?.name, 180).toLocaleLowerCase('ru'), location)
  }
  const visitedNames = Array.isArray(state?.adventure?.visitedLocations) ? state.adventure.visitedLocations : []
  const visitedIds = Array.isArray(state?.adventure?.visitedLocationIds) ? state.adventure.visitedLocationIds : []
  visitedNames.forEach((name, index) => {
    const normalizedName = clean(name, 180).toLocaleLowerCase('ru')
    const known = worldMapVisitedByName.get(normalizedName) ?? visibleVisitedByName.get(normalizedName)
    addVisitedLocation(visitedIds[index] || known?.id, name)
  })
  for (const location of worldMapVisitedByName.values()) addVisitedLocation(location?.id, location?.name)
  for (const location of visibleVisitedByName.values()) addVisitedLocation(location?.id, location?.name)
  const visited_locations = [...visitedLocations.values()].slice(-8)

  const fact_keys = [
    ...heroes.map((entry) => entry.key),
    ...quests.map((entry) => entry.key),
    ...promises.map((entry) => entry.key),
    ...visibleFacts.map((entry) => entry.key),
    ...faction_reputations.map((entry) => entry.key),
    ...visited_locations.map((entry) => entry.key),
  ]

  return {
    outcome,
    campaign: clean(state?.campaign || 'Кампания', 180),
    final_objective: clean(state?.scene?.objective, 300),
    final_location: clean(state?.scene?.location, 180),
    heroes,
    quests,
    promises,
    npc_fates,
    world_facts,
    faction_reputations,
    visited_locations,
    fact_keys,
  }
}

export function normalizeCampaignLifecycle(input, deathStatus = 'active') {
  const raw = input && typeof input === 'object' ? input : {}
  const legacyFailed = deathStatus === 'party_defeated'
  const status = STATUSES.has(raw.status) ? raw.status : legacyFailed ? 'failed' : 'active'
  return {
    schema_version: 1,
    status,
    reason: raw.reason == null ? (legacyFailed ? 'party_final_death' : null) : String(raw.reason).slice(0, 240),
    paused_at: raw.paused_at ?? null,
    concluded_at: raw.concluded_at ?? (legacyFailed ? raw.updated_at ?? null : null),
    archived_at: raw.archived_at ?? null,
    epilogue: raw.epilogue == null ? null : String(raw.epilogue).slice(0, 8_000),
    epilogue_fact_keys: Array.isArray(raw.epilogue_fact_keys)
      ? raw.epilogue_fact_keys.map((key) => clean(key, 240)).filter(Boolean).slice(0, 64)
      : [],
    changed_by: raw.changed_by == null ? null : String(raw.changed_by).slice(0, 120),
  }
}

export function campaignIsReadOnly(state) {
  return TERMINAL.has(normalizeCampaignLifecycle(state?.mechanics?.campaign_lifecycle, state?.mechanics?.death?.campaign_status).status)
}

export function assertCampaignPlayable(state) {
  const lifecycle = normalizeCampaignLifecycle(state?.mechanics?.campaign_lifecycle, state?.mechanics?.death?.campaign_status)
  if (lifecycle.status === 'paused') {
    const error = new Error('Кампания приостановлена владельцем')
    error.code = 'CAMPAIGN_PAUSED'
    throw error
  }
  if (TERMINAL.has(lifecycle.status)) {
    const error = new Error('Завершённая или архивная кампания доступна только для чтения')
    error.code = 'CAMPAIGN_READ_ONLY'
    throw error
  }
  return lifecycle
}

export function lifecycleEventForAction(action, state, { actorId, reason, now = new Date().toISOString() } = {}) {
  const lifecycle = normalizeCampaignLifecycle(state?.mechanics?.campaign_lifecycle, state?.mechanics?.death?.campaign_status)
  const normalizedAction = String(action || '').toLowerCase()
  // Цепочка арок решается **заранее**, а не в момент кульминации: сервер
  // закрывает арку автоматически, и спрашивать стол в этот момент уже поздно —
  // финал успел бы наступить. Владелец объявляет намерение, пока кампания идёт.
  if (['chain_arcs', 'conclude_after_arc'].includes(normalizedAction)) {
    if (!['active', 'paused'].includes(lifecycle.status)) {
      const error = new Error(`Продолжение кампании настраивается только в активной кампании, а не в "${lifecycle.status}"`)
      error.code = 'INVALID_CAMPAIGN_TRANSITION'
      throw error
    }
    return {
      event_type: 'CampaignArcChainSet',
      actor_id: actorId ?? null,
      target_ids: [],
      visibility: 'party',
      source_rule_ids: [],
      ruling_id: null,
      payload: {
        enabled: normalizedAction === 'chain_arcs',
        reason: String(reason || normalizedAction).slice(0, 240),
        changed_by: actorId ?? null,
        occurred_at: now,
      },
    }
  }
  const transitions = {
    activate: { from: ['setup'], to: 'active', event: 'CampaignActivated' },
    pause: { from: ['active'], to: 'paused', event: 'CampaignPaused' },
    resume: { from: ['paused'], to: 'active', event: 'CampaignResumed' },
    complete: { from: ['active', 'paused'], to: 'completed', event: 'CampaignCompleted' },
    fail: { from: ['active'], to: 'failed', event: 'CampaignFailed' },
    archive: { from: ['setup', 'paused', 'completed', 'failed'], to: 'archived', event: 'CampaignArchived' },
  }
  const transition = transitions[normalizedAction]
  if (!transition || !transition.from.includes(lifecycle.status)) {
    const error = new Error(`Переход lifecycle "${lifecycle.status}" → "${normalizedAction}" запрещён`)
    error.code = 'INVALID_CAMPAIGN_TRANSITION'
    throw error
  }
  if (normalizedAction === 'complete' && state?.mechanics?.combat?.active) {
    const error = new Error('Нельзя завершить кампанию во время активного боя')
    error.code = 'CAMPAIGN_COMBAT_ACTIVE'
    throw error
  }
  if (normalizedAction === 'fail' && (actorId !== 'system' || state?.mechanics?.death?.campaign_status !== 'party_defeated')) {
    const error = new Error('Провал кампании фиксирует только сервер после подтверждённой гибели всего отряда')
    error.code = 'CAMPAIGN_FAILURE_NOT_CONFIRMED'
    throw error
  }
  const epilogueFacts = ['complete', 'fail'].includes(normalizedAction)
    ? collectEpilogueFacts(state, { outcome: normalizedAction === 'fail' ? 'failed' : 'completed' })
    : null
  const epilogue = epilogueFacts
    ? buildDeterministicEpilogue(state, { outcome: epilogueFacts.outcome })
    : null
  return {
    event_type: transition.event,
    actor_id: actorId ?? null,
    target_ids: [],
    visibility: 'party',
    source_rule_ids: [],
    ruling_id: null,
    payload: {
      status: transition.to,
      reason: String(reason || normalizedAction).slice(0, 240),
      changed_by: actorId ?? null,
      occurred_at: now,
      ...(epilogue ? { epilogue } : {}),
      ...(epilogueFacts ? { epilogue_fact_keys: epilogueFacts.fact_keys } : {}),
    },
  }
}

export function buildDeterministicEpilogue(state, outcomeOrOptions = undefined) {
  const facts = collectEpilogueFacts(state, outcomeOrOptions)
  const living = facts.heroes.filter((hero) => hero.status === 'living').map((hero) => hero.name)
  const fallen = facts.heroes.filter((hero) => hero.status === 'dead').map((hero) => hero.name)
  const questOutcomes = facts.quests.map((quest) => {
    const resolution = quest.status === 'completed' ? 'завершён' : 'провален'
    const summary = withoutTerminalPunctuation(quest.summary, 240)
    return `«${quest.title}» ${resolution}${summary ? `: ${summary}` : ''}`
  })
  const promiseOutcomes = facts.promises.map((promise) => {
    const resolution = promise.status === 'fulfilled' ? 'исполнено' : 'нарушено'
    return `обещание ${promise.npc_name} «${withoutTerminalPunctuation(promise.text, 220)}» ${resolution}`
  })
  const confirmedWorldOutcomes = [...facts.npc_fates, ...facts.world_facts]
    .map((fact) => withoutTerminalPunctuation(fact.summary, 240))
    .filter(Boolean)
  const tierLabels = {
    reviled: 'ненавидит отряд',
    distrusted: 'не доверяет отряду',
    unknown: 'сохраняет нейтралитет',
    respected: 'уважает отряд',
    honoured: 'чтит отряд',
  }
  const reputationOutcomes = facts.faction_reputations
    .map((entry) => `${entry.faction_name} ${tierLabels[entry.tier] || 'помнит отряд'}`)
  const visited = facts.visited_locations.map((entry) => entry.name)

  return [
    facts.outcome === 'failed'
      ? `История «${facts.campaign}» завершилась поражением.`
      : `История «${facts.campaign}» завершена.`,
    facts.final_objective ? `Последняя цель: ${facts.final_objective}.` : '',
    facts.final_location ? `Финальная глава развернулась в месте «${facts.final_location}».` : '',
    questOutcomes.length ? `Итоги заданий: ${questOutcomes.join('; ')}.` : '',
    promiseOutcomes.length ? `Мир запомнил: ${promiseOutcomes.join('; ')}.` : '',
    confirmedWorldOutcomes.length ? `Подтверждённые последствия: ${confirmedWorldOutcomes.join('; ')}.` : '',
    reputationOutcomes.length ? `Слава отряда: ${reputationOutcomes.join('; ')}.` : '',
    visited.length ? `Путь пролёг через: ${visited.join(', ')}.` : '',
    living.length ? `В летописи мира остаются: ${living.join(', ')}.` : 'В летописи осталась память о павших героях.',
    fallen.length && living.length ? `Память хранит павших: ${fallen.join(', ')}.` : '',
  ].filter(Boolean).join(' ').slice(0, 8_000)
}

export function campaignCanAutoComplete(state = {}) {
  const lifecycle = normalizeCampaignLifecycle(state?.mechanics?.campaign_lifecycle, state?.mechanics?.death?.campaign_status)
  if (lifecycle.status !== 'active' || state?.mechanics?.combat?.active) return false
  if (state?.autonomy?.pacing?.phase !== 'climax') return false
  const quests = Array.isArray(state?.worldMemory?.quests) ? state.worldMemory.quests : []
  // Bootstrap creates a scene-support quest (`quest:chapter:*`) alongside the
  // campaign premise quest. The first non-scene quest is the main thread; old
  // streams without that distinction fall back to their first quest.
  const mainQuest = quests.find((quest) => !String(quest.id || '').startsWith('quest:chapter:')) ?? quests[0]
  if (!mainQuest || !['completed', 'failed'].includes(mainQuest.status)) return false
  return campaignArcPlan(state) ? campaignArcClimaxSatisfied(state) : true
}

/**
 * Готова ли кампания сменить арку вместо того, чтобы закончиться. Условие то
 * же самое, что и у финала: главная нить арки разрешена в подтверждённой
 * кульминации. Отличается только выбор стола — закрыть кампанию или взять
 * следующую арку теми же героями. Разные исходы одного момента, поэтому и
 * предикат один: `campaignCanAutoComplete` плюс запас в цепочке.
 */
export function campaignCanAdvanceArc(state = {}) {
  if (!campaignCanAutoComplete(state)) return false
  const plan = campaignArcPlan(state)
  // Цепочка держится на плане арки: без него сервер не знает ни номера текущей
  // арки, ни того, чем закончилась предыдущая. Старое сохранение доигрывает
  // как раньше и заканчивается финалом.
  return Boolean(plan) && plan.arc_number < MAX_CAMPAIGN_ARCS
}

/**
 * Что переезжает в следующую арку. Список именно перечисляется, а не выводится
 * «всё, кроме»: молчаливый перенос неизвестного поля — это способ протащить в
 * новую арку закрытую главу или чужой encounter.
 */
export function campaignArcCarryOver(state = {}) {
  const facts = collectEpilogueFacts(state, { outcome: 'completed' })
  const quests = Array.isArray(state?.worldMemory?.quests) ? state.worldMemory.quests : []
  return {
    heroes: facts.heroes.filter((hero) => hero.status === 'living').map((hero) => hero.hero_id).filter(Boolean),
    fallen_heroes: facts.heroes.filter((hero) => hero.status === 'dead').map((hero) => hero.hero_id).filter(Boolean),
    // Незакрытые нити и обещания — главная причина, по которой стол
    // возвращается: «нас узнают в городе» держится именно на них.
    open_quest_ids: quests
      .filter((quest) => !RESOLVED_QUEST_STATUSES.has(clean(quest?.status, 30))
        && !String(quest?.id ?? '').startsWith('quest:chapter:'))
      .map((quest) => clean(quest.id, 120))
      .filter(Boolean)
      .slice(0, 64),
    open_promise_npc_ids: [...new Set((Array.isArray(state?.social?.promises) ? state.social.promises : [])
      .filter((promise) => !RESOLVED_PROMISE_STATUSES.has(clean(promise?.status, 30)))
      .map((promise) => clean(promise?.npc_id, 120))
      .filter(Boolean))].slice(0, 64),
    reputation: facts.faction_reputations
      .map((entry) => ({ faction_id: entry.faction_id, tier: entry.tier }))
      .slice(0, 32),
    visited_locations: facts.visited_locations.map((entry) => clean(entry?.name ?? entry, 180)).filter(Boolean).slice(0, 64),
  }
}

export function buildEpilogueNarrationBrief(state = {}, outcomeOrOptions = undefined) {
  const facts = collectEpilogueFacts(state, outcomeOrOptions)
  const living = facts.heroes.filter((hero) => hero.status === 'living').map((hero) => hero.name)
  const fallen = facts.heroes.filter((hero) => hero.status === 'dead').map((hero) => hero.name)
  return {
    visible_events: [
      ...facts.quests.map((quest) => ({
      event_type: 'QuestResolved',
      payload: {
        quest_id: quest.quest_id,
        title: quest.title,
        outcome: quest.status === 'completed' ? 'success' : 'failure',
        summary: quest.summary,
      },
      })),
      ...facts.promises.map((promise) => ({
        event_type: 'NpcPromiseResolved',
        payload: {
          promise_id: promise.promise_id,
          npc_id: promise.npc_id,
          npc_name: promise.npc_name,
          status: promise.status,
          text: promise.text,
        },
      })),
    ],
    visible_state_changes: [{
      campaign: facts.campaign,
      outcome: facts.outcome,
      chapter: Math.max(1, Number(state.adventure?.chapter) || 1),
      final_location: facts.final_location,
      final_objective: facts.final_objective,
      living_heroes: living,
      fallen_heroes: fallen,
      confirmed_fact_keys: facts.fact_keys,
    }],
    known_environment: {
      confirmed_facts: [...facts.npc_fates, ...facts.world_facts].map((fact) => ({
        fact_id: fact.fact_id,
        subject_id: fact.subject_id,
        subject_kind: fact.subject_kind,
        subject_name: fact.subject_name,
        predicate: fact.predicate,
        summary: fact.summary,
      })),
      resolved_promises: facts.promises,
      faction_reputations: facts.faction_reputations,
      visited_locations: facts.visited_locations,
      confirmed_scene_history: (Array.isArray(state.adventure?.history) ? state.adventure.history : [])
        .filter(visibleToParty)
        .slice(-12)
        .map((entry) => ({
        chapter: Math.max(1, Number(entry.chapter) || 1),
        location: clean(entry.location, 180),
        outcome: clean(entry.outcome, 500),
        })),
    },
    permitted_npc_reactions: [],
    narration_constraints: [
      'epilogue',
      'confirmed-events-only',
      'no-unconfirmed-world-changes',
      'do-not-decide-for-player-heroes',
    ],
  }
}
