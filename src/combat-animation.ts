import { normalizePublicLoadout } from '../server/equipment-visuals.mjs'
import type { BattleEvent, GameEvent, PublicLoadout } from './types'
import { spellEffectPalette, spellIdFromEffect, spellVisualProfile, systemPrefersReducedMotion, type MagicSchool, type SpellEffectDetail, type SpellEffectFamily } from './spell-effects'

export type BoardPoint = { x: number; y: number }

export type AttackKind = 'melee' | 'ranged' | 'thrown'
export type AttackEquipment = 'unknown' | 'unarmed' | 'sword' | 'sword-shield' | 'bow' | 'staff' | 'dagger'
export type AttackVisualStyle = 'slash' | 'pierce' | 'bludgeon' | 'unarmed' | 'natural' | 'bow' | 'crossbow' | 'sling' | 'dart' | 'firearm' | 'wand' | 'net' | 'thrown'
export type AttackOutcome = 'hit' | 'miss' | 'critical' | 'blocked'
export type AttackVisualSnapshot = {
  version: 1
  equipment: AttackEquipment
} | {
  version: 2
  equipment: AttackEquipment
  loadout: PublicLoadout
}

const RANGED_WEAPON_MODEL_KEYS = new Set([
  'shortbow', 'longbow', 'light-crossbow', 'hand-crossbow', 'heavy-crossbow',
  'sling', 'blowgun', 'musket', 'pistol',
])

/** Стиль по полному публичному каталогу оружия; attackKind `thrown` имеет приоритет. */
const MODEL_ATTACK_STYLES: Readonly<Record<string, AttackVisualStyle>> = Object.freeze({
  club: 'bludgeon', dagger: 'pierce', greatclub: 'bludgeon', handaxe: 'slash', javelin: 'pierce',
  'light-hammer': 'bludgeon', mace: 'bludgeon', quarterstaff: 'bludgeon', sickle: 'slash', spear: 'pierce',
  dart: 'dart', 'light-crossbow': 'crossbow', shortbow: 'bow', sling: 'sling', battleaxe: 'slash', flail: 'bludgeon',
  glaive: 'slash', greataxe: 'slash', greatsword: 'slash', halberd: 'slash', lance: 'pierce', longsword: 'slash',
  maul: 'bludgeon', morningstar: 'pierce', pike: 'pierce', rapier: 'pierce', scimitar: 'slash', shortsword: 'pierce',
  trident: 'pierce', warhammer: 'bludgeon', 'war-pick': 'pierce', whip: 'slash', blowgun: 'dart',
  'hand-crossbow': 'crossbow', 'heavy-crossbow': 'crossbow', longbow: 'bow', musket: 'firearm', pistol: 'firearm',
  wand: 'wand', net: 'net',
})

function cueUsesRangedModel(cue: Extract<CombatAnimationCue, { kind: 'strike' }>): boolean {
  const modelKey = cue.loadout?.main_hand?.model_key
  return typeof modelKey === 'string' && RANGED_WEAPON_MODEL_KEYS.has(modelKey)
}

/** Доля такта, после которой снаряд достигает цели и можно включать hit pose. */
export function strikeUsesProjectile(cue: Extract<CombatAnimationCue, { kind: 'strike' }>): boolean {
  return cue.attackKind === 'ranged' || cue.attackKind === 'thrown'
    || (cue.attackKind == null && (cue.equipment === 'bow' || cueUsesRangedModel(cue)))
}

export function strikeImpactProgress(cue: Extract<CombatAnimationCue, { kind: 'strike' }>): number {
  return strikeUsesProjectile(cue) ? .72 : .3
}

/**
 * Нормализует движение атакующего так, чтобы его середина (p=.5) совпадала
 * с подтверждённым контактом. Одна шкала нужна 2D/3D и не меняет серверный
 * момент попадания.
 */
export function strikeMotionProgress(cue: Extract<CombatAnimationCue, { kind: 'strike' }>, progress: number): number {
  const value = Math.max(0, Math.min(1, Number(progress) || 0))
  const contact = strikeImpactProgress(cue)
  if (contact <= 0 || contact >= 1) return value
  return value < contact
    ? value / contact * .5
    : .5 + (value - contact) / (1 - contact) * .5
}

