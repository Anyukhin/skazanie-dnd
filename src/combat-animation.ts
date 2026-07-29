import type { BattleEvent, GameEvent } from './types'

export type BoardPoint = { x: number; y: number }

export type CombatAnimationCue =
  | {
      id: string
      kind: 'move'
      actorId: string
      from: BoardPoint
      to: BoardPoint
      path: BoardPoint[]
      durationMs: number
    }
  | {
      id: string
      kind: 'strike'
      actorId: string
      targetId: string
      hit: boolean
      amount: number | null
      damageType?: string
      durationMs: number
    }
  | {
      id: string
      kind: 'impact'
      targetId: string
      amount: number | null
      tone: 'damage' | 'healing' | 'miss'
      damageType?: string
      durationMs: number
    }
  | {
      id: string
      kind: 'death'
      targetId: string
      durationMs: number
    }
  | {
      id: string
      kind: 'condition'
      targetId: string
      condition: string
      label: string
      durationMs: number
    }

/** Не держим больше старых эффектов, чем игрок ещё способен связать с ходом. */
export const COMBAT_ANIMATION_QUEUE_LIMIT = 12
/** Весь подтверждённый пакет, включая движение, удар и состояние NPC, короче 2 с. */
export const COMBAT_ANIMATION_BATCH_BUDGET_MS = 1_800

const BASE_DURATIONS = {
  moveMin: 240,
  moveMax: 560,
  strike: 480,
  impact: 360,
  death: 420,
  condition: 360,
} as const

const CONDITION_LABELS: Record<string, string> = {
  unconscious: 'Без сознания',
  incapacitated: 'Недееспособен',
  stunned: 'Ошеломлён',
  paralyzed: 'Паралич',
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
  raging: 'Ярость',
  surrendered: 'Сдаётся',
  fled: 'Бежит',
}

