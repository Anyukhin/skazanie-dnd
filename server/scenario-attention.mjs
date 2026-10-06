// @ts-check
/**
 * Внимание главного противника сценария — «Внимание Саргата» в Асстохане
 * (`docs/astohan-scenario.md`, раздел 7).
 *
 * Счётчик не хранится отдельным событием, а выводится редьюсером из журнала,
 * как летопись поступков и реестр пленных: место берётся из сцены в момент
 * события, поэтому replay даёт тот же счёт. Поднимают его:
 *
 * - **+1** — открытый расспрос о драконе в поселении, где у него осведомители
 *   (`watched_location_ids`): разговор с NPC (`NpcConversationRecorded`) или
 *   свободное социальное действие (`RulingRecorded`), в тексте которых есть
 *   основа темы. Не больше одного раза за визит в место: одна деревня — один
 *   слух. Обман и скрытность — тихое расследование, счётчик не растёт;
 * - **+2** — бой в таком поселении (`EncounterCreated`): громкое дело слышно
 *   всем.
 *
 * На пороге `stranger_at` к отряду в людном месте подсаживается незнакомец —
 * дракон в человеческом облике. Сцена идёт двумя шагами команды
 * `StageScenarioStranger`, оба — шаг Режиссёра, не игрока:
 *
 * 1. `arrive` — профиль незнакомца заводится в текущем месте и встаёт на поле,
 *    отряд может с ним говорить;
 * 2. `reveal` — после первого же действия отряда он превращается, выдыхает
 *    пламя (спасбросок на половину урона у каждого героя в сцене) и улетает:
 *    профиль становится недоступен.
 *
 * Счёт решает и бой финала (`scenarioFinaleTactics`): на пороге `ready_at`
 * дракон готов — с ним засада слуг, тайный ход завален
 * (`applyScenarioMapReveals`), внезапности нет; ниже `unaware_below` или при
 * входе тайным ходом он не ждёт отряд и застигнут врасплох.
 *
 * Модуль — лист графа: он читает состояние и сценарий, но не импортирует Rules
 * Engine. Числа выдоха живут в данных сценария, а не в коде.
 */
import { campaignScenario, scenarioAttentionReady, scenarioLocationId, scenarioPreviousLocationId } from './campaign-scenario.mjs'

export const SCENARIO_ATTENTION_SCHEMA_VERSION = 1
export const SCENARIO_ATTENTION_POLICY_ID = 'skazanie:scenario-attention-v1'
export const SCENARIO_COMMAND_TYPES = Object.freeze(new Set(['StageScenarioStranger']))
export const SCENARIO_STRANGER_STAGES = Object.freeze(['arrive', 'reveal'])
/** Событие шага сцены незнакомца; стадия в нём — уже свершившаяся. */
export const SCENARIO_STRANGER_EVENT = 'ScenarioStrangerStaged'
export const SCENARIO_STRANGER_EVENT_SCHEMA_VERSION = 1

const HISTORY_LIMIT = 40
const COUNTED_LIMIT = 200
/** Навыки тихого расследования: ими выспрашивают, не привлекая внимания. */
const QUIET_SKILLS = new Set(['deception', 'stealth', 'sleight_of_hand', 'sleight-of-hand'])
const STRANGER_STATES = new Set(['none', 'arrived', 'revealed'])

const clean = (/** @type {unknown} */ value, maximum = 240) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const integer = (/** @type {unknown} */ value, fallback = 0) => {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : fallback
}

/**
 * @typedef {{ delta: number, value: number, reason: string, location_id: string, event_id: string }} AttentionChange
 * @typedef {{ stage: 'none' | 'arrived' | 'revealed', location_id: string, party_acted: boolean }} StrangerState
 * @typedef {{ schema_version: number, value: number, visit: number, counted: string[], history: AttentionChange[], stranger: StrangerState }} ScenarioAttentionState
 */

/**
 * @param {any} input
 * @returns {ScenarioAttentionState}
 */
