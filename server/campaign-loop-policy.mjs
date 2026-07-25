import { createHash } from 'node:crypto'

import { normalizeDirectorIntent } from './autonomous-campaign.mjs'

const clean = (value, maximum = 240) => String(value ?? '')
  .normalize('NFKC')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, maximum)

const hashNumber = (value) => Number.parseInt(
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 8),
  16,
)

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, Number(value) || 0))

const PHASE_BY_TENSION = Object.freeze([
  [75, 'climax'],
  [50, 'escalation'],
  [25, 'development'],
  [0, 'breather'],
])

const PACING_DELTAS = Object.freeze({
  continue_exploration: 12,
  open_social_scene: 8,
  advance_quest_clock: 14,
  request_encounter: 24,
  end_scene: -30,
  offer_next_hook: 6,
})

const PHASE_INTENT_TYPES = Object.freeze({
  breather: Object.freeze(['continue_exploration', 'open_social_scene', 'advance_quest_clock', 'offer_next_hook']),
  development: Object.freeze(['advance_quest_clock', 'continue_exploration', 'open_social_scene', 'request_encounter', 'offer_next_hook']),
  escalation: Object.freeze(['advance_quest_clock', 'request_encounter', 'end_scene', 'continue_exploration']),
  climax: Object.freeze(['advance_quest_clock', 'end_scene', 'request_encounter']),
})

function currentPhase(state = {}) {
  const stored = clean(state.autonomy?.pacing?.phase, 30)
  if (PHASE_INTENT_TYPES[stored]) return stored
  const tension = clamp(state.autonomy?.pacing?.tension, 0, 100)
  return PHASE_BY_TENSION.find(([threshold]) => tension >= threshold)?.[1] ?? 'breather'
}

function currentChapterIntents(state = {}) {
  const history = Array.isArray(state.autonomy?.director_history) ? state.autonomy.director_history : []
  const intents = history.map((entry) => entry?.intent ?? entry).filter((entry) => entry && typeof entry === 'object')
  const lastSceneEnd = intents.map((intent) => intent.type).lastIndexOf('end_scene')
  return intents.slice(lastSceneEnd + 1)
}

function firstOpenQuest(state = {}) {
  return (state.worldMemory?.quests ?? []).find((quest) => quest.status === 'active' && !quest.clock?.triggered) ?? null
}

function availableIntentTypes(state = {}) {
  const phase = currentPhase(state)
  const openQuest = firstOpenQuest(state)
  const encounter = state.mechanics?.encounter
  const encounterOutcomes = Array.isArray(state.autonomy?.encounter_outcomes) ? state.autonomy.encounter_outcomes : []
  const encounterResolved = encounter?.status === 'ended'
    && encounterOutcomes.some((entry) => entry.encounter_id === encounter.id)
  const quests = state.worldMemory?.quests ?? []
  const chapter = Math.max(1, Number(state.adventure?.chapter) || 1)
  const chapterQuest = quests.find((quest) => String(quest.id) === `quest:chapter:${chapter}`)
  const chapterQuestResolved = Boolean(chapterQuest && ['completed', 'failed'].includes(chapterQuest.status))
  const mainQuest = quests.find((quest) => !String(quest.id || '').startsWith('quest:chapter:')) ?? quests[0]
  const mainQuestOpen = Boolean(mainQuest && ['active', 'hidden'].includes(mainQuest.status))
  const chapterHistory = currentChapterIntents(state)
  const peacefulSecondChapterExit = chapter === 2
    && encounterOutcomes.length > 0
    && chapterHistory.some((intent) => intent.type === 'advance_quest_clock')
  const endSceneAvailable = encounterResolved
    || peacefulSecondChapterExit
    || (chapterQuestResolved && !mainQuestOpen)
  const phaseTypes = endSceneAvailable
    ? [...new Set([...PHASE_INTENT_TYPES[phase], 'end_scene'])]
    : PHASE_INTENT_TYPES[phase]
  const types = phaseTypes.filter((type) => {
    if (type === 'advance_quest_clock') return Boolean(openQuest)
    if (type === 'request_encounter') {
      return !state.mechanics?.combat?.active
        && !encounter
        && !(state.enemies ?? []).some((enemy) => enemy.alive !== false && Number(enemy.hp ?? 1) > 0)
    }
    if (type === 'end_scene') return !state.mechanics?.combat?.active && endSceneAvailable
    return true
  })
  return { phase, openQuest, types }
}

