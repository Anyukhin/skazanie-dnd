// Эталон server/backgrounds.mjs: node gen-backgrounds.mjs
import * as m from '../../../../server/backgrounds.mjs'
import { product, recorder } from './record.mjs'

const r = recorder('backgrounds')
const rulesets = ['srd_5_2_1', 'dnd_5e_2014']
const rulesetArgs = [...rulesets, undefined, null, '', ' dnd_5e_2014 ', 'invented']

r.constant('PHB_BACKGROUND_VARIANTS', m.PHB_BACKGROUND_VARIANTS)
r.call('phbToolOptions', m.phbToolOptions)
r.call('backgroundCatalogInfo', m.backgroundCatalogInfo)
for (const rulesetId of rulesetArgs) r.call('backgroundCatalogFor', m.backgroundCatalogFor, rulesetId)

const catalogs = Object.fromEntries(rulesets.map((rulesetId) => [rulesetId, m.backgroundCatalogFor(rulesetId)]))
const backgroundIds = [...new Set(Object.values(catalogs).flatMap((catalog) => catalog.options.map((entry) => entry.id)))]

// Авторская предыстория 2014.
const customizations = [
  undefined, null, {}, [], 'custom', 0, false,
  { skills: ['arcana', 'history'], toolCount: 1, featureBackgroundId: 'sage' },
  { name: '  Бродяга  ', skills: ['arcana', 'history'], toolCount: 0, featureBackgroundId: 'criminal', variant: 'spy' },
  { name: 'x'.repeat(200), skills: ['stealth', 'deception'], toolCount: 2, featureBackgroundId: 'noble', variant: 'knight' },
  { name: '', skills: ['stealth', 'deception'], toolCount: 2, featureBackgroundId: 'sailor', variant: 'pirate' },
  { name: null, skills: ['athletics', 'survival'], toolCount: 2.0, featureBackgroundId: 'entertainer', variant: 'gladiator' },
  { name: 5, skills: ['athletics', 'survival'], toolCount: 1, featureBackgroundId: 'guild-artisan', variant: 'guild-merchant' },
  { skills: ['athletics', 'survival'], toolCount: 1, featureBackgroundId: 'sage', variant: 'spy' },
  { skills: ['athletics', 'survival'], toolCount: 1, featureBackgroundId: 'criminal', variant: '' },
  { skills: ['athletics'], toolCount: 1, featureBackgroundId: 'sage' },
  { skills: ['athletics', 'athletics'], toolCount: 1, featureBackgroundId: 'sage' },
  { skills: ['athletics', 'flying'], toolCount: 1, featureBackgroundId: 'sage' },
  { skills: 'athletics', toolCount: 1, featureBackgroundId: 'sage' },
  { skills: ['athletics', 'survival'], toolCount: 3, featureBackgroundId: 'sage' },
  { skills: ['athletics', 'survival'], toolCount: -1, featureBackgroundId: 'sage' },
  { skills: ['athletics', 'survival'], toolCount: 1.5, featureBackgroundId: 'sage' },
  { skills: ['athletics', 'survival'], toolCount: '1', featureBackgroundId: 'sage' },
  { skills: ['athletics', 'survival'], featureBackgroundId: 'sage' },
  { skills: ['athletics', 'survival'], toolCount: 1, featureBackgroundId: 'acolyte-2024' },
  { skills: ['athletics', 'survival'], toolCount: 1 },
  { skills: ['athletics', 'survival'], toolCount: 1, featureBackgroundId: 'sage', extra: true },
]
for (const customization of customizations) r.call('resolveBackgroundCustomization', m.resolveBackgroundCustomization, customization)

