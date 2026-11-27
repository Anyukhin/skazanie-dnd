// Эталон server/character-creation-feats.mjs: node gen-character-creation-feats.mjs
import * as m from '../../../../server/character-creation-feats.mjs'
import { product, recorder } from './record.mjs'

const r = recorder('character-creation-feats')
for (const name of [
  'PHB_2014_FEATS_SOURCE', 'ABILITY_IDS', 'PHB_CANTRIPS', 'PHB_FIRST_LEVEL_SPELLS', 'PHB_RITUALS', 'PHB_MARTIAL_ADEPT_MANEUVER_IDS', 'PHB_2014_FEATS',
]) r.constant(name, m[name])

const featIds = m.PHB_2014_FEATS.map((feat) => feat.id)
for (const id of [...featIds, 'RESILIENT', ' lucky ', 'Lucky', 'unknown', '', null, undefined, 5]) r.call('characterCreationFeatFor', m.characterCreationFeatFor, id)

// Контексты героя: характеристики, владения, языки, взятые черты.
const contexts = [
  undefined, null, {}, 'context', [],
  { abilities: { str: 8, dex: 12, con: 10, int: 10, wis: 10, cha: 10 }, canCastSpells: false },
  { abilities: { str: 14, dex: 14, con: 14, int: 14, wis: 14, cha: 14 }, proficiency: { armor: ['light', 'medium', 'heavy'], weapons: ['longsword'] }, canCastSpells: true, languages: [] },
  { abilities: { str: 20, dex: 20, con: 20, int: 20, wis: 20, cha: 20 }, can_cast_spells: true, proficiencies: { armor_proficiencies: ['Heavy Armor', 'shields'] } },
  { abilities: { str: 20, dex: 20, con: 20, int: 20, wis: 20, cha: 20 }, allowCappedAbilityIncrease: true, proficiency: { armors: ['medium_armor'] } },
  { abilities: { str: 13, dex: 13, cha: 13, int: 12, wis: 13 }, armor: ['light'], weaponProficiencies: ['Hand Crossbow'] },
  { abilities: { str: '15', dex: null }, armorProficiencies: ['Medium'], canCastSpells: 'yes' },
  { abilities: { dex: 'abc' } },
  { abilities: 'strong' },
  { abilities: [] },
  { abilities: { int: 19, wis: 19 }, languages: ['Dwarvish', 'deep speech'], feats: ['Alert', 'tough', 'elemental_adept'] },
  { abilities: { int: 19 }, languageProficiencies: ['elvish'], selectedFeats: ['lucky'], allow_capped_ability_increase: true },
  { abilities: { cha: 19 }, proficiency: { armor: 'heavy' }, armor: ['heavy'], existingFeatChoices: { 'elemental-adept': [{ damage_type: 'fire' }, 'Cold'] } },
  { canCastSpells: true, existing_feat_choices: { elemental_adept: { damageType: 'acid' } }, feats: ['elemental-adept'] },
  { canCastSpells: true, featChoices: { elementalAdept: 'thunder' } },
  { canCastSpells: true, feat_choices: 'fire' },
  { proficiencyBonus: 3, proficiency_bonus: 'x', skills: ['arcana'], tools: ['lute'] },
]
// Список целиком тяжёл (42 черты с описаниями): контексты с разным исходом.
const keyContexts = [0, 3, 5, 6, 7, 8, 10, 11, 12, 14, 16].map((index) => contexts[index])
for (const context of keyContexts) r.call('listCharacterCreationFeats', m.listCharacterCreationFeats, context)

const resolve = (id, choices, context) => r.call('resolveCharacterCreationFeat', m.resolveCharacterCreationFeat, id, choices, context)

// Каждая черта без выбора и с пустым выбором во всех контекстах.
for (const [id, context] of product(featIds, keyContexts)) resolve(id, undefined, context)
for (const context of contexts) resolve('resilient', { ability: 'con' }, context)
for (const id of featIds) {
  resolve(id, null, undefined)
  resolve(id, 'choices', undefined)
  resolve(id, { unexpected: true, ability: 'str' }, undefined)
  resolve(id, { 2: 'a', b: 'c', 1: 'd' }, undefined)
}

