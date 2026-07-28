import assert from 'node:assert/strict'
import test from 'node:test'

import { serverEncounterLoot, serverRewardForEncounter } from '../server/autonomous-campaign.mjs'
import { ENCOUNTER_THEMES } from '../server/encounter-assembler.mjs'
import { SRD_EQUIPMENT_CATALOG } from '../server/merchant-economy.mjs'

/**
 * Сторож ссылочной целостности. Он же ловит дефект, который жил в таблице до
 * 2026-07-28: добыча выдавала `srd_5_2_1:healing-potion`, а в каталоге лежит
 * `srd_5_2_1:potion-of-healing`. Торговец не узнавал собственное зелье и
 * оценивал его политикой вместо каталожной цены.
 */
test('каждый предмет добычи существует в каталоге снаряжения', () => {
  for (const theme of ENCOUNTER_THEMES) {
    for (const difficulty of ['easy', 'medium', 'hard']) {
      for (const encounterId of ['e-1', 'e-2', 'e-3', 'e-4', 'e-5']) {
        for (const item of serverEncounterLoot({ theme, difficulty, encounterId })) {
          assert.ok(
            Object.hasOwn(SRD_EQUIPMENT_CATALOG, item.catalog_id),
            `${theme}/${difficulty}: предмета ${item.catalog_id} нет в каталоге`,
          )
          assert.ok(item.name, `${theme}/${difficulty}: у предмета нет имени`)
          assert.ok(item.type, `${theme}/${difficulty}: у предмета нет типа`)
          assert.ok(Number.isSafeInteger(item.quantity) && item.quantity > 0)
        }
      }
    }
  }
})

test('у каждой темы встреч есть собственная таблица добычи', () => {
  for (const theme of ENCOUNTER_THEMES) {
    const loot = serverEncounterLoot({ theme, difficulty: 'easy', encounterId: 'coverage' })
    assert.equal(loot.length, 1, `${theme}: лёгкая встреча даёт ровно один тематический предмет`)
  }
})

test('сложность решает только число зелий, тема — предмет', () => {
  const easy = serverEncounterLoot({ theme: 'raiders', difficulty: 'easy', encounterId: 'x' })
  const medium = serverEncounterLoot({ theme: 'raiders', difficulty: 'medium', encounterId: 'x' })
  const hard = serverEncounterLoot({ theme: 'raiders', difficulty: 'hard', encounterId: 'x' })

  assert.equal(easy.filter((item) => item.catalog_id === 'srd_5_2_1:potion-of-healing').length, 0)
  assert.equal(medium.find((item) => item.catalog_id === 'srd_5_2_1:potion-of-healing').quantity, 1)
  assert.equal(hard.find((item) => item.catalog_id === 'srd_5_2_1:potion-of-healing').quantity, 2)
  // Тематический предмет один и тот же: сложность его не меняет.
  const flavour = (loot) => loot.find((item) => item.catalog_id !== 'srd_5_2_1:potion-of-healing').catalog_id
  assert.equal(flavour(easy), flavour(medium))
  assert.equal(flavour(medium), flavour(hard))
})

test('выбор детерминирован по encounter_id и различается между встречами', () => {
  const first = serverEncounterLoot({ theme: 'raiders', difficulty: 'easy', encounterId: 'encounter-a' })
  assert.deepEqual(first, serverEncounterLoot({ theme: 'raiders', difficulty: 'easy', encounterId: 'encounter-a' }))

  const seen = new Set()
  for (let index = 0; index < 40; index += 1) {
    seen.add(serverEncounterLoot({ theme: 'raiders', difficulty: 'easy', encounterId: `encounter-${index}` })[0].catalog_id)
  }
  assert.ok(seen.size >= 3, `добыча однообразна: за 40 встреч выпало вариантов ${seen.size}`)
})

test('поражение по-прежнему не выдаёт добычу', () => {
  const reward = serverRewardForEncounter({
    mechanics: { encounter: { id: 'encounter-lost', difficulty: 'hard', theme: 'warband', xp_spent: 200 } },
    enemies: [{ provenance: { xp: 200 } }],
  }, 'party_defeated')
  assert.deepEqual(reward.loot, [])
  assert.equal(reward.xp, 0)
})

test('награда за победу учитывает тему встречи', () => {
  const reward = serverRewardForEncounter({
    mechanics: { encounter: { id: 'encounter-won', difficulty: 'medium', theme: 'warband', xp_spent: 100 } },
    enemies: [{ provenance: { xp: 100 } }],
  }, 'enemies_defeated')
  assert.equal(reward.xp, 100)
  assert.deepEqual(reward.loot, serverEncounterLoot({ theme: 'warband', difficulty: 'medium', encounterId: 'encounter-won' }))
})
