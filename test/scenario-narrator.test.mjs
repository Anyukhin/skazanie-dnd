// Рассказчик знает сюжет авторского сценария (`scenarioNarratorBrief`,
// `server/campaign-scenario.mjs`): о чём кампания, текущий узел, найденное.
// Ненайденные тайны в справку не попадают — ни текстом, ни темой.
import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { campaignScenario, scenarioClueFactId, scenarioLocationId, scenarioNarratorBrief } from '../server/campaign-scenario.mjs'
import { questStateForViewer } from '../server/quest-consequences.mjs'
import { normalizeCampaignState, resolveCommands } from '../server/rules-engine.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { buildNarrationBrief } from '../server/security.mjs'
import { fixedDice } from './kit/dice.mjs'

const hero = {
  id: 'story-hero', character: 'Велена', name: 'Игрок', role: 'Жрица · ур. 7', species: 'Человек', background: 'Странница',
  level: 7, hp: 52, maxHp: 52, armor: 17, speed: 30,
}

async function atAshWatch() {
  let state = normalizeCampaignState(await new CampaignBootstrapper().create({ code: 'STORY', worldTemplateId: 'astohan-plains', players: [hero] }))
  for (let hop = 0; hop < 6 && scenarioLocationId(state) !== 'astohan-ash-watch'; hop += 1) {
    const { sceneArgs } = await new SceneArchitectAgent().plan({ state, decision: 'На заставу', destinationLocationId: 'astohan-ash-watch' })
    state = normalizeCampaignState(resolveCommands([{ command_id: `story-hop-${hop}`, command_type: 'AdvanceScene', scene_args: sceneArgs }], state,
      { diceService: fixedDice(10), context: { isAdmin: true } }).state)
  }
  assert.equal(scenarioLocationId(state), 'astohan-ash-watch')
  return state
}

function discover(state, clueId) {
  const secretId = scenarioClueFactId(campaignScenario(state), clueId)
  const secret = state.worldMemory.facts.find((fact) => fact.id === secretId)
  return normalizeCampaignState(resolveCommands([{ command_id: `story-find-${clueId}`, command_type: 'RecordWorldFact', fact: {
    id: `fact-secret-found-${clueId}`, subject_id: secret.subject_id, predicate: 'discovery', object: 'clue',
    summary: secret.summary, visibility: 'party', source_event_ids: [], supersedes_fact_id: secretId,
  } }], state, { diceService: fixedDice(10), context: { isAdmin: true } }).state)
}

test('сюжетная справка: суть кампании, место, текущий узел; найденное есть, ненайденного нет', async () => {
  const before = await atAshWatch()
  const scenario = campaignScenario(before)
  const card = scenario.locations.find((location) => location.location_id === 'astohan-ash-watch')
  const [gate, ...others] = card.secrets

  const fresh = scenarioNarratorBrief(questStateForViewer(before, { isPartyMember: true }))
  assert.equal(fresh.campaign, scenario.title)
  assert.ok(fresh.premise.length > 40)
  assert.equal(fresh.place.title, card.title)
  assert.equal(fresh.current_beat.title, 'Пепельная застава')
  assert.ok(fresh.completed_beats.includes('Поручение короля'), 'пролог позади')
  assert.deepEqual(fresh.found_clues, [])
  assert.doesNotMatch(JSON.stringify(fresh), new RegExp(gate.clue.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), 'тайна до находки не звучит')

  const after = discover(before, gate.id)
  const story = scenarioNarratorBrief(questStateForViewer(after, { isPartyMember: true }))
  assert.equal(story.found_clues.length, 1)
  for (const other of others) assert.ok(!JSON.stringify(story).includes(other.clue.slice(0, 40)), `ненайденная ${other.id} молчит`)
})

