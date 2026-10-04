import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { planPreparation } from '../../../../server/asset-preparation.mjs'
import {
  LocationIllustrationService,
  locationIllustrationCacheLocation,
} from '../../../../server/location-illustrations.mjs'
import {
  NpcPortraitService,
  publicNpcPortraitProfile,
} from '../../../../server/npc-portraits.mjs'

// Синтетические payload с магической сигнатурой RIFF/WEBP: сервисы в этом
// контракте проверяют только сигнатуру, а не декодируют WebP codec. Сеть и
// настоящий provider для probe не нужны.
const SYNTHETIC_OLD = Buffer.from('52494646040000005745425000', 'hex')
const SYNTHETIC_NEW = Buffer.from('52494646050000005745425001', 'hex')

function npc(summary) {
  return publicNpcPortraitProfile({
    id: 'npc:cache-probe',
    name: 'Пробный NPC',
    role: 'merchant',
    public_summary: summary,
    tags: ['important'],
  })
}

function projected(profile) {
  return {
    social: {
      npcs: [profile],
      conversations: [],
      promises: [],
      relationships: {},
    },
    merchants: [],
  }
}

async function run() {
  const root = await mkdtemp(join(tmpdir(), 'skazanie-round12-image-cache-'))
  try {
    let npcCalls = 0
    const npcService = new NpcPortraitService({
      storageDir: root,
      imageModel: 'probe/image',
      apiKey: 'synthetic',
      generator: async () => ({ bytes: npcCalls++ === 0 ? SYNTHETIC_OLD : SYNTHETIC_NEW }),
    })
    const oldProfile = npc('Старое публичное описание')
    const newProfile = npc('Новое публичное описание')
    assert.ok(oldProfile && newProfile)

    const first = await npcService.resolve({
      campaignId: 'CACHE-PROBE',
      profile: oldProfile,
      projectedState: projected(oldProfile),
    })
    const afterChange = await npcService.resolve({
      campaignId: 'CACHE-PROBE',
      profile: newProfile,
      projectedState: projected(newProfile),
    })
    assert.equal(first.kind, 'generated')
    assert.equal(afterChange.kind, 'generated')
    assert.equal(afterChange.cacheHit, true)
    assert.equal(npcCalls, 1, 'изменение публичного описания не должно теряться за старым cache hit')
    assert.equal((await readFile(first.filePath)).equals(SYNTHETIC_OLD), true)

    let locationCalls = 0
    let release
    const barrier = new Promise((resolve) => { release = resolve })
    const locationService = new LocationIllustrationService({
      storageDir: root,
      imageModel: 'probe/image',
      apiKey: 'synthetic',
      generator: async () => {
        const marker = locationCalls++
        await barrier
        return { bytes: marker === 0 ? SYNTHETIC_OLD : SYNTHETIC_NEW }
      },
    })
    const oldLocation = {
      id: 'loc:cache-probe', name: 'Старое место', summary: 'Старое описание', kind: 'ruin', source: 'world_memory',
    }
    const sameLocation = { ...oldLocation }
    const changedLocation = { ...oldLocation, name: 'Новое место', summary: 'Новое описание' }
    const oldKey = locationIllustrationCacheLocation(locationService.cacheRoot, 'CACHE-PROBE', oldLocation.id).key
    const newKey = locationIllustrationCacheLocation(locationService.cacheRoot, 'CACHE-PROBE', changedLocation.id).key
    assert.equal(oldKey, newKey, 'location cache key is id-only')

    const firstPreparation = locationService.prepare({ campaignId: 'CACHE-PROBE', location: oldLocation })
    const secondPreparation = locationService.prepare({ campaignId: 'CACHE-PROBE', location: sameLocation })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(locationCalls, 2, 'concurrent same-location prepare calls are not deduplicated')
    release()
    await Promise.all([firstPreparation, secondPreparation])
    const locationPath = locationIllustrationCacheLocation(locationService.cacheRoot, 'CACHE-PROBE', oldLocation.id).filePath
    const finalBytes = await readFile(locationPath)
    assert.ok(finalBytes.equals(SYNTHETIC_OLD) || finalBytes.equals(SYNTHETIC_NEW))
    assert.equal((await locationService.cached('CACHE-PROBE', oldLocation.id))?.cacheHit, true)
    const locationDirectory = locationIllustrationCacheLocation(locationService.cacheRoot, 'CACHE-PROBE', oldLocation.id).directory
    assert.deepEqual((await readdir(locationDirectory)).filter((name) => name.endsWith('.tmp')), [])

    const plan = planPreparation(
      { location_ids: [changedLocation.id] },
      { locations: [{ id: changedLocation.id, has_illustration: true }] },
    )
    assert.deepEqual(plan.location_ids, [], 'ready flag skips changed location unless regenerate=true')

    process.stdout.write(JSON.stringify({
      stale_npc: {
        generator_calls: npcCalls,
        cache_hit_after_public_change: afterChange.cacheHit,
        served_bytes: (await readFile(first.filePath)).equals(SYNTHETIC_OLD) ? 'old' : 'unexpected',
      },
      concurrent_location_prepare: {
        generator_calls: locationCalls,
        final_file_cache_accepted: (await locationService.cached('CACHE-PROBE', oldLocation.id))?.cacheHit === true,
        changed_location_skipped_without_regenerate: plan.location_ids.length === 0,
      },
    }, null, 2) + '\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await run()
