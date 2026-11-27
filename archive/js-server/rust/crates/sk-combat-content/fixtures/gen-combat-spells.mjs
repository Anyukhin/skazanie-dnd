import '../../../fixtures-env.mjs'
// Эталон server/combat-spells.mjs для Rust:
//
//   node rust/crates/sk-combat-content/fixtures/gen-combat-spells.mjs
//
// Герои всех 12 классов на уровнях 1–12 в обеих редакциях, с выбором
// заклинаний и без, с доменом, врождёнными заклинаниями и мусором в полях;
// каталожные карточки каждого заклинания; блоки заклинателей всего бестиария
// 2014 и синтетические. Карточки — хешами (см. common.mjs), остальное целиком.
import { readFileSync } from 'node:fs'

import * as m from '../../../../server/combat-spells.mjs'
import { enemyFrom2014 } from '../../../../server/combat-lab-monsters.mjs'
import { cardHashes, encode, hash, mulberry32, writeFixture } from './common.mjs'

const random = mulberry32(20261014)
const pick = (items) => items[Math.floor(random() * items.length)]
const sample = (items, share) => items.filter(() => random() < share)

const catalog = JSON.parse(readFileSync(new URL('../../../../data/dndsu-spells-0-6.json', import.meta.url), 'utf8')).spells
const monsters = JSON.parse(readFileSync(new URL('../../../../data/compendia/dnd_5e_2014/monsters.json', import.meta.url), 'utf8')).monsters
const CLASSES = ['barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk', 'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard']
const CASTERS = ['bard', 'cleric', 'druid', 'paladin', 'ranger', 'sorcerer', 'warlock', 'wizard']
const ABILITIES = { str: 10, dex: 14, con: 12, int: 16, wis: 16, cha: 16 }
const proficiencyFor = (level) => 2 + Math.floor((level - 1) / 4)
const ids = catalog.map((spell) => spell.id)

const heroes = []
const add = (actor, options) => heroes.push({ actor, options })

// Все классы × уровни × редакции, без выбора: каждое заклинание подготовлено.
for (const characterClass of CLASSES) {
  for (let level = 1; level <= 12; level += 1) {
    const actor = { id: `${characterClass}-${level}`, characterClass, level, abilities: ABILITIES, proficiency: proficiencyFor(level) }
    add(actor, undefined)
    add(actor, { rulesetId: 'dnd_5e_2014' })
  }
}

// Выбор известных и подготовленных: часть списка класса, чужие и мусорные id.
for (const characterClass of CASTERS) {
  for (const level of [1, 2, 3, 5, 7, 9, 11, 12]) {
    const base = { id: `${characterClass}-pick-${level}`, characterClass, level, abilities: { ...ABILITIES, int: 12 + level % 6, wis: 18, cha: 14 }, proficiency: proficiencyFor(level) }
    const own = m.combatSpellsFor(base).map((spell) => spell.id)
    const known = [...sample(own, 0.6), 'unknown-spell', own[0], pick(ids), 5, null]
    const prepared = [...sample(own, 0.5), pick(ids), own[1]]
    const ruleset = level % 2 ? { rulesetId: 'dnd_5e_2014' } : 'srd_5_2_1'
    add({ ...base, knownSpellIds: known, preparedSpellIds: prepared }, ruleset)
    add({ ...base, known_spell_ids: sample(own, 0.4), prepared_spell_ids: sample(own, 0.4) }, { ruleset_id: 'dnd_5e_2014' })
    add({ ...base, knownSpellIds: null, preparedSpellIds: 'x' }, undefined)
    add({ ...base, knownSpellIds: [], preparedSpellIds: [] }, { rulesetId: 'dnd_5e_2014' })
    add({ ...base, knownSpellIds: [...own].reverse() }, undefined)
    add({ ...base, preparedSpellIds: own }, undefined)
    add({ ...base, creationBenefits: { expanded_spells: [pick(ids), pick(ids), 'fire-bolt'] }, knownSpellIds: sample(own, 0.7) }, { rulesetId: 'dnd_5e_2014' })
    add({ ...base, creationBenefits: {} }, { rulesetId: 'dnd_5e_2014' })
  }
}

