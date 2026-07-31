import { createHash } from 'node:crypto'

import {
  inventoryStackKey,
  MAX_STOCK_QUANTITY,
  normalizeInventoryItem,
} from './merchant-economy.mjs'
import { factionIdsForNpc } from './reputation-policy.mjs'
import { cellAt, deserializeTacticalMap } from './tactical-map.mjs'

export const NPC_WORLD_POLICY_ID = 'skazanie:npc-world-v1'
export const NPC_WORLD_COMMAND_TYPES = new Set(['PlaceNpc', 'MoveNpc', 'HarmNpc'])
export const MAX_NPC_INVENTORY_OWNERS = 500
export const MAX_NPC_INVENTORY_ITEMS = 100

const STANCES = new Set(['neutral', 'guarded', 'frightened', 'hostile', 'fleeing', 'dead'])
const MAX_PLACEMENTS = 5_000
const MAX_VISIBLE_NPCS = 100
const MAX_PROPAGATED_NPCS = 24

const clone = (value) => structuredClone(value)
const text = (value, maximum = 180) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum)
const integer = (value, fallback = 0) => Number.isSafeInteger(Number(value)) ? Number(value) : fallback
const keyOf = (position) => `${Number(position?.x)},${Number(position?.y)}`
const distance = (left, right) => Math.max(Math.abs(Number(left?.x) - Number(right?.x)), Math.abs(Number(left?.y) - Number(right?.y)))
const comparable = (value) => text(value, 180).toLocaleLowerCase('ru')
const stableId = (...parts) => createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex').slice(0, 24)

export class NpcWorldValidationError extends Error {
  constructor(message, code = 'NPC_WORLD_INVALID') {
    super(message)
    this.name = 'NpcWorldValidationError'
    this.code = code
  }
}

