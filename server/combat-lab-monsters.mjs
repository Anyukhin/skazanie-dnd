import { MONSTER_SPELL_AT_WILL, canonicalCombatSpellFor } from './combat-spells.mjs'
import { SRD_5_2_1_MONSTER_ALLOWLIST } from './encounter-assembler.mjs'

// Из существующего каталога берётся только уже подготовленный рисунок.
// Характеристики и механика ниже всегда читаются из записи 2014.
const PORTRAITS = new Set(Object.values(SRD_5_2_1_MONSTER_ALLOWLIST).map((record) => record.image).filter(Boolean))

const CLONE = (value) => value == null ? value : structuredClone(value)
const MIXED_MODE_WEAPONS = new Set(['dagger', 'javelin', 'spear', 'handaxe', 'hand-axe', 'dart', 'net'])
const SUPPORTED_TRAITS = new Set([
  'pack-tactics',
  'martial-advantage',
  'surprise-attack',
  'undead-fortitude',
])
const SUPPORTED_ON_HIT_KEYS = new Set([
  'save_ability', 'save_dc', 'condition', 'duration', 'damage_expression',
  'damage_type', 'half_on_save', 'target_size_max',
])

function slugOf(record) {
  return String(record?.id ?? '').split(':').at(-1) || 'monster'
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))]
}

function diceParts(expression) {
  const match = /^(\d+)d(\d+)([+-]\d+)?$/u.exec(String(expression ?? ''))
  if (!match) return null
  return { count: Number(match[1]), sides: Number(match[2]), bonus: Number(match[3] ?? 0), expression: match[0] }
}

function weaponModes(action) {
  const modes = Array.isArray(action?.modes) ? action.modes.map(String) : []
  return unique(modes.filter((mode) => mode === 'melee' || mode === 'ranged'))
}

function thrownModeFor(action, mode) {
  return mode === 'ranged'
    && weaponModes(action).includes('melee')
    && MIXED_MODE_WEAPONS.has(String(action?.id ?? '').toLowerCase())
}

function profileIdFor(action, mode, firstMode) {
  if (mode === firstMode) return String(action.id)
  return `${String(action.id)}:${thrownModeFor(action, mode) ? 'thrown' : mode}`
}

function mapOnHit(raw, secondaryDamage = null) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const result = {}
  if (source.save_ability) result.save_ability = String(source.save_ability)
  if (source.dc != null || source.save_dc != null) result.save_dc = Number(source.dc ?? source.save_dc)
  if (source.on_failure) result.condition = String(source.on_failure)
  if (source.condition) result.condition = String(source.condition)
  if (source.duration != null) result.duration = CLONE(source.duration)
  if (source.damage_expression) result.damage_expression = String(source.damage_expression)
  if (source.damage_type) result.damage_type = String(source.damage_type)
  if (source.damage && typeof source.damage === 'object') {
    result.damage_expression ??= String(source.damage.expression ?? '')
    result.damage_type ??= String(source.damage.type ?? '')
    if (source.save_success === 'half_damage') result.half_on_save = true
  }
  if (source.half_on_save === true) result.half_on_save = true
  if (source.target_size_max) result.target_size_max = String(source.target_size_max)
  // Preserve mechanics that the current weapon-hit handler does not execute.
  // They are useful to the arena observer and make the limitation explicit.
  for (const [key, value] of Object.entries(source)) {
    if (!Object.hasOwn(result, key) && !['dc', 'save_dc', 'on_failure', 'damage', 'save_success'].includes(key)) result[key] = CLONE(value)
  }
  if (secondaryDamage && !result.damage_expression) {
    result.damage_expression = secondaryDamage.expression
    result.damage_type = secondaryDamage.type
  }
  return Object.keys(result).length ? result : null
}

function mapWeaponAction(action, mode, firstMode) {
  const damage = Array.isArray(action.damage) ? action.damage : []
  const primary = damage[0] ?? null
  const parsed = diceParts(primary?.expression)
  const ranged = mode === 'ranged'
  const thrown = thrownModeFor(action, mode)
  const range = action.range_ft && typeof action.range_ft === 'object' ? action.range_ft : {}
  const profile = {
    id: profileIdFor(action, mode, firstMode),
    name: String(action.name_ru ?? action.id),
    kind: ranged ? 'ranged' : 'melee',
    mode: thrown ? 'thrown' : mode,
    attack_modifier: Number(action.attack_modifier ?? 0),
    damage_type: String(primary?.type ?? 'untyped'),
    range_feet: ranged ? Number(range.long ?? range.normal ?? 5) : Number(action.reach_ft ?? 5),
    normal_range_feet: ranged ? Number(range.normal ?? range.long ?? 5) : Number(action.reach_ft ?? 5),
    ...(thrown ? { thrown: true, attack_kind: 'thrown' } : {}),
  }
  if (parsed) {
    profile.damage_expression = parsed.expression
    profile.damage_dice = parsed.sides
    profile.damage_bonus = parsed.bonus
  } else {
    // An attack with no damage (for example Giant Spider's Web) is a real
    // zero-damage action. Never turn it into an invented 1d4/1d6 fallback.
    profile.damage_amount = 0
  }

  const extraDamage = damage.slice(1).find((entry) => diceParts(entry?.expression)) ?? null
  const onHit = mapOnHit(action.on_hit, extraDamage)
  if (onHit) profile.on_hit = onHit
  if (damage.length > 1) profile.damage_components = CLONE(damage)
  if (action.recharge?.success?.length) profile.recharge = Number(action.recharge.success[0])
  if (action.uses != null) profile.uses = Number(action.uses)
  if (action.mechanics_status) profile.source_mechanics_status = action.mechanics_status
  return profile
}

