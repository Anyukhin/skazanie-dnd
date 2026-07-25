import type { BattleEvent, GameState, MapCell, MechanicsSupport } from './types'

export const boardPositionKey = (x: number, y: number) => `${x},${y}`

type BoardActor = { id: string; x: number; y: number }

export type MovementPath = {
  path: Array<{ x: number; y: number }>
  costFeet: number
}

const isWalkable = (cell?: MapCell) => Boolean(cell?.revealed && (cell.type === 'floor' || cell.type === 'door'))

export function occupiedBoardPositions(state: GameState, exceptId?: string) {
  const occupied = new Set<string>()
  state.players.forEach((actor) => {
    if (actor.id !== exceptId && actor.hp > 0) occupied.add(boardPositionKey(actor.x, actor.y))
  })
  ;(state.enemies ?? []).forEach((actor) => {
    if (actor.id !== exceptId && actor.alive) occupied.add(boardPositionKey(actor.x, actor.y))
  })
  ;(state.actors ?? []).forEach((actor) => {
    if (actor.id !== exceptId && actor.alive) occupied.add(boardPositionKey(actor.x, actor.y))
  })
  return occupied
}

/**
 * Builds shortest orthogonal paths using the same visible floor/door and
 * occupancy rules as the authoritative combat path. The server remains the
 * source of truth; this result is only used to preview a command before it is
 * sent.
 */
export function buildMovementPaths(state: GameState, actor: BoardActor, cellFeet = 5) {
  const cells = new Map(state.scene.cells.map((cell) => [boardPositionKey(cell.x, cell.y), cell]))
  const blocked = occupiedBoardPositions(state, actor.id)
  const start = boardPositionKey(actor.x, actor.y)
  const queue = [start]
  const previous = new Map<string, string | null>([[start, null]])

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    const [x, y] = current.split(',').map(Number)
    for (const [nextX, nextY] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const next = boardPositionKey(nextX, nextY)
      if (previous.has(next) || blocked.has(next) || !isWalkable(cells.get(next))) continue
      previous.set(next, current)
      queue.push(next)
    }
  }

  const result = new Map<string, MovementPath>()
  for (const destination of previous.keys()) {
    if (destination === start) continue
    const path: Array<{ x: number; y: number }> = []
    let cursor: string | null = destination
    while (cursor && cursor !== start) {
      const [x, y] = cursor.split(',').map(Number)
      path.unshift({ x, y })
      cursor = previous.get(cursor) ?? null
    }
    result.set(destination, { path, costFeet: path.length * cellFeet })
  }
  return result
}

export function movementCellReason(state: GameState, actor: BoardActor, cell: MapCell, remainingFeet: number, paths: Map<string, MovementPath>) {
  if (!cell.revealed) return 'Клетка скрыта туманом войны'
  if (cell.type !== 'floor' && cell.type !== 'door') return 'Клетка непроходима'
  if (occupiedBoardPositions(state, actor.id).has(boardPositionKey(cell.x, cell.y))) return 'Клетка занята'
  const route = paths.get(boardPositionKey(cell.x, cell.y))
  if (!route) return 'Нет доступного маршрута'
  if (route.costFeet > remainingFeet) return `Нужно ${route.costFeet} фт, осталось ${Math.max(0, remainingFeet)} фт`
  return null
}

export type CombatTargetCheck = {
  selected: boolean
  economyReady: boolean
  targetAlive?: boolean
  targetTeam: 'ally' | 'enemy'
  acceptedTarget: 'ally' | 'enemy' | 'creature'
  distanceFeet: number
  rangeFeet: number
  clearTrajectory?: boolean
  equipmentReady?: boolean
  resourceReady?: boolean
  specialBlockReason?: string | null
}

export function evaluateCombatTarget(check: CombatTargetCheck) {
  let reason: string | null = null
  if (!check.selected) reason = 'Сейчас этим участником нельзя командовать'
  else if (!check.economyReady) reason = 'Нужная часть экономики хода уже потрачена'
  else if (check.resourceReady === false) reason = 'Не хватает ресурса'
  else if (check.equipmentReady === false) reason = 'Сначала смените экипированное оружие'
  else if (check.targetAlive === false) reason = 'Цель уже выбыла из боя'
  else if (check.acceptedTarget !== 'creature' && check.acceptedTarget !== check.targetTeam) reason = check.acceptedTarget === 'ally' ? 'Это действие требует союзника' : 'Это действие требует противника'
  else if (check.specialBlockReason) reason = check.specialBlockReason
  else if (check.distanceFeet > check.rangeFeet) reason = `Цель в ${check.distanceFeet} фт: дальность ${check.rangeFeet} фт`
  else if (check.clearTrajectory === false) reason = 'Линию до цели перекрывает стена'
  return { allowed: reason == null, reason }
}

