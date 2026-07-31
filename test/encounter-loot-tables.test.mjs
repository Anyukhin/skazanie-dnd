import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ENCOUNTER_LOOT_POLICY_ID,
  LOOT_BY_THEME,
  serverEncounterLoot,
} from '../server/loot-tables.mjs'
import {
  ITEM_CATALOG,
  ITEM_CATALOG_SCHEMA_VERSION,
  ITEM_LOOT_CATALOG_IDS,
} from '../server/item-catalog.mjs'

const prefix = (values) => values.map((value) => `srd_5_2_1:${value}`)
const EXPECTED_LOOT_IDS = prefix([
  'arrows-20', 'battleaxe', 'bolts-20', 'chain-shirt', 'club', 'dagger', 'dart',
  'greataxe', 'greatclub', 'handaxe', 'healers-kit', 'hide-armor', 'javelin',
  'leather-armor', 'light-crossbow', 'longsword', 'mace', 'quarterstaff',
  'rations-one-day', 'ring-mail', 'rope-hempen-50-feet', 'shield', 'shortbow',
  'shortsword', 'sickle', 'sling', 'sling-bullets-20', 'spear', 'torch', 'war-pick',
])

const EXPECTED_POOLS = {
  goblinoids: prefix(['dagger', 'shortbow', 'arrows-20', 'javelin', 'shield', 'leather-armor', 'spear', 'torch', 'rations-one-day', 'chain-shirt']),
  undead: prefix(['mace', 'ring-mail', 'dagger', 'shortbow', 'arrows-20', 'shield', 'shortsword', 'torch', 'rope-hempen-50-feet']),
  beasts: prefix(['spear', 'javelin', 'shortbow', 'arrows-20', 'hide-armor', 'rope-hempen-50-feet', 'rations-one-day', 'healers-kit', 'torch', 'quarterstaff']),
  raiders: prefix(['dagger', 'handaxe', 'javelin', 'shortsword', 'light-crossbow', 'bolts-20', 'leather-armor', 'shield', 'rations-one-day', 'rope-hempen-50-feet', 'healers-kit', 'sickle', 'greataxe', 'chain-shirt']),
  warband: prefix(['battleaxe', 'chain-shirt', 'greataxe', 'shield', 'longsword', 'mace', 'ring-mail', 'spear', 'light-crossbow', 'bolts-20', 'healers-kit']),
  vermin: prefix(['club', 'dagger', 'sling', 'sling-bullets-20', 'torch', 'rations-one-day', 'rope-hempen-50-feet']),
  ambush: prefix(['dagger', 'dart', 'shortbow', 'arrows-20', 'light-crossbow', 'bolts-20', 'shortsword', 'leather-armor', 'rope-hempen-50-feet', 'healers-kit']),
  crypt: prefix(['mace', 'ring-mail', 'dagger', 'rope-hempen-50-feet', 'torch', 'shortbow', 'arrows-20', 'shield', 'shortsword']),
  cave: prefix(['club', 'greatclub', 'spear', 'javelin', 'war-pick', 'sling', 'sling-bullets-20', 'torch', 'rope-hempen-50-feet', 'rations-one-day', 'hide-armor', 'chain-shirt']),
  wilderness: prefix(['rations-one-day', 'rope-hempen-50-feet', 'torch', 'shortbow', 'arrows-20', 'spear', 'javelin', 'handaxe', 'dagger', 'healers-kit', 'hide-armor', 'quarterstaff', 'sickle']),
  generic: prefix(['rations-one-day', 'rope-hempen-50-feet', 'torch', 'dart', 'ring-mail', 'sling', 'dagger', 'arrows-20', 'club', 'chain-shirt', 'bolts-20', 'battleaxe', 'handaxe', 'healers-kit', 'hide-armor', 'javelin', 'leather-armor', 'light-crossbow', 'longsword', 'mace', 'quarterstaff', 'shield', 'shortbow', 'shortsword', 'sickle', 'sling-bullets-20', 'spear', 'war-pick', 'greataxe', 'greatclub']),
}

test('loot allowlist и тематические пулы совпадают с bounded контрактом v2', () => {
  assert.equal(ENCOUNTER_LOOT_POLICY_ID, 'encounter-loot-v2')
  assert.deepEqual([...ITEM_LOOT_CATALOG_IDS].sort(), [...EXPECTED_LOOT_IDS].sort())
  assert.equal(ITEM_LOOT_CATALOG_IDS.length, 30)
  assert.deepEqual(LOOT_BY_THEME, EXPECTED_POOLS)
  assert.deepEqual(new Set(Object.values(LOOT_BY_THEME).flat()), new Set(EXPECTED_LOOT_IDS))
})