function intentForType(type, state, openQuest) {
  if (type === 'open_social_scene') {
    const location = clean(state.scene?.location, 180).toLocaleLowerCase('ru')
    const npc = (state.social?.npcs ?? []).find((entry) => entry.available !== false
      && (!entry.location || !location || clean(entry.location, 180).toLocaleLowerCase('ru') === location))
    return normalizeDirectorIntent({
      type,
      ...(npc?.id ? { npc_id: npc.id } : {}),
      reason: 'Серверная политика темпа открывает содержательную социальную сцену.',
    })
  }
  if (type === 'advance_quest_clock') {
    return normalizeDirectorIntent({
      type,
      quest_id: openQuest.id,
      reason: 'Серверная политика темпа продвигает подтверждённую активную цель.',
    })
  }
  if (type === 'request_encounter') {
    return normalizeDirectorIntent({
      type,
      theme: 'beasts',
      difficulty: currentPhase(state) === 'climax' ? 'hard' : 'medium',
      reason: 'Серверная политика темпа требует препятствия, разрешаемого правилами.',
    })
  }
  if (type === 'end_scene') {
    const chapter = Math.max(1, Number(state.adventure?.chapter) || 1)
    return normalizeDirectorIntent({
      type,
      destination: `След главы ${chapter + 1}`,
      reason: 'Подтверждённая развязка позволяет перейти к следующей главе.',
    })
  }
  if (type === 'offer_next_hook') {
    return normalizeDirectorIntent({
      type,
      hook: clean(state.scene?.objective, 300) || 'Найти следующую подтверждаемую зацепку',
      reason: 'Сервер сохраняет доступный следующий шаг.',
    })
  }
  return normalizeDirectorIntent({
    type: 'continue_exploration',
    reason: 'Серверная политика темпа требует нового наблюдаемого шага.',
  })
}

/**
 * Server-owned Director boundary. The model may propose only a bounded intent;
 * phase compatibility and anti-stall replacement are decided here.
 */
export function authorizeDirectorIntent(state = {}, proposedIntent = {}) {
  const proposed = normalizeDirectorIntent(proposedIntent)
  const availability = availableIntentTypes(state)
  const history = currentChapterIntents(state)
  const lastType = clean(history.at(-1)?.type, 40)
  const lastOutcome = (state.autonomy?.director_outcomes ?? []).at(-1) ?? null
  const stalledType = lastOutcome?.state_changed === false ? clean(lastOutcome.intent_type, 40) : ''
  const blocked = new Set([lastType, stalledType].filter(Boolean))
  const allowed = availability.types.filter((type) => !blocked.has(type))
  const candidates = allowed.length ? allowed : availability.types
  const accepted = candidates.includes(proposed.type)
  const replacementType = accepted ? proposed.type : candidates[0] ?? 'continue_exploration'
  const intent = accepted ? proposed : intentForType(replacementType, state, availability.openQuest)
  return {
    intent,
    proposed_intent: proposed,
    replaced: !accepted,
    phase: availability.phase,
    allowed_types: availability.types,
    reason: accepted
      ? 'intent_allowed'
      : blocked.has(proposed.type)
        ? 'anti_stall_replacement'
        : 'phase_incompatible_replacement',
    policy: 'director-intent-policy-v1',
  }
}

export function directorProgressFingerprint(state = {}) {
  return createHash('sha256').update(JSON.stringify({
    chapter: Math.max(1, Number(state.adventure?.chapter) || 1),
    scene: {
      location: clean(state.scene?.location, 180),
      objective: clean(state.scene?.objective, 300),
      revealed_cells: (state.scene?.cells ?? []).filter((cell) => cell.revealed === true).length,
    },
    quests: (state.worldMemory?.quests ?? []).map((quest) => ({
      id: clean(quest.id, 120),
      status: clean(quest.status, 30),
      current: Number(quest.clock?.current) || 0,
      triggered: quest.clock?.triggered === true,
    })),
    encounter: state.mechanics?.encounter ? {
      id: clean(state.mechanics.encounter.id, 120),
      status: clean(state.mechanics.encounter.status, 40),
      outcome: clean(state.mechanics.encounter.outcome, 80),
    } : null,
    lifecycle: clean(state.mechanics?.campaign_lifecycle?.status, 30),
  })).digest('hex').slice(0, 24)
}

export function pacingForDirectorIntent(state = {}, intent = {}) {
  const previous = state.autonomy?.pacing ?? {}
  const before = clamp(previous.tension, 0, 100)
  const delta = PACING_DELTAS[intent.type] ?? 0
  const after = clamp(before + delta, 0, 100)
  const phase = PHASE_BY_TENSION.find(([threshold]) => after >= threshold)?.[1] ?? 'breather'
  return {
    beat: Math.max(0, Number(previous.beat) || 0) + 1,
    phase,
    tension_before: before,
    tension_after: after,
    delta,
    intent_type: clean(intent.type, 40),
    policy: 'campaign-pacing-v1',
  }
}

function recentEncounterResolved(state = {}) {
  const outcomes = state.autonomy?.encounter_outcomes ?? []
  const travels = state.autonomy?.travel_history ?? []
  return outcomes.length > travels.length
}

