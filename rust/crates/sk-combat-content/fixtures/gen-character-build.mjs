import '../../../fixtures-env.mjs'
// Эталон server/character-build.mjs для Rust:
//
//   node rust/crates/sk-combat-content/fixtures/gen-character-build.mjs
//
// Команды SetCharacterChoices и SetSpellSelections для героев всех классов:
// подкласс, классовые навыки и особенности, улучшение характеристик и черты
// PHB 2014 вместо него, выбор заклинаний — допустимые, запрещённые, мусорные;
// в обеих редакциях, в бою и вне, с правами и без. Результат или отказ
// записываются целиком, вместе с событием.
import { readFileSync } from 'node:fs'

import * as m from '../../../../server/character-build.mjs'
import { combatSpellsFor } from '../../../../server/combat-spells.mjs'
import { normalizedSelectedFeatureIds } from '../../../../server/character-progression.mjs'
import { attempt, encode, mulberry32, writeFixture } from './common.mjs'

const random = mulberry32(4_8_12)
const pick = (items) => items[Math.floor(random() * items.length)]
const sample = (items, share) => items.filter(() => random() < share)

const buildRules = JSON.parse(readFileSync(new URL('../../../../data/dndsu-class-build-rules-1-12.json', import.meta.url), 'utf8'))
const actionCatalog = JSON.parse(readFileSync(new URL('../../../../data/dndsu-class-actions-1-12.json', import.meta.url), 'utf8'))
const CLASSES = buildRules.classes.map((entry) => entry.classKey)
const skillsOf = (classKey) => buildRules.classes.find((entry) => entry.classKey === classKey)?.skills ?? []
const choiceCountOf = (classKey) => buildRules.classes.find((entry) => entry.classKey === classKey)?.choiceCount ?? 2
const featuresOf = (classKey) => buildRules.featureChoiceGroups.filter((group) => group.classKey === classKey).flatMap((group) => group.options.map((option) => option.id))
const subclassesOf = (classKey) => actionCatalog.classes.find((entry) => entry.classKey === classKey)?.subclasses ?? []

const players = []
for (const classKey of CLASSES) {
  for (const level of [1, 3, 4, 8, 12]) {
    const player = {
      id: `${classKey}-${level}`, character: `Герой ${classKey}`, characterClass: classKey, level,
      abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8, ...(level === 8 ? { str: 19 } : {}), ...(level === 12 ? { dex: 20, int: 18 } : {}) },
      classSkillProficiencies: skillsOf(classKey).slice(0, choiceCountOf(classKey)),
      selectedFeatureIds: [],
      creationBenefits: level === 4 ? { feat: { id: ' Alert ' }, armor_proficiencies: ['light'], weapon_proficiencies: ['simple'], spell_grants: [] } : { armor_proficiencies: ['light', 'medium'], languages: ['common'], tool_proficiencies: ['thieves_tools'], passive_skill_bonuses: { perception: 1 }, speed_bonus: 5 },
      ...(level === 4 ? { phbCreation: { feat: { choices: {} } } } : {}),
      ...(level === 8 ? { abilityScoreIncreases: { 4: ['str'], ' 6': ['dex', 'con'], x: ['wis'], 9: 'str' } } : {}),
      ...(level === 12 ? { levelFeats: { 4: { id: 'Tough', choices: {}, benefits: { hit_point_maximum_bonus_per_level: 2 } }, 8: { id: '' }, x: { id: 'alert' }, 10: 'x' }, abilityScoreIncreases: { 8: ['int'] } } : {}),
      inventory: [],
    }
    players.push(player)
  }
}
players.push({ id: 'garbage', characterClass: 'wizard', level: 'x', abilities: [], creationBenefits: 'x', creationSpellGrants: 'ab' }, { characterClass: 'fighter', level: 4 }, { id: 5, characterClass: 'rogue', level: 4 })

