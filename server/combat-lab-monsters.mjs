import { MONSTER_SPELL_AT_WILL, canonicalCombatSpellFor } from './combat-spells.mjs'
import { monsterAreaAction } from './monster-actions.mjs'

// Портрет привязан к полному ID проверенного статблока. Имена файлов
// не выводятся из пользовательского ввода или другой редакции.
export const DND_2014_MONSTER_IMAGES = Object.freeze({
  'dnd_5e_2014:monster:goblin': '/assets/enemies/goblin.png',
  'dnd_5e_2014:monster:kobold': '/assets/enemies/kobold.png',
  'dnd_5e_2014:monster:hobgoblin': '/assets/enemies/hobgoblin.png',
  'dnd_5e_2014:monster:bugbear': '/assets/enemies/bugbear.png',
  'dnd_5e_2014:monster:orc': '/assets/enemies/orc.png',
  'dnd_5e_2014:monster:bandit': '/assets/enemies/bandit.png',
  'dnd_5e_2014:monster:bandit-captain': '/assets/enemies/bandit-captain.png',
  'dnd_5e_2014:monster:guard': '/assets/enemies/dnd-2014/guard.png',
  'dnd_5e_2014:monster:cultist': '/assets/enemies/dnd-2014/cultist.png',
  'dnd_5e_2014:monster:cult-fanatic': '/assets/enemies/dnd-2014/cult-fanatic.png',
  'dnd_5e_2014:monster:acolyte': '/assets/enemies/dnd-2014/acolyte.png',
  'dnd_5e_2014:monster:mage': '/assets/enemies/dnd-2014/mage.png',
  'dnd_5e_2014:monster:skeleton': '/assets/enemies/skeleton.png',
  'dnd_5e_2014:monster:zombie': '/assets/enemies/zombie.png',
  'dnd_5e_2014:monster:ghoul': '/assets/enemies/ghoul.png',
  'dnd_5e_2014:monster:ogre': '/assets/enemies/ogre.png',
  'dnd_5e_2014:monster:troll': '/assets/enemies/dnd-2014/troll.png',
  'dnd_5e_2014:monster:wolf': '/assets/enemies/wolf.png',
  'dnd_5e_2014:monster:dire-wolf': '/assets/enemies/dire-wolf.png',
  'dnd_5e_2014:monster:giant-spider': '/assets/enemies/giant-spider.png',
  'dnd_5e_2014:monster:mimic': '/assets/enemies/dnd-2014/mimic.png',
  'dnd_5e_2014:monster:gelatinous-cube': '/assets/enemies/dnd-2014/gelatinous-cube.png',
  'dnd_5e_2014:monster:owlbear': '/assets/enemies/owlbear.png',
  'dnd_5e_2014:monster:young-red-dragon': '/assets/enemies/dnd-2014/young-red-dragon.png',
  'dnd_5e_2014:monster:gnoll': '/assets/enemies/gnoll-warrior.png',
  'dnd_5e_2014:monster:harpy': '/assets/enemies/dnd-2014/harpy.png',
  'dnd_5e_2014:monster:giant-boar': '/assets/enemies/giant-boar.png',
  'dnd_5e_2014:monster:minotaur': '/assets/enemies/dnd-2014/minotaur.png',
  'dnd_5e_2014:monster:veteran': '/assets/enemies/warrior-veteran.png',
  'dnd_5e_2014:monster:manticore': '/assets/enemies/manticore.png',
  'dnd_5e_2014:monster:hill-giant': '/assets/enemies/hill-giant.png',
  'dnd_5e_2014:monster:fire-elemental': '/assets/enemies/dnd-2014/fire-elemental.png',
  'dnd_5e_2014:monster:displacer-beast': '/assets/enemies/dnd-2014/displacer-beast.png',
  'dnd_5e_2014:monster:wyvern': '/assets/enemies/wyvern.png',
  'dnd_5e_2014:monster:commoner': '/assets/enemies/dnd-2014/commoner.png',
  'dnd_5e_2014:monster:crawling-claw': '/assets/enemies/dnd-2014/crawling-claw.png',
  'dnd_5e_2014:monster:homunculus': '/assets/enemies/dnd-2014/homunculus.png',
  'dnd_5e_2014:monster:lemure': '/assets/enemies/dnd-2014/lemure.png',
  'dnd_5e_2014:monster:awakened-shrub': '/assets/enemies/dnd-2014/awakened-shrub.png',
  'dnd_5e_2014:monster:giant-fire-beetle': '/assets/enemies/dnd-2014/giant-fire-beetle.png',
  'dnd_5e_2014:monster:hyena': '/assets/enemies/dnd-2014/hyena.png',
  'dnd_5e_2014:monster:jackal': '/assets/enemies/dnd-2014/jackal.png',
  'dnd_5e_2014:monster:spider': '/assets/enemies/dnd-2014/spider.png',
  'dnd_5e_2014:monster:scorpion': '/assets/enemies/dnd-2014/scorpion.png',
  'dnd_5e_2014:monster:animated-armor': '/assets/enemies/animated-armor.png',
  'dnd_5e_2014:monster:brown-bear': '/assets/enemies/brown-bear.png',
  'dnd_5e_2014:monster:imp': '/assets/enemies/dnd-2014/imp.png',
  'dnd_5e_2014:monster:lion': '/assets/enemies/lion.png',
  'dnd_5e_2014:monster:specter': '/assets/enemies/dnd-2014/specter.png',
  'dnd_5e_2014:monster:berserker': '/assets/enemies/berserker.png',
  'dnd_5e_2014:monster:ghast': '/assets/enemies/dnd-2014/ghast.png',
  'dnd_5e_2014:monster:minotaur-skeleton': '/assets/enemies/minotaur-skeleton.png',
  'dnd_5e_2014:monster:wererat': '/assets/enemies/dnd-2014/wererat.png',
  'dnd_5e_2014:monster:basilisk': '/assets/enemies/dnd-2014/basilisk.png',
  'dnd_5e_2014:monster:hell-hound': '/assets/enemies/dnd-2014/hell-hound.png',
  'dnd_5e_2014:monster:werewolf': '/assets/enemies/dnd-2014/werewolf.png',
  'dnd_5e_2014:monster:wight': '/assets/enemies/dnd-2014/wight.png',
  'dnd_5e_2014:monster:mummy': '/assets/enemies/dnd-2014/mummy.png',
  'dnd_5e_2014:monster:banshee': '/assets/enemies/dnd-2014/banshee.png',
  'dnd_5e_2014:monster:black-pudding': '/assets/enemies/dnd-2014/black-pudding.png',
  'dnd_5e_2014:monster:ghost': '/assets/enemies/dnd-2014/ghost.png',
  'dnd_5e_2014:monster:ettin': '/assets/enemies/ettin.png',
  'dnd_5e_2014:monster:succubus': '/assets/enemies/dnd-2014/succubus.png',
  'dnd_5e_2014:monster:red-dragon-wyrmling': '/assets/enemies/dnd-2014/red-dragon-wyrmling.png',
  'dnd_5e_2014:monster:chuul': '/assets/enemies/dnd-2014/chuul.png',
  'dnd_5e_2014:monster:couatl': '/assets/enemies/dnd-2014/couatl.png',
  'dnd_5e_2014:monster:flameskull': '/assets/enemies/dnd-2014/flameskull.png',
  'dnd_5e_2014:monster:helmed-horror': '/assets/enemies/dnd-2014/helmed-horror.png',
  'dnd_5e_2014:monster:air-elemental': '/assets/enemies/dnd-2014/air-elemental.png',
  'dnd_5e_2014:monster:earth-elemental': '/assets/enemies/earth-elemental.png',
  'dnd_5e_2014:monster:water-elemental': '/assets/enemies/dnd-2014/water-elemental.png',
  'dnd_5e_2014:monster:flesh-golem': '/assets/enemies/dnd-2014/flesh-golem.png',
  'dnd_5e_2014:monster:vampire-spawn': '/assets/enemies/dnd-2014/vampire-spawn.png',
  'dnd_5e_2014:monster:barbed-devil': '/assets/enemies/barbed-devil.png',
  'dnd_5e_2014:monster:gorgon': '/assets/enemies/dnd-2014/gorgon.png',
  'dnd_5e_2014:monster:chimera': '/assets/enemies/dnd-2014/chimera.png',
  'dnd_5e_2014:monster:cyclops': '/assets/enemies/dnd-2014/cyclops.png',
  'dnd_5e_2014:monster:medusa': '/assets/enemies/dnd-2014/medusa.png',
  'dnd_5e_2014:monster:mammoth': '/assets/enemies/dnd-2014/mammoth.png',
  'dnd_5e_2014:monster:vrock': '/assets/enemies/dnd-2014/vrock.png',
  'dnd_5e_2014:monster:drider': '/assets/enemies/dnd-2014/drider.png',
  'dnd_5e_2014:monster:young-white-dragon': '/assets/enemies/dnd-2014/young-white-dragon.png',
  'dnd_5e_2014:monster:young-brass-dragon': '/assets/enemies/dnd-2014/young-brass-dragon.png',
})

