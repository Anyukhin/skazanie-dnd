import {
  RulesValidationError,
  actorPosition,
  attackProfileFor,
  findActor,
  hasClearTrajectory,
  isEnemyActor,
  isLivingActor,
  normalizeCampaignState,
  shortestTacticalPath,
} from './rules-engine.mjs'
import { isPartySummon } from './combat-spells.mjs'

const CELL_FEET = 5

function actorId(actor) {
  return String(actor?.id ?? actor?.actor_id ?? '')
}

function livingParty(state) {
  const members = new Set(state.partyMemberIds?.length ? state.partyMemberIds.map(String) : state.players.map(actorId))
  const heroes = state.players.filter((actor) => members.has(actorId(actor)) && isLivingActor(actor))
  const summons = (state.actors ?? []).filter((actor) => isPartySummon(actor) && members.has(String(actor.ownerId ?? actor.owner_id)) && isLivingActor(actor))
  return [...heroes, ...summons]
}

function livingEnemies(state) {
  const encounterIds = new Set(Array.isArray(state.mechanics?.encounter?.enemy_ids)
    ? state.mechanics.encounter.enemy_ids.map(String)
    : [])
  return state.enemies.filter((enemy) => isLivingActor(enemy) && (!encounterIds.size || encounterIds.has(actorId(enemy))))
}

function gridDistance(left, right) {
  const a = actorPosition(left.state, left.id)
  const b = actorPosition(right.state, right.id)
  return a && b ? Math.abs(a.x - b.x) + Math.abs(a.y - b.y) : Number.MAX_SAFE_INTEGER
}

function targetCandidates(state, enemy) {
  return livingParty(state).map((target) => {
    const path = shortestTacticalPath(state, actorId(enemy), actorPosition(state, actorId(target)), { allowOccupiedDestination: true })
    return {
      actor: target,
      path,
      inRange: inAttackRange(state, actorId(enemy), actorId(target)),
      distance: path ? path.length : gridDistance({ state, id: actorId(enemy) }, { state, id: actorId(target) }),
    }
  }).sort((left, right) => Number(right.inRange) - Number(left.inRange)
    || Number(Boolean(right.path)) - Number(Boolean(left.path))
    || left.distance - right.distance
    || actorId(left.actor).localeCompare(actorId(right.actor)))
}

function inAttackRange(state, attackerId, targetId) {
  const attacker = actorPosition(state, attackerId)
  const target = actorPosition(state, targetId)
  const profile = attackProfileFor(state, attackerId)
  if (!attacker || !target || !profile) return false
  const distance = Math.max(Math.abs(attacker.x - target.x), Math.abs(attacker.y - target.y)) * CELL_FEET
  return distance >= CELL_FEET && distance <= profile.range_feet && (profile.range_feet <= CELL_FEET || hasClearTrajectory(state, attacker, target))
}

export function planNpcTurn(rawState, enemyId) {
  const state = normalizeCampaignState(rawState)
  const enemy = findActor(state, enemyId)
  if (!enemy || !isEnemyActor(state, enemyId) || !isLivingActor(enemy)) return [{ command_type: 'EndTurn', actor_id: String(enemyId) }]
  const candidate = targetCandidates(state, enemy)[0]
  if (!candidate) return [{ command_type: 'EndTurn', actor_id: String(enemyId) }]
  const targetId = actorId(candidate.actor)
  const commands = []
  if (!inAttackRange(state, enemyId, targetId) && candidate.path?.length) {
    const profile = attackProfileFor(state, enemyId)
    const rangeCells = Math.max(1, Math.floor((profile?.range_feet ?? CELL_FEET) / CELL_FEET))
    const speed = Number(enemy.speed)
    const maximumSteps = Math.max(0, Math.floor((Number.isFinite(speed) ? speed : 30) / CELL_FEET))
    const steps = Math.min(maximumSteps, Math.max(0, candidate.path.length - rangeCells))
    if (steps > 0) commands.push({ command_type: 'MoveActor', actor_id: String(enemyId), to: candidate.path[steps - 1] })
    const destination = steps > 0 ? candidate.path[steps - 1] : actorPosition(state, enemyId)
    const targetAt = actorPosition(state, targetId)
    const distanceAfterMove = destination && targetAt
      ? Math.max(Math.abs(destination.x - targetAt.x), Math.abs(destination.y - targetAt.y)) * CELL_FEET
      : Number.MAX_SAFE_INTEGER
    if (profile && distanceAfterMove >= CELL_FEET && distanceAfterMove <= profile.range_feet) {
      commands.push({ command_type: 'MakeAttack', actor_id: String(enemyId), target_id: targetId })
    }
  } else if (inAttackRange(state, enemyId, targetId)) {
    commands.push({ command_type: 'MakeAttack', actor_id: String(enemyId), target_id: targetId })
  }
  commands.push({ command_type: 'EndTurn', actor_id: String(enemyId) })
  return commands
}

