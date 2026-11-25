import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { campaignScenario, scenarioClueFactId } from '../server/campaign-scenario.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { normalizeCampaignState, resolveCommands } from '../server/rules-engine.mjs'
import { fixedDice } from './kit/dice.mjs'
import { addPlayer, createCampaign, expectStatus, sendCommand, setupAdmin, startTestServer } from './kit/http.mjs'
import { readJournal } from './kit/journal.mjs'
import { chatCompletion, startFakeProvider } from './kit/llm.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const CODE = 'TREATY-HTTP'
const HERO_ID = 'treaty-http-hero'
const SARGAT = 'astohan-sargat'
const HERO = {
  id: HERO_ID,
  character: 'Рейна',
  name: 'Игрок договора',
  role: 'Воин · ур. 9',
  species: 'Человек',
  background: 'Странница',
  level: 9,
  hp: 70,
  maxHp: 70,
  armor: 16,
  speed: 30,
  abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 16 },
  inventory: [],
}

const MAX_DICE = {
  format: 'skazanie.test-dice/1',
  unmatched: 'random',
  rules: [{ sides: 20, value: 'max' }, { value: 'max' }],
}

async function lairState(code = CODE, { combat = false } = {}) {
  let state = normalizeCampaignState(await new CampaignBootstrapper().create({
    code,
    worldTemplateId: 'astohan-plains',
    players: [HERO],
    campaignMode: 'adventure',
  }))
  const scenario = campaignScenario(state)
  for (const clueId of ['stormberg-journal-page', 'ares-confession']) {
    const factId = scenarioClueFactId(scenario, clueId)
    const secret = state.worldMemory.facts.find((fact) => fact.id === factId)
    assert.ok(secret, `${clueId}: исходная тайна должна быть записана`)
    state.worldMemory.facts.push({
      id: `fact-found-${clueId}`,
      subject_id: secret.subject_id,
      predicate: 'discovery',
      object: 'clue',
      summary: secret.summary,
      visibility: 'party',
      source_event_ids: [],
      supersedes_fact_id: factId,
      status: 'active',
    })
  }
  for (const locationId of ['astohan-ash-watch', 'astohan-obsidian-pass', 'astohan-vulkanis-brazier']) {
    const { sceneArgs } = await new SceneArchitectAgent().plan({
      state,
      decision: `Идём в ${locationId}`,
      destinationLocationId: locationId,
    })
    state = normalizeCampaignState(resolveCommands([{
      command_type: 'AdvanceScene',
      command_id: `${code}-arrive-${locationId}`,
      scene_args: sceneArgs,
    }], state, { diceService: fixedDice(10), context: { isAdmin: true } }).state)
  }
  assert.equal(state.scene.location_id, 'astohan-vulkanis-brazier')
  if (combat) {
    state = normalizeCampaignState(resolveCommands([{
      command_type: 'CreateEncounter',
      command_id: `${code}-encounter`,
      actor_id: HERO.id,
      npc_id: SARGAT,
      difficulty: 'deadly',
      seed: `${code}-fight`,
    }], state, { diceService: fixedDice(10), context: { isDirector: true } }).state)
    state = normalizeCampaignState(resolveCommands([{
      command_type: 'StartCombat', command_id: `${code}-start`, actor_id: HERO.id, server_authoritative: true,
    }], state, { diceService: fixedDice(10), context: { isDirector: true } }).state)
    const boss = state.enemies.find((enemy) => enemy.id === SARGAT)
    assert.ok(boss, 'финальный босс должен быть в бою')
    boss.hp = Math.floor(Number(boss.maxHp) * 0.45)
    state.mechanics.combat.active_index = state.mechanics.combat.initiative.findIndex((entry) => entry.actor_id === HERO.id)
  }
  return normalizeCampaignState({
    sessionCode: code,
    campaign: 'Договор Асстохана',
    partyName: 'Отряд договора',
    partyMemberIds: [HERO.id],
    campaignConcept: state.campaignConcept,
    worldMap: state.worldMap,
    worldMemory: state.worldMemory,
    adventure: state.adventure,
    players: state.players,
    enemies: combat ? state.enemies : [],
    entities: [],
    merchants: [],
    mechanics: state.mechanics,
    activePlayerId: HERO.id,
    ruleset_id: state.ruleset_id,
    ruleset_version: state.ruleset_version,
    enabled_rule_packs: state.enabled_rule_packs,
    scene: state.scene,
    social: state.social,
    npc_world: state.npc_world,
    scenario_attention: state.scenario_attention,
    autonomy: state.autonomy,
    law: state.law,
    messages: [],
    battleLog: [],
    rulings: {},
    state_version: 0,
  })
}