function imagesFor2014(record) {
  const primary = DND_2014_MONSTER_IMAGES[String(record?.id ?? '')]
  if (!primary) return []
  return record.id === 'dnd_5e_2014:monster:goblin' ? [primary, '/assets/enemies/goblin-minion.png'] : [primary]
}

function imageFor2014(record, index = 0) {
  const images = imagesFor2014(record)
  return images[Math.abs(Math.trunc(Number(index) || 0)) % Math.max(1, images.length)] ?? null
}

const CLONE = (value) => value == null ? value : structuredClone(value)
const MIXED_MODE_WEAPONS = new Set(['dagger', 'javelin', 'spear', 'handaxe', 'hand-axe', 'dart', 'net'])
const SUPPORTED_TRAITS = new Set([
  'pack-tactics',
  'martial-advantage',
  'surprise-attack',
  'undead-fortitude',
  'aggressive',
  'web-walker',
])
const SUPPORTED_ON_HIT_KEYS = new Set([
  'save_ability', 'save_dc', 'condition', 'duration', 'damage_expression',
  'damage_type', 'half_on_save', 'target_size_max',
])
const SUPPORTED_ON_HIT_CONDITIONS = new Set(['grappled', 'poisoned', 'prone', 'restrained', 'paralyzed'])
const MOVEMENT_LABELS = Object.freeze({ fly: 'полёта', climb: 'лазания', swim: 'плавания', burrow: 'рытья' })

