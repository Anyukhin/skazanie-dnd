import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classBenefitsFor,
  classOptionFor,
  classOptionsCatalog,
  PHB_2014_CLASS_KEYS,
  PHB_2014_DRACONIC_ANCESTRIES,
  PHB_2014_TOOL_CATALOG,
} from '../server/character-creation-class-options.mjs'

const skillsFor = (classKey) => classOptionFor(classKey).skill_choice.options.slice(0, classOptionFor(classKey).skill_choice.count)

test('каталог содержит ровно 12 классов PHB 2014 и базовые владения', () => {
  const catalog = classOptionsCatalog()
  assert.equal(catalog.length, 12)
  assert.deepEqual(catalog.map((entry) => entry.id), PHB_2014_CLASS_KEYS)
  assert.deepEqual(classOptionFor('fighter').armor_proficiencies, ['light', 'medium', 'heavy', 'shields'])
  assert.deepEqual(classOptionFor('druid').tool_proficiencies, ['herbalism_kit'])
  assert.deepEqual(classOptionFor('rogue').tool_proficiencies, ['thieves_tools'])
  assert.deepEqual(classOptionFor('sorcerer').saving_throw_proficiencies, ['con', 'cha'])
  assert.equal(classOptionFor('druid').armor_restrictions[0], 'nonmetal')
})

test('на первом уровне доступны только PHB-подклассы жреца, чародея и колдуна', () => {
  assert.equal(classOptionFor('cleric').subclass_options.length, 7)
  assert.deepEqual(classOptionFor('cleric').subclass_options.map((entry) => entry.id), [
    'knowledge', 'life', 'light', 'nature', 'tempest', 'trickery', 'war',
  ])
  assert.equal(classOptionFor('sorcerer').subclass_options.length, 2)
  assert.deepEqual(classOptionFor('sorcerer').subclass_options.map((entry) => entry.id), ['draconic-bloodline', 'wild-magic'])
  assert.equal(classOptionFor('warlock').subclass_options.length, 3)
  assert.deepEqual(classOptionFor('warlock').subclass_options.map((entry) => entry.id), ['archfey', 'fiend', 'great-old-one'])
  assert.equal(classOptionFor('bard').subclass_options.length, 0)
  assert.equal(classBenefitsFor('cleric', { skills: skillsFor('cleric'), subclass: 'forge' }).ok, false)
})

test('бард выбирает три разных музыкальных инструмента, а монах — один инструмент одного из двух типов', () => {
  const bard = classBenefitsFor('bard', { skills: ['performance', 'persuasion', 'history'], instruments: ['lute', 'drum', 'bagpipes'] })
  assert.equal(bard.ok, true)
  assert.deepEqual(bard.tool_proficiencies, ['lute', 'drum', 'bagpipes'])
  assert.equal(classBenefitsFor('bard', { skills: skillsFor('bard'), instruments: ['lute', 'lute', 'drum'] }).ok, false)
  const monk = classBenefitsFor('monk', { skills: ['acrobatics', 'stealth'], artisan_tool: 'smiths_tools' })
  assert.equal(monk.ok, true)
  assert.deepEqual(monk.tool_proficiencies, ['smiths_tools'])
  assert.equal(classBenefitsFor('monk', { skills: ['acrobatics', 'stealth'], tool_or_instrument: { kind: 'musical_instrument', id: 'lute' } }).ok, true)
  assert.equal(classBenefitsFor('monk', { skills: ['acrobatics', 'stealth'] }).ok, false)
})

test('мастерство плута ограничено уже полученными владениями', () => {
  const valid = classBenefitsFor('rogue', {
    skills: ['stealth', 'perception', 'investigation', 'deception'],
    expertise: ['stealth', 'thieves-tools'],
  })
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.expertise, ['stealth', 'thieves_tools'])
  assert.equal(classBenefitsFor('rogue', {
    skills: ['stealth', 'perception', 'investigation', 'deception'], expertise: ['arcana', 'thieves_tools'],
  }).ok, false)
  const backgroundSkill = classBenefitsFor('rogue', {
    skills: ['stealth', 'perception', 'investigation', 'deception'], expertise: ['arcana', 'thieves_tools'],
  }, { proficiencies: ['arcana'] })
  assert.equal(backgroundSkill.ok, true)
})

