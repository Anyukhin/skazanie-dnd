import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { abilityScoreChoiceLevelsFor } from '../server/character-progression.mjs'
import {
  applyCharacterLifecycleEvent,
  experienceForLevel,
  levelUpEvent,
  validateLevelUpCommand,
} from '../server/character-lifecycle.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { applyGameEvent, replayEvents, resolveCommand, resolveCommands, normalizeCampaignState } from '../server/rules-engine.mjs'

const dice = new DiceService({ rng: new SequenceDiceRng([]), idFactory: (() => { let id = 0; return () => `starting-level-${++id}` })() })

test('ASI levels follow the class progression used by the staged wizard', () => {
  assert.deepEqual(abilityScoreChoiceLevelsFor({ characterClass: 'fighter' }), [4, 6, 8, 12])
  assert.deepEqual(abilityScoreChoiceLevelsFor({ characterClass: 'rogue' }), [4, 8, 10, 12])
  assert.deepEqual(abilityScoreChoiceLevelsFor({ characterClass: 'wizard' }), [4, 8, 12])
})

function stagedState(target = 3) {
  return normalizeCampaignState({
    sessionCode: 'STARTING-LEVEL',
    character_start_level: target,
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{
      id: 'hero', character: 'Ада', characterClass: 'fighter', role: 'Воин · ур. 1',
      level: 1, experience: 0, characterSetupRequired: true, characterSetupStage: 'leveling',
      abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
      classSkillProficiencies: ['athletics', 'perception'],
      selectedFeatureIds: ['fighting-style-defense'], knownSpellIds: [], preparedSpellIds: [],
      hitPointIncreases: [], hp: 12, maxHp: 12, inventory: [],
    }],
  })
}

test('новая кампания сохраняет выбранный стартовый уровень и отклоняет неподдерживаемый', async () => {
  const state = await new CampaignBootstrapper().create({
    code: 'START-LVL', name: 'Седьмой круг', partyName: 'Отряд', world: {}, startLevel: 7,
    players: [{ id: 'hero', character: 'Ада', characterSetupRequired: true }],
  })
  assert.equal(state.character_start_level, 7)
  assert.equal(state.players[0].level, 1, 'слот всё равно начинает с первого уровня')
  await assert.rejects(
    () => new CampaignBootstrapper().create({
      code: 'START-BAD', world: {}, startLevel: 13,
      players: [{ id: 'hero', character: 'Ада', characterSetupRequired: true }],
    }),
    /начальный уровень должен быть целым числом от 1 до 12/iu,
  )
})

test('поэтапный старт повышает ровно один уровень с порогом XP и снимает setup только на цели', () => {
  let state = stagedState(2)
  const events = []
  for (const expectedLevel of [1]) {
    const result = resolveCommand({
      command_type: 'LevelUp', actor_id: 'hero', expected_level: expectedLevel,
    }, state, { diceService: dice, context: { allowedActorIds: ['hero'] } })
    assert.equal(result.events.length, 1)
    assert.equal(result.events[0].payload.progression_source, 'character_creation')
    assert.equal(result.events[0].payload.experience, experienceForLevel(expectedLevel + 1))
    events.push(...result.events)
    state = replayEvents(state, result.events)
    assert.equal(state.players[0].level, expectedLevel + 1)
    assert.equal(state.players[0].characterSetupRequired, false)
  }
  assert.deepEqual(replayEvents(stagedState(2), events), state, 'поэтапные события воспроизводятся тем же листом')
  assert.throws(
    () => validateLevelUpCommand({ command_type: 'LevelUp', actor_id: 'hero', expected_level: 2 }, state, { allowedActorIds: ['hero'] }),
    (error) => error.code === 'LEVEL_UP_PROGRESSION_REQUIRED',
  )
})

test('поэтапная подготовка разрешает сохранить выбор, но игровой ход остаётся закрыт', () => {
  const initial = stagedState(3)
  const choices = resolveCommands([{
    command_type: 'SetCharacterChoices', actor_id: 'hero',
    subclass: '', class_skill_proficiencies: ['athletics', 'perception'],
    selected_feature_ids: ['fighting-style-defense'],
  }], initial, { diceService: dice, context: { allowedActorIds: ['hero'] } })
  assert.equal(choices.events[0].event_type, 'CharacterChoicesUpdated')
  assert.throws(
    () => resolveCommand({ command_type: 'MakeAbilityCheck', actor_id: 'hero', skill: 'athletics', difficulty: 10 }, choices.state, { diceService: dice, context: { allowedActorIds: ['hero'] } }),
    (error) => error.code === 'CHARACTER_SETUP_REQUIRED',
  )
})