function slugOf(record) {
  return String(record?.id ?? '').split(':').at(-1) || 'monster'
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))]
}

// Тактические метки — производная от полного MM14-статблока. Они не заменяют
// числовую механику и нужны только планировщику/подбору состава стычки: один и
// тот же профиль остаётся источником истины для атаки, ОЗ и CR.
export function monsterRolesFor(record) {
  const actions = Array.isArray(record?.actions) ? record.actions : []
  const traits = Array.isArray(record?.traits) ? record.traits : []
  const profiles = actions.filter((action) => action.kind === 'weapon_attack')
  const hasMelee = profiles.some((action) => weaponModes(action).includes('melee'))
  const hasRanged = profiles.some((action) => weaponModes(action).includes('ranged'))
  const hasMultiattack = actions.some((action) => action.kind === 'multiattack')
  const hasArea = actions.some((action) => action.kind === 'save_area')
  const hasSpecial = actions.some((action) => action.kind === 'special')
  const hasSpellcasting = Boolean(record?.spellcasting)
  const ids = new Set(traits.map((trait) => String(trait.id ?? '')))
  const spellIds = new Set((record?.spellcasting?.spell_slots ?? []).flatMap((slot) => (
    Array.isArray(slot?.spells) ? slot.spells.map((spell) => String(spell.key ?? '')) : []
  )))
  const roles = []
  if (hasSpellcasting) roles.push('caster')
  if (spellIds.has('bless') || spellIds.has('cure-wounds') || spellIds.has('healing-word') || spellIds.has('sanctuary')) roles.push('support')
  if (hasArea || hasSpecial || profiles.some((action) => action.on_hit)) roles.push('controller')
  if (hasRanged) roles.push('artillery')
  if (hasMelee) roles.push('frontliner')
  if (hasMultiattack) roles.push('multiattack')
  if (Number(record?.speed_ft?.fly ?? 0) > 0) roles.push('flying')
  if (Number(record?.speed_ft?.walk ?? 0) >= 40 || ids.has('pack-tactics') || ids.has('surprise-attack')) roles.push('skirmisher')
  if (ids.has('surprise-attack') || ids.has('false-appearance') || ids.has('shapechanger')) roles.push('ambusher')
  if (['large', 'huge', 'gargantuan'].includes(String(record?.size ?? '')) || Number(record?.abilities?.str ?? 0) >= 18) roles.push('brute')
  if (Number(record?.xp ?? 0) <= 50) roles.push('minion')
  if (Number(record?.xp ?? 0) >= 1_800 || Number(record?.challenge_rating ?? 0) >= 5) roles.push('solo')
  return unique(roles.length ? roles : ['frontliner'])
}

