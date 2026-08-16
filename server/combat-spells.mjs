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

export function canonicalCombatSpellFor(spellId) {
  const spell = SPELLS_BY_ID.get(String(spellId ?? ''))
  return spell ? clone(spell) : null
}

/**
 * Заклинатель из стат-блока — не класс и не ячейки.
 *
 * Редакция 2024 записывает магию существа двумя строками: «неограниченно» и
 * «X в день». Ячеек у стат-блока нет вовсе, поэтому ни `casterProfile`, ни
 * таблицы прогрессии выше сюда не годятся: они вывели бы существу класс по
 * имени роли («жрец культа» → полный жрец со всеми ячейками своего уровня) и
 * подарили бы ему чужую магию. Блок объявляется явно и целиком:
 *
 * ```js
 * spellcasting: {
 *   ability: 'cha', save_dc: 15, attack_bonus: 7,
 *   spells: [{ id: 'fire-bolt', uses: 'at-will' }, { id: 'fireball', uses: 2 }],
 * }
 * ```
 *
 * СЛ и бонус атаки берутся **из блока**, а не считаются из характеристик:
 * стат-блок объявляет их числом, и вывод по формуле героя разошёлся бы с
 * карточкой существа.
 */
export const MONSTER_SPELL_AT_WILL = 'at-will'

/** Маркер потраченного применения: `monster-spell-used:<spell>#<n>`. */
export const MONSTER_SPELL_USE_CONDITION_PREFIX = 'monster-spell-used:'

const SPELL_ABILITIES = Object.freeze(['str', 'dex', 'con', 'int', 'wis', 'cha'])

/** Нормализованный блок стат-блока либо `null`, если существо не заклинатель. */
export function monsterSpellcastingFor(actor) {
  const raw = actor?.spellcasting
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const spells = (Array.isArray(raw.spells) ? raw.spells : [])
    .map((entry) => {
      const id = String(entry?.id ?? '')
      if (!id) return null
      const declared = entry?.uses
      // «неограниченно» — это отсутствие предела, а не ноль применений:
      // `null` ниже читается всеми потребителями как «лимита нет».
      const perDay = declared == null || declared === MONSTER_SPELL_AT_WILL
        ? null
        : Math.max(0, Math.trunc(Number(declared) || 0))
      return { id, perDay }
    })
    .filter(Boolean)
  if (!spells.length) return null
  return {
    ability: SPELL_ABILITIES.includes(String(raw.ability)) ? String(raw.ability) : 'int',
    saveDc: Math.max(1, Math.trunc(Number(raw.save_dc ?? raw.saveDc) || 10)),
    attackBonus: Math.trunc(Number(raw.attack_bonus ?? raw.attackBonus) || 0),
    spells,
  }
}

/** Запись блока по идентификатору заклинания либо `null`. */
export function monsterSpellEntryFor(actor, spellId) {
  const block = monsterSpellcastingFor(actor)
  if (!block) return null
  const id = String(spellId ?? '')
  return block.spells.find((entry) => entry.id === id) ?? null
}

/**
 * Карточка заклинания существа: механика — каталожная, числа — из блока.
 *
 * Возвращает `null` и на «существо не заклинатель», и на «этого заклинания в
 * блоке нет», и на «блок называет заклинание, которого нет в каталоге». Три
 * разных отказа разводит `monsterSpellRefusalFor` ниже — движку нужен честный
 * код, а не общее «нельзя».
 */
export function monsterCombatSpellFor(actor, spellId) {
  const block = monsterSpellcastingFor(actor)
  if (!block) return null
  const entry = block.spells.find((candidate) => candidate.id === String(spellId ?? ''))
  const spell = entry ? SPELLS_BY_ID.get(entry.id) : null
  if (!entry || !spell) return null
  return {
    ...clone(spell),
    // Ячеек у стат-блока нет: предел записан «X в день» и считается маркерами.
    slotResource: null,
    spellcastingAbility: block.ability,
    prepared: true,
    monsterSpell: { id: entry.id, perDay: entry.perDay, saveDc: block.saveDc, attackBonus: block.attackBonus },
  }
}

/**
 * Почему существо не может произнести это заклинание. `null` — может.
 *
 * Разделение отказов принципиально: «нет в блоке» — правило («это существо так
 * не умеет»), а «нет в каталоге» — дефект самого стат-блока, и молчать о нём
 * нельзя: иначе опечатка в записи бестиария читалась бы за столом как решение
 * автора не давать существу это заклинание.
 */
export function monsterSpellRefusalFor(actor, spellId) {
  const block = monsterSpellcastingFor(actor)
  if (!block) return ['Существо не владеет магией', 'MONSTER_SPELLCASTING_ABSENT']
  const id = String(spellId ?? '')
  const entry = block.spells.find((candidate) => candidate.id === id)
  if (!entry) return ['Этого заклинания нет в стат-блоке существа', 'MONSTER_SPELL_NOT_IN_STAT_BLOCK']
  if (!SPELLS_BY_ID.has(entry.id)) {
    return [`Стат-блок называет заклинание «${entry.id}», которого нет в каталоге`, 'MONSTER_SPELL_UNKNOWN']
  }
  return null
}

/**
 * Сколько применений «X в день» уже потрачено, по маркерам состояний.
 *
 * Считают одинаково и движок (проверка предела), и планировщик (не предлагать
 * исчерпанное). Второй копии счёта быть не должно: разойдись они — планировщик
 * предлагал бы заклинание, на которое движок отвечает отказом, и весь ход
 * существа падал бы на собственном плане.
 */
export function monsterSpellUsesSpentIn(conditionIds, spellId) {
  const prefix = `${MONSTER_SPELL_USE_CONDITION_PREFIX}${String(spellId ?? '')}#`
  return [...(conditionIds ?? [])].filter((condition) => String(condition).startsWith(prefix)).length
}

/** Заклинания блока, которых каталог не знает. Пусто — блок исполним. */
export function monsterSpellcastingIssues(actor) {
  const block = monsterSpellcastingFor(actor)
  if (!block) return []
  return block.spells.filter((entry) => !SPELLS_BY_ID.has(entry.id)).map((entry) => entry.id)
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
