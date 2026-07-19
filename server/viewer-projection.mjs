import { merchantIsAtLocation, publicMerchantFor } from './merchant-economy.mjs'
import { npcSocialForViewer } from './npc-social.mjs'
import { projectVisibleState } from './security.mjs'
import { worldMemoryForViewer } from './world-memory.mjs'

function text(value, maximum = 500) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, maximum)
}

function integer(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : fallback
}

function publicHistoryEntry(entry = {}) {
  return {
    chapter: Math.max(1, integer(entry.chapter, 1)),
    title: text(entry.title, 120),
    location: text(entry.location, 180),
    objective: text(entry.objective, 500),
    outcome: text(entry.outcome, 500),
    ...(entry.status == null ? {} : { status: text(entry.status, 40) }),
  }
}

/** The browser receives narrative continuity, never arbitrary private buckets. */
export function publicAdventureFor(adventure = {}) {
  return {
    chapter: Math.max(1, integer(adventure.chapter, 1)),
    ...(adventure.currentHook == null ? {} : { currentHook: text(adventure.currentHook, 500) }),
    ...(adventure.lastTransition == null ? {} : { lastTransition: text(adventure.lastTransition, 1_000) }),
    unresolvedThreads: (Array.isArray(adventure.unresolvedThreads) ? adventure.unresolvedThreads : [])
      .map((entry) => text(entry, 500)).filter(Boolean).slice(-20),
    visitedLocations: (Array.isArray(adventure.visitedLocations) ? adventure.visitedLocations : [])
      .map((entry) => text(entry, 180)).filter(Boolean).slice(-50),
    history: (Array.isArray(adventure.history) ? adventure.history : [])
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .map(publicHistoryEntry).slice(-20),
  }
}

export function publicWorldMapFor(worldMap = {}) {
  const locationIds = new Set((Array.isArray(worldMap.locations) ? worldMap.locations : []).map((location) => text(location?.id, 100)).filter(Boolean))
  return {
    version: Math.max(1, integer(worldMap.version, 1)),
    seed: text(worldMap.seed, 120),
    name: text(worldMap.name, 160),
    width: Math.max(320, Math.min(2000, integer(worldMap.width, 1000))),
    height: Math.max(240, Math.min(1200, integer(worldMap.height, 640))),
    currentLocationId: locationIds.has(text(worldMap.currentLocationId, 100)) ? text(worldMap.currentLocationId, 100) : '',
    regions: (Array.isArray(worldMap.regions) ? worldMap.regions : []).slice(0, 12).map((region) => ({
      id: text(region?.id, 100), name: text(region?.name, 120), biome: text(region?.biome, 40),
      x: integer(region?.x, 0), y: integer(region?.y, 0), radius: integer(region?.radius, 180),
    })),
    locations: (Array.isArray(worldMap.locations) ? worldMap.locations : []).slice(0, 50).map((location) => ({
      id: text(location?.id, 100), name: text(location?.name, 160), kind: text(location?.kind, 40),
      x: integer(location?.x, 0), y: integer(location?.y, 0), regionId: text(location?.regionId, 100),
      summary: text(location?.summary, 500), known: location?.known !== false, visited: location?.visited === true,
    })),
    routes: (Array.isArray(worldMap.routes) ? worldMap.routes : []).slice(0, 100)
      .filter((route) => locationIds.has(text(route?.from, 100)) && locationIds.has(text(route?.to, 100)))
      .map((route) => ({
        id: text(route?.id, 100), from: text(route?.from, 100), to: text(route?.to, 100), kind: text(route?.kind, 40),
        distance: Math.max(1, integer(route?.distance, 1)), danger: text(route?.danger, 40), discovered: route?.discovered !== false,
      })),
  }
}

function publicCellFor(cell = {}) {
  const revealed = cell.revealed === true
  const material = String(cell.material ?? '')
  const pattern = String(cell.pattern ?? '')
  const allowedMaterials = new Set(['stone', 'wood', 'earth', 'grass', 'sand', 'metal', 'marble', 'ice'])
  const allowedPatterns = new Set(['small-room', 'great-hall', 'keep', 'courtyard', 'crypt', 'cave-cluster', 'village', 'bridge', 'natural'])
  return {
    x: integer(cell.x),
    y: integer(cell.y),
    type: ['wall', 'floor', 'water', 'door'].includes(String(cell.type)) ? String(cell.type) : 'floor',
    revealed,
    ...(allowedMaterials.has(material) ? { material } : {}),
    ...(allowedPatterns.has(pattern) ? { pattern } : {}),
    ...(Number.isSafeInteger(Number(cell.variant)) ? { variant: Math.max(0, Math.min(5, Number(cell.variant))) } : {}),
    ...(typeof cell.edge_mask === 'string' && /^[nesw]{0,4}$/.test(cell.edge_mask) ? { edge_mask: cell.edge_mask } : {}),
    ...(revealed && cell.feature != null ? { feature: text(cell.feature, 40) } : {}),
  }
}

