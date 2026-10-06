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
 * Модуль — лист графа: читает состояние и сценарий, Rules Engine не
 * импортирует. Числа и тексты — в данных сценария (`knight`).
 */
import { campaignScenario, scenarioLocationId } from './campaign-scenario.mjs'
import { clockMinuteOf } from './weather.mjs'

export const SCENARIO_KNIGHT_PRESENCE_EVENT = 'ScenarioKnightPresenceChanged'
export const SCENARIO_KNIGHT_PRESENCE_EVENT_SCHEMA_VERSION = 1

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
