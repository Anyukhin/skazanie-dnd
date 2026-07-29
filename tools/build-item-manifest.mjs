#!/usr/bin/env node
// Собирает явный список статичных рисунков предметов из public/.
//
// Vite не обходит public/assets через import.meta.glob, поэтому клиент не
// должен угадывать URL и ловить 404. Соглашение имён:
//   type-<Item.type>.png                 — запасной рисунок вида;
//   item-<normalized catalog/id>.png     — рисунок конкретного предмета.
//
// Запуск: pnpm items:manifest
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const ITEM_DIR = new URL('../public/assets/items/', import.meta.url)
const MANIFEST = new URL('../src/item-images.ts', import.meta.url)

export const ITEM_TYPES = Object.freeze([
  'weapon',
  'armor',
  'consumable',
  'tool',
  'quest',
  'treasure',
  'document',
  'other',
])

export function normalizeItemIdentifier(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('en')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
}

export function itemAssetsOnDisk() {
  const stems = readdirSync(ITEM_DIR)
    .filter((name) => name.endsWith('.png'))
    .map((name) => name.slice(0, -'.png'.length))
    .sort()
  return {
    itemIds: stems.filter((stem) => stem.startsWith('item-') && stem !== 'item-atlas'),
    typeIds: Object.fromEntries(ITEM_TYPES.flatMap((type) => (
      stems.includes(`type-${type}`) ? [[type, `type-${type}`]] : []
    ))),
  }
}

export function resolveItemImagePath(item, manifest = itemAssetsOnDisk()) {
  const runtime = String(item?.image ?? '').trim()
  if (runtime) return runtime
  const available = new Set(manifest.itemIds)
  for (const value of [item?.id, item?.stock_id, item?.catalog_id]) {
    const normalized = normalizeItemIdentifier(value)
    if (normalized && available.has(`item-${normalized}`)) {
      return `/assets/items/item-${normalized}.png`
    }
  }
  const typeId = manifest.typeIds[String(item?.type ?? '')]
  return typeId ? `/assets/items/${typeId}.png` : null
}

export function manifestSource({ itemIds, typeIds }) {
  const typeRows = ITEM_TYPES.flatMap((type) => (
    typeIds[type] ? [`  ${type}: '${typeIds[type]}',`] : []
  ))
  return `// Собран автоматически: pnpm items:manifest. Руками не править.
// Конкретный предмет выбирается по id/catalog_id, затем используется рисунок
// его вида. Файлы лежат в public/assets/items/<asset-id>.png.
export const ITEM_IMAGE_IDS: ReadonlySet<string> = new Set([
${itemIds.map((id) => `  '${id}',`).join('\n')}
])

export const ITEM_TYPE_IMAGE_IDS = Object.freeze({
${typeRows.join('\n')}
}) satisfies Readonly<Partial<Record<'weapon' | 'armor' | 'consumable' | 'tool' | 'quest' | 'treasure' | 'document' | 'other', string>>>

export type ItemImageInput = {
  id?: string
  stock_id?: string
  catalog_id?: string
  type?: string
  image?: string
  imagePosition?: string
}

const normalizeItemIdentifier = (value?: string) => String(value ?? '')
  .trim()
  .toLocaleLowerCase('en')
  .replace(/[^a-z0-9]+/gu, '-')
  .replace(/^-+|-+$/gu, '')

export function itemImageFor(item: ItemImageInput): string | null {
  const runtime = String(item.image ?? '').trim()
  if (runtime) return runtime
  for (const value of [item.id, item.stock_id, item.catalog_id]) {
    const normalized = normalizeItemIdentifier(value)
    const imageId = normalized ? \`item-\${normalized}\` : ''
    if (imageId && ITEM_IMAGE_IDS.has(imageId)) return \`/assets/items/\${imageId}.png\`
  }
  const typeId = ITEM_TYPE_IMAGE_IDS[item.type as keyof typeof ITEM_TYPE_IMAGE_IDS]
  return typeId ? \`/assets/items/\${typeId}.png\` : null
}
`
}

export function manifestIsCurrent() {
  const expected = manifestSource(itemAssetsOnDisk())
  let actual = ''
  try { actual = readFileSync(MANIFEST, 'utf8') } catch { return false }
  return actual.replace(/\r\n/gu, '\n') === expected
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/gu, '/')}` || process.argv[1]?.endsWith('build-item-manifest.mjs')) {
  const assets = itemAssetsOnDisk()
  writeFileSync(MANIFEST, manifestSource(assets), 'utf8')
  console.log(JSON.stringify({
    ok: true,
    items: assets.itemIds.length,
    types: Object.keys(assets.typeIds).length,
    manifest: 'src/item-images.ts',
  }, null, 2))
}