/** Доля такта до выпуска стрелы/брошенного оружия; melee выпуска не ждёт. */
export function strikeLaunchProgress(cue: Extract<CombatAnimationCue, { kind: 'strike' }>): number {
  return strikeUsesProjectile(cue) ? .2 : 0
}

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
      /** Зафиксированный сервером способ атаки; у старых событий отсутствует. */
      attackKind?: AttackKind
      /** Снимок снаряжения на момент удара; не читается из текущего инвентаря. */
      equipment?: AttackEquipment
      /** Полный публичный snapshot v2; v1 cues сохраняют отсутствие поля. */
      loadout?: PublicLoadout
      /** Концы серверной траектории, если она была в событии. */
      from?: BoardPoint
      to?: BoardPoint
      /** Серверный natural/automatic critical; не выводится из урона. */
      critical?: boolean
      /** Удар перехватил подтверждённый сервером блок/двойник. */
      blocked?: boolean
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
  /** Фаза презентации нужна только составным авторитетным эффектам. */
  presentationPhase?: 'departure' | 'arrival'
  /** Override палитры для составной сцены; не меняет реальную механику spellId. */
  visualFamily?: SpellEffectFamily
  /** Авторитетный исход spell-attack по target id; отсутствие означает неизвестно. */
  targetOutcomes?: Readonly<Record<string, AttackOutcome>>
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
      areaSideFeet?: number
      damageType?: string
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
      from?: BoardPoint
      position?: BoardPoint
      channelType: 'cast' | 'healing' | 'summon' | 'teleport'
      amount?: number | null
    }
)

export type CombatAnimationCue = CombatAnimationPresentation & PhysicalAnimationCue | SpellAnimationCue

export function attackVisualStyleForModelKey(value: unknown): AttackVisualStyle | undefined {
  const key = String(value ?? '').toLocaleLowerCase('en-US')
  return MODEL_ATTACK_STYLES[key]
}

export type AttackActorVisual = {
  kind?: string
  archetype?: string
  modelKey?: string
  appearance?: { profile?: string }
}

const NATURAL_ATTACK_ARCHETYPES = new Set(['beast', 'wolf', 'bear', 'boar', 'lion', 'tiger', 'hound', 'spider'])

/** Природный удар определяется публичной моделью/архетипом, а не именем NPC. */
export function attackVisualStyleForActor(
  cue: Extract<CombatAnimationCue, { kind: 'strike' }>,
  actor?: AttackActorVisual | null,
): AttackVisualStyle {
  const archetype = String(actor?.archetype ?? '').toLocaleLowerCase('en-US')
  const modelKey = String(actor?.modelKey ?? '').toLocaleLowerCase('en-US')
  const profile = String(actor?.appearance?.profile ?? '').toLocaleLowerCase('en-US')
  const naturalArchetype = NATURAL_ATTACK_ARCHETYPES.has(archetype)
    || /(?:beast|wolf|bear|boar|lion|tiger|hound|spider|snake|rat)/u.test(archetype)
  if (profile === 'beast' || naturalArchetype || ['wolf', 'beast'].includes(modelKey)) return 'natural'
  return attackVisualStyle(cue)
}

/**
 * Один источник правды для читаемого рисунка физической атаки. В первую
 * очередь используется frozen loadout из AttackResolved; старые события
 * остаются совместимы с coarse equipment и damage type.
 */
export function attackVisualStyle(cue: Extract<CombatAnimationCue, { kind: 'strike' }>): AttackVisualStyle {
  const modelKey = String(cue.loadout?.main_hand?.model_key ?? '').toLocaleLowerCase('en-US')
  const modelStyle = attackVisualStyleForModelKey(modelKey)
  if (cue.attackKind === 'thrown') return modelStyle === 'net' ? 'net' : 'thrown'
  if (cue.equipment === 'unarmed') return 'unarmed'
  if (modelStyle === 'wand' && cue.attackKind !== 'ranged') return 'bludgeon'
  if (modelStyle && !(cue.attackKind === 'melee' && ['bow', 'crossbow', 'sling', 'dart', 'firearm', 'wand'].includes(modelStyle))) return modelStyle
  if (cue.attackKind === 'melee' && modelStyle && ['bow', 'crossbow', 'sling', 'dart', 'firearm'].includes(modelStyle)) return 'slash'
  if (cue.attackKind === 'ranged' || cue.equipment === 'bow' || RANGED_WEAPON_MODEL_KEYS.has(modelKey)) return 'bow'
  const damageType = String(cue.damageType ?? '').toLocaleLowerCase('en-US')
  if (damageType === 'bludgeoning' || damageType === 'bludgeon') return 'bludgeon'
  if (damageType === 'piercing' || damageType === 'pierce') return 'pierce'
  if (damageType === 'slashing' || damageType === 'slash') return 'slash'
  if (cue.equipment === 'dagger') return 'pierce'
  if (cue.equipment === 'staff') return 'bludgeon'
  return 'slash'
}

