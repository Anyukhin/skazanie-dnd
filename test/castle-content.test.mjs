import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { listCampaignScenarios, scenarioClueFactIdsKnownBy, scenarioLocationNpcs } from '../server/campaign-scenario.mjs'
import { dialogueOptionsFor } from '../server/campaign-dialogues.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, resolveCommands } from '../server/rules-engine.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'
import { deserializeTacticalMap, reachableCells } from '../server/tactical-map.mjs'

const scenario = listCampaignScenarios().find((entry) => entry.world_template_id === 'astohan-plains')
const castle = scenario.locations.find((entry) => entry.location_id === 'astohan-forgotten-cliffs')
const catalog = JSON.parse(readFileSync(new URL('../data/authored-location-maps-v1.json', import.meta.url), 'utf8'))
const map = deserializeTacticalMap(catalog.maps.find((entry) => entry.locationId === 'astohan-forgotten-cliffs'))

const hero = {
  id: 'castle-content-hero', character: 'Проверяющий', name: 'Проверяющий', role: 'Воин · ур. 7',
  species: 'Человек', background: 'Странник', level: 7, hp: 64, maxHp: 64, armor: 18, speed: 30,
}

test('Замок содержит физический дневник и кухонный якорь служанки', () => {
  assert.ok(castle)
  const diary = castle.secrets.find((secret) => secret.id === 'cliffs-diary')
  assert.deepEqual(diary.inspect_prop_ids, [
    'astohan-forgotten-cliffs:executioner-desk',
    'astohan-forgotten-cliffs:executioner-diary',
  ])
  assert.equal(castle.npcs.length, 1)
  assert.equal(castle.npcs[0].id, 'astohan-cliffs-maid')
  assert.ok(castle.npcs[0].tags.includes('anchor:astohan-forgotten-cliffs:kitchen_stove-49'))
  assert.deepEqual(scenarioClueFactIdsKnownBy(scenario, 'astohan-cliffs-maid'), [
    'fact:secret:scenario:astohan-dragon-hunt:cliffs-maid',
  ])
  const sceneNpcs = scenarioLocationNpcs({ campaignConcept: { arc: {
    version: 'skazanie:scenario-arc-v1', scenario_id: 'astohan-dragon-hunt', scenario_version: 1,
  } } }, 'astohan-forgotten-cliffs')
  const maid = sceneNpcs.find((npc) => npc.id === 'astohan-cliffs-maid')
  assert.ok(maid)
  assert.deepEqual(maid.known_fact_ids, ['fact:secret:scenario:astohan-dragon-hunt:cliffs-maid'])
  assert.ok(maid.tags.includes('anchor:astohan-forgotten-cliffs:kitchen_stove-49'))

  const diaryProp = map.props.find((prop) => prop.id === 'astohan-forgotten-cliffs:executioner-diary')
  const deskProp = map.props.find((prop) => prop.id === 'astohan-forgotten-cliffs:executioner-desk')
  const kitchenAnchor = map.props.find((prop) => prop.id === 'astohan-forgotten-cliffs:kitchen_stove-49')
  assert.ok(diaryProp)
  assert.ok(deskProp)
  assert.ok(kitchenAnchor)
  assert.equal(diaryProp.assetId, 'paper_scatter')
  assert.equal(kitchenAnchor.assetId, 'kitchen_stove')
})

test('дневник и кухонный якорь достижимы по авторской карте', () => {
  const starts = map.spawnPoints.filter((point) => point.role === 'party')
  const reachable = reachableCells(map, starts[0].x, starts[0].y)
  for (const id of ['astohan-forgotten-cliffs:executioner-diary', 'astohan-forgotten-cliffs:kitchen_stove-49']) {
    const prop = map.props.find((entry) => entry.id === id)
    assert.ok(prop)
    assert.ok(prop.footprint.some((cell) => reachable.has(`${cell.x},${cell.y}`)), `${id}: недостижим`)
  }
})