test('каждая ссылка loot существует, verified/partial и не открывает magic/ruling/crafting', () => {
  for (const catalogId of ITEM_LOOT_CATALOG_IDS) {
    const entry = ITEM_CATALOG[catalogId]
    assert.ok(entry, catalogId)
    assert.ok(['verified', 'partial'].includes(entry.mechanics_status), catalogId)
    assert.equal(entry.availability.loot, true, catalogId)
    assert.equal(entry.availability.crafting, false, catalogId)
    assert.notEqual(entry.type, 'magic-item', catalogId)
    assert.notEqual(entry.mechanics_status, 'ruling-only', catalogId)
  }
  assert.equal(ITEM_LOOT_CATALOG_IDS.some((id) => /potion|ring-of|longsword-plus|wand-of/u.test(id)), false)
})

test('difficulty даёт 1/2/3 уникальных stack и easy IDs являются prefix medium/hard', () => {
  for (const theme of Object.keys(EXPECTED_POOLS)) {
    for (let index = 0; index < 80; index += 1) {
      const encounterId = `${theme}-${index}`
      const easy = serverEncounterLoot({ theme, difficulty: 'easy', encounterId })
      const medium = serverEncounterLoot({ theme, difficulty: 'medium', encounterId })
      const hard = serverEncounterLoot({ theme, difficulty: 'hard', encounterId })
      assert.equal(easy.length, 1, theme)
      assert.equal(medium.length, 2, theme)
      assert.equal(hard.length, 3, theme)
      const ids = (loot) => loot.map((item) => item.catalog_id)
      assert.deepEqual(ids(medium).slice(0, 1), ids(easy), `${theme}/${encounterId}`)
      assert.deepEqual(ids(hard).slice(0, 2), ids(medium), `${theme}/${encounterId}`)
      assert.equal(new Set(ids(hard)).size, hard.length)
    }
  }
})

test('price tier выбирается точно, а fallback идёт только вниз', () => {
  const tiers = [[0, 500], [501, 2_500], [2_501, 7_500]]
  for (const [theme, pool] of Object.entries(EXPECTED_POOLS)) {
    for (let index = 0; index < 80; index += 1) {
      const loot = serverEncounterLoot({ theme, difficulty: 'hard', encounterId: `tier-${index}` })
      const used = new Set()
      loot.forEach((item, tierIndex) => {
        const price = ITEM_CATALOG[item.catalog_id].base_price_cp
        const exactAvailable = pool.some((catalogId) => {
          const candidatePrice = ITEM_CATALOG[catalogId].base_price_cp
          return !used.has(catalogId) && candidatePrice >= tiers[tierIndex][0] && candidatePrice <= tiers[tierIndex][1]
        })
        if (exactAvailable) assert.ok(price >= tiers[tierIndex][0] && price <= tiers[tierIndex][1], `${theme}/${tierIndex}/${price}`)
        else assert.ok(price <= tiers[tierIndex][1], `${theme}/${tierIndex}/${price}`)
        used.add(item.catalog_id)
      })
    }
  }
})

test('quantity policy bounded для supplies/ammunition, hard ≤9 единиц и ≤54 lb', () => {
  const supplies = new Set(prefix(['torch', 'rations-one-day']))
  const ammunition = new Set(prefix(['arrows-20', 'bolts-20', 'sling-bullets-20']))
  const expectedSupply = { easy: 1, medium: 2, hard: 3 }
  const expectedAmmo = { easy: 1, medium: 1, hard: 2 }
  for (const theme of Object.keys(EXPECTED_POOLS)) {
    for (const difficulty of ['easy', 'medium', 'hard']) {
      for (let index = 0; index < 120; index += 1) {
        const loot = serverEncounterLoot({ theme, difficulty, encounterId: `quantity-${index}` })
        for (const item of loot) {
          const expected = supplies.has(item.catalog_id)
            ? expectedSupply[difficulty]
            : ammunition.has(item.catalog_id)
              ? expectedAmmo[difficulty]
              : 1
          assert.equal(item.quantity, expected, `${theme}/${difficulty}/${item.catalog_id}`)
        }
        if (difficulty === 'hard') {
          assert.ok(loot.reduce((sum, item) => sum + item.quantity, 0) <= 9)
          assert.ok(loot.reduce((sum, item) => sum + item.quantity * item.weight, 0) <= 54)
        }
      }
    }
  }
})

test('loot детерминирован и materialize берёт canonical catalog fields', () => {
  const first = serverEncounterLoot({ theme: 'raiders', difficulty: 'hard', encounterId: 'same-id' })
  assert.deepEqual(first, serverEncounterLoot({ theme: 'raiders', difficulty: 'hard', encounterId: 'same-id' }))
  for (const item of first) {
    const catalog = ITEM_CATALOG[item.catalog_id]
    assert.equal(item.catalog_schema_version, ITEM_CATALOG_SCHEMA_VERSION)
    assert.equal(item.name, catalog.name)
    assert.equal(item.type, catalog.type)
    assert.equal(item.weight, catalog.weight)
    assert.equal(item.base_price_cp, catalog.base_price_cp)
    assert.equal(item.mechanics_status, catalog.mechanics_status)
  }
})
