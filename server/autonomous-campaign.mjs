import { createHash } from 'node:crypto'

import { ENCOUNTER_THEMES } from './encounter-assembler.mjs'

export { serverEncounterLoot } from './loot-tables.mjs'
export { freezeEncounterOutcomePlan, serverRewardForEncounter } from './encounter-rewards.mjs'

export const DIRECTOR_INTENT_VERSION = 'skazanie:director-intent-v1'
export const DIRECTOR_INTENT_TYPES = Object.freeze([
  'continue_exploration',
  'open_social_scene',
  'advance_quest_clock',
  'request_encounter',
  'end_scene',
  'offer_next_hook',
])

const INTENT_TYPES = new Set(DIRECTOR_INTENT_TYPES)
const DIFFICULTIES = new Set(['easy', 'medium', 'hard', 'deadly'])
/**
 * Список тем был записан здесь вторым, руками, и разошёлся с реальным: у
 * EncounterAssembler их было пять, а Директор мог попросить четыре — `generic`
 * оставался недостижимым, хотя ростер под него существовал. Теперь источник
 * один, и новая тема в сборщике сразу доступна Директору.
 */
const THEMES = new Set(ENCOUNTER_THEMES)
const TOP_LEVEL_FIELDS = new Set(['version', 'type', 'theme', 'difficulty', 'quest_id', 'npc_id', 'hook', 'destination', 'reason'])
/**
 * Написание ключа значения не имеет: `max_hp`, `maxHp` и `MAX-HP` — одно и то
 * же поле, и модель придёт к верблюжьему написанию не реже, чем к змеиному.
 * Поэтому и список, и проверяемый ключ приводятся к одному виду.
 */
const mechanicalKey = (value) => String(value).toLowerCase().replace(/[_-]/g, '')

const FORBIDDEN_MECHANICAL_FIELDS = new Set([
  'hp', 'max_hp', 'dc', 'difficulty_class', 'roll', 'dice', 'price', 'quantity', 'xp', 'xp_budget',
  'loot', 'coordinates', 'x', 'y', 'damage', 'armor', 'initiative', 'reputation_delta', 'amount',
].map(mechanicalKey))

export class DirectorIntentError extends Error {
  constructor(message, code = 'DIRECTOR_INTENT_INVALID') {
    super(message)
    this.name = 'DirectorIntentError'
    this.code = code
  }
}
const clean = (value, maximum = 240) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const clone = (value) => structuredClone(value)
const safeId = (value, label) => {
  const result = clean(value, 120)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(result)) throw new DirectorIntentError(`${label} должен быть безопасным идентификатором`, 'DIRECTOR_INTENT_INVALID_ID')
  return result
}

function assertNoMechanics(value, path = '$', seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return
  if (seen.has(value)) throw new DirectorIntentError('Director intent содержит цикл', 'DIRECTOR_INTENT_INVALID_SHAPE')
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_MECHANICAL_FIELDS.has(mechanicalKey(key))) {
      throw new DirectorIntentError(`Director не может задавать механическое поле ${path}.${key}`, 'DIRECTOR_MECHANICS_FORBIDDEN')
    }
    assertNoMechanics(child, `${path}.${key}`, seen)
  }
  seen.delete(value)
}

export function normalizeDirectorIntent(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DirectorIntentError('Director intent должен быть объектом')
  assertNoMechanics(input)
  const unexpected = Object.keys(input).filter((key) => !TOP_LEVEL_FIELDS.has(key))
  if (unexpected.length) throw new DirectorIntentError(`Director intent содержит неизвестные поля: ${unexpected.join(', ')}`, 'DIRECTOR_INTENT_UNKNOWN_FIELD')
  if (input.version != null && input.version !== DIRECTOR_INTENT_VERSION) throw new DirectorIntentError('Director intent использует неподдерживаемую версию контракта', 'DIRECTOR_INTENT_VERSION_UNSUPPORTED')
  const type = clean(input.type, 40)
  if (!INTENT_TYPES.has(type)) throw new DirectorIntentError('Director предложил неизвестное намерение', 'DIRECTOR_INTENT_NOT_ALLOWED')
  const intent = { version: DIRECTOR_INTENT_VERSION, type }
  if (type === 'request_encounter') {
    if (!THEMES.has(input.theme)) throw new DirectorIntentError('Тема встречи не входит в server allowlist', 'DIRECTOR_ENCOUNTER_THEME_NOT_ALLOWED')
    if (!DIFFICULTIES.has(input.difficulty)) throw new DirectorIntentError('Сложность встречи не входит в server allowlist', 'DIRECTOR_ENCOUNTER_DIFFICULTY_NOT_ALLOWED')
    intent.theme = input.theme
    intent.difficulty = input.difficulty
  }
  if (type === 'advance_quest_clock') intent.quest_id = safeId(input.quest_id, 'quest_id')
  if (type === 'open_social_scene' && input.npc_id != null) intent.npc_id = safeId(input.npc_id, 'npc_id')
  if (type === 'offer_next_hook') intent.hook = clean(input.hook, 300)
  if (type === 'end_scene') intent.destination = clean(input.destination, 160)
  if (input.reason != null) intent.reason = clean(input.reason, 240)
  return Object.freeze(intent)
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)
}

