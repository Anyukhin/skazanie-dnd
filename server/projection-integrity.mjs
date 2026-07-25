import { createHash } from 'node:crypto'

const CANONICAL_FIELDS = Object.freeze([
  'sessionCode',
  'campaign',
  'partyName',
  'partyMemberIds',
  'players',
  'enemies',
  'actors',
  'merchants',
  'worldMemory',
  'worldMap',
  'social',
  'mechanics',
  'rulings',
  'entities',
  'scene',
  'adventure',
  'agentInteraction',
  'activePlayerId',
  'tacticalTurn',
  'battleLog',
  'economyLog',
  'mapFeedback',
  'suggestions',
  'lastDiceRoll',
  'state_version',
  'ruleset_id',
  'ruleset_version',
  'enabled_rule_packs',
  'enabled_house_rules',
  'ruleset_locked_at',
  'engine_mode',
])

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

function canonicalPlayer(player) {
  if (!player || typeof player !== 'object') return player
  const { online: _online, ...canonical } = player
  return canonical
}

export function canonicalProjection(state = {}) {
  const projected = {}
  for (const field of CANONICAL_FIELDS) {
    if (!Object.hasOwn(state, field)) {
      if (field === 'agentInteraction') projected[field] = null
      continue
    }
    projected[field] = field === 'players'
      ? (Array.isArray(state.players) ? state.players.map(canonicalPlayer) : [])
      : state[field]
  }
  return stableValue(projected)
}

export function projectionHash(state = {}) {
  return createHash('sha256').update(JSON.stringify(canonicalProjection(state))).digest('hex')
}

export function compareProjection(authoritativeState, projectedState) {
  const authoritative_hash = projectionHash(authoritativeState)
  const projected_hash = projectionHash(projectedState)
  return {
    matched: authoritative_hash === projected_hash,
    authoritative_hash,
    projected_hash,
  }
}
