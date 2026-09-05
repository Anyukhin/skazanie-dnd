import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ABILITY_IDS,
  PHB_MARTIAL_ADEPT_MANEUVER_IDS,
  PHB_2014_FEATS,
  PHB_CANTRIPS,
  PHB_FIRST_LEVEL_SPELLS,
  PHB_RITUALS,
  characterCreationFeatFor,
  listCharacterCreationFeats,
  resolveCharacterCreationFeat,
} from '../server/character-creation-feats.mjs'

const fullContext = {
  abilities: { str: 14, dex: 14, con: 14, int: 14, wis: 14, cha: 14 },
  proficiency: { armor: ['light', 'medium', 'heavy'], weapons: ['longsword'] },
  canCastSpells: true,
  languages: [],
}

test('каталог содержит ровно 42 черты PHB 2014 и не смешивает книги', () => {
  assert.equal(PHB_2014_FEATS.length, 42)
  assert.equal(new Set(PHB_2014_FEATS.map((feat) => feat.id)).size, 42)
  assert.ok(PHB_2014_FEATS.every((feat) => feat.source === 'PHB2014'))
  assert.ok(PHB_2014_FEATS.every((feat) => feat.mechanics_status === 'partial'))
  assert.ok(PHB_2014_FEATS.some((feat) => feat.id === 'magic-initiate'))
  assert.ok(PHB_2014_FEATS.some((feat) => feat.id === 'ritual-caster'))
  assert.equal(characterCreationFeatFor('RESILIENT').id, 'resilient')
})

test('list сохраняет все варианты и помечает требования для конкретного героя', () => {
  const list = listCharacterCreationFeats({ abilities: { str: 8, dex: 12, con: 10, int: 10, wis: 10, cha: 10 }, canCastSpells: false })
  assert.equal(list.length, 42)
  assert.equal(list.find((feat) => feat.id === 'grappler').prerequisites_met, false)
  assert.equal(list.find((feat) => feat.id === 'actor').prerequisites_met, true)
  assert.ok(Array.isArray(list.find((feat) => feat.id === 'ritual-caster').unmet_prerequisites))
})

test('ASI choices respect PHB options and the ability maximum of 20', () => {
  assert.deepEqual(resolveCharacterCreationFeat('actor').benefits.ability_increases, { cha: 1 })
  const athlete = resolveCharacterCreationFeat('athlete', { ability: 'dex' }, { abilities: { dex: 19 } })
  assert.equal(athlete.ok, true)
  assert.deepEqual(athlete.benefits.ability_increases, { dex: 1 })
  const athleteChoice = resolveCharacterCreationFeat('athlete', { ability: 'cha' }, { abilities: { cha: 10 } })
  assert.equal(athleteChoice.ok, false)
  assert.equal(athleteChoice.code, 'CHOICE_INVALID')
  const capped = resolveCharacterCreationFeat('keen-mind', {}, { abilities: { int: 20 } })
  assert.equal(capped.ok, false)
  assert.equal(capped.code, 'ABILITY_MAX_REACHED')
  assert.deepEqual(resolveCharacterCreationFeat('heavy-armor-master', {}, { proficiency: { armor: ['heavy'] } }).benefits.ability_increases, { str: 1 })
})

test('Resilient добавляет выбранный спасбросок и +1 к той же характеристике', () => {
  const result = resolveCharacterCreationFeat('resilient', { ability: 'wis' }, { abilities: { wis: 12 } })
  assert.equal(result.ok, true)
  assert.deepEqual(result.benefits.ability_increases, { wis: 1 })
  assert.deepEqual(result.benefits.saving_throw_proficiencies, ['wis'])
  assert.deepEqual(result.choices, { ability: 'wis' })
})

test('Skilled и Weapon Master требуют ровно три и четыре уникальных выбора', () => {
  const skilled = resolveCharacterCreationFeat('skilled', { skills: ['arcana', 'history'], tools: ['thieves-tools'] })
  assert.equal(skilled.ok, true)
  assert.deepEqual(skilled.benefits.skill_proficiencies, ['arcana', 'history'])
  assert.deepEqual(skilled.benefits.tool_proficiencies, ['thieves_tools'])
  const weaponMaster = resolveCharacterCreationFeat('weapon-master', { weapons: ['longsword', 'shortbow', 'rapier', 'hand-crossbow'] })
  assert.equal(weaponMaster.ok, true)
  assert.deepEqual(weaponMaster.benefits.weapon_proficiencies, ['longsword', 'shortbow', 'rapier', 'hand_crossbow'])
  assert.equal(resolveCharacterCreationFeat('weapon-master', { weapons: ['longsword', 'shortbow'] }).code, 'CHOICE_COUNT_INVALID')
  assert.equal(resolveCharacterCreationFeat('skilled', { skills: ['arcana', 'arcana', 'history'] }).code, 'CHOICE_DUPLICATE')
})