test('договор через диалог сразу завершает кампанию и не создаёт новый бой', { timeout: runnerTimeout(180_000) }, async (t) => {
  const server = await startTestServer(t, { dice: MAX_DICE, storagePrefix: 'skazanie-treaty-completion-' })
  const { client: admin } = await setupAdmin(server, {
    name: 'Ведущий договора',
    email: 'treaty-completion-admin@test.local',
    password: 'secure-treaty-admin-password',
  })
  const state = await lairState()
  await createCampaign(admin, { code: CODE, name: 'Договор Асстохана', state })
  const player = (await addPlayer(server, admin, CODE, {
    heroIds: [HERO_ID],
    name: 'Игрок договора',
    email: 'treaty-completion-player@test.local',
    password: 'secure-treaty-player-password',
  })).client

  const before = expectStatus(await player.get(`/api/rooms/${CODE}`))
  const dialogue = before.state.scene_dialogues?.[SARGAT]
  assert.ok(dialogue, 'Саргат должен быть доступен для разговора в логове')
  assert.ok(dialogue.options.some((option) => option.id === 'treaty'), 'вариант договора должен быть виден игроку')

  const chosen = expectStatus(await sendCommand(player, CODE, 'treaty-dialogue', {
    command_type: 'ChooseDialogueOption',
    actor_id: HERO_ID,
    npc_id: SARGAT,
    option_id: 'treaty',
  }))
  assert.ok(chosen.mechanics.some((event) => event.event_type === 'ScenarioTreatyConcluded'))

  const after = expectStatus(await player.get(`/api/rooms/${CODE}`))
  assert.equal(after.state.mechanics.campaign_lifecycle.status, 'completed')
  assert.equal(after.state.mechanics.campaign_lifecycle.ending?.id, 'treaty')
  assert.match(String(after.state.mechanics.campaign_lifecycle.epilogue), /Саргат|договор/u)
  assert.equal(after.state.mechanics.combat?.active, false)
  assert.equal(after.state.mechanics.encounter?.status ?? 'none', 'none')

  const repeated = expectStatus(await sendCommand(player, CODE, 'treaty-dialogue', {
    command_type: 'ChooseDialogueOption', actor_id: HERO_ID, npc_id: SARGAT, option_id: 'treaty',
  }))
  assert.equal(repeated.idempotent_replay, true)
  assert.equal(repeated.authoritative_state.mechanics.campaign_lifecycle.ending.id, 'treaty')

  const directorial = await admin.post(`/api/campaigns/${CODE}/autonomy/advance`, {
    idempotency_key: 'treaty-after-director', actor_id: HERO_ID,
    player_action: 'Ищем бой с Саргатом в Жаровне Вулканиса',
  })
  assert.equal(directorial.status, 409, directorial.text)
  assert.match(String(directorial.body?.code), /CAMPAIGN|LIFECYCLE|COMPLETED/u)

  const journal = await readJournal(server, CODE)
  const completed = journal.events.filter((event) => event.event_type === 'CampaignCompleted')
  const treaty = journal.events.filter((event) => event.event_type === 'ScenarioTreatyConcluded')
  assert.equal(treaty.length, 1)
  assert.equal(completed.length, 1)
  assert.ok(journal.events.indexOf(completed[0]) > journal.events.indexOf(treaty[0]))
  assert.ok(!journal.events.slice(journal.events.indexOf(treaty[0]) + 1, journal.events.indexOf(completed[0])).some((event) => event.event_type === 'EncounterCreated' || event.event_type === 'CombatStarted'))

  const replayed = await readJournal(server, CODE, { useSnapshots: false })
  assert.equal(replayed.state.mechanics.campaign_lifecycle.ending.id, 'treaty')
  assert.equal(replayed.state.mechanics.campaign_lifecycle.status, 'completed')

  await server.restart()
  const afterRestart = expectStatus(await player.get(`/api/rooms/${CODE}`))
  assert.equal(afterRestart.state.mechanics.campaign_lifecycle.status, 'completed')
  assert.equal(afterRestart.state.mechanics.campaign_lifecycle.ending?.id, 'treaty')
})

