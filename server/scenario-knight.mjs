// @ts-check
/**
 * Проклятый рыцарь сценария — Дуннахан Каэлан в Асстохане
 * (`docs/astohan-scenario.md`, линия Б).
 *
 * Здесь — когда рыцарь в замке. Он появляется только в полночь: с 23:00 до
 * 01:00 по часам мира (`server/weather.mjs`) и только при отряде в его месте.
 * Профиль заводится недоступным при создании кампании; доступным его делает
 * Rules Engine, когда время или переход сцены приводят отряд в окно
 * (`scenarioKnightPresencePlan`), и снимает, когда окно закрылось. Посреди боя
 * присутствие не меняется: рыцарь не исчезает из схватки с ударом колокола.
 *
 * Загадка (`scenario_knight` — вывод из журнала, как внимание дракона):
 *
 * - пока голова не поставлена перед ним, рыцарь неуязвим ко всему урону
 *   (`scenarioKnightWard`), удар по нему вызывает смех и подсказку, а в начале
 *   хода героя рядом с ним — спасбросок от ужаса (`scenarioKnightDreadFor`);
 * - голову ставит герой командой `ReturnKnightHead`, когда отряд нашёл тайну
 *   часовни (`riddle_clue`): ужас снят, неуязвимость сменяется сопротивлением
 *   всему урону, кроме силового;
 * - после этого вне боя `ReleaseCursedKnight` — проверка Убеждения или
 *   Религии: успех отпускает рыцаря с миром и отдаёт Слезу, провал — одна
 *   попытка героя за ночь.
 *
 * Модуль — лист графа: читает состояние и сценарий, Rules Engine не
 * импортирует. Числа и тексты — в данных сценария (`knight`).
 */
import { campaignScenario, scenarioClueFactId, scenarioLocationId } from './campaign-scenario.mjs'
import { CAMPAIGN_START_MINUTE_OF_DAY, clockMinuteOf } from './weather.mjs'

export const SCENARIO_KNIGHT_PRESENCE_EVENT = 'ScenarioKnightPresenceChanged'
export const SCENARIO_KNIGHT_PRESENCE_EVENT_SCHEMA_VERSION = 1
export const SCENARIO_KNIGHT_SCHEMA_VERSION = 1
export const SCENARIO_KNIGHT_COMMAND_TYPES = Object.freeze(new Set(['ReturnKnightHead', 'ReleaseCursedKnight']))
export const SCENARIO_KNIGHT_HEAD_EVENT = 'ScenarioKnightHeadReturned'
export const SCENARIO_KNIGHT_RELEASED_EVENT = 'ScenarioKnightReleased'
export const SCENARIO_KNIGHT_RELEASE_FAILED_EVENT = 'ScenarioKnightReleaseFailed'
/** Источник спасброска ужаса в `SavingThrowResolved`. */
export const SCENARIO_KNIGHT_DREAD_SOURCE = 'scenario-knight-dread'
const MINUTES_PER_DAY = 1_440
const LIST_LIMIT = 100

/** Поля профиля, которые принимает `UpsertNpcSocialProfile`. */
const PROFILE_FIELDS = Object.freeze([
  'id', 'name', 'role', 'location', 'location_id', 'public_summary', 'voice', 'speech_profile', 'goals', 'beliefs',
  'known_fact_ids', 'social_dcs', 'visibility', 'reveal_on_presence', 'available', 'tags', 'schedule', 'inventory',
])

const clean = (/** @type {unknown} */ value, maximum = 240) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)

/** @param {any} state */
function knightConfig(state) {
  return campaignScenario(state)?.knight ?? null
}

/** Ночные гости сценария мира: их профиль при создании кампании недоступен. @param {any} scenario */
export function scenarioNightVisitorIds(scenario) {
  return scenario?.knight?.npc_id ? [String(scenario.knight.npc_id)] : []
}

