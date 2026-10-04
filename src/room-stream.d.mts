type CampaignState = { sessionCode?: string | null }

/** Отложенный снимок комнаты с кампанией, из потока которой он пришёл (аудит PR #131, REC-04). */
export type QueuedRoomSnapshot<S extends CampaignState> = {
  campaignId: string
  version: number
  state: S
}

export function campaignKey(value: unknown): string
export function sameCampaign(left: unknown, right: unknown): boolean
export function roomSnapshotAcceptable(currentCampaignId: unknown, sourceCampaignId: unknown, state: CampaignState | null | undefined): boolean
export function enqueueRoomSnapshot<S extends CampaignState>(
  queue: QueuedRoomSnapshot<S>[],
  sourceCampaignId: string,
  room: { version?: number; state?: S | null },
): QueuedRoomSnapshot<S>[]
export function takeQueuedRoom<S extends CampaignState>(
  queue: QueuedRoomSnapshot<S>[],
  currentCampaignId: string,
  appliedVersion: number,
): QueuedRoomSnapshot<S> | null
export function queuedRoomsForCampaign<S extends CampaignState>(queue: QueuedRoomSnapshot<S>[], campaignId: string): QueuedRoomSnapshot<S>[]

/** Кадр `access` со `status: 'revoked'` (аудит PR #131, LIVE-01/02). */
export function streamAccessRevocation(data: unknown): { reason: string } | null
