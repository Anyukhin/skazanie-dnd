import '../../../fixtures-env.mjs'
// Эталон server/character-creation-phb.mjs: node gen-character-creation-phb.mjs
//
// Сборка героя PHB 2014 для всех классов × подклассов × предысторий (и своей
// предыстории) на уровнях 1–12, все виды × все классы, вариантный человек ×
// все черты с разными выборами, отказы каждого шага и мусор на входе.
import * as m from '../../../../server/character-creation-phb.mjs'
import { classOptionFor, validateClassChoices, PHB_2014_CLASS_KEYS, PHB_2014_TOOL_IDS, PHB_2014_SKILLS } from '../../../../server/character-creation-class-options.mjs'
import { PHB_2014_FEATS, resolveCharacterCreationFeat } from '../../../../server/character-creation-feats.mjs'
import { characterCreationPolicyFor, defaultSpeciesChoices, speciesBenefitsFor } from '../../../../server/character-creation-catalog.mjs'
import { backgroundBenefits, backgroundById, backgroundCatalogFor, defaultBackgroundChoices } from '../../../../server/backgrounds.mjs'
import { recorder } from './record.mjs'

const RULESET = 'dnd_5e_2014'
const r = recorder('character-creation-phb')
const clone = (value) => structuredClone(value)

r.constant('PHB_FIGHTING_STYLES', m.PHB_FIGHTING_STYLES)
for (const id of ['tashas_hideous_laughter', 'tensers_floating_disk', 'cure_wounds', 'magic-missile', 'a_b_c', '', null, undefined, 5, ['x_y'], { a: 1 }, true]) {
  r.call('phbSpellId', m.phbSpellId, id)
}
for (const id of ['dragonchess_set', 'three_dragon_ante_set', 'playing_card_set', 'land_vehicles', 'water_vehicles', 'thieves-tools', 'smiths_tools', 'a-b-c', '', null, undefined, 7, ['x-y'], { a: 1 }, false]) {
  r.call('phbToolId', m.phbToolId, id)
}
r.call('phbFirstLevelSpells', m.phbFirstLevelSpells)
r.call('phbCreationCatalog', m.phbCreationCatalog)

const SPECIES = characterCreationPolicyFor(RULESET).species_options.map((entry) => entry.id)
const BACKGROUNDS = backgroundCatalogFor(RULESET).options.map((entry) => entry.id)
const CUSTOM_BACKGROUNDS = [
  { name: 'Странник', skills: ['arcana', 'stealth'], toolCount: 1, featureBackgroundId: 'outlander' },
  { name: '  Шпион  ', skills: ['deception', 'insight'], toolCount: 2, featureBackgroundId: 'criminal', variant: 'spy' },
  { skills: ['history', 'survival'], toolCount: 0, featureBackgroundId: 'sailor', variant: 'pirate' },
]
const STYLES = Object.keys(m.PHB_FIGHTING_STYLES)

function classChoicesFor(classId, subclass, variant = 0) {
  const klass = classOptionFor(classId)
  const skills = klass.skill_choice.options.slice(variant % 2 ? -klass.skill_choice.count : 0).slice(0, klass.skill_choice.count)
  const choices = {
    bard: { instruments: variant % 2 ? ['viol', 'shawm', 'horn'] : ['lute', 'drum', 'flute'] },
    monk: { tool_or_instrument: variant % 2 ? { kind: 'musical_instrument', id: 'lute' } : { kind: 'artisan_tool', id: 'smiths_tools' } },
    rogue: { expertise: variant % 2 ? [skills[0], 'thieves_tools'] : skills.slice(0, 2) },
    ranger: variant % 3 === 0 ? { favored_enemy: { type: 'undead', language: null }, natural_explorer: 'forest' }
      : variant % 3 === 1 ? { favored_enemy: { type: 'humanoids', races: ['orc', 'goblin'], language: 'goblin' }, natural_explorer: 'mountain' }
        : { favored_enemy: { type: 'fiends', language: 'infernal' }, natural_explorer: 'swamp' },
    sorcerer: subclass === 'draconic-bloodline' ? { draconic_ancestry: ['red', 'blue', 'gold', 'silver'][variant % 4] } : {},
    cleric: subclass === 'knowledge' ? { knowledge_skills: variant % 2 ? ['nature', 'religion'] : ['arcana', 'history'], knowledge_languages: variant % 2 ? ['sylvan', 'abyssal'] : ['draconic', 'celestial'] }
      : subclass === 'nature' ? { nature_cantrip: ['shillelagh', 'druidcraft', 'thorn_whip'][variant % 3], nature_skill: ['nature', 'survival', 'animal_handling'][variant % 3] } : {},
  }[classId] ?? {}
  return { skills, choices }
}

