import { merchantNarration } from './merchant-narration.mjs'
import { NARRATOR_PRIORITY, cleanNarrationText as clean, registerDeterministicNarrator } from './deterministic-narration.mjs'
import { clockMinuteOf, elapsedMinutesOf } from './weather.mjs'

export function hasSceneEvent(events) {
  return (Array.isArray(events) ? events : []).some((event) => event?.event_type === 'SceneAdvanced')
}

/** Narrates only facts already committed in SceneAdvanced/merchant events. */
export function sceneNarration(events, state) {
  const event = [...(Array.isArray(events) ? events : [])].reverse()
    .find((candidate) => candidate?.event_type === 'SceneAdvanced')
  if (!event) return null
  const transition = sentence(clean(event.payload?.transition, 1_000))
  const arrival = sentence(clean(event.payload?.arrival, 1_000))
  const commerce = merchantNarration(events, state)
  return [transition, [arrival, travelTimeSentence(events, state)].filter(Boolean).join(' '), commerce].filter(Boolean).join('\n\n')
}

const HOURS_GENITIVE = ['', 'часа', 'двух', 'трёх', 'четырёх', 'пяти', 'шести', 'семи', 'восьми', 'девяти', 'десяти', 'одиннадцати', 'двенадцати']

/** «около двух с половиной часов», «около полутора часов», «около получаса». */
function travelDurationRu(minutes) {
  if (minutes < 45) return 'около получаса'
  const halves = Math.max(2, Math.round(minutes / 30))
  const hours = Math.floor(halves / 2)
  const half = halves % 2 === 1
  if (hours === 1) return half ? 'около полутора часов' : 'около часа'
  if (hours >= HOURS_GENITIVE.length) return 'полдня'
  return `около ${HOURS_GENITIVE[hours]}${half ? ' с половиной' : ''} часов`
}

/** Время суток к приходу словами стола. */
function arrivalDayPartRu(elapsedMinutes) {
  const hour = Math.floor(clockMinuteOf(elapsedMinutes) / 60)
  if (hour < 4) return 'стоит глубокая ночь'
  if (hour < 6) return 'до рассвета уже недалеко'
  if (hour < 10) return 'наступило утро'
  if (hour < 17) return 'день в разгаре'
  if (hour < 21) return 'вечереет'
  return 'ночь только начинается'
}

/**
 * Сколько шёл отряд и который час на месте. Переход двигает мировые часы, и
 * без этой фразы время прыгало с 23:38 к 02:08 «без пояснений» (замер 19,
 * 2026-10-11). Короткий путь — меньше получаса — не называется.
 */
function travelTimeSentence(events, state) {
  const travel = (Array.isArray(events) ? events : [])
    .filter((candidate) => candidate?.event_type === 'TimeAdvanced')
    .reduce((sum, candidate) => sum + Math.max(0, Number(candidate?.payload?.elapsed_minutes) || 0), 0)
  if (travel < 30) return ''
  return `Дорога заняла ${travelDurationRu(travel)}; ${arrivalDayPartRu(elapsedMinutesOf(state))}.`
}

/**
 * Архитектор пишет `transition` и `arrival` фразами без точки. Хроника
 * показывает абзацы подряд, и без точки получалось «…до таверны «Морской
 * Змей» Герои входят…».
 */
function sentence(value) {
  if (!value) return value
  const core = value.replace(/[»"”')\]]+$/u, '')
  return /[.!?…]$/u.test(core) ? value : `${value}.`
}

// Регистрируется первым: смена сцены перекрывает и торговлю, и появление
// противников. Этот приоритет существовал и раньше — он был зашит в порядок
// ветвей `?:` в оркестраторе и нигде не назывался.
export const sceneNarrator = registerDeterministicNarrator({
  id: 'scene',
  priority: NARRATOR_PRIORITY.scene,
  promptVersion: 'scene-narrator/v1',
  provider: 'deterministic-scene',
  matches: hasSceneEvent,
  narrate: sceneNarration,
})

