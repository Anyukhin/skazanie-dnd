// Локальный probe раунда 12: только временный каталог и внедрённый генератор.
// Сетевых запросов, реального ключа и записи в storage репозитория здесь нет.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_PREPARATION_BATCH, planPreparation } from '../../../../server/asset-preparation.mjs'
import { NpcPortraitService, publicNpcPortraitProfile } from '../../../../server/npc-portraits.mjs'

const magicOnlyWebp = Buffer.from('524946460400000057454250', 'hex')

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'skazanie-asset-preparation-probe-'))
  try {
    const ready = Array.from({ length: MAX_PREPARATION_BATCH }, (_, index) => ({
      id: `npc:ready-${index}`,
      has_portrait: true,
    }))
    const pending = { id: 'npc:pending', has_portrait: false }
    const plan = planPreparation(
      { npc_ids: [...ready.map((entry) => entry.id), pending.id] },
      { npcs: [...ready, pending], locations: [] },
    )
    assert.equal(plan.code, 'BATCH_TOO_LARGE')

    let calls = 0
    const profile = publicNpcPortraitProfile({
      id: 'npc:race', name: 'Race', role: 'merchant', public_summary: 'Проба', tags: ['merchant'],
    })
    assert.ok(profile)
    const service = new NpcPortraitService({
      storageDir: root,
      imageModel: 'test/image-model',
      apiKey: 'loopback-stub',
      generator: async () => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 25))
        return { bytes: magicOnlyWebp, usage: { total_tokens: 1, cost: 0 } }
      },
    })
    await Promise.all([
      service.prepare({ campaignId: 'RACE', profile }),
      service.prepare({ campaignId: 'RACE', profile }),
    ])
    assert.equal(calls, 2)

    // Сигнатура из 12 байт принимается как готовый WebP и попадает в кеш.
    // Это synthetic stub: он показывает границу валидатора, а не внешний файл.
    const cached = await service.cached('RACE', profile.id)
    assert.ok(cached)
    assert.equal(cached.cacheHit, true)

    console.log(JSON.stringify({
      readyPlusPending: plan.code,
      concurrentPrepareCalls: calls,
      magicOnlyAccepted: true,
    }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
