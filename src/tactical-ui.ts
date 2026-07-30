import { cellAt, doorBlocksStep } from './tactical-map-client'
import type { BattleEvent, GameEvent, GameState, MapCell, MechanicsSupport, TacticalMap } from './types'

export const boardPositionKey = (x: number, y: number) => `${x},${y}`

type BoardActor = { id: string; x: number; y: number }

export type MovementPath = {
  path: Array<{ x: number; y: number }>
  /** Стоимость обычных шагов без труднопроходимой местности. */
  baseCostFeet: number
  /** Доплата за труднопроходимые клетки; нужна подписи предпросмотра. */
  difficultTerrainFeet: number
  costFeet: number
}

const isWalkable = (cell?: MapCell) => Boolean(cell?.revealed && (cell.type === 'floor' || cell.type === 'door'))

type AreaEffectWithCells = NonNullable<NonNullable<GameState['mechanics']>['active_effects']>[number] & {
  cells?: Array<{ x: number; y: number }>
}

function pointInAreaEffect(effect: AreaEffectWithCells, point: { x: number; y: number }) {
  if (Array.isArray(effect.cells)) {
    return effect.cells.some((cell) => Number(cell.x) === point.x && Number(cell.y) === point.y)
  }
  if (!effect.center) return false
  const radiusCells = Math.max(0, Math.floor((Number(effect.radius_feet) || 0) / 5))
  return Math.max(Math.abs(point.x - effect.center.x), Math.abs(point.y - effect.center.y)) <= radiusCells
}

/**
 * Активные области зеркалят доплату Rules Engine перед MoveActor. Слой
 * `moveCost` карты тоже показывается заранее: контракт уже объявляет 1/2, хотя
 * серверное перемещение пока расходует только трудные области заклинаний.
 */
export function isDifficultTerrain(state: GameState, point: { x: number; y: number }, map?: TacticalMap | null) {
  const mapCost = map ? Number(cellAt(map, point.x, point.y)?.moveCost) || 1 : 1
  if (mapCost > 1) return true
  return (state.mechanics?.active_effects ?? []).some((effect) => (
    effect.difficult_terrain === true && pointInAreaEffect(effect as AreaEffectWithCells, point)
  ))
}

export function movementCostLabel(route: MovementPath) {
  return route.difficultTerrainFeet > 0
    ? `${route.costFeet} фт (${route.baseCostFeet} фт пути + ${route.difficultTerrainFeet} фт за трудную местность)`
    : `${route.costFeet} фт`
}

export function turnClockPresentation(clock: GameState['turn_clock'], now = Date.now()) {
  if (!clock) return null
  const deadline = Date.parse(String(clock.deadline_at))
  const durationMs = Math.max(1, Number(clock.duration_ms) || 1)
  if (!Number.isFinite(deadline)) return null
  const remainingMs = Math.max(0, deadline - Number(now))
  const remainingSeconds = Math.ceil(remainingMs / 1_000)
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds % 60
  return {
    remainingMs,
    remainingSeconds,
    label: `${minutes}:${String(seconds).padStart(2, '0')}`,
    remainingRatio: Math.max(0, Math.min(1, remainingMs / durationMs)),
    urgent: remainingSeconds <= 15,
    expired: remainingMs === 0,
  }
}

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
export function buildMovementPaths(state: GameState, actor: BoardActor, cellFeet = 5, map?: TacticalMap | null) {
  const cells = new Map(state.scene.cells.map((cell) => [boardPositionKey(cell.x, cell.y), cell]))
  const blocked = occupiedBoardPositions(state, actor.id)
  const start = boardPositionKey(actor.x, actor.y)
  const costs = new Map<string, number>([[start, 0]])
  const previous = new Map<string, string | null>([[start, null]])
  const frontier: Array<{ key: string; cost: number }> = [{ key: start, cost: 0 }]
  const pushFrontier = (entry: { key: string; cost: number }) => {
    frontier.push(entry)
    let child = frontier.length - 1
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2)
      if (frontier[parent].cost <= frontier[child].cost) break
      ;[frontier[parent], frontier[child]] = [frontier[child], frontier[parent]]
      child = parent
    }
  }
  const popFrontier = () => {
    const first = frontier[0]
    const last = frontier.pop()
    if (frontier.length && last) {
      frontier[0] = last
      let parent = 0
      while (true) {
        const left = parent * 2 + 1
        const right = left + 1
        let smallest = parent
        if (left < frontier.length && frontier[left].cost < frontier[smallest].cost) smallest = left
        if (right < frontier.length && frontier[right].cost < frontier[smallest].cost) smallest = right
        if (smallest === parent) break
        ;[frontier[parent], frontier[smallest]] = [frontier[smallest], frontier[parent]]
        parent = smallest
      }
    }
    return first
  }

  while (frontier.length) {
    const current = popFrontier()
    if (!current || current.cost !== costs.get(current.key)) continue
    const [x, y] = current.key.split(',').map(Number)
    for (const [nextX, nextY] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      const next = boardPositionKey(nextX, nextY)
      if (blocked.has(next) || !isWalkable(cells.get(next))) continue
      // Закрытая и запертая дверь останавливают шаг ровно так же, как на
      // сервере: иначе предпросмотр вёл бы маршрут сквозь запертую дверь.
      if (map && doorBlocksStep(map, x, y, nextX, nextY)) continue
      const nextCost = current.cost + cellFeet * (isDifficultTerrain(state, { x: nextX, y: nextY }, map) ? 2 : 1)
      if (nextCost >= (costs.get(next) ?? Number.POSITIVE_INFINITY)) continue
      costs.set(next, nextCost)
      previous.set(next, current.key)
      pushFrontier({ key: next, cost: nextCost })
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
    const baseCostFeet = path.length * cellFeet
    const costFeet = costs.get(destination) ?? baseCostFeet
    const difficultTerrainFeet = Math.max(0, costFeet - baseCostFeet)
    result.set(destination, { path, baseCostFeet, difficultTerrainFeet, costFeet })
  }
  return result
}