/** Outcome берётся только из серверных признаков события. */
export function attackOutcome(cue: Extract<CombatAnimationCue, { kind: 'strike' }>): AttackOutcome {
  if (cue.blocked) return 'blocked'
  if (cue.critical && cue.hit) return 'critical'
  return cue.hit ? 'hit' : 'miss'
}

function attackOutcomeFromPayload(payload: Record<string, unknown>): AttackOutcome {
  const shieldBlocked = payload.shielded_by_reaction === true && payload.hit !== true
  if (payload.mirror_image_intercepted === true || payload.blocked === true || shieldBlocked) return 'blocked'
  if (payload.critical === true && payload.hit === true) return 'critical'
  return payload.hit === true ? 'hit' : 'miss'
}

/** Поза погибшего не опережает анимацию, объясняющую его выбытие. */
export function shouldDeferDefeat(
  actorId: string,
  activeCue: CombatAnimationCue | undefined,
  pendingCues: readonly CombatAnimationCue[],
): boolean {
  if (activeCue?.kind === 'death' && activeCue.targetId === actorId) return false
  const sequence = activeCue ? [activeCue, ...pendingCues] : pendingCues
  return sequence.some((cue) => (cue.kind === 'strike' || cue.kind === 'impact' || cue.kind === 'death') && cue.targetId === actorId)
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
  // Качественная форма нанесённого яда: ключ вещи из чужого кармана проекция
  // срезает (`publicConditionsFor`, `server/viewer-projection.mjs`), и над
  // клеткой всплывает то, что видно за столом, а не опись инвентаря.
  'weapon-coated': 'Клинок смазан',
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

type SpellCastGeometry = {
  from?: BoardPoint
  to?: BoardPoint
  center?: BoardPoint
  cells: BoardPoint[]
  points: BoardPoint[]
  shape?: 'sphere' | 'cylinder' | 'cone' | 'cube' | 'line'
  originMode?: 'self' | 'point'
  radiusFeet?: number
  areaSideFeet?: number
}

/**
 * Геометрия приходит плоскими полями в подтверждённом событии. Старые события
 * ничего из этого не содержат и остаются валидными.
 */
function spellCastGeometry(payload: Record<string, unknown>): SpellCastGeometry {
  const from = point(payload.from) ?? point(payload.origin)
  const to = point(payload.to) ?? point(payload.center)
  const center = point(payload.center) ?? point(payload.to)
  const cells = points(payload.cells)
  const areaPoints = points(payload.points)
  const shape = areaShape(payload.area_shape) ?? undefined
  const originMode = payload.area_origin === 'self' || payload.area_origin === 'point'
    ? payload.area_origin
    : undefined
  const radius = Number(payload.radius_feet)
  const areaSideFeet = Number(payload.area_side_feet)
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(center ? { center } : {}),
    cells,
    points: areaPoints,
    ...(shape ? { shape } : {}),
    ...(originMode ? { originMode } : {}),
    ...(Number.isFinite(radius) && radius > 0 ? { radiusFeet: radius } : {}),
    ...(Number.isFinite(areaSideFeet) && areaSideFeet > 0 ? { areaSideFeet } : {}),
  }
}

function uniqueIds(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map(String).filter(Boolean))]
    : []
}

const ATTACK_KINDS = new Set<AttackKind>(['melee', 'ranged', 'thrown'])
const ATTACK_EQUIPMENT = new Set<AttackEquipment>(['unknown', 'unarmed', 'sword', 'sword-shield', 'bow', 'staff', 'dagger'])

function attackKind(value: unknown): AttackKind | undefined {
  const kind = String(value)
  return ATTACK_KINDS.has(kind as AttackKind) ? kind as AttackKind : undefined
}

function attackEquipment(value: unknown): AttackEquipment | undefined {
  const equipment = String(value)
  return ATTACK_EQUIPMENT.has(equipment as AttackEquipment) ? equipment as AttackEquipment : undefined
}

