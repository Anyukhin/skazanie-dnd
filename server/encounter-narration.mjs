const ENCOUNTER_EVENT_TYPES = new Set(['EncounterCreated'])

function safeText(value, fallback, maximum = 120) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, maximum)
  return text || fallback
}

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
  const names = enemies.map((enemy) => safeText(enemy?.name, 'Противник')).filter(Boolean)
  const roster = names.length ? names.join(', ') : 'противники'
  const initiativeStarted = (Array.isArray(events) ? events : []).some((event) => event?.event_type === 'CombatStarted')
  return `На поле появляются противники: ${roster}.${initiativeStarted ? ' Инициатива определена, бой начинается.' : ''}`
}