/**
 * Минута суток в окне `[from, to)`; окно может переходить через полночь.
 * @param {number} minute
 * @param {{ from_minute: number, to_minute: number }} window
 */
export function minuteInWindow(minute, window) {
  const from = window.from_minute
  const to = window.to_minute
  return from <= to ? minute >= from && minute < to : minute >= from || minute < to
}

/**
 * Должен ли рыцарь сейчас быть при отряде: окно ночи, место, жив.
 * @param {any} state
 */
export function scenarioKnightShouldBePresent(state = {}) {
  const config = knightConfig(state)
  if (!config) return false
  if (state?.npc_world?.vitals?.[config.npc_id]?.alive === false) return false
  if (normalizeScenarioKnightState(state?.scenario_knight).released) return false
  if (scenarioLocationId(state) !== config.location_id) return false
  return minuteInWindow(clockMinuteOf(state?.mechanics?.world_time?.elapsed_minutes ?? 0), config.night)
}

/**
 * Что сделать с профилем рыцаря после хода времени или перехода сцены.
 * `null` — менять нечего (или идёт бой). Иначе — профиль для
 * `UpsertNpcSocialProfile` и, если отряд это видит, текст прихода или ухода.
 * @param {any} state
 * @returns {{ npc_id: string, present: boolean, profile: Record<string, unknown>, text: string, location_id: string } | null}
 */
export function scenarioKnightPresencePlan(state = {}) {
  const config = knightConfig(state)
  if (!config || state?.mechanics?.combat?.active) return null
  const stored = (Array.isArray(state?.social?.npcs) ? state.social.npcs : []).find((/** @type {any} */ npc) => npc?.id === config.npc_id)
  if (!stored) return null
  const present = stored.available !== false
  const shouldBe = scenarioKnightShouldBePresent(state)
  if (present === shouldBe) return null
  /** @type {Record<string, unknown>} */
  const profile = {}
  for (const field of PROFILE_FIELDS) if (stored[field] !== undefined) profile[field] = structuredClone(stored[field])
  profile.available = shouldBe
  // Уход виден, только если отряд при нём; ушедший без свидетелей рыцарь
  // просто перестаёт быть доступным.
  const witnessed = scenarioLocationId(state) === config.location_id
  return {
    npc_id: config.npc_id,
    present: shouldBe,
    profile,
    location_id: config.location_id,
    text: witnessed ? clean(shouldBe ? config.arrival_text : config.departure_text, 1_000) : '',
  }
}

// ---------------------------------------------------------------------------
// Загадка: реестр, защита, ужас и мирный путь

/**
 * @typedef {{ schema_version: number, head_returned: boolean, head_returned_by: string, released: boolean, released_by: string, attempts: string[], dread_resisted: string[] }} ScenarioKnightState
 */

/** @param {any} input @returns {ScenarioKnightState} */
export function normalizeScenarioKnightState(input = {}) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const list = (/** @type {unknown} */ entries) => (Array.isArray(entries) ? entries : [])
    .map((entry) => clean(entry, 200)).filter(Boolean).slice(-LIST_LIMIT)
  return {
    schema_version: SCENARIO_KNIGHT_SCHEMA_VERSION,
    head_returned: value.head_returned === true,
    head_returned_by: clean(value.head_returned_by, 120),
    released: value.released === true,
    released_by: clean(value.released_by, 120),
    attempts: list(value.attempts),
    dread_resisted: list(value.dread_resisted),
  }
}

/**
 * Номер ночи: ночь тянется через полночь, поэтому сутки отсчитываются от
 * полудня. «Одна попытка за ночь» и «выдержал ужас этой ночью» — по нему.
 * @param {any} state
 */
export function scenarioNightIndex(state = {}) {
  const elapsed = Math.max(0, Math.trunc(Number(state?.mechanics?.world_time?.elapsed_minutes) || 0))
  return Math.floor((CAMPAIGN_START_MINUTE_OF_DAY + elapsed + MINUTES_PER_DAY / 2) / MINUTES_PER_DAY)
}

