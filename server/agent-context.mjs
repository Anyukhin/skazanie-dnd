const clean = (value, maximum) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

function positiveInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

/** Public, bounded campaign contract shared by every creative agent. */
export function campaignConceptForAgent(state = {}) {
  const concept = state.campaignConcept ?? state.campaign_concept ?? {}
  const arcHistory = (Array.isArray(concept.arc_history) ? concept.arc_history : [])
    .slice(-3)
    .map((entry) => ({
      arc_number: positiveInteger(entry?.arc_number),
      title: clean(entry?.title, 160),
      epilogue: clean(entry?.epilogue, 1_200),
      concluded_at: clean(entry?.concluded_at, 80),
    }))
    .filter((entry) => entry.arc_number && entry.epilogue)
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
    current_arc_number: positiveInteger(concept.arc?.arc_number),
    current_chapter: positiveInteger(state.adventure?.chapter),
    arc_history: arcHistory,
  }
}
