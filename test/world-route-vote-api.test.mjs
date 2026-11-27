import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'

import { createCampaignState, partyDecisionOpenedEvent, resolvePartyVote } from './kit/fixtures.mjs'
import { addPlayer, createCampaign, expectStatus, registerUser, setupAdmin, startTestServer } from './kit/http.mjs'
import { appendJournal, readJournal } from './kit/journal.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const HEROES = ['first', 'first-alt', 'second']
const DESTINATION = 'astohan-mittlayd'
const START = 'astohan-stormberg'

async function setup(t, code, ttl = 120_000, detour = false) {
  const server = await startTestServer(t)
  const { client: admin } = await setupAdmin(server)
  const state = await createCampaignState({
    code, worldTemplateId: 'astohan-plains', rulesetId: 'dnd_5e_2014', campaignMode: 'adventure',
    players: HEROES.map((id) => ({ id, character: id, name: id, hp: 18, maxHp: 18, armor: 13, abilities: { str: 12 }, inventory: [] })),
  })
  state.partyDecisionPolicy = { ...state.partyDecisionPolicy, decisionTtlMs: ttl }
  if (detour) {
    const origin = state.worldMap.locations.find((location) => location.id === START)
    state.worldMap.locations.push({
      id: 'detour', name: 'Сосновый хутор', kind: 'village', known: true,
      x: origin.x + 15, y: origin.y, regionId: origin.regionId,
    })
    state.worldMap.routes.push({ id: 'detour-road', from: START, to: 'detour', kind: 'road', discovered: true, distance: 1 })
    state.worldMemory.quests.push({
      id: 'quest-test', title: 'Охота на дракона', summary: 'Охота на дракона', status: 'active', visibility: 'party',
      objectives: ['Охота на дракона'], entity_ids: [], clock: { current: 0, max: 4, label: 'Срок' },
    })
  }
  await createCampaign(admin, { code, state })
  const { client: first } = await addPlayer(server, admin, code, { heroIds: HEROES.slice(0, 2) })
  const { client: second } = await addPlayer(server, admin, code, { heroIds: [HEROES[2]] })
  const { client: observer } = await registerUser(server)
  return { server, admin, first, second, observer }
}

const room = async (client, code) => expectStatus(await client.get('/api/rooms/' + code)).state

async function waitUntilRoom(client, code, predicate) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await room(client, code)
    if (predicate(state)) return state
    await sleep(100)
  }
  assert.fail('Кампания не достигла ожидаемого состояния')
}

function say(client, code, action, key) {
  return client.post('/api/narrate', { campaign_id: code, actor_id: HEROES[0], action, idempotency_key: key })
}
function vote(client, code, decision, actor, option, key) {
  return client.post('/api/campaigns/' + code + '/party-decisions/' + decision.id + '/votes', {
    actor_id: actor, option_id: option, idempotency_key: key,
  })
}

