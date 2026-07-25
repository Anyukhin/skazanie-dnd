import { createHash } from 'node:crypto'

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
  open_social_scene: -6,
  advance_quest_clock: 14,
  request_encounter: 24,
  end_scene: -18,
  offer_next_hook: -4,
})

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
  const recoveryDiscount = recentEncounterResolved(state) ? 35 : 0
  const riskScore = clamp(pacingTension + (wilderness ? 20 : 5) + activeQuestPressure - recoveryDiscount, 0, 100)
  const threshold = clamp(riskScore - 35, 0, 55)
  const roll = (entropy >>> 8) % 100
  const randomEncounter = riskScore >= 65 && roll < threshold
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
