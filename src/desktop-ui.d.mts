export function localizedQuestClockLabel(label: string | null | undefined): string

export function shouldAutoOpenCampaignModal(input: {
  heroCount: number
  membershipCount: number
  requestedRoom?: string | null
}): boolean

export function doorDirectionFromActor(
  door: { x: number; y: number; dir: 'e' | 's' },
  actor: { x: number; y: number },
): 'север' | 'юг' | 'восток' | 'запад'

export function doorOverlayCells(
  door: { x: number; y: number; dir: 'e' | 's' },
): Array<{ x: number; y: number }>

export function selectedAttackForecast<T extends { item_id?: string | null }>(
  targets: Record<string, T[]> | null | undefined,
  targetId: string | null | undefined,
  itemId: string | null | undefined,
): T | null