function attackVisualSnapshot(value: unknown): AttackVisualSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const snapshot = value as { version?: unknown; equipment?: unknown; loadout?: unknown }
  if (snapshot.version === 1) return { version: 1, equipment: attackEquipment(snapshot.equipment) ?? 'unknown' }
  if (snapshot.version === 2) {
    return {
      version: 2,
      equipment: attackEquipment(snapshot.equipment) ?? 'unknown',
      loadout: normalizePublicLoadout(snapshot.loadout),
    }
  }
  return null
}

function trajectoryEnds(value: unknown): { from: BoardPoint; to: BoardPoint } | null {
  if (!Array.isArray(value)) return null
  const trajectory = value.map(point)
  if (trajectory.length < 2 || trajectory.some((entry) => !entry)) return null
  return { from: trajectory[0]!, to: trajectory.at(-1)! }
}

type AttackCueFields = Pick<Extract<PhysicalAnimationCue, { kind: 'strike' }>, 'attackKind' | 'equipment' | 'loadout' | 'from' | 'to' | 'critical' | 'blocked'>

function attackCueFieldsFromEvent(payload: Record<string, unknown>): AttackCueFields {
  const visual = attackVisualSnapshot(payload.attack_visual ?? payload.attackVisual)
  const ends = trajectoryEnds(payload.trajectory)
  const shieldBlocked = payload.shielded_by_reaction === true && payload.hit !== true
  return {
    ...(attackKind(payload.attack_kind ?? payload.attackKind) ? { attackKind: attackKind(payload.attack_kind ?? payload.attackKind) } : {}),
    ...(visual ? { equipment: visual.equipment } : {}),
    ...(visual?.version === 2 ? { loadout: visual.loadout } : {}),
    ...(ends ?? {}),
    ...(payload.critical === true ? { critical: true } : {}),
    ...(payload.mirror_image_intercepted === true || payload.blocked === true || shieldBlocked ? { blocked: true } : {}),
  }
}

function attackCueFieldsFromBattleLog(event: BattleEvent): AttackCueFields {
  const value = event as BattleEvent & {
    attackKind?: unknown
    attack_kind?: unknown
    attack_visual?: unknown
    attackEquipment?: unknown
    equipment?: unknown
    trajectory?: unknown
    critical?: unknown
    blocked?: unknown
    shieldedByReaction?: unknown
    shielded_by_reaction?: unknown
    mirrorImageIntercepted?: unknown
    mirror_image_intercepted?: unknown
  }
  const visual = attackVisualSnapshot(value.attackVisual ?? value.attack_visual)
  const ends = trajectoryEnds(value.trajectory)
  const loggedFrom = point(value.from)
  const loggedTo = point(value.to)
  const fallbackEnds = !ends && loggedFrom && loggedTo ? { from: loggedFrom, to: loggedTo } : {}
  const shieldBlocked = (value.shieldedByReaction === true || value.shielded_by_reaction === true)
    && value.roll?.hit !== true
  return {
    ...(attackKind(value.attackKind ?? value.attack_kind) ? { attackKind: attackKind(value.attackKind ?? value.attack_kind) } : {}),
    ...(visual ? { equipment: visual.equipment } : attackEquipment(value.attackEquipment ?? value.equipment) ? { equipment: attackEquipment(value.attackEquipment ?? value.equipment) } : {}),
    ...(visual?.version === 2 ? { loadout: visual.loadout } : {}),
    ...(ends ?? fallbackEnds),
    ...(value.critical === true ? { critical: true } : {}),
    ...(value.blocked === true || value.mirrorImageIntercepted === true || value.mirror_image_intercepted === true || shieldBlocked ? { blocked: true } : {}),
  }
}

function motionFor(options: CombatAnimationOptions) {
  return (options.reducedMotion ?? systemPrefersReducedMotion()) ? 'reduced' as const : 'full' as const
}

function burstDuration(spellId: string) {
  // У шара есть две читаемые фазы: полёт и расширение до границы области.
  return spellId === 'fireball' ? 1000 : BASE_DURATIONS.burst
}