const baseState = (rulesetId, combat = false) => ({ ruleset_id: rulesetId, players, mechanics: combat ? { combat: { active: true } } : {} })
const STATES = [baseState('dnd_5e_2014'), baseState('srd_5_2_1'), baseState('dnd_5e_2014', true), { players: null }, {}]

const FEATS = [
  { id: 'alert' }, { id: 'Mobile' }, { id: 'tough', choices: {} }, { id: 'observant', choices: { ability: 'wis' } }, { id: 'observant', choices: { ability: 'str' } },
  { id: 'magic-initiate', choices: { class: 'wizard', cantrips: ['mage-hand', 'light'], spell: 'magic-missile' } },
  { id: 'magic-initiate', choices: { class: 'druid', cantrips: ['guidance', 'shillelagh'], spell: 'cure-wounds' } },
  { id: 'ritual-caster', choices: { class: 'wizard', rituals: ['detect-magic', 'find-familiar'] } }, { id: 'skilled', choices: { proficiencies: ['athletics', 'stealth', 'thieves_tools'] } },
  { id: 'linguist', choices: { ability: 'int', languages: ['elvish', 'dwarvish', 'giant'] } }, { id: 'resilient', choices: { ability: 'con' } }, { id: 'heavily-armored' },
  { id: 'nope' }, { id: '' }, 'alert', ['alert'], { id: 'alert', choices: 'x' }, { id: 'actor', choices: { unknown: 1 } }, { id: 'war-caster' }, { id: 'elemental-adept', choices: { damage_type: 'fire' } },
]
const ASI = [['str'], ['dex', 'con'], ['STR '], ['str', 'str'], ['luck'], [], ['str', 'dex', 'con'], 'str', null, ['int'], ['cha', 'wis']]

function choicesCommand(player) {
  const classKey = player.characterClass
  const own = skillsOf(classKey)
  const features = featuresOf(classKey)
  const command = { command_type: 'SetCharacterChoices', actor_id: random() < 0.85 ? pick([player.id, player.id, ` ${player.id} `]) : pick(['nobody', undefined]) }
  const subclasses = subclassesOf(classKey)
  if (random() < 0.8) command.subclass = pick([subclasses[0]?.name, subclasses.at(-1)?.name, subclasses[0]?.id, '', 'Чужой подкласс', null, undefined])
  const skillVariant = random()
  const skills = skillVariant < 0.6 ? own.slice(0, choiceCountOf(classKey))
    : skillVariant < 0.55 ? own.slice(0, choiceCountOf(classKey)).map((id) => id.replaceAll('_', '-'))
      : skillVariant < 0.65 ? [...own.slice(0, choiceCountOf(classKey)), own.at(-1)]
        : skillVariant < 0.72 ? ['Athletics']
          : skillVariant < 0.78 ? 'athletics'
            : skillVariant < 0.82 ? Array.from({ length: 101 }, (_, index) => `s${index}`)
              : skillVariant < 0.9 ? [] : undefined
  if (skills !== undefined) command[random() < 0.8 ? 'class_skill_proficiencies' : 'classSkillProficiencies'] = skills
  if (random() < 0.7) command[random() < 0.8 ? 'selected_feature_ids' : 'selectedFeatureIds'] = random() < 0.2 ? ['bad id'] : random() < 0.7 ? normalizedSelectedFeatureIds({ ...player, selectedFeatureIds: sample(features, 0.3) }) : sample(features, 0.3)
  const asiVariant = random()
  if (asiVariant < 0.35) {
    command.ability_score_level = pick([4, 6, 8, 10, 12, '4', 5, null, 4.5])
    command.ability_score_increases = clone(pick(ASI))
  } else if (asiVariant < 0.65) {
    command.ability_score_level = pick([4, 4, 8, 12, 6, 2])
    command.ability_score_feat = clone(pick(FEATS))
    if (random() < 0.1) command.ability_score_increases = ['str']
  } else if (asiVariant < 0.7) {
    command.abilityScoreLevel = 4
    command.abilityScoreIncreases = ['dex']
  }
  if (random() < 0.3) Object.assign(command, { creation_benefits: { x: 1 }, level_feats: { 4: {} }, creation_spell_grants: [], creation_skill_proficiencies: ['x'] })
  if (random() < 0.4) command.request_fingerprint = pick(['fp-1', ' fingerprint ', 'x'.repeat(200), 5])
  return command
}