// Выбор характеристики.
const abilityFeats = ['athlete', 'observant', 'tavern-brawler', 'lightly-armored', 'moderately-armored', 'resilient']
const abilityContexts = [undefined, { abilities: { str: 19, dex: 20, con: 13, int: 20, wis: 12, cha: 10 }, proficiency: { armor: ['light'] } }, { abilities: { str: 20, dex: 20, con: 20, int: 20, wis: 20, cha: 20 }, allowCappedAbilityIncrease: true, armor: ['light'] }]
for (const [id, ability, key, context] of product(abilityFeats, ['str', 'DEX', ' con ', 'int', 'wis', 'cha', 'luck', '', null], ['ability', 'ability_id', 'abilityId'], abilityContexts)) {
  resolve(id, { [key]: ability }, context)
}

// Одарённый.
for (const choice of [
  { skills: ['arcana', 'history'], tools: ['thieves-tools'] }, { skills: ['arcana', 'Animal Handling', 'sleight-of-hand'] },
  { tools: ['lute', "alchemist's supplies", 'Smith’s Tools'] }, { skill_ids: ['arcana'], tool_ids: ['playing-cards', 'land-vehicles'] },
  { skills: ['arcana', 'arcana', 'history'] }, { skills: ['arcana', 'history'] }, { skills: ['arcana', 'history', 'religion', 'nature'] },
  { skills: ['arcana', 'flying'] }, { tools: ['lute', 'banjo', 'drum'] }, { skills: 'arcana', tools: ['lute', 'drum', 'viol'] },
  { skillIds: ['stealth'], toolIds: ['thieves_tools', 'thieves-tools'] }, {}, { skills: null, tools: null },
  { skills: ['arcana'], skill_ids: ['history', 'religion', 'nature'] },
]) resolve('skilled', choice)

// Мастер оружия.
for (const weapons of [
  ['longsword', 'shortbow', 'rapier', 'hand-crossbow'], ['Long Sword', 'great-axe', 'war_pick', 'Morning-Star'], ['longsword', 'shortbow'],
  ['longsword', 'longsword', 'rapier', 'whip'], ['longsword', 'shortbow', 'rapier', 'laser'], ['', 'shortbow', 'rapier', 'whip'], 'longsword', null,
]) for (const key of ['weapons', 'weapon_ids', 'weaponIds']) resolve('weapon-master', { [key]: weapons })

// Воинский адепт.
for (const maneuvers of [
  ['precision-attack', 'riposte'], ['Precision Attack', 'trip_attack'], ['commander-s-strike', 'rally'], ['precision-attack'],
  ['precision-attack', 'not-a-maneuver'], ['parry', 'parry'], ['  ', 'parry'], null,
]) for (const key of ['maneuvers', 'maneuver_ids', 'maneuverIds']) resolve('martial-adept', { [key]: maneuvers })

// Языковед.
for (const [languages, context] of product([
  ['dwarvish', 'elvish', 'draconic'], ['Deep Speech', 'deep-speech', 'orc'], ['dwarvish', 'elvish'], ['dwarvish', 'elvish', 'klingon'],
  ['common', 'giant', 'sylvan'], ['dwarvish', 'Dwarvish', 'orc'],
], [undefined, { abilities: { int: 12 } }, { languages: ['common'] }, { abilities: { int: 20 } }])) resolve('linguist', { languages }, context)

