import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { freePort } from './free-port.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

function startServer(port, storage, appendLog) {
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      ROUTERAI_API_KEY: '',
      ADMIN_SETUP_TOKEN: 'director-player-entry-setup',
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
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Тестовый сервер завершился\n${logs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
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
  return { status: response.status, body: text ? JSON.parse(text) : null, text, response }
}

function cookie(result) {
  return result.response.headers.get('set-cookie')?.split(';')[0] ?? ''
}

function characterDocument(character) {
  const baseScores = { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 }
  return {
    schema: 'skazanie.character',
    schema_version: 1,
    character: {
      character, name: character, role: 'Варвар · ур. 1', characterClass: 'barbarian',
      species: 'Человек', background: 'Солдат', backstory: 'Ищет пропавшую дорогу.',
      level: 1, experience: 0, abilities: baseScores,
      abilityGeneration: {
        policyId: 'skazanie.character-abilities.standard-array', policyVersion: 1,
        method: 'standard_array', baseScores,
        originBonusProfileId: 'none',
        originBonuses: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
        speciesOptionId: 'human',
      },
      baseSpeed: 30, hitPointIncreases: [],
      classSkillProficiencies: ['athletics', 'perception'],
      selectedFeatureIds: [], knownSpellIds: [], preparedSpellIds: [],
    },
  }
}

async function command(baseUrl, campaignId, cookieValue, key, value) {
  return request(baseUrl, `/api/campaigns/${campaignId}/commands`, {
    method: 'POST', cookie: cookieValue,
    body: { idempotency_key: key, message: value.command.command_type, command: value.command },
  })
}

async function register(baseUrl, name, email) {
  const result = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name, email, password: `${name}-director-entry-password` },
  })
  assert.equal(result.status, 201, result.text)
  return cookie(result)
}

