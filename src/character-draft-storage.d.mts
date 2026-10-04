export const CHARACTER_DRAFT_VERSION: number
export const CHARACTER_DRAFT_MAX_AGE_MS: number

export function characterDraftKey(owner: {
  accountId?: unknown
  sessionCode?: unknown
  playerId?: unknown
  rulesetId?: unknown
}): string

export function saveCharacterDraft(
  key: string,
  snapshot: { draft: object; step: string; furthestStep: string },
  options?: { storage?: Storage | null; now?: number },
): boolean

export function loadCharacterDraft(
  key: string,
  options?: { storage?: Storage | null; now?: number; knownClassIds?: string[]; knownSteps?: string[] },
): { draft: Record<string, unknown>; step: string; furthestStep: string; savedAt: number } | null

export function clearCharacterDraft(key: string, options?: { storage?: Storage | null }): void
