import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileEventStore } from '../server/event-store.mjs'
import { GAME_STATE_PROJECTOR_VERSION, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  const address = probe.address()
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
  return address.port
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
      ADMIN_SETUP_TOKEN: 'stage1-setup',
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
  await new Promise((resolve) => { child.once('exit', resolve); child.kill() })
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Server exited\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
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

function sessionCookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0]
}

async function openRoomStream(baseUrl, cookie, signal) {
  const response = await fetch(`${baseUrl}/api/campaigns/STAGE1/stream`, {
    headers: { Cookie: cookie, Accept: 'text/event-stream' },
    signal,
  })
  assert.equal(response.status, 200)
  return { reader: response.body.getReader(), decoder: new TextDecoder(), buffer: '', queued: [] }
}

async function nextRoomEvent(stream, predicate = () => true) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    while (stream.queued.length) {
      const value = stream.queued.shift()
      if (predicate(value)) return value
    }
    const remaining = Math.max(1, deadline - Date.now())
    let timeout
    const read = await Promise.race([
      stream.reader.read(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('SSE timeout')), remaining) }),
    ]).finally(() => clearTimeout(timeout))
    if (read.done) throw new Error('SSE stream closed')
    stream.buffer += stream.decoder.decode(read.value, { stream: true })
    const blocks = stream.buffer.split(/\r?\n\r?\n/u)
    stream.buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      if (!/^event: room$/mu.test(block)) continue
      const data = block.split(/\r?\n/u).filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n')
      if (data) stream.queued.push(JSON.parse(data))
    }
  }
  throw new Error('No matching room event')
}

function hero(id, name) {
  return {
    id,
    name,
    character: name,
    characterClass: 'fighter',
    level: 1,
    experience: 0,
    hp: 12,
    maxHp: 12,
    armor: 10,
    speed: 30,
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    inventory: [{
      id: `${id}-leather`,
      catalog_id: 'srd_5_2_1:leather-armor',
      name: 'Кожаный доспех',
      type: 'armor',
      quantity: 1,
      weight: 10,
      equipped: false,
    }],
  }
}

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

