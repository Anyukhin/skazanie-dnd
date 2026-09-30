export function isAdventureContinuation(text: unknown, context?: { npcId?: string; requestKind?: string }): boolean
export function isEncounterRequest(text: unknown, context?: { npcId?: string; requestKind?: string }): boolean
export function isDirectorPartyDecision(interaction: { type?: string; id?: string } | null | undefined): boolean
