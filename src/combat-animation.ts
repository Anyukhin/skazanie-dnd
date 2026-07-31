import type { BattleEvent, GameEvent } from './types'
import { spellIdFromEffect, spellVisualProfile, systemPrefersReducedMotion, type MagicSchool, type SpellEffectDetail } from './spell-effects'

export type BoardPoint = { x: number; y: number }

type CombatAnimationPresentation = {
  id: string
  durationMs: number
  /** Сложность рисунка снижается вместе с бюджетом пакета или кадра. */
  detail?: SpellEffectDetail
  /** При reduced motion реплика остаётся читаемым статическим акцентом. */
  motion?: 'full' | 'reduced'
}

type PhysicalAnimationCue =
  | {
      kind: 'move'
      actorId: string
      from: BoardPoint
      to: BoardPoint
      path: BoardPoint[]
    }
  | {
      kind: 'strike'
      actorId: string
      targetId: string
      hit: boolean
      amount: number | null
      damageType?: string
    }
  | {
      kind: 'impact'
      targetId: string
      amount: number | null
      tone: 'damage' | 'healing' | 'miss'
      damageType?: string
    }
  | {
      kind: 'death'
      targetId: string
    }
  | {
      kind: 'condition'
      targetId: string
      condition: string
      label: string
    }

type SpellAnimationCore = {
  spellId: string
  school: MagicSchool
}

export type SpellAnimationCue = CombatAnimationPresentation & SpellAnimationCore & (
  | {
      kind: 'projectile'
      actorId: string
      targetIds: string[]
      from?: BoardPoint
      to?: BoardPoint
      projectileCount: number
      damageType?: string
    }
  | {
      kind: 'burst'
      actorId: string
      targetIds: string[]
      origin?: BoardPoint
      center?: BoardPoint
      cells?: BoardPoint[]
      shape: 'sphere' | 'cylinder' | 'cone' | 'cube' | 'line'
      originMode?: 'self' | 'point'
      sizeFeet: number
    }
  | {
      kind: 'beam'
      actorId: string
      targetIds: string[]
      from?: BoardPoint
      points?: BoardPoint[]
      chain: boolean
      damageType?: string
    }
  | {
      kind: 'aura'
      actorId: string
      center?: BoardPoint
      radiusFeet: number
      auraType: 'spell' | 'concentration'
      active: boolean
    }
  | {
      kind: 'channel'
      actorId: string
      targetId?: string
      position?: BoardPoint
      channelType: 'cast' | 'healing' | 'summon'
      amount?: number | null
    }
)

export type CombatAnimationCue = CombatAnimationPresentation & PhysicalAnimationCue | SpellAnimationCue

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
  projectile: 520,
  burst: 480,
  beam: 560,
  aura: 440,
  channel: 480,
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

export type CombatAnimationOptions = {
  reducedMotion?: boolean
}

const AREA_SHAPES = new Set(['sphere', 'cylinder', 'cone', 'cube', 'line'])

function areaShape(value: unknown): 'sphere' | 'cylinder' | 'cone' | 'cube' | 'line' | null {
  const shape = String(value ?? '')
  return AREA_SHAPES.has(shape) ? shape as 'sphere' | 'cylinder' | 'cone' | 'cube' | 'line' : null
}

function points(value: unknown) {
  return Array.isArray(value)
    ? value.map(point).filter((entry): entry is BoardPoint => Boolean(entry))
    : []
}

function uniqueIds(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map(String).filter(Boolean))]
    : []
}

function motionFor(options: CombatAnimationOptions) {
  return (options.reducedMotion ?? systemPrefersReducedMotion()) ? 'reduced' as const : 'full' as const
}

