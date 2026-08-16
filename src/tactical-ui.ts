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
  /** Доплата за ползание в состоянии prone. */
  crawlingFeet: number
  costFeet: number
}

/**
 * Правило повторяет серверное `isWalkableCell`: туман не делает клетку
 * непроходимой. Раньше здесь стояло `cell.revealed &&`, и клиент не строил
 * маршрут в темноту — подсветки не было, нажатие по клетке ничего не делало,
 * а сервер к тому моменту шаг уже разрешал. Разведка снимает туман по мере
 * движения; стены и вода остаются непроходимыми независимо от него.
 */
const isWalkable = (cell?: MapCell) => Boolean(cell && (cell.type === 'floor' || cell.type === 'door'))

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
 * Активные области и `moveCost` карты зеркалят единую доплату Rules Engine
 * перед MoveActor. Совпавшие источники не складываются.
 */
export function isDifficultTerrain(state: GameState, point: { x: number; y: number }, map?: TacticalMap | null) {
  const mapCost = map ? Number(cellAt(map, point.x, point.y)?.moveCost) || 1 : 1
  if (mapCost > 1) return true
  return (state.mechanics?.active_effects ?? []).some((effect) => (
    effect.difficult_terrain === true && pointInAreaEffect(effect as AreaEffectWithCells, point)
  ))
}

export function movementCostLabel(route: MovementPath) {
  const surcharges = [
    ...(route.difficultTerrainFeet > 0 ? [`${route.difficultTerrainFeet} фт за трудную местность`] : []),
    ...(route.crawlingFeet > 0 ? [`${route.crawlingFeet} фт ползком`] : []),
  ]
  return surcharges.length
    ? `${route.costFeet} фт (${route.baseCostFeet} фт пути + ${surcharges.join(' + ')})`
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
  const conditionIds = new Set((state.mechanics?.conditions?.[actor.id] ?? []).map((condition) => String(condition.id)))
  const crawling = conditionIds.has('prone')
  const ignoresDifficultTerrain = conditionIds.has('freedom-of-movement')
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
      const difficultTerrain = !ignoresDifficultTerrain && isDifficultTerrain(state, { x: nextX, y: nextY }, map)
      const nextCost = current.cost + cellFeet * (1 + (difficultTerrain ? 1 : 0) + (crawling ? 1 : 0))
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
    const difficultTerrainFeet = ignoresDifficultTerrain
      ? 0
      : path.filter((step) => isDifficultTerrain(state, step, map)).length * cellFeet
    const crawlingFeet = crawling ? path.length * cellFeet : 0
    const costFeet = costs.get(destination) ?? baseCostFeet + difficultTerrainFeet + crawlingFeet
    result.set(destination, { path, baseCostFeet, difficultTerrainFeet, crawlingFeet, costFeet })
  }
  return result
}

export function movementCellReason(state: GameState, actor: BoardActor, cell: MapCell, remainingFeet: number, paths: Map<string, MovementPath>) {
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
  /* Малое благословение алтаря или жреца (`server/blessings.mjs`). Имя у него
     своё, отдельное от заклинания «Благословение»: у того кость на каждый
     бросок и концентрация, у этого — плоская единица до первой атаки. */
  'minor-blessing': 'Малое благословение',
  bane: 'Порча',
  'metamagic-quickened': 'Ускоренное заклинание',
  'favored-foe': 'Избранный враг',
  'hunters-mark': 'Метка охотника',
  fled: 'Бежал',
  surrendered: 'Сдался',
  // Качественная форма нанесённого яда. Ровно её сервер отдаёт про клинок
  // противника: ключ вещи из чужого кармана проекция срезает
  // (`publicConditionsFor`, `server/viewer-projection.mjs`), поэтому подписи
  // тоже две — своё оружие герой знает по имени, чужое видно только на глаз.
  'weapon-coated': 'Клинок смазан чем-то тёмным',
}

const IMPLEMENTED_CONDITIONS = new Set([
  'unconscious', 'disengaged', 'bless', 'bane', 'minor-blessing', 'beacon-of-hope', 'death-ward',
  'aura-of-life', 'aura-of-protection', 'metamagic-quickened', 'fled', 'surrendered',
])

