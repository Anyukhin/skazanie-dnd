import '../../../fixtures-env.mjs'
// Эталон server/combat-actions.mjs для Rust:
//
//   node rust/crates/sk-combat-content/fixtures/gen-combat-actions.mjs
//
// Действия, запасы и восстановление героев всех 12 классов на уровнях 1–12
// с каждым подклассом каталога, с выбором особенностей и без, с оружием
// дыхания, второй рукой, врождёнными заклинаниями и мусором в полях.
// Карточки — хешами (см. common.mjs), остальное целиком.
import { readFileSync } from 'node:fs'

import * as m from '../../../../server/combat-actions.mjs'
import { cardHashes, encode, hash, mulberry32, writeFixture } from './common.mjs'

const random = mulberry32(1_12)
const sample = (items, share) => items.filter(() => random() < share)

const catalog = JSON.parse(readFileSync(new URL('../../../../data/dndsu-class-actions-1-12.json', import.meta.url), 'utf8'))
const buildRules = JSON.parse(readFileSync(new URL('../../../../data/dndsu-class-build-rules-1-12.json', import.meta.url), 'utf8'))
const ABILITIES = { str: 16, dex: 14, con: 14, int: 12, wis: 14, cha: 15 }
const featureIdsFor = (classKey) => buildRules.featureChoiceGroups.filter((group) => group.classKey === classKey).flatMap((group) => group.options.map((option) => option.id))

const actors = []
for (const entry of catalog.classes) {
  const classKey = entry.classKey
  const subclasses = [undefined, ...entry.subclasses.map((subclass) => subclass.name)]
  const features = featureIdsFor(classKey)
  for (let level = 1; level <= 12; level += 1) {
    for (const subclass of subclasses) {
      actors.push({ id: `${classKey}-${level}`, characterClass: classKey, level, subclass, abilities: ABILITIES })
    }
    if (features.length) {
      actors.push({ characterClass: classKey, level, subclass: entry.subclasses[level % entry.subclasses.length]?.name, abilities: ABILITIES, selectedFeatureIds: sample(features, 0.4) })
      actors.push({ characterClass: classKey, level, abilities: ABILITIES, selectedFeatureIds: [] })
    }
  }
  // Подкласс по id каталога, по роли и чужой.
  actors.push({ characterClass: classKey, level: 7, subclass: entry.subclasses[0]?.id })
  actors.push({ role: `${entry.label} · ${entry.subclasses.at(-1)?.name ?? ''}`, level: 9 })
  actors.push({ characterClass: classKey, level: 7, subClass: 'чужой подкласс' })
  actors.push({ characterClass: classKey, level: 8, archetype: entry.subclasses[1]?.name?.toUpperCase() })
}

// Мастер боевых искусств с манёврами и стилем «Оборона».
const maneuvers = featureIdsFor('fighter').filter((id) => !id.startsWith('fighting-style') && id !== 'fighter-perehvat')
for (const level of [1, 2, 3, 5, 7, 9, 11]) {
  actors.push({ characterClass: 'fighter', subclass: 'Мастер боевых искусств', level, selectedFeatureIds: ['fighting-style-protection', ...maneuvers.slice(0, 3)] })
  actors.push({ characterClass: 'fighter', subclass: 'Мастер боевых искусств', level, selectedFeatureIds: ['fighting-style-defense'] })
  actors.push({ characterClass: 'paladin', level, selectedFeatureIds: ['fighting-style-protection'] })
  actors.push({ characterClass: 'fighter', level, selectedFeatureIds: 'fighting-style-protection' })
}

// Оружие дыхания, вторая рука, врождённые заклинания.
const ancestries = [
  { label: 'Красный дракон', shape: 'cone', distance_feet: 15, damage_type: 'fire', save_ability: 'dex' },
  { label: 'Синий дракон', shape: 'line', distance_feet: 30, damage_type: 'lightning' },
  { label: 'Зелёный', shape: 'cone', distance_feet: 'x', damage_type: 'poison', save_ability: null },
  {}, 'x', null,
]
for (const [index, ancestry] of ancestries.entries()) {
  actors.push({ characterClass: CLASSES_FOR(index), level: 3 + index, speciesBenefits: { source_url: index % 2 ? undefined : 'https://dnd.su/race/dragonborn', mechanics: { breath_weapon: true, dragon_ancestry: ancestry } } })
  actors.push({ characterClass: 'rogue', level: 4, speciesBenefits: { mechanics: { breath_weapon: 'true', dragon_ancestry: ancestry } } })
}
function CLASSES_FOR(index) { return catalog.classes[index % catalog.classes.length].classKey }
for (const inventory of [[{ id: 'dagger', equipped: true, equipped_slot: 'off_hand' }], [{ equipped: 'true', equipped_slot: 'off_hand' }], [{ equipped: true, equipped_slot: 'main_hand' }], 'x', null]) {
  actors.push({ characterClass: 'rogue', level: 3, inventory })
}
const innate = [
  { innate_spells: [{ id: 'hellish-rebuke', uses: 1, minimum_level: 3 }, { id: 'darkness', uses: '2', minimum_level: 5 }, { id: 'light' }, { id: 'thaumaturgy', uses: 0 }, { id: 'misty-step', uses: 2.9 }, 'x'] },
  { innate_spells: 'light' },
]
for (const benefits of innate) {
  for (const level of [1, 3, 5]) actors.push({ characterClass: 'warlock', level, speciesBenefits: benefits, creationSpellGrants: [{ id: 'cure-wounds', uses: 1 }, { uses: 1 }, { id: 'guidance', uses: 'at-will' }] })
}
actors.push({ characterClass: 'wizard', level: 4, creationSpellGrants: 'ab' })

