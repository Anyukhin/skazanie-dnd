import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runnerTimeout } from './shared-runner-timeout.mjs'

const SESSION = 'NONSTANDARD-ACTION-API'
const SETUP_TOKEN = 'nonstandard-action-api-setup'
const ACTION = 'Балансирую на узкой опоре'

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
    const timer = setTimeout(resolve, 5_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
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
  try { parsed = text ? JSON.parse(text) : null } catch { /* assertion includes raw body */ }
  return { status: response.status, body: parsed, text, response }
}

function cookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0] ?? ''
}

function cells(width = 8, height = 6) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
    type: 'floor',
    passable: true,
    revealed: true,
  }))
}

function initialState() {
  return {
    state_version: 0,
    sessionCode: SESSION,
    campaign: 'Проверка нестандартного действия',
    partyName: 'Проверка опоры',
    partyMemberIds: ['hero-one', 'hero-two'],
    activePlayerId: 'hero-one',
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    battleLog: [],
    players: [
      {
        id: 'hero-one', name: 'Лира', character: 'Лира', role: 'Герой', species: 'Человек',
        characterClass: 'fighter', level: 1, hp: 20, maxHp: 20, armor: 14, speed: 30, proficiency: 2,
        abilities: { str: 10, dex: 3, con: 10, int: 10, wis: 10, cha: 10 },
        classSkillProficiencies: [], skillExpertiseIds: [], inventory: [], online: true, x: 2, y: 2,
      },
      {
        id: 'hero-two', name: 'Бор', character: 'Бор', role: 'Герой', species: 'Человек',
        characterClass: 'fighter', level: 1, hp: 20, maxHp: 20, armor: 14, speed: 30, proficiency: 2,
        abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
        classSkillProficiencies: [], skillExpertiseIds: [], inventory: [], online: true, x: 4, y: 2,
      },
    ],
    enemies: [],
    actors: [],
    scene: {
      title: 'Узкий мост', location: 'Узкий мост', mood: 'Тихо',
      objective: 'Проверить физически разумный трюк', turn: 0, cells: cells(),
    },
    mechanics: { positions: { 'hero-one': { x: 2, y: 2 }, 'hero-two': { x: 4, y: 2 } } },
    ruleset_id: 'srd_5_2_1',
    ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'],
    engine_mode: 'enforce',
  }
}

async function narrate(baseUrl, ownerCookie, key, extra = {}) {
  return request(baseUrl, '/api/narrate', {
    method: 'POST',
    cookie: ownerCookie,
    body: {
      campaignId: SESSION,
      action: ACTION,
      idempotency_key: key,
      ...extra,
    },
  })
}

