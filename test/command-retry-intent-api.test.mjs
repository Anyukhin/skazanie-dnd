import { freePort } from './free-port.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { narrationRequestFingerprint, structuredCommandsFingerprint } from '../server/game-orchestrator.mjs'

/**
 * Аудит PR #131, CMD-01/02/03 (docs/reviews/2026-10-04/round-2/12-command-retries.md).
 *
 * Повтор с прежним `idempotency_key` возвращает старый commit только тому же
 * намерению. Изменённая цель, другой тип команды или другой endpoint с тем же
 * ключом и тем же текстом раньше получали `200 replay` чужого результата;
 * теперь — `409 IDEMPOTENCY_CONFLICT`. Смена актора давала 409 и раньше
 * (CMD-03) — это положительный контроль. Записи, сделанные до появления
 * операции в отпечатке, повторяются как прежде.
 */

const SETUP_TOKEN = 'command-retry-intent-setup'
const CAMPAIGN = 'RETRY-INTENT'

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: SETUP_TOKEN,
      GAME_ENGINE_MODE: 'enforce',
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
  await new Promise((resolve) => {
    child.once('exit', resolve)
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Server exited\n${logs()}`)
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return
    } catch { /* сервер ещё поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Server did not become healthy\n${logs()}`)
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
  try { parsed = text ? JSON.parse(text) : null } catch { /* текст остаётся для диагностики */ }
  return { response, status: response.status, body: parsed, text }
}

function sessionCookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0] ?? ''
}

function hero(id) {
  return { id, character: id, hp: 10, maxHp: 10, armor: 12, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, proficiency: 2, inventory: [], online: true }
}

function goblin(id) {
  return { id, character: id, hp: 10, maxHp: 10, armor: 10, abilities: { str: 8, dex: 10, con: 10, int: 8, wis: 8, cha: 8 }, proficiency: 2, inventory: [], alive: true }
}

const initialState = {
  sessionCode: CAMPAIGN,
  campaign: 'Idempotency intent',
  activePlayerId: 'hero-a',
  isNarrating: false,
  pendingCheck: null,
  suggestions: [],
  messages: [],
  players: [hero('hero-a'), hero('hero-b')],
  enemies: ['goblin-a', 'goblin-b', 'goblin-c', 'goblin-d', 'goblin-e', 'goblin-f', 'goblin-g'].map(goblin),
  scene: { title: 'Probe', location: 'Probe', mood: '', objective: '', turn: 0, cells: [] },
  social: { npcs: [], relationships: {}, conversations: [], promises: [] },
  ruleset_id: 'srd_5_2_1',
  ruleset_version: '5.2.1',
  enabled_rule_packs: ['srd_5_2_1'],
  engine_mode: 'enforce',
  state_version: 0,
}

function identify(target, actor = 'hero-a') {
  return { command_type: 'IdentifyEnemy', actor_id: actor, target_id: target }
}

function rollIds(result) {
  return (result.body?.mechanics ?? []).map((event) => event.payload?.roll_id).filter(Boolean)
}

function brief(result) {
  return JSON.stringify({ status: result.status, code: result.body?.code ?? null, error: result.body?.error ?? null, replay: result.body?.idempotent_replay ?? null })
}