const PARTIAL_CONDITIONS = new Set([
  'incapacitated', 'stunned', 'paralyzed', 'restrained', 'grappled', 'prone',
  'invisible', 'dodging', 'helped', 'raging', 'reckless', 'favored-foe', 'hunters-mark',
])

function humanizeConditionId(id: string) {
  return id.split('-').filter(Boolean).map((part) => part.charAt(0).toLocaleUpperCase('ru') + part.slice(1)).join(' ')
}

/**
 * Подписи сроков состояний. Ключи — те же строки, которыми срок объявляет
 * движок (`duration` в `ConditionAdded`), и переводятся они здесь, а не в
 * движке: это подпись для глаза, а не значение для правила.
 *
 * Незнакомый срок отдаётся как есть — молча потерять его хуже, чем показать
 * сырым.
 */
const CONDITION_DURATION_LABELS: Record<string, string> = {
  'until-long-rest': 'до продолжительного отдыха',
  'until-short-rest': 'до короткого отдыха',
  'until-next-turn': 'до начала следующего хода',
}

function conditionDurationLabel(duration: string) {
  return CONDITION_DURATION_LABELS[duration] ?? duration.replace(/^rounds:/, 'раундов: ')
}

export function conditionPresentation(condition: { id: string; duration?: string | null } | string) {
  const id = String(typeof condition === 'string' ? condition : condition.id)
  const duration = typeof condition === 'string' ? null : condition.duration
  const status: ConditionRuleStatus = id.startsWith('resistance-') || id.startsWith('weapon-coated') || IMPLEMENTED_CONDITIONS.has(id)
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
    label: CONDITION_LABELS[id]
      ?? (id.startsWith('weapon-coated:') ? 'Оружие смазано ядом'
        : id.startsWith('resistance-') ? `Сопротивление: ${humanizeConditionId(id.slice('resistance-'.length))}`
          : humanizeConditionId(id)),
    status,
    statusLabel,
    explanation,
    duration: duration ? conditionDurationLabel(String(duration)) : null,
  }
}

/**
 * Знаки под фишкой. Живут рядом с `conditionPresentation`, а не в доске: подпись
 * состояния собирается здесь же, и знак — вторая половина одного решения. Пока
 * они стояли внутри `DungeonMap.tsx`, вызвать их из теста было нечем — модуль
 * тянет react, lucide-react и два десятка соседей, — и единственным сторожем
 * оставалась регулярка по тексту исходника: она держала форму записи, а не
 * поведение.
 */
export const TOKEN_CONDITION_GLYPHS: Record<string, string> = {
  paralyzed: '✦',
  restrained: '⌁',
  prone: '▰',
  frightened: '!',
  // Смазанный ядом клинок противника. Без своего знака под фишку уезжала
  // первая буква подписи, а «К» о яде не говорит ничего.
  'weapon-coated': '☠',
}

export const TOKEN_CONDITION_PRIORITY = ['paralyzed', 'restrained', 'prone', 'frightened']

/**
 * Знак состояния под фишкой. Смазанный клинок приезжает в двух формах: чужой —
 * непрозрачной (`weapon-coated`), свой — точной (`weapon-coated:<item_id>`),
 * потому что проекция обезличивает только карман противника
 * (`publicConditionsFor`, `server/viewer-projection.mjs`). Знак у обеих форм
 * один: иначе под своей фишкой вместо черепа стояла бы первая буква подписи.
 */
export function tokenConditionGlyph(id: string, label: string) {
  if (id.startsWith('weapon-coated:')) return TOKEN_CONDITION_GLYPHS['weapon-coated']
  return TOKEN_CONDITION_GLYPHS[id] ?? label.slice(0, 1)
}

/**
 * Этажи локации (`docs/multilevel-map-plan.md`, раздел 6). Всё, что клиент
 * считает о переходе между этажами, живёт здесь чистыми функциями: доска и
 * экран только показывают результат, а тесты `test/tactical-ui.test.mjs`
 * проверяют его без DOM.
 */
export type SceneLevel = { index: number; label?: string }

