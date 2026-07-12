import type { BattleEvent, Enemy, GameState, MapCell, MapFeedback, Message, Player, TacticalTurn } from './types'

export const CELL_FEET = 5
const pos = (x: number, y: number) => x + ',' + y
const clock = () => new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date())
const uid = (kind: string) => Date.now() + '-' + kind + '-' + Math.random().toString(36).slice(2, 7)
const memberIds = (state: GameState) => new Set(state.partyMemberIds?.length ? state.partyMemberIds : state.players.map((player) => player.id))
const isWalkable = (cell?: MapCell) => Boolean(cell?.revealed && (cell.type === 'floor' || cell.type === 'door'))

export function mapGridDimensions(cells: MapCell[]) {
  return cells.reduce((dimensions, cell) => ({
    columns: Math.max(dimensions.columns, cell.x + 1),
    rows: Math.max(dimensions.rows, cell.y + 1),
  }), { columns: 1, rows: 1 })
}

export function currentTacticalTurn(state: GameState): TacticalTurn {
  const value = state.tacticalTurn
  return value?.sceneTurn === state.scene.turn && value.actorId === state.activePlayerId
    ? value
    : { sceneTurn: state.scene.turn, actorId: state.activePlayerId, movementSpent: 0, actionUsed: false }
}

function pathTo(cells: MapCell[], from: { x: number; y: number }, to: { x: number; y: number }, blocked: Set<string>, allowTarget = false) {
  const cellsByPosition = new Map(cells.map((cell) => [pos(cell.x, cell.y), cell]))
  const start = pos(from.x, from.y)
  const target = pos(to.x, to.y)
  const queue = [start]
  const previous = new Map<string, string | null>([[start, null]])
  while (queue.length) {
    const current = queue.shift()!
    if (current === target) break
    const [x, y] = current.split(',').map(Number)
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const next = pos(nx, ny)
      if (previous.has(next) || !isWalkable(cellsByPosition.get(next))) continue
      if (blocked.has(next) && !(allowTarget && next === target)) continue
      previous.set(next, current)
      queue.push(next)
    }
  }
  if (!previous.has(target)) return null
  const result: Array<{ x: number; y: number }> = []
  let cursor: string | null = target
  while (cursor && cursor !== start) {
    const [x, y] = cursor.split(',').map(Number)
    result.unshift({ x, y })
    cursor = previous.get(cursor) ?? null
  }
  return result
}

function occupied(state: GameState, exceptId?: string) {
  const result = new Set<string>()
  state.players.forEach((player) => { if (player.id !== exceptId && player.hp > 0) result.add(pos(player.x, player.y)) })
  ;(state.enemies ?? []).forEach((enemy) => { if (enemy.alive) result.add(pos(enemy.x, enemy.y)) })
  return result
}

export function reachableCells(state: GameState, playerId: string) {
  const player = state.players.find((item) => item.id === playerId)
  if (!player || state.activePlayerId !== playerId) return new Set<string>()
  const tactical = currentTacticalTurn(state)
  const maxSteps = Math.max(0, Math.floor((player.speed - tactical.movementSpent) / CELL_FEET))
  const result = new Set<string>()
  const blocked = occupied(state, playerId)
  if (!maxSteps) return result
  state.scene.cells.forEach((cell) => {
    if (!isWalkable(cell) || blocked.has(pos(cell.x, cell.y))) return
    const path = pathTo(state.scene.cells, player, cell, blocked)
    if (path && path.length > 0 && path.length <= maxSteps) result.add(pos(cell.x, cell.y))
  })
  return result
}

function feedback(state: GameState, value: Omit<MapFeedback, 'id'>) {
  return [...(state.mapFeedback ?? []).slice(-5), { ...value, id: uid(value.kind) }]
}

function battleLog(state: GameState, events: Array<Omit<BattleEvent, 'id'>>) {
  return [...(state.battleLog ?? []).slice(-49), ...events.map((event) => ({ ...event, id: uid('battle') }))].slice(-50)
}

function log(text: string, kind: string, roll?: Message['roll']): Message {
  return { id: uid(kind), speaker: 'system', author: 'Тактический журнал', timestamp: clock(), text, roll, turnConsumed: false }
}