export function battleRollPresentation(event: BattleEvent) {
  if (!event.roll || event.roll.die == null) return null
  const modifier = Number(event.roll.modifier) || 0
  const isSave = event.type === 'spell-save' || event.type === 'concentration-save' || event.type === 'death-save'
  const success = isSave ? event.result === 'success' || event.result === 'stabilized' || event.result === 'revived' : event.roll.hit
  return {
    natural: event.roll.die,
    modifier,
    modifierText: modifier === 0 ? '±0' : `${modifier > 0 ? '+' : '−'}${Math.abs(modifier)}`,
    total: event.roll.total,
    difficulty: event.roll.difficulty,
    difficultyLabel: event.type === 'attack' ? 'КД' : 'СЛ',
    success,
  }
}

const MECHANICS_SUPPORT: Record<MechanicsSupport, {
  label: string
  shortLabel: string
  explanation: string
  blocked: boolean
}> = {
  verified: {
    label: 'Проверенная механика',
    shortLabel: 'ПРОВЕРЕНО',
    explanation: 'Эффект сверён с источником, исполняется сервером и покрыт проверками.',
    blocked: false,
  },
  partial: {
    label: 'Частичная механика',
    shortLabel: 'ЧАСТИЧНО',
    explanation: 'Сервер исполняет только безопасную часть эффекта; отдельные исключения ещё не поддерживаются.',
    blocked: false,
  },
  heuristic: {
    label: 'Непроверенная механика',
    shortLabel: 'НЕ ПРОВЕРЕНО',
    explanation: 'Карточка получена автоматически и пока не допускается к авторитетному бою.',
    blocked: true,
  },
  'ruling-only': {
    label: 'Требуется решение',
    shortLabel: 'НУЖНО РЕШЕНИЕ',
    explanation: 'Для способности ещё нет серверного механического обработчика.',
    blocked: true,
  },
}

export function mechanicsSupportPresentation(support?: MechanicsSupport, supportNote?: string) {
  const status = support && support in MECHANICS_SUPPORT ? support : 'ruling-only'
  const presentation = MECHANICS_SUPPORT[status]
  return {
    status,
    ...presentation,
    explanation: supportNote || presentation.explanation,
  }
}

export type ConditionRuleStatus = 'implemented' | 'partial' | 'marker'

const CONDITION_LABELS: Record<string, string> = {
  unconscious: 'Без сознания',
  incapacitated: 'Недееспособен',
  stunned: 'Ошеломлён',
  paralyzed: 'Парализован',
  restrained: 'Опутан',
  grappled: 'Схвачен',
  prone: 'Сбит с ног',
  poisoned: 'Отравлен',
  blinded: 'Ослеплён',
  frightened: 'Испуган',
  charmed: 'Очарован',
  invisible: 'Невидим',
  disengaged: 'Отход',
  dodging: 'Уклонение',
  helped: 'Помощь',
  readied: 'Подготовлено',
  raging: 'Ярость',
  reckless: 'Безрассудная атака',
  'bardic-inspiration': 'Бардовское вдохновение',
  'beacon-of-hope': 'Маяк надежды',
  'death-ward': 'Оберег от смерти',
  'aura-of-life': 'Аура жизни',
  'aura-of-protection': 'Аура защиты',
  bless: 'Благословение',
  bane: 'Порча',
  'metamagic-quickened': 'Ускоренное заклинание',
  'favored-foe': 'Избранный враг',
  'hunters-mark': 'Метка охотника',
  fled: 'Бежал',
  surrendered: 'Сдался',
}

const IMPLEMENTED_CONDITIONS = new Set([
  'unconscious', 'disengaged', 'bless', 'bane', 'beacon-of-hope', 'death-ward',
  'aura-of-life', 'aura-of-protection', 'metamagic-quickened', 'fled', 'surrendered',
])

const PARTIAL_CONDITIONS = new Set([
  'incapacitated', 'stunned', 'paralyzed', 'restrained', 'grappled', 'prone',
  'invisible', 'dodging', 'helped', 'raging', 'reckless', 'favored-foe', 'hunters-mark',
])

function humanizeConditionId(id: string) {
  return id.split('-').filter(Boolean).map((part) => part.charAt(0).toLocaleUpperCase('ru') + part.slice(1)).join(' ')
}

export function conditionPresentation(condition: { id: string; duration?: string | null } | string) {
  const id = String(typeof condition === 'string' ? condition : condition.id)
  const duration = typeof condition === 'string' ? null : condition.duration
  const status: ConditionRuleStatus = id.startsWith('resistance-') || IMPLEMENTED_CONDITIONS.has(id)
    ? 'implemented'
    : PARTIAL_CONDITIONS.has(id) ? 'partial' : 'marker'
  const statusLabel = status === 'implemented' ? 'эффект работает' : status === 'partial' ? 'эффект частичный' : 'только маркер'
  const explanation = status === 'implemented'
    ? 'Эффект применяется движком в текущем боевом срезе.'
    : status === 'partial'
      ? 'Часть эффекта применяется, но полные правила состояния ещё не реализованы.'
      : 'Состояние хранится и отображается, но его отдельные правила пока не применяются.'
  return {
    id,
    label: CONDITION_LABELS[id] ?? (id.startsWith('resistance-') ? `Сопротивление: ${humanizeConditionId(id.slice('resistance-'.length))}` : humanizeConditionId(id)),
    status,
    statusLabel,
    explanation,
    duration: duration ? String(duration).replace(/^rounds:/, 'раундов: ') : null,
  }
}