/**
 * Ключ запомненной камеры доски. У каждого этажа своя камера: партия бегает по
 * лестнице туда-сюда, и общий ключ возвращал бы её на угол чужого этажа. Этаж
 * входа ключ не меняет — записи, сделанные до этажей, остаются валидными (то же
 * правило, что у серверного `levelKey`).
 */
export function boardCameraKey(locationId?: string | null, levelIndex = 0) {
  const base = String(locationId || '') || 'нет карты'
  const level = Number.isSafeInteger(Number(levelIndex)) ? Number(levelIndex) : 0
  return level === 0 ? base : `${base}@L${level}`
}

/**
 * Подпись этажа для игрока. Порядок источников: подпись самого перехода, затем
 * известные партии этажи, затем номер — кнопка и индикатор не должны остаться
 * без текста, даже если сервер прислал пустую строку.
 */
export function levelLabelFor(toLevel: number, transitionLabel?: string, levels: readonly SceneLevel[] = []) {
  const declared = String(transitionLabel ?? '').trim()
  if (declared) return declared
  const known = levels.find((level) => Number(level?.index) === Number(toLevel))
  const remembered = String(known?.label ?? '').trim()
  if (remembered) return remembered
  return `этаж ${Number(toLevel)}`
}

/**
 * Подсказка у предмета-перехода: «Ведёт: Винный погреб». Нужна отдельно от
 * надписи кнопки — кнопка появляется только у подошедшего вплотную персонажа,
 * а «куда ведёт эта лестница» игрок спрашивает раньше, наведением с другого
 * конца зала. `null` означает, что предмет переходом не является.
 */
export function levelTransitionHint(
  transition: { toLevel: number; label?: string } | null | undefined,
  levels: readonly SceneLevel[] = [],
) {
  if (!transition || !Number.isFinite(Number(transition.toLevel))) return null
  return `Ведёт: ${levelLabelFor(Number(transition.toLevel), transition.label, levels)}`
}

export type LevelTransitionPresentation = {
  /** Надпись кнопки: направление и подпись целевого этажа. */
  label: string
  direction: 'up' | 'down'
  disabled: boolean
  /** Подсказка: при отказе объясняет причину, иначе повторяет надпись. */
  title: string
}

/**
 * Кнопка у лестницы. Далеко и бой — разные отказы: кнопка в обоих случаях
 * видна, но подсказка называет, что именно мешает. Проверка расстояния здесь
 * клиентская и недоверенная — авторитет остаётся за `TRANSITION_TOO_FAR`
 * в Rules Engine.
 */
export function levelTransitionPresentation(input: {
  transition: { toLevel: number; label?: string }
  currentLevel?: number
  levels?: readonly SceneLevel[]
  atHand: boolean
  combatActive: boolean
}): LevelTransitionPresentation {
  const current = Number.isSafeInteger(Number(input.currentLevel)) ? Number(input.currentLevel) : 0
  const toLevel = Number(input.transition?.toLevel) || 0
  const direction: 'up' | 'down' = toLevel > current ? 'up' : 'down'
  const label = `${direction === 'up' ? 'Подняться' : 'Спуститься'}: ${levelLabelFor(toLevel, input.transition?.label, input.levels ?? [])}`
  const refusal = input.combatActive
    ? 'Сначала завершите бой'
    : input.atHand ? '' : 'Подойдите вплотную'
  return { label, direction, disabled: Boolean(refusal), title: refusal || label }
}

/**
 * Строки индикатора этажей: верхний этаж сверху, активный помечен. Один этаж —
 * не выбор, а шум, поэтому индикатор одноэтажной локации пустой.
 */
export function levelIndicatorRows(levels: readonly SceneLevel[] | undefined, currentIndex = 0) {
  const byIndex = new Map<number, { index: number; label: string; active: boolean }>()
  const current = Number.isSafeInteger(Number(currentIndex)) ? Number(currentIndex) : 0
  for (const level of levels ?? []) {
    const index = Number(level?.index)
    if (!Number.isSafeInteger(index) || byIndex.has(index)) continue
    byIndex.set(index, { index, label: levelLabelFor(index, level?.label), active: index === current })
  }
  const rows = [...byIndex.values()].sort((left, right) => right.index - left.index)
  return rows.length > 1 ? rows : []
}
