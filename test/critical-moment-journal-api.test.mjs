import { freePort } from './free-port.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Боевой плейтест 2026-10-03: свой удар, сваливший врага, игрок видел в хронике
// без единого числа, а удары врага — с числами. Критический момент рассказчика
// заменял строку системы боя целиком. Теперь лог ложится перед рассказчиком.

function startServer({ port, storage, setupToken, appendLog }) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: setupToken,
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
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not stop')), 5_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
}

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const headers = { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* сырое тело попадёт в сообщение проверки */ }
  return { response, status: response.status, body: json, text }
}

async function waitForHealth(baseUrl, child, log) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Test server exited with ${child.exitCode}\n${log()}`)
    try {
      const health = await request(baseUrl, '/api/health')
      if (health.status === 200) return
    } catch { /* сервер ещё поднимается */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Test server did not become healthy\n${log()}`)
}

const sessionCookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]
const assertStatus = (result, expected, log) => assert.equal(result.status, expected, `${result.text.slice(0, 2000)}\n${log().slice(-2000)}`)

test('враг, сваленный своим ударом: в хронике и лог системы боя, и рассказчик', { timeout: runnerTimeout(30_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-critical-journal-'))
  const setupToken = 'critical-journal-setup'
  let logs = ''
  const log = () => logs
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const child = startServer({ port, storage, setupToken, appendLog: (chunk) => { logs += chunk } })
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })
  await waitForHealth(baseUrl, child, log)
  const setup = await request(baseUrl, '/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Мастер стенда', email: 'admin@critical-journal.test', password: 'critical-journal-admin-password', setupToken,
  } })
  assertStatus(setup, 201, log)
  const adminCookie = sessionCookie(setup)
  const registration = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Игрок стенда', email: 'player@critical-journal.test', password: 'critical-journal-player-password',
  } })
  assertStatus(registration, 201, log)
  const playerCookie = sessionCookie(registration)
  const cells = []
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 9; x += 1) cells.push({ x, y, type: 'floor', revealed: true })
  const initial = {
    sessionCode: 'CRIT-JOURNAL', campaign: 'Хроника удара', partyMemberIds: ['hero'], activePlayerId: 'hero',
    ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    players: [{ id: 'hero', name: 'Маг', character: 'Маг', characterClass: 'wizard', level: 5,
      hp: 30, maxHp: 30, armor: 14, speed: 30, proficiency: 3,
      abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 12, cha: 10 }, inventory: [], x: 1, y: 1,
      knownSpellIds: ['magic-missile'], preparedSpellIds: ['magic-missile'] }],
    enemies: [{ id: 'raider', name: 'Налётчик', hp: 1, maxHp: 11, armor: 12, speed: 30, attackBonus: 3, damageDice: 6, damageBonus: 1,
      abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, x: 5, y: 1, alive: true }],
    scene: { turn: 1, title: 'Полигон', location: 'critical-journal', cells },
    mechanics: { combat: { active: true, round: 1, active_index: 0,
      initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'raider', total: 5 }],
      action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } } },
    engine_mode: 'enforce',
  }
  const created = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: adminCookie, body: { code: 'CRIT-JOURNAL', name: initial.campaign, state: initial } })
  assertStatus(created, 201, log)
  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const playerUser = users.body.users.find((entry) => entry.email === 'player@critical-journal.test')
  assertStatus(await request(baseUrl, `/api/admin/users/${playerUser.id}`, { method: 'PATCH', cookie: adminCookie, body: { heroIds: ['hero'] } }), 200, log)

  const cast = await request(baseUrl, '/api/campaigns/CRIT-JOURNAL/commands', { method: 'POST', cookie: playerCookie, body: {
    idempotency_key: 'missile-kill', message: 'Волшебная стрела',
    command: { command_type: 'CastSpell', actor_id: 'hero', spell_id: 'magic-missile', target_id: 'raider', slot_level: 1 },
  } })
  assertStatus(cast, 200, log)
  assert.ok(cast.body.mechanics.some((entry) => entry.event_type === 'HitPointsReducedToZero'), 'стрела валит налётчика')
  assert.equal(cast.body.narration_author, 'Рассказчик', 'враг повержен — говорит рассказчик')

  const room = await request(baseUrl, '/api/rooms/CRIT-JOURNAL', { cookie: playerCookie })
  assertStatus(room, 200, log)
  const messages = room.body.state.messages
  const narrator = messages.findIndex((message) => message.id === cast.body.narration_message_id)
  assert.ok(narrator >= 0, 'текст рассказчика в хронике')
  assert.equal(messages[narrator].author, 'Рассказчик')
  const combatLog = messages.findIndex((message) => message.author === 'Система боя' && /Налётчик/u.test(message.text))
  assert.ok(combatLog >= 0, `строка системы боя в хронике: ${JSON.stringify(messages.map((message) => [message.author, message.text]))}`)
  assert.ok(combatLog < narrator, 'лог идёт перед рассказчиком')
  assert.match(messages[combatLog].text, /\d/u, 'у своей стрелы видно число')

  // Повтор того же ключа хронику не удваивает.
  const replay = await request(baseUrl, '/api/campaigns/CRIT-JOURNAL/commands', { method: 'POST', cookie: playerCookie, body: {
    idempotency_key: 'missile-kill', message: 'Волшебная стрела',
    command: { command_type: 'CastSpell', actor_id: 'hero', spell_id: 'magic-missile', target_id: 'raider', slot_level: 1 },
  } })
  assertStatus(replay, 200, log)
  const after = await request(baseUrl, '/api/rooms/CRIT-JOURNAL', { cookie: playerCookie })
  assert.equal(after.body.state.messages.filter((message) => message.author === 'Система боя' && message.text === messages[combatLog].text).length, 1)
})