test('повтор ключа: то же намерение — replay, другая цель, тип, endpoint или актор — 409', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-command-retry-intent-'))
  let logs = ''
  let child = null
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'GM', email: 'gm@retry-intent.test', password: 'retry-intent-admin-password', setupToken: SETUP_TOKEN },
  })
  assert.equal(admin.status, 201, `${admin.text}\n${logs}`)
  const adminCookie = sessionCookie(admin)
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code: CAMPAIGN, name: CAMPAIGN, state: initialState },
  })
  assert.equal(created.status, 201, `${created.text}\n${logs}`)
  const player = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Player', email: 'player@retry-intent.test', password: 'retry-intent-player-password' },
  })
  assert.equal(player.status, 201, `${player.text}\n${logs}`)
  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const playerUser = users.body.users.find((candidate) => candidate.email === 'player@retry-intent.test')
  const assigned = await request(baseUrl, `/api/admin/users/${playerUser.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds: ['hero-a', 'hero-b'] },
  })
  assert.equal(assigned.status, 200, `${assigned.text}\n${logs}`)
  const cookie = sessionCookie(player)

  const command = (key, message, value) => request(baseUrl, `/api/campaigns/${CAMPAIGN}/commands`, {
    method: 'POST', cookie, body: { idempotency_key: key, message, command: value },
  })
  const narrate = (key, action) => request(baseUrl, '/api/narrate', {
    method: 'POST', cookie, body: { campaignId: CAMPAIGN, actor_id: 'hero-a', action, idempotency_key: key },
  })

  // Тот же ключ и та же команда — прежний commit, без второго броска. Свежее
  // `expected_state_version` смысла заявки не меняет.
  const first = await command('same-key', 'same message', identify('goblin-a'))
  assert.equal(first.status, 200, `${first.text}\n${logs}`)
  assert.ok(rollIds(first).length, 'первая проверка бросает кость')
  const replay = await command('same-key', 'same message', { ...identify('goblin-a'), expected_state_version: 999 })
  assert.equal(replay.status, 200, brief(replay))
  assert.equal(replay.body.idempotent_replay, true)
  assert.deepEqual(rollIds(replay), rollIds(first), 'повтор не бросает заново')

  // CMD-01: другая цель с тем же ключом и тем же текстом.
  const changedTarget = await command('same-key', 'same message', identify('goblin-b'))
  assert.equal(changedTarget.status, 409, brief(changedTarget))
  assert.equal(changedTarget.body.code, 'IDEMPOTENCY_CONFLICT', brief(changedTarget))

  // CMD-01: другой тип команды с тем же ключом и тем же текстом.
  const changedType = await command('same-key', 'same message', { command_type: 'EndTurn', actor_id: 'hero-a' })
  assert.equal(changedType.status, 409, brief(changedType))
  assert.equal(changedType.body.code, 'IDEMPOTENCY_CONFLICT', brief(changedType))

  // CMD-02: `/commands`, затем `/api/narrate` с тем же ключом и той же фразой.
  const structured = await command('cross-endpoint-key', 'Атакую goblin-c', identify('goblin-c'))
  assert.equal(structured.status, 200, `${structured.text}\n${logs}`)
  const prose = await narrate('cross-endpoint-key', 'Атакую goblin-c')
  assert.equal(prose.status, 409, brief(prose))
  assert.equal(prose.body.code, 'IDEMPOTENCY_CONFLICT', brief(prose))

  // CMD-02 в обратную сторону: ход фразой, затем `/commands` с тем же ключом и
  // той же фразой. Повтор самой фразы остаётся повтором.
  const look = await narrate('reverse-endpoint-key', 'Осматриваю комнату')
  assert.equal(look.status, 200, `${look.text}\n${logs}`)
  assert.ok(rollIds(look).length, 'фраза записала проверку')
  const lookReplay = await narrate('reverse-endpoint-key', 'Осматриваю комнату')
  assert.equal(lookReplay.status, 200, brief(lookReplay))
  assert.equal(lookReplay.body.idempotent_replay, true)
  assert.deepEqual(rollIds(lookReplay), rollIds(look))
  const lookAsCommand = await command('reverse-endpoint-key', 'Осматриваю комнату', identify('goblin-g'))
  assert.equal(lookAsCommand.status, 409, brief(lookAsCommand))
  assert.equal(lookAsCommand.body.code, 'IDEMPOTENCY_CONFLICT', brief(lookAsCommand))

  // CMD-03, положительный контроль: смена актора под тем же ключом.
  const actorFirst = await command('cross-actor-key', 'actor message', identify('goblin-d'))
  assert.equal(actorFirst.status, 200, `${actorFirst.text}\n${logs}`)
  const actorChanged = await command('cross-actor-key', 'actor message', identify('goblin-d', 'hero-b'))
  assert.equal(actorChanged.status, 409, brief(actorChanged))
  assert.equal(actorChanged.body.code, 'IDEMPOTENCY_CONFLICT', brief(actorChanged))

  // Совместимость: трасса, записанная до аудита, хранит отпечаток без операции
  // (или не хранит его вовсе) — честный повтор той же команды остаётся replay.
  const traceFile = (turnId) => join(storage, 'turn-traces', CAMPAIGN, `${turnId}.json`)
  const rewriteTrace = (turnId, fingerprint) => {
    const trace = JSON.parse(readFileSync(traceFile(turnId), 'utf8'))
    assert.ok(trace.request_fingerprint, 'новая трасса хранит отпечаток')
    writeFileSync(traceFile(turnId), JSON.stringify({ ...trace, request_fingerprint: fingerprint }), 'utf8')
  }
  const legacy = await command('legacy-key', 'legacy message', identify('goblin-e'))
  assert.equal(legacy.status, 200, `${legacy.text}\n${logs}`)
  assert.ok(legacy.body.turn_id)
  rewriteTrace(legacy.body.turn_id, narrationRequestFingerprint({ campaignId: CAMPAIGN, playerId: 'hero-a', message: 'legacy message' }))
  const legacyReplay = await command('legacy-key', 'legacy message', identify('goblin-e'))
  assert.equal(legacyReplay.status, 200, brief(legacyReplay))
  assert.equal(legacyReplay.body.idempotent_replay, true)
  assert.deepEqual(rollIds(legacyReplay), rollIds(legacy))

  const ancient = await command('ancient-key', 'ancient message', identify('goblin-f'))
  assert.equal(ancient.status, 200, `${ancient.text}\n${logs}`)
  rewriteTrace(ancient.body.turn_id, null)
  const ancientReplay = await command('ancient-key', 'ancient message', identify('goblin-f'))
  assert.equal(ancientReplay.status, 200, brief(ancientReplay))
  assert.equal(ancientReplay.body.idempotent_replay, true)
})

test('отпечаток пакета команд: транспорт и версия не в счёт, цель и тип — в счёт', () => {
  const base = structuredCommandsFingerprint([identify('goblin-a')])
  assert.equal(structuredCommandsFingerprint([{ target_id: 'goblin-a', actor_id: 'hero-a', command_type: 'IdentifyEnemy' }]), base, 'порядок полей не важен')
  assert.equal(structuredCommandsFingerprint([{ ...identify('goblin-a'), expected_state_version: 7, command_id: 'x', server_authoritative: true }]), base)
  // `rest_id` санитайзер отдыха берёт из состояния, которого после коммита уже нет.
  const rest = { command_type: 'CompleteRest', actor_id: 'hero-a' }
  assert.equal(structuredCommandsFingerprint([{ ...rest, rest_id: 'rest-1' }]), structuredCommandsFingerprint([rest]))
  assert.notEqual(structuredCommandsFingerprint([identify('goblin-b')]), base)
  assert.notEqual(structuredCommandsFingerprint([identify('goblin-a', 'hero-b')]), base)
  assert.notEqual(structuredCommandsFingerprint([{ ...identify('goblin-a'), command_type: 'EndTurn' }]), base)
  assert.notEqual(structuredCommandsFingerprint([identify('goblin-a'), identify('goblin-a')]), base, 'кратность пакета важна')
  // Пустая операция — прежний отпечаток: по нему узнаются старые трассы.
  const fields = { campaignId: CAMPAIGN, playerId: 'hero-a', message: 'текст' }
  assert.equal(narrationRequestFingerprint({ ...fields, operation: '' }), narrationRequestFingerprint(fields))
  assert.notEqual(narrationRequestFingerprint({ ...fields, operation: 'message' }), narrationRequestFingerprint(fields))
})
