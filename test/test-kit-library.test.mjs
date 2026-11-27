// Самопроверка частей набора `test/kit/`, которые опираются на JS-библиотеку
// `server/`: кости (`kit/dice.mjs`), движок и журнал JS (`kit/engine.mjs`),
// клиент модели JS против заглушки провайдера. Остальное — test-kit.test.mjs.
import assert from 'node:assert/strict'
import test from 'node:test'

import { RouterAIClient } from '../server/llm-client.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { dice, diceThen, fixedDice, maxDice, minDice } from './kit/dice.mjs'
import { applyAll, assertReplayMatches, commitEvents, createCampaignStore, createEngine, reopenStore } from './kit/engine.mjs'
import { chatCompletion, startFakeProvider } from './kit/llm.mjs'
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

// Подключение сервера к заглушке — контрактный случай `test-kit.test.mjs`
// «сервер подключается к локальному провайдеру набора»: здесь бинаря нет.
test('модель: локальный провайдер говорит протоколом RouterAI', { timeout: runnerTimeout(60_000) }, async (t) => {
  const provider = await startFakeProvider(t, (request) => {
    if (request.path === '/chat/completions') return chatCompletion({ verdict: 'ok', model: request.body.model })
    return null
  })
  assert.match(provider.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/u)
  const client = new RouterAIClient({ apiKey: 'kit-key', baseUrl: provider.baseUrl, model: 'kit/model' })
  assert.deepEqual(await client.completeJson({ messages: [{ role: 'user', content: 'проверка' }] }), { verdict: 'ok', model: 'kit/model' })
  assert.equal(provider.requests.at(-1).headers.authorization, 'Bearer kit-key')
})
