import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { runnerTimeout } from './shared-runner-timeout.mjs'

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode != null) throw new Error('Тестовый сервер завершился')
    try {
      const response = await fetch(baseUrl + '/api/health')
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Тестовый сервер не запустился')
}

function cookie(response) {
  return response.headers.get('set-cookie')?.split(';')[0]
}

test('агент открывает общее голосование, а неактивный игрок может проголосовать без расхода хода', { timeout: runnerTimeout(60_000) }, async (t) => {
  const port = 30_000 + Math.floor(Math.random() * 10_000)
  const baseUrl = 'http://127.0.0.1:' + port
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-party-'))
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    // Ключ пуст намеренно: сторож проверяет детерминированные пути (голосование
    // Режиссёра и fallback Архитектора сцен), а не модель. С непустым ключом
    // сервер честно стучался в routerai.ru, и тест ждал таймаут соединения на
    // каждой модели каскада — прогон плавал от секунд до минуты.
    env: { ...process.env, AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage, ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'party-setup-token', COOKIE_SECURE: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => { if (child.exitCode == null) child.kill() })
  await waitForHealth(baseUrl, child)

  const setup = await fetch(baseUrl + '/api/auth/setup-admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Admin', email: 'admin@party.test', password: 'very-secure-password', setupToken: 'party-setup-token' }),
  })
  assert.equal(setup.status, 201)
  const adminCookie = cookie(setup)
  const register = await fetch(baseUrl + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Player', email: 'player@party.test', password: 'another-secure-password' }),
  })
  assert.equal(register.status, 201)
  const playerCookie = cookie(register)

  const usersResponse = await fetch(baseUrl + '/api/admin/users', { headers: { Cookie: adminCookie } })
  const users = (await usersResponse.json()).users
  const playerUser = users.find((user) => user.email === 'player@party.test')
  const access = await fetch(baseUrl + '/api/admin/users/' + playerUser.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ heroIds: ['brann'] }),
  })
  assert.equal(access.status, 200)

  const state = {
    sessionCode: 'PARTY-VOTE', campaign: 'Vote test', activePlayerId: 'lira', isNarrating: false, pendingCheck: null, agentInteraction: null, suggestions: [], messages: [],
    players: [
      { id: 'lira', character: 'Лира', hp: 10, maxHp: 10, armor: 14, abilities: {}, proficiency: 2, inventory: [], online: true },
      { id: 'brann', character: 'Бранн', hp: 12, maxHp: 12, armor: 16, abilities: {}, proficiency: 2, inventory: [], online: true },
    ],
    scene: { title: 'Подземелье', location: 'Нижний зал', mood: '', objective: 'Найти выход', turn: 4, cells: [] },
    adventure: { chapter: 1, visitedLocations: ['Нижний зал'], history: [] },
  }
  const createdResponse = await fetch(baseUrl + '/api/campaigns', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ code: 'PARTY-VOTE', state }),
  })
  assert.equal(createdResponse.status, 201)
  let room = await createdResponse.json()

  const narrated = await fetch(baseUrl + '/api/narrate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ campaignId: 'PARTY-VOTE', action: 'Предлагаю покинуть подземелье', idempotency_key: 'open-vote-1' }),
  })
  assert.equal(narrated.status, 200)
  const result = await narrated.json()
  assert.equal(result.turn_consumed, false)
  assert.equal(result.effects.interaction.type, 'vote')
  assert.equal(result.provider, 'AgentDirector')

  const persistedVoteResponse = await fetch(baseUrl + '/api/rooms/PARTY-VOTE', { headers: { Cookie: adminCookie } })
  room = await persistedVoteResponse.json()
  assert.equal(persistedVoteResponse.status, 200)
  assert.equal(room.state.agentInteraction.id, result.effects.interaction.id)

  const forgedSave = await fetch(baseUrl + '/api/rooms/PARTY-VOTE', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: playerCookie },
    body: JSON.stringify({ state: room.state, baseVersion: room.version }),
  })
  const afterForgery = await forgedSave.json()
  assert.equal(forgedSave.status, 410)
  assert.equal(afterForgery.code, 'ROOM_MUTATION_RETIRED')

  let saved = await fetch(baseUrl + `/api/campaigns/PARTY-VOTE/party-decisions/${encodeURIComponent(room.state.agentInteraction.id)}/votes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ actor_id: 'lira', option_id: 'option-1', idempotency_key: 'party-vote-lira' }),
  })
  room = await saved.json()
  assert.equal(room.state.agentInteraction.status, 'open')

  saved = await fetch(baseUrl + `/api/campaigns/PARTY-VOTE/party-decisions/${encodeURIComponent(room.state.agentInteraction.id)}/votes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: playerCookie },
    body: JSON.stringify({ actor_id: 'brann', option_id: 'option-1', idempotency_key: 'party-vote-brann' }),
  })
  const resolved = await saved.json()
  assert.equal(saved.status, 200)
  assert.equal(resolved.state.agentInteraction.status, 'resolved')
  assert.equal(resolved.state.agentInteraction.resolvedOptionId, 'option-1')
  assert.deepEqual(resolved.state.agentInteraction.votes, { lira: 'option-1', brann: 'option-1' })
  assert.equal(resolved.state.activePlayerId, 'lira')
  assert.equal(resolved.state.scene.turn, 4)

  const deniedContinue = await fetch(baseUrl + '/api/narrate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: playerCookie },
    body: JSON.stringify({ campaignId: 'PARTY-VOTE', action: '[РЕШЕНИЕ ГРУППЫ] Покинуть подземелье', idempotency_key: 'continue-foreign-turn' }),
  })
  assert.equal(deniedContinue.status, 403)
  const unchangedAfterDenied = await fetch(baseUrl + '/api/rooms/PARTY-VOTE', { headers: { Cookie: adminCookie } })
  const unchangedRoom = await unchangedAfterDenied.json()
  assert.equal(unchangedRoom.state.agentInteraction.status, 'resolved')
  assert.equal(unchangedRoom.state.scene.turn, 4)

  const continued = await fetch(baseUrl + '/api/narrate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ campaignId: 'PARTY-VOTE', action: '[\u0420\u0415\u0428\u0415\u041D\u0418\u0415 \u0413\u0420\u0423\u041F\u041F\u042B] \u041F\u043E\u043A\u0438\u043D\u0443\u0442\u044C \u043F\u043E\u0434\u0437\u0435\u043C\u0435\u043B\u044C\u0435', idempotency_key: 'continue-vote-1' }),
  })
  assert.equal(continued.status, 200)
  const transition = await continued.json()
  assert.equal(transition.provider, 'deterministic-scene')
  assert.equal(transition.turn_consumed, true)
  assert.notEqual(transition.effects.scene.scene.location, '\u041D\u0438\u0436\u043D\u0438\u0439 \u0437\u0430\u043B')
  assert.ok(transition.agent_trace.some((stage) => stage.agent === 'scene_architect'))
  assert.equal(transition.effects.scene.adventure.chapter, 2)
  assert.ok(transition.effects.scene.scene.cells.length >= 16 * 16,
    'неопознанный выход обязан получить структурированный тематический fallback')
  assert.ok(transition.effects.scene.scene.cells.some((cell) => cell.feature),
    'fallback не должен оставлять новую сцену пустой')

  const labResponse = await fetch(baseUrl + '/api/agent-lab/scene-transition', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      campaignId: 'PARTY-VOTE',
      decision: 'Уходим в город — отступаем и ищем другой путь, сохранив нить с печатью архивариуса',
      scene: { location: 'Затопленный архив', objective: 'Исследовать печать архивариуса' },
      adventure: { currentHook: 'Печать архивариуса открывает скрытый зал' },
    }),
  })
  assert.equal(labResponse.status, 200)
  const lab = await labResponse.json()
  assert.equal(lab.dry_run, true)
  assert.equal(lab.transition.scene.location, 'Город')
  assert.equal(lab.transition.scene.cells.length, 20 * 20)
  assert.ok(lab.transition.scene.cells.filter((cell) => cell.type === 'door').length >= 4,
    'городская карта обязана содержать двери домов')
  assert.deepEqual(lab.stages.map((stage) => stage.agent), ['AgentDirector', 'scene_architect', 'WorldEngine', 'AgentNarrator'])
  assert.match(lab.transition.adventure.currentHook, /Печать архивариуса/u)
})
