import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runnerTimeout } from './shared-runner-timeout.mjs'
import { worldClockEventDrafts } from '../server/weather.mjs'

/**
 * Что может выпустить ход мира за продолжительный отдых
 * (`server/offscreen-world.mjs`). Набор закрытый: он и отделяет ход мира от
 * событий самого отдыха, которые сторож ниже по-прежнему сверяет буквально.
 */
const OFFSCREEN_STEP_EVENT_TYPES = new Set([
  'OffscreenWorldStepResolved', 'QuestClockAdvanced', 'QuestResolved',
  'WorldEntityUpserted', 'WorldFactRecorded', 'NarrativeSummaryRecorded',
  // Увод заложника гасит доступность уже известного NPC — единственное, что ход
  // мира правит помимо памяти мира.
  'NpcSocialProfileUpserted',
])

async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
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
      ADMIN_SETUP_TOKEN: 'hit-dice-api-setup',
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
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return } catch { /* starting */ }
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
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { /* assertion includes raw body */ }
  return { response, status: response.status, body: parsed, text }
}

const cookie = (result) => result.response.headers.get('set-cookie')?.split(';')[0]

function initialState() {
  return {
    state_version: 0,
    sessionCode: 'HIT-DICE-API',
    campaign: 'Кости хитов',
    activePlayerId: 'fighter',
    partyMemberIds: ['fighter', 'wizard'],
    players: [
      {
        id: 'fighter', character: 'Бран', characterClass: 'fighter', role: 'Воин · ур. 2', level: 2,
        hp: 1, maxHp: 30, armor: 16, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 8 }, inventory: [],
      },
      {
        id: 'wizard', character: 'Мира', characterClass: 'wizard', role: 'Волшебник · ур. 3', level: 3,
        hp: 10, maxHp: 10, armor: 12, abilities: { str: 8, dex: 12, con: 10, int: 16, wis: 12, cha: 10 }, inventory: [],
      },
    ],
    enemies: [], actors: [], messages: [], battleLog: [],
    scene: { location: 'Лагерь', cells: [], turn: 1 },
    mechanics: { resources: { fighter: {}, wizard: {} } },
  }
}

function restCommand(baseUrl, cookieValue, key, command) {
  return request(baseUrl, '/api/campaigns/HIT-DICE-API/commands', {
    method: 'POST', cookie: cookieValue, key,
    body: { idempotency_key: key, command, message: `HTTP rest: ${command.command_type}` },
  })
}