function safePlacement(value = {}) {
  const npcId = text(value.npc_id, 120)
  const locationId = text(value.location_id, 180)
  const x = integer(value.x, Number.NaN)
  const y = integer(value.y, Number.NaN)
  if (!npcId || !locationId || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null
  return {
    npc_id: npcId,
    location_id: locationId,
    x,
    y,
    anchor_prop_id: text(value.anchor_prop_id, 120),
    placement_reason: text(value.placement_reason, 80) || 'deterministic-post',
    policy_id: NPC_WORLD_POLICY_ID,
    source_event_id: text(value.source_event_id, 120),
  }
}

function safeVital(value = {}) {
  const maximum = Math.max(1, Math.min(100, integer(value.max_hp, 4)))
  const hp = Math.max(0, Math.min(maximum, integer(value.hp, maximum)))
  return { hp, max_hp: maximum, alive: value.alive !== false && hp > 0 }
}

function safeStance(value = {}) {
  const stance = STANCES.has(String(value.stance)) ? String(value.stance) : 'neutral'
  return {
    stance,
    reason: text(value.reason, 120),
    source_event_id: text(value.source_event_id, 120),
    propagation_depth: Math.max(0, Math.min(1, integer(value.propagation_depth, 0))),
  }
}

function safeNpcInventory(value) {
  const inventory = []
  const stackIndexes = new Map()
  for (const raw of Array.isArray(value) ? value : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = normalizeInventoryItem({
      ...raw,
      equipped: false,
      attuned_to: null,
    }, { preserveUnknown: true })
    const stackKey = inventoryStackKey(item)
    const existingIndex = stackIndexes.get(stackKey)
    if (existingIndex != null) {
      inventory[existingIndex] = {
        ...inventory[existingIndex],
        quantity: Math.min(
          MAX_STOCK_QUANTITY,
          integer(inventory[existingIndex].quantity, 1) + integer(item.quantity, 1),
        ),
      }
      continue
    }
    if (inventory.length >= MAX_NPC_INVENTORY_ITEMS) continue
    stackIndexes.set(stackKey, inventory.length)
    inventory.push(item)
  }
  return inventory
}

export function normalizeNpcWorldState(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const placements = []
  const placementKeys = new Set()
  for (const raw of Array.isArray(source.placements) ? source.placements : []) {
    const placement = safePlacement(raw)
    const key = placement ? `${placement.location_id}\0${placement.npc_id}` : ''
    if (!placement || placementKeys.has(key)) continue
    placementKeys.add(key)
    placements.push(placement)
  }
  const vitals = Object.fromEntries(Object.entries(source.vitals ?? {}).slice(0, 500)
    .map(([npcId, value]) => [text(npcId, 120), safeVital(value)])
    .filter(([npcId]) => npcId))
  const stances = Object.fromEntries(Object.entries(source.stances ?? {}).slice(0, 500)
    .map(([npcId, value]) => [text(npcId, 120), safeStance(value)])
    .filter(([npcId]) => npcId))
  const inventoryEntries = []
  const inventoryIds = new Set()
  for (const [rawNpcId, value] of Object.entries(source.inventories ?? {})) {
    if (inventoryEntries.length >= MAX_NPC_INVENTORY_OWNERS) break
    const npcId = text(rawNpcId, 120)
    if (!npcId || inventoryIds.has(npcId)) continue
    const inventory = safeNpcInventory(value)
    if (!inventory.length) continue
    inventoryIds.add(npcId)
    inventoryEntries.push([npcId, inventory])
  }
  const inventories = Object.fromEntries(inventoryEntries)
  return {
    schema_version: 2,
    placements: placements.slice(-MAX_PLACEMENTS),
    vitals,
    stances,
    inventories,
  }
}

export function sceneLocationId(state = {}) {
  const explicit = text(state.scene?.location_id ?? state.scene?.locationId, 180)
  if (explicit) return explicit
  const fromMap = text(state.scene?.map?.locationId, 180)
  if (fromMap) return fromMap
  return text(state.scene?.location ?? state.scene?.title, 180)
}

function npcLocationMatchesCurrentScene(npc, state) {
  const currentId = comparable(sceneLocationId(state))
  const currentName = comparable(state.scene?.location ?? state.scene?.title)
  const location = comparable(npc?.location)
  if (!location) return false
  return location === currentId || location === currentName
}

function npcAtCurrentLocation(npc, state) {
  return npc?.available !== false && npcLocationMatchesCurrentScene(npc, state)
}

export function presentSceneNpcs(state = {}) {
  const world = normalizeNpcWorldState(state.npc_world)
  return (Array.isArray(state.social?.npcs) ? state.social.npcs : [])
    .filter((npc) => npc?.id && npc?.name && npcAtCurrentLocation(npc, state))
    .filter((npc) => world.vitals[String(npc.id)]?.alive !== false)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .slice(0, MAX_VISIBLE_NPCS)
}

export function npcPlacementFor(state = {}, npcId, locationId = sceneLocationId(state)) {
  const expectedNpc = String(npcId ?? '')
  const expectedLocation = String(locationId ?? '')
  return normalizeNpcWorldState(state.npc_world).placements
    .find((placement) => placement.npc_id === expectedNpc && placement.location_id === expectedLocation) ?? null
}

export function npcVitalFor(state = {}, npcId) {
  const world = normalizeNpcWorldState(state.npc_world)
  const persisted = world.vitals[String(npcId ?? '')]
  if (persisted) return persisted
  const npc = (state.social?.npcs ?? []).find((candidate) => String(candidate?.id) === String(npcId ?? ''))
  return initialNpcVital(npc)
}

/**
 * Узкий public-presence gate для действий игрока с NPC. Он намеренно не
 * раскрывает availability/vitals: вызывающий код вправе различить их только
 * после того, как публичный профиль и пост текущей сцены уже доказаны.
 */
export function npcInteractionTargetForViewer(state = {}, npcId) {
  const expectedNpcId = String(npcId ?? '')
  const npc = (state.social?.npcs ?? []).find((candidate) => String(candidate?.id) === expectedNpcId) ?? null
  if (!npc || npc.visibility === 'gm_only' || !npcLocationMatchesCurrentScene(npc, state)) return null
  const placement = npcPlacementFor(state, expectedNpcId)
  return placement ? { npc, placement } : null
}

export function initialNpcVital(npc = {}) {
  const role = `${text(npc.role, 160)} ${(Array.isArray(npc.tags) ? npc.tags : []).join(' ')}`.toLocaleLowerCase('ru')
  const maximum = /ветеран|veteran|рыцар|knight|телохран|bodyguard/iu.test(role)
    ? 18
    : /страж|guard|воин|soldier|охотник|hunter/iu.test(role)
      ? 11
      : /лекар|healer|жрец|priest|кузнец|blacksmith/iu.test(role)
        ? 7
        : 4
  return { hp: maximum, max_hp: maximum, alive: true }
}

function sceneMap(state) {
  try {
    return state.scene?.map ? deserializeTacticalMap(state.scene.map) : null
  } catch {
    return null
  }
}

function propCells(prop) {
  const footprint = Array.isArray(prop?.footprint) && prop.footprint.length
    ? prop.footprint
    : [{ x: Math.floor(Number(prop?.x)), y: Math.floor(Number(prop?.y)) }]
  return footprint.filter((cell) => Number.isSafeInteger(Number(cell?.x)) && Number.isSafeInteger(Number(cell?.y)))
    .map((cell) => ({ x: Number(cell.x), y: Number(cell.y) }))
}

function actorOccupiedCells(state) {
  const occupied = new Set()
  for (const actor of [...(state.players ?? []), ...(state.enemies ?? []), ...(state.actors ?? [])]) {
    if (actor?.alive === false || Number(actor?.hp) === 0) continue
    const id = String(actor?.id ?? actor?.actor_id ?? '')
    const position = state.mechanics?.positions?.[id] ?? actor
    const x = Number(position?.x)
    const y = Number(position?.y)
    if (Number.isSafeInteger(x) && Number.isSafeInteger(y)) occupied.add(`${x},${y}`)
  }
  for (const entity of state.entities ?? []) {
    if (!['creature', 'npc', 'enemy'].includes(String(entity?.kind))) continue
    const x = Number(entity?.x)
    const y = Number(entity?.y)
    if (Number.isSafeInteger(x) && Number.isSafeInteger(y)) occupied.add(`${x},${y}`)
  }
  return occupied
}

function preferredAssets(npc = {}) {
  const role = `${text(npc.role, 160)} ${(Array.isArray(npc.tags) ? npc.tags : []).join(' ')}`.toLocaleLowerCase('ru')
  if (/торгов|merchant|трактир|innkeep|бармен|barkeep/iu.test(role)) return ['bar_counter', 'table_long', 'table_round', 'stall', 'counter']
  if (/жрец|priest|свящ|cleric/iu.test(role)) return ['altar', 'shrine', 'candle', 'fireplace']
  if (/лекар|healer|травник|herbal/iu.test(role)) return ['table_long', 'fireplace', 'campfire', 'shelf']
  if (/кузнец|blacksmith|ремесл|artisan/iu.test(role)) return ['forge', 'anvil', 'workbench', 'fireplace']
  if (/страж|guard|часов|watch/iu.test(role)) return ['signpost', 'hitching_post', 'gate', 'door', 'campfire']
  if (/фермер|farmer|конюх|stable/iu.test(role)) return ['well', 'hitching_post', 'cart', 'hay']
  return ['table_round', 'table_long', 'well', 'signpost', 'campfire', 'fireplace']
}

function suitableProps(map, npc) {
  const preferred = preferredAssets(npc)
  return [...map.props].sort((left, right) => {
    const leftAsset = String(left.assetId ?? '')
    const rightAsset = String(right.assetId ?? '')
    const leftRank = preferred.findIndex((asset) => leftAsset.includes(asset))
    const rightRank = preferred.findIndex((asset) => rightAsset.includes(asset))
    const normalizedLeft = leftRank < 0 ? preferred.length : leftRank
    const normalizedRight = rightRank < 0 ? preferred.length : rightRank
    return normalizedLeft - normalizedRight || String(left.id).localeCompare(String(right.id))
  })
}

function placementCellAllowed(map, position, occupied, propOccupied) {
  const x = Number(position?.x)
  const y = Number(position?.y)
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return false
  const cell = cellAt(map, x, y)
  return Boolean(cell?.passable && cell?.revealed && !occupied.has(`${x},${y}`) && !propOccupied.has(`${x},${y}`))
}

function candidateCells(map, npc, occupied, propOccupied) {
  const preferred = preferredAssets(npc)
  const props = suitableProps(map, npc)
  const candidates = []
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const position = { x, y }
      if (!placementCellAllowed(map, position, occupied, propOccupied)) continue
      let anchor = null
      let anchorDistance = Number.MAX_SAFE_INTEGER
      let anchorRank = preferred.length + 1
      for (const prop of props) {
        const distanceToProp = Math.min(...propCells(prop).map((cell) => distance(position, cell)))
        const rank = preferred.findIndex((asset) => String(prop.assetId ?? '').includes(asset))
        const normalizedRank = rank < 0 ? preferred.length : rank
        if (distanceToProp < anchorDistance || (distanceToProp === anchorDistance && normalizedRank < anchorRank)
          || (distanceToProp === anchorDistance && normalizedRank === anchorRank && String(prop.id).localeCompare(String(anchor?.id ?? '')) < 0)) {
          anchor = prop
          anchorDistance = distanceToProp
          anchorRank = normalizedRank
        }
      }
      const tie = stableId(map.seed, npc.id, x, y)
      candidates.push({
        x,
        y,
        anchor_prop_id: anchorDistance <= 2 ? String(anchor?.id ?? '') : '',
        score: [
          anchorRank,
          anchorDistance === 1 ? 0 : anchorDistance === 2 ? 1 : 2,
          anchorDistance,
          tie,
        ],
      })
    }
  }
  return candidates.sort((left, right) => {
    for (let index = 0; index < left.score.length; index += 1) {
      if (left.score[index] < right.score[index]) return -1
      if (left.score[index] > right.score[index]) return 1
    }
    return 0
  })
}

