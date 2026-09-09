import { parseDiceExpression } from './dice-service.mjs'

// Общие правила доступности приёма читают и движок, и планировщик NPC.
// Потраченное хранится существующими событиями ConditionAdded/Removed.
export function monsterRechargeMinimum(action) {
  const value = action?.recharge && typeof action.recharge === 'object'
    ? Math.min(...(action.recharge.success ?? []))
    : Number(action?.recharge ?? 0)
  return Number.isSafeInteger(value) && value >= 1 && value <= 6 ? value : 0
}

export function monsterActionUsageKey(action) {
  return String(action?.recharge_group ?? action?.recharge?.group ?? action?.id ?? '')
}

export function monsterActionUsesSpent(action, conditions) {
  const marker = `monster-action-used:${monsterActionUsageKey(action)}`
  return [...conditions].filter(value => {
    const id = String(value?.id ?? value)
    return id === marker || id.startsWith(`${marker}#`)
  }).length
}

export function monsterActionAvailable(action, conditions) {
  const spent = monsterActionUsesSpent(action, conditions)
  if (monsterRechargeMinimum(action)) return spent === 0
  const maximum = Number(action?.uses ?? 0)
  return !Number.isSafeInteger(maximum) || maximum <= 0 || spent < maximum
}

export function monsterActionSpentMarker(action, conditions) {
  const marker = `monster-action-used:${monsterActionUsageKey(action)}`
  if (monsterRechargeMinimum(action)) return marker
  if (Number(action?.uses) > 0) return `${marker}#${monsterActionUsesSpent(action, conditions) + 1}`
  return null
}

export function monsterAttackTargetAllowed(action, conditions, sourceId = null) {
  const entries = [...conditions]
  const ids = new Set(entries.map(entry => String(entry?.id ?? entry)))
  if (action?.target_condition && !ids.has(String(action.target_condition))) return false
  if (action?.target_any_conditions?.length) return action.target_any_conditions.some(condition => {
    if (condition === 'incapacitated') return ['incapacitated', 'paralyzed', 'petrified', 'stunned', 'unconscious'].some(id => ids.has(id))
    if (condition === 'grappled') return entries.some(entry => entry.id === 'grappled' && entry.source_actor === sourceId)
    return ids.has(condition)
  })
  return true
}

export function monsterOnHitTargetAllowed(onHit, target) {
  const kind = String(target?.creature_type ?? target?.creatureType ?? 'humanoid').toLowerCase()
  if (onHit.required_target_type && kind !== onHit.required_target_type) return false
  const race = String(target?.speciesBenefits?.race_id ?? target?.race_id ?? target?.raceId ?? target?.race ?? '').toLowerCase()
  const tags = new Set([kind, race, ...(Array.isArray(target?.subtypes) ? target.subtypes : [])])
  if (race.startsWith('elf-') || race === 'drow' || race === 'эльф') tags.add('elf')
  return !(onHit.excluded_targets ?? []).some(excluded => tags.has(excluded))
}

/** Допустимые последовательности, которые полностью состоят из реализованных атак. */
export function monsterMultiattackSequences(actor) {
  const multiattack = (Array.isArray(actor?.traits) ? actor.traits : []).find(trait => trait?.id === 'multiattack')
  if (!multiattack) return []
  const profiles = new Set((Array.isArray(actor.action_profiles) ? actor.action_profiles : []).map(action => String(action.id)))
  const sequences = Array.isArray(multiattack.sequences) && multiattack.sequences.length ? multiattack.sequences : Array.isArray(multiattack.sequence) && multiattack.sequence.length ? [multiattack.sequence] : []
  return sequences.filter((sequence, index) => {
    const requirement = multiattack.sequence_conditions?.[index]
    if (requirement && !(requirement.requires === 'flying' && actor.movement_mode === 'fly')) return false
    return Array.isArray(sequence) && sequence.length > 0 && sequence.length <= 8 && sequence.every(id => profiles.has(String(id)))
  }).map(sequence => sequence.map(String))
}

export function monsterMultiattackSequenceFor(actor, nextActionId, usedActionIds = []) {
  const remaining = monsterMultiattackSequences(actor).filter(sequence => usedActionIds.every((id, index) => sequence[index] === String(id)))
  return remaining.find(sequence => sequence[usedActionIds.length] === String(nextActionId)) ?? remaining[0] ?? null
}

/** Только формализованная область урона; прочие особые действия остаются справочными. */
export function monsterAreaAction(action) {
  if (action?.kind !== 'save_area' || !action.id || action.condition || action.on_hit || Object.keys(action.effects ?? {}).length) return null
  if (!['str', 'dex', 'con', 'int', 'wis', 'cha'].includes(action.save?.ability)) return null
  if (!Number.isSafeInteger(action.save.dc) || action.save.dc < 1 || action.save.dc > 40) return null
  if (!['half_damage', 'no_damage'].includes(action.save.success)) return null
  const shape = action.area?.shape
  if (!['cone', 'line', 'sphere'].includes(shape)) return null
  if (shape === 'line' && Number(action.area.width_ft ?? 5) !== 5) return null
  const length = Number(action.area.length_ft ?? action.area.radius_ft)
  if (!Number.isSafeInteger(length) || length < 5 || length > 120) return null
  const components = action.damage
  if (!Array.isArray(components) || !components.length || components.length > 4) return null
  for (const component of components) {
    if (!['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder'].includes(component.type)) return null
    if (component.expression) {
      try { parseDiceExpression(component.expression) } catch { return null }
    } else if (!Number.isSafeInteger(component.amount) || component.amount < 0) return null
  }
  return {
    ...action,
    name: String(action.name_ru ?? action.name ?? action.id),
    recharge: monsterRechargeMinimum(action),
    recharge_group: action.recharge_group ?? action.recharge?.group ?? null,
    shape,
    length_feet: length,
    width_feet: Math.max(5, Math.min(120, Number(action.area.width_ft) || 5)),
  }
}