function firstOpenQuest(state) {
  return (state.worldMemory?.quests ?? []).find((quest) => quest.status === 'active' && !quest.clock?.triggered) ?? null
}

// Здесь до 2026-07-27 лежал второй перевод намерения Директора в команды —
// `commandsForDirectorIntent`. Его не импортировал никто: намерение исполняет
// `autonomous-orchestrator.mjs`. Разойтись с живым путём он успел настолько,
// что писал команды `RecordDirectorIntent`, `OfferNextHook`, `OpenSocialScene`
// и `CompleteScene`, которых в движке нет вовсе. Сторож против повторения —
// тест «автономный слой не умеет писать команду, которой движок не знает».

export function normalizeAutonomyState(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const reputations = Object.fromEntries(Object.entries(source.reputations ?? {}).slice(0, 200)
    .map(([id, value]) => [clean(id, 120), Math.max(-100, Math.min(100, Number.isSafeInteger(Number(value)) ? Number(value) : 0))]).filter(([id]) => id))
  return {
    schema_version: 3,
    director_history: (Array.isArray(source.director_history) ? clone(source.director_history) : []).slice(-500),
    director_outcomes: (Array.isArray(source.director_outcomes) ? clone(source.director_outcomes) : []).slice(-500),
    hooks: (Array.isArray(source.hooks) ? clone(source.hooks) : []).slice(-100),
    transitions: (Array.isArray(source.transitions) ? clone(source.transitions) : []).slice(-100),
    encounter_outcomes: (Array.isArray(source.encounter_outcomes) ? clone(source.encounter_outcomes) : []).slice(-200),
    reputations,
    witness_graph: (Array.isArray(source.witness_graph) ? clone(source.witness_graph) : []).slice(-500),
    npc_schedules: source.npc_schedules && typeof source.npc_schedules === 'object' && !Array.isArray(source.npc_schedules) ? clone(source.npc_schedules) : {},
    npc_actions: (Array.isArray(source.npc_actions) ? clone(source.npc_actions) : []).slice(-500),
    pacing: source.pacing && typeof source.pacing === 'object' && !Array.isArray(source.pacing)
      ? {
          beat: Math.max(0, Number(source.pacing.beat) || 0),
          phase: ['breather', 'development', 'escalation', 'climax'].includes(source.pacing.phase) ? source.pacing.phase : 'breather',
          tension: Math.max(0, Math.min(100, Number(source.pacing.tension) || 0)),
          last_intent_type: clean(source.pacing.last_intent_type, 40),
        }
      : { beat: 0, phase: 'breather', tension: 0, last_intent_type: '' },
    travel_history: (Array.isArray(source.travel_history) ? clone(source.travel_history) : []).slice(-200),
    downtime_history: (Array.isArray(source.downtime_history) ? clone(source.downtime_history) : []).slice(-200),
    random_encounters: (Array.isArray(source.random_encounters) ? clone(source.random_encounters) : []).slice(-200),
    applied_consequences: [...new Set((Array.isArray(source.applied_consequences) ? source.applied_consequences : []).map((item) => clean(item, 160)).filter(Boolean))].slice(-2_000),
    admin_interventions: Math.max(0, Number.isSafeInteger(Number(source.admin_interventions)) ? Number(source.admin_interventions) : 0),
  }
}

/**
 * Добыча: тематический предмет плюс зелья по сложности.
 *
 * Прежняя таблица выдавала один и тот же предмет на всю кампанию — факел за
 * лёгкую встречу, зелье за среднюю, два за тяжёлую, — и на тридцатой сессии
 * это переставало быть наградой. Тематическая часть выбирается детерминированно
 * по `encounter_id`: разные встречи дают разное, а replay того же события даёт
 * тот же предмет.
 *
 * Все `catalog_id` обязаны существовать в `ITEM_CATALOG` и входить в явный
 * loot allowlist (`server/item-catalog.mjs`): иначе добыча не может быть
 * материализована авторитетно. Сторож ссылочной целостности —
 * `test/encounter-loot-tables.test.mjs`.
 */