export function monsterAttackModesFor(record) {
  return unique((record?.actions ?? [])
    .filter((action) => action.kind === 'weapon_attack')
    .flatMap((action) => weaponModes(action)))
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
  const failure = source.on_failure && typeof source.on_failure === 'object' ? source.on_failure : {}
  const save = source.save && typeof source.save === 'object' ? source.save : {}
  const condition = source.condition ?? failure.condition ?? (typeof source.on_failure === 'string' ? source.on_failure : null)
  const result = {}
  const saveAbility = source.save_ability ?? save.ability
  const saveDc = source.dc ?? source.save_dc ?? save.dc
  if (saveAbility) result.save_ability = String(saveAbility)
  if (saveDc != null) result.save_dc = Number(saveDc)
  // Неизвестный эффект и выбор «захват вместо урона» не становятся состоянием
  // поверх обычного удара. Исходное правило остаётся в полном статблоке.
  const complexGrapple = source.max_grappled_targets || source.while_grappled || source.cannot_constrict_another_target
  if (SUPPORTED_ON_HIT_CONDITIONS.has(condition) && !source.instead_of_damage && !complexGrapple) result.condition = condition
  const minutes = Number(source.duration_minutes ?? (failure.duration === '1_minute' ? 1 : 0))
  const hours = Number(source.duration_hours ?? 0)
  if (minutes > 0 || hours > 0) {
    result.duration = `rounds:${Math.max(1, Math.ceil(minutes * 10 + hours * 600))}`
    result.duration_minutes = minutes + hours * 60
  }
  else if (source.duration != null && source.duration !== 'until-extinguished') result.duration = CLONE(source.duration)
  const repeated = source.repeat_save ?? failure.repeat_save
  if (repeated && (typeof repeated === 'string' ? repeated.includes('end_') : repeated.timing?.includes('end_'))) result.repeat_save_timing = 'turn-end'
  const exclusions = source.excluded_targets ?? []
  result.excluded_targets = unique([...exclusions,
    ...((source.target_restrictions ?? []).some(value => ['non_undead_creature', 'non_undead'].includes(value)) ? ['undead'] : []),
    ...(source.target_restrictions?.includes('non_elf') ? ['elf'] : []),
  ])
  if (!result.excluded_targets.length) delete result.excluded_targets
  if (source.requires_target === 'humanoid') result.required_target_type = 'humanoid'
  if (source.target_size_max) result.target_size_max = source.target_size_max
  if (source.at_0_hp_from_poison) result.poison_on_zero = CLONE(source.at_0_hp_from_poison)
  // Горение тикает на последующем ходу; это не дополнительный немедленный урон.
  if (source.duration !== 'until-extinguished' && condition !== 'burning') {
    const extra = source.damage && typeof source.damage === 'object' ? source.damage : secondaryDamage
    if (source.damage_expression || extra?.expression) {
      result.damage_expression = String(source.damage_expression ?? extra.expression)
      result.damage_type = String(source.damage_type ?? extra.type)
      result.damage_on_save = Boolean(saveAbility)
    }
    if (source.half_on_save || source.save_success === 'half_damage') result.half_on_save = true
  }
  return result.condition || result.damage_expression ? result : null
}