function actionProfileSet(record) {
  const profiles = []
  const byAction = new Map()
  for (const action of record.actions ?? []) {
    if (action.kind !== 'weapon_attack') continue
    const modes = weaponModes(action)
    if (!modes.length) continue
    const firstMode = modes[0]
    const mapped = modes.map((mode) => mapWeaponAction(action, mode, firstMode))
    profiles.push(...mapped)
    byAction.set(String(action.id), { firstMode, profileIds: new Map(modes.map((mode) => [mode, profileIdFor(action, mode, firstMode)])) })
  }
  return { profiles, byAction }
}

function multiattackTrait(record, byAction) {
  const action = (record.actions ?? []).find((candidate) => candidate.kind === 'multiattack')
  if (!action) return null
  const sequences = (action.sequences ?? []).map((sequence) => sequence.flatMap((step) => {
    const mapped = byAction.get(String(step.action_id))
    const mode = String(step.mode ?? mapped?.firstMode ?? 'melee')
    const profileId = mapped?.profileIds.get(mode) ?? String(step.action_id)
    return Array.from({ length: Math.max(1, Number(step.count) || 1) }, () => profileId)
  }))
  const sequence = sequences[0] ?? []
  return {
    id: 'multiattack',
    name: String(action.name_ru ?? 'Мультиатака'),
    sequence,
    attacks: sequence.length,
    ...(sequences.length > 1 ? { sequences } : {}),
  }
}

function monsterSpellcasting(record) {
  const source = record.spellcasting
  if (!source) return null
  const spells = new Map()
  for (const slot of source.spell_slots ?? []) {
    const uses = slot.level === 0 ? MONSTER_SPELL_AT_WILL : Number(slot.slots ?? 0)
    for (const spell of slot.spells ?? []) {
      const id = String(spell.key ?? '')
      if (!id) continue
      const previous = spells.get(id)
      if (!previous || (previous.uses !== MONSTER_SPELL_AT_WILL && uses !== MONSTER_SPELL_AT_WILL && uses > previous.uses)) {
        spells.set(id, { id, uses, level: Number(slot.level) })
      }
    }
  }
  return {
    ability: String(source.ability),
    save_dc: Number(source.save_dc),
    attack_bonus: Number(source.attack_modifier),
    spells: [...spells.values()],
    // Исходная таблица общих ячеек 2014 нужна наблюдателю и
    // `monsterSpellcastingFor`, который задаёт реальные пулы ресурсов.
    spell_slots: CLONE(source.spell_slots ?? []),
    caster_level: Number(source.caster_level),
    class: String(source.class ?? ''),
  }
}

function specialActionLimitations(record) {
  return (record.actions ?? [])
    .filter((action) => !['weapon_attack', 'multiattack'].includes(action.kind))
    .map((action) => `Действие «${action.name_ru ?? action.id}» статблока пока не исполняется планировщиком.`)
}

function traitLimitations(record) {
  return (record.traits ?? [])
    .filter((trait) => !SUPPORTED_TRAITS.has(String(trait.id)))
    .map((trait) => `Черта «${trait.name_ru ?? trait.id}» статблока пока не исполняется движком.`)
}

function onHitLimitations(record) {
  const limitations = []
  for (const action of record.actions ?? []) {
    if (action.kind !== 'weapon_attack') continue
    const onHit = action.on_hit
    if (onHit && Object.keys(onHit).some((key) => !SUPPORTED_ON_HIT_KEYS.has(key) && !['dc', 'on_failure', 'damage', 'save_success'].includes(key))) {
      limitations.push(`Дополнительные условия удара «${action.name_ru ?? action.id}» перенесены частично.`)
    }
    if ((action.damage ?? []).length > 2 || ((action.damage ?? []).length > 1 && onHit?.damage)) {
      limitations.push(`Несколько независимых компонентов урона «${action.name_ru ?? action.id}» требуют отдельного обработчика.`)
    }
  }
  return limitations
}

