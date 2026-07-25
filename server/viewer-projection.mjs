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
  const currentLocationId = text(worldMap.currentLocationId, 100)
  const locations = (Array.isArray(worldMap.locations) ? worldMap.locations : [])
    .filter((location) => location?.known !== false || location?.visited === true || text(location?.id, 100) === currentLocationId)
    .slice(0, 50)
  const locationIds = new Set(locations.map((location) => text(location?.id, 100)).filter(Boolean))
  const regionIds = new Set(locations.map((location) => text(location?.regionId, 100)).filter(Boolean))
  return {
    version: Math.max(1, integer(worldMap.version, 1)),
    name: text(worldMap.name, 160),
    width: Math.max(320, Math.min(2000, integer(worldMap.width, 1000))),
    height: Math.max(240, Math.min(1200, integer(worldMap.height, 640))),
    currentLocationId: locationIds.has(currentLocationId) ? currentLocationId : '',
    regions: (Array.isArray(worldMap.regions) ? worldMap.regions : [])
      .filter((region) => regionIds.has(text(region?.id, 100)))
      .slice(0, 12).map((region) => ({
      id: text(region?.id, 100), name: text(region?.name, 120), biome: text(region?.biome, 40),
      x: integer(region?.x, 0), y: integer(region?.y, 0), radius: integer(region?.radius, 180),
    })),
    locations: locations.map((location) => ({
      id: text(location?.id, 100), name: text(location?.name, 160), kind: text(location?.kind, 40),
      x: integer(location?.x, 0), y: integer(location?.y, 0), regionId: text(location?.regionId, 100),
      summary: text(location?.summary, 500), known: location?.known !== false, visited: location?.visited === true,
    })),
    routes: (Array.isArray(worldMap.routes) ? worldMap.routes : []).slice(0, 100)
      .filter((route) => route?.discovered !== false && locationIds.has(text(route?.from, 100)) && locationIds.has(text(route?.to, 100)))
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

function enemyKnowledgeFor(state, enemyId, actorId = '') {
  const registry = state?.mechanics?.enemy_knowledge
  const entry = registry?.party?.[enemyId] ?? registry?.[enemyId] ?? {}
  const knownBy = Array.isArray(entry?.known_by) ? entry.known_by.map(String) : null
  return knownBy && actorId && !knownBy.includes(String(actorId)) ? {} : entry
}

function enemyHealthStatus(enemy = {}) {
  if (enemy.hp == null && enemy.maxHp == null) return enemy.alive === false ? 'defeated' : text(enemy.healthStatus, 20) || 'unharmed'
  const hp = Math.max(0, integer(enemy.hp, 0))
  const maximum = Math.max(1, integer(enemy.maxHp ?? enemy.max_hp, 1))
  if (enemy.alive === false || hp <= 0) return 'defeated'
  const ratio = hp / maximum
  if (ratio >= 1) return 'unharmed'
  if (ratio > .5) return 'wounded'
  if (ratio > .25) return 'bloodied'
  return 'critical'
}

function exactEnemyFact(knowledge, key) {
  return knowledge?.[key] === 'exact' || knowledge?.[key] === true
}

function exactEnemyHealthKnown(state, enemyId, actorId = '') {
  const knowledge = enemyKnowledgeFor(state, enemyId, actorId)
  return knowledge?.health === 'exact' || exactEnemyFact(knowledge, 'hp') || knowledge?.exact_hp === true
}

export function publicEnemyFor(enemy = {}, state = {}, actorId = '') {
  const id = text(enemy.id ?? enemy.actor_id, 120)
  const knowledge = enemyKnowledgeFor(state, id, actorId)
  const exactHealth = exactEnemyHealthKnown(state, id, actorId)
  return {
    id,
    name: text(enemy.name, 120),
    x: integer(enemy.x, 0),
    y: integer(enemy.y, 0),
    alive: enemy.alive !== false && (enemy.hp == null || integer(enemy.hp, 0) > 0),
    healthStatus: enemyHealthStatus(enemy),
    healthKnown: exactHealth ? 'exact' : 'banded',
    ...(exactHealth ? {
      hp: Math.max(0, integer(enemy.hp, 0)),
      maxHp: Math.max(1, integer(enemy.maxHp ?? enemy.max_hp, 1)),
    } : {}),
    ...(exactEnemyFact(knowledge, 'armor_class') || exactEnemyFact(knowledge, 'armor') ? {
      armor: Math.max(0, integer(enemy.armor ?? enemy.armor_class, 10)),
    } : {}),
    ...(exactEnemyFact(knowledge, 'speed') ? { speed: Math.max(0, integer(enemy.speed, 0)) } : {}),
    ...(exactEnemyFact(knowledge, 'stat_block') && enemy.stat_block_id != null ? { stat_block_id: text(enemy.stat_block_id, 120) } : {}),
  }
}

function publicInitiativeFor(initiative, state, actorId = '') {
  const enemyIds = new Set((state?.enemies ?? []).map((enemy) => text(enemy?.id ?? enemy?.actor_id, 120)))
  return (Array.isArray(initiative) ? initiative : []).map((entry) => {
    const entryId = text(entry?.actor_id, 120)
    if (!enemyIds.has(entryId)) return entry
    return {
      actor_id: entryId,
      ...(entry?.shared_with == null ? {} : { shared_with: text(entry.shared_with, 120) }),
    }
  })
}

function publicBattleEventFor(entry, state, actorId = '') {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
  const result = { ...entry }
  const targetId = text(entry.targetId ?? entry.target_id, 120)
  const actingId = text(entry.actorId ?? entry.actor_id, 120)
  const enemyIds = new Set((state?.enemies ?? []).map((enemy) => text(enemy?.id ?? enemy?.actor_id, 120)))
  if (enemyIds.has(targetId) && !exactEnemyHealthKnown(state, targetId, actorId)) {
    delete result.hpBefore
    delete result.hpAfter
    delete result.maximumHpBefore
    delete result.maximumHpAfter
    if (result.roll && typeof result.roll === 'object') {
      result.roll = { ...result.roll }
      delete result.roll.difficulty
    }
  }
  if (enemyIds.has(actingId) && result.roll && typeof result.roll === 'object') {
    result.roll = {
      total: integer(result.roll.total, 0),
      hit: result.roll.hit === true,
    }
  }
  return result
}

function publicCombatMessageFor(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message
  const isCombatMessage = String(message.id ?? '').startsWith('combat-') || String(message.author ?? '').toLocaleLowerCase('ru').includes('система боя')
  if (!isCombatMessage || typeof message.text !== 'string') return message
  return {
    ...message,
    text: message.text
      .replace(/\s+против КД\s+\d+\s+—/gu, ' —')
      .replace(/;\s*ОЗ\s+\d+\s*→\s*\d+/gu, '')
      .replace(/,\s*но Охрана от смерти срабатывает и оставляет 1 ОЗ/gu, ', но Охрана от смерти удерживает цель на ногах')
      .replace(/Максимум ОЗ ([^.]+?) снижается:\s*\d+\s*→\s*\d+/gu, 'Максимум ОЗ $1 снижается'),
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

function publicReactionWindowFor(window, state = {}, actorId = '') {
  if (!window || typeof window !== 'object' || Array.isArray(window)) return null
  const enemyIds = new Set((state?.enemies ?? []).map((enemy) => text(enemy?.id ?? enemy?.actor_id, 120)))
  const targetId = text(window.target_id, 120)
  const enemyTarget = enemyIds.has(targetId)
  const enemySource = enemyIds.has(text(window.source_actor_id, 120))
  const triggerRoll = window.trigger_roll && typeof window.trigger_roll === 'object'
    ? {
      kept: integer(window.trigger_roll.kept, 0),
      modifier: integer(window.trigger_roll.modifier, 0),
      total: integer(window.trigger_roll.total, 0),
      difficulty: Math.max(0, integer(window.trigger_roll.difficulty, 0)),
      ability: text(window.trigger_roll.ability, 20),
      save_event_type: text(window.trigger_roll.save_event_type, 80),
    }
    : null
  if (triggerRoll && enemyTarget) delete triggerRoll.difficulty
  if (triggerRoll && enemySource) {
    delete triggerRoll.kept
    delete triggerRoll.modifier
  }
  const damage = window.damage && typeof window.damage === 'object' ? { ...window.damage } : null
  if (damage && enemyTarget && !exactEnemyHealthKnown(state, targetId, actorId)) {
    for (const key of ['hp', 'max_hp', 'hp_before', 'hp_after', 'maximum_hp_before', 'maximum_hp_after', 'temporary_hp_before', 'temporary_hp_after']) delete damage[key]
  }
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
    ...(triggerRoll ? { trigger_roll: triggerRoll } : {}),
    ...(window.fighter_level == null ? {} : { fighter_level: Math.max(1, integer(window.fighter_level, 1)) }),
    ...(damage ? { damage } : {}),
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
  const { locationMaps: _locationMaps, ...publicState } = visible
  const scene = publicSceneFor(visible.scene ?? state.scene)
  const location = scene.location
  const merchants = (Array.isArray(visible.merchants) ? visible.merchants : [])
    .filter((merchant) => merchant.available !== false && merchantIsAtLocation(merchant, state?.scene ?? location))
    .map(publicMerchantFor)
  const enemies = (Array.isArray(visible.enemies) ? visible.enemies : []).map((enemy) => publicEnemyFor(enemy, state, actorId))
  const mechanics = visible.mechanics && typeof visible.mechanics === 'object'
    ? (() => {
      const { enemy_knowledge: _enemyKnowledge, ...publicMechanics } = visible.mechanics
      return {
      ...publicMechanics,
      encounter: publicEncounterFor(visible.mechanics.encounter),
      ...(visible.mechanics.combat && typeof visible.mechanics.combat === 'object' ? {
        combat: {
          ...visible.mechanics.combat,
          initiative: publicInitiativeFor(visible.mechanics.combat.initiative, state, actorId),
          reaction_window: publicReactionWindowFor(visible.mechanics.combat.reaction_window, state, actorId),
        },
      } : {}),
    }})()
    : visible.mechanics
  return {
    ...publicState,
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
      state,
    }),
    merchants,
    enemies,
    mechanics,
    battleLog: (Array.isArray(visible.battleLog) ? visible.battleLog : []).map((entry) => publicBattleEventFor(entry, state, actorId)),
    messages: (Array.isArray(visible.messages) ? visible.messages : []).map(publicCombatMessageFor),
  }
}

function eventForViewer(event, user, actorId, state = {}) {
  const visible = projectVisibleState(event, viewerFor(state, user, actorId), { forNarrator: true })
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
      enemies: (Array.isArray(payload.encounter.enemies) ? payload.encounter.enemies : []).map((enemy) => publicEnemyFor(enemy, state, actorId)),
    }
  }
  const targetIds = (Array.isArray(visible.target_ids) ? visible.target_ids : []).map(String)
  const enemyIds = new Set((state?.enemies ?? []).map((enemy) => text(enemy?.id ?? enemy?.actor_id, 120)))
  const enemyTargetId = targetIds.find((id) => enemyIds.has(id)) ?? (enemyIds.has(String(payload.target_id ?? '')) ? String(payload.target_id) : '')
  const enemyActor = enemyIds.has(String(visible.actor_id ?? ''))
  if (enemyTargetId && !exactEnemyHealthKnown(state, enemyTargetId, actorId)) {
    for (const key of ['hp', 'max_hp', 'hp_before', 'hp_after', 'maximum_hp', 'maximum_hp_before', 'maximum_hp_after', 'temporary_hp_before', 'temporary_hp_after', 'armor_class']) delete payload[key]
  }
  if (visible.event_type === 'CombatStarted') {
    payload.initiative = publicInitiativeFor(payload.initiative, state, actorId)
  }
  if (enemyActor) {
    for (const key of ['modifier', 'kept', 'attack_bonus', 'damage_expression', 'damage_dice', 'action_id', 'dice', 'expression']) delete payload[key]
  }
  if (enemyTargetId && ['SavingThrowResolved', 'AbilityCheckResolved'].includes(String(visible.event_type))) {
    for (const key of ['modifier', 'kept', 'dice', 'roll_id']) delete payload[key]
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
    return { ...visible, payload: publicReactionWindowFor(payload, state, actorId) }
  }
  return { ...visible, payload }
}

