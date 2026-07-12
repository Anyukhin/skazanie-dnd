import { merchantNarration } from './merchant-narration.mjs'

function clean(value, maximum = 1_000) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)
}

export function hasSceneEvent(events) {
  return (Array.isArray(events) ? events : []).some((event) => event?.event_type === 'SceneAdvanced')
}

export function sceneSuggestions(events) {
  const event = [...(Array.isArray(events) ? events : [])].reverse()
    .find((candidate) => candidate?.event_type === 'SceneAdvanced')
  return (Array.isArray(event?.payload?.suggestions) ? event.payload.suggestions : [])
    .map((suggestion) => clean(suggestion, 120)).filter(Boolean).slice(0, 3)
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

