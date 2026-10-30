import assert from 'node:assert/strict'
import test from 'node:test'

import { appendJournal, createCampaign, readJournal, setupAdmin, startTestServer } from './kit/index.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

/**
 * Старое сохранение с мусором в реестрах открывается через HTTP
 * (`GET /api/rooms/:id`) и переживает restart — в обоих режимах сервера
 * (docs/rust-port-js-findings.md, «Исправлено (2026-10-26)»). Состояние
 * старой кампании попадает в журнал событием `LegacyStateImported` мимо
 * сервера (`appendJournal`), как перенос сохранения прежней версии.
 */

const CODE = 'OLDSAVE-1'

/** @param {any} state */
function withOldSaveJunk(state) {
  return {
    ...state,
    merchants: [null, ...(Array.isArray(state.merchants) ? state.merchants : [])],
    social: {
      ...(state.social ?? {}),
      npcs: [null, { id: 'npc-old', name: 'Старая Марта', role: 'трактирщица', location: 'Площадь' }, ...(state.social?.npcs ?? [])],
      conversations: [null],
      promises: [null, { id: 'promise-old', npc_id: 'npc-old', hero_id: 'hero-old', text: 'Вернусь нескоро', due_hint: 'нескоро', status: 'open' }],
    },
    worldMemory: {
      ...(state.worldMemory ?? {}),
      entities: [null, ...(state.worldMemory?.entities ?? [])],
      quests: [{ id: 'quest-old', title: 'Старая карта', clock: null }, ...(state.worldMemory?.quests ?? [])],
    },
    offscreen_world: { schema_version: 1, steps: [null] },
    captives: { schema_version: 1, captives: [null] },
    courier_letters: { schema_version: 1, letters: [null] },
    world_deeds: { schema_version: 1, deeds: [null] },
    law: { schema_version: 1, crimes: [null], cleared: {}, encounter: { id: 'guard-old', region_id: 'region-1', escape_attempts: '2' } },
  }
}

test('старое сохранение с null в реестрах открывается комнатой и переживает restart', { timeout: runnerTimeout(90_000) }, async (t) => {
  const server = await startTestServer(t, { storagePrefix: 'skazanie-old-save-api-' })
  const { client: gm } = await setupAdmin(server)
  await createCampaign(gm, { code: CODE, bootstrap: { partyName: 'Старый отряд', slotCount: 1, rulesetId: 'srd_5_2_1', world: {} } })

  await server.stop()
  const start = await readJournal(server, CODE)
  await appendJournal(server, CODE, {
    idempotency_key: 'old-save-import',
    command_id: 'old-save-import',
    events: [{
      event_type: 'LegacyStateImported',
      actor_id: 'system',
      target_ids: [],
      visibility: 'gm_only',
      source_rule_ids: [],
      payload: { state: withOldSaveJunk(start.state) },
    }],
  })
  await server.start()

  /** @param {any} room */
  const check = (room) => {
    const state = room.state
    assert.ok(state, 'комната отдаёт состояние')
    assert.ok((state.social?.npcs ?? []).every((/** @type {any} */ npc) => npc && npc.id && npc.name), 'в списке NPC нет пустых записей')
    assert.ok(state.social.npcs.some((/** @type {any} */ npc) => npc.id === 'npc-old'), 'NPC старого сохранения на месте')
    assert.equal((state.merchants ?? []).includes(null), false)
  }
  const first = await gm.get(`/api/rooms/${CODE}`)
  assert.equal(first.status, 200, first.text)
  check(first.body)

  const head = await readJournal(server, CODE)
  assert.equal(head.current_state_version, start.current_state_version + 1)
  assert.deepEqual(head.state.captives?.captives ?? [], [])
  assert.deepEqual(head.state.courier_letters?.letters ?? [], [])
  assert.deepEqual(head.state.offscreen_world?.steps ?? [], [])
  assert.deepEqual(head.state.world_deeds?.deeds ?? [], [])
  assert.deepEqual(head.state.law?.crimes ?? [], [])
  assert.equal(head.state.law?.encounter?.escape_attempts, 2)
  assert.equal(head.state.worldMemory.quests.find((/** @type {any} */ quest) => quest.id === 'quest-old')?.clock?.max, 4)

  await server.stop()
  await server.start()
  const again = await gm.get(`/api/rooms/${CODE}`)
  assert.equal(again.status, 200, again.text)
  check(again.body)
  const replayed = await readJournal(server, CODE, { useSnapshots: false })
  assert.deepEqual(replayed.state, head.state, 'replay журнала даёт то же состояние')
})