// Посвящённый в магию, ритуалы, меткие заклинания.
const casterClasses = ['bard', 'cleric', 'druid', 'sorcerer', 'warlock', 'wizard', 'Wizard', 'paladin', '', null]
const cantripPairs = [['fire-bolt', 'mage-hand'], ['guidance', 'light'], ['eldritch-blast', 'minor-illusion'], ['vicious-mockery', 'friends'], ['Thorn Whip', 'produce_flame'], ['toll-the-dead', 'mage-hand'], ['light', 'light'], ['fire-bolt']]
const firstLevel = ['magic-missile', 'cure-wounds', 'hex', 'healing-word', "Tasha's Hideous Laughter", 'tashas-hideous-laughter', 'shield', 'absorb-elements', '', null]
for (const [classKey, cantrips, spell] of product(casterClasses, cantripPairs, firstLevel)) {
  resolve('magic-initiate', { class: classKey, cantrips, spell })
}
resolve('magic-initiate', { class_key: 'wizard', cantrip_ids: ['fire-bolt', 'light'], spell_id: 'shield' })
resolve('magic-initiate', { classKey: 'cleric', cantripIds: ['guidance', 'light'], spellId: 'bless' })
resolve('magic-initiate', { class: 'wizard', cantrips: ['fire-bolt', 'light'] })
const ritualPairs = [['alarm', 'find-familiar'], ['detect-magic', 'identify'], ['comprehend-languages', 'detect-magic'], ['Tenser’s Floating Disk', 'unseen servant'], ['alarm'], ['alarm', 'alarm'], ['speak-with-animals', 'purify-food-and-drink']]
for (const [classKey, rituals, context] of product(casterClasses, ritualPairs, [{ abilities: { int: 13 } }, { abilities: { wis: 13 } }, { abilities: { int: 12, wis: 12 } }])) {
  resolve('ritual-caster', { class: classKey, rituals }, context)
}
for (const [classKey, cantrip] of product(casterClasses, ['fire-bolt', 'eldritch-blast', 'thorn-whip', 'Chill Touch', 'produce_flame', 'light', '', null])) {
  resolve('spell-sniper', { class: classKey, cantrip }, { canCastSpells: true })
}
resolve('spell-sniper', { class_key: 'warlock', cantrip_id: 'eldritch-blast' }, { canCastSpells: true })

// Стихийный адепт и повторный выбор.
const adeptContexts = [
  { canCastSpells: true }, { canCastSpells: true, existingFeatChoices: { 'elemental-adept': [{ damage_type: 'fire' }] }, feats: ['elemental-adept'] },
  { canCastSpells: true, existing_feat_choices: { elemental_adept: ['Cold', { damage: 'acid' }] } }, { canCastSpells: true, featChoices: { elementalAdept: { damageType: 'thunder' } } },
  { canCastSpells: false },
]
for (const [damage, key, context] of product(['acid', 'cold', 'Fire', 'lightning', 'thunder', 'poison', '', null], ['damage_type', 'damageType', 'damage'], adeptContexts)) {
  resolve('elemental-adept', { [key]: damage }, context)
}

// Требования к владению и уже взятые черты.
for (const [id, context] of product(['heavily-armored', 'heavy-armor-master', 'medium-armor-master', 'moderately-armored', 'war-caster', 'defensive-duelist', 'grappler', 'skulker', 'inspiring-leader', 'ritual-caster'], [
  {}, { proficiency: { armor: ['medium'] } }, { proficiency: { armor: ['light'] } }, { armor: ['Heavy-Armor'] }, { abilities: { dex: 12 } },
  { abilities: { str: 12, dex: 13, cha: 13 } }, { feats: ['heavily-armored', 'War Caster', 'war_caster'] },
])) resolve(id, {}, context)
r.call('resolveCharacterCreationFeat', m.resolveCharacterCreationFeat, 'unknown', {}, {})

// Доступность классовых заклинаний.
const spells = [
  { id: 'absorb-elements', level: 1, classes: ['wizard'] }, { id: 'magic-missile', level: 1, classes: ['wizard', 'sorcerer'] },
  { id: 'fire-bolt', level: 0, classes: ['wizard', 'sorcerer'] }, { id: 'toll-the-dead', level: 0, classes: ['wizard', 'cleric', 'warlock'] },
  { id: 'fireball', level: 3, classes: ['wizard', 'sorcerer'] }, { id: 'guidance', level: '0', classes: ['cleric', 'druid'] },
  { id: 'bless', level: null, classes: ['cleric'] }, { id: 'hex', classes: ['warlock'] }, { id: 'cure-wounds', level: 1, classes: 'cleric' }, {}, null,
]
const casters = [
  undefined, null, {}, { creationBenefits: null }, { creationBenefits: { expanded_spells: [], domain_spells: [] } },
  { creationBenefits: { expanded_spells: ['absorb-elements', 'toll-the-dead', 'fireball'] } }, { creationBenefits: { expanded_spells: 'absorb-elements' } },
  { creationBenefits: 1 },
]
for (const [spell, classKey, actor] of product(spells, ['wizard', 'sorcerer', 'cleric', 'warlock', 'druid', 'bard', 'paladin', ''], casters)) {
  r.call('isClassSpellAvailable', m.isClassSpellAvailable, spell, classKey, actor)
}
r.write('character-creation-feats.json')
