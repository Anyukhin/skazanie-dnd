import assert from 'node:assert/strict'
import test from 'node:test'
import { addPlayer, createClient, readRoom, startTestServer, writeRoom } from './kit/index.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

// Сверка проекции (`reconcileCampaignProjection`) читает журнал, истекает
// голосования и может перезаписать комнату. Чужой аккаунт не должен её
// запускать: окончательный отказ — до сверки, с тем же 403, что и раньше.
//
// Членство — штатным приглашением, дрейф комнаты — `writeRoom` набора, а
// «сверка не запускалась» — `readRoom`: записанная комната не изменилась.

async function request(baseUrl, path, { method = 'GET', cookie = '', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
  return { status: response.status, body: parsed, text }
}

function sessionCookie(result, response) {
  return response.headers.get('set-cookie')?.split(';')[0] ?? ''
}

async function login(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const parsed = await response.json()
  assert.ok(response.status === 200 || response.status === 201, JSON.stringify(parsed))
  return { cookie: sessionCookie(parsed, response), userId: parsed.user?.id }
}

function campaignState(code) {
  return {
    sessionCode: code, campaign: 'Reconcile access', activePlayerId: 'hero',
    isNarrating: false, pendingCheck: null, agentInteraction: null, messages: [],
    players: [{ id: 'hero', name: 'Hero', character: 'Hero', hp: 10, maxHp: 10, armor: 14, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, proficiency: 2, inventory: [], online: true }],
    enemies: [{ id: 'goblin', name: 'Goblin', hp: 8, maxHp: 8, armor: 12, abilities: { str: 8, dex: 14, con: 10, int: 8, wis: 8, cha: 8 }, proficiency: 2, alive: true, x: 1, y: 0 }],
    scene: { title: 'Зал', location: 'Зал', mood: '', objective: '', turn: 0, cells: [] },
    mechanics: {}, ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'], engine_mode: 'enforce', state_version: 0,
  }
}

/** Канонический дрейф комнаты при той же версии: сверка обязана его исправить. */
async function driftRoom(server, code) {
  const room = await readRoom(server, code)
  const drifted = await writeRoom(server, code, {
    ...room.state,
    enemies: room.state.enemies.map((enemy) => (enemy.id === 'goblin' ? { ...enemy, hp: 1 } : enemy)),
  })
  assert.equal(drifted.state.enemies.find((enemy) => enemy.id === 'goblin').hp, 1, 'дрейф записан')
  return drifted
}

test('чужой аккаунт получает прежний 403 и не запускает сверку проекции', { timeout: runnerTimeout(90_000) }, async (t) => {
  const server = await startTestServer(t, { setupToken: 'reconcile-access-setup', storagePrefix: 'skazanie-reconcile-access-' })
  const baseUrl = server.baseUrl

  const admin = await login(baseUrl, '/api/auth/setup-admin', {
    name: 'Ведущий', email: 'reconcile-admin@test.local', password: 'reconcile-admin-password', setupToken: 'reconcile-access-setup',
  })
  for (const code of ['RECACC', 'RECLEG']) {
    const created = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: admin.cookie, body: { code, name: 'Reconcile access', state: campaignState(code) } })
    assert.equal(created.status, 201, created.text)
  }
  // Участник — по приглашению ведущего на героя «hero»: запись о членстве есть
  // только у RECACC, у RECLEG их нет вовсе.
  const member = await addPlayer(server, createClient(server, { cookie: admin.cookie }), 'RECACC', {
    heroIds: ['hero'], name: 'Участник', email: 'reconcile-member@test.local', password: 'reconcile-player-password',
  })
  assert.deepEqual(member.heroIds, ['hero'])
  const memberCookie = member.client.cookie
  const outsider = await login(baseUrl, '/api/auth/register', { name: 'Чужой', email: 'reconcile-outsider@test.local', password: 'reconcile-player-password' })

  const drifted = await driftRoom(server, 'RECACC')

  const denied = await request(baseUrl, '/api/rooms/RECACC', { cookie: outsider.cookie })
  assert.equal(denied.status, 403, denied.text)
  assert.deepEqual(denied.body, { error: 'Нет доступа к этой комнате' })
  const deniedStream = await request(baseUrl, '/api/campaigns/RECACC/stream', { cookie: outsider.cookie })
  assert.equal(deniedStream.status, 403, deniedStream.text)
  assert.deepEqual(deniedStream.body, { error: 'Нет доступа к этой кампании' })
  const deniedDialogue = await request(baseUrl, '/api/campaigns/RECACC/dialogue', { cookie: outsider.cookie })
  assert.equal(deniedDialogue.status, 403, deniedDialogue.text)
  assert.deepEqual(await readRoom(server, 'RECACC'), drifted, 'запрос чужого аккаунта не дошёл до сверки и не переписал комнату')

  const allowed = await request(baseUrl, '/api/rooms/RECACC', { cookie: memberCookie })
  assert.equal(allowed.status, 200, allowed.text)
  const repaired = await readRoom(server, 'RECACC')
  assert.equal(repaired.state.enemies.find((enemy) => enemy.id === 'goblin').hp, 8, 'участник по-прежнему запускает сверку, и она чинит комнату')

  // Кампания без записей о членстве: доступ решают герои комнаты, которые
  // сверка может восстановить, — отказ приходит после сверки, как раньше.
  const legacyDrifted = await driftRoom(server, 'RECLEG')
  const legacyDenied = await request(baseUrl, '/api/rooms/RECLEG', { cookie: outsider.cookie })
  assert.equal(legacyDenied.status, 403, legacyDenied.text)
  assert.deepEqual(legacyDenied.body, { error: 'Нет доступа к этой комнате' })
  const legacyAfter = await readRoom(server, 'RECLEG')
  assert.notDeepEqual(legacyAfter, legacyDrifted, 'в наследственной кампании отказ по-прежнему после сверки')
  assert.equal(legacyAfter.state.enemies.find((enemy) => enemy.id === 'goblin').hp, 8, 'сверка до отказа починила комнату')
})
