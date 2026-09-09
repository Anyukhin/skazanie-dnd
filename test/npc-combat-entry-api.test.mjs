import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runnerTimeout } from './shared-runner-timeout.mjs'

const SESSION = 'NPC-COMBAT-ENTRY'
const SETUP_TOKEN = 'npc-combat-entry-setup-token'

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
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Тестовый сервер не завершился')), 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill()
  })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Тестовый сервер завершился до health\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch { /* listener ещё запускается */ }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Тестовый сервер не стал healthy\n${logs()}`)
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
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* assertion reports the body */ }
  return { status: response.status, body: parsed, text, response }
}

function sessionCookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0] ?? ''
}

function hero() {
  return {
    id: 'npc-entry-hero', name: 'Игрок', character: 'Испытатель', role: 'Воин · ур. 8',
    species: 'Человек', background: 'Солдат', backstory: 'Проверяет безопасный вход в бой.',
    characterClass: 'fighter', level: 8, hp: 72, maxHp: 72, armor: 18, speed: 30, proficiency: 3,
    abilities: { str: 18, dex: 14, con: 16, int: 10, wis: 12, cha: 10 }, inventory: [], online: true,
    attackBonus: 7, damageDice: 8, damageBonus: 4, damageType: 'slashing', attackRange: 5,
  }
}

function attackBody(key, npcId = 'astohan-ares') {
  return {
    idempotency_key: key,
    message: 'Напасть на NPC',
    command: { command_type: 'AttackNpc', actor_id: 'npc-entry-hero', npc_id: npcId },
  }
}

function characterDocument() {
  const abilities = { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }
  return {
    schema: 'skazanie.character', schema_version: 1,
    character: {
      character: 'Испытатель', name: 'Игрок', role: 'Воин · ур. 1', characterClass: 'fighter',
      species: 'Человек', background: 'Солдат', level: 1, experience: 0, abilities,
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.standard-array', policyVersion: 1, method: 'standard_array',
        baseScores: abilities, originBonusProfileId: 'none', originBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
        speciesOptionId: 'human',
      },
      baseSpeed: 30, hitPointIncreases: [], classSkillProficiencies: ['athletics', 'perception'],
      selectedFeatureIds: [], knownSpellIds: [], preparedSpellIds: [],
    },
  }
}

test('обычный игрок начинает бой с видимым NPC через команды, а replay переживает рестарт', { timeout: runnerTimeout(45_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-npc-combat-entry-'))
  let logs = ''
  let child = null
  let baseUrl = ''
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })
  const launch = async () => {
    const port = await freePort()
    baseUrl = `http://127.0.0.1:${port}`
    child = startServer(port, storage, (chunk) => { logs += chunk })
    await waitForHealth(baseUrl, child, () => logs)
  }
  await launch()

  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST', body: { name: 'NPC admin', email: 'npc-entry-admin@example.test', password: 'secure-npc-entry-password', setupToken: SETUP_TOKEN },
  })
  assert.equal(admin.status, 201, admin.text)
  const owner = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: { name: 'NPC player', email: 'npc-entry-player@example.test', password: 'secure-npc-player-password' },
  })
  assert.equal(owner.status, 201, owner.text)
  const cookie = sessionCookie(owner)
  assert.ok(cookie)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie,
    body: { code: SESSION, name: 'NPC combat entry', bootstrap: { partyName: 'Тестовый отряд', worldTemplateId: 'astohan-plains', players: [hero()] } },
  })
  assert.equal(created.status, 201, created.text)
  const initial = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie })
  assert.equal(initial.status, 200, initial.text)
  const beforeHero = { x: initial.body.state.players[0].x, y: initial.body.state.players[0].y }
  assert.ok(initial.body.state.scene_npcs.find((npc) => npc.id === 'astohan-ares')?.can_start_combat === true)

  const imported = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie, key: 'npc-entry-import', body: {
      idempotency_key: 'npc-entry-import', message: 'Подготовить героя',
      command: { command_type: 'ImportCharacter', actor_id: 'npc-entry-hero', document: characterDocument() },
    },
  })
  assert.equal(imported.status, 200, imported.text)
  // Импорт листа сам может изменить видимую проекцию. Вход в бой сравниваем
  // с состоянием непосредственно перед ним, а не до отдельной команды.
  const beforeCombat = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie })
  assert.equal(beforeCombat.status, 200, beforeCombat.text)
  const beforeMap = structuredClone(beforeCombat.body.state.scene.map)

  const hidden = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie, key: 'npc-entry-hidden', body: attackBody('npc-entry-hidden', 'astohan-sargat'),
  })
  assert.equal(hidden.status, 400, hidden.text)
  assert.equal(hidden.body.code, 'AUTHORED_NPC_NOT_VISIBLE')

  const first = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie, key: 'npc-entry-attack', body: attackBody('npc-entry-attack'),
  })
  assert.equal(first.status, 200, first.text)
  assert.deepEqual(first.body.mechanics.slice(0, 2).map((event) => event.event_type), ['EncounterCreated', 'CombatStarted'])
  assert.equal(first.body.authoritative_state.mechanics.combat.active, true)
  assert.equal(first.body.authoritative_state.enemies[0].id, 'astohan-ares')
  assert.deepEqual(first.body.authoritative_state.mechanics.positions['npc-entry-hero'], beforeHero)
  // После инициативы NPC может походить и открыть дверь: видимость и набор
  // раскрытых зон меняются законно. Саму геометрию вход в бой не пересоздаёт.
  const combatMap = first.body.authoritative_state.scene.map
  for (const field of ['version', 'locationId', 'seed', 'generator', 'width', 'height', 'bounds']) {
    assert.deepEqual(combatMap[field], beforeMap[field], field)
  }
  assert.deepEqual(combatMap.layers.present, beforeMap.layers.present)
  assert.deepEqual(combatMap.layers.passable, beforeMap.layers.passable)
  assert.doesNotMatch(JSON.stringify(first.body.mechanics), /astohan:ares-v1|action_profiles|provenance/u)

  const duplicate = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie, key: 'npc-entry-attack', body: attackBody('npc-entry-attack'),
  })
  assert.equal(duplicate.status, 200, duplicate.text)
  assert.equal(duplicate.body.idempotent_replay, true)
  assert.equal(duplicate.body.authoritative_state.mechanics.combat.active, true)
  const conflict = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie, key: 'npc-entry-attack', body: attackBody('npc-entry-attack', 'astohan-oren'),
  })
  assert.equal(conflict.status, 409, conflict.text)
  assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT')

  const rawEncounter = await request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie, key: 'npc-entry-raw-encounter', body: {
      idempotency_key: 'npc-entry-raw-encounter', message: 'raw',
      command: { command_type: 'CreateEncounter', npc_id: 'astohan-ares', difficulty: 'deadly', theme: 'generic', seed: 'forged' },
    },
  })
  assert.equal(rawEncounter.status, 403, rawEncounter.text)
  assert.equal(rawEncounter.body.code, 'PLAYER_COMMAND_FORBIDDEN')

  const beforeRestart = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie })
  assert.equal(beforeRestart.status, 200, beforeRestart.text)
  await stopServer(child)
  child = null
  await launch()
  const afterRestart = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie })
  assert.equal(afterRestart.status, 200, afterRestart.text)
  assert.equal(afterRestart.body.state.mechanics.combat.active, true)
  assert.equal(afterRestart.body.state.enemies[0].id, 'astohan-ares')
  assert.deepEqual(afterRestart.body.state.scene.map, beforeRestart.body.state.scene.map)
  assert.deepEqual(afterRestart.body.state.mechanics.positions['npc-entry-hero'], beforeHero)
})
