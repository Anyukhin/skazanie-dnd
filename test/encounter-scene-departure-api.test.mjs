import assert from 'node:assert/strict'
import test from 'node:test'

import { createCampaignState } from './kit/fixtures.mjs'
import { addPlayer, createCampaign, expectStatus, setupAdmin, startTestServer } from './kit/http.mjs'
import { readJournal } from './kit/journal.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const CODE = 'ENCOUNTER-DEPARTURE'
const START = 'astohan-stormberg'
const DESTINATION = 'astohan-ash-watch'
const HERO = 'hero'
const FOE = 'old-foe'
const CAPTIVE = 'held-foe'
const BEAST = 'tamed-beast'

const actor = (id, name, extra = {}) => ({
  id, name, character: name, kind: 'neutral', hp: 12, maxHp: 12, x: 2, y: 3, armor: 12, inventory: [], ...extra,
})

test('участники завершённой встречи остаются на месте, а пленный и зверь идут с отрядом', { timeout: runnerTimeout(90_000) }, async (t) => {
  const server = await startTestServer(t)
  const { client: admin } = await setupAdmin(server)
  const state = await createCampaignState({
    code: CODE, worldTemplateId: 'astohan-plains', rulesetId: 'dnd_5e_2014', campaignMode: 'adventure',
    players: [actor(HERO, 'Лира')],
  })
  const prior = state.scene.location
  state.actors = [
    actor(FOE, 'Бывший противник'),
    actor(CAPTIVE, 'Пленный'),
    actor(BEAST, 'Приручённый волк', { creature_type: 'beast' }),
  ]
  state.enemies = [actor(FOE, 'Бывший противник', { kind: 'enemy', hp: 0, alive: false })]
  state.mechanics.encounter = {
    id: 'old-encounter', status: 'ended', outcome: 'enemies_defeated',
    enemy_ids: [FOE, CAPTIVE, BEAST],
  }
  state.social.npcs.push({
    id: FOE, name: 'Бывший противник', role: 'Предводитель',
    location: '', available: true, visibility: 'party', goals: ['запомнить исход боя'], tags: ['parley-leader'],
  }, {
    id: CAPTIVE, name: 'Пленный', role: 'Пленник', location: prior, location_id: START,
    available: true, visibility: 'party', tags: ['captive'],
  })
  state.worldMemory.entities.push({ id: FOE, kind: 'npc', name: 'Бывший противник', summary: 'Свидетель боя', visibility: 'party' })
  state.captives = { captives: [{ id: 'capture-1', npc_id: CAPTIVE, actor_id: CAPTIVE, name: 'Пленный', status: 'held', location_id: START, location_name: prior }] }
  state.beasts = { beasts: [{ id: 'beast-1', actor_id: BEAST, name: 'Приручённый волк', stage: 'tamed', status: 'companion', location_id: START, location_name: prior }] }

  await createCampaign(admin, { code: CODE, state })
  const { client: player } = await addPlayer(server, admin, CODE, { heroIds: [HERO] })
  const response = await player.post('/api/narrate', {
    campaign_id: CODE, actor_id: HERO, action: 'Идём в Пепельную заставу', idempotency_key: 'advance-after-fight',
  })
  expectStatus(response)
  const view = expectStatus(await player.get('/api/rooms/' + CODE)).state
  assert.equal((view.actors ?? []).some((entry) => entry.id === FOE), false)
  assert.notEqual(view.social.npcs.find((entry) => entry.id === FOE)?.present, true)
  const read = () => readJournal(server, CODE)
  const reached = await read()
  assert.equal(reached.state.scene.location_id, DESTINATION)
  assert.equal(reached.state.actors.some((entry) => entry.id === FOE), false)
  assert.equal(reached.state.enemies.some((entry) => entry.id === FOE), false)
  const foeProfile = reached.state.social.npcs.find((entry) => entry.id === FOE)
  assert.equal(foeProfile.location_id, START)
  assert.deepEqual(foeProfile.goals, ['запомнить исход боя'])
  assert.equal(reached.state.worldMemory.entities.find((entry) => entry.id === FOE)?.summary, 'Свидетель боя')

  const captive = reached.state.captives.captives.find((entry) => entry.npc_id === CAPTIVE)
  assert.equal(captive.location_id, DESTINATION)
  assert.equal(reached.state.social.npcs.find((entry) => entry.id === CAPTIVE)?.location_id, DESTINATION)
  assert.equal(reached.state.beasts.beasts.find((entry) => entry.actor_id === BEAST)?.location_id, DESTINATION)
  assert.ok(reached.state.actors.some((entry) => entry.id === BEAST))
  const leaked = []
  JSON.stringify(response.body, function (key, value) {
    if (key === 'encounter_departure') leaked.push(Object.keys(this))
    return value
  })
  assert.deepEqual(leaked, [], 'служебная разметка перехода скрыта от игрока')

  const tried = await player.post('/api/narrate', {
    campaign_id: CODE, actor_id: HERO, npc_id: FOE, action: 'Говорю с предводителем', idempotency_key: 'talk-to-absent-npc',
  })
  assert.ok(tried.status < 500, tried.text)
  assert.equal((await read()).events.some((event) => event.event_type === 'NpcConversationRecorded'
    && event.payload.conversation?.npc_id === FOE), false)
  await server.restart()
  const restored = await read()
  assert.equal(restored.state.social.npcs.find((entry) => entry.id === FOE)?.location_id, START)
  assert.deepEqual((await readJournal(server, CODE, { useSnapshots: false })).state, restored.state)
})