test('обычный игрок запускает Director, resume по interaction_id переживает restart и guards не меняют состояние', { timeout: runnerTimeout(90_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-director-player-entry-'))
  let logs = ''
  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  let child = startServer(port, storage, (chunk) => { logs += chunk })
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })
  await waitForHealth(baseUrl, child, () => logs)

  const setup = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Setup', email: 'setup@director-entry.test', password: 'setup-password', setupToken: 'director-player-entry-setup' },
  })
  assert.equal(setup.status, 201, setup.text)
  const adminCookie = cookie(setup)
  const ownerCookie = await register(baseUrl, 'Owner', 'owner@director-entry.test')
  const guestCookie = await register(baseUrl, 'Guest', 'guest@director-entry.test')

  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: ownerCookie,
    body: {
      code: 'DIRECTOR-ENTRY', name: 'Проверка входа ведущего',
      bootstrap: { slotCount: 2, partyName: 'Два героя', world: { preset: 'Классическое фэнтези' } },
    },
  })
  assert.equal(created.status, 201, created.text)
  const ownerHero = 'hero-slot-1'
  const guestHero = 'hero-slot-2'

  const setupBlocked = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/autonomy/advance', {
    method: 'POST', cookie: ownerCookie,
    body: { idempotency_key: 'setup-block', actor_id: ownerHero, player_action: 'продолжим' },
  })
  assert.equal(setupBlocked.status, 409, setupBlocked.text)
  assert.equal(setupBlocked.body.code, 'CHARACTER_SETUP_REQUIRED')

  const invite = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/invites', {
    method: 'POST', cookie: ownerCookie, body: {},
  })
  assert.equal(invite.status, 201, invite.text)
  const joined = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/join', {
    method: 'POST', cookie: guestCookie, body: { invite_token: invite.body.token },
  })
  assert.equal(joined.status, 200, joined.text)

  for (const [heroId, heroCookie] of [[ownerHero, ownerCookie], [guestHero, guestCookie]]) {
    const imported = await command(baseUrl, 'DIRECTOR-ENTRY', heroCookie, `import-${heroId}`, {
      command: { command_type: 'ImportCharacter', actor_id: heroId, document: characterDocument(heroId) },
    })
    assert.equal(imported.status, 200, imported.text)
  }

  const paused = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/lifecycle', {
    method: 'POST', cookie: ownerCookie,
    body: { action: 'pause', idempotency_key: 'pause-before-director' },
  })
  assert.equal(paused.status, 200, paused.text)
  const pausedAdvance = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/autonomy/advance', {
    method: 'POST', cookie: ownerCookie,
    body: { idempotency_key: 'paused-director', actor_id: ownerHero, player_action: 'продолжим' },
  })
  assert.equal(pausedAdvance.status, 409, pausedAdvance.text)
  assert.equal(pausedAdvance.body.code, 'CAMPAIGN_PAUSED')
  const resumed = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/lifecycle', {
    method: 'POST', cookie: ownerCookie,
    body: { action: 'resume', idempotency_key: 'resume-before-director' },
  })
  assert.equal(resumed.status, 200, resumed.text)

  const first = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/autonomy/advance', {
    method: 'POST', cookie: ownerCookie,
    body: { idempotency_key: 'director-first', actor_id: ownerHero, player_action: 'продолжим' },
  })
  assert.equal(first.status, 200, first.text)
  assert.equal(first.body.admin_commands, 0)
  assert.equal(first.body.intent.type, 'continue_exploration')
  const firstRetry = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/autonomy/advance', {
    method: 'POST', cookie: ownerCookie,
    body: { idempotency_key: 'director-first', actor_id: ownerHero, player_action: 'другая формулировка' },
  })
  assert.equal(firstRetry.status, 200, firstRetry.text)
  assert.equal(firstRetry.body.duplicate, true)
  assert.equal(firstRetry.body.state_version, first.body.state_version)

  const foreignActor = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/autonomy/advance', {
    method: 'POST', cookie: guestCookie,
    body: { idempotency_key: 'foreign-director', actor_id: ownerHero, player_action: 'продолжим' },
  })
  assert.equal(foreignActor.status, 403, foreignActor.text)
  assert.equal(foreignActor.body.code, 'ACTOR_FORBIDDEN')

  const transition = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/autonomy/advance', {
    method: 'POST', cookie: ownerCookie,
    body: { idempotency_key: 'director-transition', actor_id: ownerHero, player_action: 'Перейти дальше' },
  })
  assert.equal(transition.status, 200, transition.text)
  const interactionId = transition.body.state.agentInteraction?.id
  assert.ok(interactionId)
  assert.equal(transition.body.state.agentInteraction.status, 'open')
  const openDecisionBlocked = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/autonomy/advance', {
    method: 'POST', cookie: ownerCookie,
    body: { idempotency_key: 'director-while-vote-open', actor_id: ownerHero, player_action: 'продолжим' },
  })
  assert.equal(openDecisionBlocked.status, 409, openDecisionBlocked.text)
  assert.equal(openDecisionBlocked.body.code, 'PARTY_DECISION_OPEN')

  for (const [heroId, heroCookie] of [[ownerHero, ownerCookie], [guestHero, guestCookie]]) {
    const vote = await request(baseUrl, `/api/campaigns/DIRECTOR-ENTRY/party-decisions/${encodeURIComponent(interactionId)}/votes`, {
      method: 'POST', cookie: heroCookie,
      body: { actor_id: heroId, option_id: 'continue', idempotency_key: `vote-${heroId}` },
    })
    assert.equal(vote.status, 200, vote.text)
  }

  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const resumedTransition = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/autonomy/advance', {
    method: 'POST', cookie: ownerCookie,
    body: {
      interaction_id: interactionId, idempotency_key: 'attacker-prefix-does-not-authorize',
      actor_id: ownerHero, player_action: 'Продолжить подтверждённый переход',
    },
  })
  assert.equal(resumedTransition.status, 200, resumedTransition.text)
  assert.equal(resumedTransition.body.state.agentInteraction, null)
  assert.equal(resumedTransition.body.state.adventure.chapter, transition.body.state.adventure.chapter + 1)

  const resumedRetry = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/autonomy/advance', {
    method: 'POST', cookie: ownerCookie,
    body: { interaction_id: interactionId, actor_id: ownerHero, player_action: 'Повтор после reconnect' },
  })
  assert.equal(resumedRetry.status, 200, resumedRetry.text)
  assert.equal(resumedRetry.body.duplicate, true)
  assert.equal(resumedRetry.body.state_version, resumedTransition.body.state_version)

  const afterResume = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/autonomy/advance', {
    method: 'POST', cookie: ownerCookie,
    body: { idempotency_key: 'director-after-resume', actor_id: ownerHero, player_action: 'продолжим' },
  })
  assert.equal(afterResume.status, 200, afterResume.text)
  assert.notEqual(afterResume.body.code, 'PARTY_DECISION_RESUME_REQUIRED')

  const room = await request(baseUrl, '/api/rooms/DIRECTOR-ENTRY', { cookie: adminCookie })
  const assembled = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/encounters/assemble', {
    method: 'POST', cookie: adminCookie,
    body: {
      expected_state_version: room.body.state.state_version,
      difficulty: 'easy', theme: 'beasts', seed: 'director-entry-combat', idempotency_key: 'director-entry-combat',
    },
  })
  assert.equal(assembled.status, 200, assembled.text)
  const combatRoom = await request(baseUrl, '/api/rooms/DIRECTOR-ENTRY', { cookie: ownerCookie })
  assert.equal(combatRoom.status, 200, combatRoom.text)
  assert.equal(combatRoom.body.state.mechanics.combat.active, true)
  const resumedAfterCombat = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/autonomy/advance', {
    method: 'POST', cookie: ownerCookie,
    body: { interaction_id: interactionId, actor_id: ownerHero, player_action: 'Повтор после нового боя' },
  })
  assert.equal(resumedAfterCombat.status, 200, resumedAfterCombat.text)
  assert.equal(resumedAfterCombat.body.duplicate, true)
  assert.equal(resumedAfterCombat.body.state_version, combatRoom.body.state.state_version)
  const combatBlocked = await request(baseUrl, '/api/campaigns/DIRECTOR-ENTRY/autonomy/advance', {
    method: 'POST', cookie: ownerCookie,
    body: { idempotency_key: 'combat-director', actor_id: ownerHero, player_action: 'продолжим' },
  })
  assert.equal(combatBlocked.status, 409, combatBlocked.text)
  assert.equal(combatBlocked.body.code, 'COMBAT_ACTIVE')
})