test('известный путь голосуют аккаунты: restart, один переход со всеми транзитами', { timeout: runnerTimeout(90_000) }, async (t) => {
  const code = 'WORLD-TRAVEL-VOTE'
  const { server, first, second, observer } = await setup(t, code)
  const initial = await room(first, code)
  assert.equal(initial.worldMap.currentLocationId, START)
  expectStatus(await say(first, code, 'Идём в Митглайд', 'travel-open'))
  const decision = (await room(first, code)).agentInteraction
  assert.equal(decision.destinationLocationId, DESTINATION)
  assert.equal(decision.requiredVotes, 2)
  assert.equal(decision.eligibleVoterIds.length, 2)
  assert.equal(decision.policy.disconnectAction, 'retain')
  assert.equal(decision.options.length, 2)
  const option = decision.options[0].id
  expectStatus(await vote(observer, code, decision, HEROES[0], option, 'observer'), 403)
  expectStatus(await vote(first, code, decision, HEROES[0], option, 'vote-first'))
  expectStatus(await vote(first, code, decision, HEROES[1], option, 'unclaimed-hero'), 403)
  await server.restart()
  const restarted = await room(second, code)
  assert.equal(restarted.agentInteraction.requiredVotes, 2)
  assert.deepEqual(restarted.agentInteraction.votes, { [HEROES[0]]: option })
  assert.equal(restarted.worldMap.currentLocationId, START)

  expectStatus(await vote(second, code, decision, HEROES[2], option, 'vote-second'))
  const arrived = await room(second, code)
  assert.equal(arrived.worldMap.currentLocationId, DESTINATION)
  assert.equal(arrived.adventure.chapter, initial.adventure.chapter + 1)
  const shortcut = (route) => [route.from, route.to].includes(START) && [route.from, route.to].includes(DESTINATION)
  assert.equal(initial.worldMap.routes.some(shortcut), false)
  assert.equal(arrived.worldMap.routes.some(shortcut), false, 'переход по отрезкам не создаёт прямую дорогу')
  assert.equal(arrived.agentInteraction, null)
  await server.restart()
  expectStatus(await vote(second, code, decision, HEROES[2], option, 'vote-second'))
  const journal = await readJournal(server, code)
  const travel = journal.events.filter((event) => event.event_type === 'SceneAdvanced' && event.payload.party_decision?.interaction_id === decision.id)
  assert.equal(travel.length, 1)
  assert.equal(journal.state.adventure.history.at(-1).location_id, START)
  assert.equal(journal.state.adventure.history.at(-1).entry_from_location_id, 'astohan-mirror-lake')
  assert.match(travel[0].payload.transition, /через «Озеро Двух Отражений»/u)
  // Штормберг → озеро — дорога на 120 минут, озеро → Митглайд — река на 150.
  const travelCommit = journal.commits.find((commit) => commit.events.some((event) => event.event_id === travel[0].event_id))
  const time = travelCommit.events.filter((event) => event.event_type === 'TimeAdvanced')
  assert.deepEqual(time.map((event) => event.payload.elapsed_minutes), [120 + 150])
  assert.deepEqual((await readJournal(server, code, { useSnapshots: false })).state, journal.state)
})

test('винительный падеж и маркер дают одну цель, срок без голосов отменяет переход', { timeout: runnerTimeout(90_000) }, async (t) => {
  const code = 'WORLD-TRAVEL-TIMEOUT'
  const { server, first } = await setup(t, code, 1_000, true)
  const target = 'astohan-ash-watch'
  for (const [index, action] of [
    'Идём в Пепельную заставу',
    '[ГЛОБАЛЬНАЯ КАРТА] [destination_location_id=' + target + '] Идём в Пепельную заставу',
  ].entries()) {
    expectStatus(await say(first, code, action, 'open-' + index))
    const opened = (await room(first, code)).agentInteraction
    assert.equal(opened.destinationLocationId, target)
    assert.equal(opened.options.length, 2)
    const after = await waitUntilRoom(first, code, (state) => !state.agentInteraction)
    assert.equal(after.worldMap.currentLocationId, START)
    assert.ok(after.messages.some((message) => /Переход отменён.*кворум/u.test(message.text)))
  }
  expectStatus(await say(first, code, 'Идём в Сосновый хутор', 'detour'))
  const detour = (await room(first, code)).agentInteraction
  assert.equal(detour.destinationLocationId, 'detour')
  assert.ok(detour.options.some((option) => /бросаем задание/u.test(option.label)))
  const journal = await readJournal(server, code)
  assert.equal(journal.events.filter((event) => event.event_type === 'SceneAdvanced').length, 0)
  assert.equal(journal.events.filter((event) => event.event_type === 'PartyDecisionConsumed' && event.payload.reason === 'quorum_not_reached').length, 2)
})

