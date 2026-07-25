import type { GameState, MapCell, TacticalTurn } from './types'

export const CELL_FEET = 5

/** Pure presentation helpers for the tactical UI. All validation, movement,
 * attacks, turns and random outcomes are resolved by the server. */
export function mapGridDimensions(cells: MapCell[]) {
  return cells.reduce((dimensions, cell) => ({
    columns: Math.max(dimensions.columns, cell.x + 1),
    rows: Math.max(dimensions.rows, cell.y + 1),
  }), { columns: 1, rows: 1 })
}

export function currentTacticalTurn(state: GameState): TacticalTurn {
  const value = state.tacticalTurn
  return value?.sceneTurn === state.scene.turn && value.actorId === state.activePlayerId
    ? value
    : { sceneTurn: state.scene.turn, actorId: state.activePlayerId, movementSpent: 0, actionUsed: false }
}
