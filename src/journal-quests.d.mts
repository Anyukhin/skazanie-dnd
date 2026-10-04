export function journalQuestFocus(state: {
  scene?: { objective?: unknown }
  adventure?: { chapter?: unknown }
  worldMemory?: { quests?: Array<{ id: string; status?: string; objectives?: string[] }> }
} | null | undefined): { currentId: string; carriedIds: string[] }
