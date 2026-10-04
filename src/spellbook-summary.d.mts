export interface SummarySpell {
  id: string
  level: number
  prepared?: boolean
  innateSpell?: boolean
}

export type SpellSelectionMode = 'spellbook' | 'known' | 'prepared'

export interface HeroSpellCounts {
  mode: SpellSelectionMode | string | null
  cantrips: number
  book: number | null
  prepared: number
  innate: number
  list: number
}

export function heroSpellCounts(
  spells: readonly SummarySpell[],
  options?: { mode?: SpellSelectionMode | string | null; knownSpellIds?: readonly string[] | null },
): HeroSpellCounts

export function heroSpellSummary(counts: HeroSpellCounts): string

export function heroSpellTileLabel(counts: HeroSpellCounts): string