export function isValidNpcPost(state, position, { occupied = actorOccupiedCells(state), exceptNpcId = '' } = {}) {
  const map = sceneMap(state)
  if (!map) return false
  const propOccupied = new Set(map.props.flatMap(propCells).map(keyOf))
  const otherNpcs = normalizeNpcWorldState(state.npc_world).placements
    .filter((placement) => placement.location_id === sceneLocationId(state) && placement.npc_id !== String(exceptNpcId))
  for (const placement of otherNpcs) occupied.add(keyOf(placement))
  return placementCellAllowed(map, position, occupied, propOccupied)
}

/**
 * Возвращает события размещения, но не применяет их. Первый визит создаёт
 * `NpcPlaced`; изменившаяся карта переносит старый пост через `NpcMoved`.
 */
export function planSceneNpcPlacementEvents(state = {}) {
  const map = sceneMap(state)
  const locationId = sceneLocationId(state)
  if (!map || !locationId) return []
  const world = normalizeNpcWorldState(state.npc_world)
  const occupied = actorOccupiedCells(state)
  const propOccupied = new Set(map.props.flatMap(propCells).map(keyOf))
  const events = []
  for (const npc of presentSceneNpcs(state)) {
    const existing = world.placements.find((placement) => placement.npc_id === String(npc.id) && placement.location_id === locationId)
    if (existing && placementCellAllowed(map, existing, occupied, propOccupied)) {
      occupied.add(keyOf(existing))
      continue
    }
    const selected = candidateCells(map, npc, occupied, propOccupied)[0]
    if (!selected) continue
    occupied.add(keyOf(selected))
    const placement = {
      npc_id: String(npc.id),
      npc_name: text(npc.name, 160),
      npc_role: text(npc.role, 160),
      location_id: locationId,
      x: selected.x,
      y: selected.y,
      anchor_prop_id: selected.anchor_prop_id,
      placement_reason: existing ? 'relocated-invalid-post' : 'role-suitable-post',
      policy_id: NPC_WORLD_POLICY_ID,
      ...(existing ? { from: { x: existing.x, y: existing.y } } : { vitality: initialNpcVital(npc) }),
    }
    events.push({
      event_type: existing ? 'NpcMoved' : 'NpcPlaced',
      payload: placement,
      target_ids: [String(npc.id)],
      visibility: npc.visibility === 'public' ? 'public' : npc.visibility === 'gm_only' ? 'gm_only' : 'party',
    })
  }
  return events
}

