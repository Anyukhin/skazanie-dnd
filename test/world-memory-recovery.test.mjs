import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FileEventStore } from '../server/event-store.mjs'
import { MapStore } from '../server/map-store.mjs'
import { applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { normalizeWorldMemoryLegacy } from '../server/world-memory.mjs'
import { recoverWorldMemory } from '../tools/recover-world-memory.mjs'

function entities(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `npc:recovery-${index}`, kind: 'npc', name: `Recovery NPC ${index}`, visibility: 'gm_only',
  }))
}

function legacyNormalize(state) {
  const normalized = normalizeCampaignState(state)
  return { ...normalized, worldMemory: normalizeWorldMemoryLegacy(normalized.worldMemory) }
}

test('проект восстановления не меняет источник и показывает добавления текущей проекции', async (t) => {
  const source = mkdtempSync(join(tmpdir(), 'skazanie-recovery-source-'))
  const output = join(mkdtempSync(join(tmpdir(), 'skazanie-recovery-output-root-')), 'preview')
  t.after(() => {
    rmSync(source, { recursive: true, force: true })
    rmSync(join(output, '..'), { recursive: true, force: true })
  })
  const initialState = {
    scene: {
      title: 'Archive', location: 'Archive', cells: [],
      map: { width: 1, height: 1, cells: [{ x: 0, y: 0, type: 'floor', revealed: true }] },
    },
    worldMemory: { entities: entities(500) },
  }
  const legacyStore = new FileEventStore({
    rootDir: source, reducer: applyGameEvent, normalizeState: legacyNormalize,
    snapshotEvery: 1, snapshotProjectorVersion: 14, reducerVersion: 14, mapStore: new MapStore({ rootDir: source }),
  })
  await legacyStore.initializeCampaign({ campaign_id: 'recovery', initial_state: initialState })
  await legacyStore.commit({
    campaign_id: 'recovery', expected_state_version: 0, idempotency_key: 'tail',
    events: [{ event_type: 'WorldEntityUpserted', payload: { entity: entities(501).at(-1) } }],
  })
  const campaignDirectory = join(source, 'campaigns', readdirSync(join(source, 'campaigns'))[0])
  const snapshotFile = join(campaignDirectory, 'snapshots', '0000000000000001.json')
  const sourceSnapshot = readFileSync(snapshotFile, 'utf8')

  const manifest = await recoverWorldMemory({ source, campaign: 'recovery', output })
  assert.equal(manifest.source_unchanged, true)
  assert.equal(manifest.legacy_reducer_version, 14)
  assert.equal(manifest.recovered_reducer_version, 15)
  assert.ok(manifest.diff.world_memory.entities.added_ids.includes('npc:recovery-500'))
  assert.ok(Array.isArray(manifest.diff.world_memory.entities.changed_ids))
  assert.ok(manifest.diff.roots.changed_roots.includes('worldMemory'))
  assert.equal(typeof manifest.diff.roots.has_unexpected_root_differences, 'boolean')
  assert.equal(manifest.artifact_kind, 'read-only-preview')
  assert.equal(manifest.source_backup_not_created, true)
  assert.equal(manifest.backup_required_before_apply, true)
  assert.equal(readFileSync(snapshotFile, 'utf8'), sourceSnapshot)
  assert.equal(JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8')).schema_version, 'world-memory-recovery/v1')
  const recoveredState = JSON.parse(readFileSync(join(output, 'recovered_state.json'), 'utf8'))
  assert.ok(recoveredState.worldMemory.entities.some((entry) => entry.id === 'npc:recovery-500'))
  assert.equal(recoveredState.scene.map?.marker, undefined, 'в preview карта должна быть восстановлена из MapStore, а не оставаться ссылкой')
  assert.equal(recoveredState.scene.map?.width, 1)
})

test('проверка восстановления не создаёт ошибочный источник и не пишет в его подпапки', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-recovery-paths-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const missing = join(root, 'missing')
  await assert.rejects(recoverWorldMemory({ source: missing, campaign: 'test', output: join(root, 'preview') }), /не существует/u)
  assert.equal(existsSync(missing), false)
  const inside = join(root, '..preview')
  await assert.rejects(recoverWorldMemory({ source: root, campaign: 'test', output: inside }), /внутри исходного/u)
  assert.equal(existsSync(inside), false)
})