const point = (value: unknown): BoardPoint | null => {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { x?: unknown; y?: unknown }
  const x = Number(candidate.x)
  const y = Number(candidate.y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

const eventId = (event: GameEvent, suffix = '') => {
  const base = String(event.event_id ?? `${event.command_id ?? 'event'}:${event.event_type}:${event.state_version_after ?? ''}`)
  return suffix ? `${base}:${suffix}` : base
}

const targetIdFor = (event: GameEvent) => String(
  event.target_ids?.[0]
  ?? event.payload?.target_id
  ?? event.payload?.actor_id
  ?? '',
)

const commandKey = (event: GameEvent, targetId = targetIdFor(event)) => `${String(event.command_id ?? '')}|${targetId}`

const safeAmount = (value: unknown) => {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.max(0, amount) : null
}

function conditionLabel(condition: string) {
  return CONDITION_LABELS[condition]
    ?? condition.split('-').filter(Boolean).map((part) => part.charAt(0).toLocaleUpperCase('ru') + part.slice(1)).join(' ')
}

function moveDuration(pathLength: number) {
  return Math.min(BASE_DURATIONS.moveMax, Math.max(BASE_DURATIONS.moveMin, pathLength * 70))
}

/**
 * Превращает уже отфильтрованную для зрителя механику в визуальные сигналы.
 * Урон объединяется с атакой, чтобы обычный удар не занимал два такта;
 * смерть и состояние остаются короткими отдельными акцентами.
 */
export function combatAnimationCuesFromEvents(events: readonly GameEvent[]): CombatAnimationCue[] {
  const damageByCommand = new Map<string, GameEvent[]>()
  const consumedDamage = new Set<GameEvent>()
  for (const event of events) {
    if (event.event_type !== 'DamageApplied') continue
    const key = commandKey(event)
    damageByCommand.set(key, [...(damageByCommand.get(key) ?? []), event])
  }

  const cues: CombatAnimationCue[] = []
  for (const event of events) {
    const payload = event.payload ?? {}
    const actorId = String(event.actor_id ?? '')
    const targetId = targetIdFor(event)

    if (event.event_type === 'ActorMoved') {
      const from = point(payload.from)
      const to = point(payload.to)
      if (!actorId || !from || !to) continue
      const path = Array.isArray(payload.path)
        ? payload.path.map(point).filter((step): step is BoardPoint => Boolean(step))
        : []
      const resolvedPath = path.length ? path : [to]
      cues.push({
        id: eventId(event),
        kind: 'move',
        actorId,
        from,
        to,
        path: resolvedPath,
        durationMs: moveDuration(resolvedPath.length),
      })
      continue
    }

    if (event.event_type === 'AttackResolved') {
      if (!actorId || !targetId) continue
      const related = damageByCommand.get(commandKey(event, targetId)) ?? []
      related.forEach((damage) => consumedDamage.add(damage))
      const amounts = related.map((damage) => safeAmount(damage.payload?.applied_amount)).filter((amount): amount is number => amount != null)
      const damage = amounts.length ? amounts.reduce((total, amount) => total + amount, 0) : null
      const lastDamage = related.at(-1)
      const hit = payload.hit === true
      cues.push({
        id: eventId(event),
        kind: 'strike',
        actorId,
        targetId,
        hit,
        amount: hit ? damage : 0,
        damageType: String(lastDamage?.payload?.damage_type ?? payload.damage_type ?? '') || undefined,
        durationMs: BASE_DURATIONS.strike,
      })
      if (related.some((damageEvent) => Number(damageEvent.payload?.hp_after) === 0)) {
        cues.push({ id: eventId(event, 'death'), kind: 'death', targetId, durationMs: BASE_DURATIONS.death })
      }
      continue
    }

    if (event.event_type === 'DamageApplied' && !consumedDamage.has(event)) {
      if (!targetId) continue
      const amount = safeAmount(payload.applied_amount)
      cues.push({
        id: eventId(event),
        kind: 'impact',
        targetId,
        amount,
        tone: 'damage',
        damageType: String(payload.damage_type ?? '') || undefined,
        durationMs: BASE_DURATIONS.impact,
      })
      if (Number(payload.hp_after) === 0) cues.push({ id: eventId(event, 'death'), kind: 'death', targetId, durationMs: BASE_DURATIONS.death })
      continue
    }

    if (event.event_type === 'HealingApplied') {
      if (!targetId) continue
      cues.push({
        id: eventId(event),
        kind: 'impact',
        targetId,
        amount: safeAmount(payload.applied_amount),
        tone: 'healing',
        durationMs: BASE_DURATIONS.impact,
      })
      continue
    }

    if (event.event_type === 'ConditionAdded') {
      const condition = String(payload.condition ?? '')
      if (!targetId || !condition) continue
      cues.push({
        id: eventId(event),
        kind: 'condition',
        targetId,
        condition,
        label: conditionLabel(condition),
        durationMs: BASE_DURATIONS.condition,
      })
      continue
    }

    if (event.event_type === 'HeroDied' && targetId) {
      cues.push({ id: eventId(event, 'death'), kind: 'death', targetId, durationMs: BASE_DURATIONS.death })
    }
  }
  return fitCombatAnimationBudget(cues)
}

/** Резервный путь для снимков комнаты/SSE с видимым боевым журналом. */
export function combatAnimationCuesFromBattleLog(events: readonly BattleEvent[]): CombatAnimationCue[] {
  const cues: CombatAnimationCue[] = []
  for (const event of events) {
    if (event.type === 'move' && event.actorId && event.from && event.to) {
      const path = event.path?.length ? event.path : [event.to]
      cues.push({
        id: String(event.id),
        kind: 'move',
        actorId: event.actorId,
        from: event.from,
        to: event.to,
        path,
        durationMs: moveDuration(path.length),
      })
      continue
    }
    if (event.type === 'attack' && event.actorId && event.targetId && event.roll) {
      cues.push({
        id: String(event.id),
        kind: 'strike',
        actorId: event.actorId,
        targetId: event.targetId,
        hit: event.roll.hit,
        amount: event.roll.hit ? safeAmount(event.damage) : 0,
        damageType: event.damageType,
        durationMs: BASE_DURATIONS.strike,
      })
      if (event.hpAfter === 0) cues.push({ id: `${event.id}:death`, kind: 'death', targetId: event.targetId, durationMs: BASE_DURATIONS.death })
      continue
    }
    if (event.type === 'spell-damage' && event.targetId) {
      cues.push({
        id: String(event.id),
        kind: 'impact',
        targetId: event.targetId,
        amount: safeAmount(event.damage),
        tone: 'damage',
        damageType: event.damageType,
        durationMs: BASE_DURATIONS.impact,
      })
      if (event.hpAfter === 0) cues.push({ id: `${event.id}:death`, kind: 'death', targetId: event.targetId, durationMs: BASE_DURATIONS.death })
      continue
    }
    if (event.type === 'healing' && event.targetId) {
      cues.push({
        id: String(event.id),
        kind: 'impact',
        targetId: event.targetId,
        amount: safeAmount(event.healing),
        tone: 'healing',
        durationMs: BASE_DURATIONS.impact,
      })
    }
  }
  return fitCombatAnimationBudget(cues)
}

/**
 * Большая команда может включать дополнительные эффекты и реакции. Сжимаем
 * только визуальные такты, никогда не механику, чтобы очередь оставалась краткой.
 */
export function fitCombatAnimationBudget(cues: readonly CombatAnimationCue[]) {
  const total = cues.reduce((sum, cue) => sum + cue.durationMs, 0)
  if (total <= COMBAT_ANIMATION_BATCH_BUDGET_MS || total <= 0) return [...cues]
  const scale = COMBAT_ANIMATION_BATCH_BUDGET_MS / total
  return cues.map((cue) => ({ ...cue, durationMs: Math.max(120, Math.round(cue.durationMs * scale)) }))
}
