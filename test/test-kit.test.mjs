// Самопроверка общего тестового набора `test/kit/`. Если набор сломается,
// здесь это видно раньше, чем в десятках тестов, которые на него опираются.
import assert from 'node:assert/strict'
import test from 'node:test'

import { RouterAIClient } from '../server/llm-client.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import {
  DEFAULT_SETUP_TOKEN,
  addPlayer,
  applyAll,
  assertReplayMatches,
  chatCompletion,
  commitEvents,
  createCampaign,
  createCampaignStore,
  createClient,
  createEngine,
  dice,
  diceThen,
  expectStatus,
  fixedDice,
  forbiddenLlm,
  isolatedServerEnv,
  maxDice,
  minDice,
  reopenStore,
  scriptedLlm,
  sendCommand,
  setupAdmin,
  startFakeProvider,
  startTestServer,
} from './kit/index.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const hero = (id, x) => ({
  id, name: `Игрок ${id}`, character: `Герой ${id}`, hp: 20, maxHp: 20, armor: 14, speed: 30, proficiency: 2,
  abilities: { str: 14, dex: 14, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], online: true, x, y: 0,
})

const campaignState = (code) => ({
  sessionCode: code, campaign: code, partyName: 'Отряд', partyMemberIds: ['hero-1', 'hero-2'], activePlayerId: 'hero-1',
  isNarrating: false, pendingCheck: null, suggestions: [], messages: [],
  players: [hero('hero-1', 0), hero('hero-2', 1)],
  enemies: [],
  scene: {
    title: 'Привал', location: 'Привал', mood: 'Тихо', objective: 'Проверка набора', turn: 1,
    cells: [0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => ({ x, y, type: 'floor', revealed: true }))),
  },
  adventure: { chapter: 1, history: [], visitedLocations: ['Привал'] },
  engine_mode: 'enforce',
})

// Сетевая часть isolatedServerEnv проверяется в test/test-network-isolation.test.mjs.
test('env сервера: стандартный блок, хранилище и порт только от набора, undefined снимает переменную', () => {
  const base = { port: 1, storageDir: 'storage-dir', setupToken: 'token' }
  const env = isolatedServerEnv({ ...base, env: { DND_COMBAT_TURN_TIMEOUT_MS: '3600000', DND_AI_MODEL: undefined } })
  assert.deepEqual(
    [env.AGENT_HOST, env.AGENT_PORT, env.DND_STORAGE_DIR, env.ADMIN_SETUP_TOKEN, env.COOKIE_SECURE, env.NODE_ENV, env.DND_COMBAT_TURN_TIMEOUT_MS],
    ['127.0.0.1', '1', 'storage-dir', 'token', 'false', 'test', '3600000'],
  )
  assert.equal('DND_AI_MODEL' in env, false)
  assert.throws(() => isolatedServerEnv({ ...base, env: { DND_STORAGE_DIR: 'elsewhere' } }), /storageDir/u)
})

test('HTTP: сервер, администратор, кампания, игрок по приглашению и restart', { timeout: runnerTimeout(60_000) }, async (t) => {
  const server = await startTestServer(t)
  assert.equal(server.setupToken, DEFAULT_SETUP_TOKEN)
  const health = expectStatus(await createClient(server).get('/api/health'))
  assert.equal(health.configured, false, 'без заглушки провайдера модель не настроена')

  const admin = await setupAdmin(server)
  assert.equal(admin.user.role, 'admin')
  const created = await createCampaign(admin.client, { code: 'KIT-SELF', state: campaignState('KIT-SELF') })
  assert.equal(created.state.sessionCode, 'KIT-SELF')

  const player = await addPlayer(server, admin.client, 'KIT-SELF', { heroIds: ['hero-2'] })
  assert.deepEqual(player.heroIds, ['hero-2'])
  const room = expectStatus(await player.client.get('/api/rooms/KIT-SELF'))
  assert.ok(room.state.players.some((entry) => entry.id === 'hero-2'))

  const outsider = createClient(server)
  assert.equal((await outsider.get('/api/rooms/KIT-SELF')).status, 401, 'без сессии комната закрыта')

  const foreign = await sendCommand(player.client, 'KIT-SELF', 'kit-foreign-move', { command_type: 'MoveActor', actor_id: 'hero-1', to: { x: 2, y: 2 } })
  assert.equal(foreign.status, 403, 'чужим героем игрок не ходит')

  const versionBefore = room.state.state_version
  const childBefore = server.child
  await server.restart()
  assert.notEqual(server.child, childBefore, 'restart поднимает новый процесс')
  assert.equal(server.baseUrl, `http://127.0.0.1:${server.port}`)
  const afterRestart = expectStatus(await player.client.get('/api/rooms/KIT-SELF'))
  assert.equal(afterRestart.state.state_version, versionBefore, 'restart на том же хранилище сохраняет кампанию и сессию')
  assert.match(server.output(), /\S/u, 'вывод сервера накапливается')

  // stop/start — окно, в котором тест читает хранилище напрямую.
  await server.stop()
  assert.equal(server.child, null)
  await server.start()
  await assert.rejects(server.start(), /уже запущен/u)
  const raw = await player.client.fetch('/api/rooms/KIT-SELF')
  assert.equal(raw.status, 200, 'fetch несёт cookie клиента')
  await raw.arrayBuffer()
})