/**
 * Документ героя, как его собирает мастер создания: навыки класса, выборы вида
 * и предыстории по умолчанию, замены повторённых навыков и инструментов.
 */
function makeSource(classId, { speciesId = 'human', backgroundId = 'sage', customization, subclass, level = 1, feat, variant = 0, extraChoices = {}, style } = {}) {
  const { skills, choices } = classChoicesFor(classId, subclass, variant)
  const speciesChoices = defaultSpeciesChoices(speciesId, RULESET)
  const species = speciesBenefitsFor(speciesId, RULESET, speciesChoices)
  const background = backgroundById(backgroundId, RULESET, customization)
  const backgroundChoices = { ...(defaultBackgroundChoices(backgroundId, RULESET) ?? { tools: [], languages: [] }) }
  if (customization) {
    backgroundChoices.customization = customization
    backgroundChoices.tools = PHB_2014_TOOL_IDS.slice(3 + (variant % 20), 3 + (variant % 20) + customization.toolCount)
    backgroundChoices.languages = backgroundCatalogFor(RULESET).language_options.slice(5, 5 + 2 - customization.toolCount).map((entry) => entry.id)
  }
  const granted = [...skills, ...(species?.skill_proficiencies ?? []), ...(background?.skillProficiencies ?? [])]
  const known = new Set(granted)
  backgroundChoices.replacementSkills = PHB_2014_SKILLS.filter((skill) => !known.has(skill)).slice(0, granted.length - known.size)
  backgroundChoices.replacementTools = []
  const source = {
    character: 'Проверка PHB', characterClass: classId, level, experience: 0,
    abilityGeneration: {
      method: 'standard_array', baseScores: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
      originBonuses: speciesId === 'human-variant' ? { str: 1, dex: 1, con: 0, int: 0, wis: 0, cha: 0 } : { str: 2, dex: 1, con: 0, int: 0, wis: 0, cha: 0 },
      originBonusProfileId: speciesId, speciesOptionId: speciesId,
    },
    baseSpeed: 30, speciesChoices, classSkillProficiencies: skills,
    selectedFeatureIds: classId === 'fighter' ? [style ?? STYLES[variant % STYLES.length]] : [],
    ...(subclass ? { subclass } : {}),
    backgroundId, backgroundChoices,
    phbCreation: { schema_version: 1, classChoices: { ...choices, ...extraChoices }, ...(feat ? { feat } : {}) },
  }
  fixReplacementTools(source)
  return source
}

/** Повторы инструментов заменяются первыми свободными инструментами PHB. */
function fixReplacementTools(source) {
  try {
    m.resolvePhbCreation(source)
  } catch (error) {
    const match = /^Выберите (\d+) новых инструментальных владений/u.exec(error.message)
    if (!match || match[1] === '0') return
    const tools = allToolsFor(source)
    source.backgroundChoices.replacementTools = PHB_2014_TOOL_IDS.filter((id) => !tools.includes(id)).slice(0, Number(match[1]))
  }
}

function allToolsFor(source) {
  const speciesId = source.abilityGeneration.speciesOptionId
  const species = speciesBenefitsFor(speciesId, RULESET, source.speciesChoices)
  const grants = backgroundBenefits(source.backgroundId, null, source.backgroundChoices, RULESET)
  const choices = { ...source.phbCreation.classChoices, skills: source.classSkillProficiencies, ...(source.subclass ? { subclass: source.subclass } : {}) }
  if (source.characterClass === 'fighter') choices.fighting_style = m.PHB_FIGHTING_STYLES[source.selectedFeatureIds[0]]
  const classTools = validateClassChoices(source.characterClass, choices, { skill_proficiencies: [...source.classSkillProficiencies], tool_proficiencies: [] }).benefits?.tool_proficiencies ?? []
  const feat = source.phbCreation.feat ? resolveCharacterCreationFeat(source.phbCreation.feat.id, source.phbCreation.feat.choices ?? {}, {}) : null
  return [...species.tool_proficiencies, ...grants.tool_proficiencies, ...classTools, ...(feat?.benefits?.tool_proficiencies ?? [])].map(m.phbToolId)
}

const resolve = (source) => r.call('resolvePhbCreation', m.resolvePhbCreation, source)