test('стартовый уровень с новыми выборами не открывает игру до их сохранения', () => {
  const initial = stagedState(3)
  const first = resolveCommand({ command_type: 'LevelUp', actor_id: 'hero', expected_level: 1 }, initial, { diceService: dice, context: { allowedActorIds: ['hero'] } })
  const afterFirst = replayEvents(initial, first.events)
  const second = resolveCommand({ command_type: 'LevelUp', actor_id: 'hero', expected_level: 2 }, afterFirst, { diceService: dice, context: { allowedActorIds: ['hero'] } })
  const afterSecond = replayEvents(afterFirst, second.events)
  assert.equal(afterSecond.players[0].level, 3)
  assert.equal(afterSecond.players[0].characterSetupRequired, true)
  const choices = resolveCommands([{
    command_type: 'SetCharacterChoices', actor_id: 'hero', subclass: 'Мастер боевых искусств',
    class_skill_proficiencies: ['athletics', 'perception'],
    selected_feature_ids: ['fighting-style-defense', 'trip-attack', 'menacing-attack', 'disarming-attack'],
  }], afterSecond, { diceService: dice, context: { allowedActorIds: ['hero'] } })
  assert.equal(choices.state.players[0].characterSetupRequired, false)
})

test('на четвёртом уровне сначала требуется серверно проверенное улучшение характеристик', () => {
  const state = normalizeCampaignState({
    ...stagedState(7),
    players: [{
      ...stagedState(7).players[0], level: 4, experience: 2_700,
      subclass: 'Мастер боевых искусств',
      selectedFeatureIds: ['fighting-style-defense', 'trip-attack', 'menacing-attack', 'disarming-attack'],
    }],
  })
  assert.throws(
    () => validateLevelUpCommand({ command_type: 'LevelUp', actor_id: 'hero', expected_level: 4 }, state, { allowedActorIds: ['hero'] }),
    (error) => error.code === 'CHARACTER_CREATION_CHOICES_REQUIRED',
  )
  const choices = resolveCommands([{
    command_type: 'SetCharacterChoices', actor_id: 'hero', subclass: 'Мастер боевых искусств',
    class_skill_proficiencies: ['athletics', 'perception'],
    selected_feature_ids: ['fighting-style-defense', 'trip-attack', 'menacing-attack', 'disarming-attack'],
    ability_score_level: 4, ability_score_increases: ['str', 'con'],
  }], state, { diceService: dice, context: { allowedActorIds: ['hero'] } })
  assert.equal(choices.state.players[0].abilities.str, 17)
  assert.equal(choices.state.players[0].abilities.con, 15)
  assert.deepEqual(choices.state.players[0].abilityScoreIncreases, { 4: ['str', 'con'] })
})

test('событие создания героя сохраняет поэтапный setup до выбранного уровня', () => {
  const initial = stagedState(2)
  const actor = initial.players[0]
  const event = {
    event_type: 'CharacterLeveledUp',
    actor_id: actor.id,
    target_ids: [actor.id],
    payload: {
      level_before: 1, level_after: 2, experience: 0, experience_required: 0,
      progression_source: 'character_creation', hit_die: 10, hit_point_roll: 6,
      hit_point_policy: 'fixed_average', max_hp_before: 12, max_hp_after: 19,
    },
  }
  const after = applyCharacterLifecycleEvent(initial, event)
  assert.equal(after.players[0].characterSetupRequired, false)
  assert.equal(after.players[0].characterSetupStage, undefined)
  assert.equal(after.players[0].level, 2)
  assert.equal(levelUpEvent({
    command_type: 'LevelUp', actor_id: actor.id, level_before: 1, level_after: 2,
    experience: 0, experience_required: 0, progression_source: 'character_creation',
    hit_die: 10, hit_point_roll: 6, max_hp_before: 12, max_hp_after: 19,
  }).payload.progression_source, 'character_creation')
})

