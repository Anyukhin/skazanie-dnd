import { cellAt, deserializeTacticalMap } from './tactical-map.mjs'
import { campaignModeFor } from './campaign-stories.mjs'
import { questStateForViewer } from './quest-consequences.mjs'

const clean = (value, maximum) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
export const AGENT_CONTEXT_SCHEMA_VERSION = 1
export const SPATIAL_CONTEXT_SCHEMA_VERSION = 2

function safeIdentifier(value, maximum = 120) {
  const result = clean(value, maximum)
  return result || null
}

function safeStateVersion(state = {}) {
  const value = Number(state.state_version ?? state.stateVersion ?? state.version)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function campaignIdFor(state = {}) {
  return safeIdentifier(state.sessionCode ?? state.campaign_id ?? state.campaignId ?? state.campaign?.id)
}

/**
 * Метаданные вызова принадлежат серверу и не принимаются из ответа модели.
 * Они нужны для привязки ответа к роли, актёру, кампании, версии состояния и
 * контракту роли;
 * отдельного долговечного реестра контекстов для этого не требуется.
 */
export function agentContextMetadata(state = {}, { role = 'unknown', actorId = null, targetId = null, contractVersion = null } = {}) {
  return {
    role: clean(role, 80) || 'unknown',
    actor_id: safeIdentifier(actorId),
    target_id: safeIdentifier(targetId),
    campaign_id: campaignIdFor(state),
    state_version: safeStateVersion(state),
    contract_version: safeIdentifier(contractVersion, 80),
    schema_version: AGENT_CONTEXT_SCHEMA_VERSION,
  }
}

/**
 * Метаданные ограниченной выборки. `candidateCount` должен быть посчитан уже
 * после фильтрации доступности, поэтому скрытые записи не влияют на полноту.
 */
export function boundedSelectionMetadata({ scope, candidateCount = 0, limit = 0, sourceAvailable = true } = {}) {
  const boundedLimit = Math.max(0, Number(limit) || 0)
  if (!sourceAvailable) return {
    scope: clean(scope, 160), status: 'unavailable', availability: 'unavailable',
    complete_within_scope: null, truncation_reason: 'source_unavailable',
  }
  const count = Math.max(0, Number(candidateCount) || 0)
  const truncated = count > boundedLimit
  return {
    scope: clean(scope, 160), status: truncated ? 'truncated' : count ? 'complete' : 'empty',
    availability: 'available', complete_within_scope: !truncated,
    ...(truncated ? { truncation_reason: 'item_limit' } : {}),
  }
}

function selectionFields(metadata, prefix) {
  return {
    [`${prefix}_scope`]: metadata.scope,
    [`${prefix}_status`]: metadata.status,
    [`${prefix}_availability`]: metadata.availability,
    [`${prefix}_complete_within_scope`]: metadata.complete_within_scope,
    ...(metadata.truncation_reason ? { [`${prefix}_truncation_reason`]: metadata.truncation_reason } : {}),
  }
}

function unavailableSpatialContext() {
  const objects = boundedSelectionMetadata({ scope: 'visible_interactable_objects_in_current_area', sourceAvailable: false })
  const areas = boundedSelectionMetadata({ scope: 'visible_discovered_areas_in_current_location', sourceAvailable: false })
  return {
    schema_version: SPATIAL_CONTEXT_SCHEMA_VERSION,
    current_area: null,
    known_areas: [],
    known_area_ids: [],
    objects: [],
    ...selectionFields(areas, 'known_areas'),
    ...selectionFields(objects, 'objects'),
  }
}

/** Видимая обстановка у действующего лица, без скрытых комнат и бинарных слоёв карты. */
export function sceneContextForAgent(state = {}, actorId = '') {
  const scene = state.scene ?? {}
  const context = Object.fromEntries(['title', 'location', 'mood', 'objective', 'theme', 'scene_kind'].map((key) => [key, clean(scene[key], 300)]))
  const metadata = agentContextMetadata(state, { role: 'scene_context', actorId, contractVersion: 'scene-context/v2' })
  if (!scene.map || typeof scene.map !== 'object') return { ...context, context_metadata: metadata, spatial_context: unavailableSpatialContext() }
  let map
  try { map = scene.map.layers?.present instanceof Uint8Array ? scene.map : deserializeTacticalMap(scene.map) }
  catch { return { ...context, context_metadata: metadata, spatial_context: unavailableSpatialContext() } }
  const requiredLayers = ['present', 'passable', 'revealed', 'moveCost', 'surface', 'material', 'variant', 'elevation', 'zoneId']
  if (!Number.isSafeInteger(map?.width) || !Number.isSafeInteger(map?.height)
    || !requiredLayers.every((name) => ArrayBuffer.isView(map?.layers?.[name]))) {
    return { ...context, context_metadata: metadata, spatial_context: unavailableSpatialContext() }
  }
  const id = String(actorId || state.activePlayerId || '')
  const actor = [...(state.players ?? []), ...(state.actors ?? [])].find((entry) => entry.id === id)
  const position = state.mechanics?.positions?.[id] ?? actor
    ?? state.npc_world?.placements?.find((entry) => entry.npc_id === id && entry.location_id === scene.location_id)
  const at = position ? cellAt(map, Number(position.x), Number(position.y)) : null
  const zones = Array.isArray(map.zones) ? map.zones : []
  const props = Array.isArray(map.props) ? map.props : []
  const currentZone = at?.revealed ? zones.find((zone) => zone.id === at.zone) : null
  const discovered = new Set()
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const cell = cellAt(map, x, y)
    if (cell?.revealed && cell.passable && cell.zone) discovered.add(cell.zone)
  }
  const visibleObjects = props.filter((prop) => {
    const cell = cellAt(map, Math.floor(prop.x), Math.floor(prop.y))
    const footprintVisible = !prop.footprint?.length || prop.footprint.every((point) => cellAt(map, point.x, point.y)?.revealed)
    const visibility = String(prop.visibility ?? prop.interaction?.visibility ?? '').toLowerCase()
    return !['gm_only', 'npc_private'].includes(visibility)
      && cell?.revealed && (!currentZone || cell.zone === currentZone.id)
      && footprintVisible && !['broken', 'destroyed'].includes(prop.state)
  }).sort((left, right) => position
    ? Math.hypot(left.x - position.x, left.y - position.y) - Math.hypot(right.x - position.x, right.y - position.y)
    : String(left.id).localeCompare(String(right.id)))
  const objects = visibleObjects.slice(0, 16).map((prop) => ({ id: clean(prop.id, 120), kind: prop.assetId, x: prop.x, y: prop.y, state: prop.state }))
  const visibleAreas = zones.filter((zone) => discovered.has(zone.id) && zone.label)
  const objectSelection = boundedSelectionMetadata({ scope: 'visible_interactable_objects_in_current_area', candidateCount: visibleObjects.length, limit: 16 })
  const areaSelection = boundedSelectionMetadata({ scope: 'visible_discovered_areas_in_current_location', candidateCount: visibleAreas.length, limit: 16 })
  return { ...context,
    context_metadata: metadata,
    ...(currentZone ? { id: `${scene.location_id || scene.location}:${currentZone.id}`, theme: currentZone.label || currentZone.kind } : {}),
    spatial_context: {
      schema_version: SPATIAL_CONTEXT_SCHEMA_VERSION,
      current_area: currentZone ? { name: currentZone.label, indoors: currentZone.kind === 'interior' } : null,
      known_areas: visibleAreas.slice(0, 16).map((zone) => zone.label),
      known_area_ids: visibleAreas.slice(0, 16).map((zone) => clean(zone.id, 120)).filter(Boolean),
      objects,
      ...selectionFields(areaSelection, 'known_areas'),
      ...selectionFields(objectSelection, 'objects'),
    },
  }
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

/** Public, bounded campaign contract shared by every creative agent. */
export function campaignConceptForAgent(state = {}, viewer = { isPartyMember: true }) {
  const visibleState = questStateForViewer(state, viewer)
  const concept = visibleState.campaignConcept ?? visibleState.campaign_concept ?? {}
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
    ...(campaignModeFor(state) === 'persistent' ? {
      campaign_mode: 'persistent',
      quests_optional: true,
      wait_for_player_after_story: true,
      completed_stories: (Array.isArray(concept.story_history) ? concept.story_history : []).slice(-3).map((story) => ({
        story_id: clean(story.story_id, 120), title: clean(story.title, 180),
        outcome: clean(story.outcome, 30), summary: clean(story.summary, 600),
      })),
    } : {}),
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
    current_chapter: positiveInteger(visibleState.adventure?.chapter),
    arc_history: arcHistory,
  }
}
