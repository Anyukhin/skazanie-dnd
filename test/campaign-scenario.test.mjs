import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { campaignCanAutoComplete, campaignCanAdvanceArc } from '../server/campaign-lifecycle.mjs'
import {
  authorizeDirectorIntent,
  campaignArcClimaxSatisfied,
  campaignArcPosition,
  nextWorldMapDestination,
} from '../server/campaign-loop-policy.mjs'
import {
  SCENARIO_ARC_VERSION,
  campaignScenario,
  listCampaignScenarios,
  scenarioClueFactId,
  scenarioDestinationIds,
  scenarioEncounterFor,
  scenarioEnding,
  scenarioProgress,
} from '../server/campaign-scenario.mjs'
import { fallbackDirectorIntent } from '../server/director-agent.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { getWorldTemplate } from '../server/world-template-catalog.mjs'

const hero = {
  id: 'scenario-hero',
  character: 'Испытатель',
  name: 'Игрок',
  role: 'Воин · ур. 7',
  species: 'Человек',
  background: 'Странник',
  level: 7,
  hp: 64,
  maxHp: 64,
  armor: 18,
  speed: 30,
}

const dice = () => new DiceService({ rng: new SequenceDiceRng([]) })

async function astohanCampaign() {
  const state = await new CampaignBootstrapper().create({
    code: 'SCENARIO-RUN',
    worldTemplateId: 'astohan-plains',
    players: [hero],
  })
  return normalizeCampaignState(state)
}

/** Переход тем же путём, что и голосование отряда: план Архитектора → AdvanceScene. */
async function travel(state, locationId, commandId) {
  const { sceneArgs } = await new SceneArchitectAgent().plan({
    state,
    decision: `Идём в ${locationId}`,
    destinationLocationId: locationId,
  })
  const result = resolveCommands([{ command_type: 'AdvanceScene', command_id: commandId, scene_args: sceneArgs }], state,
    { diceService: dice(), context: { isAdmin: true } })
  return { ...result, state: normalizeCampaignState(result.state) }
}

/** Находка: удачный поиск заменяет тайну фактом `discovery`, как `secretRevealCommand`. */
function discover(state, clueId, commandId) {
  const scenario = campaignScenario(state)
  const secretId = scenarioClueFactId(scenario, clueId)
  const secret = state.worldMemory.facts.find((fact) => fact.id === secretId)
  assert.ok(secret, `тайна ${clueId} записана при входе в место`)
  const result = resolveCommands([{ command_type: 'RecordWorldFact', command_id: commandId, fact: {
    id: `fact-secret-found-${clueId}`,
    subject_id: secret.subject_id,
    predicate: 'discovery',
    object: 'clue',
    summary: secret.summary,
    visibility: 'party',
    source_event_ids: [],
    supersedes_fact_id: secretId,
  } }], state, { diceService: dice(), context: { isAdmin: true } })
  return normalizeCampaignState(result.state)
}

/** Путь к логову: логово скрыто, пока отряд не дошёл до перевала. */
async function toLair() {
  let state = (await travel(await astohanCampaign(), 'astohan-ash-watch', 'scenario-to-ash')).state
  state = (await travel(state, 'astohan-obsidian-pass', 'scenario-to-pass')).state
  return (await travel(state, 'astohan-vulkanis-brazier', 'scenario-to-lair')).state
}

/** Состояние «бой с главным противником завершён и исход записан». */
function afterBossFight(state, outcome) {
  return {
    ...state,
    mechanics: {
      ...state.mechanics,
      combat: { ...state.mechanics.combat, active: false },
      encounter: { id: 'encounter-boss', status: 'ended', outcome, enemy_ids: ['astohan-sargat'], difficulty: 'deadly' },
    },
    autonomy: { ...state.autonomy, encounter_outcomes: [{ encounter_id: 'encounter-boss', outcome }] },
  }
}