function socialNpc(state, npcId) {
  return (state.social?.npcs ?? []).find((npc) => String(npc?.id) === String(npcId ?? '')) ?? null
}

function requiredSystemContext(context = {}) {
  if (context.isAdmin !== true && context.isDirector !== true && context.serverAuthoritativeCombat !== true) {
    throw new NpcWorldValidationError('Положение и уязвимость мирных NPC изменяет только серверный контур', 'NPC_WORLD_FORBIDDEN')
  }
}

export function validateNpcWorldCommand(input, state, context = {}) {
  requiredSystemContext(context)
  const command = { ...input }
  const npcId = text(command.npc_id ?? command.npcId, 120)
  const npc = socialNpc(state, npcId)
  if (!npc) throw new NpcWorldValidationError('NPC не найден', 'NPC_WORLD_NPC_NOT_FOUND')
  if (!npcAtCurrentLocation(npc, state)) {
    throw new NpcWorldValidationError('NPC отсутствует в текущей сцене', 'NPC_NOT_PRESENT')
  }
  command.npc_id = npcId
  command.actor_id = null
  command.target_id = null
  command.target_ids = []
  if (command.command_type === 'HarmNpc') {
    if (context.serverAuthoritativeCombat !== true && context.isAdmin !== true) {
      throw new NpcWorldValidationError('Урон мирному NPC принимает только авторитетный серверный бой', 'NPC_HARM_FORBIDDEN')
    }
    const amount = integer(command.amount, 0)
    if (amount <= 0 || amount > 1_000) throw new NpcWorldValidationError('Урон NPC должен быть положительным целым', 'NPC_HARM_AMOUNT_INVALID')
    if (!npcPlacementFor(state, npcId)) throw new NpcWorldValidationError('NPC не находится в текущей сцене', 'NPC_NOT_PRESENT')
    if (!npcVitalFor(state, npcId).alive) throw new NpcWorldValidationError('Погибший NPC не может получить повторный урон', 'NPC_ALREADY_DEAD')
    command.amount = amount
    command.damage_type = text(command.damage_type, 40) || 'untyped'
    command.source_event_id = text(command.source_event_id, 120)
    command.source_actor_id = text(command.source_actor_id, 120)
    command.trigger = text(command.trigger, 80) || 'server-collateral'
    return command
  }
  const locationId = text(command.location_id, 180) || sceneLocationId(state)
  if (!locationId || locationId !== sceneLocationId(state)) {
    throw new NpcWorldValidationError('NPC можно разместить только в текущей локации', 'NPC_LOCATION_MISMATCH')
  }
  command.location_id = locationId
  const existing = npcPlacementFor(state, npcId, locationId)
  if (command.command_type === 'PlaceNpc' && existing) {
    throw new NpcWorldValidationError('NPC уже размещён; используйте MoveNpc', 'NPC_ALREADY_PLACED')
  }
  if (!npcVitalFor(state, npcId).alive) {
    throw new NpcWorldValidationError('Погибшего NPC нельзя разместить на новом посту', 'NPC_ALREADY_DEAD')
  }
  const requested = command.to ?? command.position
  if (requested) {
    command.to = { x: integer(requested.x, Number.NaN), y: integer(requested.y, Number.NaN) }
    if (!isValidNpcPost(state, command.to, { exceptNpcId: npcId })) {
      throw new NpcWorldValidationError('Пост NPC должен быть раскрытой, проходимой и свободной клеткой', 'NPC_POST_INVALID')
    }
  } else {
    const planned = planSceneNpcPlacementEvents({
      ...state,
      social: { ...(state.social ?? {}), npcs: [npc] },
    })[0]
    if (!planned) throw new NpcWorldValidationError('На карте нет свободного поста для NPC', 'NPC_POST_UNAVAILABLE')
    command.to = { x: planned.payload.x, y: planned.payload.y }
    command.anchor_prop_id = planned.payload.anchor_prop_id
  }
  if (command.command_type === 'MoveNpc' && !existing) {
    throw new NpcWorldValidationError('Сначала NPC нужно разместить в этой локации', 'NPC_POST_NOT_FOUND')
  }
  command.anchor_prop_id = text(command.anchor_prop_id, 120)
  return command
}