/**
 * Свёртка события в реестр рыцаря; вызывается редьюсером после применения.
 * @param {any} ledgerInput
 * @param {any} event
 * @param {any} state
 * @returns {ScenarioKnightState}
 */
export function applyScenarioKnightEvent(ledgerInput, event, state) {
  const ledger = normalizeScenarioKnightState(ledgerInput)
  const config = knightConfig(state)
  if (!config || !event) return ledger
  const payload = event.payload ?? {}
  const type = String(event.event_type ?? '')
  if (type === SCENARIO_KNIGHT_HEAD_EVENT) return { ...ledger, head_returned: true, head_returned_by: clean(event.actor_id, 120) }
  if (type === SCENARIO_KNIGHT_RELEASED_EVENT) return { ...ledger, released: true, released_by: clean(event.actor_id, 120) }
  if (type === SCENARIO_KNIGHT_RELEASE_FAILED_EVENT) {
    return { ...ledger, attempts: [...ledger.attempts, `${clean(event.actor_id, 120)}:${Math.trunc(Number(payload.night) || 0)}`].slice(-LIST_LIMIT) }
  }
  if (type === 'SavingThrowResolved' && payload.source === SCENARIO_KNIGHT_DREAD_SOURCE && payload.saved === true) {
    const heroId = clean(event.target_ids?.[0], 120)
    return heroId ? { ...ledger, dread_resisted: [...ledger.dread_resisted, `${heroId}:${Math.trunc(Number(payload.night) || 0)}`].slice(-LIST_LIMIT) } : ledger
  }
  return ledger
}

/** Состояние загадки для проверок и тестов. @param {any} state */
export function scenarioKnightState(state = {}) {
  const config = knightConfig(state)
  return config ? { npc_id: String(config.npc_id), ...normalizeScenarioKnightState(state?.scenario_knight) } : null
}

/** Нашёл ли отряд разгадку (тайну часовни). @param {any} state */
export function scenarioKnightRiddleSolved(state = {}) {
  const scenario = campaignScenario(state)
  const config = scenario?.knight
  if (!config) return false
  const id = scenarioClueFactId(scenario, config.riddle_clue)
  return (Array.isArray(state?.worldMemory?.facts) ? state.worldMemory.facts : [])
    .some((/** @type {any} */ fact) => fact?.predicate === 'discovery' && fact.supersedes_fact_id === id)
}

/** Рыцарь сейчас в сцене при отряде (его профиль доступен). @param {any} state */
export function scenarioKnightPresent(state = {}) {
  const config = knightConfig(state)
  if (!config || scenarioLocationId(state) !== config.location_id) return false
  const profile = (Array.isArray(state?.social?.npcs) ? state.social.npcs : []).find((/** @type {any} */ npc) => npc?.id === config.npc_id)
  return Boolean(profile && profile.available !== false)
}

/**
 * Защита рыцаря от урона: до возвращения головы — неуязвимость со смехом и
 * подсказкой, после — сопротивление всему, кроме исключений (силовой урон).
 * `null` — цель не рыцарь или защиты нет.
 * @param {any} state
 * @param {string} targetId
 * @returns {{ kind: 'immune', laugh: string } | { kind: 'resist', except: string[] } | null}
 */
export function scenarioKnightWard(state = {}, targetId = '') {
  const config = knightConfig(state)
  if (!config || String(targetId) !== config.npc_id) return null
  const ledger = normalizeScenarioKnightState(state?.scenario_knight)
  if (ledger.released) return null
  return ledger.head_returned
    ? { kind: 'resist', except: [...config.ward_resist_except] }
    : { kind: 'immune', laugh: clean(config.ward_laugh_text, 600) }
}