test('нестандартный физический трюк проходит HTTP check → roll → injury commit и replay', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-nonstandard-action-api-'))
  let logs = ''
  let child = null
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })

  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Тестовый мастер', email: 'nonstandard-admin@example.test', password: 'NonstandardAdmin-2026!', setupToken: SETUP_TOKEN },
  })
  const owner = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Владелец', email: 'nonstandard-owner@example.test', password: 'NonstandardOwner-2026!' },
  })
  const foreign = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Другой игрок', email: 'nonstandard-foreign@example.test', password: 'NonstandardForeign-2026!' },
  })
  assert.equal(admin.status, 201, admin.text)
  assert.equal(owner.status, 201, owner.text)
  assert.equal(foreign.status, 201, foreign.text)
  const adminCookie = cookie(admin)
  const ownerCookie = cookie(owner)
  const foreignCookie = cookie(foreign)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: adminCookie,
    body: { code: SESSION, name: 'Проверка нестандартного действия', state: initialState() },
  })
  assert.equal(created.status, 201, `${created.text}\n${logs}`)
  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  assert.equal(users.status, 200, users.text)
  const ownerUser = users.body.users.find((candidate) => candidate.email === 'nonstandard-owner@example.test')
  const foreignUser = users.body.users.find((candidate) => candidate.email === 'nonstandard-foreign@example.test')
  assert.ok(ownerUser)
  assert.ok(foreignUser)
  for (const [userId, heroId] of [[ownerUser.id, 'hero-one'], [foreignUser.id, 'hero-two']]) {
    const ownership = await request(baseUrl, `/api/admin/users/${userId}`, {
      method: 'PATCH', cookie: adminCookie, body: { heroIds: [heroId] },
    })
    assert.equal(ownership.status, 200, `${ownership.text}\n${logs}`)
  }
  const ownerInvite = await request(baseUrl, `/api/campaigns/${SESSION}/invites`, {
    method: 'POST', cookie: adminCookie, body: { hero_ids: ['hero-one'] },
  })
  const foreignInvite = await request(baseUrl, `/api/campaigns/${SESSION}/invites`, {
    method: 'POST', cookie: adminCookie, body: { hero_ids: ['hero-two'] },
  })
  assert.equal(ownerInvite.status, 201, ownerInvite.text)
  assert.equal(foreignInvite.status, 201, foreignInvite.text)
  assert.equal((await request(baseUrl, `/api/campaigns/${SESSION}/join`, {
    method: 'POST', cookie: ownerCookie, body: { invite_token: ownerInvite.body.token },
  })).status, 200)
  assert.equal((await request(baseUrl, `/api/campaigns/${SESSION}/join`, {
    method: 'POST', cookie: foreignCookie, body: { invite_token: foreignInvite.body.token },
  })).status, 200)

  const before = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: ownerCookie })
  assert.equal(before.status, 200, before.text)
  const beforeHero = before.body.state.players.find((hero) => hero.id === 'hero-one')
  const beforeMinutes = before.body.state.mechanics.world_time?.elapsed_minutes ?? 0

  const offered = await narrate(baseUrl, ownerCookie, 'stunt-check-1', { manual_roll: true })
  assert.equal(offered.status, 200, `${offered.text}\n${logs}`)
  assert.equal(offered.body.free_action_outcome, 'check_required')
  assert.equal(offered.body.check.skill, 'acrobatics')
  assert.equal(offered.body.check.ability, 'dex')
  assert.equal(offered.body.check.difficulty, 20)
  assert.equal(offered.body.check.modifier, -4, 'DEX 3 без владения даёт −4')
  assert.match(offered.body.check.proposal.on_failure, /1d4|дробящ/u)
  assert.deepEqual(offered.body.mechanics, [], 'предподтверждение не коммитит события')
  const afterOffer = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: ownerCookie })
  assert.equal(afterOffer.body.state.players.find((hero) => hero.id === 'hero-one').hp, beforeHero.hp)
  assert.equal(afterOffer.body.state.mechanics.world_time?.elapsed_minutes ?? 0, beforeMinutes)

  const foreignRoll = await request(baseUrl, '/api/roll', {
    method: 'POST', cookie: foreignCookie,
    body: { campaignId: SESSION, playerId: 'hero-one', checkId: offered.body.check.check_id },
  })
  assert.equal(foreignRoll.status, 403, foreignRoll.text)
  const wrongHeroRoll = await request(baseUrl, '/api/roll', {
    method: 'POST', cookie: ownerCookie,
    body: { campaignId: SESSION, playerId: 'hero-two', checkId: offered.body.check.check_id },
  })
  assert.equal(wrongHeroRoll.status, 403, wrongHeroRoll.text)

  const rolled = await request(baseUrl, '/api/roll', {
    method: 'POST', cookie: ownerCookie,
    body: { campaignId: SESSION, playerId: 'hero-one', checkId: offered.body.check.check_id },
  })
  assert.equal(rolled.status, 200, `${rolled.text}\n${logs}`)
  assert.equal(rolled.body.difficulty, 20)
  assert.ok(rolled.body.total <= 16, 'DEX 3 без владения должен провалить DC20 даже на натуральной 20')
  assert.equal(rolled.body.success, false)

  const resolved = await narrate(baseUrl, ownerCookie, 'stunt-resolve-1', {
    roll: { roll_id: rolled.body.roll_id },
  })
  assert.equal(resolved.status, 200, `${resolved.text}\n${logs}`)
  const check = (resolved.body.mechanics ?? []).find((event) => event.event_type === 'AbilityCheckResolved')
  assert.equal(check?.payload?.success, false)
  assert.equal(check?.payload?.difficulty, 20)
  const damageRolls = (resolved.body.mechanics ?? []).filter((event) => event.event_type === 'DieRolled' && event.payload?.expression === '1d4')
  assert.equal(damageRolls.length, 1)
  const damage = (resolved.body.mechanics ?? []).filter((event) => event.event_type === 'DamageApplied')
  assert.equal(damage.length, 1)
  assert.deepEqual(damage[0].target_ids, ['hero-one'])
  assert.equal(damage[0].payload.damage_type, 'bludgeoning')
  assert.ok(damage[0].payload.applied_amount >= 1 && damage[0].payload.applied_amount <= 4)
  assert.equal((resolved.body.mechanics ?? []).some((event) => event.event_type === 'TimeAdvanced'), false)
  assert.match(String(resolved.body.narration ?? ''), /дробящ|урон/iu)

  const after = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: ownerCookie })
  const afterHero = after.body.state.players.find((hero) => hero.id === 'hero-one')
  assert.equal(afterHero.hp, beforeHero.hp - damage[0].payload.applied_amount)
  assert.equal(after.body.state.mechanics.world_time?.elapsed_minutes ?? 0, beforeMinutes)

  const repeated = await narrate(baseUrl, ownerCookie, 'stunt-resolve-1', {
    roll: { roll_id: rolled.body.roll_id },
  })
  assert.equal(repeated.status, 200, repeated.text)
  assert.equal(repeated.body.idempotent_replay, true)
  assert.equal(repeated.body.authoritative_state.players.find((hero) => hero.id === 'hero-one').hp, afterHero.hp)
  assert.equal((repeated.body.mechanics ?? []).filter((event) => event.event_type === 'DamageApplied').length, 1)

  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)
  const reopened = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: ownerCookie })
  assert.equal(reopened.status, 200, `${reopened.text}\n${logs}`)
  assert.equal(reopened.body.state.players.find((hero) => hero.id === 'hero-one').hp, afterHero.hp)
  assert.equal(reopened.body.state.mechanics.world_time?.elapsed_minutes ?? 0, beforeMinutes)
  const replayAfterRestart = await narrate(baseUrl, ownerCookie, 'stunt-resolve-1', {
    roll: { roll_id: rolled.body.roll_id },
  })
  assert.equal(replayAfterRestart.status, 200, replayAfterRestart.text)
  assert.equal(replayAfterRestart.body.idempotent_replay, true)
  assert.equal(replayAfterRestart.body.authoritative_state.players.find((hero) => hero.id === 'hero-one').hp, afterHero.hp)
})