export function placedSceneNpcTargets(state) {
  const locationId = sceneLocationId(state)
  return presentSceneNpcs(state)
    .map((npc) => ({ npc, placement: npcPlacementFor(state, npc.id, locationId) }))
    .filter(({ placement }) => placement)
    .sort((left, right) => String(left.npc.id).localeCompare(String(right.npc.id)))
}

export function npcTargetsWithinArea(state, center, radiusFeet) {
  const maximumCells = Math.max(0, Math.floor(Number(radiusFeet) / 5))
  return placedSceneNpcTargets(state)
    .filter(({ placement }) => distance(placement, center) <= maximumCells)
    .sort((left, right) => String(left.npc.id).localeCompare(String(right.npc.id)))
}

export function npcMissCollateralTarget(state, { targetPosition, attackTotal, armorClass } = {}) {
  const missMargin = Number(armorClass) - Number(attackTotal)
  if (!targetPosition || !Number.isFinite(missMargin) || missMargin < 1 || missMargin > 2) return null
  return npcTargetsWithinArea(state, targetPosition, 5)[0] ?? null
}

function nearbyPlacedNpcs(state, origin, radiusCells, excluded = new Set()) {
  if (!origin) return []
  return presentSceneNpcs(state)
    .map((npc) => ({ npc, placement: npcPlacementFor(state, npc.id) }))
    .filter(({ npc, placement }) => placement && !excluded.has(String(npc.id)) && distance(origin, placement) <= radiusCells)
    .sort((left, right) => distance(origin, left.placement) - distance(origin, right.placement)
      || String(left.npc.id).localeCompare(String(right.npc.id)))
}

