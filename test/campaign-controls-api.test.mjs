import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { addPlayer, appendJournal, createCampaign, createClient, readJournal, registerUser, setupAdmin, startTestServer } from './kit/index.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Откат ведущего и жизненный цикл кампании через HTTP (`server/index.mjs`,
 * маршруты `POST /api/campaigns/:id/controls` и `GET`/`POST
 * /api/campaigns/:id/lifecycle`): права владельца, обязательный ключ отката,
 * детерминированные `event_id`, повтор и конфликт ключа, принудительный снимок
 * отката, сводка финала (`NarrativeSummaryRecorded`), replay после restart.
 *
 * Игровые ходы дописываются в журнал мимо сервера (`appendJournal`): тест
 * трогает только маршруты кампаний, отката и жизненного цикла.
 */

const CODE = 'CTRL-1'

/** @param {string} text */
const digest = (text) => createHash('sha256').update(text).digest('hex').slice(0, 24)

/** Ход отряда в журнале: урон по герою. */
function damage(heroId, before, after) {
  return {
    event_type: 'DamageApplied',
    actor_id: 'enemy-1',
    target_ids: [heroId],
    visibility: 'party',
    source_rule_ids: [],
    payload: { hp_before: before, hp_after: after, applied_amount: before - after, temporary_hp_after: 0 },
  }
}

/** @param {any} state @param {string} heroId */
const hpOf = (state, heroId) => state.players.find((/** @type {any} */ player) => player.id === heroId)?.hp

