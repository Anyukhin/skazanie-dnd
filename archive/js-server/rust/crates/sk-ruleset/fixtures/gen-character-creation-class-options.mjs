// Эталон server/character-creation-class-options.mjs:
// node gen-character-creation-class-options.mjs
import * as m from '../../../../server/character-creation-class-options.mjs'
import { product, recorder } from './record.mjs'

const r = recorder('character-creation-class-options')
for (const name of [
  'CLASS_OPTIONS_PROVENANCE', 'PHB_2014_CLASS_KEYS', 'PHB_2014_GAMING_SETS', 'PHB_2014_OTHER_TOOLS', 'PHB_2014_TOOL_OPTIONS',
  'PHB_2014_TOOL_IDS', 'PHB_2014_TOOL_CATALOG', 'PHB_2014_MUSICAL_INSTRUMENTS', 'PHB_2014_ARTISAN_TOOLS', 'PHB_2014_DRUID_CANTRIPS',
  'PHB_2014_SKILLS', 'PHB_2014_DRACONIC_ANCESTRIES', 'PHB_2014_FAVORED_ENEMY_TYPES', 'PHB_2014_FAVORED_ENEMY_LANGUAGE_REQUIRED_TYPES',
  'PHB_2014_NATURAL_EXPLORER_TERRAINS', 'PHB_2014_CLASS_OPTIONS',
]) r.constant(name, m[name])
r.call('classOptionsCatalog', m.classOptionsCatalog)
r.call('classCreationOptionsCatalog', m.classCreationOptionsCatalog)
for (const key of [...m.PHB_2014_CLASS_KEYS, ' Fighter ', 'WIZARD', 'artificer', '', null, undefined, 5]) r.call('classOptionFor', m.classOptionFor, key)

// `classBenefitsFor` содержит весь ответ `validateClassChoices`; удачная
// проверка пишется отдельно лишь каждой четвёртой, чтобы не удваивать эталон.
let validCount = 0
const benefits = (classKey, choices, context) => {
  const validated = m.validateClassChoices(classKey, choices, context)
  if (!validated.ok || validCount++ % 4 === 0) r.call('validateClassChoices', m.validateClassChoices, classKey, choices, context)
  r.call('classBenefitsFor', m.classBenefitsFor, classKey, choices, context)
}

// Навыки: первые, последние, повторы, чужие, иные написания, неверное число.
const skillVariants = (classKey) => {
  const { count, options } = m.PHB_2014_CLASS_OPTIONS[classKey].skill_choice
  const foreign = m.PHB_2014_SKILLS.filter((id) => !options.includes(id))
  return [
    options.slice(0, count),
    options.slice(-count),
    options.slice(0, count).map((id) => id.replaceAll('_', '-').toUpperCase()),
    options.slice(0, count).map((id) => ` ${id.replaceAll('_', ' ')} `),
    [...options.slice(0, count - 1), options[0]],
    [...options.slice(0, count - 1), foreign[0] ?? 'arcana'],
    options.slice(0, count - 1),
    [...options.slice(0, count - 1), null],
    'athletics',
  ]
}
const skillKeys = ['skills', 'class_skills', 'classSkillProficiencies', 'skill_proficiencies']

for (const classKey of m.PHB_2014_CLASS_KEYS) {
  const valid = skillVariants(classKey)[0]
  // Навыки под разными ключами и в разных написаниях — с минимально верными
  // прочими выборами класса.
  const base = {
    bard: { instruments: ['lute', 'drum', 'bagpipes'] },
    fighter: { fighting_style: 'defense' },
    monk: { artisan_tool: 'smiths_tools' },
    rogue: { expertise: [valid[0], 'thieves_tools'] },
    ranger: { favored_enemy: { type: 'beasts' }, natural_explorer: 'forest' },
    cleric: { subclass: 'life' },
    sorcerer: { subclass: 'wild-magic' },
    warlock: { subclass: 'fiend' },
  }[classKey] ?? {}
  for (const skills of skillVariants(classKey)) {
    for (const key of skillKeys.slice(0, 2)) benefits(classKey, { ...base, [key]: skills })
  }
  benefits(classKey, { ...base, classSkillProficiencies: valid, skills: valid.slice(0, 1) })
  benefits(classKey, { ...base, skill_proficiencies: valid })
  benefits(classKey, base)
  benefits(classKey, { ...base, skills: valid, subclass: 'life' })
  benefits(classKey, { ...base, skills: valid, subclass: '   ' })
  benefits(classKey, { ...base, skills: valid, subclass: null })
  benefits(classKey, { ...base, skills: valid, domain: { id: 'x' } })
}