// 1. Классы × подклассы × предыстории (вид — по кругу), уровень 1.
const subclassesOf = (classId) => {
  const klass = classOptionFor(classId)
  return klass.subclass_level === 1 ? klass.subclass_options.map((entry) => entry.id) : [undefined]
}
let counter = 0
for (const classId of PHB_2014_CLASS_KEYS) {
  for (const subclass of subclassesOf(classId)) {
    for (const backgroundId of BACKGROUNDS) {
      const speciesId = SPECIES.filter((id) => id !== 'human-variant')[counter % (SPECIES.length - 1)]
      resolve(makeSource(classId, { speciesId, backgroundId, subclass, variant: counter++ }))
    }
    for (const customization of CUSTOM_BACKGROUNDS) {
      resolve(makeSource(classId, { backgroundId: customization.featureBackgroundId, customization, subclass, variant: counter++ }))
    }
    // Уровни 2–12: мастер создаёт только героя первого уровня.
    for (let level = 2; level <= 12; level += 1) {
      resolve(makeSource(classId, { backgroundId: BACKGROUNDS[level % BACKGROUNDS.length], subclass, level, variant: level }))
    }
  }
  // Подкласс у класса, который выбирает его позже, — отказ проверки класса.
  if (classOptionFor(classId).subclass_level !== 1) resolve(makeSource(classId, { subclass: 'champion' }))
}

// 2. Все виды × все классы.
for (const speciesId of SPECIES) {
  for (const classId of PHB_2014_CLASS_KEYS) {
    const subclass = subclassesOf(classId)[counter % subclassesOf(classId).length]
    const feat = speciesId === 'human-variant' ? { id: 'alert', choices: {} } : undefined
    resolve(makeSource(classId, { speciesId, subclass, feat, backgroundId: BACKGROUNDS[counter % BACKGROUNDS.length], variant: counter++ }))
  }
}

// 3. Вариантный человек × все черты: выборы под каждую черту.
const FEAT_CHOICES = {
  athlete: [{ ability: 'str' }, { ability: 'dex' }], observant: [{ ability: 'int' }, { ability: 'wis' }],
  'tavern-brawler': [{ ability: 'con' }], 'lightly-armored': [{ ability: 'dex' }], 'moderately-armored': [{ ability: 'str' }],
  resilient: [{ ability: 'con' }, { ability: 'wis' }, { ability: 'str' }],
  'martial-adept': [{ maneuvers: ['precision-attack', 'riposte'] }, { maneuvers: ['parry'] }],
  'weapon-master': [{ weapons: ['longsword', 'shortbow', 'rapier', 'hand-crossbow'] }],
  'spell-sniper': [{ class: 'wizard', cantrip: 'fire-bolt' }, { class: 'warlock', cantrip: 'eldritch-blast' }],
  skilled: [{ skills: ['arcana', 'history'], tools: ['thieves-tools'] }, { skills: ['medicine', 'nature', 'religion'] }, { tools: ['lute', 'smiths_tools', 'dice_set'] }],
  'magic-initiate': [
    { class: 'wizard', cantrips: ['mage-hand', 'light'], spell: 'shield' }, { class: 'cleric', cantrips: ['guidance', 'sacred-flame'], spell: 'bless' },
    { class: 'warlock', cantrips: ['eldritch-blast', 'minor-illusion'], spell: 'hex' }, { class: 'druid', cantrips: ['thorn-whip', 'produce-flame'], spell: 'tasha-s-hideous-laughter' },
  ],
  'ritual-caster': [{ class: 'wizard', rituals: ['alarm', 'find-familiar'] }, { class: 'cleric', rituals: ['detect-magic', 'purify-food-and-drink'] }],
  'elemental-adept': [{ damage_type: 'fire' }, { damage_type: 'cold' }],
  linguist: [{ languages: ['orc', 'infernal', 'sylvan'] }, { languages: ['dwarvish', 'elvish', 'giant'] }, { languages: ['druidic', 'orc', 'goblin'] }],
}
const FEAT_CLASSES = ['fighter', 'wizard', 'cleric', 'rogue', 'paladin', 'warlock']
for (const feat of PHB_2014_FEATS) {
  const variants = [{}, ...(FEAT_CHOICES[feat.id] ?? [])]
  for (const [index, choices] of variants.entries()) {
    if (index === 0 && FEAT_CHOICES[feat.id]) {
      resolve(makeSource('fighter', { speciesId: 'human-variant', feat: { id: feat.id, choices }, variant: counter++ }))
      continue
    }
    for (const classId of FEAT_CLASSES) {
      const subclass = subclassesOf(classId)[counter % subclassesOf(classId).length]
      resolve(makeSource(classId, { speciesId: 'human-variant', subclass, feat: { id: feat.id, choices }, backgroundId: BACKGROUNDS[counter % BACKGROUNDS.length], variant: counter++ }))
    }
  }
}
resolve(makeSource('fighter', { speciesId: 'human-variant', feat: { id: 'TOUGH' } }))
resolve(makeSource('fighter', { speciesId: 'human-variant', feat: { id: ' tough ', choices: null } }))

