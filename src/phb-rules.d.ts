declare module '*character-creation-feats.mjs' {
  export function resolveCharacterCreationFeat(id: string, choices: Record<string, unknown>, context: Record<string, unknown>): { ok: boolean; code?: string; reason?: string; benefits?: { ability_increases: Record<string, number>; skill_proficiencies: string[]; tool_proficiencies: string[] } }
  export function isClassSpellAvailable(spell: { id?: string; level?: number; classes?: string[] }, classKey: string, actor?: { creationBenefits?: { expanded_spells?: string[] } } | null): boolean
}
declare module '*character-creation-class-options.mjs' {
  export function validateClassChoices(id: string, choices: Record<string, unknown>, context: Record<string, unknown>): { ok: boolean; errors?: string[] }
}