function recordLimitations(record) {
  const limitations = [
    ...traitLimitations(record),
    ...specialActionLimitations(record),
    ...onHitLimitations(record),
  ]
  const multiattack = (record.actions ?? []).find((action) => action.kind === 'multiattack')
  for (const entry of record.spellcasting?.spell_slots ?? []) for (const known of entry.spells ?? []) {
    const spell = canonicalCombatSpellFor(known.key)
    if (!spell || !['verified', 'partial'].includes(spell.mechanicsSupport)) limitations.push(`Заклинание «${known.name_ru || spell?.name || known.key}» пока не исполняется движком.`)
    else if (spell.actionType !== 'action') limitations.push(`Заклинание «${spell.name}» с этим временем накладывания пока не выбирается тактикой NPC.`)
  }
  if ((multiattack?.sequences?.length ?? 0) > 1) limitations.push('Альтернативные последовательности мультиатаки сохранены в записи, планировщик использует первую.')
  return unique(limitations)
}

export function monsterCatalogEntry(record) {
  return {
    id: String(record.id),
    name: String(record.name_ru),
    ...(PORTRAITS.has(`/assets/enemies/${slugOf(record)}.png`) ? { image: `/assets/enemies/${slugOf(record)}.png` } : {}),
    cr: String(record.challenge_rating),
    hp: Number(record.hit_points.average),
    sourceUrl: String(record.source_url),
    ...(recordLimitations(record).length ? { limitations: recordLimitations(record) } : {}),
  }
}

export function enemyFrom2014(record, position, index = 0) {
  const { profiles, byAction } = actionProfileSet(record)
  const multiattack = multiattackTrait(record, byAction)
  const traits = [...(record.traits ?? []).map(CLONE), ...(multiattack ? [multiattack] : [])]
  const primary = profiles[0] ?? null
  const primaryDice = diceParts(primary?.damage_expression)
  const spellcasting = monsterSpellcasting(record)
  const limitations = recordLimitations(record)
  const id = `enemy-${slugOf(record)}-${Number(index) + 1}`
  const maxHp = Number(record.hit_points.average)
  const enemy = {
    id,
    name: String(record.name_ru),
    ...(PORTRAITS.has(`/assets/enemies/${slugOf(record)}.png`) ? { image: `/assets/enemies/${slugOf(record)}.png` } : {}),
    hp: maxHp,
    maxHp,
    armor: Number(record.armor_class.value),
    speed: Number(record.speed_ft.walk ?? 0),
    proficiency: Number(record.proficiency_bonus),
    initiativeBonus: Number(record.initiative_bonus),
    ...(primary ? {
      attackBonus: Number(primary.attack_modifier ?? 0),
      ...(primaryDice ? { damageDice: primaryDice.sides, damageBonus: primaryDice.bonus } : { damageDice: 0, damageBonus: 0 }),
      damageType: primary.damage_type,
      attackRange: Number(primary.range_feet),
    } : {}),
    abilities: CLONE(record.abilities),
    creature_type: String(record.creature_type),
    size: String(record.size),
    saving_throws: CLONE(record.saving_throws ?? {}),
    skills: CLONE(record.skills ?? {}),
    senses: CLONE(record.senses ?? {}),
    languages: CLONE(record.languages ?? {}),
    ...(record.damage_resistances?.length ? { damage_resistances: CLONE(record.damage_resistances) } : {}),
    ...(record.damage_immunities?.length ? { damage_immunities: CLONE(record.damage_immunities) } : {}),
    ...(record.damage_vulnerabilities?.length ? { damage_vulnerabilities: CLONE(record.damage_vulnerabilities) } : {}),
    ...(record.condition_immunities?.length ? { condition_immunities: CLONE(record.condition_immunities) } : {}),
    traits,
    action_profiles: profiles,
    attack_profile: primary,
    ...(spellcasting ? { spellcasting } : {}),
    ...((record.actions ?? []).some((action) => !['weapon_attack', 'multiattack'].includes(action.kind))
      ? { special_actions: CLONE(record.actions.filter((action) => !['weapon_attack', 'multiattack'].includes(action.kind))) }
      : {}),
    stat_block_id: String(record.id),
    source_url: String(record.source_url),
    challenge_rating: String(record.challenge_rating),
    xp: Number(record.xp),
    mechanics_status: limitations.length ? 'partial' : 'verified',
    ...(limitations.length ? { limitations } : {}),
    x: Number(position?.x),
    y: Number(position?.y),
    alive: true,
  }
  return enemy
}

export { diceParts as parseMonsterDamage, recordLimitations as monsterLimitationsFor }
