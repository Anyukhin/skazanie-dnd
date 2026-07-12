const SPELLS = Object.freeze({
  'fire-bolt': Object.freeze({
    id: 'fire-bolt',
    name: 'Огненный снаряд',
    level: 0,
    kind: 'attack',
    actionType: 'action',
    target: 'enemy',
    range: 120,
    damage: '1d10',
    damageType: 'fire',
    description: 'Дальнобойная атака заклинанием по одной цели.',
  }),
  'sacred-flame': Object.freeze({
    id: 'sacred-flame',
    name: 'Священное пламя',
    level: 0,
    kind: 'save',
    actionType: 'action',
    target: 'enemy',
    range: 60,
    saveAbility: 'dex',
    damage: '1d8',
    damageType: 'radiant',
    description: 'Цель совершает спасбросок Ловкости; при провале получает урон.',
  }),
  'cure-wounds': Object.freeze({
    id: 'cure-wounds',
    name: 'Лечение ран',
    level: 1,
    kind: 'healing',
    actionType: 'action',
    target: 'ally',
    range: 5,
    healing: '1d8',
    addAbilityModifier: true,
    slotResource: 'spell_slots_1',
    description: 'Восстанавливает хиты существу в пределах касания.',
  }),
  'healing-word': Object.freeze({
    id: 'healing-word',
    name: 'Лечащее слово',
    level: 1,
    kind: 'healing',
    actionType: 'bonus_action',
    target: 'ally',
    range: 60,
    healing: '1d4',
    addAbilityModifier: true,
    slotResource: 'spell_slots_1',
    description: 'Бонусным действием восстанавливает хиты союзнику на расстоянии.',
  }),
  'summon-beast': Object.freeze({
    id: 'summon-beast',
    name: 'Призыв зверя',
    level: 2,
    kind: 'summon',
    actionType: 'action',
    target: 'point',
    range: 90,
    concentration: true,
    slotResource: 'spell_slots_2',
    description: 'Создаёт управляемого звериного духа. Он ходит сразу после заклинателя.',
    summon: Object.freeze({
      name: 'Звериный дух',
      hp: 20,
      armor: 13,
      speed: 40,
      attackName: 'Звериный удар',
      damage: '1d8+6',
      damageType: 'piercing',
      range: 5,
    }),
  }),
})

const clone = (value) => structuredClone(value)
const roleText = (actor) => `${actor?.role ?? ''} ${actor?.class ?? ''} ${actor?.characterClass ?? ''}`.toLocaleLowerCase('ru')

function casterProfile(actor) {
  const role = roleText(actor)
  if (/жрец|cleric/u.test(role)) return { key: 'cleric', ability: 'wis', progression: 'full' }
  if (/друид|druid/u.test(role)) return { key: 'druid', ability: 'wis', progression: 'full' }
  if (/бард|bard/u.test(role)) return { key: 'bard', ability: 'cha', progression: 'full' }
  if (/чарод|sorcer/u.test(role)) return { key: 'sorcerer', ability: 'cha', progression: 'full' }
  if (/волшеб|wizard|маг\b/u.test(role)) return { key: 'wizard', ability: 'int', progression: 'full' }
  if (/следопыт|ranger/u.test(role)) return { key: 'ranger', ability: 'wis', progression: 'half' }
  if (/паладин|paladin/u.test(role)) return { key: 'paladin', ability: 'cha', progression: 'half' }
  return null
}

function permittedSpellIds(actor, profile) {
  const level = Math.max(1, Math.min(20, Number(actor?.level) || 1))
  const result = []
  if (['sorcerer', 'wizard'].includes(profile.key)) result.push('fire-bolt')
  if (profile.key === 'cleric') result.push('sacred-flame', 'cure-wounds', 'healing-word')
  if (['druid', 'ranger', 'paladin'].includes(profile.key)) result.push('cure-wounds')
  if (['druid', 'bard'].includes(profile.key)) result.push('healing-word')
  if ((profile.key === 'druid' && level >= 3) || (profile.key === 'ranger' && level >= 5)) result.push('summon-beast')
  return result
}

export function combatSpellsFor(actor) {
  const profile = casterProfile(actor)
  if (!profile) return []
  return permittedSpellIds(actor, profile).map((id) => ({
    ...clone(SPELLS[id]),
    spellcastingAbility: profile.ability,
  }))
}

export function combatSpellFor(actor, spellId) {
  return combatSpellsFor(actor).find((spell) => spell.id === String(spellId ?? '')) ?? null
}

/** Minimal slot bootstrap for the levels represented by the current board. */
export function spellSlotMaximumsFor(actor) {
  const profile = casterProfile(actor)
  if (!profile) return {}
  const level = Math.max(1, Math.min(20, Number(actor?.level) || 1))
  const full = level <= 1 ? [2] : level === 2 ? [3] : level === 3 ? [4, 2] : level === 4 ? [4, 3] : [4, 3, 2]
  const half = level <= 2 ? [2] : level <= 4 ? [3] : [4, 2]
  const slots = profile.progression === 'full' ? full : half
  return Object.fromEntries(slots.map((maximum, index) => [`spell_slots_${index + 1}`, maximum]))
}

export function isPartySummon(actor) {
  return actor?.kind === 'summon' && actor?.faction === 'party' && Boolean(actor?.ownerId || actor?.owner_id)
}

