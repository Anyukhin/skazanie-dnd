import { cellAt, deserializeTacticalMap } from './tactical-map.mjs'

const clean = (value, maximum) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)

/** Видимая обстановка у действующего лица, без скрытых комнат и бинарных слоёв карты. */
export function sceneContextForAgent(state = {}, actorId = '') {
  const scene = state.scene ?? {}
  const context = Object.fromEntries(['title', 'location', 'mood', 'objective', 'theme', 'scene_kind'].map((key) => [key, clean(scene[key], 300)]))
  if (!scene.map?.zones?.length) return context
  let map
  try { map = scene.map.layers?.present instanceof Uint8Array ? scene.map : deserializeTacticalMap(scene.map) }
  catch { return context }
  const id = String(actorId || state.activePlayerId || '')
  const actor = [...(state.players ?? []), ...(state.actors ?? [])].find((entry) => entry.id === id)
  const position = state.mechanics?.positions?.[id] ?? actor
    ?? state.npc_world?.placements?.find((entry) => entry.npc_id === id && entry.location_id === scene.location_id)
  const at = position ? cellAt(map, Number(position.x), Number(position.y)) : null
  const currentZone = at?.revealed ? map.zones.find((zone) => zone.id === at.zone) : null
  const discovered = new Set()
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (cell?.revealed && cell.passable && cell.zone) discovered.add(cell.zone)
  }
  const objects = map.props.filter((prop) => {
    const cell = cellAt(map, Math.floor(prop.x), Math.floor(prop.y))
    const footprintVisible = !prop.footprint?.length || prop.footprint.every((point) => cellAt(map, point.x, point.y)?.revealed)
    return cell?.revealed && (!currentZone || cell.zone === currentZone.id)
      && footprintVisible && !['broken', 'destroyed'].includes(prop.state)
  }).sort((left, right) => position
    ? Math.hypot(left.x - position.x, left.y - position.y) - Math.hypot(right.x - position.x, right.y - position.y)
    : String(left.id).localeCompare(String(right.id))).slice(0, 16).map((prop) => ({ kind: prop.assetId, x: prop.x, y: prop.y, state: prop.state }))
  return { ...context,
    ...(currentZone ? { id: `${scene.location_id || scene.location}:${currentZone.id}`, theme: currentZone.label || currentZone.kind } : {}),
    spatial_context: {
      schema_version: 1,
      current_area: currentZone ? { name: currentZone.label, indoors: currentZone.kind === 'interior' } : null,
      known_areas: map.zones.filter((zone) => discovered.has(zone.id) && zone.label).slice(0, 16).map((zone) => zone.label),
      objects,
    },
  }
}

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