export function publicSceneFor(scene = {}) {
  return {
    title: text(scene.title, 120),
    location: text(scene.location, 180),
    mood: text(scene.mood, 500),
    objective: text(scene.objective, 500),
    turn: Math.max(0, integer(scene.turn, 0)),
    cells: (Array.isArray(scene.cells) ? scene.cells : []).map(publicCellFor).slice(0, 500),
    ...(scene.theme == null ? {} : { theme: text(scene.theme, 120) }),
    ...(scene.danger == null ? {} : { danger: text(scene.danger, 40) }),
    ...(scene.scene_kind == null ? {} : { scene_kind: text(scene.scene_kind, 40) }),
    ...(scene.settlement_type == null ? {} : { settlement_type: text(scene.settlement_type, 40) }),
  }
}

export function publicEnemyFor(enemy = {}) {
  return {
    id: text(enemy.id ?? enemy.actor_id, 120),
    name: text(enemy.name, 120),
    hp: Math.max(0, integer(enemy.hp, 0)),
    maxHp: Math.max(1, integer(enemy.maxHp ?? enemy.max_hp, 1)),
    armor: Math.max(0, integer(enemy.armor ?? enemy.armor_class, 10)),
    speed: Math.max(0, integer(enemy.speed, 0)),
    x: integer(enemy.x, 0),
    y: integer(enemy.y, 0),
    alive: enemy.alive !== false && integer(enemy.hp, 0) > 0,
    ...(enemy.stat_block_id == null ? {} : { stat_block_id: text(enemy.stat_block_id, 120) }),
  }
}

export function publicEncounterFor(encounter = {}) {
  if (!encounter || typeof encounter !== 'object' || Array.isArray(encounter)) return null
  return {
    id: text(encounter.id ?? encounter.encounter_id, 120),
    status: ['staged', 'active', 'ended'].includes(String(encounter.status)) ? String(encounter.status) : 'staged',
    difficulty: text(encounter.difficulty, 40),
    theme: text(encounter.theme, 40),
    proposal_id: text(encounter.proposal_id, 120),
    enemy_ids: (Array.isArray(encounter.enemy_ids) ? encounter.enemy_ids : []).map((id) => text(id, 120)).filter(Boolean).slice(0, 12),
    threat: encounter.threat && typeof encounter.threat === 'object' ? {
      budget_xp: Math.max(0, integer(encounter.threat.budget_xp, 0)),
      spent_xp: Math.max(0, integer(encounter.threat.spent_xp, 0)),
      quantity: Math.max(0, integer(encounter.threat.quantity, 0)),
    } : undefined,
  }
}

function publicReactionWindowFor(window) {
  if (!window || typeof window !== 'object' || Array.isArray(window)) return null
  return {
    id: text(window.id, 160),
    trigger: text(window.trigger, 80),
    actor_id: text(window.actor_id, 120),
    source_actor_id: text(window.source_actor_id, 120),
    target_id: text(window.target_id, 120),
    action_ids: (Array.isArray(window.action_ids) ? window.action_ids : []).map((id) => text(id, 120)).filter(Boolean).slice(0, 20),
    action_options: (Array.isArray(window.action_options) ? window.action_options : []).slice(0, 20).map((option) => ({
      id: text(option?.id, 120),
      name: text(option?.name, 160),
      description: text(option?.description, 500),
      ...(option?.resource == null ? {} : { resource: text(option.resource, 120) }),
      ...(option?.cost == null ? {} : { cost: Math.max(0, integer(option.cost, 0)) }),
    })),
    ...(window.trigger_roll && typeof window.trigger_roll === 'object' ? {
      trigger_roll: {
        kept: integer(window.trigger_roll.kept, 0),
        modifier: integer(window.trigger_roll.modifier, 0),
        total: integer(window.trigger_roll.total, 0),
        difficulty: Math.max(0, integer(window.trigger_roll.difficulty, 0)),
        ability: text(window.trigger_roll.ability, 20),
        save_event_type: text(window.trigger_roll.save_event_type, 80),
      },
    } : {}),
    ...(window.fighter_level == null ? {} : { fighter_level: Math.max(1, integer(window.fighter_level, 1)) }),
    ...(window.damage && typeof window.damage === 'object' ? { damage: { ...window.damage } } : {}),
    ...(window.pending_spell && typeof window.pending_spell === 'object' ? { pending_spell: { ...window.pending_spell } } : {}),
  }
}

function viewerFor(state, user, actorId) {
  return {
    role: user?.role === 'admin' ? 'admin' : 'player',
    playerId: String(actorId ?? ''),
    partyIds: Array.isArray(state?.partyMemberIds) ? state.partyMemberIds.map(String) : [],
    isPartyMember: true,
  }
}

/**
 * Produces a non-admin campaign projection shared by room, command and narration
 * responses. It is deliberately stricter than the internal event-sourced state.
 */
