import { merchantNarration } from './merchant-narration.mjs'
import { NARRATOR_PRIORITY, cleanNarrationText as clean, registerDeterministicNarrator } from './deterministic-narration.mjs'

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
  return [transition, arrival, commerce].filter(Boolean).join('\n\n')
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

