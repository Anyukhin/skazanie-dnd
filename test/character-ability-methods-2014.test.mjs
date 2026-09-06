import assert from 'node:assert/strict'
import test from 'node:test'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { createCharacterSlot, parseCharacterImport } from '../server/character-lifecycle.mjs'
import { normalizeCampaignState, resolveCommands, replayEvents } from '../server/rules-engine.mjs'

function document(baseScores, method = 'point_buy', extra = {}) {
  return { schema: 'skazanie.character', schema_version: 1, character: {
    character: 'Тестовый герой', characterClass: 'fighter', level: 1, experience: 0,
    abilities: Object.fromEntries(Object.entries(baseScores).map(([key, value]) => [key, value + 1])),
    abilityGeneration: { policyId: 'skazanie.character-abilities.dnd-5e-2014', policyVersion: 2,
      method, baseScores, originBonusProfileId: 'human', speciesOptionId: 'human',
      originBonuses: { str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: 1 }, ...extra },
    baseSpeed: 30, speciesChoices: { 'extra-language': ['dwarvish'] },
    classSkillProficiencies: ['athletics', 'perception'], selectedFeatureIds: ['fighting-style-defense'], knownSpellIds: [], preparedSpellIds: [],
  } }
}

test('покупка характеристик PHB 2014 допускает 27 очков и запрещает выход за бюджет/8–15', () => {
  const base = { str: 15, dex: 15, con: 15, int: 8, wis: 8, cha: 8 }
  assert.equal(parseCharacterImport(document(base), { rulesetId: 'dnd_5e_2014' }).patch.abilities.str, 16)
  for (const bad of [{ ...base, int: 9 }, { ...base, str: 16 }, { ...base, int: 7 }]) {
    assert.throws(() => parseCharacterImport(document(bad), { rulesetId: 'dnd_5e_2014' }), /27|8–15/)
  }
  assert.throws(() => parseCharacterImport(document(base), { rulesetId: 'srd_5_2_1' }), /policy/)
})

test('4к6 отбрасывает минимум, сохраняется событием и не перебрасывается повторной командой', () => {
  const initial = normalizeCampaignState({ sessionCode: 'ROLL-CREATE', ruleset_id: 'dnd_5e_2014', partyMemberIds: ['hero'], players: [createCharacterSlot({ id: 'hero' })] })
  const diceService = new DiceService({ rng: new SequenceDiceRng([1, 2, 3, 4, 6, 6, 6, 1, 2, 2, 2, 2, 1, 1, 1, 1, 4, 4, 4, 4, 5, 5, 5, 5]) })
  const command = { command_type: 'RollCharacterAbilities', actor_id: 'hero' }
  const result = resolveCommands([command], initial, { diceService, context: { allowedActorIds: ['hero'] } })
  const roll = result.state.players[0].characterCreationRolls.abilities
  assert.deepEqual(roll.scores, [9, 18, 6, 3, 12, 15])
  assert.deepEqual(replayEvents(initial, result.events), result.state)
  assert.throws(() => resolveCommands([command], result.state, { diceService, context: { allowedActorIds: ['hero'] } }), /уже сохранены/)
  assert.throws(() => resolveCommands([command], initial, { diceService, context: { allowedActorIds: [] } }), /владелец героя/)
  const base = { str: 18, dex: 15, con: 12, int: 9, wis: 6, cha: 3 }
  const doc = document(base, 'rolled', { rollId: roll.id })
  assert.doesNotThrow(() => parseCharacterImport(doc, { rulesetId: 'dnd_5e_2014', trustedAbilityRoll: roll }))
  assert.throws(() => parseCharacterImport(doc, { rulesetId: 'dnd_5e_2014' }), /серверными бросками/)
  assert.throws(() => parseCharacterImport(document({ ...base, str: 17 }, 'rolled', { rollId: roll.id }), { rulesetId: 'dnd_5e_2014', trustedAbilityRoll: roll }), /серверными бросками/)
})