function mapWeaponAction(action, mode, firstMode) {
  const damage = Array.isArray(action.damage) ? action.damage : []
  const primary = damage[0] ?? null
  const ranged = mode === 'ranged'
  const parsed = diceParts(ranged && action.ranged_damage ? action.ranged_damage : primary?.expression)
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
    profile.damage_amount = Number.isSafeInteger(primary?.amount) ? primary.amount : 0
  }

  const extraDamage = damage.slice(1).find((entry) => diceParts(entry?.expression)) ?? null
  const onHit = mapOnHit(action.on_hit, extraDamage)
  if (onHit) profile.on_hit = onHit
  if (damage.length > 1) profile.damage_components = CLONE(damage)
  if (action.recharge?.success?.length) profile.recharge = Number(action.recharge.success[0])
  if (action.uses != null) profile.uses = Number(action.uses)
  if (action.recharge?.group) profile.recharge_group = String(action.recharge.group)
  if (action.target === 'one_prone_creature') profile.target_condition = 'prone'
  if (action.on_hit?.target_restrictions?.includes('willing')) profile.target_any_conditions = ['grappled', 'incapacitated', 'restrained']
  if (action.attack_type) profile.attack_type = String(action.attack_type)
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
    ...(action.conditions ? { sequence_conditions: CLONE(action.conditions) } : {}),
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
  for (const group of source.innate_spells ?? []) {
    for (const spell of group.spells ?? []) {
      const id = String(spell.key ?? '')
      if (id) spells.set(id, { id, uses: group.uses === 'at-will' ? MONSTER_SPELL_AT_WILL : Number(group.uses) })
    }
  }
  return {
    ability: String(source.ability),
    save_dc: Number(source.save_dc),
    attack_bonus: source.attack_modifier == null ? Math.floor((Number(record.abilities[source.ability]) - 10) / 2) + Number(record.proficiency_bonus) : Number(source.attack_modifier),
    spells: [...spells.values()],
    // Исходная таблица общих ячеек 2014 нужна наблюдателю и
    // `monsterSpellcastingFor`, который задаёт реальные пулы ресурсов.
    spell_slots: CLONE(source.spell_slots ?? []),
    caster_level: source.caster_level == null ? Math.max(1, Number(record.challenge_rating) || 1) : Number(source.caster_level),
    class: String(source.class ?? ''),
  }
}

function specialActionLimitations(record) {
  return (record.actions ?? [])
    .filter((action) => !['weapon_attack', 'multiattack'].includes(action.kind) && !monsterAreaAction(action))
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
    if (onHit?.condition && !SUPPORTED_ON_HIT_CONDITIONS.has(String(onHit.condition))) {
      limitations.push(`Состояние «${String(onHit.condition)}» после попадания «${action.name_ru ?? action.id}» записано, но его отдельный обработчик не подключён.`)
    }
    if (onHit?.duration === 'until-extinguished') {
      limitations.push(`Продолжительный эффект «${action.name_ru ?? action.id}» до тушения записан, но периодический урон движком не тикает.`)
    }
    if (onHit && Object.keys(onHit).some((key) => !SUPPORTED_ON_HIT_KEYS.has(key) && !['dc', 'on_failure', 'damage', 'save_success'].includes(key))) {
      limitations.push(`Дополнительные условия удара «${action.name_ru ?? action.id}» перенесены частично.`)
    }
    if ((action.damage ?? []).length > 2 || ((action.damage ?? []).length > 1 && onHit?.damage
      && !action.damage.slice(1).some(component => component.expression === onHit.damage.expression && component.type === onHit.damage.type))) {
      limitations.push(`Несколько независимых компонентов урона «${action.name_ru ?? action.id}» требуют отдельного обработчика.`)
    }
  }
  return limitations
}