function stanceDraft(npc, stance, reason, sourceEventId, propagationDepth) {
  return {
    event_type: 'NpcStanceChanged',
    payload: {
      npc_id: String(npc.id),
      npc_name: text(npc.name, 160),
      stance,
      reason,
      source_event_id: sourceEventId,
      propagation_depth: propagationDepth,
      policy_id: NPC_WORLD_POLICY_ID,
    },
    target_ids: [String(npc.id)],
    visibility: npc.visibility === 'public' ? 'public' : npc.visibility === 'gm_only' ? 'gm_only' : 'party',
  }
}

function witnessAndReputationDrafts(state, witnesses, { sourceEventId, severity }) {
  const witnessIds = witnesses.map(({ npc }) => String(npc.id))
  const factions = [...new Set(witnesses.flatMap(({ npc }) => factionIdsForNpc(npc)))].sort()
  const events = [{
    event_type: 'WitnessConsequencePropagated',
    payload: {
      source_event_id: sourceEventId,
      witness_ids: witnessIds,
      faction_ids: factions,
      propagation_scope: 'nearby-one-hop',
      outcome: 'harmful',
      severity,
      provenance: { source: 'server-npc-witness-policy', policy: NPC_WORLD_POLICY_ID },
    },
    target_ids: witnessIds,
    visibility: 'party',
  }]
  const delta = severity === 'major' ? -5 : -2
  for (const factionId of factions) events.push({
    event_type: 'FactionReputationAdjusted',
    payload: {
      faction_id: factionId,
      delta,
      source_event_id: sourceEventId,
      witness_ids: witnessIds,
      provenance: { source: 'server-reputation-table', policy: 'faction-reputation-v1' },
    },
    target_ids: [],
    visibility: 'party',
  })
  return events
}

/**
 * События урона и социальных последствий. Распространение паники намеренно
 * ограничено прямыми свидетелями и одним соседним кольцом.
 */