test('диалог о подписанном признании завершает кампанию без броска', { timeout: runnerTimeout(180_000) }, async (t) => {
  const code = 'SIGNED-TREATY-HTTP'
  const fake = await startFakeProvider(t, () => chatCompletion('Отряд только прибыл в логово и ещё не решил судьбу дракона.'))
  const server = await startTestServer(t, {
    storagePrefix: 'skazanie-signed-treaty-',
    env: { OPENROUTER_API_KEY: 'kit-free', DND_AI_OPENROUTER_BASE_URL: fake.baseUrl },
  })
  const { client: admin } = await setupAdmin(server)
  const state = await lairState(code)
  state.dialogues = { 'astohan-ares': { flags: ['ares-signed-confession'] } }
  await createCampaign(admin, { code, state })
  const { client: player } = await addPlayer(server, admin, code, { heroIds: [HERO_ID] })
  const { state: before } = expectStatus(await player.get(`/api/rooms/${code}`))
  const option = before.scene_dialogues[SARGAT].options.find((entry) => entry.id === 'signed-treaty')
  assert.ok(option, 'в диалоге доступно письменное признание')
  assert.equal(option.check, undefined)

  const result = expectStatus(await sendCommand(player, code, 'signed-treaty-dialogue', {
    command_type: 'ChooseDialogueOption',
    actor_id: HERO_ID,
    npc_id: SARGAT,
    option_id: option.id,
  }))
  assert.ok(result.mechanics.some((event) => event.event_type === 'ScenarioTreatyConcluded'))
  assert.ok(result.mechanics.every((event) => event.event_type !== 'AbilityCheckResolved'))
  const { state: after } = expectStatus(await player.get(`/api/rooms/${code}`))
  assert.equal(after.mechanics.campaign_lifecycle.status, 'completed')
  assert.equal(after.mechanics.campaign_lifecycle.ending.id, 'treaty')
  assert.match(after.mechanics.campaign_lifecycle.epilogue, /^Саргат ушёл с равнин по договору\./u)
  const journal = await readJournal(server, code)
  const completed = journal.events.find((event) => event.event_type === 'CampaignCompleted')
  assert.equal(completed?.payload.epilogue, after.mechanics.campaign_lifecycle.epilogue)
  assert.equal(fake.requests.length, 0, 'для авторского эпилога не запрашиваем модель')
})