// Домены: заклинания домена подготовлены всегда; «Разрушительная волна» — только Буре.
const tempestByLevel = { 1: ['fog_cloud', 'thunderwave'], 3: ['gust-of-wind', 'shatter'], 5: ['call-lightning', 'sleet-storm'], x: ['light'], 7: 'control-water', 9: ['destructive_wave', 'INSECT-PLAGUE', null, ''] }
for (const level of [1, 3, 5, 9, 12]) {
  const cleric = { id: `tempest-${level}`, characterClass: 'cleric', level, abilities: ABILITIES, proficiency: proficiencyFor(level) }
  add({ ...cleric, subclass: 'tempest', creationBenefits: { domain_spells: ['bless', 'cure_wounds', 'destructive-wave'], domain_spells_by_level: tempestByLevel }, preparedSpellIds: ['guiding-bolt'] }, { rulesetId: 'dnd_5e_2014' })
  add({ ...cleric, creationBenefits: { class: { class_key: 'cleric', subclass: { id: 'Домен Бури' } }, domain_spells: ['destructive_wave', 'Shield_Of_Faith'], domain_spells_by_level: [['fireball'], 'x'] } }, undefined)
  add({ ...cleric, subclassId: 'cleric-domen-buri', creationBenefits: { domain_spells_by_level: tempestByLevel } }, { rulesetId: 'dnd_5e_2014' })
  add({ ...cleric, creationBenefits: { domain_spells: ['destructive-wave', 7, { id: 'x' }], domain_spells_by_level: tempestByLevel }, subclass: 'life' }, undefined)
  add({ id: `paladin-domain-${level}`, characterClass: 'paladin', level, creationBenefits: { domain_spells: ['destructive_wave', 'bless'] }, preparedSpellIds: [] }, { rulesetId: 'dnd_5e_2014' })
  add({ role: 'Паладин', level, creationBenefits: { class: { class_key: 'cleric', subclass: { id: 'tempest' } }, domain_spells: ['destructive-wave'] } }, undefined)
}

// Колдун: Мистическое копьё и договор, выбор особенностей.
for (const level of [1, 2, 3, 5, 11, 12]) {
  const warlock = { id: `warlock-inv-${level}`, characterClass: 'warlock', level, abilities: ABILITIES, proficiency: proficiencyFor(level) }
  add({ ...warlock, selectedFeatureIds: ['eldritch-spear', 'pact-tome'] }, { rulesetId: 'dnd_5e_2014' })
  add({ ...warlock, selectedFeatureIds: ['agonizing-blast'] }, undefined)
  add({ ...warlock, selectedFeatureIds: 'eldritch-spear' }, undefined)
}

// Врождённые заклинания вида и черт: ограниченные применения, круг, класс.
const innateSets = [
  [{ id: 'light' }, { id: 'hellish-rebuke', uses: 1, minimum_level: 3, cast_level: 2, ability: 'cha', class_key: 'warlock' }, { id: 'darkness', uses: '1', minimum_level: 5 }],
  [{ id: 'dancing-lights', ability: 'cha', source: 'drow' }, { id: 'faerie-fire', uses: 1, minimum_level: 3, source: 'drow' }, { id: 'darkness', uses: 1, minimum_level: 5, cast_level: 'x' }],
  ['light', null, { id: 'unknown-spell' }, { id: 'thaumaturgy', uses: 'at-will', class_key: 'cleric' }, { id: 'misty-step', uses: 2.7, cast_level: 4 }, { id: 'cure-wounds', uses: 0 }],
  [{ id: 'fire-bolt', class_key: 'wizard', ability: 'int' }, { id: 'magic-missile', uses: 1, class_key: 'wizard', ability: 'int', source: 'magic-initiate' }, { id: 'magic-missile', uses: 1, ability: 'wis' }],
]
const grantSets = [
  [{ id: 'guidance', ability: 'wis', uses: 'at-will', source: 'level-feat', class_key: 'druid' }, { id: 'cure-wounds', ability: 'wis', uses: 1, source: 'level-feat', class_key: 'druid' }],
  [{ id: 'eldritch-blast', ability: 'cha', uses: 'at-will', class_key: 'warlock' }, { id: 'hex', ability: 'cha', uses: 1, class_key: 'warlock' }],
  'ab',
  [],
]
for (const [index, characterClass] of ['fighter', 'wizard', 'cleric', 'warlock', 'druid', 'rogue', 'sorcerer', 'paladin'].entries()) {
  for (const level of [1, 3, 5, 9]) {
    const actor = { id: `innate-${characterClass}-${level}`, characterClass, level, abilities: ABILITIES, proficiency: proficiencyFor(level) }
    add({ ...actor, speciesBenefits: { innate_spells: innateSets[index % innateSets.length] }, creationSpellGrants: grantSets[(index + level) % grantSets.length] }, level % 2 ? { rulesetId: 'dnd_5e_2014' } : undefined)
    add({ ...actor, speciesBenefits: { innate_spells: 'light' }, creationSpellGrants: grantSets[index % 2], knownSpellIds: ['fire-bolt', 'eldritch-blast'] }, { rulesetId: 'dnd_5e_2014' })
  }
}

