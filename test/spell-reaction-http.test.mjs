import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runnerTimeout } from './shared-runner-timeout.mjs'

const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return port
}

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
    const timer = setTimeout(() => reject(new Error('Тестовый сервер не остановился')), 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, log) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Тестовый сервер завершился с кодом ${child.exitCode}\n${log().slice(-2000)}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return response.json()
    } catch { /* Сервер ещё запускается. */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Тестовый сервер не ответил\n${log().slice(-2000)}`)
}

async function request(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : JSON_HEADERS), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* Проверка статуса сообщит о теле ниже. */ }
  return { status: response.status, body: json, text, headers: response.headers }
}

function cookie(result) {
  return result.headers.get('set-cookie')?.split(';')[0]
}

function assertStatus(result, expected, log) {
  assert.equal(result.status, expected, `${result.text.slice(0, 2000)}\n${log().slice(-2000)}`)
  assert.ok(result.body && typeof result.body === 'object', `Ожидался JSON: ${result.text.slice(0, 500)}`)
}

function cells() {
  return Array.from({ length: 24 }, (_, index) => ({
    x: index % 8,
    y: Math.floor(index / 8),
    type: 'floor',
    revealed: true,
  }))
}

function economy() {
  return { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
}

function initialState() {
  return {
    sessionCode: 'REACTION-HTTP',
    campaign: 'Проверка реакций через HTTP',
    partyName: 'Тестовая группа',
    partyMemberIds: ['hero', 'ally'],
    activePlayerId: 'enemy',
    ruleset_id: 'dnd_5e_2014',
    ruleset_version: '2014.1.0',
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    players: [
      {
        id: 'hero', name: 'Игрок', character: 'Ведьма', characterClass: 'wizard', level: 3,
        hp: 30, maxHp: 30, armor: 14, speed: 30, proficiency: 2,
        abilities: { str: 8, dex: 14, con: 12, int: 16, wis: 10, cha: 10 },
        knownSpellIds: ['silvery-barbs'], preparedSpellIds: ['silvery-barbs'], inventory: [], x: 1, y: 1,
      },
      {
        id: 'ally', name: 'Союзник', character: 'Лира', characterClass: 'fighter', level: 3,
        hp: 30, maxHp: 30, armor: 16, speed: 30, proficiency: 2,
        abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
        inventory: [], x: 1, y: 2,
      },
    ],
    enemies: [{
      id: 'enemy', name: 'Враг', characterClass: 'fighter', level: 3,
      hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 2,
      abilities: { str: 14, dex: 12, con: 12, int: 8, wis: 8, cha: 8 },
      attackBonus: 4, damageDice: 4, damageBonus: 1, attackRange: 5,
      inventory: [], x: 3, y: 1, alive: true,
    }],
    scene: { turn: 1, title: 'Полигон реакций', location: 'reaction-http', cells: cells() },
    mechanics: {
      resources: { hero: { spell_slots_1: { current: 4, max: 4 } } },
      conditions: { ally: [{ id: 'silvery-fortune', effect_id: 'older-silvery-barbs', source_actor: 'ally', duration: 'rounds:10' }] },
      combat: {
        active: true,
        round: 1,
        initiative: [{ actor_id: 'enemy', total: 20 }, { actor_id: 'hero', total: 12 }, { actor_id: 'ally', total: 10 }],
        active_index: 0,
        action_economy: { enemy: economy(), hero: economy(), ally: economy() },
        reaction_window: {
          id: 'reaction-http-silvery',
          trigger: 'attack-hit',
          actor_id: 'hero',
          source_actor_id: 'enemy',
          target_id: 'hero',
          action_ids: ['cast:silvery-barbs'],
          action_options: [{
            id: 'cast:silvery-barbs', name: 'Искусная острота', description: 'Перебросить попадание.',
            resource: 'spell_slots_1', slot_level: 1, cost: 1, requires_beneficiary: true,
          }],
          damage: { applied_amount: 3, damage_type: 'slashing', hp_before: 30, hp_after: 27 },
          trigger_roll: { kept: 18, modifier: 4, total: 22, armor_class: 12, hit: true, critical: false },
        },
      },
    },
    engine_mode: 'enforce',
  }
}

test('HTTP UseCombatAction сохраняет выбранного получателя Искусной остроты', { timeout: runnerTimeout(30_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-spell-reaction-http-'))
  const setupToken = 'spell-reaction-http-setup-token'
  let logs = ''
  let child = null
  const log = () => logs
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })

  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer({ port, storage, setupToken, appendLog: (chunk) => { logs += chunk } })
  await waitForHealth(baseUrl, child, log)

  const setup = await request(baseUrl, '/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Администратор реакций', email: 'admin@spell-reaction-http.test', password: 'spell-reaction-http-admin-password', setupToken,
  } })
  assertStatus(setup, 201, log)
  const adminCookie = cookie(setup)
  const registration = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Игрок реакций', email: 'player@spell-reaction-http.test', password: 'spell-reaction-http-player-password',
  } })
  assertStatus(registration, 201, log)
  const playerCookie = cookie(registration)

  const created = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: adminCookie, body: {
    code: 'REACTION-HTTP', name: 'Проверка реакций через HTTP', state: initialState(),
  } })
  assertStatus(created, 201, log)
  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  assertStatus(users, 200, log)
  const player = users.body.users.find((candidate) => candidate.email === 'player@spell-reaction-http.test')
  assert.ok(player)
  const assigned = await request(baseUrl, `/api/admin/users/${player.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds: ['hero', 'ally'] },
  })
  assertStatus(assigned, 200, log)

  const command = await request(baseUrl, '/api/campaigns/REACTION-HTTP/commands', {
    method: 'POST',
    cookie: playerCookie,
    body: {
      idempotency_key: 'silvery-beneficiary-http-1',
      message: 'Передать преимущество союзнику',
      command: {
        command_type: 'UseCombatAction',
        actor_id: 'hero',
        action_id: 'cast:silvery-barbs',
        target_id: 'enemy',
        beneficiary_id: 'ally',
      },
    },
  })
  assertStatus(command, 200, log)
  const conditions = command.body.authoritative_state?.mechanics?.conditions ?? {}
  assert.ok(conditions.ally?.some((condition) => condition.id === 'silvery-fortune'), 'выбранный союзник должен получить преимущество')
  assert.equal(conditions.hero?.some((condition) => condition.id === 'silvery-fortune'), false, 'преимущество не должно по умолчанию возвращаться заклинателю')
  const fortune = conditions.ally.filter((condition) => condition.id === 'silvery-fortune')
  assert.equal(fortune.length, 1, 'по источнику нельзя накопить несколько усилений Silvery Barbs')
  assert.match(fortune[0].effect_id, /^silvery-barbs:/u)
  assert.notEqual(fortune[0].effect_id, 'older-silvery-barbs')
})
