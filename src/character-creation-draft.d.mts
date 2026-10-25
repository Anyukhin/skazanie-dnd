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

export function addStartingPurchase(
  purchases: ReadonlyArray<{ id: string; quantity: number }>,
  id: string,
  quantity: number,
): Array<{ id: string; quantity: number }>

export function isRolledAssignment(abilities: Readonly<Record<string, number>>, scores: ReadonlyArray<number>): boolean

export function firstIncompleteStepIndex(stepIds: ReadonlyArray<string>, validate: (stepId: string) => string): number

export function pointBuySpent(scores: Readonly<Record<string, number>>, costs: Readonly<Record<string | number, number>>): number

export function pointBuyStep(input: {
  scores: Readonly<Record<string, number>>
  ability: string
  delta: 1 | -1
  costs: Readonly<Record<string | number, number>>
  budget?: number
  minimum?: number
  maximum?: number
}): { ok: true; score: number; cost: number } | { ok: false; reason: string }

export interface AbilityPreview {
  hitPoints: number | null
  initiative: number
  proficiency: number
  savingThrows: Array<{ ability: string; bonus: number }>
  attack: { ability: string; bonus: number } | null
  spell: { ability: string; saveDc: number; attack: number } | null
}

export function abilityPreview(input: {
  abilities: Readonly<Record<string, number>>
  hitDie?: number | null
  savingThrows?: ReadonlyArray<string>
  spellcastingAbility?: string | null
  primaryAbility?: string | null
  proficiency?: number
}): AbilityPreview

export function creationChecklist(
  steps: ReadonlyArray<{ id: string; title: string }>,
  validate: (stepId: string) => string,
): Array<{ id: string; title: string; done: boolean; message: string }>