function keyPart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60) || 'none'
}

function schedulerKey(campaignId, combat, actorIdValue, suffix = 'turn') {
  return `npc:${keyPart(campaignId)}:r${combat.round}:i${combat.active_index}:${keyPart(actorIdValue)}:${suffix}`
}

async function commitPlan({ campaignId, eventStore, rulesEngine, loaded, commands, key }) {
  const plan = {
    proposed_commands: commands.map((command, index) => ({
      ...command,
      server_authoritative: true,
      campaign_id: campaignId,
      command_id: `${key}:${index + 1}`,
    })),
  }
  const resolved = rulesEngine.resolvePlan(plan, loaded.state, { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true })
  if (!resolved.events.length) throw new RulesValidationError('NPC turn produced no events', 'NPC_TURN_EMPTY')
  const committed = await eventStore.commit({
    campaign_id: campaignId,
    expected_state_version: loaded.state_version,
    idempotency_key: key,
    command_id: key,
    events: resolved.events,
  })
  return { committed, resolved }
}

/**
 * Advances only server-owned actors. Decisions are deterministic for a given
 * state; dice remain server-generated. Every turn is a separately idempotent
 * event-store commit and the loop is hard-bounded.
 */
export async function runNpcTurnScheduler({
  campaignId,
  eventStore,
  rulesEngine,
  advanceNpc = true,
  maxTurns = 64,
} = {}) {
  if (!campaignId || !eventStore || !rulesEngine) throw new TypeError('NPC scheduler requires campaignId, eventStore and rulesEngine')
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 256) throw new RangeError('maxTurns must be between 1 and 256')
  let loaded = await eventStore.load(campaignId)
  const turns = []
  const events = []
  for (let iteration = 0; iteration < maxTurns; iteration += 1) {
    const state = normalizeCampaignState(loaded.state)
    const combat = state.mechanics.combat
    if (!combat.active) return { state: state, state_version: loaded.state_version, turns, events }
    const currentId = String(combat.initiative[combat.active_index]?.actor_id ?? '')
    const party = livingParty(state)
    const enemies = livingEnemies(state)
    if (!party.length || !enemies.length) {
      const reason = enemies.length ? 'party_defeated' : 'enemies_defeated'
      const key = schedulerKey(campaignId, combat, currentId || party[0]?.id || enemies[0]?.id, `end-${reason}`)
      const actor = findActor(state, currentId) ?? party[0] ?? enemies[0]
      if (!actor) throw new RulesValidationError('Combat has no actor that can close it', 'INVALID_COMBAT_STATE')
      const { committed } = await commitPlan({
        campaignId, eventStore, rulesEngine, loaded, key,
        commands: [{ command_type: 'EndCombat', actor_id: actorId(actor), reason }],
      })
      events.push(...committed.events)
      turns.push({ actor_id: actorId(actor), round: combat.round, active_index: combat.active_index, kind: 'combat-end', reason, idempotency_key: key, state_version: committed.state_version })
      loaded = await eventStore.load(campaignId)
      return { state: loaded.state, state_version: loaded.state_version, turns, events }
    }
    const current = findActor(state, currentId)
    if (current && isLivingActor(current) && !isEnemyActor(state, currentId)) {
      return { state: loaded.state, state_version: loaded.state_version, turns, events }
    }
    if (current && isLivingActor(current) && isEnemyActor(state, currentId) && !advanceNpc) {
      return { state: loaded.state, state_version: loaded.state_version, turns, events }
    }
    if (!current) throw new RulesValidationError('Initiative references an unknown actor', 'INVALID_COMBAT_STATE')
    const commands = current && isLivingActor(current) && isEnemyActor(state, currentId)
      ? planNpcTurn(state, currentId)
      : [{ command_type: 'EndTurn', actor_id: currentId }]
    const key = schedulerKey(campaignId, combat, currentId, isLivingActor(current) ? 'turn' : 'skip')
    const { committed } = await commitPlan({ campaignId, eventStore, rulesEngine, loaded, commands, key })
    events.push(...committed.events)
    turns.push({
      actor_id: currentId,
      round: combat.round,
      active_index: combat.active_index,
      kind: isLivingActor(current) ? 'enemy-turn' : 'skipped-defeated',
      commands: commands.map((command) => command.command_type),
      idempotency_key: key,
      state_version: committed.state_version,
    })
    loaded = await eventStore.load(campaignId)
  }
  throw new RulesValidationError(`NPC scheduler exceeded ${maxTurns} turns`, 'NPC_TURN_LIMIT')
}