test('кости: последовательность, отказ на лишнем броске, крайние значения, id и время', () => {
  const sequence = dice([3, 17], { prefix: 'kit', now: '2026-01-01T00:00:00.000Z' })
  const first = sequence.rollD20({ purpose: 'check', actorId: 'hero' })
  assert.equal(first.kept, 3)
  assert.equal(first.roll_id, 'kit-1')
  assert.equal(first.created_at, '2026-01-01T00:00:00.000Z')
  assert.equal(sequence.roll('1d20', 'check', 'hero').total, 17)
  assert.throws(() => sequence.roll('1d6', 'check', 'hero'), /закончилась/u)
  assert.throws(() => dice([7]).roll('1d6', 'check', 'hero'), /диапазон/u)

  assert.equal(maxDice().roll('2d6', 'damage', 'hero').total, 12)
  assert.equal(minDice().roll('2d6', 'damage', 'hero').total, 2)
  assert.equal(fixedDice(15).roll('1d20', 'check', 'hero').total, 15)
  assert.equal(fixedDice(15).roll('1d6', 'check', 'hero').total, 6, 'значение прижимается к грани')
  const tail = diceThen([20], 1)
  assert.deepEqual([tail.roll('1d20', 'a', 'h').total, tail.roll('1d20', 'b', 'h').total, tail.roll('1d8', 'c', 'h').total], [20, 1, 1])
})

test('движок: команда → события → журнал, replay с нуля совпадает с головой', async (t) => {
  const initial = normalizeCampaignState({ ...campaignState('KIT-ENGINE'), mechanics: { world_time: { elapsed_minutes: 0 } } })
  const store = await createCampaignStore(t, 'KIT-ENGINE', initial)
  const engine = createEngine([])
  let expected = (await store.load('KIT-ENGINE')).state
  for (const amount of [10, 50]) {
    const result = engine.resolve({ command_type: 'AdvanceTime', actor_id: 'hero-1', amount, unit: 'minute', server_authoritative: true }, expected, { isAdmin: true })
    assert.ok(result.events.length > 0)
    await commitEvents(store, 'KIT-ENGINE', result.events)
    expected = applyAll(expected, result.events)
  }
  const head = await assertReplayMatches(store, 'KIT-ENGINE', { expected })
  assert.equal(head.mechanics.world_time.elapsed_minutes, 60)
  assert.equal((await reopenStore(store).load('KIT-ENGINE')).current_state_version, (await store.load('KIT-ENGINE')).current_state_version)

  // Тот же resolveCommand напрямую — с костями из набора.
  const direct = resolveCommand({ command_type: 'AdvanceTime', actor_id: 'hero-1', amount: 1, unit: 'minute', server_authoritative: true }, head, { diceService: dice([]), context: { isAdmin: true } })
  assert.equal(applyAll(head, direct.events).mechanics.world_time.elapsed_minutes, 61)
})

test('модель: scriptedLlm отвечает по очереди, записывает вызовы и не терпит лишних', async () => {
  const llm = scriptedLlm([{ ok: 1 }, new Error('сбой'), (input) => ({ echo: input.messages.length })])
  assert.deepEqual(await llm.completeJson({ messages: [] }, { timeoutMs: 5 }), { ok: 1 })
  await assert.rejects(llm.completeJson({ messages: [] }), /сбой/u)
  assert.deepEqual(await llm.completeJson({ messages: [{ role: 'user', content: 'x' }] }), { echo: 1 })
  await assert.rejects(llm.completeJson({ messages: [] }), (error) => error.code === 'LLM_UNEXPECTED_CALL')
  assert.equal(llm.calls.length, 4)
  assert.deepEqual(llm.calls[0].options, { timeoutMs: 5 })

  const steady = scriptedLlm([], { fallback: { narration: 'тишина' } })
  assert.deepEqual(await steady.completeJson({}), { narration: 'тишина' })
  assert.equal((await steady.complete({})).json.narration, 'тишина')
  assert.equal((await scriptedLlm(['текст']).complete({})).content, 'текст')
  await assert.rejects(forbiddenLlm().completeJson({}), (error) => error.code === 'LLM_FORBIDDEN')
})

test('модель: локальный провайдер говорит протоколом RouterAI и подключается к серверу', { timeout: runnerTimeout(60_000) }, async (t) => {
  const provider = await startFakeProvider(t, (request) => {
    if (request.path === '/chat/completions') return chatCompletion({ verdict: 'ok', model: request.body.model })
    return null
  })
  assert.match(provider.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/u)
  const client = new RouterAIClient({ apiKey: 'kit-key', baseUrl: provider.baseUrl, model: 'kit/model' })
  assert.deepEqual(await client.completeJson({ messages: [{ role: 'user', content: 'проверка' }] }), { verdict: 'ok', model: 'kit/model' })
  assert.equal(provider.requests.at(-1).headers.authorization, 'Bearer kit-key')

  const server = await startTestServer(t, { env: { ...provider.env, DND_AI_MODEL: 'kit/model', DND_AI_FALLBACK_MODELS: '' } })
  const health = expectStatus(await createClient(server).get('/api/health'))
  assert.equal(health.configured, true, 'сервер видит ключ заглушки')
  assert.equal(health.model, 'kit/model')
})
