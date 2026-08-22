import catalogPayload from '../data/dndsu-spells-0-6.json'
import mechanicsOverrides from '../data/dndsu-spell-mechanics-overrides.json'
import type { CombatSpell, Player } from './types'

const defaultPartialNote = 'Сервер исполняет формализованную часть карточки; полный набор исключений и взаимодействий ещё не подтверждён.'
const defaultRulingNote = 'Карточка известна каталогу, но для её эффекта ещё нет исполняемого серверного решения.'

const fullSlots = [[], [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1]]
const halfSlots = [[], [], [2], [3], [3], [4, 2], [4, 2], [4, 3], [4, 3], [4, 3, 2], [4, 3, 2], [4, 3, 3], [4, 3, 3]]
const pactSlots = [null, [1, 1], [2, 1], [2, 2], [2, 2], [2, 3], [2, 3], [2, 4], [2, 4], [2, 5], [2, 5], [3, 5], [3, 5]] as const

type Caster = { key: string; ability: CombatSpell['spellcastingAbility']; progression: 'full' | 'half' | 'pact' }

const CANTRIPS: Record<string, number[]> = {
  bard: [0, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4],
  cleric: [0, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5],
  druid: [0, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4],
  sorcerer: [0, 4, 4, 4, 5, 5, 5, 5, 5, 5, 6, 6, 6],
  warlock: [0, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4],
  wizard: [0, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5],
}

const SPELLS_KNOWN: Record<string, number[]> = {
  bard: [0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 15],
  ranger: [0, 0, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7],
  sorcerer: [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12],
  warlock: [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11],
}

function caster(player?: Player): Caster | null {
  const explicit = player?.characterClass
  if (explicit === 'cleric') return { key: 'cleric', ability: 'wis', progression: 'full' }
  if (explicit === 'druid') return { key: 'druid', ability: 'wis', progression: 'full' }
  if (explicit === 'bard') return { key: 'bard', ability: 'cha', progression: 'full' }
  if (explicit === 'sorcerer') return { key: 'sorcerer', ability: 'cha', progression: 'full' }
  if (explicit === 'warlock') return { key: 'warlock', ability: 'cha', progression: 'pact' }
  if (explicit === 'wizard') return { key: 'wizard', ability: 'int', progression: 'full' }
  if (explicit === 'ranger') return { key: 'ranger', ability: 'wis', progression: 'half' }
  if (explicit === 'paladin') return { key: 'paladin', ability: 'cha', progression: 'half' }
  const role = String(player?.role ?? '').toLocaleLowerCase('ru')
  if (/жрец|cleric/u.test(role)) return { key: 'cleric', ability: 'wis', progression: 'full' }
  if (/друид|druid/u.test(role)) return { key: 'druid', ability: 'wis', progression: 'full' }
  if (/бард|bard/u.test(role)) return { key: 'bard', ability: 'cha', progression: 'full' }
  if (/чарод|sorcer/u.test(role)) return { key: 'sorcerer', ability: 'cha', progression: 'full' }
  if (/колдун|warlock/u.test(role)) return { key: 'warlock', ability: 'cha', progression: 'pact' }
  if (/волшеб|wizard|маг\b/u.test(role)) return { key: 'wizard', ability: 'int', progression: 'full' }
  if (/следопыт|ranger/u.test(role)) return { key: 'ranger', ability: 'wis', progression: 'half' }
  if (/паладин|paladin/u.test(role)) return { key: 'paladin', ability: 'cha', progression: 'half' }
  return null
}

const selectedIds = (player: Player | undefined, key: 'knownSpellIds' | 'preparedSpellIds') => Object.hasOwn(player ?? {}, key) ? new Set((player?.[key] ?? []).map(String)) : null