// Мусор в полях и классы по роли.
const roles = ['Варвар', 'бард', 'Жрец · ур. 3', 'Друид круга луны', 'Воин', 'монах', 'Паладин клятвы преданности', 'Следопыт-охотник', 'Плут', 'разбойник', 'Чародейка', 'Колдун', 'Волшебник', 'маг', 'магa', 'Воин-маг', '']
for (const role of roles) actors.push({ role, level: 6 })
actors.push(
  null, undefined, {}, 'fighter', [], { characterClass: 'Fighter', level: 5 }, { class: 'monk', level: 4 }, { characterClass: 'bard', level: 2.5, abilities: { cha: 'x' } },
  { characterClass: 'bard', level: 6, abilities: { cha: 0 } }, { characterClass: 'bard', level: 6, abilities: { cha: 8 } }, { characterClass: 'paladin', level: 4, abilities: { cha: 20 } },
  { characterClass: 'paladin', level: 4, abilities: { cha: '18' } }, { characterClass: 'monk', level: '5' }, { characterClass: 'monk', level: 0 }, { characterClass: 'barbarian', level: -2 },
  { characterClass: 'sorcerer', level: 15 }, { characterClass: 'wizard', level: 'abc' }, { characterClass: 'cleric', level: 7, abilities: {} }, { characterClass: 'cleric', level: 7, abilities: { wis: 'x' } },
  { characterClass: 'artificer', level: 5 }, { characterClass: 'druid', subclass: 'Круг луны', level: 2.5 }, { characterClass: 'fighter', level: 5.5 },
)

const PROBE_IDS = ['extra-attack', 'dash', 'wild-shape', 'rage', 'breath-weapon', 'nope', null]
const actorCases = actors.map((actor) => ({
  actor: encode(actor),
  cards: cardHashes(m.combatActionsFor(actor)),
  maximums: m.combatResourceMaximumsFor(actor),
  maximums2024: m.combatResourceMaximumsFor(actor, { classResources2024: true }),
  recovery: m.combatResourceRecoveryFor(actor),
  recovery2024: m.combatResourceRecoveryFor(actor, { classResources2024: true }),
  superseded: m.supersededFeatureResourceIdsFor(actor),
  subclass: m.normalizedCombatSubclassFor(actor),
  options: hash(m.combatSubclassOptionsFor(actor)),
  attacks: m.weaponAttacksPerActionFor(actor),
  probes: PROBE_IDS.map((id) => hash(m.combatActionFor(actor, id))),
}))

// Полные карточки нескольких героев — для разбора расхождений.
const fullActors = [
  { characterClass: 'fighter', subclass: 'Мастер боевых искусств', level: 7, selectedFeatureIds: ['fighting-style-protection', 'trip-attack', 'parry', 'rally'] },
  { characterClass: 'druid', subclass: 'Круг луны', level: 7 },
  { characterClass: 'cleric', level: 12 },
  { characterClass: 'rogue', level: 5, inventory: [{ equipped: true, equipped_slot: 'off_hand' }], speciesBenefits: { mechanics: { breath_weapon: true, dragon_ancestry: ancestries[1] } } },
]
const full = fullActors.map((actor) => ({ actor, cards: m.combatActionsFor(actor) }))

const entries = [
  null, undefined, {}, { actionType: 'reaction', target: 'enemy' }, { target: 'enemy' }, { effect: { kind: 'dash' } }, { effect: { kind: 'condition' } },
  { effect: { kind: 'condition', duration: null } }, { effect: { kind: 'condition', duration: 'rounds:10' } }, { effect: { kind: 'condition', duration: 'until-next-turn' } },
  { effect: { kind: 'heal' } }, { effect: null }, { effect: { kind: 'special' } }, { effect: { kind: 'ready_action' } }, { effect: { kind: 5 } }, 0, 'x',
]
const exploration = entries.map((entry) => ({ entry: encode(entry), use: m.explorationUseFor(entry) }))

const states = [
  null, undefined, {}, { ruleset_id: 'dnd_5e_2014', enabled_house_rules: [m.CLASS_RESOURCES_2024_POLICY_ID] }, { ruleset_id: 'srd_5_2_1', enabled_house_rules: [m.CLASS_RESOURCES_2024_POLICY_ID] },
  { enabled_house_rules: [m.CLASS_RESOURCES_2024_POLICY_ID] }, { enabled_house_rules: m.CLASS_RESOURCES_2024_POLICY_ID }, { ruleset_id: 'srd_5_2_1', enabled_house_rules: ['house:x'] },
  { ruleset_id: 'srd_5_2_1', enabled_house_rules: [null, 5, m.CLASS_RESOURCES_2024_POLICY_ID] },
]
const resourceOptions = states.map((state) => ({ state: encode(state), options: m.classResourceOptionsFor(state) }))

writeFixture(new URL('combat-actions.json', import.meta.url), {
  constants: { ONE_ON_SHORT_REST: m.ONE_ON_SHORT_REST, CLASS_RESOURCES_2024_POLICY_ID: m.CLASS_RESOURCES_2024_POLICY_ID, passive: m.passiveClassFeatureIds() },
  catalogInfo: m.combatClassCatalogInfo(),
  actors: actorCases,
  full,
  exploration,
  resourceOptions,
})
