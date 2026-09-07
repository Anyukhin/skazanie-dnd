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

test('шесть отдельных 4к6 сохраняют каждый бросок, отбрасывают минимум и не допускают переброса', () => {
  const initial = normalizeCampaignState({ sessionCode: 'ROLL-CREATE', ruleset_id: 'dnd_5e_2014', partyMemberIds: ['hero'], players: [createCharacterSlot({ id: 'hero' })] })
  const diceService = new DiceService({ rng: new SequenceDiceRng([1, 2, 3, 4, 6, 6, 6, 1, 2, 2, 2, 2, 1, 1, 1, 1, 4, 4, 4, 4, 5, 5, 5, 5]) })
  const command = { command_type: 'RollCharacterAbilities', actor_id: 'hero', roll_index: 0 }
  const options = { diceService, context: { allowedActorIds: ['hero'] } }
  let result = { state: initial, events: [] }
  const events = []
  const expected = [9, 18, 6, 3, 12, 15]
  let firstId
  for (let index = 0; index < 6; index++) {
    result = resolveCommands([{ ...command, roll_index: index }], result.state, options)
    const saved = result.state.players[0].characterCreationRolls.abilities
    firstId ??= saved.id
    assert.equal(saved.id, firstId)
    assert.equal(saved.schema_version, 2)
    assert.deepEqual(saved.scores, expected.slice(0, index + 1))
    assert.equal(saved.rolls.length, index + 1)
    assert.equal(result.rolls.length, 1, 'одно нажатие расходует только четыре кубика')
    events.push(...result.events)
    assert.deepEqual(replayEvents(initial, events), result.state)
    if (index < 5) {
      for (const invalid of [index, index + 2, -1, 1.5, '1', undefined]) {
        assert.throws(() => resolveCommands([{ ...command, roll_index: invalid }], result.state, options), /не по порядку/)
      }
      const incomplete = document({ str: 18, dex: 15, con: 12, int: 9, wis: 6, cha: 3 }, 'rolled', { rollId: saved.id })
      assert.throws(() => parseCharacterImport(incomplete, { rulesetId: 'dnd_5e_2014', trustedAbilityRoll: saved }), /серверными бросками/)
      result.state = replayEvents(initial, events)
    }
  }
  const roll = result.state.players[0].characterCreationRolls.abilities
  assert.deepEqual(roll.scores, [9, 18, 6, 3, 12, 15])
  assert.deepEqual(replayEvents(initial, events), result.state)
  assert.throws(() => resolveCommands([command], result.state, { diceService, context: { allowedActorIds: ['hero'] } }), /уже сохранены/)
  assert.throws(() => resolveCommands([command], initial, { diceService, context: { allowedActorIds: [] } }), /владелец героя/)
  const base = { str: 18, dex: 15, con: 12, int: 9, wis: 6, cha: 3 }
  const doc = document(base, 'rolled', { rollId: roll.id })
  assert.doesNotThrow(() => parseCharacterImport(doc, { rulesetId: 'dnd_5e_2014', trustedAbilityRoll: roll }))
  assert.throws(() => parseCharacterImport(doc, { rulesetId: 'dnd_5e_2014' }), /серверными бросками/)
  assert.throws(() => parseCharacterImport(document({ ...base, str: 17 }, 'rolled', { rollId: roll.id }), { rulesetId: 'dnd_5e_2014', trustedAbilityRoll: roll }), /серверными бросками/)
})

test('старое событие с шестью бросками продолжает воспроизводиться и запрещает переброс', () => {
  const initial = normalizeCampaignState({ sessionCode: 'OLD-ROLLS', ruleset_id: 'dnd_5e_2014', partyMemberIds: ['hero'], players: [createCharacterSlot({ id: 'hero' })] })
  const payload = { schema_version: 1, id: 'old-roll', scores: [9, 18, 6, 3, 12, 15], rolls: [] }
  const state = replayEvents(initial, [{ event_type: 'CharacterAbilitiesRolled', target_ids: ['hero'], payload }])
  assert.deepEqual(state.players[0].characterCreationRolls.abilities, payload)
  assert.throws(() => resolveCommands([{ command_type: 'RollCharacterAbilities', actor_id: 'hero', roll_index: 6 }], state, { diceService: new DiceService({ rng: new SequenceDiceRng([1]) }), context: { allowedActorIds: ['hero'] } }), /уже сохранены/)
})
