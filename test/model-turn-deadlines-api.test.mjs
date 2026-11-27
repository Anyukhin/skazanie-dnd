import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { addPlayer, createCampaign, expectStatus, setupAdmin, startTestServer } from './kit/http.mjs'
import { chatCompletion, startFakeProvider } from './kit/llm.mjs'
import { readJournal } from './kit/journal.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

const code = 'ROLE-DEADLINES'
const action = 'Сверяю отражение на медной пластине с насечками, чтобы понять их порядок'
const narration = 'Бранн убирает ладонь. Из пустого прохода тянет прохладой.'
const model = 'test/slow-local'
const decision = {
  route: 'check', destination: '', npc_hint: '',
  goal_summary: 'Понять порядок насечек', approach_summary: 'Сравнивает отражение с насечками', obstacle: 'Линии трудно различить',
  activity_kind: 'routine', duration_class: 'brief', ability: 'int', skill: 'investigation', plausibility: 'trivial', risk: 'none',
  required_means: [], action_cost: 'action', effect: 'none', effect_target: '', hazard: '', prop_id: '', target_id: '', item_id: '',
  proficiency: 'none', consequence_type: 'time', success_detail: 'Различает порядок линий.', surface_detail: '', failure_detail: 'Блики закрывают насечки.',
}

function archiveState(heroes) {
  return {
    sessionCode: code, activePlayerId: 'brann', partyMemberIds: heroes.map(([id]) => id),
    players: heroes.map(([id, character]) => ({ id, character, hp: 15, maxHp: 15, armor: 12, abilities: { int: 18 }, inventory: [] })),
    scene: { title: 'Каменный архив', location: 'Каменный архив', turn: 1, cells: [{ x: 0, y: 0, type: 'floor', revealed: true }] },
  }
}

test('две роли отвечают по шесть секунд подряд, а Рассказчик видит сохранённый исход', { timeout: runnerTimeout(40_000) }, async (t) => {
  const roles = []
  let server
  let narratorVersion
  const provider = await startFakeProvider(t, async ({ path, body }, res) => {
    if (path !== '/chat/completions') return null
    const system = body.messages?.[0]?.content ?? ''
    if (system.includes('ROLE: Free Action Adjudicator')) {
      roles.push('judge')
      await delay(6_000)
      return chatCompletion(decision, { model })
    }
    if (!system.includes('ROLE: Narrator')) return null
    roles.push('narrator')
    narratorVersion = (await readJournal(server, code)).state_version
    await delay(6_000)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ model, choices: [{ delta: { content: narration } }] }) + '\n\n')
    res.end('data: [DONE]\n\n')
  })
  server = await startTestServer(t, {
    storagePrefix: 'skazanie-model-deadlines-',
    env: {
      ...provider.env,
      DND_AI_MODEL: model,
      DND_AI_FALLBACK_MODELS: model,
      DND_AI_MODEL_TIMEOUT_MS: '20000',
      DND_AI_TURN_TIMEOUT_MS: '2000',
      DND_AI_ADJUDICATOR_TIMEOUT_MS: '9000',
      DND_AI_NARRATOR_TIMEOUT_MS: '9000',
      DND_AI_LOCAL_RESERVE_MS: '5000',
    },
  })
  const { client: admin } = await setupAdmin(server)
  await createCampaign(admin, { code, state: archiveState([['brann', 'Бранн']]) })
  const { client: player } = await addPlayer(server, admin, code, { heroIds: ['brann'] })
  const before = await readJournal(server, code)
  const body = {
    campaign_id: code, actor_id: 'brann', action, idempotency_key: 'two-slow-roles', request_kind: 'action',
  }
  const [first, second] = (await Promise.all([player.post('/api/narrate', body), player.post('/api/narrate', body)])).map((response) => expectStatus(response))
  const [result, repeated] = first.idempotent_replay ? [second, first] : [first, second]

  assert.deepEqual(roles, ['judge', 'narrator'])
  assert.equal(repeated.idempotent_replay, true)
  assert.equal(repeated.narration_message_id, result.narration_message_id)
  assert.ok(narratorVersion > before.state_version, 'модель Рассказчика вызвана после commit')
  assert.equal(result.free_action_outcome, 'auto_success')
  assert.equal(result.verification?.origin?.source, 'llm', JSON.stringify(result.verification))
  assert.equal(result.narration_origin, 'model')
  assert.equal(result.narration, narration)
})

