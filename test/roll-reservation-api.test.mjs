// Резерв броска вокруг commit (аудит PR #131, SEC-04).
//
// `/api/narrate` потребляет `roll_id` в реестре раньше, чем ход фиксируется в
// журнале. До исправления несостоявшийся commit оставлял кость помеченной: новый
// ключ получал `ROLL_ALREADY_USED`, хотя ни одного события с этой костью не
// было, и объявленная проверка оставалась без исхода. Здесь по настоящему HTTP
// проверены три точки сбоя: отказ commit, остановка процесса до commit и
// остановка после commit. Во всех трёх кость исполняет ровно одну проверку.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { freePort } from './free-port.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const COMMIT_FAULT_PRELOAD = pathToFileURL(fileURLToPath(new URL('./fixtures/fail-commit-once.mjs', import.meta.url))).href
const SESSION = 'ROLL-RESERVATION'
const SETUP_TOKEN = 'roll-reservation-setup'
const ACTION = 'Проверяю силу'

function fixtureState() {
  return {
    state_version: 0,
    sessionCode: SESSION,
    campaign: 'Резерв броска',
    activePlayerId: 'hero-a',
    isNarrating: false,
    pendingCheck: null,
    suggestions: [],
    messages: [],
    players: [{
      id: 'hero-a', character: 'Герой', name: 'Герой', hp: 10, maxHp: 10,
      armor: 14, proficiency: 2,
      abilities: { str: 16, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
      inventory: [], online: true,
    }],
    enemies: [],
    scene: { title: 'Проба', location: 'Площадь', mood: '', objective: '', turn: 0, cells: [] },
    mechanics: { world_time: { elapsed_minutes: 0 } },
    social: { npcs: [], relationships: {}, conversations: [], promises: [] },
    ruleset_id: 'srd_5_2_1', ruleset_version: '5.2.1',
    enabled_rule_packs: ['srd_5_2_1'], engine_mode: 'enforce',
  }
}

function startServer(port, storage, faults, appendLog) {
  const child = spawn(process.execPath, [
    '--import', COMMIT_FAULT_PRELOAD,
    'server/index.mjs',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENT_HOST: '127.0.0.1',
      AGENT_PORT: String(port),
      DND_STORAGE_DIR: storage,
      DND_COMMIT_FAULTS: faults,
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

async function waitForExit(child) {
  if (child.exitCode != null) return child.exitCode
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)))
}

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
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
  try { parsed = text ? JSON.parse(text) : null } catch { /* в сообщение уходит сырой текст */ }
  return { status: response.status, body: parsed, text, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' }
}

/** Все `AbilityCheckResolved` из файлов журнала событий кампании. */
function committedAbilityChecks(storage) {
  const campaignsRoot = join(storage, 'engine', 'campaigns')
  return readdirSync(campaignsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const eventsDir = join(campaignsRoot, entry.name, 'events')
      return readdirSync(eventsDir).filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(eventsDir, name), 'utf8')))
    })
    .flatMap((commit) => (commit.events ?? []).map((event) => ({ ...event, idempotency_key: commit.idempotency_key })))
    .filter((event) => event.event_type === 'AbilityCheckResolved')
}