function auxiliaryLimitations(record) {
  const limitations = []
  const extraSpeeds = Object.entries(record.speed_ft ?? {})
    .filter(([mode, value]) => mode !== 'walk' && Number(value) > 0)
    .map(([mode, value]) => `${MOVEMENT_LABELS[mode] ?? mode} ${Number(value)} футов`)
  if (extraSpeeds.length) {
    limitations.push(!record.speed_ft.walk && record.speed_ft.fly
      ? `Используется скорость полёта ${Number(record.speed_ft.fly)} футов на плоской карте; высота и пролёт над препятствиями пока не моделируются.`
      : `Дополнительная скорость (${extraSpeeds.join(', ')}) сохранена в профиле, но планировщик NPC пока использует только скорость ходьбы.`)
  }
  for (const action of record.bonus_actions ?? []) {
    if (action.id === 'aggressive') continue
    if (action.id === 'nimble-escape') {
      limitations.push('Ловкое бегство позволяет отойти бонусным действием; скрытность бонусным действием пока не выбирается автоматически.')
      continue
    }
    limitations.push(`Бонусное действие «${action.name_ru ?? action.id}» статблока сохранено, но пока не исполняется планировщиком NPC.`)
  }
  for (const reaction of record.reactions ?? []) {
    limitations.push(`Реакция «${reaction.name_ru ?? reaction.id}» статблока сохранена, но пока не исполняется планировщиком NPC.`)
  }
  for (const action of record.legendary_actions ?? []) {
    limitations.push(`Легендарное действие «${action.name_ru ?? action.id}» статблока сохранено, но пока не исполняется планировщиком NPC.`)
  }
  for (const action of record.lair_actions ?? []) {
    limitations.push(`Действие логова «${action.name_ru ?? action.id}» статблока сохранено, но пока не исполняется планировщиком NPC.`)
  }
  return limitations
}

function recordLimitations(record) {
  const limitations = [
    ...traitLimitations(record),
    ...specialActionLimitations(record),
    ...onHitLimitations(record),
    ...auxiliaryLimitations(record),
  ]
  if (['damage_resistances', 'damage_immunities', 'damage_vulnerabilities'].some(key => (record[key] ?? []).some(entry => typeof entry !== 'string'))) {
    limitations.push('Защиты с особыми условиями сохранены в статблоке; пока они не применяются в автоматическом бою.')
  }
  const multiattack = (record.actions ?? []).find((action) => action.kind === 'multiattack')
  for (const entry of [...(record.spellcasting?.spell_slots ?? []), ...(record.spellcasting?.innate_spells ?? [])]) for (const known of entry.spells ?? []) {
    const spell = canonicalCombatSpellFor(known.key)
    if (!spell || !['verified', 'partial'].includes(spell.mechanicsSupport)) limitations.push(`Заклинание «${known.name_ru || spell?.name || known.key}» пока не исполняется движком.`)
    else if (spell.actionType !== 'action') limitations.push(`Заклинание «${spell.name}» с этим временем накладывания пока не выбирается тактикой NPC.`)
  }
  if (multiattack?.conditions?.some(Boolean) || (multiattack?.sequences ?? []).some(sequence => sequence.some(step => !(record.actions ?? []).some(action => action.id === step.action_id && action.kind === 'weapon_attack')))) {
    limitations.push('Условные варианты мультиатаки и замены атак особыми действиями сохранены; в бою доступны проверенные оружейные последовательности.')
  }
  return unique(limitations)
}

