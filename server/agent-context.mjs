const clean = (value, maximum) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

/** Public, bounded campaign contract shared by every creative agent. */
export function campaignConceptForAgent(state = {}) {
  const concept = state.campaignConcept ?? state.campaign_concept ?? {}
  return {
    preset: clean(concept.preset, 160),
    era: clean(concept.era, 80),
    genre: clean(concept.genre, 100),
    tone: clean(concept.tone, 160),
    premise: clean(concept.premise, 400),
    themes: clean(concept.themes ?? concept.theme, 240),
    boundaries: clean(concept.boundaries, 500),
    magic_level: clean(concept.magicLevel ?? concept.magic_level, 80),
    technology_level: clean(concept.technologyLevel ?? concept.technology_level, 80),
  }
}