function spellCueFromCast(event: GameEvent): SpellAnimationCue | null {
  const payload = event.payload ?? {}
  const actorId = String(event.actor_id ?? '')
  const spellId = String(payload.spell_id ?? '')
  if (!actorId || !spellId) return null
  const geometry = spellCastGeometry(payload)
  const profileHints = {
    school: String(payload.school ?? ''),
    kind: String(payload.kind ?? ''),
    damageType: String(payload.damage_type ?? ''),
    radius: geometry.radiusFeet,
    areaSideFeet: geometry.areaSideFeet,
    areaShape: geometry.shape,
    areaOrigin: geometry.originMode,
    concentration: payload.concentration === true,
  }
  const profile = spellVisualProfile(spellId, profileHints)
  const family = spellEffectPalette(spellId, profileHints).family
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
      from: geometry.from,
      to: geometry.to,
      projectileCount: profile.projectileCount ?? Math.max(1, targetIds.length),
      damageType: String(payload.damage_type ?? '') || undefined,
      durationMs: BASE_DURATIONS.projectile,
    }
  }
  if (profile.kind === 'burst') {
    return {
      ...common,
      kind: 'burst',
      origin: geometry.from,
      center: geometry.center,
      cells: geometry.cells.length ? geometry.cells : undefined,
      shape: profile.areaShape ?? geometry.shape ?? 'sphere',
      originMode: profile.areaOrigin ?? geometry.originMode,
      sizeFeet: profile.sizeFeet ?? Math.max(5, geometry.radiusFeet ?? 5),
      areaSideFeet: profile.areaSideFeet ?? geometry.areaSideFeet,
      damageType: String(payload.damage_type ?? '') || undefined,
      durationMs: burstDuration(spellId),
    }
  }
  if (profile.kind === 'beam') {
    return {
      ...common,
      kind: 'beam',
      from: geometry.from,
      points: geometry.points,
      chain: profile.chain === true,
      damageType: String(payload.damage_type ?? '') || undefined,
      durationMs: BASE_DURATIONS.beam,
    }
  }
  if (profile.kind === 'aura') {
    return {
      ...common,
      kind: 'aura',
      center: geometry.center,
      radiusFeet: profile.radiusFeet ?? Math.max(5, geometry.radiusFeet ?? 10),
      auraType: 'spell',
      active: true,
      durationMs: BASE_DURATIONS.aura,
    }
  }
  return {
    ...common,
    kind: 'channel',
    targetId: targetIds[0],
    from: family === 'teleport' ? geometry.from : undefined,
    position: geometry.center,
    channelType: family === 'teleport' ? 'teleport' : 'cast',
    ...(family === 'teleport' ? { presentationPhase: 'arrival' as const } : {}),
    durationMs: BASE_DURATIONS.channel,
  }
}

/** Удар из SpellCast рисуется физически только если canonical профиль требует оружие. */
function spellAttackRequiresWeapon(payload: Record<string, unknown>): boolean {
  const spellId = String(payload.spell_id ?? payload.spellId ?? '')
  if (!spellId) return false
  const profile = spellVisualProfile(spellId, {
    kind: String(payload.kind ?? 'attack'),
    damageType: String(payload.damage_type ?? payload.damageType ?? '') || undefined,
  })
  return payload.requires_weapon_attack === true || profile.requiresWeaponAttack === true
}

/** Thunder Step состоит из портала и подтверждённого громового удара в старой клетке. */
function thunderStepDepartureCue(cue: SpellAnimationCue): SpellAnimationCue | null {
  if (cue.kind !== 'channel' || cue.channelType !== 'teleport' || cue.spellId !== 'thunder-step' || !cue.from) return null
  return {
    id: `${cue.id}:departure-thunder`,
    kind: 'burst',
    actorId: cue.actorId,
    targetIds: [],
    spellId: cue.spellId,
    school: cue.school,
    origin: cue.from,
    center: cue.from,
    shape: 'sphere',
    originMode: 'point',
    sizeFeet: 10,
    presentationPhase: 'departure',
    visualFamily: 'thunder',
    durationMs: 420,
  }
}

function conditionLabel(condition: string) {
  // Свой смазанный клинок проекция не обезличивает — герой знает своё
  // снаряжение, — поэтому в клиент приезжает точная форма
  // `weapon-coated:<item_instance_id>`. Без этой ветки общий гуманизатор писал
  // над клеткой героя «Weapon Coated:hero Item 3»: качественная подпись выше
  // совпадает только с непрозрачной формой противника.
  if (condition.startsWith('weapon-coated:')) return 'Клинок смазан ядом'
  return CONDITION_LABELS[condition]
    ?? condition.split('-').filter(Boolean).map((part) => part.charAt(0).toLocaleUpperCase('ru') + part.slice(1)).join(' ')
}

