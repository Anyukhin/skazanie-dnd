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
