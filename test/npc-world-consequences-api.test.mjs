import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runnerTimeout } from './shared-runner-timeout.mjs'
import { palaceFixture } from './shared-npc-consequence-fixture.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { resolveCommands } from '../server/rules-engine.mjs'

const SESSION = 'NPC-CONSEQUENCE-API'
const SETUP_TOKEN = 'npc-consequence-setup-token'

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
      const response = await fetch(`${baseUrl}/api/health`, { headers: { Connection: 'close' } })
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
      // Процесс сервера в этом тесте перезапускается; сокет не переживает его.
      Connection: 'close',
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

test('HTTP огненный шар обычного игрока сохраняет смерть, задачу и вакансию без LLM; повтор и restart не расходуют вторую ячейку', { timeout: runnerTimeout(90_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-npc-consequence-api-'))
  let child = null
  let baseUrl = ''
  let logs = ''
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })
  const launch = async () => {
    const port = await freePort()
    baseUrl = `http://127.0.0.1:${port}`
    child = startServer(port, storage, (chunk) => { logs += chunk })
    await waitForHealth(baseUrl, child, () => logs)
  }
  await launch()
  const admin = await request(baseUrl, '/api/auth/setup-admin', { method: 'POST', body: {
    name: 'Ведущий', email: 'gm@npc-consequence.test', password: 'npc-consequence-password', setupToken: SETUP_TOKEN,
  } })
  assert.equal(admin.status, 201, admin.text)
  const owner = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Игрок', email: 'owner@npc-consequence.test', password: 'npc-consequence-password',
  } })
  const outsider = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Чужой', email: 'foreign@npc-consequence.test', password: 'npc-consequence-password',
  } })
  assert.equal(owner.status, 201, owner.text)
  assert.equal(outsider.status, 201, outsider.text)
  const adminCookie = sessionCookie(admin)
  const ownerCookie = sessionCookie(owner)
  const outsiderCookie = sessionCookie(outsider)
  const fixture = await palaceFixture({ kingHp: 1, witnesses: false })
  // Сценарий начинается в инициативе; атака и её урон ещё не исполнялись.
  const initial = resolveCommands([{ command_type: 'AttackNpc', command_id: 'palace-initiative', actor_id: fixture.heroId, npc_id: fixture.kingId }], fixture.state, {
    diceService: new DiceService({ rng: new SequenceDiceRng([20, 1]) }), context: { allowedActorIds: [fixture.heroId] },
  }).state
  initial.sessionCode = SESSION
  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const ownerId = users.body.users.find((user) => user.email === 'owner@npc-consequence.test').id
  const assigned = await request(baseUrl, `/api/admin/users/${ownerId}`, { method: 'PATCH', cookie: adminCookie, body: { heroIds: [fixture.heroId] } })
  assert.equal(assigned.status, 200, assigned.text)
  const created = await request(baseUrl, '/api/campaigns', { method: 'POST', cookie: adminCookie, body: { code: SESSION, name: 'Дворец после нападения', state: initial } })
  assert.equal(created.status, 201, created.text)
  const key = 'palace-fireball'
  const command = { command_type: 'CastSpell', actor_id: fixture.heroId, spell_id: 'fireball', to: fixture.kingPoint }
  const cast = (cookie, idempotencyKey = key) => request(baseUrl, `/api/campaigns/${SESSION}/commands`, {
    method: 'POST', cookie, key: idempotencyKey, body: { idempotency_key: idempotencyKey, command },
  }).catch((cause) => { throw new Error(`Не удалось выполнить ${method} ${path}`, { cause }) })
  const denied = await cast(outsiderCookie, 'foreign-fireball')
  assert.equal(denied.status, 403, denied.text)
  const first = await cast(ownerCookie)
  assert.equal(first.status, 200, first.text)
  const types = first.body.mechanics.map((event) => event.event_type)
  for (const type of ['SpellCast', 'ResourceSpent', 'DamageApplied', 'NpcDied', 'QuestInvalidated', 'OfficeVacated', 'CampaignStoryCompleted']) assert.ok(types.includes(type), type)
  assert.equal(types.filter((type) => type === 'NpcDied').length, 1)
  const result = first.body.authoritative_state
  const questId = fixture.state.campaignConcept.story_quest_id
  const initialQuest = fixture.state.worldMemory.quests.find((quest) => quest.id === questId)
  const failed = result.worldMemory.quests.find((quest) => quest.id === questId)
  assert.equal(failed.status, 'failed')
  assert.deepEqual(failed.clock, initialQuest.clock)
  assert.equal(result.campaignConcept.story_history.length, 1)
  assert.equal(result.campaignConcept.story_history[0].outcome, 'failure')
  assert.equal(result.world_offices[0].holder_npc_id, null)
  assert.equal(result.social.npcs.find((npc) => npc.id === fixture.kingId).available, false)
  assert.equal(result.npc_world, undefined)
  assert.doesNotMatch(JSON.stringify(result.world_offices), /successor|defender_npc_ids|due_at_minutes|pending/u)
  assert.doesNotMatch(JSON.stringify(first.body.mechanics.filter((event) => event.event_type.startsWith('Office'))), /due_at_minutes|candidate_dead/u)
  const slots = result.mechanics.resources[fixture.heroId].spell_slots_3.current
  assert.equal(slots, initial.mechanics.resources[fixture.heroId].spell_slots_3.current - 1)
  const repeated = await cast(ownerCookie)
  assert.equal(repeated.status, 200, repeated.text)
  assert.equal(repeated.body.idempotent_replay, true)
  assert.equal(repeated.body.authoritative_state.mechanics.resources[fixture.heroId].spell_slots_3.current, slots)
  assert.equal(repeated.body.authoritative_state.campaignConcept.story_history.length, 1)
  const rejectedDialogue = await request(baseUrl, '/api/narrate', { method: 'POST', cookie: ownerCookie, body: {
    campaign_id: SESSION, actor_id: fixture.heroId, npc_id: fixture.kingId, action: 'Обращаюсь к королю', request_kind: 'action', idempotency_key: 'dead-king-dialogue',
  } })
  assert.ok(rejectedDialogue.status >= 400, rejectedDialogue.text)
  assert.equal(rejectedDialogue.body.code, 'NPC_UNAVAILABLE', rejectedDialogue.text)
  await stopServer(child)
  child = null
  await launch()
  const restored = await request(baseUrl, `/api/rooms/${SESSION}`, { cookie: ownerCookie })
  assert.equal(restored.status, 200, restored.text)
  assert.equal(restored.body.state.social.npcs.find((npc) => npc.id === fixture.kingId).available, false)
  assert.deepEqual(restored.body.state.world_offices, result.world_offices)
  assert.deepEqual(restored.body.state.campaignConcept.story_history, result.campaignConcept.story_history)
  const retryAfterRestart = await cast(ownerCookie)
  assert.equal(retryAfterRestart.status, 200, retryAfterRestart.text)
  assert.equal(retryAfterRestart.body.idempotent_replay, true)
  assert.equal(retryAfterRestart.body.authoritative_state.mechanics.resources[fixture.heroId].spell_slots_3.current, slots)
})
