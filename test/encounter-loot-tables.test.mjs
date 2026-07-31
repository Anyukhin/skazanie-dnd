import assert from 'node:assert/strict'
import test from 'node:test'

import { serverEncounterLoot, serverRewardForEncounter } from '../server/autonomous-campaign.mjs'
import { ENCOUNTER_THEMES } from '../server/encounter-assembler.mjs'
import {
  MAGIC_LOOT_CATALOG_IDS,
  planEncounterLootDistribution,
  serverEncounterCoins,
} from '../server/loot-tables.mjs'
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
    const mundane = loot.filter((item) => item.rarity === 'обычный' && item.catalog_id !== 'srd_5_2_1:potion-of-healing')
    assert.equal(mundane.length, 1, `${theme}: лёгкая встреча даёт ровно один тематический обычный предмет`)
  }
})

test('сложность увеличивает число обычных находок, зелий и шанс магической награды', () => {
  const easy = serverEncounterLoot({ theme: 'raiders', difficulty: 'easy', encounterId: 'x' })
  const medium = serverEncounterLoot({ theme: 'raiders', difficulty: 'medium', encounterId: 'x' })
  const hard = serverEncounterLoot({ theme: 'raiders', difficulty: 'hard', encounterId: 'x' })

  assert.equal(easy.filter((item) => item.catalog_id === 'srd_5_2_1:potion-of-healing').length, 0)
  assert.equal(medium.find((item) => item.catalog_id === 'srd_5_2_1:potion-of-healing').quantity, 1)
  assert.equal(hard.find((item) => item.catalog_id === 'srd_5_2_1:potion-of-healing').quantity, 2)
  const mundaneCount = (loot) => loot.filter((item) => item.rarity === 'обычный' && item.catalog_id !== 'srd_5_2_1:potion-of-healing').length
  assert.deepEqual([mundaneCount(easy), mundaneCount(medium), mundaneCount(hard)], [1, 2, 3])
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

test('все пятнадцать магических предметов реально достижимы в расширенной таблице', () => {
  const seen = new Set()
  for (let index = 0; index < 10_000 && seen.size < MAGIC_LOOT_CATALOG_IDS.length; index += 1) {
    for (const item of serverEncounterLoot({ theme: 'generic', difficulty: 'hard', encounterId: `magic-${index}` })) {
      if (MAGIC_LOOT_CATALOG_IDS.includes(item.catalog_id)) seen.add(item.catalog_id)
    }
  }
  assert.equal(MAGIC_LOOT_CATALOG_IDS.length, 15)
  assert.deepEqual([...seen].sort(), [...MAGIC_LOOT_CATALOG_IDS].sort())
})

test('монеты врагов бросаются детерминированно и масштабируются числом противников', () => {
  const first = serverEncounterCoins({ theme: 'goblinoids', difficulty: 'medium', encounterId: 'coins-1', enemyCount: 3 })
  const replay = serverEncounterCoins({ theme: 'goblinoids', difficulty: 'medium', encounterId: 'coins-1', enemyCount: 3 })
  const single = serverEncounterCoins({ theme: 'goblinoids', difficulty: 'medium', encounterId: 'coins-1', enemyCount: 1 })
  assert.deepEqual(first, replay)
  assert.equal(first.currency.gold, single.currency.gold * 3)
  assert.deepEqual(first.rolls[0].values.length, 3)
  assert.equal(first.rolls[0].expression, '3d6')
})

test('план дележа исключает погибших, делит вещи по кругу и сохраняет каждую медь', () => {
  const loot = serverEncounterLoot({ theme: 'warband', difficulty: 'hard', encounterId: 'split-1' })
  const coins = { copper: 3, silver: 2, gold: 7, platinum: 1 }
  const plan = planEncounterLootDistribution({
    encounterId: 'split-1',
    loot,
    coins,
    partyMemberIds: ['dead', 'a', 'b', 'c'],
    ineligibleActorIds: ['dead'],
  })
  assert.deepEqual(plan.map((entry) => entry.actor_id).sort(), ['a', 'b', 'c'])
  assert.equal(plan.some((entry) => entry.actor_id === 'dead'), false)
  assert.deepEqual(plan.flatMap((entry) => entry.items).map((item) => item.catalog_id).sort(), loot.map((item) => item.catalog_id).sort())
  const copper = (currency) => currency.copper + currency.silver * 10 + currency.gold * 100 + currency.platinum * 1_000
  assert.equal(plan.reduce((total, entry) => total + copper(entry.currency), 0), copper(coins))
  const shares = plan.map((entry) => copper(entry.currency))
  assert.ok(Math.max(...shares) - Math.min(...shares) <= 1)
  assert.deepEqual(plan, planEncounterLootDistribution({
    encounterId: 'split-1',
    loot,
    coins,
    partyMemberIds: ['dead', 'a', 'b', 'c'],
    ineligibleActorIds: ['dead'],
  }))
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