// Класс по роли и мусор в полях.
const roles = ['Жрец · ур. 3', 'Друидка', 'бард', 'Чародей', 'Колдун', 'Волшебница', 'маг', 'магa', 'Маг огня', 'Следопыт', 'Паладин', 'Воин', 'wizard apprentice', 'CLERIC', 'warlock bard', '']
for (const role of roles) {
  add({ role, level: 5, abilities: ABILITIES }, undefined)
  add({ role, level: 5, abilities: ABILITIES }, { rulesetId: 'dnd_5e_2014' })
}
const garbage = [
  null, undefined, {}, 'wizard', [], { characterClass: 'Wizard', level: 3 }, { class: 'druid', level: 4 }, { characterClass: null, class: 'bard', level: 2 },
  { characterClass: 'fighter', role: 'Волшебник', level: 5 }, { characterClass: 'wizard', level: 2.5, abilities: { int: 17 } }, { characterClass: 'paladin', level: 3.5 },
  { characterClass: 'warlock', level: 10.5 }, { characterClass: 'wizard', level: '5' }, { characterClass: 'cleric', level: -3 }, { characterClass: 'cleric', level: 0 },
  { characterClass: 'sorcerer', level: 15 }, { characterClass: 'bard', level: null }, { characterClass: 'ranger', level: 'abc' }, { characterClass: 'wizard', level: 4, abilities: { int: 'x' } },
  { characterClass: 'wizard', level: 4, abilities: { int: 25 } }, { characterClass: 'paladin', level: 1, abilities: { cha: 20 } }, { characterClass: 'paladin', level: 2, abilities: { cha: 3 } },
  { characterClass: 'cleric', level: 4, proficiency: '3', abilities: { wis: '18' } }, { characterClass: 'cleric', level: 4, proficiency: 2.5, abilities: { wis: 17.5 } },
  { characterClass: 'artificer', level: 5 }, { characterClass: 5, level: 5 }, { characterClass: 'wizard', level: 3, abilities: [] },
]
for (const actor of garbage) add(actor, undefined)

const SPELL_PROBES = ['fire-bolt', 'eldritch-blast', 'cure-wounds', 'hex', 'light', 'magic-missile', 'nope', null]
const SLOT_PROFILES = [
  { level: 3, slotResource: 'pact_slots' }, { level: 6, slotResource: 'mystic_arcanum_6' }, { level: 1, slotResource: 'species_spell_x', innateCastLevel: 3 },
  { level: 2, slotResource: 'species_spell_x', innateCastLevel: 0 }, { level: 0, slotResource: 'pact_slots' }, { level: 2, slotResource: 'spell_slots_2' }, null,
  { level: '2', slotResource: 'species_spell_x' }, { slotResource: 'pact_slots' }, { level: 4, slotResource: 'species_spell_x', innateCastLevel: '6' }, { level: 2 },
]

const heroCases = heroes.map(({ actor, options }) => ({
  actor: encode(actor),
  options: encode(options),
  cards: cardHashes(m.combatSpellsFor(actor, options)),
  rules: m.spellSelectionRulesFor(actor),
  selections: m.normalizedSpellSelectionsFor(actor),
  summary: m.heroSpellcastingSummaryFor(actor),
  slots: m.spellSlotMaximumsFor(actor),
  attack: ['int', 'wis', 'cha', 'str'].map((ability) => m.heroSpellAttackModifier(actor, ability)),
  probes: SPELL_PROBES.map((id) => hash(m.combatSpellFor(actor, id, options) ?? null)),
  fixed: SLOT_PROFILES.map((spell) => encode(m.fixedSpellSlotLevelFor(actor, spell))),
}))