export function normalizeScenarioAttentionState(input = {}) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const stranger = value.stranger && typeof value.stranger === 'object' ? value.stranger : {}
  const stage = STRANGER_STATES.has(stranger.stage) ? stranger.stage : 'none'
  return {
    schema_version: SCENARIO_ATTENTION_SCHEMA_VERSION,
    value: Math.max(0, integer(value.value)),
    visit: Math.max(0, integer(value.visit)),
    counted: (Array.isArray(value.counted) ? value.counted : []).map((/** @type {unknown} */ key) => clean(key, 200)).filter(Boolean).slice(-COUNTED_LIMIT),
    history: (Array.isArray(value.history) ? value.history : []).slice(-HISTORY_LIMIT).map((/** @type {any} */ entry) => ({
      delta: integer(entry?.delta),
      value: Math.max(0, integer(entry?.value)),
      reason: clean(entry?.reason, 40),
      location_id: clean(entry?.location_id, 120),
      event_id: clean(entry?.event_id, 160),
    })),
    stranger: {
      stage,
      location_id: clean(stranger.location_id, 120),
      party_acted: stranger.party_acted === true,
    },
  }
}

/** @param {any} state */
function attentionConfig(state) {
  return campaignScenario(state)?.attention ?? null
}

/**
 * Упоминает ли текст тему сценария: основа слова ищется в начале слова, чтобы
 * «дракон» находился в «драконе» и «драконьих», а не внутри чужого слова.
 * @param {any} config
 * @param {unknown} text
 */
export function mentionsScenarioTopic(config, text) {
  const value = clean(text, 1_000).toLocaleLowerCase('ru').replace(/ё/gu, 'е')
  if (!value) return false
  const words = value.split(/[^\p{L}\p{M}]+/u).filter(Boolean)
  return (config?.topic_stems ?? []).some((/** @type {string} */ stem) => words.some((word) => word.startsWith(stem)))
}

/**
 * @param {ScenarioAttentionState} ledger
 * @param {any} config
 * @param {{ delta: number, reason: string, key: string, locationId: string, eventId: string }} change
 */
function raise(ledger, config, { delta, reason, key, locationId, eventId }) {
  if (ledger.counted.includes(key)) return ledger
  const value = Math.max(0, Math.min(config.maximum, ledger.value + delta))
  return {
    ...ledger,
    value,
    counted: [...ledger.counted, key].slice(-COUNTED_LIMIT),
    history: [...ledger.history, { delta, value, reason, location_id: locationId, event_id: clean(eventId, 160) }].slice(-HISTORY_LIMIT),
  }
}

/**
 * Свёртка одного события. Вызывается редьюсером **после** применения события:
 * место — это сцена, в которой оно случилось (переход сцены сам место меняет и
 * только считает визиты).
 * @param {any} ledgerInput
 * @param {any} event
 * @param {any} state
 * @returns {ScenarioAttentionState}
 */
export function applyScenarioAttentionEvent(ledgerInput, event, state) {
  let ledger = normalizeScenarioAttentionState(ledgerInput)
  const config = attentionConfig(state)
  if (!config || !event) return ledger
  const payload = event.payload ?? {}
  const type = String(event.event_type ?? '')
  const locationId = scenarioLocationId(state)
  const watched = (config.watched_location_ids ?? []).includes(locationId)
  const strangerId = config.stranger?.npc_id
  const partyIds = new Set((Array.isArray(state?.partyMemberIds) ? state.partyMemberIds : []).map(String))

  if (type === 'SceneAdvanced') return { ...ledger, visit: ledger.visit + 1 }
  if (type === SCENARIO_STRANGER_EVENT) {
    const stage = payload.stage === 'revealed' ? 'revealed' : payload.stage === 'arrived' ? 'arrived' : ledger.stranger.stage
    return { ...ledger, stranger: { stage, location_id: clean(payload.location_id, 120) || ledger.stranger.location_id, party_acted: false } }
  }
  // Незнакомец открывается после первого же поступка отряда при нём: реплики,
  // шага, проверки. Иначе он не успел бы «прощупать» отряд.
  if (ledger.stranger.stage === 'arrived' && !ledger.stranger.party_acted
    && (partyIds.has(String(event.actor_id ?? '')) || type === 'NpcConversationRecorded')) {
    ledger = { ...ledger, stranger: { ...ledger.stranger, party_acted: true } }
  }
  if (type === 'NpcConversationRecorded') {
    const conversation = payload.conversation ?? {}
    if (String(conversation.npc_id ?? '') === strangerId) return ledger
    if (!watched || QUIET_SKILLS.has(clean(conversation.check?.skill, 40))) return ledger
    if (!mentionsScenarioTopic(config, conversation.player_message)) return ledger
    return raise(ledger, config, { delta: 1, reason: 'questions', key: `questions:${locationId}:${ledger.visit}`, locationId, eventId: event.event_id })
  }
  if (type === 'RulingRecorded') {
    const ruling = payload.ruling ?? {}
    const interpretation = ruling.interpretation ?? {}
    if (!watched || interpretation.activity_kind !== 'social' || QUIET_SKILLS.has(clean(interpretation.skill, 40))) return ledger
    if (!mentionsScenarioTopic(config, ruling.question)) return ledger
    return raise(ledger, config, { delta: 1, reason: 'questions', key: `questions:${locationId}:${ledger.visit}`, locationId, eventId: event.event_id })
  }
  if (type === 'EncounterCreated') {
    if (!watched) return ledger
    const encounterId = clean(payload.encounter_id ?? payload.encounter?.id, 120) || clean(event.event_id, 160)
    return raise(ledger, config, { delta: 2, reason: 'fight', key: `fight:${encounterId}`, locationId, eventId: event.event_id })
  }
  return ledger
}

