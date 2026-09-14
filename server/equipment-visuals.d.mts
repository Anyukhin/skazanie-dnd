export type EquipmentVisualSlot =
  | 'body'
  | 'main_hand'
  | 'off_hand'
  | 'cloak'
  | 'brooch'
  | 'ring-protection'
  | 'ring-fire-resistance'

export type EquipmentVisualVariant = 'default' | 'enchanted' | 'adamantine' | 'flaming'

export type EquipmentVisualDescriptor = {
  model_key: string
  variant?: EquipmentVisualVariant
}

export type PublicLoadout = Partial<Record<EquipmentVisualSlot, EquipmentVisualDescriptor | null>>

export const EQUIPMENT_VISUAL_SCHEMA_VERSION: 2
export const EQUIPMENT_VISUAL_SLOTS: readonly EquipmentVisualSlot[]
export const EQUIPMENT_VISUAL_VARIANTS: readonly EquipmentVisualVariant[]
export const EQUIPMENT_VISUAL_MODEL_KEYS: readonly string[]
export const EQUIPMENT_ITEM_VISUALS: Readonly<Record<string, {
  slot: EquipmentVisualSlot
  model_key: string
  variant?: EquipmentVisualVariant
}>>

export function normalizeEquipmentVisualSlot(value: unknown): EquipmentVisualSlot | null
export function normalizeEquipmentVisualVariant(value: unknown, fallback?: EquipmentVisualVariant): EquipmentVisualVariant | null
export function normalizeEquipmentModelKey(value: unknown): string | null
export function itemVisualForCatalogId(catalogId: unknown): (EquipmentVisualDescriptor & { slot: EquipmentVisualSlot }) | null
export const equipmentVisualForCatalogId: typeof itemVisualForCatalogId
export function publicLoadoutForItems(items: unknown, options?: { additionalEquipped?: unknown[] }): PublicLoadout
export function normalizePublicLoadout(value: unknown): PublicLoadout
export function modelKeysForEquipmentSlot(slot: unknown): string[]