for (const classKey of [...m.PHB_2014_CLASS_KEYS, 'artificer', ' Bard ', null]) {
  benefits(classKey, undefined, undefined)
  benefits(classKey, null, undefined)
  benefits(classKey, [], undefined)
  benefits(classKey, 'skills', undefined)
}

// Бард: инструменты.
const bardSkills = ['performance', 'persuasion', 'history']
for (const instruments of [
  ['lute', 'drum', 'bagpipes'], ['Lute', 'pan flute', 'PAN-FLUTE'], ['lute', 'pan-flute', 'viol'], ['lute', 'lute', 'drum'], ['lute', 'drum'],
  ['lute', 'drum', 'smiths_tools'], 'lute', null, ['лютня', 'drum', 'viol'],
]) {
  for (const key of ['instruments', 'musical_instruments', 'musicalInstruments']) benefits('bard', { skills: bardSkills, [key]: instruments })
}

// Воин: боевой стиль и псевдонимы.
for (const style of [
  'archery', 'defense', 'Defence', 'защита', 'dueling', 'Дуэлянт', 'great weapon', 'Great_Weapon_Fighting', 'protection', 'оборона',
  'two weapon', 'сражение двумя оружиями', 'стрельба', 'Стрельба!', 'сражение большим оружием', 'blind fighting', '', null, 5, ['defense'],
]) {
  benefits('fighter', { skills: ['athletics', 'perception'], fighting_style: style })
  benefits('fighter', { skills: ['athletics', 'perception'], fightingStyle: style })
}
benefits('fighter', { skills: ['athletics', 'perception'] })

// Монах: инструмент или музыкальный инструмент.
const monkSkills = ['acrobatics', 'stealth']
for (const choice of [
  { artisan_tool: 'smiths_tools' }, { artisanTool: "smith's tools" }, { artisan_tool: 'lute' }, { instrument: 'lute' },
  { musical_instrument: 'Pan Flute' }, { musicalInstrument: 'smiths_tools' }, { tool_or_instrument: 'lute' },
  { tool_or_instrument: 'smiths_tools' }, { tool_or_instrument: 'nothing' }, { tool_or_instrument: { kind: 'musical_instrument', id: 'lute' } },
  { tool_or_instrument: { kind: 'artisan', id: 'lute' } }, { tool_or_instrument: { type: 'ремесленный', value: 'masons_tools' } },
  { tool_or_instrument: { kind: 'музыкальный', value: 'viol' } }, { tool_or_instrument: { kind: 'instrument', id: 'cooks_utensils' } },
  { tool_or_instrument: { kind: 'other', id: 'drum' } }, { tool_or_instrument: null }, { toolOrInstrument: ['lute'] },
  { tool_or_instrument: 'lute', instrument: 'drum' }, { artisan_tool: 'smiths_tools', instrument: 'drum' }, {},
  { artisan_tool: null }, { instrument: undefined },
]) benefits('monk', { skills: monkSkills, ...choice })