test('сохранённое решение прежней версии исполняется при запуске один раз', { timeout: runnerTimeout(90_000) }, async (t) => {
  const code = 'WORLD-TRAVEL-LEGACY'
  const { server, first } = await setup(t, code)
  await server.stop()
  const head = await readJournal(server, code)
  const opened = await partyDecisionOpenedEvent({
    id: 'legacy-travel', type: 'vote', title: 'Покинуть Штормберг?',
    destinationLocationId: DESTINATION,
    options: [{ id: 'move', label: 'Уходим из «Штормберг» и идём в «Митглайд»' }, { id: 'stay', label: 'Остаться' }],
  }, HEROES[0], { eligibleHeroIds: [HEROES[0], HEROES[2]] })
  const interaction = opened.payload.interaction
  const draft = { ...head.state, agentInteraction: interaction }
  const firstVote = await resolvePartyVote(draft, { interactionId: interaction.id, heroId: HEROES[0], optionId: 'move' })
  const secondVote = await resolvePartyVote({ ...draft, agentInteraction: { ...interaction, votes: firstVote.votes } }, {
    interactionId: interaction.id, heroId: HEROES[2], optionId: 'move',
  })
  await appendJournal(server, code, {
    expected_state_version: head.state_version, idempotency_key: 'seed-old-resolved',
    events: [opened, ...firstVote.events, ...secondVote.events],
  })
  await server.start()
  const arrived = await waitUntilRoom(first, code, (state) => state.worldMap.currentLocationId === DESTINATION)
  assert.equal(arrived.agentInteraction, null)
  await server.restart()
  assert.equal((await room(first, code)).worldMap.currentLocationId, DESTINATION)
  const journal = await readJournal(server, code)
  assert.equal(journal.events.filter((event) => event.event_type === 'SceneAdvanced').length, 1)
  assert.deepEqual((await readJournal(server, code, { useSnapshots: false })).state, journal.state)
})

test('старый исход с пониженным кворумом закрывается с записью об отмене', { timeout: runnerTimeout(90_000) }, async (t) => {
  const code = 'WORLD-TRAVEL-LEGACY-LOW'
  const { server, first } = await setup(t, code)
  await server.stop()
  const before = await readJournal(server, code)
  const opened = await partyDecisionOpenedEvent({
    id: 'legacy-dropped-quorum', type: 'vote', title: 'Покинуть Штормберг?',
    destinationLocationId: DESTINATION,
    options: [{ id: 'move', label: 'Уходим из «Штормберг» и идём в «Митглайд»' }, { id: 'stay', label: 'Остаться' }],
  }, HEROES[0], { eligibleHeroIds: [HEROES[0], HEROES[2]] })
  const { interaction } = opened.payload
  const firstVote = await resolvePartyVote({ ...before.state, agentInteraction: interaction }, {
    interactionId: interaction.id, heroId: HEROES[0], optionId: 'move',
  })
  const resolvedAfterDisconnect = {
    event_type: 'PartyDecisionResolved', visibility: 'party',
    payload: {
      interaction_id: interaction.id, resolved_option_id: 'move', votes: firstVote.votes,
      active_voter_ids: ['hero:' + HEROES[0]], required_votes: 1, resolution_reason: 'quorum_after_disconnect',
    },
  }
  await appendJournal(server, code, {
    expected_state_version: before.state_version, idempotency_key: 'old-disconnect-resolved',
    events: [opened, ...firstVote.events, resolvedAfterDisconnect],
  })
  await server.start()
  const after = await waitUntilRoom(first, code, (state) => !state.agentInteraction)
  assert.equal(after.worldMap.currentLocationId, START)
  assert.ok(after.messages.some((message) => /Переход отменён.*кворум/u.test(message.text)))
  const journal = await readJournal(server, code)
  assert.equal(journal.events.filter((event) => event.event_type === 'SceneAdvanced').length, 0)
  assert.equal(journal.events.find((event) => event.event_type === 'PartyDecisionConsumed').payload.reason, 'travel_legacy_no_quorum')
})