export function spellSelectionRules(player?: Player) {
  const profile = caster(player)
  if (!profile) return null
  const level = Math.max(1, Math.min(12, Number(player?.level) || 1))
  const modifier = Math.floor(((player?.abilities?.[profile.ability] ?? 10) - 10) / 2)
  const mode = profile.key === 'wizard' ? 'spellbook' : SPELLS_KNOWN[profile.key] ? 'known' : 'prepared'
  const preparedLimit = profile.key === 'paladin' ? (level < 2 ? 0 : Math.max(1, Math.floor(level / 2) + modifier))
    : mode === 'prepared' || profile.key === 'wizard' ? Math.max(1, level + modifier)
      : 0
  return {
    classKey: profile.key,
    mode,
    cantrips: CANTRIPS[profile.key]?.[level] ?? 0,
    spellsKnown: SPELLS_KNOWN[profile.key]?.[level] ?? 0,
    preparedLimit,
    spellbookMinimum: profile.key === 'wizard' ? 6 + (level - 1) * 2 : 0,
    maximumSpellLevel: profile.progression === 'full' ? fullSlots[level].length : profile.progression === 'half' ? halfSlots[level].length : level >= 11 ? 6 : pactSlots[level]?.[1] ?? 0,
  }
}

/** Имя заклинания по идентификатору каталога — для чипа концентрации. */
export function spellNameById(id: string | null | undefined): string | null {
  if (!id) return null
  const spell = (catalogPayload.spells as unknown as CombatSpell[]).find((entry) => entry.id === id)
  return spell?.name ?? null
}

export function fallbackCombatSpells(player?: Player): CombatSpell[] {
  const profile = caster(player)
  if (!profile) return []
  const level = Math.max(1, Math.min(12, Number(player?.level) || 1))
  const maximum = profile.progression === 'full' ? fullSlots[level].length : profile.progression === 'half' ? halfSlots[level].length : level >= 11 ? 6 : pactSlots[level]?.[1] ?? 0
  const known = selectedIds(player, 'knownSpellIds')
  const prepared = selectedIds(player, 'preparedSpellIds')
  const rules = spellSelectionRules(player)
  const overrides = mechanicsOverrides.spells as unknown as Record<string, Partial<CombatSpell>>
  return (catalogPayload.spells as unknown as CombatSpell[])
    .filter((spell) => (spell as CombatSpell & { classes?: string[] }).classes?.includes(profile.key) && (spell.level === 0 || spell.level <= maximum))
    .map((spell) => {
      const isPrepared = spell.level === 0 ? (known ? known.has(spell.id) : true)
        : rules?.mode === 'known' ? (known ? known.has(spell.id) : true)
          : rules?.mode === 'spellbook' ? (known ? known.has(spell.id) : true) && (prepared ? prepared.has(spell.id) : true)
            : prepared ? prepared.has(spell.id) : true
      const mechanicsOverride = overrides[spell.id]
      const mechanicsSupport = mechanicsOverride?.mechanicsSupport
        ?? (mechanicsOverride ? 'partial' : 'heuristic')
      return {
        ...spell,
        ...(mechanicsOverride ?? {}),
        mechanicsAccuracy: mechanicsOverride?.mechanicsAccuracy ?? (mechanicsOverride ? 'verified-dndsu' : 'heuristic'),
        mechanicsSupport,
        ...((mechanicsOverride?.supportNote || mechanicsSupport === 'partial' || mechanicsSupport === 'ruling-only') ? { supportNote: mechanicsOverride?.supportNote ?? (mechanicsSupport === 'partial' ? defaultPartialNote : defaultRulingNote) } : {}),
        prepared: isPrepared, spellcastingAbility: profile.ability,
        slotResource: spell.level === 0 ? undefined : profile.progression === 'pact' ? spell.level === 6 ? 'mystic_arcanum_6' : 'pact_slots' : `spell_slots_${spell.level}`,
      }
    })
}

export function fallbackSpellResources(player?: Player): Record<string, { current: number; max: number }> {
  const profile = caster(player)
  if (!profile) return {}
  const level = Math.max(1, Math.min(12, Number(player?.level) || 1))
  if (profile.progression === 'pact') {
    const pact = pactSlots[level]
    return { ...(pact ? { pact_slots: { current: pact[0], max: pact[0] } } : {}), ...(level >= 11 ? { mystic_arcanum_6: { current: 1, max: 1 } } : {}) }
  }
  const slots = profile.progression === 'full' ? fullSlots[level] : halfSlots[level]
  return Object.fromEntries(slots.map((maximum, index) => [`spell_slots_${index + 1}`, { current: maximum, max: maximum }]))
}
