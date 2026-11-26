import assert from 'node:assert/strict'
import test from 'node:test'

import { CampaignBootstrapper } from '../server/campaign-bootstrap.mjs'
import { campaignScenario, scenarioClueFactId } from '../server/campaign-scenario.mjs'
import { SceneArchitectAgent } from '../server/scene-architect.mjs'
import { normalizeCampaignState, resolveCommands } from '../server/rules-engine.mjs'
import { fixedDice } from './kit/dice.mjs'
import { addPlayer, createCampaign, expectStatus, sendCommand, setupAdmin, startTestServer } from './kit/http.mjs'
import { readJournal } from './kit/journal.mjs'
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

const COMPANION = { ...HERO, id: 'treaty-http-companion', character: 'Тавин' }

async function lairState(code = CODE, { combat = false, players = [HERO], decisionTtlMs } = {}) {
  let state = normalizeCampaignState(await new CampaignBootstrapper().create({
    code,
    worldTemplateId: 'astohan-plains',
    players,
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
    partyMemberIds: players.map(({ id }) => id),
    partyDecisionPolicy: { decisionTtlMs },
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

  const request = {
    idempotency_key: 'old-treaty-director',
    actor_id: HERO_ID,
    player_action: 'Ищем бой с Саргатом в Жаровне Вулканиса',
  }
  const advanced = await admin.post(`/api/campaigns/${code}/autonomy/advance`, request)
  assert.equal(advanced.status, 200, advanced.text)
  assert.equal(advanced.body.state.mechanics.campaign_lifecycle.status, 'completed')
  assert.equal(advanced.body.state.mechanics.campaign_lifecycle.ending?.id, 'treaty')
  assert.match(String(advanced.body.state.mechanics.campaign_lifecycle.epilogue), /Саргат|договор/u)
  assert.equal(advanced.body.state.mechanics.combat?.active, false)
  const repeat = expectStatus(await admin.post(`/api/campaigns/${code}/autonomy/advance`, request))
  assert.equal(repeat.duplicate, true)
  assert.equal(repeat.state.mechanics.campaign_lifecycle.ending?.id, 'treaty')

  const journal = await readJournal(server, code)
  assert.equal(journal.events.filter((event) => event.event_type === 'CampaignCompleted').length, 1)
  assert.equal(journal.events.filter((event) => event.event_type === 'EncounterCreated' || event.event_type === 'CombatStarted').length, 0)
  assert.equal(journal.state.mechanics.campaign_lifecycle.ending.id, 'treaty')
})

async function startTreatyParty(t, code, { dice = MAX_DICE, ...options } = {}) {
  const server = await startTestServer(t, { dice, storagePrefix: 'skazanie-treaty-vote-' })
  const { client: admin } = await setupAdmin(server, {
    name: 'Ведущий отряда', email: 'treaty-party-admin@test.local', password: 'secure-treaty-admin-password',
  })
  const state = await lairState(code, { ...options, players: [HERO, COMPANION] })
  await createCampaign(admin, { code, name: 'Решение отряда', state })
  const first = (await addPlayer(server, admin, code, {
    heroIds: [HERO.id], name: HERO.character, email: 'treaty-party-first@test.local', password: 'secure-treaty-player-password',
  })).client
  const second = (await addPlayer(server, admin, code, {
    heroIds: [COMPANION.id], name: COMPANION.character, email: 'treaty-party-second@test.local', password: 'secure-treaty-player-password',
  })).client
  return { server, first, second }
}

function castTreatyVote(client, code, decision, hero, option, key) {
  return client.post(`/api/campaigns/${code}/party-decisions/${decision.id}/votes`, {
    actor_id: hero.id, option_id: option, idempotency_key: key,
  })
}

test('договор требует голосов двух игроков, переживает перезапуск и исполняется один раз', { timeout: runnerTimeout(180_000) }, async (t) => {
  const code = 'TREATY-PARTY'
  const { server, first, second } = await startTreatyParty(t, code)
  const command = { command_type: 'ChooseDialogueOption', actor_id: HERO.id, npc_id: SARGAT, option_id: 'treaty' }
  const opened = expectStatus(await sendCommand(first, code, 'treaty-open', command))
  assert.deepEqual(opened.mechanics.map((event) => event.event_type), ['PartyDecisionOpened'])
  const decision = opened.authoritative_state.agentInteraction
  assert.equal(decision.scenarioTreaty.actorId, HERO.id)
  assert.equal(decision.requiredVotes, 2)
  assert.match(decision.description, /Вулканиса.*вир.*эпилог/u)
  const duplicate = expectStatus(await sendCommand(first, code, 'treaty-open', command))
  assert.equal(duplicate.idempotent_replay, true)
  assert.equal(duplicate.authoritative_state.agentInteraction.id, decision.id)
  const view = expectStatus(await second.get(`/api/rooms/${code}`))
  assert.deepEqual(view.state.agentInteraction.options, decision.options)
  assert.equal(view.state.agentInteraction.description, decision.description)
  assert.equal(view.state.mechanics.campaign_lifecycle.status, 'active')

  const forced = await sendCommand(first, code, 'treaty-force', {
    command_type: 'NegotiateScenarioTreaty', actor_id: HERO.id, interaction_id: decision.id,
    resolved_option_id: 'accept', isDirector: true, difficulty: 0,
  })
  assert.equal(forced.status, 403, forced.text)
  const forgedResolution = await sendCommand(first, code, 'treaty-forged-resolution', {
    command_type: 'ResolveScenarioTreatyDecision', actor_id: HERO.id, interaction_id: decision.id, resolved_option_id: 'accept',
  })
  assert.equal(forgedResolution.status, 403, forgedResolution.text)
  const forged = await castTreatyVote(first, code, decision, COMPANION, 'accept', 'treaty-forged')
  assert.equal(forged.status, 403, forged.text)
  const firstVote = expectStatus(await castTreatyVote(first, code, decision, HERO, 'accept', 'treaty-vote-a'))
  assert.equal(firstVote.state.mechanics.campaign_lifecycle.status, 'active')
  assert.equal(firstVote.state.agentInteraction.status, 'open')
  await server.restart()
  assert.equal(expectStatus(await second.get(`/api/rooms/${code}`)).state.agentInteraction.id, decision.id)

  const agreed = expectStatus(await castTreatyVote(second, code, decision, COMPANION, 'accept', 'treaty-vote-b'))
  assert.equal(agreed.state.agentInteraction, null)
  assert.equal(agreed.state.mechanics.campaign_lifecycle.status, 'completed')
  const repeat = expectStatus(await castTreatyVote(second, code, decision, COMPANION, 'accept', 'treaty-vote-b'))
  assert.equal(repeat.state.mechanics.campaign_lifecycle.ending.id, 'treaty')
  const lateProposalRetry = expectStatus(await sendCommand(first, code, 'treaty-open', command))
  assert.equal(lateProposalRetry.idempotent_replay, true)
  assert.equal(lateProposalRetry.authoritative_state.mechanics.campaign_lifecycle.ending.id, 'treaty')
  const replay = await readJournal(server, code, { useSnapshots: false })
  const counts = ['PartyDecisionOpened', 'PartyDecisionResolved', 'PartyDecisionConsumed', 'AbilityCheckResolved', 'ScenarioTreatyConcluded', 'CampaignCompleted']
  assert.deepEqual(replay.events.filter((event) => counts.includes(event.event_type)).map((event) => event.event_type), counts)
  assert.equal(replay.state.mechanics.campaign_lifecycle.ending.id, 'treaty')
})

test('молчание второго игрока и отказ сохраняют кампанию без попытки проверки', { timeout: runnerTimeout(180_000) }, async (t) => {
  const code = 'TREATY-DECLINE'
  const { server, first, second } = await startTreatyParty(t, code, { decisionTtlMs: 8_000 })
  const proposal = (key) => first.post('/api/narrate', {
    campaign_id: code, actor_id: HERO.id, action: 'Предлагаю Саргату договор', idempotency_key: key,
  })
  const open = expectStatus(await proposal('treaty-await'))
  const decision = open.authoritative_state.agentInteraction
  assert.ok(decision?.scenarioTreaty)
  const firstVote = expectStatus(await castTreatyVote(first, code, decision, HERO, 'accept', 'treaty-await-a'))
  assert.equal(firstVote.state.agentInteraction.status, 'open')
  await new Promise((resolve) => setTimeout(resolve, Math.max(1, decision.expiresAt - Date.now() + 20)))
  const expiredResponse = await second.get(`/api/rooms/${code}`)
  assert.equal(expiredResponse.status, 200, server.output())
  const expired = expiredResponse.body
  assert.equal(expired.state.agentInteraction, null)
  assert.equal(expired.state.mechanics.campaign_lifecycle.status, 'active')
  const fresh = expectStatus(await proposal('treaty-decline')).authoritative_state.agentInteraction
  assert.notEqual(fresh.id, decision.id)
  expectStatus(await castTreatyVote(first, code, fresh, HERO, 'accept', 'treaty-decline-a'))
  const refused = expectStatus(await castTreatyVote(second, code, fresh, COMPANION, 'decline', 'treaty-decline-b'))
  assert.equal(refused.state.agentInteraction, null)
  assert.equal(refused.state.mechanics.campaign_lifecycle.status, 'active')
  const journal = await readJournal(server, code)
  assert.equal(journal.events.filter((event) => event.event_type === 'PartyDecisionConsumed').length, 2)
  assert.ok(!journal.events.some((event) => ['AbilityCheckResolved', 'ScenarioTreatyConcluded', 'CampaignCompleted'].includes(event.event_type)))

  const offeredToNpc = { campaign_id: code, actor_id: HERO.id, npc_id: SARGAT, action: 'Предлагаю Саргату договор', idempotency_key: 'treaty-late-confirm' }
  const another = expectStatus(await first.post('/api/narrate', offeredToNpc)).authoritative_state.agentInteraction
  assert.ok(another?.scenarioTreaty)
  expectStatus(await castTreatyVote(first, code, another, HERO, 'accept', 'treaty-confirm-a'))
  const final = expectStatus(await castTreatyVote(second, code, another, COMPANION, 'accept', 'treaty-confirm-b'))
  assert.equal(final.state.mechanics.campaign_lifecycle.ending?.id, 'treaty')
  const retried = expectStatus(await first.post('/api/narrate', offeredToNpc))
  assert.equal(retried.idempotent_replay, true)
  assert.equal(retried.authoritative_state.mechanics.campaign_lifecycle.ending?.id, 'treaty')
})

test('кнопка переговоров с Саргатом ведёт в тот же кворум и не обходит провал проверки', { timeout: runnerTimeout(180_000) }, async (t) => {
  const code = 'TREATY-HOTBAR'
  const dice = { ...MAX_DICE, rules: [{ value: 1 }] }
  const { server, first, second } = await startTreatyParty(t, code, { combat: true, dice })
  const open = expectStatus(await first.post(`/api/campaigns/${code}/commands`, {
    idempotency_key: 'treaty-hotbar', manual_roll: true, command: { command_type: 'ProposeParley', actor_id: HERO.id, skill: 'intimidation' },
  }))
  assert.equal(open.check ?? null, null)
  const decision = open.authoritative_state.agentInteraction
  assert.ok(decision?.scenarioTreaty, server.output())
  assert.equal(decision.requiredVotes, 2)
  assert.equal(open.authoritative_state.mechanics.combat.active, true)
  assert.notEqual(open.authoritative_state.mechanics.combat.action_economy[HERO.id]?.action, false)
  expectStatus(await castTreatyVote(first, code, decision, HERO, 'accept', 'treaty-hotbar-a'))
  const refused = expectStatus(await castTreatyVote(second, code, decision, COMPANION, 'accept', 'treaty-hotbar-b'))
  assert.equal(refused.state.agentInteraction, null)
  assert.equal(refused.state.mechanics.campaign_lifecycle.status, 'active')
  assert.equal(refused.state.mechanics.combat.active, true)
  assert.equal(refused.state.mechanics.combat.action_economy[HERO.id].action, false)
  expectStatus(await castTreatyVote(second, code, decision, COMPANION, 'accept', 'treaty-hotbar-b'))
  const journal = await readJournal(server, code)
  const actionUses = journal.events.filter((event) => event.event_type === 'CombatActionUsed' && event.payload.action_id === 'scenario-treaty')
  assert.equal(actionUses.length, 1)
  assert.equal(actionUses[0].actor_id, HERO.id)
  const checks = journal.events.filter((event) => event.event_type === 'AbilityCheckResolved')
  assert.equal(checks.length, 1)
  assert.equal(checks[0].payload.skill, 'persuasion')
  assert.equal(checks[0].payload.success, false)
  assert.equal(journal.events.filter((event) => event.event_type === 'ScenarioTreatyRefused').length, 1)
  assert.ok(!journal.events.some((event) => event.event_type === 'CampaignCompleted' || event.event_type === 'TruceOpened'))
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
  assert.equal(journal.events.filter((event) => event.event_type === 'CombatActionUsed' && event.payload.action_id === 'scenario-treaty').length, 1)
  assert.equal(journal.state.mechanics.campaign_lifecycle.ending.id, 'treaty')
})