function spellsCommand(player) {
  const own = combatSpellsFor(player).map((spell) => spell.id)
  const command = { command_type: 'SetSpellSelections', actor_id: pick([player.id, player.id, 'nobody']) }
  const variant = random()
  if (variant < 0.5) {
    command.known_spell_ids = sample(own, 0.3)
    command.prepared_spell_ids = sample(own, 0.2)
  } else if (variant < 0.65) {
    command.knownSpellIds = sample(own, 0.1)
    command.preparedSpellIds = sample(own, 0.1)
  } else if (variant < 0.75) {
    command.known_spell_ids = ['Fire Bolt']
  } else if (variant < 0.85) {
    command.prepared_spell_ids = own
  } else if (variant < 0.9) {
    command.known_spell_ids = 'fire-bolt'
  }
  if (random() < 0.4) command.request_fingerprint = 'fp'
  return command
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

const CONTEXTS = [undefined, {}, { isAdmin: true }, { isAdmin: 'true' }]
const cases = []
for (let round = 0; round < 10; round += 1) {
  for (const player of players) {
    for (const make of [choicesCommand, spellsCommand]) {
      // Поле `undefined` держит в JS место ключа, а в JSON эталона его нет.
      const command = JSON.parse(JSON.stringify(make(player)))
      const state = random() < 0.8 ? STATES[random() < 0.5 ? 0 : 1] : pick(STATES)
      const context = random() < 0.7 ? { allowedActorIds: [String(player.id), 'other'] } : pick(CONTEXTS)
      const stateIndex = STATES.indexOf(state)
      const outcome = attempt(() => m.validateCharacterBuildCommand(command, state, context ?? {}))
      if (outcome.error && outcome.error.name !== 'CharacterBuildValidationError') continue
      const event = outcome.result ? m.characterBuildEvent(outcome.result) : undefined
      cases.push({ command: encode(command), state: stateIndex, context: encode(context ?? {}), ...outcome, ...(outcome.result ? { event: encode(event) } : {}) })
    }
  }
}
// Черты вместо улучшения характеристик: каждая черта у героев 4-го, 8-го и
// 12-го уровней со списком навыков и особенностей, который проходит проверку.
for (const player of players.filter((candidate) => [4, 8, 12].includes(candidate.level))) {
  for (const feat of FEATS) {
    const command = JSON.parse(JSON.stringify({
      command_type: 'SetCharacterChoices', actor_id: player.id, subclass: '',
      class_skill_proficiencies: player.classSkillProficiencies, selected_feature_ids: [],
      ability_score_level: player.level === 4 ? 4 : player.level === 8 ? 8 : 12, ability_score_feat: clone(feat), request_fingerprint: 'feat',
    }))
    const outcome = attempt(() => m.validateCharacterBuildCommand(command, STATES[0], { allowedActorIds: [player.id] }))
    if (outcome.error && outcome.error.name !== 'CharacterBuildValidationError') continue
    cases.push({ command, state: 0, context: { allowedActorIds: [player.id] }, ...outcome, ...(outcome.result ? { event: encode(m.characterBuildEvent(outcome.result)) } : {}) })
  }
}
// Чужие команды возвращаются как есть, событие — только у своих.
for (const command of [{ command_type: 'MakeAttack', actor_id: 'x' }, { actor_id: 'x' }]) {
  cases.push({ command, state: 0, context: {}, ...attempt(() => m.validateCharacterBuildCommand(command, STATES[0], {})), event: encode(m.characterBuildEvent(command)) })
}

writeFixture(new URL('character-build.json', import.meta.url), {
  commandTypes: [...m.CHARACTER_BUILD_COMMAND_TYPES],
  states: STATES,
  cases,
})
