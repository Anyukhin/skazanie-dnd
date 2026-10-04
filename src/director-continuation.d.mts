export function isAdventureContinuation(text: unknown, context?: { npcId?: string; requestKind?: string }): boolean
export function continuesOnwardRoute(text: unknown, scene: { objective?: unknown; location?: unknown } | null | undefined, context?: { npcId?: string; requestKind?: string }): boolean
export function isEncounterRequest(text: unknown, context?: { npcId?: string; requestKind?: string }): boolean
export function isDirectorPartyDecision(interaction: { type?: string; id?: string } | null | undefined): boolean
export function awaitsDecisionContinuation(interaction: { status?: string; resolvedOptionId?: string | null; questAbandonment?: unknown; questAcceptance?: unknown } | null | undefined): boolean