for (const [id, rulesetId] of product([...backgroundIds, 'unknown', '', null, undefined], rulesetArgs)) {
  r.call('backgroundById', m.backgroundById, id, rulesetId)
  r.call('defaultBackgroundAbilityChoice', m.defaultBackgroundAbilityChoice, id, rulesetId)
  r.call('defaultBackgroundChoices', m.defaultBackgroundChoices, id, rulesetId)
  r.call('backgroundBenefits', m.backgroundBenefits, id, undefined, undefined, rulesetId)
}
for (const [id, customization] of product(['sage', 'criminal', 'noble', 'soldier', 'unknown'], customizations)) {
  r.call('backgroundById', m.backgroundById, id, 'dnd_5e_2014', customization)
  r.call('backgroundById', m.backgroundById, id, 'srd_5_2_1', customization)
}

// Прибавки от предыстории (2024) и их отсутствие (2014).
const abilityChoices = [
  undefined, {}, { mode: 'none' }, { mode: 'two_one' }, { mode: 'one_one_one' }, { mode: 'unknown', abilities: ['int', 'wis'] },
  { mode: 'two_one', abilities: ['int', 'wis'] }, { mode: 'two_one', abilities: ['INT', 'Wis'] }, { mode: 'two_one', abilities: ['int', 'int'] },
  { mode: 'two_one', abilities: ['int'] }, { mode: 'two_one', abilities: ['str', 'dex'] }, { mode: 'two_one', abilities: ['luck', 'int'] },
  { mode: 'one_one_one', abilities: ['int', 'wis', 'cha'] }, { mode: 'one_one_one', abilities: ['str', 'con', 'dex'] },
  { mode: 'one_one_one', abilities: ['int', 'wis'] }, { abilities: ['cha', 'wis'] }, { abilities: 'int' }, { mode: 5 }, { abilities: [null, 'int'] },
]
for (const [id, rulesetId, choice] of product([...backgroundIds, 'unknown'], rulesets, abilityChoices)) {
  r.call('resolveBackgroundAbilityChoice', m.resolveBackgroundAbilityChoice, id, choice, rulesetId)
}

// Инструменты и языки.
const toolChoices = (id, rulesetId) => {
  const entry = catalogs[rulesetId].options.find((candidate) => candidate.id === id)
  const options = entry?.toolChoice?.options ?? []
  const count = Number(entry?.toolChoice?.count ?? 0)
  const languages = catalogs[rulesetId].language_options ?? []
  const languageCount = Number(entry?.languageChoiceCount ?? 0)
  const pick = (list, from, n) => list.slice(from, from + n).map((item) => item.id)
  return [
    undefined, {}, m.defaultBackgroundChoices(id, rulesetId),
    { tools: pick(options, 1, count), languages: pick(languages, 2, languageCount) },
    { tools: pick(options, 0, count + 1), languages: pick(languages, 0, languageCount) },
    { tools: pick(options, 0, count), languages: pick(languages, 0, languageCount + 1) },
    { tools: [options[0]?.id, options[0]?.id].slice(0, Math.max(count, 2)), languages: pick(languages, 0, languageCount) },
    { tools: ['not-a-tool'].slice(0, count || 1), languages: pick(languages, 0, languageCount) },
    { tools: pick(options, 0, count), languages: ['klingon'].slice(0, languageCount || 1) },
    { tools: pick(options, 0, count), languages: pick(languages, 0, languageCount), customization: { skills: ['arcana', 'history'], toolCount: 1, featureBackgroundId: 'sage' } },
    { tools: ['dice_set'], languages: [languages[0]?.id ?? 'x'], customization: { skills: ['arcana', 'history'], toolCount: 1, featureBackgroundId: 'criminal', variant: 'spy' } },
    { tools: ['dice_set', 'lute'], languages: [], customization: { skills: ['arcana', 'history'], toolCount: 2, featureBackgroundId: 'noble', variant: 'knight' } },
    { tools: [], languages: pick(languages, 0, 2), customization: { skills: ['arcana', 'history'], toolCount: 0, featureBackgroundId: 'sailor' } },
    { tools: 'lute', languages: 'common' },
  ]
}
for (const rulesetId of rulesets) {
  for (const id of [...backgroundIds, 'unknown']) {
    for (const choice of toolChoices(id, rulesetId)) {
      r.call('resolveBackgroundChoices', m.resolveBackgroundChoices, id, choice, rulesetId)
      r.call('backgroundBenefits', m.backgroundBenefits, id, undefined, choice, rulesetId)
    }
    for (const abilityChoice of abilityChoices.slice(0, 8)) r.call('backgroundBenefits', m.backgroundBenefits, id, abilityChoice, undefined, rulesetId)
  }
}
r.call('resolveBackgroundChoices', m.resolveBackgroundChoices, 'sage', { customization: { skills: ['arcana'] } }, 'dnd_5e_2014')