test('Magic Initiate и Ritual Caster ограничивают класс, заклинания и ритуалы PHB', () => {
  assert.ok(PHB_CANTRIPS.wizard.includes('fire-bolt'))
  assert.ok(PHB_FIRST_LEVEL_SPELLS.wizard.includes('magic-missile'))
  assert.ok(PHB_RITUALS.wizard.includes('alarm'))
  const initiate = resolveCharacterCreationFeat('magic-initiate', {
    class: 'wizard', cantrips: ['fire-bolt', 'mage-hand'], spell: 'magic-missile',
  })
  assert.equal(initiate.ok, true)
  assert.deepEqual(initiate.benefits.spellcasting, {
    source: 'magic-initiate', class_key: 'wizard', ability: 'int',
    cantrips: ['fire-bolt', 'mage-hand'], first_level_spell: 'magic-missile',
    once_per_long_rest: true, uses_spell_slots: true,
  })
  assert.equal(resolveCharacterCreationFeat('magic-initiate', {
    class: 'wizard', cantrips: ['toll-the-dead', 'mage-hand'], spell: 'magic-missile',
  }).code, 'SPELL_CHOICE_INVALID')
  const ritual = resolveCharacterCreationFeat('ritual-caster', { class: 'wizard', rituals: ['alarm', 'find-familiar'] }, { abilities: { int: 13 } })
  assert.equal(ritual.ok, true)
  assert.deepEqual(ritual.benefits.spellcasting.rituals, ['alarm', 'find-familiar'])
  assert.equal(resolveCharacterCreationFeat('ritual-caster', { class: 'wizard', rituals: ['alarm', 'find-familiar'] }, { abilities: { int: 12, wis: 12 } }).code, 'PREREQUISITE_NOT_MET')
})

test('Martial Adept принимает два разных приёма из списка Battle Master', () => {
  assert.equal(PHB_MARTIAL_ADEPT_MANEUVER_IDS.length, 16)
  const result = resolveCharacterCreationFeat('martial-adept', { maneuvers: ['precision-attack', 'riposte'] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.benefits.static.maneuvers, ['precision-attack', 'riposte'])
  assert.equal(resolveCharacterCreationFeat('martial-adept', { maneuvers: ['precision-attack'] }).code, 'CHOICE_COUNT_INVALID')
  assert.equal(resolveCharacterCreationFeat('martial-adept', { maneuvers: ['precision-attack', 'not-a-maneuver'] }).code, 'CHOICE_INVALID')
})

test('Elemental Adept, Linguist и static benefits возвращают стабильную форму', () => {
  const adept = resolveCharacterCreationFeat('elemental-adept', { damageType: 'fire' }, { canCastSpells: true })
  assert.equal(adept.ok, true)
  assert.equal(adept.benefits.static.selected_damage_type, 'fire')
  assert.equal(resolveCharacterCreationFeat('elemental-adept', { damage_type: 'fire' }, {}).code, 'PREREQUISITE_NOT_MET')
  const linguist = resolveCharacterCreationFeat('linguist', { languages: ['dwarvish', 'elvish', 'draconic'] }, { abilities: { int: 12 } })
  assert.equal(linguist.ok, true)
  assert.deepEqual(linguist.benefits.ability_increases, { int: 1 })
  assert.deepEqual(linguist.benefits.language_proficiencies, ['dwarvish', 'elvish', 'draconic'])
  const alert = resolveCharacterCreationFeat('alert')
  assert.equal(alert.ok, true)
  assert.equal(alert.benefits.initiative_bonus, 5)
  assert.equal(resolveCharacterCreationFeat('mobile').benefits.speed_bonus, 10)
  assert.equal(resolveCharacterCreationFeat('tough').benefits.hit_point_maximum_bonus_per_level, 2)
  for (const ability of ABILITY_IDS) assert.equal(Object.hasOwn(alert.benefits.ability_increases, ability), false)
})

test('требования к владению и заклинаниям проверяются до выбора', () => {
  assert.equal(resolveCharacterCreationFeat('heavily-armored', {}, {}).code, 'PREREQUISITE_NOT_MET')
  assert.equal(resolveCharacterCreationFeat('heavily-armored', {}, { proficiency: { armor: ['medium'] } }).ok, true)
  assert.equal(resolveCharacterCreationFeat('heavy-armor-master', {}, { proficiency: { armor: ['medium'] } }).code, 'PREREQUISITE_NOT_MET')
  assert.equal(resolveCharacterCreationFeat('war-caster', {}, { canCastSpells: false }).code, 'PREREQUISITE_NOT_MET')
  assert.equal(resolveCharacterCreationFeat('defensive-duelist', {}, { abilities: { dex: 12 } }).code, 'PREREQUISITE_NOT_MET')
  assert.equal(resolveCharacterCreationFeat('grappler', {}, { abilities: { str: 12 } }).code, 'PREREQUISITE_NOT_MET')
  assert.equal(resolveCharacterCreationFeat('skulker', {}, { abilities: { dex: 12 } }).code, 'PREREQUISITE_NOT_MET')
  assert.equal(resolveCharacterCreationFeat('unknown', {}, fullContext).code, 'UNKNOWN_FEAT')
})

test('результат изолирован от внутреннего каталога', () => {
  const first = resolveCharacterCreationFeat('resilient', { ability: 'con' })
  first.benefits.saving_throw_proficiencies.push('str')
  const second = resolveCharacterCreationFeat('resilient', { ability: 'con' })
  assert.deepEqual(second.benefits.saving_throw_proficiencies, ['con'])
  const listed = listCharacterCreationFeats()
  listed.find((feat) => feat.id === 'athlete').choice_schema.ability.options.push('cha')
  assert.deepEqual(characterCreationFeatFor('athlete').choice_schema.ability.options, ['str', 'dex'])
})