test('обрыв Рассказчика виден обоим игрокам и сохраняется с неизвестной суммой', { timeout: runnerTimeout(25_000) }, async (t) => {
  let startedNarrator = false
  const generationId = 'rai-archive-narrator-fixture'
  const provider = await startFakeProvider(t, async ({ path, body }, res) => {
    if (path !== '/chat/completions') return null
    const system = body.messages?.[0]?.content ?? ''
    if (system.includes('ROLE: Free Action Adjudicator')) {
      return chatCompletion(decision, { model, usage: { prompt_tokens: 18, completion_tokens: 4, total_tokens: 22, cost: 0.025 } })
    }
    if (!system.includes('ROLE: Narrator')) return null
    startedNarrator = true
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Generation-Id': generationId })
    res.flushHeaders()
    await delay(800)
    res.end('data: [DONE]\n\n')
  })
  const server = await startTestServer(t, {
    storagePrefix: 'skazanie-model-interrupted-',
    env: { ...provider.env, DND_AI_MODEL: model, DND_AI_FALLBACK_MODELS: model, DND_AI_NARRATOR_TIMEOUT_MS: '200' },
  })
  const { client: admin } = await setupAdmin(server)
  await createCampaign(admin, { code, state: archiveState([['brann', 'Бранн'], ['mira', 'Мира']]) })
  const { client: player } = await addPlayer(server, admin, code, { heroIds: ['brann'] })
  const { client: guest } = await addPlayer(server, admin, code, { heroIds: ['mira'] })
  const body = {
    campaign_id: code, actor_id: 'brann', action, idempotency_key: 'interrupted-narrator', request_kind: 'action',
  }
  const result = expectStatus(await player.post('/api/narrate', body))
  assert.ok(startedNarrator)
  assert.equal(result.narration_origin, 'interrupted', JSON.stringify(result.verification))
  assert.ok(result.narration_message_id)
  assert.ok(result.narration.trim())
  const traceFile = join(server.storageDir, 'turn-traces', code, result.turn_id + '.json')
  function checkTrace() {
    const trace = JSON.parse(readFileSync(traceFile, 'utf8'))
    assert.ok(trace.model_attempts.some((attempt) => attempt.role === 'narrator' && attempt.provider_generation_id === generationId), JSON.stringify(trace.model_attempts))
  }
  async function checkRoom() {
    for (const client of [player, guest]) {
      const room = expectStatus(await client.get('/api/rooms/' + code))
      const entry = room.state.messages.filter((message) => message.id === result.narration_message_id)
      assert.equal(entry.length, 1)
      assert.equal(entry[0].narrationOrigin, 'interrupted')
      assert.equal(entry[0].text, result.narration)
    }
  }
  await checkRoom()
  checkTrace()
  await server.restart()
  const repeated = expectStatus(await player.post('/api/narrate', body))
  assert.equal(repeated.idempotent_replay, true)
  assert.deepEqual(repeated.mechanics, result.mechanics)
  assert.equal(repeated.narration_origin, 'interrupted')
  assert.equal(repeated.narration_message_id, result.narration_message_id)
  const conflict = expectStatus(await player.post('/api/narrate', { ...body, action: 'Снимаю медную пластину' }), 409)
  assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT')
  await checkRoom()
  checkTrace()
  const { usage } = expectStatus(await admin.get('/api/admin/usage'))
  const ledger = JSON.parse(readFileSync(join(server.storageDir, 'engine', 'llm-usage.json'), 'utf8'))
  const entries = Object.values(ledger.requests)
  const aborted = entries.filter((entry) => entry.status === 'interrupted')
  assert.equal(aborted.length, 1)
  assert.equal(aborted[0].role, 'narrator')
  assert.equal(aborted[0].provider_cost, null)
  assert.equal(aborted[0].provider_generation_id, generationId)
  assert.equal(usage.interrupted_requests, 1)
  // Стартовые пробы провайдера также попадают в журнал и могут не сообщить цену.
  assert.equal(usage.unknown_cost_requests, entries.filter((entry) => entry.provider_cost === null).length)
  assert.equal(usage.confirmed_cost_requests, 1)
  assert.equal(usage.provider_cost, 0.025)
  assert.equal(usage.committed_tokens, 22)
  assert.ok(usage.reserved_tokens > 0)
})
