// Собран автоматически: pnpm items:manifest. Руками не править.
// Конкретный предмет выбирается по id/catalog_id, затем используется рисунок
// его вида. Файлы лежат в public/assets/items/<asset-id>.png.
import starterPresentation from '../data/starter-item-presentation.json'

export const ITEM_IMAGE_IDS: ReadonlySet<string> = new Set([
  'item-srd-5-2-1-acid',
  'item-srd-5-2-1-adamantine-chain-mail',
  'item-srd-5-2-1-alchemists-fire',
  'item-srd-5-2-1-alchemists-supplies',
  'item-srd-5-2-1-antitoxin',
  'item-srd-5-2-1-arcane-focus-crystal',
  'item-srd-5-2-1-arcane-focus-orb',
  'item-srd-5-2-1-arcane-focus-rod',
  'item-srd-5-2-1-arcane-focus-staff',
  'item-srd-5-2-1-arcane-focus-wand',
  'item-srd-5-2-1-arrows-20',
  'item-srd-5-2-1-backpack',
  'item-srd-5-2-1-bagpipes',
  'item-srd-5-2-1-ball-bearings',
  'item-srd-5-2-1-battleaxe',
  'item-srd-5-2-1-bedroll',
  'item-srd-5-2-1-blowgun',
  'item-srd-5-2-1-bolts-20',
  'item-srd-5-2-1-breastplate',
  'item-srd-5-2-1-brewers-supplies',
  'item-srd-5-2-1-brooch-of-shielding',
  'item-srd-5-2-1-calligraphers-supplies',
  'item-srd-5-2-1-caltrops',
  'item-srd-5-2-1-carpenters-tools',
  'item-srd-5-2-1-cartographers-tools',
  'item-srd-5-2-1-chain-mail',
  'item-srd-5-2-1-chain-shirt',
  'item-srd-5-2-1-climbers-kit',
  'item-srd-5-2-1-cloak-of-protection',
  'item-srd-5-2-1-club',
  'item-srd-5-2-1-cobblers-tools',
  'item-srd-5-2-1-component-pouch',
  'item-srd-5-2-1-cooks-utensils',
  'item-srd-5-2-1-crowbar',
  'item-srd-5-2-1-dagger',
  'item-srd-5-2-1-dart',
  'item-srd-5-2-1-diamond-50gp',
  'item-srd-5-2-1-druidic-focus-mistletoe',
  'item-srd-5-2-1-druidic-focus-totem',
  'item-srd-5-2-1-druidic-focus-wooden-staff',
  'item-srd-5-2-1-druidic-focus-yew-wand',
  'item-srd-5-2-1-drum',
  'item-srd-5-2-1-dulcimer',
  'item-srd-5-2-1-explorers-pack',
  'item-srd-5-2-1-firearm-bullets-10',
  'item-srd-5-2-1-flail',
  'item-srd-5-2-1-flame-tongue-longsword',
  'item-srd-5-2-1-flute',
  'item-srd-5-2-1-glaive',
  'item-srd-5-2-1-glassblowers-tools',
  'item-srd-5-2-1-grappling-hook',
  'item-srd-5-2-1-greataxe',
  'item-srd-5-2-1-greatclub',
  'item-srd-5-2-1-greatsword',
  'item-srd-5-2-1-halberd',
  'item-srd-5-2-1-half-plate-armor',
  'item-srd-5-2-1-hand-crossbow',
  'item-srd-5-2-1-handaxe',
  'item-srd-5-2-1-healers-kit',
  'item-srd-5-2-1-heavy-crossbow',
  'item-srd-5-2-1-herbalism-kit',
  'item-srd-5-2-1-hide-armor',
  'item-srd-5-2-1-holy-symbol-amulet',
  'item-srd-5-2-1-holy-symbol-emblem',
  'item-srd-5-2-1-holy-symbol-reliquary',
  'item-srd-5-2-1-holy-water',
  'item-srd-5-2-1-horn',
  'item-srd-5-2-1-hunting-trap',
  'item-srd-5-2-1-javelin',
  'item-srd-5-2-1-jewelers-tools',
  'item-srd-5-2-1-lance',
  'item-srd-5-2-1-lantern-hooded',
  'item-srd-5-2-1-leather-armor',
  'item-srd-5-2-1-leatherworkers-tools',
  'item-srd-5-2-1-light-crossbow',
  'item-srd-5-2-1-light-hammer',
  'item-srd-5-2-1-longbow',
  'item-srd-5-2-1-longsword',
  'item-srd-5-2-1-longsword-plus-1',
  'item-srd-5-2-1-lute',
  'item-srd-5-2-1-lyre',
  'item-srd-5-2-1-mace',
  'item-srd-5-2-1-manacles',
  'item-srd-5-2-1-masons-tools',
  'item-srd-5-2-1-material-circle-of-death-500gp',
  'item-srd-5-2-1-material-dawn-100gp',
  'item-srd-5-2-1-material-diamond-dust-100gp',
  'item-srd-5-2-1-material-shadow-of-moil-150gp',
  'item-srd-5-2-1-material-summon-aberration-400gp',
  'item-srd-5-2-1-material-summon-beast-200gp',
  'item-srd-5-2-1-material-summon-celestial-500gp',
  'item-srd-5-2-1-material-summon-construct-400gp',
  'item-srd-5-2-1-material-summon-draconic-spirit-500gp',
  'item-srd-5-2-1-material-summon-elemental-400gp',
  'item-srd-5-2-1-material-summon-fey-300gp',
  'item-srd-5-2-1-material-summon-fiend-600gp',
  'item-srd-5-2-1-material-summon-shadowspawn-300gp',
  'item-srd-5-2-1-material-summon-undead-300gp',
  'item-srd-5-2-1-maul',
  'item-srd-5-2-1-morningstar',
  'item-srd-5-2-1-musket',
  'item-srd-5-2-1-needles-50',
  'item-srd-5-2-1-oil-flask',
  'item-srd-5-2-1-padded-armor',
  'item-srd-5-2-1-painters-supplies',
  'item-srd-5-2-1-pan-flute',
  'item-srd-5-2-1-pike',
  'item-srd-5-2-1-pistol',
  'item-srd-5-2-1-plate-armor',
  'item-srd-5-2-1-poison-basic',
  'item-srd-5-2-1-potion-of-healing',
  'item-srd-5-2-1-potters-tools',
  'item-srd-5-2-1-quarterstaff',
  'item-srd-5-2-1-rapier',
  'item-srd-5-2-1-rations-one-day',
  'item-srd-5-2-1-ring-mail',
  'item-srd-5-2-1-ring-of-fire-resistance',
  'item-srd-5-2-1-ring-of-protection',
  'item-srd-5-2-1-rope-hempen-50-feet',
  'item-srd-5-2-1-scale-mail',
  'item-srd-5-2-1-scimitar',
  'item-srd-5-2-1-shawm',
  'item-srd-5-2-1-shield',
  'item-srd-5-2-1-shortbow',
  'item-srd-5-2-1-shortsword',
  'item-srd-5-2-1-sickle',
  'item-srd-5-2-1-sling',
  'item-srd-5-2-1-sling-bullets-20',
  'item-srd-5-2-1-smiths-tools',
  'item-srd-5-2-1-spear',
  'item-srd-5-2-1-splint-armor',
  'item-srd-5-2-1-studded-leather-armor',
  'item-srd-5-2-1-tinkers-tools',
  'item-srd-5-2-1-torch',
  'item-srd-5-2-1-trident',
  'item-srd-5-2-1-vicious-longsword',
  'item-srd-5-2-1-viol',
  'item-srd-5-2-1-wand-of-magic-missiles',
  'item-srd-5-2-1-war-pick',
  'item-srd-5-2-1-warhammer',
  'item-srd-5-2-1-waterskin',
  'item-srd-5-2-1-weapon-of-warning-longsword',
  'item-srd-5-2-1-weavers-tools',
  'item-srd-5-2-1-whip',
  'item-srd-5-2-1-woodcarvers-tools',
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
  name?: string
  id?: string
  stock_id?: string
  catalog_id?: string
  type?: string
  image?: string
  imagePosition?: string
}

export function starterItemPresentationFor(item: ItemImageInput): { description: string; image: string; imagePosition?: string } | null {
  if (item.catalog_id) return null
  const entries = starterPresentation.items as Record<string, { description: string; image: string; imagePosition?: string }>
  return entries[String(item.name ?? '').trim()] ?? null
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
  const starter = starterItemPresentationFor(item)
  if (starter?.image) return starter.image
  const typeId = ITEM_TYPE_IMAGE_IDS[item.type as keyof typeof ITEM_TYPE_IMAGE_IDS]
  return typeId ? `/assets/items/${typeId}.png` : null
}