/**
 * Внимание для Режиссёра и тестов. `null` — у кампании нет сценария со
 * счётчиком.
 * @param {any} state
 */
export function scenarioAttention(state = {}) {
  const config = attentionConfig(state)
  if (!config) return null
  const ledger = normalizeScenarioAttentionState(state?.scenario_attention)
  return {
    value: ledger.value,
    maximum: config.maximum,
    stranger_at: config.stranger_at,
    ready_at: config.ready_at,
    ready: ledger.value >= config.ready_at,
    stranger_stage: ledger.stranger.stage,
    history: ledger.history,
  }
}

/**
 * Какой шаг сцены незнакомца сейчас уместен: `arrive`, `reveal` или `null`.
 * Обе стадии — только вне боя, в месте из списка незнакомца.
 * @param {any} state
 * @returns {'arrive' | 'reveal' | null}
 */
export function scenarioStrangerStage(state = {}) {
  const config = attentionConfig(state)
  if (!config) return null
  if (state?.mechanics?.combat?.active) return null
  const status = state?.mechanics?.campaign_lifecycle?.status
  if (status && status !== 'active') return null
  const locationId = scenarioLocationId(state)
  if (!(config.stranger.location_ids ?? []).includes(locationId)) return null
  const ledger = normalizeScenarioAttentionState(state?.scenario_attention)
  if (ledger.stranger.stage === 'none') return ledger.value >= config.stranger_at ? 'arrive' : null
  if (ledger.stranger.stage === 'arrived') {
    return ledger.stranger.party_acted && ledger.stranger.location_id === locationId ? 'reveal' : null
  }
  return null
}

/** Id NPC-незнакомца сценария или пустая строка. @param {any} state */
export function scenarioStrangerNpcId(state = {}) {
  return clean(attentionConfig(state)?.stranger?.npc_id, 120)
}

/**
 * Профиль незнакомца для `UpsertNpcSocialProfile`: заводится в текущем месте.
 * Цели и убеждения ведут социального контроллера — он играет путника, а не
 * дракона, и себя не называет.
 * @param {any} state
 * @param {{ available?: boolean }} [options]
 */
export function scenarioStrangerProfile(state = {}, { available = true } = {}) {
  const stranger = attentionConfig(state)?.stranger
  if (!stranger) return null
  const ledger = normalizeScenarioAttentionState(state?.scenario_attention)
  const locationId = available ? scenarioLocationId(state) : ledger.stranger.location_id || scenarioLocationId(state)
  const location = available
    ? clean(state?.scene?.location, 180)
    : clean((state?.social?.npcs ?? []).find((/** @type {any} */ npc) => npc?.id === stranger.npc_id)?.location, 180) || clean(state?.scene?.location, 180)
  return {
    id: stranger.npc_id,
    name: stranger.name,
    role: stranger.role,
    location,
    location_id: locationId,
    public_summary: stranger.summary,
    voice: stranger.voice,
    goals: [...stranger.goals],
    beliefs: [...(stranger.beliefs ?? [])],
    known_fact_ids: [],
    visibility: 'party',
    available,
    tags: ['scenario-stranger'],
    schedule: [],
    inventory: [],
  }
}

/** Выдох незнакомца из данных сценария. @param {any} state */
export function scenarioStrangerBreath(state = {}) {
  const breath = attentionConfig(state)?.stranger?.breath
  return breath ? { expression: breath.expression, ability: breath.ability, dc: breath.dc, damage_type: breath.damage_type } : null
}

const ABILITY_GENITIVE = Object.freeze({ str: 'Силы', dex: 'Ловкости', con: 'Телосложения', int: 'Интеллекта', wis: 'Мудрости', cha: 'Харизмы' })
const DAMAGE_INSTRUMENTAL = Object.freeze({
  fire: 'огнём', cold: 'холодом', acid: 'кислотой', lightning: 'молнией', poison: 'ядом', thunder: 'звуком',
  necrotic: 'некротической энергией', radiant: 'излучением', force: 'силовым полем', psychic: 'психической энергией',
})

