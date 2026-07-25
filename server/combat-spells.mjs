import { readFileSync } from 'node:fs'

const payload = JSON.parse(readFileSync(new URL('../data/dndsu-spells-0-6.json', import.meta.url), 'utf8'))
const overridePayload = JSON.parse(readFileSync(new URL('../data/dndsu-spell-mechanics-overrides.json', import.meta.url), 'utf8'))
const SPELL_OVERRIDES = overridePayload.spells ?? {}
const DEFAULT_PARTIAL_NOTE = 'Сервер исполняет формализованную часть карточки; полный набор исключений и взаимодействий ещё не подтверждён.'
const DEFAULT_RULING_NOTE = 'Карточка известна каталогу, но для её эффекта ещё нет исполняемого серверного решения.'
const SPELLS = Object.freeze(payload.spells.map((spell) => {
  const mechanicsOverride = SPELL_OVERRIDES[spell.id]
  const mechanicsSupport = mechanicsOverride?.mechanicsSupport
    ?? (mechanicsOverride ? 'partial' : 'heuristic')
  return Object.freeze({
    ...spell,
    ...(mechanicsOverride ?? {}),
    mechanicsAccuracy: mechanicsOverride?.mechanicsAccuracy ?? (mechanicsOverride ? 'verified-dndsu' : 'heuristic'),
    mechanicsSupport,
    ...((mechanicsOverride?.supportNote || mechanicsSupport === 'partial' || mechanicsSupport === 'ruling-only') ? { supportNote: mechanicsOverride?.supportNote ?? (mechanicsSupport === 'partial' ? DEFAULT_PARTIAL_NOTE : DEFAULT_RULING_NOTE) } : {}),
  })
}))
const SPELLS_BY_ID = new Map(SPELLS.map((spell) => [spell.id, spell]))

const clone = (value) => structuredClone(value)
const roleText = (actor) => `${actor?.role ?? ''} ${actor?.class ?? ''} ${actor?.characterClass ?? ''}`.toLocaleLowerCase('ru')

const FULL_CASTER_SLOTS = Object.freeze([
  [],
  [2],
  [3],
  [4, 2],
  [4, 3],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3, 1],
  [4, 3, 3, 2],
  [4, 3, 3, 3, 1],
  [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1],
])

const HALF_CASTER_SLOTS = Object.freeze([
  [],
  [],
  [2],
  [3],
  [3],
  [4, 2],
  [4, 2],
  [4, 3],
  [4, 3],
  [4, 3, 2],
  [4, 3, 2],
  [4, 3, 3],
  [4, 3, 3],
])

const WARLOCK_PACT = Object.freeze([
  null,
  { slots: 1, level: 1 },
  { slots: 2, level: 1 },
  { slots: 2, level: 2 },
  { slots: 2, level: 2 },
  { slots: 2, level: 3 },
  { slots: 2, level: 3 },
  { slots: 2, level: 4 },
  { slots: 2, level: 4 },
  { slots: 2, level: 5 },
  { slots: 2, level: 5 },
  { slots: 3, level: 5 },
  { slots: 3, level: 5 },
])

const CANTRIPS = Object.freeze({
  bard: [0, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4], cleric: [0, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5],
  druid: [0, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4], sorcerer: [0, 4, 4, 4, 5, 5, 5, 5, 5, 5, 6, 6, 6],
  warlock: [0, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4, 4], wizard: [0, 3, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5],
})

const SPELLS_KNOWN = Object.freeze({
  bard: [0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 15], ranger: [0, 0, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7],
  sorcerer: [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12], warlock: [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11],
})