/**
 * Ужас в начале хода героя: рыцарь в бою, голова не возвращена, герой в
 * радиусе и этой ночью ещё не выдержал. Расстояние считает Rules Engine;
 * модуль решает только правило.
 * @param {any} state
 * @param {string} heroId
 * @param {number | null} distanceFeet от героя до рыцаря
 * @returns {{ source_id: string, ability: string, dc: number, night: number } | null}
 */
export function scenarioKnightDreadFor(state = {}, heroId = '', distanceFeet = null) {
  const config = knightConfig(state)
  if (!config || !state?.mechanics?.combat?.active) return null
  const ledger = normalizeScenarioKnightState(state?.scenario_knight)
  if (ledger.head_returned || ledger.released) return null
  if (!(Array.isArray(state?.partyMemberIds) ? state.partyMemberIds : []).map(String).includes(String(heroId))) return null
  if (distanceFeet == null || !Number.isFinite(distanceFeet) || distanceFeet > config.dread.radius_feet) return null
  const night = scenarioNightIndex(state)
  if (ledger.dread_resisted.includes(`${heroId}:${night}`)) return null
  return { source_id: String(config.npc_id), ability: String(config.dread.ability), dc: Number(config.dread.dc), night }
}

/** Данные загадки для Rules Engine: досягаемость, тексты, мирный путь. @param {any} state */
export function scenarioKnightRules(state = {}) {
  const config = knightConfig(state)
  if (!config) return null
  return {
    npc_id: String(config.npc_id),
    head_reach_feet: Number(config.head_reach_feet),
    head_text: clean(config.head_text, 1_000),
    release: {
      dc: Number(config.release.dc),
      skills: [...config.release.skills].map(String),
      reward: { name: clean(config.release.reward?.name, 120), description: clean(config.release.reward?.description, 400) },
      success_text: clean(config.release.success_text, 1_000),
      failure_text: clean(config.release.failure_text, 1_000),
    },
  }
}

const HEAD_PATTERN = /(?<![\p{L}\p{M}])(?:возвра\p{L}*|верн\p{L}*|став\p{L}*|постав\p{L}*|клад\p{L}*|полож\p{L}*|отда\p{L}*|протяг\p{L}*|прино\p{L}*|подаю|водружа\p{L}*)(?![\p{L}\p{M}])[^.!?]{0,60}(?<![\p{L}\p{M}])голов/iu
const RELEASE_PATTERN = /(?<![\p{L}\p{M}])(?:упоко\p{L}*|освобо\p{L}*|отпуска\p{L}*|отпусти\p{L}*|убежда\p{L}*|уговарива\p{L}*|молюсь|молитв\p{L}*|благослов\p{L}*)(?![\p{L}\p{M}])[^.!?]{0,80}(?:рыцар|каэлан|дуннахан|всадник|страж|покой|проклят|клятв)/iu
const RELIGION_PATTERN = /(?:молитв|молюсь|молю|бог|свят|обряд|благослов|упоко|отпева|религи)/iu

/**
 * Действие с рыцарем в тексте игрока: «ставлю голову перед рыцарем» —
 * `ReturnKnightHead`, «молюсь об упокоении Каэлана» — `ReleaseCursedKnight` с
 * Религией, «убеждаю рыцаря обрести покой» — с Убеждением. Только узнаёт
 * намерение: допустимость проверяет Rules Engine.
 * @param {unknown} value
 * @returns {{ action: 'return_head' } | { action: 'release', skill: 'persuasion' | 'religion' } | null}
 */
export function scenarioKnightActionFromText(value) {
  const text = clean(value, 1_000).toLocaleLowerCase('ru').replace(/ё/gu, 'е')
  if (!text) return null
  if (HEAD_PATTERN.test(text)) return { action: 'return_head' }
  if (RELEASE_PATTERN.test(text)) return { action: 'release', skill: RELIGION_PATTERN.test(text) ? 'religion' : 'persuasion' }
  return null
}
