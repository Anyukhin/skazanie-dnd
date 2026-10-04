import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { projectionHash } from '../server/projection-integrity.mjs'
import { freePort } from './free-port.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const PROJECTION_FAULT_PRELOAD = pathToFileURL(fileURLToPath(new URL('./fixtures/fail-projection-ack-once.mjs', import.meta.url))).href

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, [
    '--import', PROJECTION_FAULT_PRELOAD,
    'server/index.mjs',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      DND_PROJECTION_FAULT_CAMPAIGN: 'PROJECTION-FAULT',
      DND_PROJECTION_FAULT_VERSION: '1',
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: 'projection-fault-setup',
      COOKIE_SECURE: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => appendLog(String(chunk)))
  child.stderr.on('data', (chunk) => appendLog(String(chunk)))
  return child
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Тестовый сервер завершился\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
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
  return { status: response.status, body: text ? JSON.parse(text) : null, text, response }
}

function cookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0] ?? ''
}

test('ошибка проекции после commit возвращает 500, а повтор читает сохранённое событие', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-commands-projection-fault-'))
  let logs = ''
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const child = startServer(port, storage, (chunk) => { logs += chunk })
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })
  await waitForHealth(baseUrl, child, () => logs)

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Setup', email: 'setup@projection-fault.test', password: 'setup-password', setupToken: 'projection-fault-setup' },
  })
  assert.equal(setup.status, 201, setup.text)
  const adminCookie = cookie(setup)
  const state = {
    sessionCode: 'PROJECTION-FAULT', campaign: 'Projection fault', activePlayerId: 'hero',
    isNarrating: false, pendingCheck: null, agentInteraction: null, messages: [],
    players: [{ id: 'hero', name: 'Hero', character: 'Hero', hp: 10, maxHp: 10, armor: 14, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, proficiency: 2, inventory: [], online: true }],
    enemies: [{ id: 'goblin', name: 'Goblin', hp: 8, maxHp: 8, armor: 12, abilities: { str: 8, dex: 14, con: 10, int: 8, wis: 8, cha: 8 }, proficiency: 2, alive: true, x: 1, y: 0 }],
    scene: { title: 'Зал', location: 'Зал', mood: '', objective: '', turn: 0, cells: [] },
    mechanics: {}, ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'], engine_mode: 'enforce', state_version: 0,
  }
  const created = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: adminCookie, body: { code: 'PROJECTION-FAULT', name: state.campaign, state } })
  assert.equal(created.status, 201, created.text)

  const command = {
    idempotency_key: 'projection-fault-command',
    message: 'Нанести урон',
    command: { command_type: 'ApplyDamage', actor_id: 'hero', target_id: 'goblin', amount: 3, damage_type: 'slashing' },
  }
  const failed = await request(baseUrl, '/api/campaigns/PROJECTION-FAULT/commands', {
    method: 'POST', cookie: adminCookie, body: command,
  })
  assert.equal(failed.status, 500, failed.text)
  assert.equal(failed.body.code, 'INTERNAL_ERROR')
  assert.match(failed.body.error, /Внутренняя ошибка/u)
  assert.doesNotMatch(failed.body.error, /synthetic|projection acknowledgement/u)

  const afterFailure = await request(baseUrl, '/api/rooms/PROJECTION-FAULT', { cookie: adminCookie })
  assert.equal(afterFailure.status, 200, afterFailure.text)
  assert.equal(afterFailure.body.state.enemies.find((enemy) => enemy.id === 'goblin').hp, 5)

  const replay = await request(baseUrl, '/api/campaigns/PROJECTION-FAULT/commands', {
    method: 'POST', cookie: adminCookie, body: command,
  })
  assert.equal(replay.status, 200, replay.text)
  assert.equal(replay.body.idempotent_replay, true)
  assert.equal(replay.body.authoritative_state.enemies.find((enemy) => enemy.id === 'goblin').hp, 5)

  const namedValidation = await request(baseUrl, '/api/campaigns/PROJECTION-FAULT/commands', {
    method: 'POST', cookie: adminCookie,
    body: {
      idempotency_key: 'projection-validation', message: 'Нанести урон',
      command: { command_type: 'ApplyDamage', actor_id: 'missing', target_id: 'goblin', amount: 3, damage_type: 'slashing' },
    },
  })
  assert.equal(namedValidation.status, 400, namedValidation.text)
  assert.equal(namedValidation.body.code, 'ACTOR_NOT_FOUND')
  const malformed = await fetch(`${baseUrl}/api/campaigns/PROJECTION-FAULT/commands`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: '{',
  })
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.json()).code, 'INVALID_JSON')
})

