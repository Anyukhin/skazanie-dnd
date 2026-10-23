import assert from 'node:assert/strict'
import test from 'node:test'
import { startTestServer } from './kit/http.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'
import { ITEM_CATALOG } from '../server/item-catalog.mjs'

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null, response }
}

function cookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

test('non-admin room and Director response cannot expose private world memory', { timeout: runnerTimeout(30_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-viewer-api-', setupToken: 'viewer-api-token' })
  const baseUrl = server.baseUrl

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST', body: { name: 'GM', email: 'gm@viewer.test', password: 'viewer-admin-password', setupToken: 'viewer-api-token' },
  })
  assert.equal(setup.status, 201, server.output())
  const adminCookie = cookie(setup)
  const registration = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: { name: 'Player', email: 'player@viewer.test', password: 'viewer-player-password' },
  })
  assert.equal(registration.status, 201, server.output())
  const playerCookie = cookie(registration)
  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const playerUser = users.body.users.find((candidate) => candidate.email === 'player@viewer.test')
  const access = await request(baseUrl, `/api/admin/users/${playerUser.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds: ['hero'] },
  })
  assert.equal(access.status, 200, server.output())

  const privateMarker = 'GM_PRIVATE_DRAGON_COUNCIL'
  const initialState = {
    sessionCode: 'VIEWER-API', campaign: 'Visibility', partyMemberIds: ['hero'], activePlayerId: 'hero',
    isNarrating: false, pendingCheck: null, suggestions: [], messages: [], enemies: [], entities: [], economyLog: [],
    players: [{ id: 'hero', character: 'Лира', hp: 18, maxHp: 18, armor: 14, abilities: { cha: 14 }, inventory: [{ id: 'keepsake', catalog_id: 'srd_5_2_1:torch', name: 'Факел деда', description: 'Подарок перед дорогой.', type: 'tool', quantity: 1 }], currency: { gold: 20 }, online: true }],
    scene: {
      title: 'Склеп', location: 'Склеп', mood: 'Тихо', objective: 'Выйти', turn: 1,
      cells: [{ x: 0, y: 0, type: 'floor', revealed: false, feature: 'enemy', secret: privateMarker }],
      hidden_information: { ambush: privateMarker },
    },
    adventure: {
      chapter: 1, currentHook: 'Публичная печать', history: [], visitedLocations: ['Склеп'],
      gm_only: { villain: privateMarker }, hidden_information: { route: privateMarker },
    },
    merchants: [{
      id: 'old-shop', name: 'Скрытая лавка', location: 'Склеп', available: true,
      stock: [{ stock_id: 'torch', catalog_id: 'srd_5_2_1:torch', name: 'Факел', type: 'gear', quantity: 1, secret_supplier: privateMarker }],
      pricing: { mode: 'catalog', agent_adjustment_bps: -500, bargain_dc: 1 }, bargains: { hero: { success: true } }, secret: privateMarker,
    }],
    agentInteraction: {
      id: 'visibility-vote', type: 'vote', status: 'resolved', resolvedOptionId: 'city', votes: { hero: 'city' },
      options: [{ id: 'city', label: 'Уходим из склепа и идём в большой город Норвин' }],
    },
  }
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code: 'VIEWER-API', state: initialState },
  })
  assert.equal(created.status, 201, server.output())

  const playerRoom = await request(baseUrl, '/api/rooms/VIEWER-API', { cookie: playerCookie })
  assert.equal(playerRoom.status, 200, server.output())
  assert.doesNotMatch(JSON.stringify(playerRoom.body), new RegExp(privateMarker, 'u'))
  assert.equal(playerRoom.body.state.scene.cells[0].feature, undefined)
  assert.equal(playerRoom.body.state.merchants[0].bargains, undefined)
  assert.equal(playerRoom.body.state.merchants[0].pricing.agent_adjustment_bps, undefined)
  const keepsake = playerRoom.body.state.players[0].inventory[0]
  assert.equal(keepsake.description, 'Подарок перед дорогой.', 'каталог не переписывает историю экземпляра')
  assert.equal(keepsake.capabilities.catalog_description, ITEM_CATALOG['srd_5_2_1:torch'].description)

  const transitioned = await request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: playerCookie,
    body: { campaignId: 'VIEWER-API', idempotency_key: 'viewer-city-transition', action: '[РЕШЕНИЕ ГРУППЫ] Уходим из склепа и идём в большой город Норвин' },
  })
  assert.equal(transitioned.status, 200, `${JSON.stringify(transitioned.body)}\n${server.output()}`)
  assert.doesNotMatch(JSON.stringify(transitioned.body), new RegExp(privateMarker, 'u'))
  assert.ok(transitioned.body.authoritative_state, JSON.stringify(transitioned.body))
  assert.equal(transitioned.body.authoritative_state.scene.location, 'Большой город Норвин')
  assert.equal(transitioned.body.authoritative_state.messages.some((message) => message.id === transitioned.body.narration_message_id), true)
  assert.equal(transitioned.body.mechanics.some((event) => event.event_type === 'SceneAdvanced'), true)
  assert.equal(transitioned.body.authoritative_state.merchants.every((merchant) => merchant.location === 'Большой город Норвин'), true)
  assert.equal(transitioned.body.authoritative_state.merchants.every((merchant) => merchant.bargains === undefined), true)

  const socialNpc = transitioned.body.authoritative_state.merchants[0]
  const socialAction = '\u0433\u043e\u0432\u043e\u0440\u044e \u0441 ' + socialNpc.name
  const spoken = await request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: playerCookie,
    body: { campaignId: 'VIEWER-API', idempotency_key: 'viewer-social-turn', action: socialAction },
  })
  assert.equal(spoken.status, 200, JSON.stringify(spoken.body) + '\n' + server.output())
  assert.equal(spoken.body.mechanics.some((event) => event.event_type === 'NpcConversationRecorded'), true)
  assert.equal(spoken.body.authoritative_state.social.conversations.length, 1)

  const replayedSocial = await request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: playerCookie,
    body: { campaignId: 'VIEWER-API', idempotency_key: 'viewer-social-turn', action: socialAction },
  })
  assert.equal(replayedSocial.status, 200, server.output())
  assert.equal(replayedSocial.body.idempotent_replay, true)
  assert.equal(replayedSocial.body.narration, spoken.body.narration)

  const checkedAction = '\u0443\u0431\u0435\u0436\u0434\u0430\u044e ' + socialNpc.name + ' \u043f\u043e\u043c\u043e\u0447\u044c'
  const checkedSocial = await request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: playerCookie,
    body: { campaignId: 'VIEWER-API', idempotency_key: 'viewer-social-check', action: checkedAction },
  })
  assert.equal(checkedSocial.status, 200, JSON.stringify(checkedSocial.body) + '\n' + server.output())
  const playerCheck = checkedSocial.body.mechanics.find((event) => event.event_type === 'AbilityCheckResolved')
  assert.ok(playerCheck, JSON.stringify(checkedSocial.body.mechanics))
  assert.equal(playerCheck.payload.difficulty, undefined)
  assert.equal(playerCheck.payload.social_check.difficulty_hidden, true)
  assert.equal(playerCheck.payload.social_check.request_fingerprint, undefined)
  assert.equal(checkedSocial.body.authoritative_state.social.conversations.length, 2)

  const forgedSocialState = structuredClone(checkedSocial.body.authoritative_state)
  forgedSocialState.social.conversations = []
  forgedSocialState.social.npcs[0].goals = ['FORGED_SOCIAL_SECRET']
  const roomPut = await request(baseUrl, '/api/rooms/VIEWER-API', {
    method: 'PUT', cookie: playerCookie,
    body: { state: forgedSocialState, baseVersion: checkedSocial.body.room_version },
  })
  assert.equal(roomPut.status, 410, JSON.stringify(roomPut.body) + '\n' + server.output())
  assert.equal(roomPut.body.code, 'ROOM_MUTATION_RETIRED')

  const adminRoom = await request(baseUrl, '/api/rooms/VIEWER-API', { cookie: adminCookie })
  assert.equal(adminRoom.status, 200, server.output())
  assert.equal(adminRoom.body.state.adventure.gm_only.villain, privateMarker)
  assert.equal(adminRoom.body.state.social.conversations.length, 2)
  assert.doesNotMatch(JSON.stringify(adminRoom.body.state.social), /FORGED_SOCIAL_SECRET/u)
})
