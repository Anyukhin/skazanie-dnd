import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { ITEM_CATALOG, SCENARIO_ITEM_CATALOG } from '../server/item-catalog.mjs'

import {
  ITEM_TYPES,
  itemAssetsOnDisk,
  manifestIsCurrent,
  normalizeItemIdentifier,
  legacyStarterItemPresentationFor,
  resolveItemImagePath,
  starterItemPresentationFor,
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

  // Предметы сценария живут в своём каталоге, но рисунок у каждого свой — как у SRD.
  const FULL_CATALOG = { ...ITEM_CATALOG, ...SCENARIO_ITEM_CATALOG }
  const expectedCatalogImages = Object.keys(FULL_CATALOG)
    .map((id) => `item-${normalizeItemIdentifier(id)}`)
    .sort()
  assert.deepEqual(
    assets.itemIds,
    expectedCatalogImages,
    'кждая запись полного каталога получает отдельный рисунок',
  )
  for (const item of Object.values(FULL_CATALOG)) {
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

test('стартовые вещи получают рисунок по точному имени без подмены авторского изображения', () => {
  const book = { name: 'Книга заклинаний', type: 'other' }
  const art = starterItemPresentationFor(book)
  assert.equal(resolveItemImagePath(book), art.image)
  assert.ok(art.description.length > 20)
  assert.equal(resolveItemImagePath({ ...book, image: '/generated/custom-book.png' }), '/generated/custom-book.png')
  assert.equal(starterItemPresentationFor({ ...book, catalog_id: 'srd_5_2_1:dagger' }), null)
  assert.equal(starterItemPresentationFor({ name: 'Собственный предмет игрока' }), null)
})

test('старый рисунок заменяется только для точной пары имени стартовой вещи и прежнего URL', () => {
  const legacyImage = '/assets/ui/action-icons/identify.png'
  const currentImage = '/assets/items/starter-book.png'
  const presentations = {
    'Книга заклинаний': {
      description: 'fixture',
      image: currentImage,
      legacy_images: [legacyImage],
    },
  }
  const manifest = { itemIds: ['item-catalog-id'], typeIds: { other: 'type-other' } }

  assert.equal(
    legacyStarterItemPresentationFor({ name: 'Книга заклинаний', catalog_id: 'srd:book', image: legacyImage }, presentations)?.image,
    currentImage,
  )
  assert.equal(
    resolveItemImagePath({ name: 'Книга заклинаний', catalog_id: 'srd:book', image: legacyImage, type: 'other' }, manifest, presentations),
    currentImage,
  )
  assert.equal(
    resolveItemImagePath({ name: 'Книга заклинаний', catalog_id: 'srd:book', image: '/generated/custom.png', type: 'other' }, manifest, presentations),
    '/generated/custom.png',
  )
  assert.equal(
    resolveItemImagePath({ name: 'Другая книга', catalog_id: 'srd:book', image: legacyImage, type: 'other' }, manifest, presentations),
    legacyImage,
  )
  assert.equal(
    resolveItemImagePath({ name: 'Книга заклинаний', catalog_id: 'catalog id', type: 'other' }, manifest, presentations),
    '/assets/items/item-catalog-id.png',
  )

  const inherited = Object.create({ 'Книга заклинаний': presentations['Книга заклинаний'] })
  assert.equal(starterItemPresentationFor({ name: 'Книга заклинаний' }, inherited), null)
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