test('HTTP-отдых санитизирует поля, защищает героя и идемпотентно тратит кости хитов', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-hit-dice-api-'))
  let logs = ''
  let child = null
  t.after(async () => { await stopServer(child); rmSync(storage, { recursive: true, force: true }) })

  let port = await freePort()
  let baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const admin = await request(baseUrl, '/api/auth/setup-admin', { method: 'POST', body: {
    name: 'GM', email: 'gm@hit-dice.test', password: 'secure-admin-password', setupToken: 'hit-dice-api-setup',
  } })
  const owner = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Owner', email: 'owner@hit-dice.test', password: 'secure-owner-password',
  } })
  const foreign = await request(baseUrl, '/api/auth/register', { method: 'POST', body: {
    name: 'Foreign', email: 'foreign@hit-dice.test', password: 'secure-foreign-password',
  } })
  assert.equal(admin.status, 201, `${admin.text}\n${logs}`)
  assert.equal(owner.status, 201, `${owner.text}\n${logs}`)
  assert.equal(foreign.status, 201, `${foreign.text}\n${logs}`)
  const adminCookie = cookie(admin)
  const ownerCookie = cookie(owner)
  const foreignCookie = cookie(foreign)

  const users = await request(baseUrl, '/api/admin/users', { cookie: adminCookie })
  const ownerUser = users.body.users.find((candidate) => candidate.email === 'owner@hit-dice.test')
  const foreignUser = users.body.users.find((candidate) => candidate.email === 'foreign@hit-dice.test')
  const ownership = await request(baseUrl, `/api/admin/users/${ownerUser.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds: ['fighter'] },
  })
  assert.equal(ownership.status, 200, `${ownership.text}\n${logs}`)
  const foreignOwnership = await request(baseUrl, `/api/admin/users/${foreignUser.id}`, {
    method: 'PATCH', cookie: adminCookie, body: { heroIds: ['wizard'] },
  })
  assert.equal(foreignOwnership.status, 200, `${foreignOwnership.text}\n${logs}`)
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie,
    body: { code: 'HIT-DICE-API', name: 'Кости хитов', state: initialState() },
  })
  assert.equal(created.status, 201, `${created.text}\n${logs}`)

  const autonomyIntentMarker = await request(baseUrl, '/api/campaigns/HIT-DICE-API/commands', {
    method: 'POST', cookie: adminCookie, key: 'hit-dice-autonomy-privacy:intent',
    body: {
      idempotency_key: 'hit-dice-autonomy-privacy:intent',
      command: { command_type: 'UpdateObjective', objective: 'Проверить приватность костей хитов' },
      message: 'Служебный маркер идемпотентности',
    },
  })
  assert.equal(autonomyIntentMarker.status, 200, `${autonomyIntentMarker.text}\n${logs}`)
  const foreignAutonomyReplay = await request(baseUrl, '/api/campaigns/HIT-DICE-API/autonomy/advance', {
    method: 'POST', cookie: foreignCookie, key: 'hit-dice-autonomy-privacy',
    body: { idempotency_key: 'hit-dice-autonomy-privacy' },
  })
  assert.equal(foreignAutonomyReplay.status, 200, `${foreignAutonomyReplay.text}\n${logs}`)
  assert.equal(foreignAutonomyReplay.body.duplicate, true)
  assert.equal(foreignAutonomyReplay.body.state.mechanics.hit_point_dice.fighter, undefined)
  assert.equal(foreignAutonomyReplay.body.state.mechanics.hit_point_dice.wizard.die_size, 6)

  const knockoutState = initialState()
  knockoutState.sessionCode = 'HIT-DICE-KNOCKOUT'
  knockoutState.mechanics.resting = {
    fighter: { kind: 'short', reason: 'knockout', recovery_minutes_remaining: 60 },
  }
  knockoutState.mechanics.conditions = {
    fighter: [{ id: 'unconscious', duration: 'until-short-rest' }],
  }
  const knockoutCreated = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: adminCookie,
    body: { code: 'HIT-DICE-KNOCKOUT', name: 'Нокаут', state: knockoutState },
  })
  assert.equal(knockoutCreated.status, 201, `${knockoutCreated.text}\n${logs}`)
  const forgedKnockoutCompletion = await request(baseUrl, '/api/campaigns/HIT-DICE-KNOCKOUT/commands', {
    method: 'POST', cookie: ownerCookie, key: 'knockout-complete-forged',
    body: {
      idempotency_key: 'knockout-complete-forged',
      command: { command_type: 'CompleteRest', actor_id: 'fighter' },
      message: 'Досрочно завершить восстановление после нокаута',
    },
  })
  assert.equal(forgedKnockoutCompletion.status, 400, forgedKnockoutCompletion.text)
  assert.equal(forgedKnockoutCompletion.body.code, 'KNOCKOUT_REST_AUTOMATIC')
  const knockoutAfterForgery = await request(baseUrl, '/api/rooms/HIT-DICE-KNOCKOUT', { cookie: ownerCookie })
  assert.equal(knockoutAfterForgery.status, 200, knockoutAfterForgery.text)
  assert.equal(knockoutAfterForgery.body.state.mechanics.resting.fighter.reason, 'knockout')
  assert.equal(knockoutAfterForgery.body.state.mechanics.resting.fighter.recovery_minutes_remaining, 60)
  assert.ok(knockoutAfterForgery.body.state.mechanics.conditions.fighter.some((condition) => condition.id === 'unconscious'))

  const forbidden = await restCommand(baseUrl, foreignCookie, 'rest-foreign', { command_type: 'StartRest', actor_id: 'fighter', kind: 'short' })
  assert.equal(forbidden.status, 403, forbidden.text)

  const forged = await restCommand(baseUrl, ownerCookie, 'rest-forged', {
    command_type: 'StartRest', actor_id: 'fighter', kind: 'short', amount: 1, formula: '99d99', result: 99, cost: 0, duration: 1, rest_id: 'forged',
  })
  assert.equal(forged.status, 400, forged.text)
  assert.equal(forged.body.code, 'REST_COMMAND_UNKNOWN_FIELD')
  const invalidKind = await restCommand(baseUrl, ownerCookie, 'rest-invalid-kind', {
    command_type: 'StartRest', actor_id: 'fighter', kind: 'nap',
  })
  assert.equal(invalidKind.status, 400, invalidKind.text)
  assert.equal(invalidKind.body.code, 'REST_KIND_INVALID')
  const arbitraryTime = await restCommand(baseUrl, ownerCookie, 'rest-arbitrary-time', { command_type: 'AdvanceTime', actor_id: 'fighter', amount: 60, unit: 'minute' })
  assert.equal(arbitraryTime.status, 403, arbitraryTime.text)
  assert.equal(arbitraryTime.body.code, 'PLAYER_COMMAND_FORBIDDEN')

  const start = await restCommand(baseUrl, ownerCookie, 'rest-start-short', { command_type: 'StartRest', actor_id: 'fighter' })
  assert.equal(start.status, 200, `${start.text}\n${logs}`)
  assert.deepEqual(start.body.mechanics.map((event) => event.event_type), ['RestStarted', 'TimeAdvanced'])
  assert.equal(start.body.authoritative_state.mechanics.world_time.elapsed_minutes, 60)
  assert.equal(start.body.authoritative_state.players.find((hero) => hero.id === 'fighter').hp, 1)
  assert.equal(start.body.authoritative_state.mechanics.hit_point_dice.fighter.die_size, 10)
  assert.equal(start.body.authoritative_state.mechanics.hit_point_dice.wizard, undefined)

  const startRetry = await restCommand(baseUrl, ownerCookie, 'rest-start-short', { command_type: 'StartRest', actor_id: 'fighter' })
  assert.equal(startRetry.status, 200, startRetry.text)
  assert.equal(startRetry.body.state_version, start.body.state_version)
  assert.equal(startRetry.body.authoritative_state.mechanics.world_time.elapsed_minutes, 60)
  const semanticCollision = await restCommand(baseUrl, ownerCookie, 'rest-start-short', { command_type: 'SpendHitPointDie', actor_id: 'fighter' })
  assert.equal(semanticCollision.status, 409, semanticCollision.text)
  assert.equal(semanticCollision.body.code, 'IDEMPOTENCY_CONFLICT')

  const spent = await restCommand(baseUrl, ownerCookie, 'rest-spend-one', { command_type: 'SpendHitPointDie', actor_id: 'fighter' })
  assert.equal(spent.status, 200, `${spent.text}\n${logs}`)
  assert.equal(spent.body.authoritative_state.mechanics.hit_point_dice.fighter.spent, 1)
  assert.ok(spent.body.authoritative_state.players.find((hero) => hero.id === 'fighter').hp > 1)
  const spentRetry = await restCommand(baseUrl, ownerCookie, 'rest-spend-one', { command_type: 'SpendHitPointDie', actor_id: 'fighter' })
  assert.equal(spentRetry.status, 200, spentRetry.text)
  assert.equal(spentRetry.body.state_version, spent.body.state_version)
  assert.equal(spentRetry.body.authoritative_state.mechanics.hit_point_dice.fighter.spent, 1)

  const race = await Promise.all([
    restCommand(baseUrl, ownerCookie, 'rest-race-a', { command_type: 'SpendHitPointDie', actor_id: 'fighter' }),
    restCommand(baseUrl, ownerCookie, 'rest-race-b', { command_type: 'SpendHitPointDie', actor_id: 'fighter' }),
  ])
  assert.equal(race.filter((result) => result.status === 200).length, 1, race.map((result) => result.text).join('\n'))

  const completed = await restCommand(baseUrl, ownerCookie, 'rest-complete-short', { command_type: 'CompleteRest', actor_id: 'fighter' })
  assert.equal(completed.status, 200, `${completed.text}\n${logs}`)
  assert.equal(completed.body.authoritative_state.mechanics.resting.fighter, undefined)
  assert.equal(completed.body.authoritative_state.mechanics.hit_point_dice.fighter.spent, 2)
  const spentAfterCompletionRetry = await restCommand(baseUrl, ownerCookie, 'rest-spend-one', { command_type: 'SpendHitPointDie', actor_id: 'fighter' })
  assert.equal(spentAfterCompletionRetry.status, 200, spentAfterCompletionRetry.text)
  assert.equal(spentAfterCompletionRetry.body.idempotent_replay, true)
  assert.equal(spentAfterCompletionRetry.body.state_version, completed.body.state_version)
  const completedRetry = await restCommand(baseUrl, ownerCookie, 'rest-complete-short', { command_type: 'CompleteRest', actor_id: 'fighter' })
  assert.equal(completedRetry.status, 200, completedRetry.text)
  assert.equal(completedRetry.body.idempotent_replay, true)
  assert.equal(completedRetry.body.state_version, completed.body.state_version)

  const longRest = await restCommand(baseUrl, ownerCookie, 'rest-start-long', { command_type: 'StartRest', actor_id: 'fighter', kind: 'long' })
  assert.equal(longRest.status, 200, `${longRest.text}\n${logs}`)
  // Восемь часов сна всегда пересекают границу времени суток, и мировые часы
  // пишут об этом своё событие (`server/weather.mjs`). В списке оно остаётся на
  // своём месте — вычеркнуть небо значило бы перестать замечать задвоенное
  // событие в контуре отдыха, — а сколько его быть должно, отвечают сами часы.
  const restedState = longRest.body.authoritative_state
  const beforeRest = { ...restedState, mechanics: { ...restedState.mechanics, world_time: { ...restedState.mechanics.world_time, elapsed_minutes: 60 } } }
  const sky = worldClockEventDrafts(beforeRest, 480).map((draft) => draft.event_type)
  assert.deepEqual(sky, ['TimeOfDayChanged'], 'восемь часов сна переводят время суток ровно один раз')
  // Восемь часов — существенный скачок, и мир делает за них свой ход
  // (`server/offscreen-world.mjs`): часы заданий, память мира и врезка «Пока вас
  // не было…». Список выписан буквально и **не выводится из ответа**: счёт
  // «сколько типов пришло, столько и ждём» подтверждал бы сам себя, и задвоенный
  // `QuestClockAdvanced` — самый дорогой сбой слоя — прошёл бы мимо сторожа.
  // У этой кампании открыто ровно одно задание с часами (цель главы), поэтому
  // ход мира выпускает один тик часов, один шаг и одну сводку памяти. Ход стоит
  // между небом и восстановлением костей; полное равенство ниже остаётся тем же
  // сторожем задвоенного события в контуре отдыха.
  const worldStep = ['QuestClockAdvanced', 'OffscreenWorldStepResolved', 'NarrativeSummaryRecorded']
  assert.ok(
    worldStep.every((type) => OFFSCREEN_STEP_EVENT_TYPES.has(type)),
    'ход мира выпускает только события из своего закрытого набора',
  )
  const restEventTypes = longRest.body.mechanics.map((event) => event.event_type)
  assert.deepEqual(
    restEventTypes,
    ['RestStarted', 'TimeAdvanced', ...sky, ...worldStep, 'HitPointDiceRestored', 'RestCompleted'],
  )
  assert.equal(longRest.body.authoritative_state.mechanics.world_time.elapsed_minutes, 540)
  assert.equal(longRest.body.authoritative_state.mechanics.hit_point_dice.fighter.spent, 0)
  assert.equal(longRest.body.authoritative_state.players.find((hero) => hero.id === 'fighter').hp, 30)

  await stopServer(child)
  child = null
  port = await freePort()
  baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const reopened = await request(baseUrl, '/api/rooms/HIT-DICE-API', { cookie: ownerCookie })
  assert.equal(reopened.status, 200, `${reopened.text}\n${logs}`)
  assert.equal(reopened.body.state.mechanics.world_time.elapsed_minutes, 540)
  assert.equal(reopened.body.state.mechanics.hit_point_dice.fighter.spent, 0)
  assert.equal(reopened.body.state.mechanics.hit_point_dice.wizard, undefined)
  const durableRetry = await restCommand(baseUrl, ownerCookie, 'rest-start-long', { command_type: 'StartRest', actor_id: 'fighter', kind: 'long' })
  assert.equal(durableRetry.status, 200, `${durableRetry.text}\n${logs}`)
  assert.equal(durableRetry.body.idempotent_replay, true)
  assert.equal(durableRetry.body.authoritative_state.mechanics.world_time.elapsed_minutes, 540)

  const secondShort = await restCommand(baseUrl, ownerCookie, 'rest-start-short-two', { command_type: 'StartRest', actor_id: 'fighter', kind: 'short' })
  assert.equal(secondShort.status, 200, `${secondShort.text}\n${logs}`)
  assert.equal(secondShort.body.authoritative_state.mechanics.world_time.elapsed_minutes, 600)
  const reusedSpendKey = await restCommand(baseUrl, ownerCookie, 'rest-spend-one', { command_type: 'SpendHitPointDie', actor_id: 'fighter' })
  assert.equal(reusedSpendKey.status, 409, reusedSpendKey.text)
  assert.equal(reusedSpendKey.body.code, 'IDEMPOTENCY_CONFLICT')
  const reusedCompleteKey = await restCommand(baseUrl, ownerCookie, 'rest-complete-short', { command_type: 'CompleteRest', actor_id: 'fighter' })
  assert.equal(reusedCompleteKey.status, 409, reusedCompleteKey.text)
  assert.equal(reusedCompleteKey.body.code, 'IDEMPOTENCY_CONFLICT')
  const secondCompleted = await restCommand(baseUrl, ownerCookie, 'rest-complete-short-two', { command_type: 'CompleteRest', actor_id: 'fighter' })
  assert.equal(secondCompleted.status, 200, `${secondCompleted.text}\n${logs}`)
  assert.equal(secondCompleted.body.authoritative_state.mechanics.resting.fighter, undefined)
})