test('хранители тайн знают свою часть истории, и рассказанное в разговоре закрывает узел сюжета', async () => {
  let state = normalizeCampaignState(await new CampaignBootstrapper().create({ code: 'HOLDERS', worldTemplateId: 'astohan-plains', players: [hero] }))
  const scenario = campaignScenario(state)
  const knows = (npcId) => state.social.npcs.find((npc) => npc.id === npcId).known_fact_ids
  assert.ok(knows('astohan-eldrin').includes(scenarioClueFactId(scenario, 'eldrin-story')))
  assert.ok(knows('astohan-lomar').includes(scenarioClueFactId(scenario, 'tower-barrier-notes')))
  assert.ok(knows('astohan-kaelan').includes(scenarioClueFactId(scenario, 'cliffs-frescoes')))
  assert.ok(!knows('astohan-kaelan').includes(scenarioClueFactId(scenario, 'cliffs-chapel')), 'где голова, рыцарь сам не скажет — это загадка')

  // Отряд у Сердца Элдрина (тропу к нему открывает Дикий лес): тайна записана
  // при входе, и Древо рассказывает её герою.
  for (const destination of ['astohan-wild-forest', 'astohan-eldrin-heart']) {
    for (let hop = 0; hop < 8 && scenarioLocationId(state) !== destination; hop += 1) {
      const { sceneArgs } = await new SceneArchitectAgent().plan({ state, decision: 'К Древу', destinationLocationId: destination })
      state = normalizeCampaignState(resolveCommands([{ command_id: `holders-${destination}-${hop}`, command_type: 'AdvanceScene', scene_args: sceneArgs }], state,
        { diceService: fixedDice(10), context: { isAdmin: true } }).state)
    }
    assert.equal(scenarioLocationId(state), destination)
  }
  const lineTree = () => scenarioNarratorBrief(questStateForViewer(state, { isPartyMember: true })).completed_beats.includes('Ломар и Великое Древо')
  assert.equal(lineTree(), false)
  state = normalizeCampaignState(resolveCommands([{ command_id: 'holders-told', command_type: 'RecordKnowledgeRevelation',
    fact_id: scenarioClueFactId(scenario, 'eldrin-story'), target_ids: [hero.id], source_event_ids: [] }], state,
  { diceService: fixedDice(10), context: { isAdmin: true } }).state)
  assert.equal(lineTree(), true, 'история Древа, услышанная от него самого, закрывает линию')
})

test('справка проходит границу брифа Рассказчика: ни одного запретного ключа', async () => {
  const state = await atAshWatch()
  const scenario = scenarioNarratorBrief(questStateForViewer(state, { isPartyMember: true }))
  const brief = buildNarrationBrief({
    visible_events: [], visible_state_changes: [],
    known_environment: { scenario },
    permitted_npc_reactions: [],
  })
  assert.equal(brief.known_environment.scenario.campaign, scenario.campaign)
  assert.equal(brief.known_environment.scenario.current_beat.title, scenario.current_beat.title)
})

test('собеседники сценария вне каталога мира — комендант Гедрик и осведомители — входят в сцену и знают свои тайны', async () => {
  const { replayEvents } = await import('../server/rules-engine.mjs')
  const initial = normalizeCampaignState(await new CampaignBootstrapper().create({ code: 'SCNPC', worldTemplateId: 'astohan-plains', players: [hero] }))
  const scenario = campaignScenario(initial)
  let state = initial
  const events = []
  const travel = async (destination) => {
    for (let hop = 0; hop < 8 && scenarioLocationId(state) !== destination; hop += 1) {
      const { sceneArgs } = await new SceneArchitectAgent().plan({ state, decision: 'В путь', destinationLocationId: destination })
      const result = resolveCommands([{ command_id: `scnpc-${destination}-${hop}`, command_type: 'AdvanceScene', scene_args: sceneArgs }], state,
        { diceService: fixedDice(10), context: { isAdmin: true } })
      events.push(...result.events)
      state = normalizeCampaignState(result.state)
    }
    assert.equal(scenarioLocationId(state), destination)
  }
  assert.equal(state.social.npcs.some((npc) => npc.id === 'astohan-gedrik'), false, 'до прихода отряда коменданта в мире нет')
  for (const [destination, npcId, clue] of [
    ['astohan-quiet-watch-camp', 'astohan-gedrik', 'camp-gedrik'],
    ['astohan-redstone', 'astohan-toban', 'redstone-mill'],
    ['astohan-mittlayd', 'astohan-lars', 'mittlayd-informant'],
  ]) {
    await travel(destination)
    const npc = state.social.npcs.find((entry) => entry.id === npcId)
    assert.ok(npc, `${npcId} в сцене`)
    assert.ok(npc.known_fact_ids.includes(scenarioClueFactId(scenario, clue)), `${npcId} знает свою тайну`)
    assert.ok(state.worldMemory.facts.some((fact) => fact.id === scenarioClueFactId(scenario, clue)), 'тайна записана при входе')
  }
  // Повторный визит не плодит двойников.
  await travel('astohan-redstone')
  assert.equal(state.social.npcs.filter((npc) => npc.id === 'astohan-toban').length, 1)
  assert.deepEqual(replayEvents(initial, events).social.npcs.map((npc) => npc.id).sort(), state.social.npcs.map((npc) => npc.id).sort())
})