// 4. Отказы и мусор на входе — от верного документа.
const base = () => makeSource('fighter', { speciesId: 'human', backgroundId: 'sage', variant: 0 })
const mutate = (fn, from = base) => {
  const source = from()
  fn(source)
  resolve(source)
}
resolve(null)
resolve(undefined)
resolve('строка')
resolve([])
resolve({})
for (const value of [null, undefined, false, 0, '', 'phb', 5, true, [], [1], { schema_version: 2 }, { schema_version: '1' }, { schema_version: 1.0 }, { schema_version: 1, extra: true },
  { schema_version: 1, equipmentMode: 'standard' }, { schema_version: 1, equipmentMode: 'wealth', wealthRollId: 'r', purchases: [] }, { schema_version: 1, equipmentMode: 'barter' },
  { schema_version: 1, equipmentMode: '' }, { schema_version: 1, equipmentMode: ['standard'] }, { schema_version: 1, classChoices: null }, { schema_version: 1, classChoices: 'ab' },
  { schema_version: 1, classChoices: [1, 2] }, { schema_version: 1, classChoices: 7 }, { schema_version: 1, backgroundEquipmentChoices: { pack: 'a' } },
  { schema_version: 1, backgroundEquipmentChoices: 0 }, { schema_version: 1, feat: { id: 'tough' } }, { schema_version: 1, feat: 'tough' }, { schema_version: 1, feat: 0 }]) {
  mutate((source) => { source.phbCreation = clone(value) })
}
for (const level of [0, 2, 20, '1', ' 1 ', '01', 1.0, 1.5, null, undefined, true, [1], ['1'], [], 'one']) {
  mutate((source) => { source.level = level })
}
for (const klass of [' Fighter ', 'FIGHTER', 'artificer', '', null, undefined, 5, ['fighter'], { id: 'fighter' }]) {
  mutate((source) => { source.characterClass = klass })
}
for (const klass of [' wizard ', 'WIZARD', 'Wizard']) mutate((source) => { source.characterClass = klass }, () => makeSource('wizard'))
for (const klass of [' Rogue', 'DRUID']) mutate((source) => { source.characterClass = klass }, () => makeSource(klass.trim().toLowerCase()))
for (const value of [null, undefined, 'human', [], {}]) mutate((source) => { source.abilityGeneration = value })
for (const value of ['elf', 'HUMAN', '', null, 5, ['human']]) mutate((source) => { source.abilityGeneration.speciesOptionId = value })
for (const value of [null, undefined, {}, { 'extra-language': ['elvish'] }, { 'extra-language': ['orc', 'giant'] }, { 'extra-language': 'elvish' }, { other: [] }, 'x', false, 0, []]) {
  mutate((source) => { source.speciesChoices = value })
}
for (const baseScores of [null, undefined, 'abc', [15, 14], { str: '15', dex: 14 }, { str: 15, dex: 'NaN', con: 13, int: 12, wis: 10, cha: 8 }]) {
  mutate((source) => { source.abilityGeneration.baseScores = baseScores })
  mutate((source) => { source.abilityGeneration.baseScores = baseScores }, () => makeSource('fighter', { speciesId: 'human-variant', feat: { id: 'heavily-armored' } }))
}
for (const originBonuses of [null, undefined, { str: null, dex: undefined }, { str: '3' }, { str: 'Infinity' }]) {
  mutate((source) => { source.abilityGeneration.originBonuses = originBonuses }, () => makeSource('fighter', { speciesId: 'human-variant', feat: { id: 'grappler' } }))
}
for (const value of ['', null, undefined, 'knight', 'SAGE', 5, ['sage']]) mutate((source) => { source.backgroundId = value })
for (const value of [null, undefined, 'x', [], 5, {}, { tools: [], languages: ['giant'] }, { tools: [], languages: ['giant', 'giant'] }, { tools: [], languages: ['giant', 'klingon'] },
  { tools: [], languages: ['giant', 'orc'], replacementSkills: 'ab' }, { tools: [], languages: ['giant', 'orc'], replacementSkills: 5 }, { tools: [], languages: ['giant', 'orc'], replacementSkills: { a: 1 } },
  { tools: [], languages: ['giant', 'orc'], replacementTools: 'lute' }, { tools: [], languages: ['giant', 'orc'], replacementTools: 3 }, { tools: [], languages: ['giant', 'orc'], replacementTools: ['lute'] },
  { tools: [], languages: ['giant', 'orc'], replacementTools: null }, { tools: [], languages: ['giant', 'orc'], customization: 'x' }, { tools: [], languages: ['giant', 'orc'], customization: { name: 'А' } },
  { tools: [], languages: ['giant', 'orc'], customization: { skills: ['arcana', 'arcana'], toolCount: 1, featureBackgroundId: 'sage' } },
  { tools: [], languages: ['giant', 'orc'], customization: { skills: ['arcana', 'history'], toolCount: 3, featureBackgroundId: 'sage' } },
  { tools: [], languages: ['giant', 'orc'], customization: { skills: ['arcana', 'history'], toolCount: 1, featureBackgroundId: 'nope' } },
  { tools: [], languages: ['giant', 'orc'], customization: { skills: ['arcana', 'history'], toolCount: 1, featureBackgroundId: 'sage', variant: 'spy' } },
  { tools: [], languages: ['giant', 'orc'], customization: null }]) {
  mutate((source) => { source.backgroundChoices = clone(value) })
}
// Повторы инструментов: плут-преступник с воровскими инструментами.
const rogueCriminal = () => makeSource('rogue', { backgroundId: 'criminal', speciesId: 'human' })
resolve(rogueCriminal())
for (const tools of [[], ['lute', 'drum'], ['thieves_tools'], ['thieves-tools'], ['dice_set'], ['lute'], ['lute', 'lute'], ['banjo'], ['constructor'], ['__proto__'], ['toString'], [['lute']], [null], [5], ['dragonchess_set'], ['three-dragon-ante-set']]) {
  mutate((source) => { source.backgroundChoices.replacementTools = clone(tools) }, rogueCriminal)
}
// Боевые стили воина и мусор на месте списка особенностей.
for (const selected of [...STYLES.map((id) => [id]), [], ['fighting-style-defense', 'fighting-style-archery'], ['fighter-perehvat'], ['constructor'], ['__proto__'], ['toString'], ['valueOf'],
  [['fighting-style-defense']], ['a'], 'a', 'fighting-style-defense', 5, null, undefined, true, { length: 1, 0: 'fighting-style-dueling' }, { length: 1 }, { 0: 'fighting-style-defense' }, [null]]) {
  mutate((source) => { source.selectedFeatureIds = clone(selected) })
}
mutate((source) => { source.selectedFeatureIds = ['fighting-style-defense'] }, () => makeSource('wizard'))
// Навыки класса и замены навыков.
for (const skills of [null, undefined, [], ['athletics'], ['athletics', 'athletics'], ['athletics', 'flying'], 'athletics', 'ab', 5, { a: 1 }, ['Athletics', 'Animal Handling']]) {
  mutate((source) => { source.classSkillProficiencies = clone(skills) })
}
// Подклассы: метка, псевдоним, чужой, пустой.
for (const subclass of ['Домен жизни', 'cleric-domen-zhizni', 'домен жизни', 'LIFE', 'champion', '', null, undefined, 5, ['life']]) {
  mutate((source) => { if (subclass === undefined) delete source.subclass; else source.subclass = subclass }, () => makeSource('cleric', { subclass: 'life' }))
}
for (const subclass of ['Исчадие', 'warlock-fiend', 'великий древний', 'great-old-one']) mutate((source) => { source.subclass = subclass }, () => makeSource('warlock', { subclass: 'fiend' }))
for (const subclass of ['Наследие драконьей крови', 'draconic']) mutate((source) => { source.subclass = subclass }, () => makeSource('sorcerer', { subclass: 'draconic-bloodline' }))
// Черта: только вариантный человек, отказы черты.
for (const feat of [undefined, null, {}, { id: '' }, { id: 'unknown' }, { id: 'war-caster' }, { id: 'tough', choices: 'x' }, { id: 'tough', choices: { a: 1 } }, { id: 'skilled', choices: { skills: ['arcana'] } },
  { id: 'linguist', choices: { languages: ['common', 'orc', 'giant'] } }, { id: 'linguist', choices: { languages: ['klingon', 'orc', 'giant'] } }, { id: 'heavily-armored' }, { id: 5 }, 'tough', 1, []]) {
  mutate((source) => { if (feat === undefined) delete source.phbCreation.feat; else source.phbCreation.feat = clone(feat) }, () => makeSource('fighter', { speciesId: 'human-variant', feat: { id: 'tough' } }))
}
mutate((source) => { source.phbCreation.feat = { id: 'tough' } })
mutate((source) => { source.phbCreation.feat = 0 })
mutate((source) => { source.phbCreation.feat = '' })
// Классовые выборы: неполные и неверные.
for (const instruments of [['lute'], ['lute', 'lute', 'drum'], ['lute', 'drum', 'banjo'], 'lute', null]) {
  mutate((source) => { source.phbCreation.classChoices.instruments = clone(instruments) }, () => makeSource('bard'))
}
for (const extra of [{ tool_or_instrument: undefined }, { tool_or_instrument: { kind: 'artisan_tool', id: 'lute' } }, { artisan_tool: 'smiths_tools' }]) {
  mutate((source) => { Object.assign(source.phbCreation.classChoices, extra); if ('tool_or_instrument' in extra && extra.tool_or_instrument === undefined) delete source.phbCreation.classChoices.tool_or_instrument }, () => makeSource('monk'))
}
for (const expertise of [['acrobatics'], ['history', 'arcana'], ['thieves_tools', 'thieves_tools']]) {
  mutate((source) => { source.phbCreation.classChoices.expertise = clone(expertise) }, () => makeSource('rogue'))
}
for (const enemy of [{ type: 'aberrations' }, { type: 'aberrations', language: 'deep_speech' }, { type: 'aberrations', language: 'deep-speech' }, { type: 'fiends', language: 'common' },
  { type: 'dragons', language: 'draconic' }, { type: 'humanoids', races: ['orc'] }, { type: 'fey', language: 'klingon' }, { type: 'beasts' }]) {
  mutate((source) => { source.phbCreation.classChoices.favored_enemy = clone(enemy) }, () => makeSource('ranger'))
}
for (const languages of [['draconic'], ['draconic', 'draconic'], ['common', 'orc'], ['giant', 'orc'], ['dwarvish', 'orc'], ['klingon', 'orc'], ['deep_speech', 'orc'], ['thieves-cant', 'druidic']]) {
  mutate((source) => { source.phbCreation.classChoices.knowledge_languages = clone(languages) }, () => makeSource('cleric', { subclass: 'knowledge', backgroundId: 'acolyte' }))
}
mutate((source) => { source.phbCreation.classChoices.knowledge_languages = ['giant', 'orc'] }, () => makeSource('cleric', { subclass: 'knowledge', speciesId: 'human-variant', feat: { id: 'linguist', choices: { languages: ['orc', 'sylvan', 'abyssal'] } } }))
mutate((source) => { source.phbCreation.classChoices.knowledge_languages = ['giant', 'orc'] }, () => makeSource('cleric', { subclass: 'knowledge', speciesId: 'human-variant', feat: { id: 'linguist', choices: { languages: ['goblin', 'sylvan', 'abyssal'] } } }))
for (const extra of [{ nature_cantrip: 'fire-bolt' }, { nature_skill: 'arcana' }, { nature_cantrip: 'poison_spray' }]) {
  mutate((source) => { Object.assign(source.phbCreation.classChoices, extra) }, () => makeSource('cleric', { subclass: 'nature' }))
}
mutate((source) => { source.phbCreation.classChoices.draconic_ancestry = 'pink' }, () => makeSource('sorcerer', { subclass: 'draconic-bloodline' }))
mutate((source) => { source.phbCreation.classChoices.skills = ['arcana', 'history'] })
mutate((source) => { source.phbCreation.classChoices.subclass = 'life' })
mutate((source) => { source.phbCreation.classChoices.subclass = 'war' }, () => makeSource('cleric', { subclass: 'life' }))
// Повторы инструментов у монаха-дварфа и барда-артиста.
for (const [classId, speciesId, backgroundId] of [['monk', 'dwarf-hill', 'guild-artisan'], ['bard', 'human', 'entertainer'], ['rogue', 'human', 'urchin'], ['monk', 'dwarf-mountain', 'folk-hero']]) {
  resolve(makeSource(classId, { speciesId, backgroundId }))
  mutate((source) => { source.backgroundChoices.replacementTools = [] }, () => makeSource(classId, { speciesId, backgroundId }))
}

r.write('character-creation-phb.json')
