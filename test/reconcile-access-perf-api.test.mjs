import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { freePort } from './free-port.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

// Сверка проекции (`reconcileCampaignProjection`) читает журнал, истекает
// голосования и может перезаписать комнату. Чужой аккаунт не должен её
// запускать: окончательный отказ — до сверки, с тем же 403, что и раньше.

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: 'reconcile-access-setup',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Тестовый сервер завершился\n${logs()}`)
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return
    } catch { /* сервер ещё запускается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Тестовый сервер не запустился\n${logs()}`)
}

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

/** Членство пишется прямо в хранилище авторизации: сервер перечитывает его на каждом запросе. */
function addMembership(storage, campaignId, userId, heroIds) {
  const file = join(storage, 'auth.json')
  const auth = JSON.parse(readFileSync(file, 'utf8'))
  auth.memberships = [...(auth.memberships ?? []), { campaignId, userId, role: 'player', heroIds, status: 'active', joinedAt: Date.now() }]
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(auth, null, 2), 'utf8')
  renameSync(temporary, file)
}

/** Канонический дрейф комнаты при той же версии: сверка обязана его исправить. */
function driftRoom(storage, code) {
  const file = join(storage, 'rooms', `${code}.json`)
  const room = JSON.parse(readFileSync(file, 'utf8'))
  room.state.enemies = room.state.enemies.map((enemy) => (enemy.id === 'goblin' ? { ...enemy, hp: 1 } : enemy))
  writeFileSync(file, JSON.stringify(room, null, 2), 'utf8')
  return readFileSync(file, 'utf8')
}

test('чужой аккаунт получает прежний 403 и не запускает сверку проекции', { timeout: runnerTimeout(90_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-reconcile-access-'))
  let logs = ''
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const child = startServer(port, storage, (chunk) => { logs += chunk })
  t.after(async () => {
    if (child.exitCode == null) await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
    rmSync(storage, { recursive: true, force: true })
  })
  await waitForHealth(baseUrl, child, () => logs)

  const admin = await login(baseUrl, '/api/auth/setup-admin', {
    name: 'Ведущий', email: 'reconcile-admin@test.local', password: 'reconcile-admin-password', setupToken: 'reconcile-access-setup',
  })
  for (const code of ['RECACC', 'RECLEG']) {
    const created = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: admin.cookie, body: { code, name: 'Reconcile access', state: campaignState(code) } })
    assert.equal(created.status, 201, created.text)
  }
  const member = await login(baseUrl, '/api/auth/register', { name: 'Участник', email: 'reconcile-member@test.local', password: 'reconcile-player-password' })
  const outsider = await login(baseUrl, '/api/auth/register', { name: 'Чужой', email: 'reconcile-outsider@test.local', password: 'reconcile-player-password' })
  addMembership(storage, 'RECACC', member.userId, ['hero'])

  const roomFile = join(storage, 'rooms', 'RECACC.json')
  const drifted = driftRoom(storage, 'RECACC')

  const denied = await request(baseUrl, '/api/rooms/RECACC', { cookie: outsider.cookie })
  assert.equal(denied.status, 403, denied.text)
  assert.deepEqual(denied.body, { error: 'Нет доступа к этой комнате' })
  const deniedStream = await request(baseUrl, '/api/campaigns/RECACC/stream', { cookie: outsider.cookie })
  assert.equal(deniedStream.status, 403, deniedStream.text)
  assert.deepEqual(deniedStream.body, { error: 'Нет доступа к этой кампании' })
  const deniedDialogue = await request(baseUrl, '/api/campaigns/RECACC/dialogue', { cookie: outsider.cookie })
  assert.equal(deniedDialogue.status, 403, deniedDialogue.text)
  assert.equal(readFileSync(roomFile, 'utf8'), drifted, 'запрос чужого аккаунта не дошёл до сверки и не переписал комнату')

  const allowed = await request(baseUrl, '/api/rooms/RECACC', { cookie: member.cookie })
  assert.equal(allowed.status, 200, allowed.text)
  const repaired = JSON.parse(readFileSync(roomFile, 'utf8'))
  assert.equal(repaired.state.enemies.find((enemy) => enemy.id === 'goblin').hp, 8, 'участник по-прежнему запускает сверку, и она чинит комнату')

  // Кампания без записей о членстве: доступ решают герои комнаты, которые
  // сверка может восстановить, — отказ приходит после сверки, как раньше.
  const legacyDrifted = driftRoom(storage, 'RECLEG')
  const legacyDenied = await request(baseUrl, '/api/rooms/RECLEG', { cookie: outsider.cookie })
  assert.equal(legacyDenied.status, 403, legacyDenied.text)
  assert.deepEqual(legacyDenied.body, { error: 'Нет доступа к этой комнате' })
  assert.notEqual(readFileSync(join(storage, 'rooms', 'RECLEG.json'), 'utf8'), legacyDrifted, 'в наследственной кампании отказ по-прежнему после сверки')
})
