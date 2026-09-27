export const CIRCULAR_AREA_GEOMETRY_VERSION: 'circle-grid-v2'

export type GridCell = { x: number; y: number }
export type GridBounds = { minX: number; minY: number; maxX: number; maxY: number }
export type CircularAreaOptions = {
  origin: GridCell
  radiusFeet: number
  cellFeet?: number
  bounds?: GridBounds
}

export function circularCellCoverage(cell: GridCell, radiusCells: number): number
export function circularCellCovered(cell: GridCell, radiusCells: number): boolean
export function gridOriginForTargetCell(target: GridCell): GridCell
export function circularAreaCells(options: CircularAreaOptions): GridCell[]
export type CircularAreaLineOfEffectOptions = {
  radiusFeet: number
  spreadsAroundCorners?: boolean
  isOpenCell?: (cell: GridCell) => boolean
  isBlockedEdge?: (from: GridCell, to: GridCell) => boolean
}
export function circularAreaLineOfEffect(
  origin: GridCell,
  targetCell: GridCell,
  options: CircularAreaLineOfEffectOptions,
): boolean