export function serverReputationDelta({ severity = 'minor', outcome = 'neutral' } = {}) {
  const table = { helpful: { minor: 2, major: 5 }, harmful: { minor: -2, major: -5 }, neutral: { minor: 0, major: 0 } }
  return table[outcome]?.[severity] ?? 0
}

export function scheduledNpcEvents(state = {}, elapsedMinutes = 0) {
  const autonomy = normalizeAutonomyState(state.autonomy)
  const start = Math.max(0, Number(state.mechanics?.world_time?.elapsed_minutes) || 0)
  const end = start + Math.max(0, Number(elapsedMinutes) || 0)
  const events = []
  for (const [npcId, schedule] of Object.entries(autonomy.npc_schedules).sort(([a], [b]) => a.localeCompare(b))) {
    for (const entry of (Array.isArray(schedule?.entries) ? schedule.entries : [])) {
      const at = Math.max(0, Number(entry.at_minutes) || 0)
      const key = `schedule:${npcId}:${at}:${clean(entry.action, 80)}`
      if (at <= start || at > end || autonomy.applied_consequences.includes(key)) continue
      events.push({ event_type: 'NpcScheduledActionExecuted', payload: {
        consequence_key: key, npc_id: npcId, at_minutes: at, action: clean(entry.action, 80),
        location: clean(entry.location, 180), summary: clean(entry.summary, 300),
      }, target_ids: [npcId], visibility: entry.visibility === 'public' ? 'public' : 'party' })
    }
  }
  return events
}

export function ensureAvailableHook(state = {}, source = 'fail-safe') {
  const open = (state.autonomy?.hooks ?? []).find((hook) => hook.status === 'available')
  if (open) return null
  const quest = firstOpenQuest(state)
  const text = quest ? `Продолжить: ${quest.title}` : `Исследовать ${clean(state.scene?.location, 120) || 'окрестности'}`
  return { id: `hook-${digest({ source, text, version: state.state_version })}`, text, status: 'available', source }
}

export function applyAutonomyEvent(input, event) {
  const autonomy = normalizeAutonomyState(input)
  const payload = event.payload ?? {}
  if (event.event_type === 'DirectorIntentRecorded') autonomy.director_history.push(clone(payload))
  if (event.event_type === 'DirectorIntentOutcomeRecorded') autonomy.director_outcomes.push(clone(payload))
  if (event.event_type === 'CampaignPacingAdvanced') autonomy.pacing = {
    beat: Math.max(0, Number(payload.beat) || autonomy.pacing.beat),
    phase: ['breather', 'development', 'escalation', 'climax'].includes(payload.phase) ? payload.phase : autonomy.pacing.phase,
    tension: Math.max(0, Math.min(100, Number(payload.tension_after) || 0)),
    last_intent_type: clean(payload.intent_type, 40),
  }
  if (event.event_type === 'TravelResolved') autonomy.travel_history.push(clone(payload))
  if (event.event_type === 'DowntimeResolved') autonomy.downtime_history.push(clone(payload))
  if (event.event_type === 'RandomEncounterTriggered') autonomy.random_encounters.push(clone(payload))
  if (event.event_type === 'NextHookOffered') autonomy.hooks = [...autonomy.hooks.filter((hook) => hook.id !== payload.hook?.id), clone(payload.hook)]
  if (event.event_type === 'TransitionUnlocked') autonomy.transitions.push(clone(payload.transition))
  if (event.event_type === 'EncounterOutcomeRecorded') autonomy.encounter_outcomes.push(clone(payload))
  if (event.event_type === 'FactionReputationAdjusted') {
    const id = clean(payload.faction_id, 120)
    autonomy.reputations[id] = Math.max(-100, Math.min(100, (autonomy.reputations[id] ?? 0) + Number(payload.delta || 0)))
  }
  if (event.event_type === 'WitnessConsequencePropagated') autonomy.witness_graph.push(clone(payload))
  if (event.event_type === 'NpcScheduleRegistered') autonomy.npc_schedules[clean(payload.npc_id, 120)] = clone(payload.schedule)
  if (event.event_type === 'NpcScheduledActionExecuted') autonomy.npc_actions.push(clone(payload))
  if (payload.consequence_key) autonomy.applied_consequences = [...new Set([...autonomy.applied_consequences, clean(payload.consequence_key, 160)])].slice(-2_000)
  return normalizeAutonomyState(autonomy)
}