// Аудит PR #131, SEC-02: быстрый путь проекции при равной `state_version`
// подтверждал комнату без сверки. Комната, испорченная вне журнала, снимала
// pending checkpoint и оставалась расходящейся до следующего GET.
test('подтверждение проекции при той же версии сверяет содержимое комнаты', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-commands-projection-fault-'))
  let logs = ''
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const child = startServer(port, storage, (chunk) => { logs += chunk })
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })
  await waitForHealth(baseUrl, child, () => logs)

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Setup', email: 'setup@projection-drift.test', password: 'setup-password', setupToken: 'projection-fault-setup' },
  })
  assert.equal(setup.status, 201, setup.text)
  const adminCookie = cookie(setup)
  const state = {
    sessionCode: 'PROJECTION-FAULT', campaign: 'Projection drift', activePlayerId: 'hero',
    isNarrating: false, pendingCheck: null, agentInteraction: null, messages: [],
    players: [{ id: 'hero', name: 'Hero', character: 'Hero', hp: 10, maxHp: 10, armor: 14, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, proficiency: 2, inventory: [], online: true }],
    enemies: [{ id: 'goblin', name: 'Goblin', hp: 8, maxHp: 8, armor: 12, abilities: { str: 8, dex: 14, con: 10, int: 8, wis: 8, cha: 8 }, proficiency: 2, alive: true, x: 1, y: 0 }],
    scene: { title: 'Зал', location: 'Зал', mood: '', objective: '', turn: 0, cells: [] },
    mechanics: {}, ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1', enabled_rule_packs: ['srd_5_2_1'], engine_mode: 'enforce', state_version: 0,
  }
  const created = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: adminCookie, body: { code: 'PROJECTION-FAULT', name: state.campaign, state } })
  assert.equal(created.status, 201, created.text)

  // Маршрут жизненного цикла проецирует результат без сверки на входе и без
  // записи в летопись: повтор того же ключа приходит в быстрый путь равной версии.
  const pause = { action: 'pause', idempotency_key: 'projection-drift-pause' }
  // Подтверждение версии 1 падает один раз (фоновое, ответ не ломает):
  // checkpoint остаётся позади журнала.
  const paused = await request(baseUrl, '/api/campaigns/PROJECTION-FAULT/lifecycle', { method: 'POST', cookie: adminCookie, body: pause })
  assert.equal(paused.status, 200, `${paused.text}\n${logs}`)

  const campaignsRoot = join(storage, 'engine', 'campaigns')
  const campaignDir = join(campaignsRoot, readdirSync(campaignsRoot).find((name) => name.toUpperCase().includes('PROJECTION-FAULT')))
  const metadata = () => JSON.parse(readFileSync(join(campaignDir, 'metadata.json'), 'utf8'))
  assert.equal(metadata().projection_checkpoint_version, 0, 'после сбоя подтверждения проекция ждёт сверки')

  // Внешний дрейф при той же версии: каноническое поле комнаты испорчено, и в
  // ней появилось каноническое поле, которого движок не держит вовсе.
  const roomFile = join(storage, 'rooms', 'PROJECTION-FAULT.json')
  const room = JSON.parse(readFileSync(roomFile, 'utf8'))
  assert.equal(room.state.state_version, 1)
  assert.equal(room.state.tacticalTurn, undefined)
  room.state.enemies = room.state.enemies.map((enemy) => (enemy.id === 'goblin' ? { ...enemy, hp: 1 } : enemy))
  room.state.tacticalTurn = { actorId: 'hero', round: 3, actionUsed: true }
  writeFileSync(roomFile, JSON.stringify(room, null, 2), 'utf8')

  const replay = await request(baseUrl, '/api/campaigns/PROJECTION-FAULT/lifecycle', { method: 'POST', cookie: adminCookie, body: pause })
  assert.equal(replay.status, 200, `${replay.text}\n${logs}`)

  // Подтверждение фоновое: ждём, пока checkpoint догонит журнал.
  let checkpoint = metadata()
  for (let attempt = 0; attempt < 40 && checkpoint.projection_checkpoint_version !== 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    checkpoint = metadata()
  }
  const repaired = JSON.parse(readFileSync(roomFile, 'utf8'))
  assert.equal(repaired.state.state_version, 1)
  assert.equal(repaired.state.enemies.find((enemy) => enemy.id === 'goblin').hp, 8, 'комната восстановлена из журнала')
  assert.equal(repaired.state.tacticalTurn, undefined, 'поле, которого движок не держит, из комнаты снято')
  assert.equal(checkpoint.projection_checkpoint_version, 1)
  assert.equal(checkpoint.projection_checkpoint_hash, projectionHash(repaired.state), 'подтверждён hash восстановленной комнаты')
})
