export const CREATION_DRAFT_VERSION: number

export function creationDraftKey(parts?: {
  campaignCode?: string | null
  accountName?: string | null
  playerId?: string | null
  rulesetId?: string | null
}): string | null

export function sessionDraftStorage(): Storage | null

export interface StoredCreationDraft {
  draft: Record<string, unknown>
  step: string | null
  furthestStep: string | null
}

export function readCreationDraft(storage: Pick<Storage, 'getItem'> | null | undefined, key: string | null | undefined): StoredCreationDraft | null

export function writeCreationDraft(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  key: string | null | undefined,
  payload: { draft: unknown; step?: string | null; furthestStep?: string | null },
): boolean

export function clearCreationDraft(storage: Pick<Storage, 'removeItem'> | null | undefined, key: string | null | undefined): void

export function mergeCreationDraft<T extends object>(
  base: T,
  stored: Record<string, unknown> | null | undefined,
  optional?: Record<string, 'boolean' | 'string' | 'number'>,
): T

export function goldLabel(copper: number): string

export interface StartingPurchaseBudget {
  spentCp: number
  budgetCp: number | null
  remainingCp: number | null
  overBudgetCp: number
}

export function startingPurchaseBudget(input?: {
  budgetGp?: number | null
  purchases?: ReadonlyArray<{ id: string; quantity: number }>
  items?: ReadonlyArray<{ id: string; price_cp: number }>
}): StartingPurchaseBudget

export function purchaseShortfallCp(input: { remainingCp: number | null; priceCp?: number; quantity?: number }): number