export function npcHarmEventDrafts(state, {
  npcId,
  amount,
  damageType = 'untyped',
  sourceEventId = '',
  sourceActorId = '',
  trigger = 'server-collateral',
  commandId = '',
} = {}) {
  const npc = socialNpc(state, npcId)
  const placement = npcPlacementFor(state, npcId)
  if (!npc || !placement) return []
  const before = npcVitalFor(state, npcId)
  if (!before.alive) return []
  const applied = Math.max(0, Math.min(before.hp, integer(amount, 0)))
  if (!applied) return []
  const after = { hp: before.hp - applied, max_hp: before.max_hp, alive: before.hp - applied > 0 }
  const harmEventId = `npc-harmed:${stableId(commandId, npcId, sourceEventId, before.hp, applied)}`
  const deathEventId = `npc-died:${stableId(commandId, npcId, sourceEventId, before.hp, applied)}`
  const events = [{
    event_type: 'NpcHarmed',
    event_id: harmEventId,
    payload: {
      npc_id: String(npc.id),
      npc_name: text(npc.name, 160),
      damage_type: text(damageType, 40) || 'untyped',
      raw_amount: integer(amount, 0),
      applied_amount: applied,
      hp_before: before.hp,
      hp_after: after.hp,
      max_hp: before.max_hp,
      source_event_id: sourceEventId,
      source_actor_id: sourceActorId,
      trigger,
      policy_id: NPC_WORLD_POLICY_ID,
    },
    target_ids: [String(npc.id)],
    visibility: 'party',
  }]
  if (!after.alive) events.push({
    event_type: 'NpcDied',
    event_id: deathEventId,
    payload: {
      npc_id: String(npc.id),
      npc_name: text(npc.name, 160),
      location_id: sceneLocationId(state),
      source_event_id: harmEventId,
      source_actor_id: sourceActorId,
      trigger,
      policy_id: NPC_WORLD_POLICY_ID,
    },
    target_ids: [String(npc.id)],
    visibility: 'party',
  })
  events.push(stanceDraft(npc, after.alive ? (after.hp * 2 <= after.max_hp ? 'fleeing' : 'hostile') : 'dead', after.alive ? 'harmed' : 'killed', after.alive ? harmEventId : deathEventId, 0))

  const direct = nearbyPlacedNpcs(state, placement, 6, new Set([String(npc.id)])).slice(0, 12)
  const directIds = new Set(direct.map(({ npc: witness }) => String(witness.id)))
  for (const witness of direct) events.push(stanceDraft(witness.npc, 'frightened', 'witnessed-npc-harm', harmEventId, 0))
  const propagated = []
  for (const witness of direct) {
    for (const neighbor of nearbyPlacedNpcs(state, witness.placement, 3, new Set([String(npc.id), ...directIds]))) {
      if (propagated.some(({ npc: candidate }) => String(candidate.id) === String(neighbor.npc.id))) continue
      propagated.push(neighbor)
      if (propagated.length >= MAX_PROPAGATED_NPCS - direct.length) break
    }
    if (direct.length + propagated.length >= MAX_PROPAGATED_NPCS) break
  }
  for (const witness of propagated) events.push(stanceDraft(witness.npc, 'guarded', 'nearby-panic', harmEventId, 1))
  events.push(...witnessAndReputationDrafts(state, [...direct, ...propagated], {
    sourceEventId: after.alive ? harmEventId : deathEventId,
    severity: after.alive ? 'minor' : 'major',
  }))

  if (!after.alive) {
    const entityExists = (state.worldMemory?.entities ?? []).some((entity) => String(entity?.id) === String(npc.id))
    if (!entityExists) events.push({
      event_type: 'WorldEntityUpserted',
      payload: {
        entity: {
          id: String(npc.id),
          kind: 'npc',
          name: text(npc.name, 160),
          summary: text(npc.public_summary, 1_000),
          aliases: [],
          visibility: 'party',
          tags: Array.isArray(npc.tags) ? npc.tags.slice(0, 20) : [],
        },
      },
      target_ids: [],
      visibility: 'party',
    })
    events.push({
      event_type: 'WorldFactRecorded',
      payload: {
        fact: {
          id: `fact:npc-death:${stableId(deathEventId)}`,
          subject_id: String(npc.id),
          predicate: 'died',
          object: sceneLocationId(state),
          summary: `${text(npc.name, 160)} погиб(ла) в локации «${text(state.scene?.location ?? state.scene?.title, 180)}».`,
          visibility: 'party',
          source_event_ids: [deathEventId],
          source_command_id: text(commandId, 160),
          supersedes_fact_id: '',
          status: 'active',
          recorded_at_minutes: Math.max(0, integer(state.mechanics?.world_time?.elapsed_minutes, 0)),
        },
      },
      target_ids: [],
      visibility: 'party',
    })
  }
  return events
}

export function npcCombatStanceEventDrafts(state, { sourceEventId = '', participantIds = [] } = {}) {
  const origins = participantIds
    .map((id) => state.mechanics?.positions?.[String(id)]
      ?? [...(state.players ?? []), ...(state.enemies ?? []), ...(state.actors ?? [])].find((actor) => String(actor?.id ?? actor?.actor_id) === String(id)))
    .filter((position) => Number.isSafeInteger(Number(position?.x)) && Number.isSafeInteger(Number(position?.y)))
  if (!origins.length) return []
  const present = presentSceneNpcs(state).map((npc) => ({ npc, placement: npcPlacementFor(state, npc.id) })).filter((entry) => entry.placement)
  const direct = present.filter(({ placement }) => origins.some((origin) => distance(origin, placement) <= 6)).slice(0, 12)
  const directIds = new Set(direct.map(({ npc }) => String(npc.id)))
  const propagated = []
  for (const witness of direct) {
    for (const neighbor of present.filter(({ npc, placement }) => !directIds.has(String(npc.id)) && distance(witness.placement, placement) <= 3)) {
      if (propagated.some(({ npc }) => String(npc.id) === String(neighbor.npc.id))) continue
      propagated.push(neighbor)
      if (direct.length + propagated.length >= MAX_PROPAGATED_NPCS) break
    }
    if (direct.length + propagated.length >= MAX_PROPAGATED_NPCS) break
  }
  return [
    ...direct.map(({ npc }) => stanceDraft(npc, 'frightened', 'nearby-combat', sourceEventId, 0)),
    ...propagated.map(({ npc }) => stanceDraft(npc, 'guarded', 'nearby-panic', sourceEventId, 1)),
  ]
}