test('старое активное сохранение с treaty.concluded закрывается перед первым запросом Директора', { timeout: runnerTimeout(180_000) }, async (t) => {
  const code = 'TREATY-OLD'
  const server = await startTestServer(t, { dice: MAX_DICE, storagePrefix: 'skazanie-treaty-old-' })
  const { client: admin } = await setupAdmin(server, {
    name: 'Ведущий старого договора',
    email: 'treaty-old-admin@test.local',
    password: 'secure-treaty-old-admin-password',
  })
  const state = await lairState(code)
  state.scenario_attention.treaty.concluded = true
  state.mechanics.campaign_lifecycle = { ...state.mechanics.campaign_lifecycle, status: 'active', ending: null, epilogue: null }
  await createCampaign(admin, { code, name: 'Старое сохранение договора', state })
  await addPlayer(server, admin, code, {
    heroIds: [HERO_ID],
    name: 'Игрок старого договора',
    email: 'treaty-old-player@test.local',
    password: 'secure-treaty-old-player-password',
  })

  const advanced = await admin.post(`/api/campaigns/${code}/autonomy/advance`, {
    idempotency_key: 'old-treaty-director',
    actor_id: HERO_ID,
    player_action: 'Ищем бой с Саргатом в Жаровне Вулканиса',
  })
  assert.equal(advanced.status, 200, advanced.text)
  assert.equal(advanced.body.state.mechanics.campaign_lifecycle.status, 'completed')
  assert.equal(advanced.body.state.mechanics.campaign_lifecycle.ending?.id, 'treaty')
  assert.match(String(advanced.body.state.mechanics.campaign_lifecycle.epilogue), /Саргат|договор/u)
  assert.equal(advanced.body.state.mechanics.combat?.active, false)

  const journal = await readJournal(server, code)
  assert.equal(journal.events.filter((event) => event.event_type === 'CampaignCompleted').length, 1)
  assert.equal(journal.events.filter((event) => event.event_type === 'EncounterCreated' || event.event_type === 'CombatStarted').length, 0)
  assert.equal(journal.state.mechanics.campaign_lifecycle.ending.id, 'treaty')
})

test('договор в уже начатом бою через обычную фразу закрывает бой и пишет эпилог', { timeout: runnerTimeout(180_000) }, async (t) => {
  const code = 'TREATY-COMBAT'
  const server = await startTestServer(t, { dice: MAX_DICE, storagePrefix: 'skazanie-treaty-combat-' })
  const { client: admin } = await setupAdmin(server, {
    name: 'Ведущий боя договора',
    email: 'treaty-combat-admin@test.local',
    password: 'secure-treaty-combat-admin-password',
  })
  const state = await lairState(code, { combat: true })
  await createCampaign(admin, { code, name: 'Договор в бою', state })
  const player = (await addPlayer(server, admin, code, {
    heroIds: [HERO_ID],
    name: 'Игрок боя договора',
    email: 'treaty-combat-player@test.local',
    password: 'secure-treaty-combat-player-password',
  })).client

  const body = {
    campaign_id: code,
    actor_id: HERO_ID,
    action: 'Предлагаю Саргату договор',
    manual_roll: true,
    idempotency_key: 'treaty-combat-narrate',
  }
  let response = await player.post('/api/narrate', body)
  assert.equal(response.status, 200, response.text)
  let answer = response.body
  if (answer.check?.check_id) {
    const rolled = expectStatus(await player.post('/api/roll', {
      campaignId: code, playerId: HERO_ID, checkId: answer.check.check_id,
    }))
    response = await player.post('/api/narrate', {
      ...body,
      action: body.action,
      idempotency_key: 'treaty-combat-narrate-roll',
      roll: { roll_id: rolled.roll_id },
    })
    assert.equal(response.status, 200, response.text)
    answer = response.body
  }
  const events = answer.mechanics ?? []
  assert.ok(events.some((event) => event.event_type === 'ScenarioTreatyConcluded'))
  assert.ok(events.some((event) => event.event_type === 'CampaignCompleted'))
  assert.equal(answer.authoritative_state.mechanics.campaign_lifecycle.status, 'completed')
  assert.equal(answer.authoritative_state.mechanics.campaign_lifecycle.ending?.id, 'treaty')
  assert.equal(answer.authoritative_state.mechanics.combat?.active, false)
  const journal = await readJournal(server, code)
  assert.equal(journal.events.filter((event) => event.event_type === 'CampaignCompleted').length, 1)
  assert.equal(journal.events.filter((event) => event.event_type === 'EncounterOutcomeRecorded' && event.payload?.outcome === 'parley').length, 1)
  assert.equal(journal.state.mechanics.campaign_lifecycle.ending.id, 'treaty')
})
