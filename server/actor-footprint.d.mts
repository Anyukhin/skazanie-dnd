export const ACTOR_FOOTPRINT_VERSION: 1
export const ACTOR_SIZE_SIDES: Readonly<Record<'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'gargantuan', 1 | 2 | 3 | 4>>

export type ActorFootprint = { version: 1; size: 1 | 2 | 3 | 4 }
export type GridPosition = { x: number; y: number }

export function footprintMetadataForSize(size: unknown): ActorFootprint
export function normalizeFootprintMetadata(value: unknown): ActorFootprint | null
export function footprintSizeFor(actor: unknown): 1 | 2 | 3 | 4
export function footprintCellsFor(actor: unknown, anchor?: Partial<GridPosition> | null): GridPosition[]
export function footprintDistanceFeet(left: unknown, right: unknown, leftAnchor?: Partial<GridPosition> | null, rightAnchor?: Partial<GridPosition> | null): number | null
export function footprintOverlap(left: unknown, right: unknown, leftAnchor?: Partial<GridPosition> | null, rightAnchor?: Partial<GridPosition> | null): boolean
