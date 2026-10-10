import { NARRATOR_PRIORITY, registerDeterministicNarrator } from './deterministic-narration.mjs'
import { encounterIntro } from './combat-narration.mjs'

const ENCOUNTER_EVENT_TYPES = new Set(['EncounterCreated'])

export function hasEncounterEvent(events) {
  return (Array.isArray(events) ? events : []).some((event) => ENCOUNTER_EVENT_TYPES.has(String(event?.event_type ?? '')))
}

/**
 * Narrates only the encounter facts already committed by Rules Engine.
 *
 * Вступление общее с боевым рассказчиком (`encounterIntro`): обстановка — тема
 * сцены, тема встречи и время суток, состав — имена из события. Плейтест
 * 2026-10-10: «На поле появляются противники: …» звучало протоколом.
 */
export function encounterNarration(events, state = {}) {
  const created = (Array.isArray(events) ? events : []).find((event) => event?.event_type === 'EncounterCreated')
  if (!created) return null
  const encounter = created.payload?.encounter && typeof created.payload.encounter === 'object'
    ? created.payload.encounter
    : {}
  const initiativeStarted = (Array.isArray(events) ? events : []).some((event) => event?.event_type === 'CombatStarted')
  // Смертельная сборка — решение владельца про честный мир: если отряд всё же
  // пошёл в бой, текст обязан сказать это прямо, а не сгладить.
  const deadly = String(encounter.difficulty ?? '') === 'deadly'
    ? ' Силы неравны: это заведомо превосходящий противник.'
    : ''
  return `${encounterIntro(created, state)}${deadly}${initiativeStarted ? ' Инициатива определена, бой начинается.' : ''}`
}

export const encounterNarrator = registerDeterministicNarrator({
  id: 'encounter',
  priority: NARRATOR_PRIORITY.encounter,
  promptVersion: 'encounter-narrator/v2',
  provider: 'deterministic-encounter',
  matches: hasEncounterEvent,
  narrate: (events, state) => encounterNarration(events, state),
})