test('сценарий Асстохана ссылается только на места и NPC своего мира', () => {
  const scenarios = listCampaignScenarios()
  assert.equal(scenarios.length, 1)
  const [scenario] = scenarios
  const template = getWorldTemplate(scenario.world_template_id)
  const locations = new Map(template.world_map.locations.map((location) => [location.id, location]))
  const npcs = new Map(template.opening.npcs.map((npc) => [npc.id, npc]))

  for (const card of scenario.locations) assert.ok(locations.has(card.location_id), card.location_id)
  assert.equal(scenario.locations.length, locations.size, 'у каждого места мира есть карточка сцены')
  for (const beat of scenario.beats) {
    for (const locationId of beat.location_ids) assert.ok(locations.has(locationId), `${beat.id}: ${locationId}`)
  }
  const finale = scenario.beats.find((beat) => beat.kind === 'finale')
  const boss = npcs.get(finale.boss.npc_id)
  assert.ok(boss?.mechanics, 'у главного противника есть боевой лист')
  assert.equal(boss.location, locations.get(finale.boss.location_id).name, 'главный противник живёт там, где назначен бой')
  const npcConditions = JSON.stringify(scenario.beats).match(/"npc_defeated":"([^"]+)"/gu) ?? []
  for (const entry of npcConditions) assert.ok(npcs.has(entry.split('"')[3]), entry)
  assert.deepEqual(scenario.endings.map((ending) => ending.id).sort(), ['banished', 'defeat', 'slain', 'treaty'])
  const roads = new Set(template.world_map.routes.map((route) => [route.from, route.to].sort().join(':')))
  for (const reveal of scenario.map_reveals) {
    for (const route of reveal.routes) assert.ok(roads.has([...route].sort().join(':')), `${reveal.id}: дорога ${route.join(' — ')} есть на карте мира`)
  }
})

test('кампания Асстохана получает арку сценария, свободный мир — прежнюю вечернюю', async () => {
  const state = await astohanCampaign()
  assert.equal(state.campaignConcept.arc.version, SCENARIO_ARC_VERSION)
  assert.equal(campaignScenario(state)?.id, 'astohan-dragon-hunt')
  const position = campaignArcPosition(state)
  assert.equal(position.phase, 'breather')
  assert.equal(position.is_final, false)
  assert.equal(scenarioProgress(state).beats.find((beat) => beat.id === 'prologue').completed, false)

  const free = await new CampaignBootstrapper().create({ code: 'FREE-RUN', worldTemplateId: 'league-nine-tides', players: [hero] })
  assert.notEqual(free.campaignConcept.arc?.version, SCENARIO_ARC_VERSION)
  assert.equal(campaignScenario(free), null)
})

test('переход в место сценария берёт его карточку и тайны со стабильными id; replay сходится', async () => {
  const start = await astohanCampaign()
  assert.equal(nextWorldMapDestination(start), 'Пепельная застава', 'из пролога сюжет зовёт на заставу')

  const arrived = await travel(start, 'astohan-ash-watch', 'scenario-to-ash')
  const { state } = arrived
  assert.equal(state.scene.location_id, 'astohan-ash-watch')
  assert.equal(state.scene.title, 'Глава 1 · Пепельная застава')
  assert.equal(state.scene.objective, 'Осмотреть сожжённую заставу и понять, кто впустил дракона')

  const scenario = campaignScenario(state)
  const secrets = state.worldMemory.facts.filter((fact) => fact.id.startsWith(`fact:secret:scenario:${scenario.id}:ash-`))
  assert.equal(secrets.length, 3)
  assert.ok(secrets.every((fact) => fact.predicate === 'gm_secret' && fact.visibility === 'gm_only'))

  const progress = scenarioProgress(state)
  assert.equal(progress.beats.find((beat) => beat.id === 'prologue').completed, true, 'отряд покинул Штормберг')
  assert.equal(progress.beats.find((beat) => beat.id === 'ash-watch').completed, false)

  const replayed = normalizeCampaignState(replayEvents(start, arrived.events))
  assert.equal(replayed.scene.title, state.scene.title)
  assert.deepEqual(replayed.worldMemory.facts.map((fact) => fact.id), state.worldMemory.facts.map((fact) => fact.id))
})