export function applyNpcWorldEvent(input, event) {
  const world = normalizeNpcWorldState(input)
  const payload = event?.payload ?? {}
  const npcId = text(payload.npc_id, 120)
  if (event?.event_type === 'NpcPlaced' || event?.event_type === 'NpcMoved') {
    const placement = safePlacement({ ...payload, source_event_id: event.event_id })
    if (placement) {
      world.placements = [
        ...world.placements.filter((entry) => entry.npc_id !== placement.npc_id || entry.location_id !== placement.location_id),
        placement,
      ].slice(-MAX_PLACEMENTS)
    }
    if (event.event_type === 'NpcPlaced' && payload.vitality && npcId && !world.vitals[npcId]) {
      world.vitals[npcId] = safeVital(payload.vitality)
    }
  }
  if (event?.event_type === 'NpcHarmed' && npcId) {
    world.vitals[npcId] = safeVital({
      hp: payload.hp_after,
      max_hp: payload.max_hp,
      alive: Number(payload.hp_after) > 0,
    })
  }
  if (event?.event_type === 'NpcDied' && npcId) {
    const before = world.vitals[npcId] ?? { hp: 0, max_hp: 4, alive: false }
    world.vitals[npcId] = { ...before, hp: 0, alive: false }
  }
  if (event?.event_type === 'NpcStanceChanged' && npcId) {
    world.stances[npcId] = safeStance({
      stance: payload.stance,
      reason: payload.reason,
      source_event_id: payload.source_event_id || event.event_id,
      propagation_depth: payload.propagation_depth,
    })
  }
  if (event?.event_type === 'ItemTransferred' && payload.recipient_kind === 'npc') {
    const recipientId = text(payload.to_actor_id, 120)
    const incoming = safeNpcInventory([{
      ...(payload.item && typeof payload.item === 'object' ? payload.item : {}),
      quantity: Math.max(1, integer(payload.quantity, 1)),
      equipped: false,
      attuned_to: null,
    }])[0]
    if (recipientId && incoming) {
      const inventory = Object.hasOwn(world.inventories, recipientId)
        ? world.inventories[recipientId]
        : []
      const stackKey = inventoryStackKey(incoming)
      const stackIndex = inventory.findIndex((item) => inventoryStackKey(item) === stackKey)
      if (stackIndex >= 0) {
        world.inventories = {
          ...world.inventories,
          [recipientId]: inventory.map((item, index) => index === stackIndex
          ? {
              ...item,
              quantity: Math.min(
                MAX_STOCK_QUANTITY,
                integer(item.quantity, 1) + integer(incoming.quantity, 1),
              ),
            }
          : item),
        }
      } else if (inventory.length < MAX_NPC_INVENTORY_ITEMS) {
        world.inventories = {
          ...world.inventories,
          [recipientId]: [...inventory, incoming],
        }
      }
    }
  }
  return normalizeNpcWorldState(world)
}

function publicHealthStatus(vital) {
  if (!vital?.alive) return 'dead'
  if (vital.hp * 2 <= vital.max_hp) return 'bloodied'
  if (vital.hp < vital.max_hp) return 'hurt'
  return 'unharmed'
}

export function sceneNpcsForViewer(state = {}) {
  const world = normalizeNpcWorldState(state.npc_world)
  const locationId = sceneLocationId(state)
  return presentSceneNpcs({ ...state, npc_world: { ...world, vitals: {} } })
    .filter((npc) => npc.visibility !== 'gm_only')
    .map((npc) => {
      const placement = world.placements.find((entry) => entry.npc_id === String(npc.id) && entry.location_id === locationId)
      if (!placement) return null
      const vital = world.vitals[String(npc.id)] ?? initialNpcVital(npc)
      const stance = world.stances[String(npc.id)]?.stance ?? 'neutral'
      return {
        id: String(npc.id),
        name: text(npc.name, 160),
        role: text(npc.role, 160),
        location_id: locationId,
        x: placement.x,
        y: placement.y,
        anchor_prop_id: placement.anchor_prop_id || null,
        stance,
        alive: vital.alive,
        health_status: publicHealthStatus(vital),
      }
    })
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, MAX_VISIBLE_NPCS)
}