export function movePlayerOnMap(state: GameState, playerId: string, x: number, y: number): GameState {
  const player = state.players.find((item) => item.id === playerId)
  if (!player || playerId !== state.activePlayerId || !memberIds(state).has(playerId)) return state
  if (!reachableCells(state, playerId).has(pos(x, y))) return state
  const tactical = currentTacticalTurn(state)
  const path = pathTo(state.scene.cells, player, { x, y }, occupied(state, playerId))
  if (!path) return state
  const feet = path.length * CELL_FEET
  const from = { x: player.x, y: player.y }
  return {
    ...state,
    players: state.players.map((item) => item.id === playerId ? { ...item, x, y } : item),
    tacticalTurn: { ...tactical, movementSpent: tactical.movementSpent + feet },
    mapFeedback: feedback(state, { x, y, text: feet + ' фт', kind: 'move' }),
    battleLog: battleLog(state, [{ sceneTurn: state.scene.turn, type: 'move', actorId: playerId, actorKind: 'player', from, to: { x, y }, distanceFeet: feet }]),
    messages: [...state.messages, log(player.character + ' перемещается на ' + feet + ' футов (' + path.length + ' кл.). Осталось ' + Math.max(0, player.speed - tactical.movementSpent - feet) + ' футов движения.', 'move')],
  }
}

export function attackEnemyOnMap(state: GameState, playerId: string, enemyId: string, random = Math.random): GameState {
  const player = state.players.find((item) => item.id === playerId)
  const enemy = state.enemies?.find((item) => item.id === enemyId && item.alive)
  const tactical = currentTacticalTurn(state)
  if (!player || !enemy || playerId !== state.activePlayerId || tactical.actionUsed) return state
  if (Math.abs(player.x - enemy.x) + Math.abs(player.y - enemy.y) !== 1) return state
  const ability = Math.floor((player.abilities.str - 10) / 2)
  const die = Math.floor(random() * 20) + 1
  const modifier = player.proficiency + ability
  const total = die + modifier
  const hit = total >= enemy.armor
  const damage = hit ? Math.max(1, Math.floor(random() * 8) + 1 + ability) : 0
  const hp = Math.max(0, enemy.hp - damage)
  const defeated = hit && hp === 0
  const text = hit
    ? player.character + ' атакует ' + enemy.name + ': ' + total + ' против КД ' + enemy.armor + ', урон ' + damage + '. У цели ' + hp + '/' + enemy.maxHp + ' ОЗ' + (defeated ? ' — враг повержен.' : '.')
    : player.character + ' атакует ' + enemy.name + ': ' + total + ' против КД ' + enemy.armor + ' — промах.'
  return {
    ...state,
    enemies: (state.enemies ?? []).map((item) => item.id === enemyId ? { ...item, hp, alive: hp > 0 } : item),
    tacticalTurn: { ...tactical, actionUsed: true },
    scene: defeated ? { ...state.scene, cells: state.scene.cells.map((cell) => cell.x === enemy.x && cell.y === enemy.y && cell.feature === 'enemy' ? { ...cell, feature: undefined } : cell) } : state.scene,
    mapFeedback: feedback(state, { x: enemy.x, y: enemy.y, text: hit ? '−' + damage : 'Промах', kind: defeated ? 'defeat' : hit ? 'damage' : 'miss' }),
    battleLog: battleLog(state, [{
      sceneTurn: state.scene.turn, type: 'attack', actorId: playerId, actorKind: 'player', targetId: enemyId,
      roll: { die, modifier, total, difficulty: enemy.armor, hit }, damage, hpBefore: enemy.hp, hpAfter: hp,
    }]),
    messages: [...state.messages, log(text, 'attack', { value: die, modifier, total, difficulty: enemy.armor, label: 'Атака по ' + enemy.name, success: hit })],
  }
}

function closest(enemy: Enemy, players: Player[]) {
  return [...players].sort((a, b) => (Math.abs(a.x - enemy.x) + Math.abs(a.y - enemy.y)) - (Math.abs(b.x - enemy.x) + Math.abs(b.y - enemy.y)))[0]
}

