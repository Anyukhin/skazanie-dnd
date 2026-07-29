// Собран автоматически: pnpm items:manifest. Руками не править.
// Конкретный предмет выбирается по id/catalog_id, затем используется рисунок
// его вида. Файлы лежат в public/assets/items/<asset-id>.png.
export const ITEM_IMAGE_IDS: ReadonlySet<string> = new Set([
  'item-srd-5-2-1-dagger',
  'item-srd-5-2-1-leather-armor',
  'item-srd-5-2-1-longsword',
  'item-srd-5-2-1-shield',
  'item-srd-5-2-1-shortbow',
])

export const ITEM_TYPE_IMAGE_IDS = Object.freeze({
  weapon: 'type-weapon',
  armor: 'type-armor',
  consumable: 'type-consumable',
  tool: 'type-tool',
  quest: 'type-quest',
  treasure: 'type-treasure',
  document: 'type-document',
  other: 'type-other',
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
    const imageId = normalized ? `item-${normalized}` : ''
    if (imageId && ITEM_IMAGE_IDS.has(imageId)) return `/assets/items/${imageId}.png`
  }
  const typeId = ITEM_TYPE_IMAGE_IDS[item.type as keyof typeof ITEM_TYPE_IMAGE_IDS]
  return typeId ? `/assets/items/${typeId}.png` : null
}
