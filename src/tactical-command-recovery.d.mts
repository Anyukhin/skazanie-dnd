export type TacticalCommandRecovery = {
  campaignId: string
  requestId: string
  kind?: 'tactical' | 'rest'
  command: Record<string, unknown>
  message: string
  manualRoll?: boolean
  rollId?: string
}

export type TacticalCommandRequest = {
  path: string
  init: RequestInit
  body: Record<string, unknown>
}

export function tacticalCommandRequest(pending: TacticalCommandRecovery): TacticalCommandRequest
export function isTacticalCommandUnknown(error: unknown): boolean
export function pendingTacticalCommandStorageKey(accountId: string | undefined, campaignId: string | undefined): string | null
export function parsePendingTacticalCommand(raw: string | null): TacticalCommandRecovery | null
export function readPendingTacticalCommand(storage: Storage | null | undefined, key: string | null): TacticalCommandRecovery | null
export function writePendingTacticalCommand(storage: Storage | null | undefined, key: string | null, pending: TacticalCommandRecovery): void
export function clearPendingTacticalCommand(storage: Storage | null | undefined, key: string | null): void
export function tacticalCommandView(pending: TacticalCommandRecovery | null | undefined): { campaignId: string; message: string; kind: 'tactical' | 'rest' } | null

/** Намерение свободного действия `/api/narrate` (аудит PR #131, REC-01). */
export type NarrateIntent = {
  campaignId: string
  actorId?: string
  action: string
  requestKind?: 'action' | 'question' | 'discussion'
  npcId?: string
  clarificationId?: string
  supersedesCheckId?: string
  supersedesProposalId?: string
  questionCheckId?: string
  questionProposalId?: string
}

export type NarrateRecovery = NarrateIntent & {
  actorId: string
  requestKind: 'action' | 'question' | 'discussion'
  requestId: string
  manualRoll: boolean
}

export function narrateIntentMatches(pending: NarrateIntent | null | undefined, intent: NarrateIntent | null | undefined): boolean
export function narrateRecoveryFor(
  existing: NarrateRecovery | null | undefined,
  intent: NarrateIntent,
  options: { newKey: () => string; manualRoll?: boolean },
): NarrateRecovery | null
export function pendingNarrateStorageKey(accountId: string | undefined, campaignId: string | undefined): string | null
export function parsePendingNarrate(raw: string | null): NarrateRecovery | null
export function readPendingNarrate(storage: Storage | null | undefined, key: string | null): NarrateRecovery | null
export function writePendingNarrate(storage: Storage | null | undefined, key: string | null, pending: NarrateRecovery | null | undefined): void
export function clearPendingNarrate(storage: Storage | null | undefined, key: string | null, requestId?: string): void