// Преимущества на листе героя.
const heroes = [
  undefined, null, {}, { backgroundId: 'unknown', backgroundSkillProficiencies: ['x'], backgroundBenefits: {}, name: 'Без предыстории' },
  { backgroundId: 'soldier', classSkillProficiencies: ['athletics', 'perception'] },
  { backgroundId: 'soldier', classSkillProficiencies: ['athletics', 'perception'], backgroundChoices: { tools: ['dice_set'], languages: [], replacementSkills: ['stealth', 'arcana'] } },
  { backgroundId: 'soldier', classSkillProficiencies: ['athletics', 'intimidation'], speciesSkillProficiencies: ['intimidation'], backgroundChoices: { tools: ['dice_set'], languages: [], replacementSkills: ['stealth', 'stealth', 'athletics', 'arcana', 5] } },
  { backgroundId: 'criminal', speciesBenefits: { skill_proficiencies: ['deception'] }, creationSkillProficiencies: ['sleight-of-hand'], backgroundChoices: { tools: ['dice_set'], languages: [], replacementSkills: ['arcana'] } },
  { backgroundId: 'sage', backgroundAbilityChoice: { mode: 'two_one', abilities: ['int', 'wis'] }, backgroundChoices: { tools: [], languages: ['dwarvish', 'elvish'] } },
  { backgroundId: 'sage', backgroundChoices: { tools: [], languages: ['dwarvish'] } },
  { backgroundId: 'acolyte', backgroundAbilityChoice: { mode: 'one_one_one', abilities: ['int', 'wis', 'cha'] } },
  { backgroundId: 'acolyte', classSkillProficiencies: ['insight', 'religion'], backgroundChoices: { replacementSkills: ['arcana', 'history'] } },
  { backgroundSkillProficiencies: [], backgroundBenefits: null, backgroundId: 'criminal', classSkillProficiencies: 'stealth' },
  { backgroundId: 'criminal', classSkillProficiencies: { stealth: true } },
  { backgroundId: 'criminal', speciesSkillProficiencies: 5 },
  { backgroundId: 'criminal', backgroundChoices: { tools: ['dice_set'], languages: [], replacementSkills: 'arcana' }, classSkillProficiencies: ['stealth', 'deception'] },
  { backgroundId: 'criminal', backgroundChoices: { tools: ['dice_set'], languages: [], replacementSkills: { a: 1 } } },
  { backgroundId: 'sage', backgroundChoices: null, backgroundAbilityChoice: null, speciesSkillProficiencies: null, speciesBenefits: { skill_proficiencies: ['arcana'] } },
  { backgroundId: 'criminal', backgroundChoices: { tools: ['dice_set'], languages: [], customization: { name: 'Своя', skills: ['arcana', 'history'], toolCount: 1, featureBackgroundId: 'criminal', variant: 'spy' }, replacementSkills: [] }, classSkillProficiencies: ['arcana'] },
]
for (const [hero, rulesetId] of product(heroes, rulesetArgs.slice(0, 5))) r.call('withBackgroundBenefits', m.withBackgroundBenefits, hero, rulesetId)
r.write('backgrounds.json')