export function campaignStateForViewer(state, user, actorId = '') {
  if (!state || typeof state !== 'object') return state
  if (user?.role === 'admin') return state
  const visible = projectVisibleState(state, viewerFor(state, user, actorId), { forNarrator: true }) ?? {}
  const scene = publicSceneFor(visible.scene ?? state.scene)
  const location = scene.location
  const merchants = (Array.isArray(visible.merchants) ? visible.merchants : [])
    .filter((merchant) => merchant.available !== false && merchantIsAtLocation(merchant.location, location))
    .map(publicMerchantFor)
  const enemies = (Array.isArray(visible.enemies) ? visible.enemies : []).map(publicEnemyFor)
  const mechanics = visible.mechanics && typeof visible.mechanics === 'object'
    ? {
      ...visible.mechanics,
      encounter: publicEncounterFor(visible.mechanics.encounter),
      ...(visible.mechanics.combat && typeof visible.mechanics.combat === 'object' ? {
        combat: {
          ...visible.mechanics.combat,
          reaction_window: publicReactionWindowFor(visible.mechanics.combat.reaction_window),
        },
      } : {}),
    }
    : visible.mechanics
  return {
    ...visible,
    scene,
    adventure: publicAdventureFor(visible.adventure),
    worldMap: publicWorldMapFor(visible.worldMap ?? state.worldMap),
    worldMemory: worldMemoryForViewer(state.worldMemory, {
      playerId: String(actorId ?? ''),
      isAdmin: false,
      isPartyMember: true,
    }),
    social: npcSocialForViewer(state.social, {
      playerId: String(actorId ?? ''),
      isAdmin: false,
      isPartyMember: true,
    }),
    merchants,
    enemies,
    mechanics,
  }
}

function eventForViewer(event, user, actorId) {
  const visible = projectVisibleState(event, viewerFor({}, user, actorId), { forNarrator: true })
  if (!visible) return null
  const payload = visible.payload && typeof visible.payload === 'object' && !Array.isArray(visible.payload)
    ? { ...visible.payload }
    : {}
  if (visible.event_type === 'SceneAdvanced') {
    payload.scene = publicSceneFor(payload.scene)
    payload.adventure = publicAdventureFor(payload.adventure)
    payload.worldMap = publicWorldMapFor(payload.worldMap)
  }
  if (visible.event_type === 'MerchantCreated' && payload.merchant) {
    payload.merchant = publicMerchantFor(payload.merchant)
  }
  if (visible.event_type === 'EncounterCreated' && payload.encounter) {
    payload.encounter = {
      ...publicEncounterFor(payload.encounter),
      enemies: (Array.isArray(payload.encounter.enemies) ? payload.encounter.enemies : []).map(publicEnemyFor),
    }
  }
  if (visible.event_type === 'AbilityCheckResolved' && payload.social_check) {
    delete payload.difficulty
    payload.social_check = {
      check_id: String(payload.social_check.check_id ?? ''),
      npc_id: String(payload.social_check.npc_id ?? ''),
      skill: String(payload.social_check.skill ?? payload.skill ?? ''),
      difficulty_hidden: true,
    }
  }
  if (visible.event_type === 'ReactionWindowOpened') {
    return { ...visible, payload: publicReactionWindowFor(payload) }
  }
  return { ...visible, payload }
}

export function mechanicsForViewer(events, user, actorId = '') {
  if (!Array.isArray(events) || user?.role === 'admin') return events
  return events.map((event) => eventForViewer(event, user, actorId)).filter(Boolean)
}

export function sceneTransitionForViewer(transition) {
  if (!transition || typeof transition !== 'object' || Array.isArray(transition)) return transition
  return {
    scene: publicSceneFor(transition.scene),
    adventure: publicAdventureFor(transition.adventure),
    worldMap: publicWorldMapFor(transition.worldMap),
    transition: text(transition.transition, 2_000),
    arrival: text(transition.arrival, 2_000),
    suggestions: (Array.isArray(transition.suggestions) ? transition.suggestions : []).map((entry) => text(entry, 200)).filter(Boolean).slice(0, 3),
    entrance: {
      x: integer(transition.entrance?.x),
      y: integer(transition.entrance?.y),
    },
  }
}

/** Sanitizes every public surface of a command/narration result consistently. */
export function turnResultForViewer(result, user, actorId = '') {
  if (!result || typeof result !== 'object' || user?.role === 'admin') return result
  const visible = projectVisibleState(result, viewerFor(result.authoritative_state, user, actorId), { forNarrator: true }) ?? {}
  const effects = visible.effects && typeof visible.effects === 'object' && !Array.isArray(visible.effects)
    ? { ...visible.effects }
    : visible.effects
  if (effects?.scene) effects.scene = sceneTransitionForViewer(effects.scene)
  return {
    ...visible,
    effects,
    mechanics: mechanicsForViewer(result.mechanics, user, actorId),
    ...(result.authoritative_state ? { authoritative_state: campaignStateForViewer(result.authoritative_state, user, actorId) } : {}),
  }
}
