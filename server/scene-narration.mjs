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
  const transition = clean(event.payload?.transition, 1_000)
  const arrival = clean(event.payload?.arrival, 1_000)
  const commerce = merchantNarration(events, state)
  return [transition, arrival, commerce].filter(Boolean).join('\n\n')
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