function casterProfile(actor) {
  const explicit = String(actor?.characterClass ?? actor?.class ?? '').toLocaleLowerCase('en')
  if (explicit === 'cleric') return { key: 'cleric', ability: 'wis', progression: 'full' }
  if (explicit === 'druid') return { key: 'druid', ability: 'wis', progression: 'full' }
  if (explicit === 'bard') return { key: 'bard', ability: 'cha', progression: 'full' }
  if (explicit === 'sorcerer') return { key: 'sorcerer', ability: 'cha', progression: 'full' }
  if (explicit === 'warlock') return { key: 'warlock', ability: 'cha', progression: 'pact' }
  if (explicit === 'wizard') return { key: 'wizard', ability: 'int', progression: 'full' }
  if (explicit === 'ranger') return { key: 'ranger', ability: 'wis', progression: 'half' }
  if (explicit === 'paladin') return { key: 'paladin', ability: 'cha', progression: 'half' }
  const role = roleText(actor)
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

const boundedLevel = (actor) => Math.max(1, Math.min(12, Number(actor?.level) || 1))

function maximumSpellLevel(profile, level) {
  if (profile.progression === 'full') return FULL_CASTER_SLOTS[level]?.length ?? 0
  if (profile.progression === 'half') return HALF_CASTER_SLOTS[level]?.length ?? 0
  if (profile.progression === 'pact') return level >= 11 ? 6 : WARLOCK_PACT[level]?.level ?? 0
  return 0
}

function slotResourceForProfile(profile, spell) {
  if (spell.level === 0) return null
  if (profile.progression === 'pact') return spell.level === 6 ? 'mystic_arcanum_6' : 'pact_slots'
  return `spell_slots_${spell.level}`
}

function selectedSpellIds(actor, camel, snake) {
  const hasSelection = Object.hasOwn(actor ?? {}, camel) || Object.hasOwn(actor ?? {}, snake)
  const source = actor?.[camel] ?? actor?.[snake]
  return hasSelection ? new Set((Array.isArray(source) ? source : []).map(String)) : null
}

function boundedSelection(actor, profile, level, rules) {
  const available = SPELLS.filter((spell) => spell.classes.includes(profile.key) && (spell.level === 0 || spell.level <= rules.maximumSpellLevel))
  const byId = new Map(available.map((spell) => [spell.id, spell]))
  const rawKnown = selectedSpellIds(actor, 'knownSpellIds', 'known_spell_ids')
  const rawPrepared = selectedSpellIds(actor, 'preparedSpellIds', 'prepared_spell_ids')
  const take = (source, predicate, maximum = Number.POSITIVE_INFINITY) => source == null ? null : new Set([...source].filter((id) => predicate(byId.get(id))).slice(0, Math.max(0, maximum)))
  const cantrips = take(rawKnown, (spell) => spell?.level === 0, rules.cantrips)
  const knownMaximum = rules.mode === 'known' ? rules.spellsKnown : rules.mode === 'spellbook' ? rules.spellbookMinimum : Number.POSITIVE_INFINITY
  const leveledKnown = take(rawKnown, (spell) => Boolean(spell && spell.level > 0), knownMaximum)
  const known = rawKnown == null ? null : new Set([...(cantrips ?? []), ...(leveledKnown ?? [])])
  const prepared = take(rawPrepared, (spell) => Boolean(spell && spell.level > 0 && (rules.mode !== 'spellbook' || known == null || known.has(spell.id))), rules.preparedLimit)
  return { known, prepared }
}

export function normalizedSpellSelectionsFor(actor) {
  const profile = casterProfile(actor)
  if (!profile) return { knownSpellIds: [], preparedSpellIds: [] }
  const level = boundedLevel(actor)
  const rules = spellSelectionRulesFor(actor)
  const { known, prepared } = boundedSelection(actor, profile, level, rules)
  return {
    knownSpellIds: known == null ? undefined : [...known],
    preparedSpellIds: prepared == null ? undefined : [...prepared],
  }
}

export function spellSelectionRulesFor(actor) {
  const profile = casterProfile(actor)
  if (!profile) return null
  const level = boundedLevel(actor)
  const modifier = Math.floor(((Number(actor?.abilities?.[profile.ability]) || 10) - 10) / 2)
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
    maximumSpellLevel: maximumSpellLevel(profile, level),
  }
}

export function combatSpellsFor(actor) {
  const profile = casterProfile(actor)
  if (!profile) return []
  const level = boundedLevel(actor)
  const maximum = maximumSpellLevel(profile, level)
  const rules = spellSelectionRulesFor(actor)
  const { known, prepared } = boundedSelection(actor, profile, level, rules)
  return SPELLS
    .filter((spell) => spell.classes.includes(profile.key) && (spell.level === 0 || spell.level <= maximum))
    .map((spell) => {
      const isPrepared = spell.level === 0 ? (known ? known.has(spell.id) : true)
        : rules.mode === 'known' ? (known ? known.has(spell.id) : true)
          : rules.mode === 'spellbook' ? (known ? known.has(spell.id) : true) && (prepared ? prepared.has(spell.id) : true)
            : prepared ? prepared.has(spell.id) : true
      return { ...clone(spell), slotResource: slotResourceForProfile(profile, spell), spellcastingAbility: profile.ability, prepared: isPrepared }
    })
}

export function combatSpellFor(actor, spellId) {
  const id = String(spellId ?? '')
  if (!SPELLS_BY_ID.has(id)) return null
  const spell = combatSpellsFor(actor).find((entry) => entry.id === id) ?? null
  return spell?.prepared === false ? null : spell
}

export function spellSlotMaximumsFor(actor) {
  const profile = casterProfile(actor)
  if (!profile) return {}
  const level = boundedLevel(actor)
  if (profile.progression === 'pact') {
    const pact = WARLOCK_PACT[level]
    return {
      ...(pact ? { pact_slots: pact.slots } : {}),
      ...(level >= 11 ? { mystic_arcanum_6: 1 } : {}),
    }
  }
  const slots = profile.progression === 'full' ? FULL_CASTER_SLOTS[level] : HALF_CASTER_SLOTS[level]
  return Object.fromEntries((slots ?? []).map((maximum, index) => [`spell_slots_${index + 1}`, maximum]))
}

export function spellCatalogInfo() {
  return {
    count: SPELLS.length, source: payload.source, generatedAt: payload.generatedAt, maximumSpellLevel: 6,
    verifiedMechanics: SPELLS.filter((spell) => spell.mechanicsSupport === 'verified').length,
    partialMechanics: SPELLS.filter((spell) => spell.mechanicsSupport === 'partial').length,
    heuristicMechanics: SPELLS.filter((spell) => spell.mechanicsSupport === 'heuristic').length,
    rulingOnlyMechanics: SPELLS.filter((spell) => spell.mechanicsSupport === 'ruling-only').length,
  }
}

export function isPartySummon(actor) {
  return actor?.kind === 'summon' && actor?.faction === 'party' && Boolean(actor?.ownerId || actor?.owner_id)
}
