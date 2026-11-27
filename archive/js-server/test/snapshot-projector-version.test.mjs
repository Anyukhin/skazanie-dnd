import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileEventStore } from '../server/event-store.mjs'

test('a projector version change replays events instead of trusting a stale derived snapshot', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-projector-version-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const legacyReducer = (state) => structuredClone(state)
  const legacyStore = new FileEventStore({
    rootDir,
    reducer: legacyReducer,
    snapshotEvery: 1,
    snapshotProjectorVersion: 1,
  })
  await legacyStore.initializeCampaign({ campaign_id: 'migration', initial_state: { experience: 0 } })
  await legacyStore.commit({
    campaign_id: 'migration',
    expected_state_version: 0,
    idempotency_key: 'award-xp',
    events: [{ event_type: 'ExperienceAwarded', payload: { amount: 75 } }],
  })

  const campaignDirectory = join(rootDir, 'campaigns', readdirSync(join(rootDir, 'campaigns'))[0])
  const snapshot = JSON.parse(readFileSync(join(campaignDirectory, 'snapshots', '0000000000000001.json'), 'utf8'))
  assert.equal(snapshot.projector_version, 1)
  assert.equal(snapshot.state.experience, 0)

  const currentReducer = (state, event) => {
    const next = structuredClone(state)
    if (event.event_type === 'ExperienceAwarded') next.experience += event.payload.amount
    return next
  }
  const reopened = new FileEventStore({
    rootDir,
    reducer: currentReducer,
    snapshotEvery: 1,
    snapshotProjectorVersion: 2,
  })
  const restored = await reopened.replay('migration')

  assert.equal(restored.state.experience, 75)
  assert.equal(restored.state_version, 1)
  assert.equal(restored.events_applied, 1)
})
