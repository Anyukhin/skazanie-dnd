import assert from 'node:assert/strict'
import test from 'node:test'
import { projectionHash } from '../server/projection-integrity.mjs'
import { readJournal, readRoom, startTestServer, writeRoom } from './kit/index.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/** Подтверждение проекции версии 1 кампании PROJECTION-FAULT падает один раз за процесс. */
function startServer(t) {
  return startTestServer(t, {
    setupToken: 'projection-fault-setup',
    storagePrefix: 'skazanie-commands-projection-fault-',
    faults: { projection_ack: [{ campaign: 'PROJECTION-FAULT', version: 1 }] },
  })
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
  const server = await startServer(t)
  const baseUrl = server.baseUrl

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
  const server = await startServer(t)
  const baseUrl = server.baseUrl
  // Комната и отметка проекции — через набор: у JS это файл комнаты и
  // metadata.json, у Rust — накладка и метаданные журнала в SQLite.
  const logs = server.output

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
  assert.equal(paused.status, 200, `${paused.text}\n${logs()}`)

  const metadata = async () => (await readJournal(server, 'PROJECTION-FAULT')).projection_checkpoint
  assert.equal((await metadata()).version, 0, 'после сбоя подтверждения проекция ждёт сверки')

  // Внешний дрейф при той же версии: каноническое поле комнаты испорчено, и в
  // ней появилось каноническое поле, которого движок не держит вовсе.
  const room = await readRoom(server, 'PROJECTION-FAULT')
  assert.equal(room.state.state_version, 1)
  assert.equal(room.state.tacticalTurn, undefined)
  const drifted = await writeRoom(server, 'PROJECTION-FAULT', {
    ...room.state,
    enemies: room.state.enemies.map((enemy) => (enemy.id === 'goblin' ? { ...enemy, hp: 1 } : enemy)),
    tacticalTurn: { actorId: 'hero', round: 3, actionUsed: true },
  })
  assert.equal(drifted.state.enemies.find((enemy) => enemy.id === 'goblin').hp, 1, 'дрейф записан')

  const replay = await request(baseUrl, '/api/campaigns/PROJECTION-FAULT/lifecycle', { method: 'POST', cookie: adminCookie, body: pause })
  assert.equal(replay.status, 200, `${replay.text}\n${logs()}`)

  // Подтверждение фоновое: ждём, пока checkpoint догонит журнал.
  let checkpoint = await metadata()
  for (let attempt = 0; attempt < 40 && checkpoint.version !== 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    checkpoint = await metadata()
  }
  const repaired = await readRoom(server, 'PROJECTION-FAULT')
  assert.equal(repaired.state.state_version, 1)
  assert.equal(repaired.state.enemies.find((enemy) => enemy.id === 'goblin').hp, 8, 'комната восстановлена из журнала')
  assert.equal(repaired.state.tacticalTurn, undefined, 'поле, которого движок не держит, из комнаты снято')
  assert.equal(checkpoint.version, 1)
  assert.equal(checkpoint.hash, projectionHash(repaired.state), 'подтверждён hash восстановленной комнаты')
})
