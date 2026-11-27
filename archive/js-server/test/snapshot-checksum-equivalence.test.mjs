import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileEventStore } from '../server/event-store.mjs'

test('контрольная сумма снимка совпадает с f074372 после преобразования входа в JSON', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-checksum-contract-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const store = new FileEventStore({ rootDir, reducer: (state) => state, clock: () => new Date('2026-09-16T00:00:00Z') })
  await store.initializeCampaign({ campaign_id: 'checksum-contract', initial_state: {
    z: null, '10': 'ten', '2': 'two', a: { text: 'Сказание', array: [{ z: 2, a: 1 }, null, -0], odd: [NaN, Infinity] },
    time: new Date('2020-01-01T00:00:00Z'),
  } })
  const { snapshot } = await store.createSnapshot('checksum-contract')
  // Получено неизменённым FileEventStore из эталонного коммита, а не новой функцией хеширования.
  assert.equal(snapshot.checksum, 'aaebf12cd3875243513f5413aafe709fb4fd01bdc6c495905f515edae0a36fa1')
  assert.deepEqual((await store.replay('checksum-contract')).state, snapshot.state)
})