export function mechanicsForViewer(events, user, actorId = '', state = {}) {
  if (!Array.isArray(events) || user?.role === 'admin') return events
  return events.map((event) => eventForViewer(event, user, actorId, state)).filter(Boolean)
}

export function turnExplanationForViewer(explanation, user, actorId = '', state = {}) {
  if (!explanation || typeof explanation !== 'object' || user?.role === 'admin') return explanation
  const enemyIds = new Set((state?.enemies ?? []).map((enemy) => text(enemy?.id ?? enemy?.actor_id, 120)))
  return {
    ...explanation,
    commands: (Array.isArray(explanation.commands) ? explanation.commands : []).map((command) => {
      if (!enemyIds.has(String(command?.actor_id ?? ''))) return command
      return {
        type: text(command?.type ?? command?.command_type, 80),
        actor_id: text(command?.actor_id, 120),
        ...(command?.target_id == null ? {} : { target_id: text(command.target_id, 120) }),
      }
    }),
    rolls: (Array.isArray(explanation.rolls) ? explanation.rolls : []).map((roll) => {
      if (!enemyIds.has(String(roll?.actor_id ?? roll?.actorId ?? ''))) return roll
      return {
        roll_id: text(roll?.roll_id ?? roll?.id, 160),
        purpose: text(roll?.purpose, 80),
        total: integer(roll?.total, 0),
        visibility: text(roll?.visibility, 40),
      }
    }),
    events: mechanicsForViewer(explanation.events, user, actorId, state),
  }
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
  const { locationMaps: _locationMaps, ...publicResult } = visible
  const effects = visible.effects && typeof visible.effects === 'object' && !Array.isArray(visible.effects)
    ? { ...visible.effects }
    : visible.effects
  if (effects?.scene) effects.scene = sceneTransitionForViewer(effects.scene)
  const enemyIds = new Set((result.authoritative_state?.enemies ?? []).map((enemy) => text(enemy?.id ?? enemy?.actor_id, 120)))
  if (effects?.roll && enemyIds.has(String(effects.roll.actor_id ?? ''))) {
    effects.roll = {
      roll_id: text(effects.roll.roll_id, 160),
      actor_id: text(effects.roll.actor_id, 120),
      total: integer(effects.roll.total, 0),
      label: text(effects.roll.label, 120),
      ...(typeof effects.roll.success === 'boolean' ? { success: effects.roll.success } : {}),
    }
  }
  return {
    ...publicResult,
    effects,
    mechanics: mechanicsForViewer(result.mechanics, user, actorId, result.authoritative_state),
    ...(Array.isArray(visible.visible_state_changes) ? {
      visible_state_changes: mechanicsForViewer(visible.visible_state_changes, user, actorId, result.authoritative_state),
    } : {}),
    ...(result.authoritative_state ? { authoritative_state: campaignStateForViewer(result.authoritative_state, user, actorId) } : {}),
  }
}