test('находка закрывает главу, и сюжет зовёт к ближайшей линии; возвращение не дублирует тайны', async () => {
  const atAsh = (await travel(await astohanCampaign(), 'astohan-ash-watch', 'scenario-to-ash')).state
  const found = discover(atAsh, 'ash-gate', 'scenario-find-gate')
  assert.equal(scenarioProgress(found).beats.find((beat) => beat.id === 'ash-watch').completed, true)

  const targets = scenarioDestinationIds(found)
  assert.ok(targets.length > 0)
  assert.ok(!targets.includes('astohan-vulkanis-brazier'), 'финал не раньше двух линий')
  const next = nextWorldMapDestination(found)
  const nextId = found.worldMap.locations.find((location) => location.name === next)?.id
  assert.ok(targets.includes(nextId), `следующая точка ${next} — из сюжета`)

  const away = (await travel(found, 'astohan-stormberg', 'scenario-back-home')).state
  const back = (await travel(away, 'astohan-ash-watch', 'scenario-ash-again')).state
  const scenario = campaignScenario(back)
  const ashSecrets = back.worldMemory.facts.filter((fact) => fact.id.startsWith(`fact:secret:scenario:${scenario.id}:ash-`))
  assert.equal(ashSecrets.length, 3, 'тайны места заводятся один раз')
})

test('линии открывают финал; в логове Режиссёр собирает бой с Саргатом, а не со зверями', async () => {
  let state = (await travel(await astohanCampaign(), 'astohan-ash-watch', 'scenario-to-ash')).state
  state = discover(state, 'ash-gate', 'scenario-find-gate')
  const lairBefore = state.worldMap.locations.find((location) => location.id === 'astohan-vulkanis-brazier')
  assert.equal(lairBefore.known, false, 'логово скрыто до перевала')
  state = (await travel(state, 'astohan-obsidian-pass', 'scenario-to-pass')).state
  assert.equal(campaignArcPosition(state).phase, 'escalation', 'подход к логову — нарастание')
  assert.equal(state.worldMap.locations.find((location) => location.id === 'astohan-vulkanis-brazier').known, true, 'с перевала логово видно')
  assert.equal(state.worldMap.routes.find((route) => route.to === 'astohan-vulkanis-brazier' && route.from === 'astohan-obsidian-pass').discovered, true)
  state = (await travel(state, 'astohan-vulkanis-brazier', 'scenario-to-lair')).state

  const position = campaignArcPosition(state)
  assert.equal(position.phase, 'climax')
  assert.equal(position.is_final, true)
  assert.deepEqual(scenarioEncounterFor(state), { npc_id: 'astohan-sargat', difficulty: 'deadly' })

  const fallback = fallbackDirectorIntent(state, 'Ищем бой с драконом')
  assert.equal(fallback.type, 'request_encounter')
  assert.equal(fallback.npc_id, 'astohan-sargat')
  assert.equal(fallback.difficulty, 'deadly')

  const modelProposal = authorizeDirectorIntent(state, { type: 'request_encounter', theme: 'beasts', difficulty: 'hard' }, { playerAction: 'Ищем бой' })
  assert.equal(modelProposal.intent.npc_id, 'astohan-sargat', 'модель не подменит Саргата стаей зверей')
  assert.equal(modelProposal.intent.difficulty, 'deadly')
})