export function monsterCatalogEntry(record) {
  const roles = monsterRolesFor(record)
  const attackModes = monsterAttackModesFor(record)
  return {
    id: String(record.id),
    name: String(record.name_ru),
    ...(imageFor2014(record) ? { image: imageFor2014(record) } : {}),
    cr: String(record.challenge_rating),
    hp: Number(record.hit_points.average),
    ac: Number(record.armor_class.value),
    xp: Number(record.xp),
    creatureType: String(record.creature_type),
    size: String(record.size),
    roles,
    attackModes,
    habitats: unique(record.habitats ?? []),
    speed_ft: CLONE(record.speed_ft ?? {}),
    sourceUrl: String(record.source_url),
    images: imagesFor2014(record),
    statBlock: CLONE(record),
    ...(recordLimitations(record).length ? { limitations: recordLimitations(record) } : {}),
  }
}

export function enemyFrom2014(record, position, index = 0) {
  const { profiles, byAction } = actionProfileSet(record)
  const multiattack = multiattackTrait(record, byAction)
  const bonusTraits = (record.bonus_actions ?? []).filter(action => ['nimble-escape', 'aggressive'].includes(action.id)).map(CLONE)
  const traits = [...(record.traits ?? []).map(CLONE), ...bonusTraits, ...(multiattack ? [multiattack] : [])]
  const primary = profiles[0] ?? null
  const primaryDice = diceParts(primary?.damage_expression)
  const spellcasting = monsterSpellcasting(record)
  const limitations = recordLimitations(record)
  const roles = monsterRolesFor(record)
  const attackModes = monsterAttackModesFor(record)
  const id = `enemy-${slugOf(record)}-${Number(index) + 1}`
  const maxHp = Number(record.hit_points.average)
  const enemy = {
    id,
    name: String(record.name_ru),
    ...(imageFor2014(record, index) ? { image: imageFor2014(record, index) } : {}),
    hp: maxHp,
    maxHp,
    armor: Number(record.armor_class.value),
    speed: Number(record.speed_ft.walk || record.speed_ft.fly || 0),
    ...(!record.speed_ft.walk && record.speed_ft.fly ? { movement_mode: 'fly' } : {}),
    speed_ft: CLONE(record.speed_ft ?? {}),
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
    subtypes: CLONE(record.subtypes ?? []),
    size: String(record.size),
    roles,
    attack_modes: attackModes,
    habitats: unique(record.habitats ?? []),
    saving_throws: CLONE(record.saving_throws ?? {}),
    skills: CLONE(record.skills ?? {}),
    senses: CLONE(record.senses ?? {}),
    languages: CLONE(record.languages ?? {}),
    ...(record.damage_resistances?.length ? { damage_resistances: record.damage_resistances.filter((entry) => typeof entry === 'string') } : {}),
    ...(record.damage_immunities?.some(entry => typeof entry === 'string') ? { damage_immunities: CLONE(record.damage_immunities.filter(entry => typeof entry === 'string')) } : {}),
    ...(record.damage_vulnerabilities?.some(entry => typeof entry === 'string') ? { damage_vulnerabilities: CLONE(record.damage_vulnerabilities.filter(entry => typeof entry === 'string')) } : {}),
    ...(record.condition_immunities?.length ? { condition_immunities: CLONE(record.condition_immunities) } : {}),
    traits,
    bonus_actions: CLONE(record.bonus_actions ?? []),
    reactions: CLONE(record.reactions ?? []),
    legendary_actions: CLONE(record.legendary_actions ?? []),
    lair_actions: CLONE(record.lair_actions ?? []),
    action_profiles: profiles,
    attack_profile: primary,
    ...(spellcasting ? { spellcasting } : {}),
    ...((record.actions ?? []).some((action) => !['weapon_attack', 'multiattack'].includes(action.kind))
      ? { special_actions: CLONE(record.actions.filter((action) => !['weapon_attack', 'multiattack'].includes(action.kind))) }
      : {}),
    stat_block_id: String(record.id),
    provenance: {
      kind: 'server-owned-dnd-2014-stat-block',
      ruleset_id: 'dnd_5e_2014',
      stat_block_id: String(record.id),
      source_version: String(record.version),
      source_url: String(record.source_url),
      challenge_rating: String(record.challenge_rating),
      xp: Number(record.xp),
    },
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
