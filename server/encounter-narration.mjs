import { NARRATOR_PRIORITY, narrationTextOr, registerDeterministicNarrator } from './deterministic-narration.mjs'

const ENCOUNTER_EVENT_TYPES = new Set(['EncounterCreated'])

export function hasEncounterEvent(events) {
  return (Array.isArray(events) ? events : []).some((event) => ENCOUNTER_EVENT_TYPES.has(String(event?.event_type ?? '')))
}

/** Narrates only the encounter facts already committed by Rules Engine. */
export function encounterNarration(events) {
  const created = (Array.isArray(events) ? events : []).find((event) => event?.event_type === 'EncounterCreated')
  if (!created) return null
  const encounter = created.payload?.encounter && typeof created.payload.encounter === 'object'
    ? created.payload.encounter
    : {}
  const enemies = (Array.isArray(encounter.enemies) ? encounter.enemies : []).slice(0, 12)
  const names = enemies.map((enemy) => narrationTextOr(enemy?.name, 'Противник')).filter(Boolean)
  const roster = names.length ? names.join(', ') : 'противники'
  const initiativeStarted = (Array.isArray(events) ? events : []).some((event) => event?.event_type === 'CombatStarted')
  return `На поле появляются противники: ${roster}.${initiativeStarted ? ' Инициатива определена, бой начинается.' : ''}`
}

export const encounterNarrator = registerDeterministicNarrator({
  id: 'encounter',
  priority: NARRATOR_PRIORITY.encounter,
  promptVersion: 'encounter-narrator/v1',
  provider: 'deterministic-encounter',
  matches: hasEncounterEvent,
  narrate: (events) => encounterNarration(events),
})