test('исход боя с Саргатом выбирает развязку и разрешает финал; смертельная встреча засчитывается', async () => {
  const lair = await toLair()
  assert.equal(campaignCanAutoComplete(lair), false, 'без боя финала нет')

  const cases = [
    ['enemies_defeated', 'slain'],
    ['fled', 'banished'],
    ['parley', 'treaty'],
    ['party_incapacitated', 'defeat'],
  ]
  for (const [outcome, ending] of cases) {
    const state = afterBossFight(lair, outcome)
    assert.equal(scenarioEnding(state)?.id, ending, outcome)
    assert.equal(campaignArcClimaxSatisfied(state), true, outcome)
    assert.equal(campaignCanAutoComplete(state), true, outcome)
    assert.equal(campaignCanAdvanceArc(state), false, 'у сценария нет следующей арки')
  }

  const notRecorded = afterBossFight(lair, 'enemies_defeated')
  notRecorded.autonomy = { ...notRecorded.autonomy, encounter_outcomes: [] }
  assert.equal(scenarioEnding(notRecorded), null, 'исход без записанного EncounterOutcomeRecorded не считается')
})

test('CompleteCampaign записывает развязку сценария, и она переживает replay', async () => {
  const lair = await toLair()
  const ready = afterBossFight(lair, 'fled')
  const result = resolveCommands([{
    command_type: 'CompleteCampaign',
    command_id: 'scenario-complete',
    reason: 'main_thread_resolved_at_climax',
    epilogue: scenarioEnding(ready).epilogue,
  }], ready, { diceService: dice(), context: { isDirector: true } })
  const completed = result.events.find((event) => event.event_type === 'CampaignCompleted')
  assert.deepEqual(completed.payload.ending, { id: 'banished', title: 'Саргат изгнан', outcome: 'fled' })
  const lifecycle = normalizeCampaignState(result.state).mechanics.campaign_lifecycle
  assert.equal(lifecycle.status, 'completed')
  assert.equal(lifecycle.ending.id, 'banished')

  const replayed = normalizeCampaignState(replayEvents(ready, result.events))
  assert.equal(replayed.mechanics.campaign_lifecycle.ending.id, 'banished')
})

test('в покинутом замке и у башни мага стражи нет, в столице — есть', async () => {
  const { currentSettlement } = await import('../server/law-and-order.mjs')
  const start = await astohanCampaign()
  assert.equal(currentSettlement(start)?.node_id, 'astohan-stormberg')
  const at = (locationId) => ({ ...start, scene: { ...start.scene, location_id: locationId }, worldMap: { ...start.worldMap, currentLocationId: locationId } })
  assert.equal(currentSettlement(at('astohan-forgotten-cliffs')), null)
  assert.equal(currentSettlement(at('astohan-lomar-tower')), null)
  assert.equal(currentSettlement(at('astohan-quiet-watch-camp'))?.node_id, 'astohan-quiet-watch-camp', 'у дозорного стана гарнизон есть')
})

test('обойдя места линий, отряд зовётся в логово, а не по кругу за пропущенными уликами', async () => {
  const start = await astohanCampaign()
  const lineIds = ['astohan-redstone', 'astohan-lomar-tower', 'astohan-wild-forest', 'astohan-eldrin-heart', 'astohan-forgotten-cliffs',
    'astohan-mittlayd', 'astohan-quiet-watch-camp', 'astohan-smugglers-cave']
  const at = (visitedIds) => ({
    ...start,
    scene: { ...start.scene, location: 'Митглайд', location_id: 'astohan-mittlayd' },
    adventure: {
      ...start.adventure,
      visitedLocationIds: ['astohan-stormberg', 'astohan-ash-watch', ...visitedIds],
      history: [{ location: 'Штормберг', location_id: 'astohan-stormberg' }, { location: 'Пепельная застава', location_id: 'astohan-ash-watch' }],
    },
    worldMap: { ...start.worldMap, currentLocationId: 'astohan-mittlayd' },
  })
  const midway = scenarioDestinationIds(at(['astohan-mittlayd', 'astohan-forgotten-cliffs']))
  assert.ok(!midway.includes('astohan-forgotten-cliffs'), 'посещённое место с ненайденной уликой не зовёт, пока есть новые')
  assert.notEqual(midway[0], 'astohan-vulkanis-brazier', 'до обхода линий финал не первый')
  const exhausted = scenarioDestinationIds(at(lineIds))
  assert.equal(exhausted[0], 'astohan-vulkanis-brazier', 'линии обойдены — сюжет зовёт в логово')
})
