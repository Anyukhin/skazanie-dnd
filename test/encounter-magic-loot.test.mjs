import assert from 'node:assert/strict'
import test from 'node:test'

import { ITEM_MAGIC_LOOT_CATALOG_IDS, catalogItem } from '../server/item-catalog.mjs'
import { ENCOUNTER_MAGIC_LOOT_POLICY_ID, serverEncounterMagicLoot } from '../server/loot-tables.mjs'

/**
 * Задача 73 бэклога: в добыче не было ни редкости, ни магии. Политика выдачи
 * server-owned и намеренно скупая — иначе магия перестаёт быть событием.
 *
 * Проверяется ровно то, что делает её безопасной: детерминированность (replay
 * и повтор после падения дают ту же находку), пороги, единственность предмета
 * за встречу и то, что открывает вещь **отдельный список**, а не факт наличия
 * записи в каталоге.
 */

const MAGIC = new Set(ITEM_MAGIC_LOOT_CATALOG_IDS)

function findingsOver(count, { totalXp }) {
  const found = []
  for (let index = 1; index <= count; index += 1) {
    found.push(...serverEncounterMagicLoot({ encounterId: `enc-${index}`, totalXp }))
  }
  return found
}

test('политика названа и выдаёт не больше одного предмета за встречу', () => {
  assert.equal(ENCOUNTER_MAGIC_LOOT_POLICY_ID, 'encounter-magic-loot-v1')
  for (let index = 1; index <= 120; index += 1) {
    const loot = serverEncounterMagicLoot({ encounterId: `enc-${index}`, totalXp: 5_000 })
    assert.ok(loot.length <= 1, `встреча enc-${index} выдала ${loot.length} магических предметов`)
  }
})

test('до порога опыта магии нет вовсе', () => {
  assert.equal(findingsOver(120, { totalXp: 199 }).length, 0,
    'мелкая стычка не должна приносить магический предмет')
  assert.equal(findingsOver(120, { totalXp: 0 }).length, 0)
})

test('редкая находка открывается только на большом опыте', () => {
  const modest = findingsOver(120, { totalXp: 300 })
  assert.ok(modest.length > 0, 'на 300 XP необычные находки обязаны иногда встречаться')
  for (const item of modest) {
    assert.equal(catalogItem(item.catalog_id).magic_item.rarity, 'uncommon',
      `${item.catalog_id} — редкая вещь не должна выпадать до 700 XP`)
  }
  const serious = findingsOver(120, { totalXp: 900 })
  assert.ok(serious.some((item) => catalogItem(item.catalog_id).magic_item.rarity === 'rare'),
    'на 900 XP редкие находки обязаны встречаться')
})

test('находка детерминирована: replay и повтор после падения дают ту же вещь', () => {
  for (const encounterId of ['enc-23', 'enc-45', 'enc-50']) {
    const first = serverEncounterMagicLoot({ encounterId, totalXp: 900 })
    const second = serverEncounterMagicLoot({ encounterId, totalXp: 900 })
    assert.deepEqual(second, first, `${encounterId}: повтор дал другую находку`)
  }
})

test('выдаётся только то, что открыто отдельным списком магической добычи', () => {
  const found = findingsOver(300, { totalXp: 5_000 })
  assert.ok(found.length > 0, 'политика обязана хоть что-то выдавать')
  for (const item of found) {
    assert.ok(MAGIC.has(item.catalog_id),
      `${item.catalog_id} не открыт списком магической добычи — запись в каталоге сама по себе ничего не открывает`)
    const source = catalogItem(item.catalog_id)
    assert.ok(['verified', 'partial'].includes(source.mechanics_status),
      `${item.catalog_id}: механика не исполнена, такой предмет выдавать нельзя`)
    assert.equal(item.quantity, 1)
    assert.equal(item.equipped, false)
    assert.ok(String(item.rarity ?? '').length > 0, 'у находки обязана быть видимая редкость')
  }
})

test('жезл и Огненный язык остаются наградой за сюжет, а не случайной находкой', () => {
  for (const catalogId of ['srd_5_2_1:wand-of-magic-missiles', 'srd_5_2_1:flame-tongue-longsword']) {
    assert.equal(MAGIC.has(catalogId), false,
      `${catalogId} требует объяснения игроку и не должен появляться случайно`)
    assert.equal(catalogItem(catalogId).availability.magic_loot, false)
  }
})

test('магическая добыча не открывает магазин и изготовление', () => {
  for (const catalogId of ITEM_MAGIC_LOOT_CATALOG_IDS) {
    const item = catalogItem(catalogId)
    assert.equal(item.availability.shop, false, `${catalogId} не должен продаваться в лавке`)
    assert.equal(item.availability.crafting, false, `${catalogId} не должен изготавливаться`)
  }
})