test('несостоявшийся commit возвращает бросок, состоявшийся закрепляет его за ключом', { timeout: runnerTimeout(120_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-roll-reservation-'))
  let logs = ''
  let child = null
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const boot = async (faults) => {
    await stopServer(child)
    child = startServer(port, storage, faults, (chunk) => { logs += chunk })
    await waitForHealth(baseUrl, child, () => logs)
  }
  await boot('reservation-fail:throw,reservation-crash:exit-before')

  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Мастер стенда', email: 'roll-reservation-admin@example.test', password: 'RollReservationAdmin-2026!', setupToken: SETUP_TOKEN },
  })
  assert.equal(admin.status, 201, admin.text)
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: admin.cookie,
    body: { code: SESSION, name: 'Резерв броска', state: fixtureState() },
  })
  assert.equal(created.status, 201, `${created.text}\n${logs}`)
  const player = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Игрок стенда', email: 'roll-reservation-player@example.test', password: 'RollReservationPlayer-2026!' },
  })
  assert.equal(player.status, 201, player.text)
  const users = await request(baseUrl, '/api/admin/users', { cookie: admin.cookie })
  const playerUser = users.body.users.find((candidate) => candidate.email === 'roll-reservation-player@example.test')
  assert.ok(playerUser)
  const assigned = await request(baseUrl, `/api/admin/users/${playerUser.id}`, {
    method: 'PATCH', cookie: admin.cookie, body: { heroIds: ['hero-a'] },
  })
  assert.equal(assigned.status, 200, assigned.text)
  const playerCookie = player.cookie
  const narrate = (key, extra = {}) => request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: playerCookie,
    body: { campaignId: SESSION, actor_id: 'hero-a', action: ACTION, idempotency_key: key, ...extra },
  })
  const declareAndRoll = async (offerKey) => {
    const offer = await narrate(offerKey, { manual_roll: true })
    assert.equal(offer.status, 200, `${offer.text}\n${logs}`)
    assert.ok(offer.body.check?.check_id, `нет карточки проверки: ${offer.text}`)
    const rolled = await request(baseUrl, '/api/roll', {
      method: 'POST', cookie: playerCookie,
      body: { campaignId: SESSION, playerId: 'hero-a', checkId: offer.body.check.check_id },
    })
    assert.equal(rolled.status, 200, `${rolled.text}\n${logs}`)
    return rolled.body
  }
  const assertResolvedWith = (response, roll) => {
    assert.equal(response.status, 200, `${response.text}\n${logs}`)
    const ability = (response.body.mechanics ?? []).find((event) => event.event_type === 'AbilityCheckResolved')
    assert.ok(ability, `проверка не исполнилась: ${response.text}`)
    assert.equal(ability.payload.roll_id, roll.roll_id)
    assert.equal(ability.payload.kept, roll.value, 'та же кость, без переброса')
  }

  // 1. Commit отклонён: кость возвращается и исполняет проверку под новым
  // ключом — ровно один раз.
  const first = await declareAndRoll('reservation-offer-1')
  const failed = await narrate('reservation-fail', { roll: { roll_id: first.roll_id } })
  assert.notEqual(failed.status, 200, failed.text)
  assert.equal(committedAbilityChecks(storage).length, 0, 'отказ commit не оставил событий')
  assertResolvedWith(await narrate('reservation-retry', { roll: { roll_id: first.roll_id } }), first)
  const third = await narrate('reservation-third', { roll: { roll_id: first.roll_id } })
  assert.equal(third.status, 400, third.text)
  assert.equal(third.body.code, 'ROLL_ALREADY_USED')

  // 2. Процесс остановлен между consume и commit: после перезапуска резерв
  // осиротевший, и кость исполняет проверку под новым ключом.
  const second = await declareAndRoll('reservation-offer-2')
  await assert.rejects(narrate('reservation-crash', { roll: { roll_id: second.roll_id } }))
  assert.equal(await waitForExit(child), 70)
  await boot('reservation-after:exit-after')
  assertResolvedWith(await narrate('reservation-crash-retry', { roll: { roll_id: second.roll_id } }), second)

  // 3. Процесс остановлен после commit: перезапуск резерв не снимает. Другой
  // ключ получает отказ, тот же ключ — прежний commit.
  const last = await declareAndRoll('reservation-offer-3')
  await assert.rejects(narrate('reservation-after', { roll: { roll_id: last.roll_id } }))
  assert.equal(await waitForExit(child), 71)
  await boot('')
  const other = await narrate('reservation-after-other', { roll: { roll_id: last.roll_id } })
  assert.equal(other.status, 400, other.text)
  assert.equal(other.body.code, 'ROLL_ALREADY_USED')
  const replay = await narrate('reservation-after', { roll: { roll_id: last.roll_id } })
  assertResolvedWith(replay, last)
  assert.equal(replay.body.idempotent_replay, true)

  // В журнале ровно по одной проверке на кость.
  const checks = committedAbilityChecks(storage)
  assert.deepEqual(
    checks.map((event) => [event.idempotency_key, event.payload.roll_id]),
    [['reservation-retry', first.roll_id], ['reservation-crash-retry', second.roll_id], ['reservation-after', last.roll_id]],
  )
})
