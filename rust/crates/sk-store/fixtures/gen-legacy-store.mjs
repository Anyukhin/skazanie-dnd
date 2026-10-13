// Эталон переноса: журнал прежнего FileEventStore с картами по хешу.
// Запуск: node rust/crates/sk-store/fixtures/gen-legacy-store.mjs
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileEventStore } from '../../../../server/event-store.mjs'
import { MapStore } from '../../../../server/map-store.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const rootDir = join(here, 'legacy-store')
rmSync(rootDir, { recursive: true, force: true })
const reducer = (state, event) => {
  const next = structuredClone(state)
  if (event.event_type === 'DamageApplied') next.hp = Math.max(0, Number(next.hp || 0) - Number(event.payload.amount || 0))
  if (event.event_type === 'HealingApplied') next.hp = Number(next.hp || 0) + Number(event.payload.amount || 0)
  return next
}
let id = 0
const store = new FileEventStore({
  rootDir, reducer, snapshotEvery: 2, mapStore: new MapStore({ rootDir }),
  idFactory: () => `fixture-${++id}`, clock: () => new Date('2026-10-13T12:00:00.000Z'),
})
const map = { width: 2, height: 1, cells: [{ x: 0, y: 0, terrain: 'floor' }, { x: 1, y: 0, terrain: 'wall' }] }
await store.initializeCampaign({ campaign_id: 'LEGACY-ONE', initial_state: { hp: 20, scene: { map, cells: [] } } })
for (const [index, amount] of [3, 4, 5].entries()) {
  await store.commit({
    campaign_id: 'LEGACY-ONE', expected_state_version: index, idempotency_key: `hit-${index}`,
    events: [{ event_type: 'DamageApplied', payload: { amount } }],
  })
}
await store.importLegacySnapshot({ campaign_id: 'LEGACY-TWO', legacy_state: { hp: 17 }, idempotency_key: 'legacy' })
await store.commit({ campaign_id: 'LEGACY-TWO', expected_state_version: 1, idempotency_key: 'heal', events: [{ event_type: 'HealingApplied', payload: { amount: 2 } }] })
const one = await store.load('LEGACY-ONE')
const two = await store.load('LEGACY-TWO')
console.log(JSON.stringify({ one: one.state, two: two.state }))
