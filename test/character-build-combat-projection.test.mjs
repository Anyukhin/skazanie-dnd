import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, resolveCommands } from '../server/rules-engine.mjs'

function initialState() {
  return normalizeCampaignState({
    sessionCode: 'CHARACTER-BUILD-COMBAT-PROJECTION',
    ruleset_id: 'dnd_5e_2014',
    players: [{
      id: 'hero', character: 'Мира', role: 'Воин · ур. 4', characterClass: 'fighter',
      level: 4, experience: 2_700, hp: 10, maxHp: 10,
      abilities: { str: 16, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
      classSkillProficiencies: [], selectedFeatureIds: [], inventory: [],
      creationBenefits: { armor_proficiencies: [], weapon_proficiencies: [] },
    }],
  })
}

test('после выбора черты боевые заклинания обновляются в состоянии без перезапуска', () => {
  const state = initialState()
  assert.equal(state.players[0].combatSpells.some((spell) => spell.id === 'magic-missile'), false)

  const result = resolveCommands([{
    command_type: 'SetCharacterChoices', actor_id: 'hero', subclass: '',
    class_skill_proficiencies: [], selected_feature_ids: [], ability_score_level: 4,
    ability_score_feat: {
      id: 'magic-initiate',
      choices: { class: 'wizard', cantrips: ['mage-hand', 'light'], spell: 'magic-missile' },
    },
  }], state, {
    diceService: new DiceService({ rng: new SequenceDiceRng([]) }),
    context: { allowedActorIds: ['hero'] },
  })

  const spells = result.state.players[0].combatSpells
  assert.equal(spells.find((spell) => spell.id === 'mage-hand')?.prepared, true)
  assert.equal(spells.find((spell) => spell.id === 'light')?.prepared, true)
  assert.equal(spells.find((spell) => spell.id === 'magic-missile')?.prepared, true)
})
