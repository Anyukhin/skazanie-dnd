import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { ITEM_CATALOG } from '../server/item-catalog.mjs'

import {
  ITEM_TYPES,
  itemAssetsOnDisk,
  manifestIsCurrent,
  normalizeItemIdentifier,
  resolveItemImagePath,
} from '../tools/build-item-manifest.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const TYPES_SOURCE = readFileSync(`${ROOT}src/types.ts`, 'utf8')

function inventoryItemTypes() {
  const declaration = TYPES_SOURCE.split('export type InventoryItem = {')[1]?.split(/\r?\n\}/u)[0] ?? ''
  const line = declaration.match(/\btype:\s*([^\r\n]+)/u)?.[1] ?? ''
  return [...line.matchAll(/'([^']+)'/gu)].map((match) => match[1])
}

function assertPng512(path) {
  const bytes = readFileSync(path)
  assert.ok(bytes.length >= 20_000, `${path}: рисунок подозрительно мал`)
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${path}: нужен PNG`)
  assert.equal(bytes.readUInt32BE(16), 512, `${path}: ширина должна быть 512`)
  assert.equal(bytes.readUInt32BE(20), 512, `${path}: высота должна быть 512`)
  return bytes
}

test('манифест предметов покрывает каждый Item.type и реальный стартовый набор', () => {
  const assets = itemAssetsOnDisk()
  const declaredTypes = inventoryItemTypes()
  assert.deepEqual(declaredTypes, ITEM_TYPES, 'сборщик обязан знать весь union InventoryItem.type')
  assert.deepEqual(Object.keys(assets.typeIds), ITEM_TYPES, 'для каждого вида нужен типовой рисунок')

  const expectedCatalogImages = Object.keys(ITEM_CATALOG)
    .map((id) => `item-${normalizeItemIdentifier(id)}`)
    .sort()
  assert.deepEqual(
    assets.itemIds,
    expectedCatalogImages,
    'кждая запись полного каталога получает отдельный рисунок',
  )
  for (const item of Object.values(ITEM_CATALOG)) {
    assert.equal(
      resolveItemImagePath(item, assets),
      `/assets/items/item-${normalizeItemIdentifier(item.catalog_id)}.png`,
      `${item.catalog_id}: каталог не должен откатываться к типовой заглушке`,
    )
  }
  assert.equal(manifestIsCurrent(), true, 'после изменения файлов нужен pnpm items:manifest')

  const rights = JSON.parse(readFileSync(`${ROOT}data/asset-rights.json`, 'utf8'))
  const declaredRights = new Map(rights.assets.map((tuple) => [tuple[0], tuple]))
  const catalogContentOwners = new Map()
  for (const imageId of [...assets.itemIds, ...Object.values(assets.typeIds)]) {
    const relative = `items/${imageId}.png`
    const path = `${ROOT}public/assets/${relative}`
    assert.equal(existsSync(path), true, `${relative}: файла нет на диске`)
    const bytes = assertPng512(path)
    const tuple = declaredRights.get(relative)
    assert.ok(tuple, `${relative}: права не зарегистрированы`)
    assert.equal(tuple[2], bytes.length, `${relative}: размер разошёлся с реестром прав`)
    const hash = createHash('sha256').update(bytes).digest('hex')
    assert.equal(tuple[1], hash, `${relative}: хеш разошёлся с реестром прав`)
    if (assets.itemIds.includes(imageId)) {
      const owners = catalogContentOwners.get(hash) ?? []
      owners.push(imageId)
      catalogContentOwners.set(hash, owners)
    }
  }
  const duplicatedCatalogImages = [...catalogContentOwners.values()].filter((owners) => owners.length > 1)
  assert.deepEqual(duplicatedCatalogImages, [], 'разные item-id не должны скрывать одинаковый рисунок')
  assert.equal(catalogContentOwners.size, assets.itemIds.length)
})

test('рисунок выбирается runtime → id/stock/catalog → type → нейтральный знак', () => {
  const manifest = {
    itemIds: ['item-direct-id', 'item-stock-id', 'item-catalog-id'],
    typeIds: { weapon: 'type-weapon' },
  }
  assert.equal(resolveItemImagePath({
    image: '/generated/runtime.png',
    id: 'direct id',
    catalog_id: 'catalog id',
    type: 'weapon',
  }, manifest), '/generated/runtime.png')
  assert.equal(resolveItemImagePath({ id: 'direct id', catalog_id: 'catalog id', type: 'weapon' }, manifest), '/assets/items/item-direct-id.png')
  assert.equal(resolveItemImagePath({ stock_id: 'stock id', catalog_id: 'catalog id', type: 'weapon' }, manifest), '/assets/items/item-stock-id.png')
  assert.equal(resolveItemImagePath({ catalog_id: 'catalog id', type: 'weapon' }, manifest), '/assets/items/item-catalog-id.png')
  assert.equal(resolveItemImagePath({ type: 'weapon' }, manifest), '/assets/items/type-weapon.png')
  assert.equal(resolveItemImagePath({ type: 'unknown' }, manifest), null)
})

test('инвентарь и торговец используют общий resolver без вечных текстовых плейсхолдеров', () => {
  const inventory = readFileSync(`${ROOT}src/InventoryViews.tsx`, 'utf8')
  const merchant = readFileSync(`${ROOT}src/MerchantView.tsx`, 'utf8')
  for (const forbidden of ['Изображение создаётся', 'Генерация не удалась']) {
    assert.equal(inventory.includes(forbidden), false, `инвентарь снова показывает «${forbidden}»`)
    assert.equal(merchant.includes(forbidden), false, `торговец снова показывает «${forbidden}»`)
  }
  assert.match(inventory, /const image = itemImageFor\(item\)/u)
  assert.match(merchant, /function MerchantItemArtwork/u)
  assert.match(merchant, /<MerchantItemArtwork item=\{item\}/u)
})