test('откат хода и сцены: только владелец, ключ обязателен, event_id детерминирован, повтор и конфликт ключа, replay после restart', { timeout: runnerTimeout(90_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-controls-api-' })
  const { client: gm } = await setupAdmin(server)
  const { client: owner, user: ownerUser } = await registerUser(server, { name: 'Владелец' })
  const created = await createCampaign(owner, { code: CODE, bootstrap: { partyName: 'Двое', slotCount: 2, rulesetId: 'srd_5_2_1', world: {} } })
  const [ownerHero, guestHero] = created.state.partyMemberIds
  const { client: guest } = await addPlayer(server, owner, CODE, { heroIds: [guestHero] })
  const { client: outsider } = await registerUser(server, { name: 'Чужой' })
  const anonymous = createClient(server)
  const path = `/api/campaigns/${CODE}/controls`

  // Права и форма запроса.
  const unauthenticated = await anonymous.post(path, { action: 'rewind_turn', idempotency_key: 'anon' })
  assert.equal(unauthenticated.status, 401, unauthenticated.text)
  const missing = await owner.post('/api/campaigns/NOPE-1/controls', { action: 'rewind_turn', idempotency_key: 'nope' })
  assert.deepEqual([missing.status, missing.body], [404, { error: 'Кампания не найдена' }])
  for (const client of [guest, outsider]) {
    const denied = await client.post(path, { action: 'rewind_turn', idempotency_key: 'denied' })
    assert.deepEqual([denied.status, denied.body], [403, { error: 'Откатывать ход или сцену может только владелец кампании' }])
  }
  const noKey = await owner.post(path, { action: 'rewind_turn', idempotency_key: '   ' })
  assert.deepEqual([noKey.status, noKey.body], [400, { error: 'Нужен idempotency_key', code: 'IDEMPOTENCY_KEY_REQUIRED' }])
  const unknown = await owner.post(path, { action: 'undo_everything', idempotency_key: 'unknown-action' })
  assert.deepEqual([unknown.status, unknown.body], [400, { error: 'Неизвестное действие ведущего: undo_everything', code: 'INVALID_CAMPAIGN_CONTROL' }])
  const nothing = await owner.post(path, { action: 'rewind_turn', idempotency_key: 'too-early' })
  assert.deepEqual([nothing.status, nothing.body.code], [409, 'NOTHING_TO_REWIND'], nothing.text)
  const nothingScene = await owner.post(path, { action: 'replay_scene', idempotency_key: 'too-early-scene' })
  assert.deepEqual([nothingScene.status, nothingScene.body.code], [409, 'NOTHING_TO_REPLAY'], nothingScene.text)

  // Два хода отряда мимо сервера.
  await server.stop()
  const start = await readJournal(server, CODE)
  const fullHp = hpOf(start.state, ownerHero)
  assert.ok(fullHp > 3, `у героя есть хиты: ${fullHp}`)
  await appendJournal(server, CODE, { idempotency_key: 'turn-1', command_id: 'turn-1', events: [damage(ownerHero, fullHp, fullHp - 1)] })
  await appendJournal(server, CODE, { idempotency_key: 'turn-2', command_id: 'turn-2', events: [damage(ownerHero, fullHp - 1, fullHp - 3)] })
  await server.start()
  const head = start.current_state_version + 2

  // Откат хода: ключ из заголовка, длинный ключ обрезается до 200 символов.
  const longKey = `rewind-${'k'.repeat(250)}`
  const rewound = await owner.post(path, { action: ' rewind_turn ' }, { idempotencyKey: longKey })
  assert.equal(rewound.status, 200, rewound.text)
  assert.equal(rewound.body.campaign_id, CODE)
  assert.equal(rewound.body.action, 'rewind_turn')
  assert.equal(rewound.body.target_version, head - 1)
  assert.equal(rewound.body.duplicate, false)
  assert.equal(typeof rewound.body.version, 'number')
  assert.equal(rewound.body.state.state_version, head + 1)
  assert.equal(hpOf(rewound.body.state, ownerHero), fullHp - 1, 'урон второго хода отменён')
  assert.equal(rewound.body.state.isNarrating, false)

  await server.stop()
  const afterRewind = await readJournal(server, CODE)
  const rewindCommit = afterRewind.commits.at(-1)
  assert.equal(rewindCommit?.idempotency_key, longKey.slice(0, 200))
  assert.deepEqual(rewindCommit?.events.map((/** @type {any} */ event) => event.event_type), ['CampaignRewound'])
  const rewindEvent = rewindCommit?.events[0]
  assert.equal(rewindEvent.event_id, `campaign-control:${digest(`${CODE}\0${longKey.slice(0, 200)}`)}`)
  assert.equal(rewindEvent.actor_id, ownerUser.id)
  assert.deepEqual(rewindEvent.source_rule_ids, ['campaign.control.rewind.v1'])
  assert.deepEqual([rewindEvent.payload.action, rewindEvent.payload.target_version, rewindEvent.payload.rewound_from_version], ['rewind_turn', head - 1, head])
  const replayed = await readJournal(server, CODE, { useSnapshots: false })
  assert.deepEqual(replayed.state, afterRewind.state, 'replay без снимков даёт то же состояние')
  await server.start()

  // Повтор ключа — тот же откат; ключ с другим действием — конфликт.
  const repeated = await owner.post(path, { action: 'rewind_turn', idempotency_key: longKey })
  assert.equal(repeated.status, 200, repeated.text)
  assert.deepEqual([repeated.body.duplicate, repeated.body.target_version, repeated.body.state.state_version], [true, head - 1, head + 1])
  const conflict = await owner.post(path, { action: 'replay_scene', idempotency_key: longKey })
  assert.deepEqual([conflict.status, conflict.body], [409, { error: 'Этот idempotency_key уже использован для другого действия кампании', code: 'IDEMPOTENCY_CONFLICT' }])
  const foreignKey = await owner.post(path, { action: 'rewind_turn', idempotency_key: 'turn-1' })
  assert.deepEqual([foreignKey.status, foreignKey.body.code], [409, 'IDEMPOTENCY_CONFLICT'], 'ключ игрового хода — не ключ отката')

  // Отменённый ход второй раз не откатывается: следующий откат снимает первый ход.
  const second = await owner.post(path, { action: 'rewind_turn', idempotency_key: 'rewind-2' })
  assert.equal(second.status, 200, second.text)
  assert.equal(second.body.target_version, head - 2)
  assert.equal(hpOf(second.body.state, ownerHero), fullHp)
  const exhausted = await owner.post(path, { action: 'rewind_turn', idempotency_key: 'rewind-3' })
  assert.deepEqual([exhausted.status, exhausted.body.code], [409, 'NOTHING_TO_REWIND'], exhausted.text)

  // Переигрывание сцены администратором: новый ход и возврат к началу сцены.
  await server.stop()
  const beforeScene = await readJournal(server, CODE)
  await appendJournal(server, CODE, { idempotency_key: 'turn-3', command_id: 'turn-3', events: [damage(ownerHero, fullHp, fullHp - 2)] })
  await server.start()
  const scene = await gm.post(path, { action: 'replay_scene', idempotency_key: 'scene-1' })
  assert.equal(scene.status, 200, scene.text)
  assert.equal(scene.body.action, 'replay_scene')
  assert.equal(typeof scene.body.target_version, 'number')
  assert.ok(scene.body.target_version < beforeScene.current_state_version + 1)
  assert.equal(scene.body.state.state_version, beforeScene.current_state_version + 2)
  assert.equal(hpOf(scene.body.state, ownerHero), fullHp)

  // Состояние после отката переживает перезапуск.
  await server.restart()
  await server.stop()
  const restarted = await readJournal(server, CODE)
  assert.equal(restarted.current_state_version, beforeScene.current_state_version + 2)
  assert.equal(restarted.commits.at(-1)?.events[0].event_id, `campaign-control:${digest(`${CODE}\0scene-1`)}`)
  assert.deepEqual((await readJournal(server, CODE, { useSnapshots: false })).state, restarted.state)
  await server.start()
  const afterRestart = await owner.post(path, { action: 'replay_scene', idempotency_key: 'scene-1' })
  assert.deepEqual([afterRestart.status, afterRestart.body.duplicate], [200, true], afterRestart.text)

  // Строка запроса и другой метод — не этот маршрут.
  const withQuery = await owner.post(`${path}?x=1`, { action: 'rewind_turn', idempotency_key: 'query' })
  assert.deepEqual([withQuery.status, withQuery.body.code], [409, 'NOTHING_TO_REWIND'], 'маршрут сравнивает pathname')
  const wrongMethod = await owner.get(path)
  assert.deepEqual([wrongMethod.status, wrongMethod.body], [404, { error: 'API endpoint не найден' }])
})

test('жизненный цикл: чтение участникам, переходы только владельцу, повтор ключа, финал со сводкой, откат не пересекает финал', { timeout: runnerTimeout(90_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-lifecycle-api-' })
  const { client: gm } = await setupAdmin(server)
  const { client: owner, user: ownerUser } = await registerUser(server, { name: 'Владелец' })
  const created = await createCampaign(owner, { code: CODE, name: 'Сказ о мосте', bootstrap: { partyName: 'Двое', slotCount: 2, rulesetId: 'srd_5_2_1', world: {} } })
  const [, guestHero] = created.state.partyMemberIds
  const { client: guest } = await addPlayer(server, owner, CODE, { heroIds: [guestHero] })
  const { client: outsider } = await registerUser(server, { name: 'Чужой' })
  const anonymous = createClient(server)
  const path = `/api/campaigns/${CODE}/lifecycle`

  assert.equal((await anonymous.get(path)).status, 401)
  assert.deepEqual(await owner.get('/api/campaigns/NOPE-1/lifecycle').then((r) => [r.status, r.body]), [404, { error: 'Кампания не найдена' }])
  assert.deepEqual(await outsider.get(path).then((r) => [r.status, r.body]), [403, { error: 'Нет доступа к этой кампании' }])
  const read = await guest.get(`${path}?view=1`)
  assert.equal(read.status, 200, read.text)
  assert.equal(read.body.campaign_id, CODE)
  assert.equal(read.body.lifecycle.status, 'active')

  assert.equal((await anonymous.post(path, { action: 'pause' })).status, 401)
  assert.deepEqual(await owner.post('/api/campaigns/NOPE-1/lifecycle', { action: 'pause' }).then((r) => [r.status, r.body]), [404, { error: 'Кампания не найдена' }])
  for (const client of [guest, outsider]) {
    const denied = await client.post(path, { action: 'pause' })
    assert.deepEqual([denied.status, denied.body], [403, { error: 'Управлять жизненным циклом может только владелец кампании' }])
  }
  const invalid = await owner.post(path, { action: 'resume', idempotency_key: 'resume-active' })
  assert.deepEqual([invalid.status, invalid.body], [409, { error: 'Переход lifecycle "active" → "resume" запрещён', code: 'INVALID_CAMPAIGN_TRANSITION' }])
  const failed = await owner.post(path, { action: 'fail', idempotency_key: 'fail-1' })
  assert.deepEqual([failed.status, failed.body.code], [400, 'CAMPAIGN_FAILURE_NOT_CONFIRMED'], failed.text)

  // Пауза с причиной; повтор ключа отдаёт тот же коммит.
  const paused = await owner.post(path, { action: 'PAUSE', reason: 'перерыв на чай', idempotency_key: 'pause-1' })
  assert.equal(paused.status, 200, paused.text)
  assert.deepEqual([paused.body.campaign_id, paused.body.lifecycle.status, paused.body.lifecycle.reason], [CODE, 'paused', 'перерыв на чай'])
  assert.equal(typeof paused.body.version, 'number')
  assert.equal(paused.body.state.mechanics.campaign_lifecycle.status, 'paused')
  const pausedAgain = await owner.post(path, { action: 'pause' }, { idempotencyKey: 'pause-1' })
  assert.equal(pausedAgain.status, 200, pausedAgain.text)
  assert.deepEqual(pausedAgain.body.lifecycle, paused.body.lifecycle)
  assert.equal(pausedAgain.body.state.state_version, paused.body.state.state_version)
  // Без ключа — новый ключ на каждый запрос.
  const resumed = await gm.post(path, { action: 'resume' })
  assert.equal(resumed.status, 200, resumed.text)
  assert.equal(resumed.body.lifecycle.status, 'active')

  // Ход отряда, затем финал: событие кампании и сводка с детерминированными id.
  await server.stop()
  const beforeTurn = await readJournal(server, CODE)
  const [ownerHero] = created.state.partyMemberIds
  const hp = hpOf(beforeTurn.state, ownerHero)
  await appendJournal(server, CODE, { idempotency_key: 'turn-1', command_id: 'turn-1', events: [damage(ownerHero, hp, hp - 1)] })
  await server.start()
  const completed = await owner.post(path, { action: 'complete', idempotency_key: 'finale' })
  assert.equal(completed.status, 200, completed.text)
  assert.equal(completed.body.lifecycle.status, 'completed')
  await server.stop()
  const finale = await readJournal(server, CODE)
  const commit = finale.commits.at(-1)
  assert.equal(commit?.idempotency_key, 'finale')
  assert.deepEqual(commit?.events.map((/** @type {any} */ event) => event.event_type), ['CampaignCompleted', 'NarrativeSummaryRecorded'])
  const [completion, summary] = commit?.events ?? []
  const lifecycleId = `campaign-lifecycle:${digest(`${CODE}\0finale`)}`
  assert.equal(completion.event_id, lifecycleId)
  assert.equal(completion.actor_id, ownerUser.id)
  assert.equal(summary.event_id, `session-summary:${digest(`${CODE}\0finale\0summary`)}`)
  assert.equal(summary.actor_id, ownerUser.id)
  assert.equal(summary.visibility, 'party')
  const record = summary.payload.summary
  assert.equal(record.id, `campaign-summary:${digest(`${CODE}\0finale`)}`)
  assert.equal(record.kind, 'session')
  assert.equal(record.title, beforeTurn.state.campaign)
  assert.equal(record.summary, String(completion.payload.epilogue || completion.payload.reason).slice(0, 2000))
  assert.deepEqual(record.source_event_ids, [lifecycleId])
  assert.equal(record.source_command_id, 'campaign-lifecycle:finale')
  assert.equal(typeof record.recorded_at_minutes, 'number')
  assert.deepEqual((await readJournal(server, CODE, { useSnapshots: false })).state, finale.state)
  await server.start()

  // Финал — жёсткая граница: откатить нечего; кампания только для чтения, но архивируется.
  const rewind = await owner.post(`/api/campaigns/${CODE}/controls`, { action: 'rewind_turn', idempotency_key: 'after-finale' })
  assert.deepEqual([rewind.status, rewind.body.code], [409, 'NOTHING_TO_REWIND'], rewind.text)
  const repeatedFinale = await owner.post(path, { action: 'complete', idempotency_key: 'finale' })
  assert.equal(repeatedFinale.status, 200, repeatedFinale.text)
  assert.equal(repeatedFinale.body.lifecycle.status, 'completed')
  const archived = await owner.post(path, { action: 'archive', idempotency_key: 'archive-1' })
  assert.equal(archived.status, 200, archived.text)
  assert.equal(archived.body.lifecycle.status, 'archived')
  await server.restart()
  const after = await guest.get(path)
  assert.deepEqual([after.status, after.body.lifecycle.status], [200, 'archived'], after.text)
})