test('EventStore проводит fighter с первого до седьмого уровня по одному шагу, choices и replay', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'skazanie-start-level-'))
  const store = new FileEventStore({
    rootDir,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotEvery: 0,
  })
  const initial = stagedState(7)
  await store.initializeCampaign({ campaign_id: initial.sessionCode, initial_state: initial })
  const fightingStyle = ['fighting-style-defense']
  const maneuvers = [...fightingStyle, 'trip-attack', 'menacing-attack', 'disarming-attack']
  const choices = (state, key, extra = {}) => {
    const result = resolveCommands([{
      command_type: 'SetCharacterChoices', actor_id: 'hero',
      subclass: extra.subclass ?? state.players[0].subclass ?? '',
      class_skill_proficiencies: ['athletics', 'perception'],
      selected_feature_ids: extra.selectedFeatureIds ?? state.players[0].selectedFeatureIds ?? fightingStyle,
      ...(extra.abilityScoreLevel ? { ability_score_level: extra.abilityScoreLevel, ability_score_increases: extra.abilityScoreIncreases } : {}),
    }], state, { diceService: dice, context: { allowedActorIds: ['hero'] } })
    return store.commit({ campaign_id: initial.sessionCode, expected_state_version: state.state_version, idempotency_key: key, events: result.events })
  }
  const levelUp = async (expectedLevel, key) => {
    const loaded = await store.load(initial.sessionCode)
    const result = resolveCommands([{ command_type: 'LevelUp', actor_id: 'hero', expected_level: expectedLevel }], loaded.state, { diceService: dice, context: { allowedActorIds: ['hero'] } })
    const first = await store.commit({ campaign_id: initial.sessionCode, expected_state_version: loaded.state_version, idempotency_key: key, events: result.events })
    const duplicate = await store.commit({ campaign_id: initial.sessionCode, expected_state_version: loaded.state_version, idempotency_key: key, events: result.events })
    assert.equal(duplicate.duplicate, true)
    assert.deepEqual(duplicate.state, first.state)
    return first
  }

  await levelUp(1, 'creation-level-2')
  await levelUp(2, 'creation-level-3')
  let loaded = await store.load(initial.sessionCode)
  assert.equal(loaded.state.players[0].level, 3)
  await choices(loaded.state, 'creation-choices-3', { subclass: 'Мастер боевых искусств', selectedFeatureIds: maneuvers })
  await levelUp(3, 'creation-level-4')
  loaded = await store.load(initial.sessionCode)
  await choices(loaded.state, 'creation-choices-4', { subclass: 'Мастер боевых искусств', selectedFeatureIds: maneuvers, abilityScoreLevel: 4, abilityScoreIncreases: ['str', 'con'] })
  await levelUp(4, 'creation-level-5')
  await levelUp(5, 'creation-level-6')
  loaded = await store.load(initial.sessionCode)
  await choices(loaded.state, 'creation-choices-6', { subclass: 'Мастер боевых искусств', selectedFeatureIds: maneuvers, abilityScoreLevel: 6, abilityScoreIncreases: ['str'] })
  const reachedTarget = await levelUp(6, 'creation-level-7')
  assert.equal(reachedTarget.state.players[0].level, 7)
  assert.equal(reachedTarget.state.players[0].characterSetupRequired, true, 'новые манёвры 7 уровня ещё нужно выбрать')
  assert.equal(reachedTarget.state.players[0].experience, 23_000)
  assert.equal(reachedTarget.state.players[0].abilities.str, 19)
  assert.equal(reachedTarget.state.players[0].abilities.con, 15)
  assert.equal(reachedTarget.state.players[0].maxHp, reachedTarget.state.players[0].hp, 'финальный герой выходит в игру с полными хитами')
  loaded = await store.load(initial.sessionCode)
  await choices(loaded.state, 'creation-choices-7', {
    subclass: 'Мастер боевых искусств',
    selectedFeatureIds: [...maneuvers, 'distracting-strike', 'goading-attack'],
  })
  const final = await store.load(initial.sessionCode)
  assert.equal(final.state.players[0].characterSetupRequired, false)
  assert.equal(final.state.players[0].characterSetupStage, undefined)
  const replayed = await store.replay(initial.sessionCode, { use_snapshots: false })
  assert.deepEqual(replayed.state, final.state, 'полный replay EventStore совпадает с поэтапным состоянием')
})
