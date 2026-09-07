import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'

const dice = () => new DiceService({ rng: new SequenceDiceRng([]), idFactory: (() => { let id = 0; return () => `feat-roll-${++id}` })() })

function state(overrides = {}) {
  return normalizeCampaignState({
    sessionCode: 'FEAT-ADVANCEMENT',
    ruleset_id: 'dnd_5e_2014',
    players: [{
      id: 'hero', character: 'Мира', role: 'Волшебник · ур. 4', characterClass: 'wizard',
      subclass: 'Школа Воплощения', level: 4, experience: 2_700, hp: 5, maxHp: 20,
      abilities: { str: 8, dex: 12, con: 12, int: 16, wis: 10, cha: 10 },
      classSkillProficiencies: ['arcana', 'investigation'], selectedFeatureIds: [],
      knownSpellIds: [], preparedSpellIds: [], hitPointIncreases: [], inventory: [],
      creationBenefits: {
        schema_version: 1, armor_proficiencies: [], weapon_proficiencies: [],
        tool_proficiencies: [], saving_throw_proficiencies: [], speed_bonus: 0,
        initiative_bonus: 0, extra_hit_points_per_level: 0,
      },
      ...overrides,
    }],
  })
}

function choices(extra = {}) {
  return {
    command_type: 'SetCharacterChoices', actor_id: 'hero', subclass: 'Школа Воплощения',
    class_skill_proficiencies: ['arcana', 'investigation'], selected_feature_ids: [],
    ...extra,
  }
}

function apply(current, command) {
  return resolveCommands([command], current, { diceService: dice(), context: { allowedActorIds: ['hero'] } })
}

test('черта вместо ASI сохраняется сервером, применяет Tough ретроактивно и не лечит текущие HP', () => {
  const initial = state()
  const result = apply(initial, choices({
    ability_score_level: 4,
    ability_score_feat: { id: 'tough', choices: {}, benefits: { hit_point_maximum_bonus_per_level: 999 } },
  }))
  const hero = result.state.players[0]
  assert.equal(result.events[0].payload.schema_version, 2)
  assert.equal(result.events[0].payload.level_feats['4'].id, 'tough')
  assert.equal(hero.levelFeats['4'].id, 'tough')
  assert.deepEqual(hero.abilityScoreIncreases, {}, 'черта не записывается в историю обычных прибавок')
  assert.equal(hero.hp, 5)
  assert.equal(hero.creationBenefits.extra_hit_points_per_level, 2)
  assert.ok(hero.maxHp > initial.players[0].maxHp)
  assert.deepEqual(replayEvents(initial, result.events), result.state)
  assert.throws(
    () => apply(result.state, choices({ ability_score_level: 4, ability_score_increases: ['str', 'con'] })),
    (error) => error.code === 'ABILITY_SCORE_CHOICE_LOCKED',
  )
})

test('ASI и черта на одном уровне взаимоисключаются, а зафиксированный ASI нельзя заменить чертой', () => {
  const initial = state()
  assert.throws(
    () => apply(initial, choices({
      ability_score_level: 4,
      ability_score_increases: ['str', 'con'],
      ability_score_feat: { id: 'athlete', choices: { ability: 'dex' } },
    })),
    (error) => error.code === 'ABILITY_SCORE_CHOICE_CONFLICT',
  )
  const asi = apply(initial, choices({ ability_score_level: 4, ability_score_increases: ['str', 'con'] }))
  assert.throws(
    () => apply(asi.state, choices({ ability_score_level: 4, ability_score_feat: { id: 'athlete', choices: { ability: 'dex' } } })),
    (error) => error.code === 'ABILITY_SCORE_CHOICE_LOCKED',
  )
})

test('дубликат исходной черты запрещён, а Elemental Adept разрешён повторно только с другой стихией', () => {
  const duplicate = state({
    creationBenefits: { feat: { id: 'athlete' }, armor_proficiencies: [], weapon_proficiencies: [] },
    phbCreation: { feat: { id: 'athlete', choices: { ability: 'dex' } } },
  })
  assert.throws(
    () => apply(duplicate, choices({ ability_score_level: 4, ability_score_feat: { id: 'athlete', choices: { ability: 'str' } } })),
    (error) => error.code === 'FEAT_ALREADY_TAKEN',
  )

  const first = apply(state(), choices({ ability_score_level: 4, ability_score_feat: { id: 'elemental-adept', choices: { damage_type: 'fire' } } }))
  first.state.players[0].level = 8
  const second = apply(first.state, choices({ ability_score_level: 8, ability_score_feat: { id: 'elemental-adept', choices: { damage_type: 'cold' } } }))
  assert.equal(second.state.players[0].levelFeats['8'].choices.damage_type, 'cold')
  second.state.players[0].level = 12
  assert.throws(
    () => apply(second.state, choices({ ability_score_level: 12, ability_score_feat: { id: 'elemental-adept', choices: { damage_type: 'fire' } } })),
    (error) => error.code === 'FEAT_CHOICE_ALREADY_TAKEN',
  )
})

test('черта ограничивает ASI максимумом 20, но level-up допускает потерянный +1, и проверяет редакцию правил', () => {
  const capped = apply(state({ abilities: { str: 8, dex: 20, con: 12, int: 16, wis: 10, cha: 10 } }), choices({ ability_score_level: 4, ability_score_feat: { id: 'athlete', choices: { ability: 'dex' } } }))
  assert.equal(capped.state.players[0].abilities.dex, 20)
  assert.deepEqual(capped.state.players[0].levelFeats['4'].benefits.ability_increases, {})
  const modern = normalizeCampaignState({ ...state(), ruleset_id: 'srd_5_2_1' })
  assert.throws(
    () => apply(modern, choices({ ability_score_level: 4, ability_score_feat: { id: 'tough', choices: {} } })),
    (error) => error.code === 'ABILITY_SCORE_FEAT_UNAVAILABLE',
  )
})

test('одинаковый idempotency key не применяет черту повторно', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'skazanie-feat-advancement-'))
  const store = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState, snapshotEvery: 0 })
  const initial = state()
  await store.initializeCampaign({ campaign_id: initial.sessionCode, initial_state: initial })
  const result = apply(initial, choices({ ability_score_level: 4, ability_score_feat: { id: 'athlete', choices: { ability: 'dex' } } }))
  const first = await store.commit({ campaign_id: initial.sessionCode, expected_state_version: initial.state_version, idempotency_key: 'feat-4', events: result.events })
  const duplicate = await store.commit({ campaign_id: initial.sessionCode, expected_state_version: initial.state_version, idempotency_key: 'feat-4', events: result.events })
  assert.equal(duplicate.duplicate, true)
  assert.deepEqual(duplicate.state, first.state)
})
