import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PERSISTENT_WORLD_OBJECTIVE } from '../server/campaign-stories.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const CAMPAIGN = 'PERSIST-API'

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
      ADMIN_SETUP_TOKEN: 'persistent-api-setup',
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

const cookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]

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

function findWalkableStep(state, actorId) {
  const actor = state.players.find((player) => player.id === actorId)
  assert.ok(actor && Number.isInteger(actor.x) && Number.isInteger(actor.y), 'у героя должна быть позиция на карте')
  const occupied = new Set(state.players.map((player) => `${player.x},${player.y}`))
  return state.scene.cells.find((cell) => cell.type === 'floor' && cell.revealed === true
    && !cell.feature && Math.abs(cell.x - actor.x) + Math.abs(cell.y - actor.y) === 1
    && !occupied.has(`${cell.x},${cell.y}`))
}

test('обычный игрок создаёт persistent кампанию, завершает стартовую историю и сохраняет её после restart', { timeout: runnerTimeout(90_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-persistent-api-'))
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

  const owner = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: { name: 'Owner', email: 'persistent-owner@test.local', password: 'secure-owner-password' },
  })
  const guest = await request(baseUrl, '/api/auth/register', {
    method: 'POST', body: { name: 'Guest', email: 'persistent-guest@test.local', password: 'secure-guest-password' },
  })
  assert.equal(owner.status, 201, owner.text)
  assert.equal(guest.status, 201, guest.text)
  const ownerCookie = cookie(owner)
  const guestCookie = cookie(guest)

  const invalidMode = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: ownerCookie,
    body: { code: 'BAD-MODE', name: 'Неверный режим', bootstrap: { slotCount: 1, campaignMode: 'sandbox' } },
  })
  assert.equal(invalidMode.status, 400, invalidMode.text)
  assert.equal(invalidMode.body.code, 'INVALID_CAMPAIGN_MODE')

  const defaultAdventure = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: ownerCookie,
    body: { code: 'ADVENTURE-DEFAULT', name: 'Обычное приключение', bootstrap: { slotCount: 1 } },
  })
  assert.equal(defaultAdventure.status, 201, defaultAdventure.text)
  assert.equal(defaultAdventure.body.state.campaignConcept.campaign_mode, 'adventure')
  assert.equal(defaultAdventure.body.state.campaignConcept.arc.preset, 'one_evening')

  const rawState = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: ownerCookie,
    body: {
      code: 'RAW-BLOCK', name: 'Сырая кампания', bootstrap: { slotCount: 1 },
      state: { sessionCode: 'RAW-BLOCK', campaign: 'Подделка', players: [] },
    },
  })
  assert.equal(rawState.status, 403, rawState.text)

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: ownerCookie,
    body: {
      code: CAMPAIGN,
      name: 'Постоянный мир',
      bootstrap: { partyName: 'Путники', slotCount: 2, rulesetId: 'srd_5_2_1', campaignMode: 'persistent' },
    },
  })
  assert.equal(created.status, 201, `${created.text}\n${log()}`)
  const initial = created.body.state
  assert.equal(initial.campaignConcept.campaign_mode, 'persistent')
  assert.equal(initial.campaignConcept.arc, undefined)
  assert.equal(initial.campaignConcept.story_sequence, 0)
  assert.deepEqual(initial.campaignConcept.story_history, [])
  const initialQuest = initial.worldMemory.quests.find((quest) => quest.status === 'active')
  assert.ok(initialQuest)
  assert.equal(initialQuest.clock.max, 4)
  assert.equal(initial.worldMemory.quests.filter((quest) => quest.status === 'active').length, 1)

  const invite = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/invites`, { method: 'POST', cookie: ownerCookie, body: {} })
  assert.equal(invite.status, 201, invite.text)
  assert.deepEqual(invite.body.hero_ids, ['hero-slot-2'])
  const joined = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/join`, {
    method: 'POST', cookie: guestCookie, body: { invite_token: invite.body.token },
  })
  assert.equal(joined.status, 200, joined.text)
  assert.deepEqual(joined.body.hero_ids, ['hero-slot-2'])

  const importHero = (cookieValue, actorId, character, key) => request(baseUrl, `/api/campaigns/${CAMPAIGN}/commands`, {
    method: 'POST', cookie: cookieValue, key,
    body: { idempotency_key: key, command: { command_type: 'ImportCharacter', actor_id: actorId, document: characterDocument(character) } },
  })
  const ownerImport = await importHero(ownerCookie, 'hero-slot-1', 'Ада', 'persistent-owner-import')
  const guestImport = await importHero(guestCookie, 'hero-slot-2', 'Борен', 'persistent-guest-import')
  assert.equal(ownerImport.status, 200, ownerImport.text)
  assert.equal(guestImport.status, 200, guestImport.text)

  await stopServer(child)
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, log)
  const afterRestart = await request(baseUrl, `/api/rooms/${CAMPAIGN}`, { cookie: ownerCookie })
  assert.equal(afterRestart.status, 200, afterRestart.text)
  assert.equal(afterRestart.body.state.campaignConcept.campaign_mode, 'persistent')
  assert.equal(afterRestart.body.state.campaignConcept.story_sequence, 0)

  const quest = afterRestart.body.state.worldMemory.quests.find((entry) => entry.status === 'active')
  assert.ok(quest)
  const requestAbandon = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/quests/abandon`, {
    method: 'POST', cookie: ownerCookie,
    body: { actor_id: 'hero-slot-1', quest_id: quest.id, idempotency_key: 'persistent-abandon-request' },
  })
  assert.equal(requestAbandon.status, 200, `${requestAbandon.text}\n${log()}`)
  const interaction = requestAbandon.body.state.agentInteraction
  assert.equal(interaction.status, 'open')
  assert.equal(interaction.questAbandonment.questId, quest.id)
  const abandonOption = interaction.options.find((option) => option.id === 'abandon')
  assert.ok(abandonOption)

  const ownerVote = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/party-decisions/${encodeURIComponent(interaction.id)}/votes`, {
    method: 'POST', cookie: ownerCookie,
    body: { actor_id: 'hero-slot-1', option_id: abandonOption.id, idempotency_key: 'persistent-abandon-owner-vote' },
  })
  assert.equal(ownerVote.status, 200, ownerVote.text)
  assert.equal(ownerVote.body.state.agentInteraction.status, 'open')
  const guestVote = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/party-decisions/${encodeURIComponent(interaction.id)}/votes`, {
    method: 'POST', cookie: guestCookie,
    body: { actor_id: 'hero-slot-2', option_id: abandonOption.id, idempotency_key: 'persistent-abandon-guest-vote' },
  })
  assert.equal(guestVote.status, 200, `${guestVote.text}\n${log()}`)

  const afterStory = guestVote.body.state
  assert.equal(afterStory.campaignConcept.campaign_mode, 'persistent')
  assert.equal(afterStory.campaignConcept.story_sequence, 1)
  assert.equal(afterStory.campaignConcept.story_history.length, 1)
  assert.equal(afterStory.campaignConcept.story_history[0].quest_id, quest.id)
  assert.equal(afterStory.scene.objective, PERSISTENT_WORLD_OBJECTIVE)
  assert.equal(afterStory.worldMemory.quests.filter((entry) => entry.status === 'active').length, 0)
  assert.ok(afterStory.messages.some((message) => message.text.includes('Мир остаётся открытым')))

  const guestForeignAbandon = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/quests/abandon`, {
    method: 'POST', cookie: guestCookie,
    body: { actor_id: 'hero-slot-1', quest_id: quest.id, idempotency_key: 'persistent-foreign-abandon' },
  })
  assert.equal(guestForeignAbandon.status, 403, guestForeignAbandon.text)
  const guestForeignCommand = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/commands`, {
    method: 'POST', cookie: guestCookie,
    body: { idempotency_key: 'persistent-foreign-command', command: { command_type: 'MoveActor', actor_id: 'hero-slot-1', to: { x: 1, y: 1 } } },
  })
  assert.equal(guestForeignCommand.status, 403, guestForeignCommand.text)

  await stopServer(child)
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, log)
  const persisted = await request(baseUrl, `/api/rooms/${CAMPAIGN}`, { cookie: ownerCookie })
  assert.equal(persisted.status, 200, persisted.text)
  assert.equal(persisted.body.state.campaignConcept.story_sequence, 1)
  assert.equal(persisted.body.state.campaignConcept.story_history.length, 1)

  const question = await request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: ownerCookie,
    body: { campaign_id: CAMPAIGN, actor_id: 'hero-slot-1', request_kind: 'question', action: 'Куда дальше?', idempotency_key: 'persistent-question' },
  })
  assert.equal(question.status, 200, `${question.text}\n${log()}`)

  const destination = findWalkableStep(persisted.body.state, 'hero-slot-1')
  assert.ok(destination, 'после завершения истории должен оставаться обычный шаг по карте')
  const move = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/commands`, {
    method: 'POST', cookie: ownerCookie,
    body: { idempotency_key: 'persistent-move-after-story', command: { command_type: 'MoveActor', actor_id: 'hero-slot-1', to: { x: destination.x, y: destination.y } } },
  })
  assert.equal(move.status, 200, `${move.text}\n${log()}`)

  const guestPause = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/lifecycle`, {
    method: 'POST', cookie: guestCookie,
    body: { action: 'pause', idempotency_key: 'persistent-guest-pause' },
  })
  assert.equal(guestPause.status, 403, guestPause.text)

  const pause = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/lifecycle`, {
    method: 'POST', cookie: ownerCookie,
    body: { action: 'pause', idempotency_key: 'persistent-pause' },
  })
  assert.equal(pause.status, 200, pause.text)
  assert.equal(pause.body.lifecycle.status, 'paused')
  const resume = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/lifecycle`, {
    method: 'POST', cookie: ownerCookie,
    body: { action: 'resume', idempotency_key: 'persistent-resume' },
  })
  assert.equal(resume.status, 200, resume.text)
  assert.equal(resume.body.lifecycle.status, 'active')
  const complete = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/lifecycle`, {
    method: 'POST', cookie: ownerCookie,
    body: { action: 'complete', idempotency_key: 'persistent-complete' },
  })
  assert.equal(complete.status, 200, complete.text)
  assert.equal(complete.body.lifecycle.status, 'completed')
  const blockedAfterComplete = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/commands`, {
    method: 'POST', cookie: ownerCookie,
    body: { idempotency_key: 'persistent-terminal-move', command: { command_type: 'MoveActor', actor_id: 'hero-slot-1', to: { x: destination.x, y: destination.y } } },
  })
  assert.equal(blockedAfterComplete.status, 400, blockedAfterComplete.text)
  assert.equal(blockedAfterComplete.body.code, 'CAMPAIGN_READ_ONLY')
  const archive = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/lifecycle`, {
    method: 'POST', cookie: ownerCookie,
    body: { action: 'archive', idempotency_key: 'persistent-archive' },
  })
  assert.equal(archive.status, 200, archive.text)
  assert.equal(archive.body.lifecycle.status, 'archived')
  const terminal = await request(baseUrl, `/api/campaigns/${CAMPAIGN}/lifecycle`, { cookie: ownerCookie })
  assert.equal(terminal.status, 200, terminal.text)
  assert.equal(terminal.body.lifecycle.status, 'archived')
})