// Плут: мастерство только для полученных владений.
const rogueSkills = ['stealth', 'perception', 'investigation', 'deception']
const rogueContexts = [
  undefined, null, {}, { proficiencies: ['arcana'] }, { available_proficiencies: ['Arcana', 'lute'] }, { skill_proficiencies: ['history'] },
  { tool_proficiencies: ['smiths tools', 'thieves-tools'] }, { proficiencies: 'arcana' },
]
for (const [expertise, context] of product([
  ['stealth', 'thieves_tools'], ['stealth', 'thieves-tools'], ['Thieves Tools', 'perception'], ['stealth', 'perception'], ['arcana', 'thieves_tools'],
  ['history', 'stealth'], ['stealth', 'stealth'], ['stealth'], ['stealth', 'lute'], 'stealth', null, ['smiths_tools', 'stealth'],
], rogueContexts)) {
  benefits('rogue', { skills: rogueSkills, expertise }, context)
}
benefits('rogue', { skills: rogueSkills, expertise_proficiencies: ['stealth', 'perception'] })
benefits('rogue', { skills: rogueSkills, expertiseProficiencies: ['stealth', 'perception'] })
benefits('rogue', { skills: ['stealth', 'stealth', 'investigation', 'deception'], expertise: ['stealth', 'investigation'] })

// Следопыт: избранный враг, языки, расы и местность.
const rangerSkills = ['survival', 'perception', 'stealth']
const enemies = [
  { type: 'humanoid', races: ['orcs', 'gnolls'], language: 'orcish' }, { type: 'humanoids', races: ['orcs', 'Orcs'], language: 'orcish' },
  { type: 'humanoid', races: ['orcs'], language: 'orcish' }, { type: 'humanoid', races: ['orcs', 'gnolls'] }, { type: 'beast' },
  { type: 'beasts', races: ['wolves'] }, { type: 'dragon' }, { type: 'dragons', language: 'draconic' }, { type: 'ooze', language: 'orc' },
  { type: 'ooze', language: 'not-in-catalog' }, { enemy_type: 'fey', language: 'sylvan' }, { type: 'fiend', language: '  ' },
  { type: 'Undead' }, { type: 'giants', language: 'giant', humanoid_races: ['x', 'y'] }, { type: 'humanoids', humanoidRaces: ['elves', 'dwarves'], language: 'common' },
  { type: 'aberration', language: 'deep speech' }, { type: 'monster' }, {}, 'beasts', ['beasts'], null,
  { type: 'humanoid', races: ['orcs', '', '  gnolls  ', null], language: 'orcish' },
]
const rangerContexts = [undefined, { language_options: ['orc', 'Common', { id: 'sylvan' }, { value: 'draconic' }, [], 5] }, { languages: ['deep_speech', 'giant'] }, { language_options: 'orc' }]
for (const [enemy, context] of product(enemies, rangerContexts)) {
  benefits('ranger', { skills: rangerSkills, favored_enemy: enemy, natural_explorer: 'forest' }, context)
}
for (const flat of [
  { favored_enemy_type: 'humanoids', favored_enemy_races: ['orcs', 'gnolls'], favored_enemy_language: 'orcish' },
  { favoredEnemyType: 'beasts' }, { favoredEnemy: { type: 'plants' } }, { favored_enemy: 'beasts', favored_enemy_type: 'beasts' },
]) benefits('ranger', { skills: rangerSkills, natural_explorer: 'forest', ...flat })
for (const [terrain, key] of product(
  ['arctic', 'Coast', 'desert', 'forest', 'grassland', 'mountain', 'swamp', 'underdark', 'Underdark', 'jungle', '', null],
  ['natural_explorer', 'natural_explorer_terrain', 'naturalExplorer', 'naturalExplorerTerrain'],
)) benefits('ranger', { skills: rangerSkills, favored_enemy: { type: 'beasts' }, [key]: terrain })