/**
 * Текст шага сцены незнакомца для ленты: авторский текст сценария и итог
 * выдоха по каждому герою из уже записанных событий. Пустая строка — среди
 * событий нет шага незнакомца. Чисел не выдумывает: всё берётся из бросков.
 * @param {any[]} events
 * @param {any} state
 */
export function scenarioStrangerNarration(events = [], state = {}) {
  const stranger = attentionConfig(state)?.stranger
  const staged = (Array.isArray(events) ? events : []).find((event) => event?.event_type === SCENARIO_STRANGER_EVENT)
  if (!stranger || !staged) return ''
  if (staged.payload?.stage === 'arrived') return clean(stranger.arrival_text, 1_000)
  const breath = staged.payload?.breath ?? stranger.breath
  const heroName = (/** @type {string} */ heroId) => {
    const hero = (Array.isArray(state?.players) ? state.players : []).find((/** @type {any} */ player) => String(player?.id) === heroId)
    return clean(hero?.character || hero?.name, 80) || 'Герой'
  }
  const lines = [clean(stranger.reveal_text, 1_000)]
  for (const save of events.filter((event) => event?.event_type === 'SavingThrowResolved' && event.payload?.source === 'scenario-stranger')) {
    const heroId = String(save.target_ids?.[0] ?? '')
    const damage = events.find((event) => event?.event_type === 'DamageApplied' && event.payload?.source === 'scenario-stranger' && String(event.target_ids?.[0] ?? '') === heroId)
    const amount = Math.max(0, integer(damage?.payload?.applied_amount))
    const total = integer(save.payload?.total, Number.NaN)
    lines.push(`${heroName(heroId)}: спасбросок ${ABILITY_GENITIVE[/** @type {keyof typeof ABILITY_GENITIVE} */ (breath.ability)] ?? breath.ability}${Number.isFinite(total) ? ` ${total}` : ''} против СЛ ${breath.dc} — ${save.payload?.saved ? 'успех' : 'провал'}, ${amount} урона ${DAMAGE_INSTRUMENTAL[/** @type {keyof typeof DAMAGE_INSTRUMENTAL} */ (breath.damage_type)] ?? ''}.`.replace(/ \./u, '.'))
  }
  lines.push(clean(stranger.departure_text, 1_000))
  return lines.filter(Boolean).join(' ')
}

/**
 * Бой финала по счёту внимания. Только для встречи с главным противником в его
 * логове; `null` — обычные правила внезапности и обычная сборка.
 *
 * - `ready` — дракон готов: к нему добавляется засада (`ambush`), внезапности
 *   нет ни у кого, даже у прокравшегося отряда;
 * - `unaware` — дракон не ждёт: счёт ниже `unaware_below` или отряд пришёл
 *   тайным ходом (`hidden_route`); сторона противника застигнута врасплох.
 * @param {any} state
 * @param {string[]} enemyIds
 * @returns {{ readiness: 'ready' | 'unaware', surprise: 'none' | 'enemies', ambush: { theme: string, difficulty: string } | null, reason: string } | null}
 */
export function scenarioFinaleTactics(state = {}, enemyIds = []) {
  const scenario = campaignScenario(state)
  const config = scenario?.attention
  const finale = scenario?.beats?.find((/** @type {any} */ beat) => beat.kind === 'finale')
  if (!config?.finale || !finale?.boss) return null
  if (!enemyIds.map(String).includes(finale.boss.npc_id)) return null
  if (scenarioLocationId(state) !== finale.boss.location_id) return null
  if (scenarioAttentionReady(state, scenario)) {
    return { readiness: 'ready', surprise: 'none', ambush: { ...config.finale.ready_ambush }, reason: 'attention-ready' }
  }
  const ledger = normalizeScenarioAttentionState(state?.scenario_attention)
  const [routeA, routeB] = config.finale.hidden_route
  const cameFrom = scenarioPreviousLocationId(state)
  const hiddenEntry = cameFrom && [routeA, routeB].includes(cameFrom) && [routeA, routeB].includes(finale.boss.location_id)
  if (hiddenEntry) return { readiness: 'unaware', surprise: 'enemies', ambush: null, reason: 'hidden-route' }
  if (ledger.value < config.finale.unaware_below) return { readiness: 'unaware', surprise: 'enemies', ambush: null, reason: 'attention-low' }
  return null
}
