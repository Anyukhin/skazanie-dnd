import assert from 'node:assert/strict'
import test from 'node:test'
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
  await createCampaign(admin, { code, state: {
    sessionCode: code, activePlayerId: 'brann', partyMemberIds: ['brann'],
    players: [{ id: 'brann', character: 'Бранн', hp: 15, maxHp: 15, armor: 12, abilities: { int: 18 }, inventory: [] }],
    scene: { title: 'Каменный архив', location: 'Каменный архив', turn: 1, cells: [{ x: 0, y: 0, type: 'floor', revealed: true }] },
  } })
  const { client: player } = await addPlayer(server, admin, code, { heroIds: ['brann'] })
  const before = await readJournal(server, code)
  const result = expectStatus(await player.post('/api/narrate', {
    campaign_id: code, actor_id: 'brann', action, idempotency_key: 'two-slow-roles', request_kind: 'action',
  }))

  assert.deepEqual(roles, ['judge', 'narrator'])
  assert.ok(narratorVersion > before.state_version, 'модель Рассказчика вызвана после commit')
  assert.equal(result.free_action_outcome, 'auto_success')
  assert.equal(result.verification?.origin?.source, 'llm', JSON.stringify(result.verification))
  assert.equal(result.narration, narration)
})
