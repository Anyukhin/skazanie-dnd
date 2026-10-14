// Эталон server/character-progression.mjs: node gen-character-progression.mjs
import { readFileSync } from 'node:fs'

import * as m from '../../../../server/character-progression.mjs'
import { product, recorder } from './record.mjs'

const r = recorder('character-progression')
const payload = JSON.parse(readFileSync(new URL('../../../../data/dndsu-class-build-rules-1-12.json', import.meta.url), 'utf8'))
const classKeys = payload.classes.map((entry) => entry.classKey)
const skillIds = payload.skills.map((entry) => entry.id)

// Сводные вызовы: один актор — список значений второго аргумента, ответ —
// массив результатов в том же порядке (иначе эталон раздувается копиями актора).
const skillTable = (actor, skills) => skills.map((skill) => m.isSkillProficient(actor, skill))
const featureTable = (actor, features) => features.map((feature) => m.isOptionalFeatureSelected(actor, feature))

r.constant('CHARACTER_RULES_PROVENANCE', m.CHARACTER_RULES_PROVENANCE)
r.call('classBuildCatalogInfo', m.classBuildCatalogInfo)

// Класс по полю и по словам роли.
const roles = [
  'Варвар', 'бард', 'Жрец · ур. 3', 'Друид', 'Воин', 'монах', 'Паладин', 'Следопыт', 'Плут', 'разбойник', 'Чародейка', 'Колдун',
  'Волшебник', 'маг', 'Маг огня', 'магистр', 'маг1', 'mag', 'Wizard', 'BARBARIAN', 'sorcerer', 'Sorcery', 'ranger', 'воин-маг',
  'Неизвестный', '', 'monk fighter',
]
const actors = [undefined, null, {}, 'wizard', []]
for (const key of [...classKeys, 'FIGHTER', ' fighter', 'Fighter', 'artificer', 5, null]) actors.push({ characterClass: key })
for (const role of roles) actors.push({ role })
actors.push({ class: 'Паладин' }, { role: 'Воин', characterClass: 'wizard' }, { role: 'Воин', characterClass: 'unknown' }, { role: { a: 1 } })
for (const actor of actors) {
  r.call('characterClassKey', m.characterClassKey, actor)
  r.call('classSkillRuleFor', m.classSkillRuleFor, actor)
  r.call('abilityScoreChoiceLevelsFor', m.abilityScoreChoiceLevelsFor, actor)
}

// Написание навыков.
const spellings = [...skillIds, ...skillIds.map((id) => id.replaceAll('_', '-')), 'Animal-Handling', ' sleight_of_hand ', 'SLEIGHT-OF-HAND', 'animal handling', 'unknown', '', null, undefined, 5]
for (const value of spellings) {
  r.call('catalogSkillId', m.catalogSkillId, value)
  r.call('skillAbility', m.skillAbility, value)
}

// Классовые навыки: выбор из списка, повторы, чужие навыки, лимит.
for (const classKey of [...classKeys, 'unknown']) {
  const rule = payload.classes.find((entry) => entry.classKey === classKey)
  const own = rule?.skills ?? []
  const foreign = skillIds.filter((id) => !own.includes(id))
  const selections = [
    undefined, null, 'athletics', [], own, [...own].reverse(), own.slice(0, 1), [...own, ...own],
    own.map((id) => id.replaceAll('_', '-')), [foreign[0], ...own], [null, 5, own[0]], foreign.slice(0, 3),
  ]
  for (const selection of selections) {
    const actor = { characterClass: classKey, classSkillProficiencies: selection }
    if (selection === undefined) delete actor.classSkillProficiencies
    r.call('normalizedClassSkillProficiencies', m.normalizedClassSkillProficiencies, actor)
    r.call('isSkillProficient*', skillTable, actor, [...skillIds, 'animal-handling', 'SLEIGHT-OF-HAND', 'unknown'])
  }
}

// Группы особенностей по классам, уровням и подклассам.
const groups = payload.featureChoiceGroups
const subclasses = [undefined, ...new Set(groups.map((group) => group.subclass).filter(Boolean)), 'мастер  боевых-искусств', 'Мастёр боевых искусств', 'Чемпион']
const levels = [undefined, null, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 20, -3, 2.5, '7', 'x']
for (const [classKey, level, subclass] of product(classKeys, levels, subclasses)) {
  const actor = { characterClass: classKey, level }
  if (subclass !== undefined) actor.subclass = subclass
  r.call('featureChoiceGroupsFor', m.featureChoiceGroupsFor, actor)
}
r.call('featureChoiceGroupsFor', m.featureChoiceGroupsFor, { characterClass: 'fighter', level: 5, subClass: 'Мастер боевых искусств' })
r.call('featureChoiceGroupsFor', m.featureChoiceGroupsFor, { characterClass: 'fighter', level: 5, archetype: 'Мастер боевых искусств' })
r.call('featureChoiceGroupsFor', m.featureChoiceGroupsFor, { characterClass: 'fighter', level: 5, subclass: null, archetype: 'Мастер боевых искусств' })

// Выбранные особенности: все варианты групп, лимиты, чужие и пустые.
const allOptionIds = groups.flatMap((group) => group.options.map((option) => option.id))
for (const classKey of classKeys) {
  const own = groups.filter((group) => group.classKey === classKey).flatMap((group) => group.options.map((option) => option.id))
  const selections = [undefined, [], own, [...own].reverse(), own.slice(0, 2), allOptionIds, ['beguiling-influence', 'pact-tome'], [null, 'null', 7]]
  for (const [selection, level, subclass] of product(selections, [1, 3, 7, 12], [undefined, 'Мастер боевых искусств'])) {
    const actor = { characterClass: classKey, level, classSkillProficiencies: ['arcana'] }
    if (subclass !== undefined) actor.subclass = subclass
    if (selection !== undefined) actor.selectedFeatureIds = selection
    r.call('normalizedSelectedFeatureIds', m.normalizedSelectedFeatureIds, actor)
    r.call('isOptionalFeatureSelected*', featureTable, actor, [...own.slice(0, 4), 'beguiling-influence', 'unknown-feature', null, 5])
    r.call('isSkillProficient*', skillTable, actor, ['deception', 'persuasion', 'arcana'])
  }
}
r.write('character-progression.json')
