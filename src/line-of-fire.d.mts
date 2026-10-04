export interface LineOfFireCell {
  x: number
  y: number
}

export function revealedLineOfFireCells<T extends LineOfFireCell>(
  sceneCells: Array<LineOfFireCell & { revealed?: boolean }> | null | undefined,
  starts: T[],
  ends: T[],
): { starts: T[]; ends: T[] }

export const HIDDEN_LINE_OF_FIRE_REASON: string
