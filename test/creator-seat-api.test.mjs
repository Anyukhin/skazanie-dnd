import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { freePort } from './free-port.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Место создателя кампании (живая сессия 2026-10-02). Администратор создал
 * кампанию мастером «Создание нового мира» на двоих, мастер пообещал «первое
 * место всегда ваше», и администратор создал героя в месте 1. Членства у
 * него при этом не было, место 1 считалось свободным и ушло в приглашение:
 * гость получил его и затёр героя администратора своим, а место 2 осталось
 * пустым. Теперь место 1 закреплено за создателем, а ссылка раздаёт место 2.
 */

const CAMPAIGN = 'CREATOR-SEAT'

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: 'creator-seat-setup',
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Server exited\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch { /* сервер ещё поднимается */ }
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

const cookieOf = (result) => result.response.headers.get('set-cookie')?.split(';')[0]

function characterDocument(character) {
  const baseScores = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
  return {
    schema: 'skazanie.character',
    schema_version: 1,
    character: {
      character,
      name: character,
      role: 'Воин · ур. 1',
      characterClass: 'fighter',
      species: 'Человек',
      background: 'Солдат',
      level: 1,
      experience: 0,
      abilities: baseScores,
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.standard-array',
        policyVersion: 1,
        method: 'standard_array',
        baseScores,
        originBonusProfileId: 'none',
        originBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
        speciesOptionId: 'human',
      },
      baseSpeed: 30,
      hitPointIncreases: [],
      classSkillProficiencies: ['athletics', 'perception'],
      selectedFeatureIds: ['fighting-style-defense'],
      knownSpellIds: [],
      preparedSpellIds: [],
    },
  }
}

test('администратор из мастера создания мира держит первое место, ссылка отдаёт гостю второе', { timeout: runnerTimeout(90_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-creator-seat-'))
  let logs = ''
  let child = null
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const log = () => logs
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, log)

  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Мастер', email: 'creator-seat-admin@test.local', password: 'secure-admin-password', setupToken: 'creator-seat-setup' },
  })
  assert.equal(admin.status, 201, admin.text)
  const guest = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: { name: 'Гость', email: 'creator-seat-guest@test.local', password: 'secure-guest-password' },
  })
  assert.equal(guest.status, 201, guest.text)
  const adminCookie = cookieOf(admin)
  const guestCookie = cookieOf(guest)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie,
    body: { code: CAMPAIGN, name: 'Место создателя', bootstrap: { partyName: 'Двое', slotCount: 2, rulesetId: 'srd_5_2_1' } },
  })
  assert.equal(created.status, 201, `${created.text}\n${log()}`)

  const importHero = (cookie, actorId, character, key) => request(baseUrl, `/api/campaigns/${CAMPAIGN}/commands`, {
    method: 'POST', cookie, key,
    body: { idempotency_key: key, command: { command_type: 'ImportCharacter', actor_id: actorId, document: characterDocument(character) } },
  })
  const adminHero = await importHero(adminCookie, 'hero-slot-1', 'Кирем', 'creator-seat-admin-hero')
  assert.equal(adminHero.status, 200, adminHero.text)

  // Ссылка по умолчанию — только свободное место.
  const invite = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/invites`, { method: 'POST', cookie: adminCookie, body: {} })
  assert.equal(invite.status, 201, invite.text)
  assert.deepEqual(invite.body.hero_ids, ['hero-slot-2'])
  const joined = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/join`, {
    method: 'POST', cookie: guestCookie, body: { invite_token: invite.body.token },
  })
  assert.equal(joined.status, 200, joined.text)
  assert.deepEqual(joined.body.hero_ids, ['hero-slot-2'])

  // Чужого героя гость не перепишет; своего создаёт.
  const stolen = await importHero(guestCookie, 'hero-slot-1', 'Гелла', 'creator-seat-guest-steal')
  assert.equal(stolen.status, 403, stolen.text)
  const own = await importHero(guestCookie, 'hero-slot-2', 'Гелла', 'creator-seat-guest-hero')
  assert.equal(own.status, 200, own.text)

  const room = await request(baseUrl, `/api/rooms/${CAMPAIGN}`, { cookie: adminCookie })
  assert.equal(room.status, 200, room.text)
  const names = Object.fromEntries(room.body.state.players.map((player) => [player.id, player.character]))
  assert.deepEqual(names, { 'hero-slot-1': 'Кирем', 'hero-slot-2': 'Гелла' })
})
