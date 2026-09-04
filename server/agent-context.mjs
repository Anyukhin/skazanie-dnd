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
  const factions = (Array.isArray(concept.factions) ? concept.factions : [])
    .slice(0, 6)
    .map((entry) => ({
      id: clean(entry?.id, 80),
      name: clean(entry?.name, 120),
      summary: clean(entry?.summary, 360),
      goal: clean(entry?.goal, 240),
    }))
    .filter((entry) => entry.id && entry.name && entry.summary)
  const storyArcs = (Array.isArray(concept.story_arcs) ? concept.story_arcs : Array.isArray(concept.storyArcs) ? concept.storyArcs : [])
    .slice(0, 4)
    .map((entry) => ({
      title: clean(entry?.title, 160),
      levels: clean(entry?.levels, 40),
      summary: clean(entry?.summary, 520),
      stakes: clean(entry?.stakes, 360),
    }))
    .filter((entry) => entry.title && entry.summary)
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
    world_template_id: clean(concept.world_template_id ?? concept.worldTemplateId, 80),
    world_template_version: clean(concept.world_template_version ?? concept.worldTemplateVersion, 40),
    world_summary: clean(concept.worldSummary ?? concept.world_summary, 1_200),
    world_history: clean(concept.worldHistory ?? concept.world_history, 3_000),
    factions,
    story_arcs: storyArcs,
    current_arc_number: positiveInteger(concept.arc?.arc_number),
    current_chapter: positiveInteger(state.adventure?.chapter),
    arc_history: arcHistory,
  }
}