function spellCueFromCast(event: GameEvent): SpellAnimationCue | null {
  const payload = event.payload ?? {}
  const actorId = String(event.actor_id ?? '')
  const spellId = String(payload.spell_id ?? '')
  if (!actorId || !spellId) return null
  const profile = spellVisualProfile(spellId, {
    school: String(payload.school ?? ''),
    kind: String(payload.kind ?? ''),
    damageType: String(payload.damage_type ?? ''),
    radius: Number(payload.radius_feet) || undefined,
    areaShape: areaShape(payload.area_shape) ?? undefined,
    concentration: payload.concentration === true,
  })
  const targetIds = uniqueIds(event.target_ids)
  const common = {
    id: eventId(event, profile.kind),
    actorId,
    targetIds,
    spellId,
    school: profile.school,
  }
  if (profile.kind === 'projectile') {
    return {
      ...common,
      kind: 'projectile',
      from: point(payload.from) ?? point(payload.origin) ?? undefined,
      to: point(payload.to) ?? point(payload.center) ?? undefined,
      projectileCount: profile.projectileCount ?? Math.max(1, targetIds.length),
      damageType: String(payload.damage_type ?? '') || undefined,
      durationMs: BASE_DURATIONS.projectile,
    }
  }
  if (profile.kind === 'burst') {
    return {
      ...common,
      kind: 'burst',
      origin: point(payload.from) ?? point(payload.origin) ?? undefined,
      center: point(payload.to) ?? point(payload.center) ?? undefined,
      shape: profile.areaShape ?? areaShape(payload.area_shape) ?? 'sphere',
      originMode: profile.areaOrigin,
      sizeFeet: profile.sizeFeet ?? Math.max(5, Number(payload.radius_feet) || 5),
      durationMs: BASE_DURATIONS.burst,
    }
  }
  if (profile.kind === 'beam') {
    return {
      ...common,
      kind: 'beam',
      from: point(payload.from) ?? point(payload.origin) ?? undefined,
      points: points(payload.points),
      chain: profile.chain === true,
      damageType: String(payload.damage_type ?? '') || undefined,
      durationMs: BASE_DURATIONS.beam,
    }
  }
  if (profile.kind === 'aura') {
    return {
      ...common,
      kind: 'aura',
      center: point(payload.center) ?? undefined,
      radiusFeet: profile.radiusFeet ?? Math.max(5, Number(payload.radius_feet) || 10),
      auraType: 'spell',
      active: true,
      durationMs: BASE_DURATIONS.aura,
    }
  }
  return {
    ...common,
    kind: 'channel',
    targetId: targetIds[0],
    position: point(payload.to) ?? point(payload.center) ?? undefined,
    channelType: 'cast',
    durationMs: BASE_DURATIONS.channel,
  }
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
export function combatAnimationCuesFromEvents(
  events: readonly GameEvent[],
  options: CombatAnimationOptions = {},
): CombatAnimationCue[] {
  const damageByCommand = new Map<string, GameEvent[]>()
  const consumedDamage = new Set<GameEvent>()
  const spellCastByCommand = new Map<string, GameEvent>()
  const areaCommands = new Set<string>()
  for (const event of events) {
    if (event.event_type === 'DamageApplied') {
      const key = commandKey(event)
      damageByCommand.set(key, [...(damageByCommand.get(key) ?? []), event])
    }
    if (event.event_type === 'SpellCast' && event.command_id) spellCastByCommand.set(String(event.command_id), event)
    if (event.event_type === 'SpellAreaCreated' && event.command_id) areaCommands.add(String(event.command_id))
  }

  const cues: CombatAnimationCue[] = []
  for (const event of events) {
    const payload = event.payload ?? {}
    const actorId = String(event.actor_id ?? '')
    const targetId = targetIdFor(event)
    const auraSourceId = String(payload.aura_of_protection_source ?? '')
    if (auraSourceId) {
      cues.push({
        id: eventId(event, 'aura-of-protection'),
        kind: 'aura',
        actorId: auraSourceId,
        spellId: 'paladin-aura-of-protection',
        school: 'abjuration',
        radiusFeet: 10,
        auraType: 'spell',
        active: true,
        durationMs: BASE_DURATIONS.aura,
      })
    }

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

    if (event.event_type === 'SpellCast') {
      const cue = spellCueFromCast(event)
      // Длящаяся область следом несёт точные клетки и центр. Не рисуем её
      // приблизительно по целям, когда в этом же пакете есть точный источник.
      if (cue && !(cue.kind === 'burst' && event.command_id && areaCommands.has(String(event.command_id)))) cues.push(cue)
      continue
    }

    if (event.event_type === 'SpellAreaCreated') {
      const effect = payload.effect && typeof payload.effect === 'object'
        ? payload.effect as Record<string, unknown>
        : payload
      const spellId = String(effect.spell_id ?? spellIdFromEffect(effect.effect_id ?? effect.id))
      const profile = spellVisualProfile(spellId, {
        school: String(effect.school ?? ''),
        damageType: String(effect.damage_type ?? ''),
        areaShape: areaShape(effect.area_shape) ?? undefined,
        radius: Number(effect.radius_feet) || undefined,
      })
      const center = point(effect.center)
      const exactCells = points(effect.cells)
      if (actorId && spellId && (center || exactCells.length)) {
        cues.push({
          id: eventId(event, 'burst'),
          kind: 'burst',
          actorId,
          targetIds: [],
          spellId,
          school: profile.school,
          center: center ?? undefined,
          cells: exactCells.length ? exactCells : undefined,
          shape: profile.areaShape ?? areaShape(effect.area_shape) ?? 'sphere',
          originMode: profile.areaOrigin,
          sizeFeet: profile.sizeFeet ?? Math.max(5, Number(effect.radius_feet) || 5),
          durationMs: BASE_DURATIONS.burst,
        })
      }
      continue
    }

    if (event.event_type === 'ConcentrationStarted' || event.event_type === 'ConcentrationEnded') {
      if (!actorId) continue
      const spellId = spellIdFromEffect(payload.effect_id)
      const profile = spellVisualProfile(spellId)
      cues.push({
        id: eventId(event, 'concentration'),
        kind: 'aura',
        actorId,
        spellId,
        school: profile.school,
        radiusFeet: 0,
        auraType: 'concentration',
        active: event.event_type === 'ConcentrationStarted',
        durationMs: BASE_DURATIONS.aura,
      })
      continue
    }

    if (event.event_type === 'SummonedCreatureCreated') {
      const summon = payload.summon && typeof payload.summon === 'object'
        ? payload.summon as Record<string, unknown>
        : {}
      const summonId = String(summon.id ?? targetId)
      const spellId = String(summon.sourceSpellId ?? summon.source_spell_id ?? '')
      const profile = spellVisualProfile(spellId, { kind: 'summon' })
      const position = point(summon)
      if (!actorId || !summonId) continue
      cues.push({
        id: eventId(event, 'summon'),
        kind: 'channel',
        actorId,
        targetId: summonId,
        position: position ?? undefined,
        spellId,
        school: profile.school,
        channelType: 'summon',
        durationMs: BASE_DURATIONS.channel,
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
      const relatedCast = event.command_id ? spellCastByCommand.get(String(event.command_id)) : undefined
      const spellId = String(payload.spell_id ?? relatedCast?.payload?.spell_id ?? '')
      const profile = spellVisualProfile(spellId, {
        school: String(payload.school ?? relatedCast?.payload?.school ?? ''),
        kind: 'healing',
      })
      cues.push({
        id: eventId(event),
        kind: 'channel',
        actorId: actorId || targetId,
        targetId,
        spellId,
        school: profile.school,
        amount: safeAmount(payload.applied_amount),
        channelType: 'healing',
        durationMs: BASE_DURATIONS.channel,
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
  return fitCombatAnimationBudget(cues, options)
}

/** Резервный путь для снимков комнаты/SSE с видимым боевым журналом. */
export function combatAnimationCuesFromBattleLog(
  events: readonly BattleEvent[],
  options: CombatAnimationOptions = {},
): CombatAnimationCue[] {
  const cues: CombatAnimationCue[] = []
  for (const event of events) {
    if (event.auraSourceId) {
      cues.push({
        id: `${event.id}:aura-of-protection`,
        kind: 'aura',
        actorId: event.auraSourceId,
        spellId: 'paladin-aura-of-protection',
        school: 'abjuration',
        radiusFeet: 10,
        auraType: 'spell',
        active: true,
        durationMs: BASE_DURATIONS.aura,
      })
    }
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
    if (event.type === 'spell' && event.actorId && event.spellId) {
      const profile = spellVisualProfile(event.spellId, { damageType: event.damageType })
      const targetIds = event.targetId ? [event.targetId] : []
      if (profile.kind === 'projectile') {
        cues.push({
          id: `${event.id}:projectile`,
          kind: 'projectile',
          actorId: event.actorId,
          targetIds,
          from: event.from,
          to: event.to,
          projectileCount: profile.projectileCount ?? 1,
          damageType: event.damageType,
          spellId: event.spellId,
          school: profile.school,
          durationMs: BASE_DURATIONS.projectile,
        })
      } else if (profile.kind === 'burst') {
        cues.push({
          id: `${event.id}:burst`,
          kind: 'burst',
          actorId: event.actorId,
          targetIds,
          origin: event.from,
          center: event.area ? { x: event.area.x, y: event.area.y } : event.to,
          shape: profile.areaShape ?? 'sphere',
          originMode: profile.areaOrigin,
          sizeFeet: profile.sizeFeet ?? event.area?.radiusFeet ?? 5,
          spellId: event.spellId,
          school: profile.school,
          durationMs: BASE_DURATIONS.burst,
        })
      } else if (profile.kind === 'beam') {
        cues.push({
          id: `${event.id}:beam`,
          kind: 'beam',
          actorId: event.actorId,
          targetIds,
          from: event.from,
          points: event.to ? [event.to] : undefined,
          chain: profile.chain === true,
          damageType: event.damageType,
          spellId: event.spellId,
          school: profile.school,
          durationMs: BASE_DURATIONS.beam,
        })
      } else if (profile.kind === 'aura') {
        cues.push({
          id: `${event.id}:aura`,
          kind: 'aura',
          actorId: event.actorId,
          radiusFeet: profile.radiusFeet ?? 10,
          auraType: 'spell',
          active: true,
          spellId: event.spellId,
          school: profile.school,
          durationMs: BASE_DURATIONS.aura,
        })
      } else {
        cues.push({
          id: `${event.id}:channel`,
          kind: 'channel',
          actorId: event.actorId,
          targetId: event.targetId,
          position: event.to,
          channelType: 'cast',
          spellId: event.spellId,
          school: profile.school,
          durationMs: BASE_DURATIONS.channel,
        })
      }
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
      const profile = spellVisualProfile(event.spellId ?? '', { kind: 'healing' })
      cues.push({
        id: String(event.id),
        kind: 'channel',
        actorId: event.actorId ?? event.targetId,
        targetId: event.targetId,
        spellId: event.spellId ?? '',
        school: profile.school,
        amount: safeAmount(event.healing),
        channelType: 'healing',
        durationMs: BASE_DURATIONS.channel,
      })
      continue
    }
    if (event.type === 'summon' && event.targetId) {
      const profile = spellVisualProfile(event.spellId ?? '', { kind: 'summon' })
      cues.push({
        id: `${event.id}:summon`,
        kind: 'channel',
        actorId: event.actorId ?? event.targetId,
        targetId: event.targetId,
        position: event.to,
        spellId: event.spellId ?? '',
        school: profile.school,
        channelType: 'summon',
        durationMs: BASE_DURATIONS.channel,
      })
      continue
    }
    if (event.type === 'concentration-end' && event.actorId) {
      const profile = spellVisualProfile(event.spellId ?? '')
      cues.push({
        id: `${event.id}:concentration`,
        kind: 'aura',
        actorId: event.actorId,
        spellId: event.spellId ?? '',
        school: profile.school,
        radiusFeet: 0,
        auraType: 'concentration',
        active: false,
        durationMs: BASE_DURATIONS.aura,
      })
    }
  }
  return fitCombatAnimationBudget(cues, options)
}

/**
 * Большая команда может включать дополнительные эффекты и реакции. Сжимаем
 * только визуальные такты, никогда не механику, чтобы очередь оставалась краткой.
 */
export function fitCombatAnimationBudget(
  cues: readonly CombatAnimationCue[],
  options: CombatAnimationOptions = {},
): CombatAnimationCue[] {
  // Очередь всё равно хранит не больше этого числа. Сжимаем именно тот пакет,
  // который будет показан, чтобы отброшенный хвост не отнимал его бюджет.
  const visible = cues.length > COMBAT_ANIMATION_QUEUE_LIMIT
    ? cues.slice(-COMBAT_ANIMATION_QUEUE_LIMIT)
    : [...cues]
  const motion = motionFor(options)
  if (motion === 'reduced') {
    return visible.map((cue) => ({
      ...cue,
      durationMs: 1,
      detail: 'minimal',
      motion,
    }))
  }

  const total = visible.reduce((sum, cue) => sum + Math.max(0, cue.durationMs), 0)
  if (total <= COMBAT_ANIMATION_BATCH_BUDGET_MS || total <= 0) {
    return visible.map((cue) => ({ ...cue, detail: cue.detail ?? 'full', motion }))
  }

  const scale = COMBAT_ANIMATION_BATCH_BUDGET_MS / total
  const detail: SpellEffectDetail = scale < .48 ? 'minimal' : 'reduced'
  const fitted = visible.map((cue) => ({
    ...cue,
    durationMs: Math.max(90, Math.round(cue.durationMs * scale)),
    detail,
    motion,
  }))
  // Округление и нижняя граница могут дать несколько лишних миллисекунд.
  // Забираем их с конца по одной, не опуская читаемый акцент ниже 90 мс.
  let overflow = fitted.reduce((sum, cue) => sum + cue.durationMs, 0) - COMBAT_ANIMATION_BATCH_BUDGET_MS
  for (let index = fitted.length - 1; index >= 0 && overflow > 0; index -= 1) {
    const available = Math.max(0, fitted[index].durationMs - 90)
    const correction = Math.min(available, overflow)
    fitted[index] = { ...fitted[index], durationMs: fitted[index].durationMs - correction }
    overflow -= correction
  }
  return fitted
}
