export type ChronicleFilter = 'all' | 'story' | 'combat'

export const CHRONICLE_FILTERS: readonly ChronicleFilter[]
export function chronicleMessageText(text: string): string

export function chronicleMatchesFilter(
  speaker: 'narrator' | 'player' | 'system',
  filter: ChronicleFilter,
  isStoryCard?: boolean,
): boolean

export function isChronicleNearBottom(
  viewport: { scrollHeight: number; clientHeight: number; scrollTop: number },
  threshold?: number,
): boolean
