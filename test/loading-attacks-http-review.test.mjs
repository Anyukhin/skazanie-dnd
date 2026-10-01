import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { freePort } from './free-port.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1', AGENT_PORT: String(port), DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '', ADMIN_SETUP_TOKEN: 'loading-attacks-http-review-setup',
      GAME_ENGINE_MODE: 'enforce', COOKIE_SECURE: 'false', NODE_ENV: 'test',
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Server exited\n${logs()}`)
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Server did not become healthy\n${logs()}`)
}

async function request(baseUrl, path, { method = 'GET', cookie = '', body, key = '' } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(key ? { 'X-Idempotency-Key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { response, status: response.status, body: text ? JSON.parse(text) : null, text }
}

function cookieOf(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0] ?? ''
}

function initialState(code) {
  const weapons = ['a', 'b'].map((id) => materializeCatalogItem(
    'srd_5_2_1:light-crossbow', { id: `crossbow-${id}`, quantity: 1, equipped: true },
  ))
  const bolts = materializeCatalogItem('srd_5_2_1:bolts-20', { id: 'bolts', quantity: 3 })
  return {
    state_version: 0, sessionCode: code, ruleset_id: 'dnd_5e_2014', campaign: 'HTTP loading review',
    activePlayerId: 'hero', partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Арбалетчик', characterClass: 'fighter', level: 5, proficiency: 3,
      hp: 40, maxHp: 40, armor: 16, speed: 30, abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 10, cha: 10 },
      inventory: [...weapons, bolts], x: 1, y: 1, alive: true }],
    enemies: [{ id: 'target', name: 'Мишень', hp: 100, maxHp: 100, armor: 1, speed: 30, alive: true,
      abilities: { str: 10, dex: 10, con: 10 }, x: 4, y: 1 }],
    scene: { title: 'HTTP loading review', turn: 1,
      cells: Array.from({ length: 64 }, (_, index) => ({ x: index % 8, y: Math.floor(index / 8), type: 'floor', revealed: true })) },
    mechanics: { positions: { hero: { x: 1, y: 1 }, target: { x: 4, y: 1 } }, combat: {
      active: true, round: 1, active_index: 0,
      initiative: [{ actor_id: 'hero', total: 20 }, { actor_id: 'target', total: 1 }],
      action_economy: {
        hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        target: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
      },
    } },
  }
}

function attack(key, itemId, spoof = {}) {
  return { idempotency_key: key, command: {
    command_type: 'MakeAttack', actor_id: 'hero', target_id: 'target', item_id: itemId,
    attack_mode: 'ranged', attack_ability: 'dex', ...spoof,
  } }
}

test('HTTP обычный игрок: sanitizer отбрасывает spoof, A→B→A получает loading отказ', { timeout: 60_000 }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-loading-http-'))
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

  const admin = await request(baseUrl, '/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Loading admin', email: 'loading-admin-http-review@test.invalid', password: 'secure-admin-password', setupToken: 'loading-attacks-http-review-setup',
  } })
  const owner = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Loading owner', email: 'loading-owner-http-review@test.invalid', password: 'secure-owner-password',
  } })
  assert.equal(admin.status, 201, `${admin.text}\n${logs}`)
  assert.equal(owner.status, 201, `${owner.text}\n${logs}`)
  const adminCookie = cookieOf(admin)
  const ownerCookie = cookieOf(owner)
  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const ownerUser = users.body.users.find((candidate) => candidate.email === 'loading-owner-http-review@test.invalid')
  assert.ok(ownerUser)
  const ownership = await request(baseUrl, `/api/admin/users/${ownerUser.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds: ['hero'] },
  })
  assert.equal(ownership.status, 200, `${ownership.text}\n${logs}`)
  const code = 'LOADING-HTTP-REVIEW'
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie, body: { code, name: 'HTTP loading review', state: initialState(code) },
  })
  assert.equal(created.status, 201, `${created.text}\n${logs}`)

  const first = await request(baseUrl, `/api/campaigns/${code}/commands`, {
    method: 'POST', cookie: ownerCookie, key: 'loading-http-a',
    body: attack('loading-http-a', 'crossbow-a', { reaction_attack: true, loading_action_type: 'reaction' }),
  })
  assert.equal(first.status, 200, `${first.text}\n${logs}`)
  const firstAttack = first.body.mechanics.find((event) => event.event_type === 'AttackResolved')
  assert.equal(firstAttack.payload.reaction_attack, false)
  assert.equal(firstAttack.payload.loading_action_type, 'action')
  assert.equal(firstAttack.payload.action_economy_version, undefined)
  assert.equal(firstAttack.payload.attack_action_id, undefined)

  const second = await request(baseUrl, `/api/campaigns/${code}/commands`, {
    method: 'POST', cookie: ownerCookie, key: 'loading-http-b', body: attack('loading-http-b', 'crossbow-b'),
  })
  assert.equal(second.status, 200, `${second.text}\n${logs}`)
  const beforeThird = await request(baseUrl, `/api/rooms/${code}`, { cookie: adminCookie })
  const third = await request(baseUrl, `/api/campaigns/${code}/commands`, {
    method: 'POST', cookie: ownerCookie, key: 'loading-http-a-again',
    body: attack('loading-http-a-again', 'crossbow-a', { reaction_attack: true, loading_action_type: 'reaction' }),
  })
  assert.equal(third.status, 400, `${third.text}\n${logs}`)
  assert.equal(third.body.code, 'LOADING_WEAPON_LIMIT')
  const afterThird = await request(baseUrl, `/api/rooms/${code}`, { cookie: adminCookie })
  assert.equal(afterThird.body.state.state_version, beforeThird.body.state.state_version)
  assert.equal(first.body.mechanics.filter((event) => event.event_type === 'AmmunitionSpent').length, 1)
  assert.equal(second.body.mechanics.filter((event) => event.event_type === 'AmmunitionSpent').length, 1)
})
