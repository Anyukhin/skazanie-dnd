import assert from 'node:assert/strict'
import test from 'node:test'

import { classBuildCatalogInfo, featureChoiceGroupsFor, isSkillProficient, normalizedClassSkillProficiencies, normalizedSelectedFeatureIds } from '../server/character-progression.mjs'
import { combatActionsFor } from '../server/combat-actions.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

const dice = (values) => new DiceService({ rng: new SequenceDiceRng(values), idFactory: (() => { let id = 0; return () => `skill-roll-${++id}` })(), now: () => '2026-07-13T12:00:00.000Z' })

test('классовый конструктор содержит 18 навыков и лимиты всех 12 классов', () => {
  const info = classBuildCatalogInfo()
  assert.equal(info.rulesProfile, 'dndsu-5e-2014-official')
  assert.equal(info.skillCount, 18)
  assert.equal(info.classes.length, 12)
  assert.equal(info.classes.find((entry) => entry.classKey === 'fighter').choiceCount, 2)
  assert.equal(info.classes.find((entry) => entry.classKey === 'rogue').choiceCount, 4)
  assert.ok(info.classes.every((entry) => entry.sourceUrl.startsWith('https://www.dnd.su/class/')))
})

test('сервер принимает только допустимое число навыков из списка класса', () => {
  const actor = { characterClass: 'fighter', classSkillProficiencies: ['athletics', 'stealth', 'perception', 'athletics'] }
  assert.deepEqual(normalizedClassSkillProficiencies(actor), ['athletics', 'perception'])
  assert.equal(isSkillProficient(actor, 'athletics'), true)
  assert.equal(isSkillProficient(actor, 'stealth'), false)
})

test('выбранное владение реально добавляет бонус мастерства к серверной проверке', () => {
  const state = normalizeCampaignState({ players: [{ id: 'hero', character: 'Бранн', characterClass: 'fighter', level: 3, hp: 20, maxHp: 20, proficiency: 2, abilities: { str: 16, dex: 12 }, classSkillProficiencies: ['athletics', 'perception'], inventory: [] }] })
  const athletics = resolveCommand({ command_type: 'MakeAbilityCheck', actor_id: 'hero', skill: 'athletics', difficulty: 10 }, state, { diceService: dice([10]) })
  const stealth = resolveCommand({ command_type: 'MakeAbilityCheck', actor_id: 'hero', skill: 'stealth', difficulty: 10 }, state, { diceService: dice([10]) })
  assert.equal(athletics.rolls[0].total, 15)
  assert.equal(stealth.rolls[0].total, 11)
})

test('число классовых выборов растёт на предусмотренных правилами уровнях', () => {
  const level3 = featureChoiceGroupsFor({ characterClass: 'fighter', subclass: 'Мастер боевых искусств', level: 3 })
  const level10 = featureChoiceGroupsFor({ characterClass: 'fighter', subclass: 'Мастер боевых искусств', level: 10 })
  assert.equal(level3.find((group) => group.id === 'fighter-fighting-style').choiceCount, 1)
  assert.equal(level3.find((group) => group.id === 'fighter-maneuvers').choiceCount, 3)
  assert.equal(level10.find((group) => group.id === 'fighter-maneuvers').choiceCount, 7)
  assert.equal(featureChoiceGroupsFor({ characterClass: 'sorcerer', level: 3 })[0].choiceCount, 2)
  assert.equal(featureChoiceGroupsFor({ characterClass: 'sorcerer', level: 10 })[0].choiceCount, 3)
})

test('боевой каталог содержит только выбранные манёвры, метамагию и дар договора', () => {
  const fighter = { characterClass: 'fighter', subclass: 'Мастер боевых искусств', level: 3, selectedFeatureIds: ['fighting-style-defense', 'trip-attack', 'parry', 'rally'] }
  assert.deepEqual(normalizedSelectedFeatureIds(fighter), ['fighting-style-defense', 'trip-attack', 'rally', 'parry'])
  const fighterIds = new Set(combatActionsFor(fighter).map((entry) => entry.id))
  assert.equal(fighterIds.has('trip-attack'), true)
  assert.equal(fighterIds.has('parry'), true)
  assert.equal(fighterIds.has('menacing-attack'), false)

  const sorcererIds = new Set(combatActionsFor({ characterClass: 'sorcerer', level: 3, selectedFeatureIds: ['quickened-spell', 'subtle-spell'] }).map((entry) => entry.id))
  assert.equal(sorcererIds.has('quickened-spell'), true)
  assert.equal(sorcererIds.has('subtle-spell'), true)
  assert.equal(sorcererIds.has('heightened-spell'), false)

  const warlockIds = new Set(combatActionsFor({ characterClass: 'warlock', level: 3, selectedFeatureIds: ['pact-talisman'] }).map((entry) => entry.id))
  assert.equal(warlockIds.has('pact-talisman'), true)
  assert.equal(warlockIds.has('pact-blade'), false)
})

test('нормализация состояния отсекает поддельные и преждевременные выборы персонажа', () => {
  const state = normalizeCampaignState({ players: [{
    id: 'hero', character: 'Тест', characterClass: 'fighter', level: 2, subclass: 'Мастер боевых искусств',
    hp: 10, maxHp: 10, abilities: { str: 16 }, inventory: [],
    classSkillProficiencies: ['athletics', 'stealth', 'perception'],
    selectedFeatureIds: ['fighting-style-defense', 'quickened-spell', 'trip-attack'],
    knownSpellIds: ['fireball'], preparedSpellIds: ['fireball'],
  }] })
  assert.equal(state.players[0].subclass, undefined)
  assert.deepEqual(state.players[0].classSkillProficiencies, ['athletics', 'perception'])
  assert.deepEqual(state.players[0].selectedFeatureIds, ['fighting-style-defense'])
  assert.deepEqual(state.players[0].knownSpellIds, [])
  assert.deepEqual(state.players[0].preparedSpellIds, [])
})