function moveDuration(pathLength: number) {
  return Math.min(BASE_DURATIONS.moveMax, Math.max(BASE_DURATIONS.moveMin, pathLength * 70))
}

type BattleLogVisualFields = {
  teleport?: boolean
  commandId?: string
  command_id?: string
  area_shape?: string
  area_origin?: 'self' | 'point'
}

function battleLogVisual(event: BattleEvent) {
  return event as BattleEvent & BattleLogVisualFields
}

function battleLogCommandId(event: BattleEvent) {
  const value = battleLogVisual(event)
  return String(value.commandId ?? value.command_id ?? '')
}

function samePoint(left: BoardPoint | undefined, right: BoardPoint | undefined) {
  return Boolean(left && right && left.x === right.x && left.y === right.y)
}

function battleLogAreaShape(event: BattleEvent) {
  const value = battleLogVisual(event)
  const area = event.area as (BattleEvent['area'] & { shape?: unknown; area_shape?: unknown; originMode?: unknown; area_origin?: unknown }) | undefined
  return areaShape(value.area_shape ?? area?.area_shape ?? area?.shape)
}

function battleLogAreaOrigin(event: BattleEvent) {
  const value = battleLogVisual(event)
  const area = event.area as (BattleEvent['area'] & { originMode?: unknown; area_origin?: unknown }) | undefined
  const origin = value.area_origin ?? area?.area_origin ?? area?.originMode
  return origin === 'self' || origin === 'point' ? origin : undefined
}

