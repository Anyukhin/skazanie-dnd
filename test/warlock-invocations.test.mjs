// Таинственные воззвания колдуна (PHB 2014): у колдуна 7-го уровня их четыре,
// а в проекте не было ни одного. Аудит боя 2026-10-13. Исполнимые воззвания:
// Мучительный взрыв, Отталкивающий взрыв, Мистическое копьё, Доспех теней и
// Влияние обольщения.
import assert from 'node:assert/strict'
import test from 'node:test'

import { spellRuntimeFixture } from '../eval/spell-runtime-audit.mjs'
import { deriveArmorClass } from '../server/character-lifecycle.mjs'
import { featureChoiceGroupsFor, isSkillProficient } from '../server/character-progression.mjs'
import { combatSpellFor } from '../server/combat-spells.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { fixedDice } from './kit/dice.mjs'

const INVOCATIONS = ['agonizing-blast', 'repelling-blast', 'eldritch-spear', 'armor-of-shadows']

function warlockFixture(invocations = INVOCATIONS) {
  const { state, command } = spellRuntimeFixture('eldritch-blast')
  const caster = state.players[0]
  Object.assign(caster, { characterClass: 'warlock', level: 7, abilities: { ...caster.abilities, cha: 18, dex: 14 }, selectedFeatureIds: invocations, knownSpellIds: ['eldritch-blast'] })
  return { state: normalizeCampaignState(state), command }
}

test('у колдуна 7-го уровня — четыре воззвания из списка, у 2-го — два', () => {
  const group = (level) => featureChoiceGroupsFor({ characterClass: 'warlock', level }).find((entry) => entry.id === 'warlock-invocations')
  assert.equal(group(7).choiceCount, 4)
  assert.equal(group(2).choiceCount, 2)
  assert.equal(group(1), undefined)
  assert.ok(INVOCATIONS.every((id) => group(7).options.some((option) => option.id === id)))
})

test('Мучительный взрыв: +Харизма к каждому лучу; Мистическое копьё: 300 футов', () => {
  const { state } = warlockFixture()
  const spell = combatSpellFor(state.players[0], 'eldritch-blast', { rulesetId: state.ruleset_id })
  assert.equal(spell.range, 300)
  const plain = combatSpellFor(warlockFixture([]).state.players[0], 'eldritch-blast', { rulesetId: state.ruleset_id })
  assert.equal(plain.range, 120)
  const { state: castState, command } = warlockFixture()
  const result = resolveCommand({ ...command, target_ids: ['enemy', 'enemy'], server_authoritative: true }, castState, { diceService: fixedDice(15), context: { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] } })
  const beams = result.events.filter((event) => event.event_type === 'DieRolled' && /spell_damage:eldritch-blast/u.test(String(event.payload.purpose)))
  assert.equal(beams.length, 2, 'два луча на 7-м уровне')
  assert.ok(beams.every((event) => event.payload.expression === '1d10+4'), JSON.stringify(beams.map((event) => event.payload.expression)))
})

test('Отталкивающий взрыв отталкивает попавшую цель на 10 футов', () => {
  const { state, command } = warlockFixture()
  const result = resolveCommand({ ...command, target_ids: ['enemy'], server_authoritative: true }, state, { diceService: fixedDice(15), context: { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] } })
  const pushed = result.events.find((event) => event.event_type === 'ActorMoved' && event.payload.invocation === 'repelling-blast')
  assert.ok(pushed, 'толчок')
  assert.deepEqual(pushed.payload.to, { x: 5, y: 2 }, 'с (3,2) на 10 футов от колдуна в (2,2)')
  const without = warlockFixture(['agonizing-blast'])
  const quiet = resolveCommand({ ...without.command, target_ids: ['enemy'], server_authoritative: true }, without.state, { diceService: fixedDice(15), context: { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] } })
  assert.ok(!quiet.events.some((event) => event.event_type === 'ActorMoved'))
})

test('Доспех теней — КД 13 + Ловкость без доспеха; Влияние обольщения — Обман и Убеждение', () => {
  const warlock = { characterClass: 'warlock', level: 7, abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 18 }, selectedFeatureIds: INVOCATIONS, inventory: [] }
  assert.equal(deriveArmorClass(warlock).value, 15)
  assert.equal(deriveArmorClass({ ...warlock, selectedFeatureIds: ['agonizing-blast'] }).value, 12)
  const beguiling = { ...warlock, classSkillProficiencies: ['arcana', 'history'], selectedFeatureIds: ['agonizing-blast', 'beguiling-influence', 'eldritch-spear', 'repelling-blast'] }
  assert.equal(isSkillProficient(beguiling, 'persuasion'), true)
  assert.equal(isSkillProficient(beguiling, 'deception'), true)
  assert.equal(isSkillProficient({ ...beguiling, selectedFeatureIds: INVOCATIONS }, 'persuasion'), false)
})

test('Дьявольское зрение: в магической тьме колдун бьёт без помехи и выбирает цель взглядом', () => {
  const darkness = (invocations) => {
    const { state, command } = warlockFixture(invocations)
    state.mechanics.conditions.caster = [{ id: 'magical-darkness', duration: 'rounds:10' }]
    state.mechanics.conditions.enemy = [{ id: 'magical-darkness', duration: 'rounds:10' }]
    return resolveCommand({ ...command, target_ids: ['enemy'], server_authoritative: true }, state, { diceService: fixedDice(15), context: { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] } })
      .events.find((event) => event.event_type === 'AttackResolved')
  }
  assert.notEqual(darkness([...INVOCATIONS.slice(0, 3), 'devils-sight']).payload.mode, 'disadvantage')
  assert.equal(darkness(INVOCATIONS).payload.mode, 'disadvantage', 'без воззвания тьма мешает')
})