test('следопыт выбирает тип врага, две расы гуманоидов и язык, а также местность', () => {
  const ranger = classBenefitsFor('ranger', {
    skills: ['survival', 'perception', 'stealth'],
    favored_enemy: { type: 'humanoid', races: ['orcs', 'gnolls'], language: 'orcish' },
    natural_explorer: 'forest',
  })
  assert.equal(ranger.ok, true)
  assert.deepEqual(ranger.favored_enemy, { type: 'humanoids', races: ['orcs', 'gnolls'], language: 'orcish' })
  assert.equal(ranger.natural_explorer, 'forest')
  assert.equal(classBenefitsFor('ranger', {
    skills: ['survival', 'perception', 'stealth'], favored_enemy: { type: 'humanoid', races: ['orcs'], language: 'orcish' }, natural_explorer: 'forest',
  }).ok, false)
  const silentEnemy = classBenefitsFor('ranger', {
    skills: ['survival', 'perception', 'stealth'], favored_enemy: { type: 'beast' }, natural_explorer: 'forest',
  })
  assert.equal(silentEnemy.ok, true)
  assert.deepEqual(silentEnemy.favored_enemy, { type: 'beasts', races: [], language: null })
  assert.deepEqual(silentEnemy.languages, [])
  assert.equal(classBenefitsFor('ranger', {
    skills: ['survival', 'perception', 'stealth'], favored_enemy: { type: 'dragon' }, natural_explorer: 'forest',
  }).ok, false)
  assert.equal(classBenefitsFor('ranger', {
    skills: ['survival', 'perception', 'stealth'], favored_enemy: { type: 'ooze', language: 'orc' }, natural_explorer: 'forest',
  }, { language_options: ['orc'] }).ok, true)
  assert.equal(classBenefitsFor('ranger', {
    skills: ['survival', 'perception', 'stealth'], favored_enemy: { type: 'ooze', language: 'not-in-catalog' }, natural_explorer: 'forest',
  }, { language_options: ['orc'] }).ok, false)
})

test('домены жреца возвращают выборы знаний или природы и отдельные доменные заклинания', () => {
  const knowledge = classBenefitsFor('cleric', {
    skills: ['history', 'religion'], subclass: 'knowledge',
    knowledge_skills: ['arcana', 'nature'], knowledge_languages: ['draconic', 'elvish'],
  })
  assert.equal(knowledge.ok, true)
  assert.deepEqual(knowledge.domain_spell_ids, ['identify', 'command'])
  assert.equal(knowledge.domain_spells_count_against_prepared_limit, false)
  assert.deepEqual(knowledge.expertise, ['arcana', 'nature'])
  const nature = classBenefitsFor('cleric', {
    skills: ['history', 'religion'], subclass: 'nature', nature_cantrip: 'druidcraft', nature_skill: 'survival',
  })
  assert.equal(nature.ok, true)
  assert.equal(nature.extra_druid_cantrip, 'druidcraft')
  assert.ok(nature.skill_proficiencies.includes('survival'))
  assert.ok(nature.armor_proficiencies.includes('heavy'))
  assert.equal(classBenefitsFor('cleric', { skills: ['history', 'religion'], subclass: 'knowledge', knowledge_skills: ['arcana'], knowledge_languages: ['draconic', 'elvish'] }).ok, false)
})

test('драконья кровь возвращает тип урона, язык, бонус ОЗ и формулу КД', () => {
  const sorcerer = classBenefitsFor('sorcerer', {
    skills: ['arcana', 'persuasion'], subclass: 'draconic-bloodline', draconic_ancestry: 'red',
  })
  assert.equal(sorcerer.ok, true)
  assert.deepEqual(sorcerer.draconic_ancestry, { id: 'red', label: 'Красный', damage_type: 'fire' })
  assert.deepEqual(sorcerer.languages, ['draconic'])
  assert.equal(sorcerer.max_hit_points_bonus_per_class_level, 1)
  assert.deepEqual(sorcerer.unarmored_armor_class, { base: 13, dexterity_modifier: true })
  assert.equal(Object.keys(PHB_2014_DRACONIC_ANCESTRIES).length, 10)
  assert.equal(classBenefitsFor('sorcerer', { skills: ['arcana', 'persuasion'], subclass: 'draconic-bloodline' }).ok, false)
})

test('каталог и результаты не дают мутировать внутренние данные', () => {
  const option = classOptionFor('barbarian')
  option.skill_choice.options.push('arcana')
  assert.equal(classOptionFor('barbarian').skill_choice.options.includes('arcana'), false)
  const result = classBenefitsFor('fighter', { skills: ['athletics', 'perception'], fighting_style: 'defense' })
  result.armor_proficiencies.push('none')
  assert.equal(classBenefitsFor('fighter', { skills: ['athletics', 'perception'], fighting_style: 'defense' }).armor_proficiencies.includes('none'), false)
})

test('полный список инструментов PHB 2014 пригоден для классовых и фоновых выборов', () => {
  assert.equal(PHB_2014_TOOL_CATALOG.filter((entry) => entry.kind === 'artisan_tool').length, 17)
  assert.equal(PHB_2014_TOOL_CATALOG.filter((entry) => entry.kind === 'musical_instrument').length, 10)
  assert.equal(PHB_2014_TOOL_CATALOG.filter((entry) => entry.kind === 'gaming_set').length, 4)
  assert.equal(PHB_2014_TOOL_CATALOG.filter((entry) => entry.kind === 'other_tool').length, 8)
  assert.ok(PHB_2014_TOOL_CATALOG.every((entry) => entry.id && entry.label))
})