export function movementCellReason(state: GameState, actor: BoardActor, cell: MapCell, remainingFeet: number, paths: Map<string, MovementPath>) {
  if (!cell.revealed) return 'Клетка скрыта туманом войны'
  if (cell.type !== 'floor' && cell.type !== 'door') return 'Клетка непроходима'
  if (occupiedBoardPositions(state, actor.id).has(boardPositionKey(cell.x, cell.y))) return 'Клетка занята'
  const route = paths.get(boardPositionKey(cell.x, cell.y))
  if (!route) return 'Нет доступного маршрута: возможно, путь перекрыт закрытой дверью'
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
  if (!event.roll) return null
  const natural = event.roll.die == null ? null : Number(event.roll.die)
  const modifier = natural == null ? null : Number(event.roll.modifier) || 0
  const isSave = event.type === 'spell-save' || event.type === 'concentration-save' || event.type === 'death-save'
  const success = isSave ? event.result === 'success' || event.result === 'stabilized' || event.result === 'revived' : event.roll.hit
  return {
    natural,
    modifier,
    modifierText: modifier == null ? 'скрыт' : modifier === 0 ? '±0' : `${modifier > 0 ? '+' : '−'}${Math.abs(modifier)}`,
    total: event.roll.total,
    difficulty: event.roll.difficulty,
    difficultyLabel: event.type === 'attack' ? 'КД' : 'СЛ',
    success,
    outcome: event.type === 'attack' ? (success ? 'попадание' : 'промах') : (success ? 'успех' : 'неудача'),
  }
}

const TARGET_CONDITION_REASONS: Record<string, string> = {
  blinded: 'цель ослеплена',
  paralyzed: 'цель парализована',
  petrified: 'цель окаменела',
  prone: 'цель сбита с ног',
  restrained: 'цель опутана',
  stunned: 'цель оглушена',
  unconscious: 'цель без сознания',
}

const ATTACKER_CONDITION_REASONS: Record<string, string> = {
  blinded: 'атакующий ослеплён',
  frightened: 'атакующий испуган',
  poisoned: 'атакующий отравлен',
  prone: 'атакующий сбит с ног',
  restrained: 'атакующий опутан',
}

function conditionRollReason(value: unknown) {
  const [side, condition] = String(value ?? '').split(':')
  if (!condition) return ''
  if (side === 'target') return TARGET_CONDITION_REASONS[condition] ?? `состояние цели: ${condition}`
  if (side === 'attacker') return ATTACKER_CONDITION_REASONS[condition] ?? `состояние атакующего: ${condition}`
  return String(value)
}

/**
 * Объясняет показанный бросок только полями подтверждённого `AttackResolved`.
 * Если сервер не прислал происхождение, клиент не достраивает преимущество
 * самостоятельно из позиций или состояний.
 */
export function battleRollContext(events: readonly GameEvent[] | null | undefined, event: BattleEvent) {
  if (event.type !== 'attack' || !event.roll) return null
  if (event.rollMode) {
    return {
      mode: event.rollMode,
      dice: Array.isArray(event.rollDice) ? event.rollDice.map(Number).filter(Number.isFinite) : [],
      advantageReasons: [...new Set((event.advantageReasons ?? []).map(String).filter(Boolean))],
      disadvantageReasons: [...new Set((event.disadvantageReasons ?? []).map(String).filter(Boolean))],
    }
  }
  const resolved = [...(events ?? [])].reverse().find((candidate) => {
    if (candidate.event_type !== 'AttackResolved') return false
    const payload = candidate.payload ?? {}
    const targetId = String(candidate.target_ids?.[0] ?? payload.target_id ?? '')
    return String(candidate.actor_id ?? '') === String(event.actorId ?? '')
      && targetId === String(event.targetId ?? '')
      && Number(payload.total) === Number(event.roll?.total)
      && Number(payload.kept) === Number(event.roll?.die)
  })
  if (!resolved) return null
  const payload = resolved.payload ?? {}
  const mode = payload.mode === 'advantage' || payload.mode === 'disadvantage' ? payload.mode : 'normal'
  const advantageReasons = (Array.isArray(payload.condition_advantage) ? payload.condition_advantage : [])
    .map(conditionRollReason).filter(Boolean)
  const disadvantageReasons = (Array.isArray(payload.condition_disadvantage) ? payload.condition_disadvantage : [])
    .map(conditionRollReason).filter(Boolean)
  if (payload.pack_tactics === true) advantageReasons.push('тактика стаи')
  if (payload.high_ground === 'higher') advantageReasons.push('позиция выше цели')
  if (payload.high_ground === 'lower') disadvantageReasons.push('позиция ниже цели')
  if (payload.long_range === true) disadvantageReasons.push('дальний диапазон')
  return {
    mode,
    dice: Array.isArray(payload.dice) ? payload.dice.map(Number).filter(Number.isFinite) : [],
    advantageReasons: [...new Set(advantageReasons)],
    disadvantageReasons: [...new Set(disadvantageReasons)],
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