export function finishTacticalTurn(state: GameState, random = Math.random): GameState {
  let players = state.players.map((player) => ({ ...player }))
  const enemies = (state.enemies ?? []).map((enemy) => ({ ...enemy }))
  const messages = [...state.messages]
  let effects = [...(state.mapFeedback ?? []).slice(-5)]
  const events: Array<Omit<BattleEvent, 'id'>> = []
  const isActiveMember = (player: Player) => memberIds(state).has(player.id) && player.online && player.hp > 0

  for (const enemy of enemies.filter((item) => item.alive)) {
    let target = closest(enemy, players.filter(isActiveMember))
    if (!target) break
    let distance = Math.abs(target.x - enemy.x) + Math.abs(target.y - enemy.y)
    if (distance > 1) {
      const blocked = new Set<string>()
      players.forEach((player) => { if (player.hp > 0) blocked.add(pos(player.x, player.y)) })
      enemies.forEach((other) => { if (other.alive && other.id !== enemy.id) blocked.add(pos(other.x, other.y)) })
      const path = pathTo(state.scene.cells, enemy, target, blocked, true)
      const steps = Math.min(Math.max(0, (path?.length ?? 1) - 1), Math.floor(enemy.speed / CELL_FEET))
      if (path && steps > 0) {
        const from = { x: enemy.x, y: enemy.y }
        enemy.x = path[steps - 1].x
        enemy.y = path[steps - 1].y
        events.push({ sceneTurn: state.scene.turn, type: 'move', actorId: enemy.id, actorKind: 'enemy', from, to: { x: enemy.x, y: enemy.y }, distanceFeet: steps * CELL_FEET })
        messages.push(log(enemy.name + ' перемещается на ' + steps * CELL_FEET + ' футов к ' + target.character + '.', 'enemy-move'))
      }
      target = closest(enemy, players.filter(isActiveMember))
      distance = target ? Math.abs(target.x - enemy.x) + Math.abs(target.y - enemy.y) : Infinity
    }
    if (!target || distance !== 1) continue
    const die = Math.floor(random() * 20) + 1
    const total = die + enemy.attackBonus
    const hit = total >= target.armor
    const damage = hit ? Math.max(1, Math.floor(random() * enemy.damageDice) + 1 + enemy.damageBonus) : 0
    const hp = Math.max(0, target.hp - damage)
    events.push({
      sceneTurn: state.scene.turn, type: 'attack', actorId: enemy.id, actorKind: 'enemy', targetId: target.id,
      roll: { die, modifier: enemy.attackBonus, total, difficulty: target.armor, hit }, damage, hpBefore: target.hp, hpAfter: hp,
    })
    players = players.map((player) => player.id === target!.id ? { ...player, hp } : player)
    effects = [...effects.slice(-5), { id: uid(hit ? 'damage' : 'miss'), x: target.x, y: target.y, text: hit ? '−' + damage : 'Промах', kind: hit ? 'damage' : 'miss' }]
    messages.push(log(hit
      ? enemy.name + ' атакует ' + target.character + ': ' + total + ' против КД ' + target.armor + ', урон ' + damage + '. У героя ' + hp + '/' + target.maxHp + ' ОЗ.'
      : enemy.name + ' атакует ' + target.character + ': ' + total + ' против КД ' + target.armor + ' — промах.', 'enemy-attack',
      { value: die, modifier: enemy.attackBonus, total, difficulty: target.armor, label: 'Атака: ' + enemy.name, success: hit }))
  }

  const eligible = players.filter(isActiveMember)
  const currentIndex = eligible.findIndex((player) => player.id === state.activePlayerId)
  const next = eligible[(currentIndex + 1 + eligible.length) % eligible.length] ?? eligible[0] ?? players[0]
  const sceneTurn = state.scene.turn + 1
  events.push({ sceneTurn: state.scene.turn, type: 'turn-end', actorId: state.activePlayerId, actorKind: 'system', targetId: next?.id })
  return {
    ...state,
    players,
    enemies,
    messages,
    mapFeedback: effects,
    battleLog: battleLog(state, events),
    activePlayerId: next?.id ?? state.activePlayerId,
    tacticalTurn: { sceneTurn, actorId: next?.id ?? state.activePlayerId, movementSpent: 0, actionUsed: false },
    scene: { ...state.scene, turn: sceneTurn },
  }
}