test('этап 1: два игрока получают SSE presence, коммитят без lost update, а projection восстанавливается после restart', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-stage1-'))
  let logs = ''
  let child = null
  const ownerStreamAbort = new AbortController()
  const guestStreamAbort = new AbortController()
  t.after(async () => {
    ownerStreamAbort.abort()
    guestStreamAbort.abort()
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })

  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const owner = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Owner', email: 'stage1-owner@test.local', password: 'secure-owner-password' },
  })
  const guest = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Guest', email: 'stage1-guest@test.local', password: 'secure-guest-password' },
  })
  const ownerCookie = sessionCookie(owner)
  const guestCookie = sessionCookie(guest)
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: ownerCookie,
    body: {
      code: 'STAGE1',
      name: 'Stage 1 authority',
      bootstrap: {
        partyName: 'Четверо',
        players: [
          hero('hero-1', 'Первый'),
          hero('hero-2', 'Второй'),
          hero('hero-3', 'Третий'),
          hero('hero-4', 'Четвёртый'),
        ],
      },
    },
  })
  assert.equal(created.status, 201, created.text)
  const invite = await request(baseUrl, '/api/campaigns/STAGE1/invites', {
    method: 'POST',
    cookie: ownerCookie,
    body: { hero_ids: ['hero-2'] },
  })
  assert.equal(invite.status, 201, invite.text)
  assert.equal((await request(baseUrl, '/api/campaigns/STAGE1/join', {
    method: 'POST',
    cookie: guestCookie,
    body: { invite_token: invite.body.token },
  })).status, 200)

  const guestSettings = await request(baseUrl, '/api/campaigns/STAGE1/settings', { cookie: guestCookie })
  assert.equal(guestSettings.status, 200, guestSettings.text)
  assert.equal(guestSettings.body.canManage, false)
  assert.equal((await request(baseUrl, '/api/campaigns/STAGE1/settings', {
    method: 'PATCH',
    cookie: guestCookie,
    body: { model: guestSettings.body.settings.model, narratorStyle: 'formal' },
  })).status, 403)

  const ownerSettings = await request(baseUrl, '/api/campaigns/STAGE1/settings', { cookie: ownerCookie })
  assert.equal(ownerSettings.status, 200, ownerSettings.text)
  assert.equal(ownerSettings.body.canManage, true)
  const selectedModel = ownerSettings.body.availableModels.at(-1)
  const savedSettings = await request(baseUrl, '/api/campaigns/STAGE1/settings', {
    method: 'PATCH',
    cookie: ownerCookie,
    body: { model: selectedModel, narratorStyle: 'formal' },
  })
  assert.equal(savedSettings.status, 200, savedSettings.text)
  assert.deepEqual(savedSettings.body.settings, { model: selectedModel, narratorStyle: 'formal' })
  const rejectedModel = await request(baseUrl, '/api/campaigns/STAGE1/settings', {
    method: 'PATCH',
    cookie: ownerCookie,
    body: { model: 'arbitrary/provider-model', narratorStyle: 'formal' },
  })
  assert.equal(rejectedModel.status, 400, rejectedModel.text)
  assert.equal(rejectedModel.body.code, 'AI_MODEL_NOT_ALLOWED')

  const importHero = (cookieValue, actorId, character) => request(baseUrl, '/api/campaigns/STAGE1/commands', {
    method: 'POST',
    cookie: cookieValue,
    key: `stage1-import-${actorId}`,
    body: {
      idempotency_key: `stage1-import-${actorId}`,
      command: { command_type: 'ImportCharacter', actor_id: actorId, document: characterDocument(character) },
    },
  })
  assert.equal((await importHero(ownerCookie, 'hero-1', 'Первый')).status, 200)
  assert.equal((await importHero(guestCookie, 'hero-2', 'Второй')).status, 200)

  const ownerStream = await openRoomStream(baseUrl, ownerCookie, ownerStreamAbort.signal)
  await nextRoomEvent(ownerStream, (event) => event.state.presence.online_hero_ids.includes('hero-1'))
  const guestStream = await openRoomStream(baseUrl, guestCookie, guestStreamAbort.signal)
  const bothOnline = await nextRoomEvent(ownerStream, (event) => event.state.presence.online_hero_ids.length === 2)
  assert.deepEqual(bothOnline.state.presence.online_hero_ids, ['hero-1', 'hero-2'])
  assert.equal((await nextRoomEvent(guestStream)).state.presence.transport, 'sse')

  const command = (cookie, key, actorId) => request(baseUrl, '/api/campaigns/STAGE1/commands', {
    method: 'POST',
    cookie,
    key,
    body: {
      idempotency_key: key,
      command: { command_type: 'EquipItem', actor_id: actorId, item_id: `${actorId}-starter-longsword`, equipped: false },
    },
  })
  const [ownerEquip, guestEquip] = await Promise.all([
    command(ownerCookie, 'stage1-owner-equip', 'hero-1'),
    command(guestCookie, 'stage1-guest-equip', 'hero-2'),
  ])
  assert.equal(ownerEquip.status, 200, ownerEquip.text)
  assert.equal(guestEquip.status, 200, guestEquip.text)
  const converged = await request(baseUrl, '/api/rooms/STAGE1', { cookie: ownerCookie })
  assert.equal(converged.status, 200, converged.text)
  assert.equal(converged.body.state.players.find((player) => player.id === 'hero-1').inventory[0].equipped, false)
  assert.equal(converged.body.state.players.find((player) => player.id === 'hero-2').inventory[0].equipped, false)

  guestStreamAbort.abort()
  const guestOffline = await nextRoomEvent(ownerStream, (event) => !event.state.presence.online_hero_ids.includes('hero-2'))
  assert.deepEqual(guestOffline.state.presence.online_hero_ids, ['hero-1'])
  ownerStreamAbort.abort()
  await stopServer(child)
  child = null

  const eventStore = new FileEventStore({
    rootDir: join(storage, 'engine'),
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
    snapshotProjectorVersion: GAME_STATE_PROJECTOR_VERSION,
  })
  const beforeCrash = await eventStore.load('STAGE1')
  await eventStore.commit({
    campaign_id: 'STAGE1',
    expected_state_version: beforeCrash.state_version,
    idempotency_key: 'stage1-crash-between-event-and-projection',
    events: [{
      event_type: 'ExperienceAwarded',
      target_ids: ['hero-1', 'hero-2', 'hero-3', 'hero-4'],
      source_rule_ids: ['srd_5_2_1:resources:spending'],
      payload: { total_xp: 40, recipients: ['hero-1', 'hero-2', 'hero-3', 'hero-4'] },
    }],
  })
  assert.ok(await eventStore.pendingProjection('STAGE1'))

  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)
  const recovered = await request(baseUrl, '/api/rooms/STAGE1', { cookie: ownerCookie })
  assert.equal(recovered.status, 200, recovered.text)
  assert.deepEqual(recovered.body.state.players.map((player) => player.experience), [10, 10, 10, 10])
  const recoveredSettings = await request(baseUrl, '/api/campaigns/STAGE1/settings', { cookie: ownerCookie })
  assert.equal(recoveredSettings.status, 200, recoveredSettings.text)
  assert.deepEqual(recoveredSettings.body.settings, { model: selectedModel, narratorStyle: 'formal' })
  assert.equal(await eventStore.pendingProjection('STAGE1'), null)
})
