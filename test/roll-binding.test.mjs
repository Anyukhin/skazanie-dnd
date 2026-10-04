// Привязка механического броска к объявленной проверке (аудит PR #131, SEC-01).
//
// До исправления `/api/roll` без `check_id` выдавал «ничейный» серверный d20, а
// обычная проверка принимала его `roll_id`: игрок объявлял проверку один раз,
// бросал сколько угодно таких костей и подставлял лучшую. Здесь закреплено, что
// механическую проверку исполняет только кость, выданная под её карточку, —
// того же героя, той же проверки и ещё не потреблённая, — а повтор с тем же
// ключом по-прежнему возвращает прежний commit.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { RollRegistry } from '../server/roll-registry.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { freePort } from './free-port.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const SESSION = 'ROLL-BINDING'
const SETUP_TOKEN = 'roll-binding-setup'
const ACTION = 'Проверяю силу'
const OTHER_ACTION = 'Проверяю ловкость'

function fixtureState() {
  return {
    state_version: 0,
    sessionCode: SESSION,
    campaign: 'Привязка броска',
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

test('обычная проверка по HTTP исполняет только кость своей карточки', { timeout: runnerTimeout(60_000) }, async (t) => {
  const storage = mkdtempSync(join(tmpdir(), 'skazanie-roll-binding-'))
  let logs = ''
  let child = null
  t.after(async () => {
    await stopServer(child)
    rmSync(storage, { recursive: true, force: true })
  })
  const port = await freePort()
  const baseUrl = `http://127.0.0.1:${port}`
  child = startServer(port, storage, (chunk) => { logs += chunk })
  await waitForHealth(baseUrl, child, () => logs)

  const admin = await request(baseUrl, '/api/auth/setup-admin', {
    method: 'POST',
    body: { name: 'Мастер стенда', email: 'roll-binding-admin@example.test', password: 'RollBindingAdmin-2026!', setupToken: SETUP_TOKEN },
  })
  assert.equal(admin.status, 201, admin.text)
  const created = await request(baseUrl, '/api/campaigns', {
    method: 'POST', cookie: admin.cookie,
    body: { code: SESSION, name: 'Привязка броска', state: fixtureState() },
  })
  assert.equal(created.status, 201, `${created.text}\n${logs}`)
  const player = await request(baseUrl, '/api/auth/register', {
    method: 'POST',
    body: { name: 'Игрок стенда', email: 'roll-binding-player@example.test', password: 'RollBindingPlayer-2026!' },
  })
  assert.equal(player.status, 201, player.text)
  const users = await request(baseUrl, '/api/admin/users', { cookie: admin.cookie })
  const playerUser = users.body.users.find((candidate) => candidate.email === 'roll-binding-player@example.test')
  assert.ok(playerUser)
  const assigned = await request(baseUrl, `/api/admin/users/${playerUser.id}`, {
    method: 'PATCH', cookie: admin.cookie, body: { heroIds: ['hero-a'] },
  })
  assert.equal(assigned.status, 200, assigned.text)
  const playerCookie = player.cookie
  const narrate = (key, extra = {}, action = ACTION) => request(baseUrl, '/api/narrate', {
    method: 'POST', cookie: playerCookie,
    body: { campaignId: SESSION, actor_id: 'hero-a', action, idempotency_key: key, ...extra },
  })
  const roll = (body) => request(baseUrl, '/api/roll', {
    method: 'POST', cookie: playerCookie, body: { campaignId: SESSION, playerId: 'hero-a', ...body },
  })

  // Первая фаза: карточка обычной проверки, без commit.
  const offer = await narrate('binding-offer', { manual_roll: true })
  assert.equal(offer.status, 200, `${offer.text}\n${logs}`)
  assert.ok(offer.body.check?.check_id, `нет карточки проверки: ${offer.text}`)
  assert.deepEqual(offer.body.mechanics ?? [], [])
  const checkId = offer.body.check.check_id

  // Ничейная кость не выдаётся вовсе — серию «до хорошего» набрать нечем, и
  // параметры клиента (модификатор, СЛ) ничего не меняют.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const generic = await roll({ label: 'Проверка Силы', modifier: 12, difficulty: 5 })
    assert.equal(generic.status, 400, generic.text)
    assert.equal(generic.body.code, 'CHECK_REQUIRED')
    assert.equal(generic.body.roll_id, undefined)
  }

  // Кость, выданная под другую карточку того же героя, эту проверку не
  // исполняет и при отказе не сгорает.
  const otherOffer = await narrate('binding-other-offer', { manual_roll: true }, OTHER_ACTION)
  assert.equal(otherOffer.status, 200, `${otherOffer.text}\n${logs}`)
  assert.ok(otherOffer.body.check?.check_id)
  assert.notEqual(otherOffer.body.check.check_id, checkId)
  const otherRoll = await roll({ checkId: otherOffer.body.check.check_id })
  assert.equal(otherRoll.status, 200, otherRoll.text)
  const crossed = await narrate('binding-crossed', { roll: { roll_id: otherRoll.body.roll_id } })
  assert.equal(crossed.status, 400, crossed.text)
  assert.equal(crossed.body.code, 'ROLL_CONTEXT_MISMATCH')

  // Своя кость: повтор выдачи после потери ответа возвращает ту же кость, а не
  // новую попытку.
  const rolled = await roll({ checkId })
  assert.equal(rolled.status, 200, `${rolled.text}\n${logs}`)
  assert.equal((await roll({ checkId })).body.roll_id, rolled.body.roll_id)
  assert.equal(rolled.body.difficulty, offer.body.check.difficulty)
  assert.equal(rolled.body.modifier, offer.body.check.modifier)

  const resolved = await narrate('binding-resolve', { roll: { roll_id: rolled.body.roll_id } })
  assert.equal(resolved.status, 200, `${resolved.text}\n${logs}`)
  const ability = (resolved.body.mechanics ?? []).find((event) => event.event_type === 'AbilityCheckResolved')
  assert.ok(ability, `проверка не исполнилась: ${resolved.text}`)
  assert.equal(ability.payload.roll_id, rolled.body.roll_id)
  assert.equal(ability.payload.kept, rolled.body.value)
  assert.equal(ability.payload.player_rolled, true)

  // Повтор с тем же ключом — прежний commit; новый ключ с той же костью — отказ.
  const replay = await narrate('binding-resolve', { roll: { roll_id: rolled.body.roll_id } })
  assert.equal(replay.status, 200, replay.text)
  assert.equal(replay.body.idempotent_replay, true)
  const reused = await narrate('binding-reuse', { roll: { roll_id: rolled.body.roll_id } })
  assert.equal(reused.status, 400, reused.text)
  assert.equal(reused.body.code, 'ROLL_ALREADY_USED')

  // В журнале ровно одна проверка — от своей карточки и своего ключа.
  const checks = committedAbilityChecks(storage)
  assert.equal(checks.length, 1, JSON.stringify(checks))
  assert.equal(checks[0].idempotency_key, 'binding-resolve')
  assert.equal(checks[0].payload.roll_id, rolled.body.roll_id)
})

test('кость другой карточки того же героя обычной проверкой не становится', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-roll-binding-unit-'))
  try {
    const initial = normalizeCampaignState({
      sessionCode: SESSION,
      activePlayerId: 'hero',
      scene: { title: 'Зал', location: 'Старый трактир', objective: 'Осмотреть зал', cells: [] },
      players: [{
        id: 'hero', character: 'Ада', name: 'Ада', hp: 10, maxHp: 10, armor: 14,
        abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [],
      }],
    })
    const eventStore = new FileEventStore({
      rootDir: join(root, 'events'),
      reducer: applyGameEvent,
      normalizeState: normalizeCampaignState,
      idFactory: (() => { let id = 0; return () => `binding-event-${++id}` })(),
    })
    const registry = new RollRegistry({
      diceService: new DiceService({ rng: new SequenceDiceRng([20, 4]), idFactory: (() => { let id = 0; return () => `binding-roll-${++id}` })() }),
    })
    const orchestrator = new GameOrchestrator({
      rulesEngine: new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([11]) }) }),
      eventStore,
      narrator: { render: async () => ({ narration: 'Описание.', provider: 'deterministic-test' }) },
      rollRegistry: registry,
      idFactory: (() => { let id = 0; return () => `binding-turn-${++id}` })(),
    })
    await eventStore.initializeCampaign({ campaign_id: SESSION, initial_state: initial })
    const input = (key, extra = {}) => ({
      state: initial, campaignId: SESSION, playerId: 'hero', allowedActorIds: ['hero'],
      message: ACTION, idempotencyKey: key, ...extra,
    })

    // Карточка парлея того же героя: реестр сверит кампанию и актора, но
    // ветка обычной проверки обязана отказать по виду карточки.
    const parley = registry.registerCheck({ campaignId: SESSION, actorId: 'hero', label: 'Убеждение', difficulty: 10, context: { kind: 'parley' } })
    const parleyRoll = registry.issue({ checkId: parley.check_id, campaignId: SESSION, actorId: 'hero' })
    assert.equal(parleyRoll.kept, 20)
    const parleyVerified = registry.consume(parleyRoll.roll_id, { campaignId: SESSION, actorId: 'hero', idempotencyKey: 'binding-parley' })
    await assert.rejects(orchestrator.handle(input('binding-parley', { verifiedRoll: parleyVerified })), { code: 'ROLL_CONTEXT_MISMATCH' })
    assert.equal((await eventStore.load(SESSION)).state_version, 0, 'чужая кость не создаёт событий')

    // Своя карточка той же ветки исполняется выпавшей костью.
    const offer = await orchestrator.handle(input('binding-offer', { manualRoll: true }))
    assert.ok(offer.check?.check_id, JSON.stringify(offer))
    const own = registry.issue({ checkId: offer.check.check_id, campaignId: SESSION, actorId: 'hero' })
    const verifiedRoll = registry.consume(own.roll_id, { campaignId: SESSION, actorId: 'hero', idempotencyKey: 'binding-own' })
    const resolved = await orchestrator.handle(input('binding-own', { verifiedRoll }))
    const ability = (resolved.mechanics ?? []).find((event) => event.event_type === 'AbilityCheckResolved')
    assert.ok(ability, JSON.stringify(resolved.mechanics))
    assert.equal(ability.payload.roll_id, own.roll_id)
    assert.equal(ability.payload.kept, 4)
    assert.equal(ability.payload.player_rolled, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