test('переход в Замок добавляет призрачную служанку в social state', async () => {
  const initial = normalizeCampaignState(await new CampaignBootstrapper().create({
    code: 'CASTLE-CONTENT', worldTemplateId: 'astohan-plains', players: [hero],
  }))
  let state = initial
  for (const [destinationLocationId, commandId] of [['astohan-mirror-lake', 'castle-content-lake'], ['astohan-forgotten-cliffs', 'castle-content-cliffs']]) {
    const { sceneArgs } = await new SceneArchitectAgent().plan({
      state, decision: `Идём в ${destinationLocationId}`, destinationLocationId,
    })
    const result = resolveCommands([{ command_type: 'AdvanceScene', command_id: commandId, scene_args: sceneArgs }], state, {
      context: { isAdmin: true }, diceService: new DiceService({ rng: new SequenceDiceRng([]) }),
    })
    assert.equal(result.halt, undefined)
    state = normalizeCampaignState(result.state)
  }
  assert.equal(state.scene.location_id, 'astohan-forgotten-cliffs')
  assert.ok(state.social.npcs.some((npc) => npc.id === 'astohan-cliffs-maid'))
})

test('выбор реплики служанки записывает факт cliffs-maid для всего отряда', async () => {
  const initial = normalizeCampaignState(await new CampaignBootstrapper().create({
    code: 'CASTLE-DIALOGUE', worldTemplateId: 'astohan-plains', players: [hero],
  }))
  let state = initial
  for (const [destinationLocationId, commandId] of [['astohan-mirror-lake', 'castle-dialogue-lake'], ['astohan-forgotten-cliffs', 'castle-dialogue-cliffs']]) {
    const { sceneArgs } = await new SceneArchitectAgent().plan({
      state, decision: `Идём в ${destinationLocationId}`, destinationLocationId,
    })
    const result = resolveCommands([{ command_type: 'AdvanceScene', command_id: commandId, scene_args: sceneArgs }], state, {
      context: { isAdmin: true }, diceService: new DiceService({ rng: new SequenceDiceRng([]) }),
    })
    state = normalizeCampaignState(result.state)
  }
  const before = campaignStateForViewer(state, { role: 'player', isPartyMember: true }, hero.id)
  assert.ok(!JSON.stringify(before).includes('слеза'))
  const dayState = normalizeCampaignState({
    ...state,
    mechanics: { ...state.mechanics, world_time: { ...state.mechanics.world_time, elapsed_minutes: 600 } },
  })
  assert.equal(dialogueOptionsFor(dayState, 'astohan-cliffs-maid', hero.id), null, 'днём служанка молчит')
  state = normalizeCampaignState({
    ...state,
    mechanics: { ...state.mechanics, world_time: { ...state.mechanics.world_time, elapsed_minutes: 1_200 } },
  })
  const options = dialogueOptionsFor(state, 'astohan-cliffs-maid', hero.id)
  assert.ok(options?.options.some((option) => option.id === 'last-tear'))
  const chosen = resolveCommands([{
    command_type: 'ChooseDialogueOption', command_id: 'castle-dialogue-maid-last-tear',
    actor_id: hero.id, npc_id: 'astohan-cliffs-maid', option_id: 'last-tear',
  }], state, { context: { isAdmin: true }, diceService: new DiceService({ rng: new SequenceDiceRng([]) }) })
  const reveal = chosen.events.find((event) => event.event_type === 'KnowledgeRevealed')
  assert.equal(reveal?.payload?.fact_id, 'fact:secret:scenario:astohan-dragon-hunt:cliffs-maid')
  assert.deepEqual(reveal?.target_ids, [hero.id])
  assert.ok(chosen.events.some((event) => event.event_type === 'DialogueOptionChosen' && event.payload?.revealed_fact_id === reveal.payload.fact_id))
  const after = campaignStateForViewer(normalizeCampaignState(chosen.state), { role: 'player', isPartyMember: true }, hero.id)
  assert.ok(JSON.stringify(after).includes('cliffs-maid'))
})