// Жрец: все домены, знания и природа.
const clericSkills = ['history', 'religion']
const domains = [
  'knowledge', 'life', 'light', 'nature', 'tempest', 'trickery', 'war', 'Домен знаний', 'домен жизни', 'cleric-domen-sveta',
  'ДОМЕН ПРИРОДЫ', 'домен бури', 'Домен обмана', 'домен войны', 'forge', 'grave', '',
]
for (const [domain, key] of product(domains, ['subclass', 'domain', 'origin', 'patron'])) benefits('cleric', { skills: clericSkills, [key]: domain })
for (const knowledge of [
  { knowledge_skills: ['arcana', 'nature'], knowledge_languages: ['draconic', 'elvish'] },
  { knowledgeSkills: ['Arcana', 'history'], knowledgeLanguages: ['Draconic', ' elvish '] },
  { knowledge_skills: ['arcana'], knowledge_languages: ['draconic', 'elvish'] },
  { knowledge_skills: ['arcana', 'medicine'], knowledge_languages: ['draconic', 'elvish'] },
  { knowledge_skills: ['arcana', 'nature'], knowledge_languages: ['draconic', 'Draconic'] },
  { knowledge_skills: ['arcana', 'nature'], knowledge_languages: ['draconic'] },
  { knowledge_skills: ['arcana', 'nature'], knowledge_languages: 'draconic' },
  { knowledge_skills: ['arcana', 'nature'], knowledge_languages: ['draconic', '', 'giant'] },
  { knowledge_skills: ['arcana', 'arcana'], knowledge_languages: ['драконий', 'ёжий'] },
  {},
]) benefits('cleric', { skills: clericSkills, subclass: 'knowledge', ...knowledge })
for (const [cantrip, skill] of product(
  ['druidcraft', 'poison spray', 'Thorn-Whip', 'fire-bolt', null, undefined],
  ['survival', 'animal handling', 'Уход за животными', 'nature', 'stealth', null],
)) {
  const choices = { skills: clericSkills, subclass: 'nature' }
  if (cantrip !== undefined) choices.nature_cantrip = cantrip
  if (skill !== null) choices.nature_skill = skill
  benefits('cleric', choices)
}
benefits('cleric', { skills: clericSkills, subclass: 'nature', druid_cantrip: 'guidance', natureSkill: 'nature' })
benefits('cleric', { skills: clericSkills, subclass: 'nature', natureCantrip: 'resistance', druidCantrip: 'mending', nature_skill: 'survival' })

// Чародей: происхождения и драконий предок.
const sorcererSkills = ['arcana', 'persuasion']
for (const origin of ['draconic-bloodline', 'draconic', 'Draconic Origin', 'наследие драконьей крови', 'wild-magic', 'Дикая магия', 'wild magic origin', 'storm', null]) {
  benefits('sorcerer', { skills: sorcererSkills, origin })
}
for (const [ancestry, key] of product(
  ['black', 'blue', 'brass', 'bronze', 'copper', 'gold', 'green', 'red', 'silver', 'white', 'Красный', 'зелёный', 'ЗЕЛЕНЫЙ', 'purple', '', null],
  ['draconic_ancestry', 'ancestry', 'draconicAncestry'],
)) benefits('sorcerer', { skills: sorcererSkills, subclass: 'draconic-bloodline', [key]: ancestry })
benefits('sorcerer', { skills: sorcererSkills, subclass: 'draconic-bloodline' })
benefits('sorcerer', { skills: sorcererSkills, subclass: 'wild-magic', draconic_ancestry: 'red' })

// Колдун: покровители.
for (const patron of ['archfey', 'fiend', 'great-old-one', 'Великий Древний', 'warlock-archfey', 'Исчадие', 'great old one', 'hexblade', '']) {
  benefits('warlock', { skills: ['arcana', 'deception'], patron })
}

// Классы без подкласса на 1 уровне с лишним подклассом.
for (const classKey of ['barbarian', 'druid', 'paladin', 'wizard']) {
  for (const subclass of ['life', '  ', null, 0, false, {}, []]) benefits(classKey, { skills: m.PHB_2014_CLASS_OPTIONS[classKey].skill_choice.options.slice(0, 2), subclass })
}
r.write('character-creation-class-options.json')