// Каталожные карточки: каждое заклинание во всех формах редакции.
const RULESET_OPTIONS = [undefined, 'dnd_5e_2014', { rulesetId: 'dnd_5e_2014' }, { ruleset_id: 'dnd_5e_2014' }, { rulesetId: null, ruleset_id: 'dnd_5e_2014' }, { rulesetId: 5 }]
const canonical = ids.map((id) => ({ id, cards: RULESET_OPTIONS.map((options) => hash(m.canonicalCombatSpellFor(id, options))) }))
canonical.push({ id: 'nope', cards: RULESET_OPTIONS.map((options) => hash(m.canonicalCombatSpellFor('nope', options))) })
const FULL = ['hex', 'resistance', 'true-strike', 'blade-ward', 'hunter-s-mark', 'dominate-beast', 'dominate-person', 'sunbeam', 'bless', 'fireball', 'acid-splash', 'longstrider']
const canonicalFull = FULL.flatMap((id) => [undefined, 'dnd_5e_2014'].map((options) => ({ id, options: encode(options), card: m.canonicalCombatSpellFor(id, options) })))

// Заклинатели бестиария 2014 и синтетические блоки.
const monsterActors = []
const actorBySlug = new Map()
for (const record of monsters) {
  const enemy = enemyFrom2014(record, { x: 0, y: 0 })
  if (!enemy.spellcasting) continue
  const actor = { spellcasting: enemy.spellcasting, level: record.challenge_rating }
  monsterActors.push(actor)
  actorBySlug.set(record.id.split(':').at(-1), actor)
}
const synthetic = [
  null, {}, { spellcasting: null }, { spellcasting: [] }, { spellcasting: 'x' }, { spellcasting: {} }, { spellcasting: { spells: [] } },
  { spellcasting: { ability: 'cha', save_dc: 15, attack_bonus: 7, spells: [{ id: 'fire-bolt', uses: 'at-will' }, { id: 'fireball', uses: 2 }, { id: 'invented', uses: 1 }] } },
  { level: 7, spellcasting: { ability: 'wis', saveDc: '13', attackBonus: 5.7, class: 'Cleric', spells: [{ id: 'sacred-flame' }, { id: 'cure-wounds', uses: '3' }, { id: '' }, null, { id: 'bless', uses: -2 }, { id: 'command', uses: 1.9 }] } },
  { spellcasting: { ability: 'luck', save_dc: 0, attack_bonus: 'x', caster_level: 0, spells: [{ id: 'light', uses: null }, { id: 'shield', uses: 'x' }] } },
  {
    spellcasting: {
      ability: 'int', save_dc: 14, attack_bonus: 6, caster_level: 5, class: 'wizard', components_required: ['verbal'], components_not_required: ['somatic', 'material', 'x'],
      spell_slots: [{ level: 1, slots: 4, spells: [{ key: 'magic-missile' }, { key: 'shield' }] }, { level: 3, slots: 2, spells: [{ key: 'fireball' }] }, { level: 2, slots: '3', spells: [{ id: 'misty-step' }] }, { level: 0, slots: 9 }, { level: 10, slots: 1 }, { level: 'x' }, { level: 2.6, slots: -1, spells: [{ key: 'hold-person' }] }],
      spells: [
        { id: 'magic-missile' }, { id: 'shield', uses: 3 }, { id: 'fireball', components_required: ['material'], components_not_required: ['verbal'] }, { id: 'misty-step', level: 2 },
        { id: 'hold-person' }, { id: 'counterspell', level: 3 }, { id: 'fly', level: 4 }, { id: 'mage-hand', uses: 'at-will' }, { id: 'invented', level: 1 },
      ],
    },
  },
  { spellcasting: { class: 'warlock', spell_slots: [{ level: 5, slots: 2, spells: [{ key: 'hex' }, null] }], spells: [{ id: 'hex' }, { id: 'eldritch-blast' }] } },
  { spellcasting: { class: 'Маг', components_not_required: ['material'], spells: [{ id: 'fire-bolt', components_required: ['somatic'] }, { id: 'fireball' }, { id: 'shield', components_not_required: ['verbal', 'somatic'] }] } },
  { characterClass: 'wizard', level: 5, spellcasting: { spells: [{ id: 'fire-bolt' }] } },
]
const monsterCases = [...monsterActors, ...synthetic].map((actor) => {
  const block = m.monsterSpellcastingFor(actor)
  const spellIds = [...new Set([...(block?.spells ?? []).map((entry) => entry.id), 'fire-bolt', 'nope', ''])]
  return {
    actor: encode(actor),
    block,
    issues: m.monsterSpellcastingIssues(actor),
    slots: m.spellSlotMaximumsFor(actor),
    spells: spellIds.map((id) => ({
      id,
      entry: m.monsterSpellEntryFor(actor, id),
      refusal: m.monsterSpellRefusalFor(actor, id),
      cards: [undefined, 'dnd_5e_2014'].map((options) => {
        const card = m.monsterCombatSpellFor(actor, id, options)
        return card ? hash(card) : null
      }),
    })),
  }
})
// Полные карточки нескольких заклинателей — для разбора расхождений.
const monsterFull = ['mage', 'flameskull', 'acolyte', 'cult-fanatic'].flatMap((slug) => {
  const actor = actorBySlug.get(slug)
  if (!actor) throw new Error(`нет заклинателя ${slug}`)
  const block = m.monsterSpellcastingFor(actor)
  return (block?.spells ?? []).slice(0, 3).map((entry) => ({ slug, id: entry.id, actor, card: m.monsterCombatSpellFor(actor, entry.id, 'dnd_5e_2014') }))
})