function teleportMoveForBattleLog(
  events: readonly BattleEvent[],
  spellIndex: number,
  spell: BattleEvent,
) {
  const spellVisual = battleLogVisual(spell)
  const commandId = battleLogCommandId(spell)
  const spellTarget = spell.to ?? (spell.area ? { x: spell.area.x, y: spell.area.y } : undefined)
  const candidates = events.filter((candidate, index) => {
    const value = battleLogVisual(candidate)
    if (candidate.type !== 'move' || value.teleport !== true || candidate.actorId !== spell.actorId) return false
    const candidateCommandId = battleLogCommandId(candidate)
    if (commandId && candidateCommandId) return commandId === candidateCommandId
    if (spell.sceneTurn != null && candidate.sceneTurn != null && spell.sceneTurn !== candidate.sceneTurn) return false
    if (spellTarget && candidate.to && !samePoint(candidate.to, spellTarget)) return false
    return Math.abs(index - spellIndex) <= 1 || Boolean(spellTarget)
  })
  return candidates[0]
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
  const teleportMovesByCommand = new Map<string, GameEvent>()
  const spellTargetOutcomesByCommand = new Map<string, Record<string, AttackOutcome>>()
  for (const event of events) {
    if (event.event_type === 'DamageApplied') {
      const key = commandKey(event)
      damageByCommand.set(key, [...(damageByCommand.get(key) ?? []), event])
      if (event.command_id && event.payload?.spell_id === 'magic-missile' && event.payload?.blocked_by_shield === true) {
        const commandId = String(event.command_id)
        const outcomes = spellTargetOutcomesByCommand.get(commandId) ?? {}
        const targetIds = uniqueIds(event.target_ids)
        const fallbackTarget = String(event.payload.target_id ?? '')
        for (const id of (targetIds.length ? targetIds : fallbackTarget ? [fallbackTarget] : [])) outcomes[id] = 'blocked'
        if (Object.keys(outcomes).length) spellTargetOutcomesByCommand.set(commandId, outcomes)
      }
    }
    if (event.event_type === 'SpellCast' && event.command_id) spellCastByCommand.set(String(event.command_id), event)
    if (event.event_type === 'SpellAreaCreated' && event.command_id) areaCommands.add(String(event.command_id))
    if (event.event_type === 'ActorMoved' && event.command_id && event.payload?.teleport === true) {
      teleportMovesByCommand.set(String(event.command_id), event)
    }
    if (event.event_type === 'AttackResolved' && event.command_id && event.payload?.spell_id) {
      const commandId = String(event.command_id)
      const outcomes = spellTargetOutcomesByCommand.get(commandId) ?? {}
      const targetIds = uniqueIds(event.target_ids)
      const fallbackTarget = String(event.payload.target_id ?? '')
      for (const id of (targetIds.length ? targetIds : fallbackTarget ? [fallbackTarget] : [])) outcomes[id] = attackOutcomeFromPayload(event.payload)
      if (Object.keys(outcomes).length) spellTargetOutcomesByCommand.set(commandId, outcomes)
    }
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
      if (payload.teleport === true) {
        if (event.command_id && spellCastByCommand.has(String(event.command_id))) continue
        const from = point(payload.from)
        const to = point(payload.to)
        if (!actorId || !to) continue
        const spellId = String(payload.spell_id ?? 'teleport')
        const profile = spellVisualProfile(spellId, { kind: 'teleport' })
        cues.push({
          id: eventId(event, 'teleport'),
          kind: 'channel',
          actorId,
          targetId: actorId,
          from: from ?? undefined,
          position: to,
          spellId,
          school: profile.school,
          channelType: 'teleport',
          presentationPhase: 'arrival',
          durationMs: BASE_DURATIONS.channel,
        })
        continue
      }
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
      const teleportMove = event.command_id ? teleportMovesByCommand.get(String(event.command_id)) : undefined
      const teleportPayload = teleportMove?.payload ?? {}
      const resolvedCue = cue?.kind === 'channel' && cue.channelType === 'teleport'
        ? {
            ...cue,
            from: point(teleportPayload.from) ?? cue.from,
            position: point(teleportPayload.to) ?? cue.position,
          }
        : cue
      // Длящаяся область следом несёт точные клетки и центр. Не рисуем её
      // приблизительно по целям, когда в этом же пакете есть точный источник.
      if (resolvedCue && !(resolvedCue.kind === 'burst' && event.command_id && areaCommands.has(String(event.command_id)))) {
        const targetOutcomes = event.command_id ? spellTargetOutcomesByCommand.get(String(event.command_id)) : undefined
        const cueWithOutcomes = targetOutcomes ? { ...resolvedCue, targetOutcomes } : resolvedCue
        const departure = thunderStepDepartureCue(cueWithOutcomes)
        cues.push(cueWithOutcomes)
        if (departure) cues.push(departure)
      }
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
        areaSideFeet: Number(effect.area_side_feet) || undefined,
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
          areaSideFeet: profile.areaSideFeet ?? (Number(effect.area_side_feet) || undefined),
          damageType: String(effect.damage_type ?? '') || undefined,
          durationMs: burstDuration(spellId),
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
      const spellAttack = String(payload.spell_id ?? '')
      if (spellAttack && !spellAttackRequiresWeapon(payload)) {
        if (payload.hit !== true) cues.push({
          id: eventId(event, 'spell-miss'),
          kind: 'impact',
          targetId,
          amount: null,
          tone: 'miss',
          damageType: String(payload.damage_type ?? '') || undefined,
          durationMs: BASE_DURATIONS.impact,
        })
        continue
      }
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
        ...attackCueFieldsFromEvent(payload),
        durationMs: BASE_DURATIONS.strike,
      })
      if (related.some((damageEvent) => Number(damageEvent.payload?.hp_after) === 0)) {
        cues.push({ id: eventId(event, 'death'), kind: 'death', targetId, durationMs: BASE_DURATIONS.death })
      }
      continue
    }

    if (event.event_type === 'DamageApplied' && event.payload?.spell_id === 'magic-missile' && event.payload?.blocked_by_shield === true) continue
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
  const teleportMoveIds = new Set<string>()
  const teleportMoveBySpell = new Map<BattleEvent, BattleEvent>()
  const spellTargetOutcomesByKey = new Map<string, Record<string, AttackOutcome>>()
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.spellId === 'magic-missile' && event.targetId && event.blocked === true) {
      const key = battleLogCommandId(event) || `${String(event.actorId)}:${String(event.spellId)}`
      const outcomes = spellTargetOutcomesByKey.get(key) ?? {}
      outcomes[String(event.targetId)] = 'blocked'
      spellTargetOutcomesByKey.set(key, outcomes)
    }
    if (event.type === 'attack' && event.spellId && event.targetId && event.roll) {
      const key = battleLogCommandId(event) || `${String(event.actorId)}:${String(event.spellId)}`
      const outcomes = spellTargetOutcomesByKey.get(key) ?? {}
      outcomes[String(event.targetId)] = attackOutcomeFromPayload({
        hit: event.roll.hit,
        critical: event.critical === true,
        blocked: (event as BattleEvent & { blocked?: boolean }).blocked === true,
      })
      spellTargetOutcomesByKey.set(key, outcomes)
    }
    if (event.type !== 'spell' || !event.actorId || !event.spellId) continue
    const profile = spellVisualProfile(event.spellId, { damageType: event.damageType })
    const family = spellEffectPalette(event.spellId, { damageType: event.damageType }).family
    if (family !== 'teleport') continue
    const move = teleportMoveForBattleLog(events, index, event)
    if (move) {
      teleportMoveBySpell.set(event, move)
      teleportMoveIds.add(String(move.id))
    }
  }

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
      if (battleLogVisual(event).teleport === true && teleportMoveIds.has(String(event.id))) continue
      if (battleLogVisual(event).teleport === true) {
        const profile = spellVisualProfile('teleport', { kind: 'teleport' })
        cues.push({
          id: `${event.id}:teleport`,
          kind: 'channel',
          actorId: event.actorId,
          targetId: event.actorId,
          from: event.from,
          position: event.to,
          channelType: 'teleport',
          spellId: 'teleport',
          school: profile.school,
          presentationPhase: 'arrival',
          durationMs: BASE_DURATIONS.channel,
        })
        continue
      }
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
      const family = spellEffectPalette(event.spellId, { damageType: event.damageType }).family
      const targetIds = event.targetId ? [event.targetId] : []
      const targetOutcomes = spellTargetOutcomesByKey.get(battleLogCommandId(event) || `${String(event.actorId)}:${String(event.spellId)}`)
      const spellOutcomeFields = targetOutcomes ? { targetOutcomes } : {}
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
          ...spellOutcomeFields,
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
          shape: battleLogAreaShape(event) ?? profile.areaShape ?? 'sphere',
          originMode: battleLogAreaOrigin(event) ?? profile.areaOrigin,
          sizeFeet: event.area?.radiusFeet ?? profile.sizeFeet ?? 5,
          damageType: event.damageType,
          spellId: event.spellId,
          school: profile.school,
          ...spellOutcomeFields,
          durationMs: burstDuration(event.spellId),
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
          ...spellOutcomeFields,
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
          ...spellOutcomeFields,
          durationMs: BASE_DURATIONS.aura,
        })
      } else {
        const teleport = family === 'teleport'
        const teleportMove = teleportMoveBySpell.get(event)
        const channel: SpellAnimationCue = {
          id: `${event.id}:channel`,
          kind: 'channel',
          actorId: event.actorId,
          targetId: event.targetId,
          from: teleportMove?.from ?? (teleport ? event.from : undefined),
          position: teleportMove?.to ?? event.to,
          channelType: teleport ? 'teleport' : 'cast',
          ...(teleport ? { presentationPhase: 'arrival' as const } : {}),
          spellId: event.spellId,
          school: profile.school,
          ...spellOutcomeFields,
          durationMs: BASE_DURATIONS.channel,
        }
        const departure = thunderStepDepartureCue(channel)
        cues.push(channel)
        if (departure) cues.push(departure)
      }
      continue
    }
    if (event.type === 'attack' && event.actorId && event.targetId && event.roll) {
      if (event.spellId && !spellAttackRequiresWeapon({ spell_id: event.spellId, kind: 'attack', damage_type: event.damageType })) {
        if (!event.roll.hit) cues.push({
          id: `${event.id}:spell-miss`,
          kind: 'impact',
          targetId: event.targetId,
          amount: null,
          tone: 'miss',
          damageType: event.damageType,
          durationMs: BASE_DURATIONS.impact,
        })
        continue
      }
      cues.push({
        id: String(event.id),
        kind: 'strike',
        actorId: event.actorId,
        targetId: event.targetId,
        hit: event.roll.hit,
        amount: event.roll.hit ? safeAmount(event.damage) : 0,
        damageType: event.damageType,
        ...attackCueFieldsFromBattleLog(event),
        durationMs: BASE_DURATIONS.strike,
      })
      if (event.hpAfter === 0) cues.push({ id: `${event.id}:death`, kind: 'death', targetId: event.targetId, durationMs: BASE_DURATIONS.death })
      continue
    }
    if (event.type === 'spell-damage' && event.spellId === 'magic-missile' && event.blocked === true) continue
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
