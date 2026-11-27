import assert from 'node:assert/strict'
import test from 'node:test'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { astohanPilotBuildCatalog, stagedCommandsForPilotBuild, validateAstohanPilotBuild } from '../server/astohan-pilot-builds.mjs'
const dice = () => new DiceService({ rng: new SequenceDiceRng(Array.from({ length: 40 }, () => 8)) })
test('четыре пилотных листа Асстохана валидны для каталога 2014 и используют только verified actions', () => {
  const catalog = astohanPilotBuildCatalog()
  assert.equal(catalog.target_level, 7)
  assert.deepEqual(catalog.builds.map((build) => build.id), ['fighter', 'barbarian', 'monk', 'paladin'])
  for (const build of catalog.builds) {
    const result = validateAstohanPilotBuild(build)
    assert.equal(result.ok, true, build.id + ': ' + JSON.stringify(result))
    assert.ok(result.actions.length >= 8, build.id + ' has too few exposed actions')
    assert.ok(result.actions.every((action) => action.mechanicsSupport === 'verified'))
  }
})
test('recipes produce only normal staged wizard commands', () => {
  for (const build of astohanPilotBuildCatalog().builds) {
    const commands = stagedCommandsForPilotBuild(build, build.id + '-hero')
    assert.equal(commands[0].command_type, 'SetCharacterChoices')
    assert.equal(commands.filter((command) => command.command_type === 'LevelUp').length, 6)
    assert.ok(commands.every((command) => ['SetCharacterChoices', 'LevelUp'].includes(command.command_type)))
    assert.ok(commands.every((command) => command.actor_id === build.id + '-hero'))
  }
})
test('staged setup reaches level 7 through Rules Engine and replay', () => {
  for (const build of astohanPilotBuildCatalog().builds) {
    const actorId = build.id + '-hero'
    const initial = normalizeCampaignState({
      sessionCode: 'PILOT-' + build.id,
      ruleset_id: 'dnd_5e_2014',
      character_start_level: 7,
      partyMemberIds: [actorId],
      players: [{
        id: actorId,
        characterClass: build.class,
        level: 1,
        experience: 0,
        abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 12 },
        hp: 10,
        maxHp: 10,
        speed: 30,
        inventory: [],
        characterSetupRequired: true,
        characterSetupStage: 'leveling',
        classSkillProficiencies: [],
        selectedFeatureIds: [],
      }],
    })
    let state = initial
    const events = []
    for (const command of stagedCommandsForPilotBuild(build, actorId)) {
      const result = resolveCommands([command], state, { diceService: dice(), context: { allowedActorIds: [actorId] } })
      state = result.state
      events.push(...result.events)
    }
    assert.equal(state.players[0].level, 7, build.id)
    assert.deepEqual(replayEvents(initial, events), state, build.id)
  }
})