const spent = [
  { ids: ['monster-spell-used:fireball#1', 'monster-spell-used:fireball#2', 'monster-spell-used:fire-bolt#1', 'prone'], spell: 'fireball' },
  { ids: ['monster-spell-used:fireball#1', 'monster-spell-used:fireball'], spell: 'fireball' },
  { ids: [], spell: 'fireball' },
  { ids: ['monster-spell-used:#1'], spell: '' },
]
const spentCases = spent.map(({ ids: conditionIds, spell }) => ({ ids: conditionIds, spell, count: m.monsterSpellUsesSpentIn(new Set(conditionIds), spell) }))

const summonActors = [
  null, {}, { kind: 'summon', faction: 'party', ownerId: 'hero' }, { kind: 'summon', faction: 'party', owner_id: 'hero', untargetable: true }, { kind: 'summon', faction: 'party', untargetable: true },
  { kind: 'summon', faction: 'hostile', ownerId: 'hero' }, { kind: 'summon', faction: 'hostile', owner_id: '' }, { kind: 'summon', faction: 'party', ownerId: 'hero', untargetable: 'true' },
  { kind: ['summon'], faction: 'party', ownerId: 'hero' }, { kind: 'creature', faction: 'party', ownerId: 'hero' }, { kind: 'summon', faction: 'party', ownerId: 0, owner_id: 'x' },
]
const summonCases = summonActors.map((actor) => ({ actor: encode(actor), party: m.isPartySummon(actor), hostile: m.isHostileSummon(actor), untargetable: m.isUntargetableSummon(actor) }))

writeFixture(new URL('combat-spells.json', import.meta.url), {
  constants: {
    DND_2014_TIMED_BUFF_EXPIRY_POLICY: m.DND_2014_TIMED_BUFF_EXPIRY_POLICY,
    MONSTER_SPELL_AT_WILL: m.MONSTER_SPELL_AT_WILL,
    MONSTER_SPELL_USE_CONDITION_PREFIX: m.MONSTER_SPELL_USE_CONDITION_PREFIX,
  },
  catalogInfo: [undefined, 'dnd_5e_2014', { rulesetId: 'dnd_5e_2014' }].map((options) => ({ options: encode(options), info: m.spellCatalogInfo(options) })),
  heroes: heroCases,
  canonical,
  canonicalFull,
  monsters: monsterCases,
  monsterFull,
  spent: spentCases,
  summons: summonCases,
})
