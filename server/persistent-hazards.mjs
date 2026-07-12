const ABILITIES = new Set(['str', 'dex', 'con', 'int', 'wis', 'cha'])
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical'])

function clean(value, maximum = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum)
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback
}

function actorExists(state, actorId) {
  return [...(state.players ?? []), ...(state.actors ?? [])].some((actor) => String(actor?.id) === String(actorId))
}

export function hazardsFor(state = {}, targetId) {
  const value = state.mechanics?.hazards?.[String(targetId)]
  return Array.isArray(value) ? structuredClone(value) : []
}

export function findHazard(state = {}, targetId, hazardId) {
  return hazardsFor(state, targetId).find((hazard) => hazard.id === String(hazardId)) ?? null
}

export function createHazardEffect(args = {}, state = {}) {
  const targetId = clean(args.targetId, 80)
  if (!targetId || !actorExists(state, targetId)) return { error: 'Цель опасного состояния не найдена', code: 'HAZARD_TARGET_NOT_FOUND' }
  const id = clean(args.id, 60).toLocaleLowerCase('ru').replace(/[^a-zа-яё0-9._-]+/giu, '-')
  if (!id) return { error: 'Не указан id опасного состояния', code: 'HAZARD_ID_REQUIRED' }
  const ability = ABILITIES.has(args.escapeAbility) ? args.escapeAbility : 'str'
  const hazard = {
    id,
    label: clean(args.label, 100) || id,
    source: clean(args.source, 160) || 'Окружающая среда',
    description: clean(args.description, 360),
    severity: SEVERITIES.has(args.severity) ? args.severity : 'medium',
    requiresCheck: args.requiresCheck !== false,
    escapeAbility: ability,
    escapeDifficulty: boundedInteger(args.escapeDifficulty, 12, 5, 30),
    endCondition: clean(args.endCondition, 240) || 'Устранить источник опасности',
    ruleId: clean(args.ruleId, 120),
    appliedAtTurn: Math.max(0, Number(state.scene?.turn) || 0),
  }
  return { operation: 'apply', targetId, hazard }
}

export function createHazardResolution(args = {}, state = {}, verifiedRoll = null) {
  const targetId = clean(args.targetId, 80)
  const id = clean(args.id, 60).toLocaleLowerCase('ru')
  const existing = findHazard(state, targetId, id)
  if (!existing) return { error: 'Такого активного опасного состояния нет', code: 'HAZARD_NOT_FOUND' }
  if (existing.requiresCheck) {
    if (!verifiedRoll) return { error: 'Для снятия состояния нужна серверная проверка', code: 'HAZARD_CHECK_REQUIRED' }
    if (verifiedRoll.ability !== existing.escapeAbility) return { error: `Нужна проверка характеристики ${existing.escapeAbility}`, code: 'HAZARD_WRONG_ABILITY' }
    if (Number(verifiedRoll.difficulty) < Number(existing.escapeDifficulty)) return { error: 'Сложность проверки ниже сложности опасного состояния', code: 'HAZARD_DIFFICULTY_TOO_LOW' }
    if (verifiedRoll.success !== true) return { error: 'Проверка провалена — опасное состояние сохраняется', code: 'HAZARD_CHECK_FAILED' }
  }
  return { operation: 'remove', targetId, hazard: existing, resolution: clean(args.resolution, 240) || existing.endCondition, roll_id: verifiedRoll?.roll_id ?? null }
}

export function applyHazardEffects(mechanics = {}, effects = []) {
  const next = structuredClone(mechanics && typeof mechanics === 'object' ? mechanics : {})
  next.hazards = structuredClone(next.hazards && typeof next.hazards === 'object' ? next.hazards : {})
  for (const effect of Array.isArray(effects) ? effects : []) {
    const targetId = String(effect?.targetId ?? '')
    if (!targetId || !effect?.hazard?.id) continue
    const current = Array.isArray(next.hazards[targetId]) ? next.hazards[targetId] : []
    if (effect.operation === 'remove') next.hazards[targetId] = current.filter((hazard) => hazard.id !== effect.hazard.id)
    else if (effect.operation === 'apply') next.hazards[targetId] = [...current.filter((hazard) => hazard.id !== effect.hazard.id), structuredClone(effect.hazard)]
  }
  return next
}
