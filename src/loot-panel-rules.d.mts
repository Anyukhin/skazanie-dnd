import type { BattleEvent, LootContainerCard, LootItemCard, Player } from './types'

export const LOOT_KIND_LABELS: Record<string, string>
export const LOOT_KIND_NOUNS: Record<string, string>
export const LOOT_ITEM_TYPE_LABELS: Record<string, string>

export function lootPriceLabel(copper?: number): string

export function lootPickKey(containerId: string, itemInstanceId: string): string

export interface LootPick {
  item: LootItemCard
  quantity: number
}

export function lootPicksOf(container: LootContainerCard, picks: Record<string, number>): LootPick[]

export function lootPickedWeight(picks: readonly LootPick[]): number

export interface LootWeightForecast {
  capacity: number
  carried: number
  after: number
  known: boolean
  overloaded: boolean
  remaining: number
}

export function lootWeightForecast(recipient: Player | null | undefined, addedWeight: number): LootWeightForecast

export type LootTakeTone = 'ready' | 'action' | 'far' | 'blocked' | 'gone' | 'heavy' | 'empty' | 'spent'

export interface LootTakeState {
  label: string
  title: string
  disabled: boolean
  tone: LootTakeTone
}

export function lootTakeButtonState(input: {
  takenBy?: string | null
  canAct: boolean
  busy: boolean
  narrating: boolean
  canInspect: boolean
  distanceFeet?: number | null
  reachFeet: number
  actionCost?: 'action' | null
  /** Действие этого героя в этом ходу уже потрачено (`action_spent` проекции). */
  actionSpent?: boolean
  overloaded: boolean
  chosenCount: number
}): LootTakeState

export interface LootGhost {
  id: string
  name: string
  kind: string
  x: number | null
  y: number | null
  /** Раскрыта ли клетка: под туманом призрак места не называет. */
  cell_revealed?: boolean
  takenBy: string
  at: number
}

export function vanishedLootFrom(
  previous: readonly LootContainerCard[],
  current: readonly LootContainerCard[],
  battleLog: readonly BattleEvent[],
  actorName: (id?: string) => string,
  now?: number,
): LootGhost[]

export interface LootAftermath {
  bodies: LootContainerCard[]
  caches: LootContainerCard[]
  captiveGear: LootContainerCard[]
  itemCount: number
  weight: number
  empty: boolean
}

export function lootAftermath(containers: readonly LootContainerCard[]): LootAftermath

export function withLootTakenRecord(
  battleLog: readonly BattleEvent[] | undefined,
  record: BattleEvent | null | undefined,
): BattleEvent[]

export function lootCellLabel(container: { x: number | null; y: number | null; cell_revealed?: boolean }): string

export function lootDistanceFeet(container: { distance_feet?: number; cell_revealed?: boolean }): number | null