export function planServerTravel(state = {}, {
  campaignId = '',
  destination = '',
  idempotencyKey = '',
} = {}) {
  const from = clean(state.scene?.location, 180) || 'Текущая локация'
  const to = clean(destination, 180) || `${from} — следующая сцена`
  const chapter = Math.max(1, Number(state.adventure?.chapter) || 1)
  const fingerprint = `${campaignId}:${idempotencyKey}:${from}:${to}:${chapter}`
  const entropy = hashNumber(fingerprint)
  const sceneKind = clean(state.scene?.scene_kind, 40).toLowerCase()
  const wilderness = sceneKind === 'wilderness'
    || /(лес|тракт|дорог|пустош|болот|гор|ущель|перевал|пещер|road|forest|wild|marsh|mountain)/iu.test(`${from} ${to}`)
  const distanceBand = ['near', 'regional', 'far'][entropy % 3]
  const baseMinutes = { near: 45, regional: 120, far: 240 }[distanceBand]
  const durationMinutes = baseMinutes + (wilderness ? 30 : 0)
  const pacingTension = clamp(state.autonomy?.pacing?.tension, 0, 100)
  const activeQuestPressure = (state.worldMemory?.quests ?? []).some((quest) => (
    quest.status === 'active' && Number(quest.clock?.current) >= Math.max(1, Number(quest.clock?.max) - 2)
  )) ? 15 : 0
  const afterEncounterRecovery = recentEncounterResolved(state)
  const recoveryDiscount = afterEncounterRecovery ? 35 : 0
  const riskScore = clamp(pacingTension + (wilderness ? 20 : 5) + activeQuestPressure - recoveryDiscount, 0, 100)
  const threshold = clamp(riskScore - 35, 0, 55)
  const roll = (entropy >>> 8) % 100
  const randomEncounter = !afterEncounterRecovery && riskScore >= 65 && roll < threshold
  const themeOptions = /(кладбищ|склеп|руин|grave|crypt|ruin)/iu.test(`${from} ${to}`)
    ? ['undead', 'raiders']
    : wilderness
      ? ['beasts', 'goblinoids', 'raiders']
      : ['raiders', 'goblinoids']
  const theme = themeOptions[(entropy >>> 16) % themeOptions.length]
  const difficulty = riskScore >= 90 ? 'hard' : riskScore >= 72 ? 'medium' : 'easy'
  return {
    travel_id: `travel-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 20)}`,
    from,
    to,
    distance_band: distanceBand,
    duration_minutes: durationMinutes,
    risk_score: riskScore,
    random_encounter: randomEncounter,
    encounter: randomEncounter ? { theme, difficulty } : null,
    policy: 'server-travel-v1',
  }
}

const NPC_NAMES = Object.freeze([
  'Арина Медный Лист',
  'Борен Серый Плащ',
  'Вея Тихая Река',
  'Гален Фонарщик',
  'Дара Каменная Пыль',
  'Еремей Следопыт',
])

const NPC_ROLES = Object.freeze([
  'местный проводник',
  'очевидец',
  'хранитель дороги',
  'ремесленник',
  'посыльный',
  'исследователь руин',
])

export function assembleSocialNpc(state = {}, {
  campaignId = '',
  requestedId = '',
  idempotencyKey = '',
} = {}) {
  const location = clean(state.scene?.location, 180) || 'Текущая локация'
  const entropy = hashNumber(`${campaignId}:${idempotencyKey}:${location}:${requestedId}`)
  const name = NPC_NAMES[entropy % NPC_NAMES.length]
  const role = NPC_ROLES[(entropy >>> 8) % NPC_ROLES.length]
  const generatedId = `npc-${createHash('sha256').update(`${campaignId}:${location}:${name}`).digest('hex').slice(0, 16)}`
  const knownFactIds = (state.worldMemory?.facts ?? [])
    .filter((fact) => fact.status === 'active' && ['public', 'party'].includes(fact.visibility))
    .map((fact) => clean(fact.id, 120))
    .filter(Boolean)
    .slice(0, 20)
  const faction = (state.worldMemory?.entities ?? []).find((entity) => entity.kind === 'faction')
  return {
    id: clean(requestedId, 120) || generatedId,
    name,
    role,
    location,
    public_summary: `${name} — ${role}, которого можно встретить в локации «${location}».`,
    voice: 'Говорит ясно, отвечает только на то, что действительно знает.',
    goals: ['Сохранить безопасность своей общины', 'Понять намерения отряда'],
    beliefs: ['Поступки важнее обещаний'],
    known_fact_ids: knownFactIds,
    visibility: 'party',
    available: true,
    tags: faction?.id ? [`faction:${clean(faction.id, 120)}`] : [],
    schedule: [],
    inventory: [],
  }
}

export function completedDowntime(state = {}, {
  kind = 'long_rest',
  durationMinutes = 480,
  reason = 'post_encounter_recovery',
} = {}) {
  const partyIds = new Set((state.partyMemberIds ?? []).map(String))
  const participants = (state.players ?? [])
    .filter((hero) => partyIds.has(String(hero.id)) && state.mechanics?.death?.heroes?.[hero.id]?.status !== 'dead')
    .map((hero) => String(hero.id))
    .sort()
  return {
    downtime_id: `downtime-${createHash('sha256').update(JSON.stringify({
      campaign: state.sessionCode ?? state.campaign_id,
      at: state.mechanics?.world_time?.elapsed_minutes,
      participants,
      reason,
    })).digest('hex').slice(0, 20)}`,
    kind,
    duration_minutes: Math.max(0, Number(durationMinutes) || 0),
    participant_ids: participants,
    reason: clean(reason, 120),
    policy: 'server-downtime-v1',
  }
}
