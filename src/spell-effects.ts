import catalogPayload from '../data/dndsu-spells-0-6.json'
import mechanicsOverrides from '../data/dndsu-spell-mechanics-overrides.json'
import { areaCells, type AreaPoint, type AreaShape } from './area-geometry'
import type { BoardContext2D, BoardEffectRenderer, BoardScene } from './board-render'
import type { BoardPoint, CombatAnimationCue, SpellAnimationCue } from './combat-animation'
import { revealedAt } from './tactical-map-client'

export type MagicSchool =
  | 'abjuration'
  | 'conjuration'
  | 'divination'
  | 'enchantment'
  | 'evocation'
  | 'illusion'
  | 'necromancy'
  | 'transmutation'

export type SpellEffectDetail = 'full' | 'reduced' | 'minimal'
export type SpellVisualKind = SpellAnimationCue['kind']

export type SpellSchoolStyle = {
  label: string
  primary: string
  secondary: string
  fill: string
  behavior: 'flash' | 'dome' | 'focus' | 'wave' | 'shimmer' | 'materialize' | 'inward' | 'morph'
}

/**
 * Книжная палитра остаётся приглушённой: школы различаются насыщенным цветом
 * и характером движения, а не неоновым свечением или россыпью частиц.
 */
export const SPELL_SCHOOL_STYLES: Readonly<Record<MagicSchool, SpellSchoolStyle>> = {
  evocation: {
    label: 'Воплощение',
    primary: '#d96d4f',
    secondary: '#efb86f',
    fill: 'rgba(186,72,48,.24)',
    behavior: 'flash',
  },
  abjuration: {
    label: 'Ограждение',
    primary: '#6f91b8',
    secondary: '#b8cbe0',
    fill: 'rgba(77,111,150,.2)',
    behavior: 'dome',
  },
  necromancy: {
    label: 'Некромантия',
    primary: '#756083',
    secondary: '#b295b9',
    fill: 'rgba(67,47,77,.27)',
    behavior: 'inward',
  },
  enchantment: {
    label: 'Очарование',
    primary: '#a66d8d',
    secondary: '#d5a9bd',
    fill: 'rgba(134,70,106,.2)',
    behavior: 'wave',
  },
  conjuration: {
    label: 'Вызов',
    primary: '#4f9a82',
    secondary: '#a6c9ad',
    fill: 'rgba(55,119,94,.22)',
    behavior: 'materialize',
  },
  transmutation: {
    label: 'Преобразование',
    primary: '#a7854d',
    secondary: '#d7bd77',
    fill: 'rgba(139,105,52,.22)',
    behavior: 'morph',
  },
  illusion: {
    label: 'Иллюзия',
    primary: '#786fae',
    secondary: '#c0b8dc',
    fill: 'rgba(91,79,145,.2)',
    behavior: 'shimmer',
  },
  divination: {
    label: 'Прорицание',
    primary: '#4f8794',
    secondary: '#acd0ce',
    fill: 'rgba(55,105,116,.2)',
    behavior: 'focus',
  },
}

type CatalogSpell = {
  id: string
  school?: string
  kind?: string
  target?: string
  radius?: number
  areaShape?: AreaShape
  areaOrigin?: 'self' | 'point'
  damageType?: string
  damageTypes?: string[]
  maxTargets?: number
  projectileCount?: number
  beams?: number
}

type SpellProfileHints = Partial<CatalogSpell> & {
  concentration?: boolean
}

export type SpellVisualProfile = {
  spellId: string
  school: MagicSchool
  kind: SpellVisualKind
  areaShape?: AreaShape
  areaOrigin?: 'self' | 'point'
  sizeFeet?: number
  radiusFeet?: number
  projectileCount?: number
  chain?: boolean
}

const catalogSpells = (catalogPayload as unknown as { spells?: CatalogSpell[] }).spells ?? []
const overrideSpells = (mechanicsOverrides as unknown as { spells?: Record<string, Partial<CatalogSpell>> }).spells ?? {}
const SPELL_CATALOG = new Map(catalogSpells.map((spell) => [
  spell.id,
  { ...spell, ...(overrideSpells[spell.id] ?? {}) },
]))

const SCHOOL_ALIASES: Record<string, MagicSchool> = {
  abjuration: 'abjuration',
  ограждение: 'abjuration',
  conjuration: 'conjuration',
  вызов: 'conjuration',
  divination: 'divination',
  прорицание: 'divination',
  enchantment: 'enchantment',
  очарование: 'enchantment',
  evocation: 'evocation',
  воплощение: 'evocation',
  illusion: 'illusion',
  иллюзия: 'illusion',
  necromancy: 'necromancy',
  некромантия: 'necromancy',
  transmutation: 'transmutation',
  преобразование: 'transmutation',
}

const PROJECTILE_SPELLS = new Set([
  'acid-arrow',
  'acid-splash',
  'chromatic-orb',
  'fire-bolt',
  'guiding-bolt',
  'hail-of-thorns',
  'ice-knife',
  'magic-missile',
  'melf-s-acid-arrow',
  'ray-of-frost',
])

const BEAM_SPELLS = new Set([
  'chain-lightning',
  'eldritch-blast',
  'lightning-lure',
  'ray-of-enfeeblement',
  'scorching-ray',
  'sunbeam',
  'witch-bolt',
])

const AURA_SPELLS: Record<string, number> = {
  'aura-of-life': 30,
  'aura-of-purity': 30,
  'aura-of-vitality': 30,
  'crusader-s-mantle': 30,
  'paladin-aura-of-protection': 10,
  'spirit-guardians': 15,
}

const normalizeId = (value: unknown) => String(value ?? '').trim().toLocaleLowerCase('en-US')

export function normalizeMagicSchool(value: unknown): MagicSchool {
  const normalized = String(value ?? '').trim().toLocaleLowerCase('ru').replace(/ё/gu, 'е')
  return SCHOOL_ALIASES[normalized] ?? 'evocation'
}

function schoolFromDamageType(value: unknown): MagicSchool {
  const damageType = String(value ?? '').toLocaleLowerCase('ru')
  if (/necrot|некрот/u.test(damageType)) return 'necromancy'
  if (/psychic|псих/u.test(damageType)) return 'enchantment'
  if (/acid|poison|кисл|яд/u.test(damageType)) return 'conjuration'
  return 'evocation'
}

/**
 * Единый детерминированный профиль визуала. Каталог даёт школу всем известным
 * заклинаниям, а серверные override — исполняемую геометрию и количество целей.
 * Подсказки из события имеют приоритет, чтобы будущая версия протокола могла
 * передать профиль напрямую без замены этого API.
 */
export function spellVisualProfile(spellIdValue: unknown, hints: SpellProfileHints = {}): SpellVisualProfile {
  const spellId = normalizeId(spellIdValue)
  const catalog = SPELL_CATALOG.get(spellId)
  const presentHints = Object.fromEntries(
    Object.entries(hints).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  ) as SpellProfileHints
  const spell = { ...(catalog ?? {}), ...presentHints }
  const school = spell.school
    ? normalizeMagicSchool(spell.school)
    : schoolFromDamageType(spell.damageType ?? spell.damageTypes?.[0])
  const radiusFeet = Math.max(0, Number(AURA_SPELLS[spellId] ?? spell.radius) || 0)
  const projectileCount = Math.max(1, Number(spell.projectileCount ?? spell.beams) || 1)

  let kind: SpellVisualKind = 'channel'
  if (AURA_SPELLS[spellId] != null) kind = 'aura'
  else if (BEAM_SPELLS.has(spellId) || /beam|ray|bolt-chain|lightning-lure/u.test(spellId)) kind = 'beam'
  else if (spell.areaShape || /^area-/u.test(String(spell.kind ?? ''))) kind = 'burst'
  else if (PROJECTILE_SPELLS.has(spellId) || spell.kind === 'attack' || spell.kind === 'damage') kind = 'projectile'
  else if (spell.kind === 'summon' || spell.kind === 'healing') kind = 'channel'

  return {
    spellId,
    school,
    kind,
    ...(spell.areaShape ? { areaShape: spell.areaShape } : {}),
    ...(spell.areaOrigin ? { areaOrigin: spell.areaOrigin } : {}),
    ...(spell.areaShape && radiusFeet > 0 ? { sizeFeet: radiusFeet } : {}),
    ...(kind === 'aura' ? { radiusFeet: radiusFeet || 10 } : {}),
    ...(kind === 'projectile' ? { projectileCount } : {}),
    ...(kind === 'beam' ? { chain: spellId === 'chain-lightning' || Number(spell.maxTargets) > 1 } : {}),
  }
}

export const SPELL_EFFECT_FRAME_BUDGET_MS = 1_000 / 60

export function systemPrefersReducedMotion() {
  return typeof globalThis.matchMedia === 'function'
    && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function spellEffectDetailForFrame(
  frameDurationMs: number,
  reducedMotion = systemPrefersReducedMotion(),
): SpellEffectDetail {
  if (reducedMotion) return 'minimal'
  const duration = Math.max(0, Number(frameDurationMs) || 0)
  if (duration > SPELL_EFFECT_FRAME_BUDGET_MS * 1.7) return 'minimal'
  if (duration > SPELL_EFFECT_FRAME_BUDGET_MS * 1.08) return 'reduced'
  return 'full'
}

/**
 * Деградирует немедленно, восстанавливает детализацию только после серии
 * быстрых кадров. Гистерезис не даёт эффекту дёргаться между режимами.
 */
export function createSpellEffectBudgetController(options: {
  frameBudgetMs?: number
  recoveryFrames?: number
  reducedMotion?: boolean
} = {}) {
  const frameBudgetMs = Math.max(1, Number(options.frameBudgetMs) || SPELL_EFFECT_FRAME_BUDGET_MS)
  const recoveryFrames = Math.max(1, Math.floor(Number(options.recoveryFrames) || 10))
  const reducedMotion = options.reducedMotion ?? systemPrefersReducedMotion()
  let detail: SpellEffectDetail = reducedMotion ? 'minimal' : 'full'
  let healthyFrames = 0

  return {
    get detail() {
      return detail
    },
    recordFrame(frameDurationMs: number) {
      const next = spellEffectDetailForFrame(
        Math.max(0, Number(frameDurationMs) || 0) * SPELL_EFFECT_FRAME_BUDGET_MS / frameBudgetMs,
        reducedMotion,
      )
      if (next === 'minimal' || next === 'reduced' && detail === 'full') {
        detail = next
        healthyFrames = 0
        return detail
      }
      if (next !== 'full' || detail === 'full') {
        healthyFrames = next === 'full' ? healthyFrames + 1 : 0
        return detail
      }
      healthyFrames += 1
      if (healthyFrames >= recoveryFrames) {
        detail = detail === 'minimal' ? 'reduced' : 'full'
        healthyFrames = 0
      }
      return detail
    },
  }
}

export type SpellEffectActor = BoardPoint & {
  id: string
}

export type SpellEffectRenderInput = {
  cue: SpellAnimationCue
  /** Нормализованное время текущей реплики, от 0 до 1. */
  progress: number
  actors: readonly SpellEffectActor[]
  detail?: SpellEffectDetail
  frameDurationMs?: number
  reducedMotion?: boolean
}

export type PersistentSpellEffect =
  | {
      id: string
      kind: 'aura'
      actorId: string
      spellId: string
      school?: MagicSchool
      radiusFeet: number
    }
  | {
      id: string
      kind: 'concentration'
      actorId: string
      spellId?: string
      school?: MagicSchool
    }

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number(value) || 0))
const pointKey = (value: BoardPoint) => `${value.x},${value.y}`

function actorPoint(actors: readonly SpellEffectActor[], actorId: string | undefined) {
  return actorId ? actors.find((actor) => actor.id === actorId) ?? null : null
}

function pointCenter(point: BoardPoint, cellSize: number) {
  return { x: (point.x + .5) * cellSize, y: (point.y + .5) * cellSize }
}

function visiblePoint(scene: BoardScene, point: BoardPoint | null | undefined): point is BoardPoint {
  return Boolean(point && revealedAt(scene.map, Math.floor(point.x), Math.floor(point.y)))
}

function envelope(style: SpellSchoolStyle, progress: number) {
  const t = clamp01(progress)
  if (style.behavior === 'flash') return { alpha: Math.max(0, 1 - t * t), phase: Math.min(1, t * 1.55) }
  if (style.behavior === 'inward') return { alpha: Math.sin(Math.PI * t), phase: 1 - t }
  if (style.behavior === 'wave') return { alpha: Math.sin(Math.PI * t), phase: .5 - Math.cos(Math.PI * t) / 2 }
  if (style.behavior === 'materialize') return { alpha: Math.min(1, t * 3) * Math.max(0, 1 - Math.max(0, t - .82) / .18), phase: t }
  if (style.behavior === 'morph') return { alpha: Math.sin(Math.PI * t), phase: .5 + Math.sin(t * Math.PI * 2) * .12 }
  if (style.behavior === 'shimmer') return { alpha: Math.sin(Math.PI * t) * (.72 + Math.sin(t * Math.PI * 6) * .18), phase: t }
  if (style.behavior === 'focus') return { alpha: Math.sin(Math.PI * t), phase: 1 - Math.abs(t * 2 - 1) * .45 }
  return { alpha: Math.sin(Math.PI * t), phase: t }
}

function detailRank(detail: SpellEffectDetail) {
  return detail === 'full' ? 2 : detail === 'reduced' ? 1 : 0
}

function cueDetail(input: SpellEffectRenderInput): SpellEffectDetail {
  const reducedMotion = input.reducedMotion ?? (input.cue.motion === 'reduced' || systemPrefersReducedMotion())
  if (reducedMotion) return 'minimal'
  const frameDetail = spellEffectDetailForFrame(input.frameDurationMs ?? 0, false)
  const declared = input.detail ?? input.cue.detail ?? 'full'
  return detailRank(frameDetail) < detailRank(declared) ? frameDetail : declared
}

function spellStyle(cue: SpellAnimationCue) {
  return SPELL_SCHOOL_STYLES[cue.school]
}

function drawRing(
  context: BoardContext2D,
  center: { x: number; y: number },
  radius: number,
  color: string,
  alpha: number,
  width: number,
  dash: number[] = [],
) {
  context.save()
  context.globalAlpha = clamp01(alpha)
  context.strokeStyle = color
  context.lineWidth = width
  context.setLineDash(dash)
  context.beginPath()
  context.arc(center.x, center.y, Math.max(1, radius), 0, Math.PI * 2)
  context.stroke()
  context.restore()
}

function projectileEndpoints(cue: Extract<SpellAnimationCue, { kind: 'projectile' }>, actors: readonly SpellEffectActor[]) {
  const from = cue.from ?? actorPoint(actors, cue.actorId)
  const targetId = cue.targetIds[0]
  const to = cue.to ?? actorPoint(actors, targetId)
  return { from, to }
}

function drawProjectile(
  context: BoardContext2D,
  scene: BoardScene,
  cue: Extract<SpellAnimationCue, { kind: 'projectile' }>,
  input: SpellEffectRenderInput,
  detail: SpellEffectDetail,
) {
  const { from, to } = projectileEndpoints(cue, input.actors)
  if (!visiblePoint(scene, from) || !visiblePoint(scene, to)) return
  const style = spellStyle(cue)
  const progress = input.reducedMotion || cue.motion === 'reduced' ? 1 : clamp01(input.progress)
  const start = pointCenter(from, scene.cellSize)
  const end = pointCenter(to, scene.cellSize)
  if (detail === 'minimal') {
    drawRing(context, end, scene.cellSize * .28, style.primary, .78, Math.max(2, scene.cellSize * .055))
    return
  }
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.max(1, Math.hypot(dx, dy))
  const count = Math.min(detail === 'full' ? 5 : 2, Math.max(1, cue.projectileCount))
  const steps = detail === 'full' ? 10 : 5
  for (let projectile = 0; projectile < count; projectile += 1) {
    const volleyProgress = clamp01(progress - projectile * .035)
    const spread = (projectile - (count - 1) / 2) * scene.cellSize * .22
    const control = {
      x: (start.x + end.x) / 2 - dy / length * (Math.min(scene.cellSize * 1.2, length * .16) + spread),
      y: (start.y + end.y) / 2 + dx / length * (Math.min(scene.cellSize * 1.2, length * .16) + spread),
    }
    const at = (t: number) => ({
      x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * control.x + t ** 2 * end.x,
      y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * control.y + t ** 2 * end.y,
    })
    const head = at(volleyProgress)
    const tailStart = Math.max(0, volleyProgress - (detail === 'full' ? .28 : .16))
    context.save()
    context.globalAlpha = .86
    context.strokeStyle = style.secondary
    context.lineWidth = Math.max(2, scene.cellSize * (detail === 'full' ? .08 : .055))
    context.beginPath()
    for (let index = 0; index <= steps; index += 1) {
      const pathPoint = at(tailStart + (volleyProgress - tailStart) * index / steps)
      if (index === 0) context.moveTo(pathPoint.x, pathPoint.y)
      else context.lineTo(pathPoint.x, pathPoint.y)
    }
    context.stroke()
    context.fillStyle = style.primary
    context.beginPath()
    context.arc(head.x, head.y, Math.max(3, scene.cellSize * .11), 0, Math.PI * 2)
    context.fill()
    context.restore()
  }
}

function burstCells(
  scene: BoardScene,
  cue: Extract<SpellAnimationCue, { kind: 'burst' }>,
  actors: readonly SpellEffectActor[],
) {
  if (cue.cells?.length) return cue.cells.filter((cell) => visiblePoint(scene, cell))
  const actor = actorPoint(actors, cue.actorId)
  const center = cue.center ?? actorPoint(actors, cue.targetIds[0])
  const origin = cue.origin ?? actor
  if (!center || !origin) return []
  const cells = areaCells({
    shape: cue.shape,
    origin,
    target: center,
    originMode: cue.originMode,
    sizeFeet: cue.sizeFeet,
    bounds: { minX: 0, minY: 0, maxX: scene.map.width - 1, maxY: scene.map.height - 1 },
  })
  return cells.filter((cell) => visiblePoint(scene, cell))
}

function evenlySample<T>(values: readonly T[], maximum: number) {
  if (values.length <= maximum) return [...values]
  const sampled: T[] = []
  for (let index = 0; index < maximum; index += 1) {
    sampled.push(values[Math.floor(index * values.length / maximum)])
  }
  return sampled
}

function drawBurst(
  context: BoardContext2D,
  scene: BoardScene,
  cue: Extract<SpellAnimationCue, { kind: 'burst' }>,
  input: SpellEffectRenderInput,
  detail: SpellEffectDetail,
) {
  const cells = burstCells(scene, cue, input.actors)
  if (!cells.length) return
  const style = spellStyle(cue)
  const progress = input.reducedMotion || cue.motion === 'reduced' ? .68 : clamp01(input.progress)
  const motion = envelope(style, progress)
  const capacity = detail === 'full' ? 96 : detail === 'reduced' ? 48 : 24
  const sampled = evenlySample(cells, capacity)
  const size = scene.cellSize
  const inset = detail === 'minimal' ? size * .12 : size * (.08 + (1 - motion.phase) * .08)
  context.save()
  context.globalAlpha = detail === 'minimal' ? .72 : Math.max(.15, motion.alpha)
  context.fillStyle = style.fill
  context.strokeStyle = style.primary
  context.lineWidth = Math.max(1, size * (detail === 'full' ? .045 : .032))
  context.setLineDash(detail === 'minimal' ? [Math.max(3, size * .12), Math.max(2, size * .08)] : [])
  for (const cell of sampled) {
    const left = cell.x * size + inset
    const top = cell.y * size + inset
    const side = Math.max(2, size - inset * 2)
    if (detail !== 'minimal') context.fillRect(left, top, side, side)
    context.strokeRect(left, top, side, side)
  }
  context.restore()
}

function beamPoints(cue: Extract<SpellAnimationCue, { kind: 'beam' }>, actors: readonly SpellEffectActor[]) {
  const result: BoardPoint[] = []
  const origin = cue.from ?? actorPoint(actors, cue.actorId)
  if (origin) result.push(origin)
  if (cue.points?.length) result.push(...cue.points)
  else {
    for (const targetId of cue.targetIds) {
      const target = actorPoint(actors, targetId)
      if (target && !result.some((point) => pointKey(point) === pointKey(target))) result.push(target)
    }
  }
  return result
}

function drawBeam(
  context: BoardContext2D,
  scene: BoardScene,
  cue: Extract<SpellAnimationCue, { kind: 'beam' }>,
  input: SpellEffectRenderInput,
  detail: SpellEffectDetail,
) {
  const points = beamPoints(cue, input.actors).filter((point) => visiblePoint(scene, point))
  if (points.length < 2) return
  const style = spellStyle(cue)
  const progress = input.reducedMotion || cue.motion === 'reduced' ? 1 : clamp01(input.progress)
  const segmentProgress = progress * (points.length - 1)
  const completeSegments = Math.floor(segmentProgress)
  const local = segmentProgress - completeSegments
  const screen = points.map((point) => pointCenter(point, scene.cellSize))
  const drawPath = (color: string, width: number, alpha: number) => {
    context.save()
    context.globalAlpha = alpha
    context.strokeStyle = color
    context.lineWidth = width
    context.beginPath()
    context.moveTo(screen[0].x, screen[0].y)
    for (let index = 0; index < completeSegments; index += 1) {
      const target = screen[index + 1]
      context.lineTo(target.x, target.y)
    }
    if (completeSegments < screen.length - 1) {
      const from = screen[completeSegments]
      const to = screen[completeSegments + 1]
      context.lineTo(from.x + (to.x - from.x) * local, from.y + (to.y - from.y) * local)
    }
    context.stroke()
    context.restore()
  }
  if (detail === 'full') drawPath(style.secondary, Math.max(5, scene.cellSize * .14), .28)
  drawPath(style.primary, Math.max(2, scene.cellSize * (detail === 'minimal' ? .045 : .07)), .9)
  if (cue.chain && detail !== 'minimal') {
    for (let index = 1; index <= Math.min(completeSegments + 1, screen.length - 1); index += 1) {
      drawRing(context, screen[index], scene.cellSize * .18, style.secondary, .75, Math.max(1, scene.cellSize * .035))
    }
  }
}

function drawAura(
  context: BoardContext2D,
  scene: BoardScene,
  cue: Extract<SpellAnimationCue, { kind: 'aura' }>,
  input: SpellEffectRenderInput,
  detail: SpellEffectDetail,
) {
  const carrier = cue.center ?? actorPoint(input.actors, cue.actorId)
  if (!visiblePoint(scene, carrier)) return
  const center = pointCenter(carrier, scene.cellSize)
  const style = spellStyle(cue)
  const progress = input.reducedMotion || cue.motion === 'reduced' ? .72 : clamp01(input.progress)
  const activeRadius = cue.auraType === 'concentration'
    ? scene.cellSize * .36
    : Math.max(scene.cellSize * .62, cue.radiusFeet / 5 * scene.cellSize)
  const phase = cue.active === false ? 1 - progress : .84 + Math.sin(progress * Math.PI) * .16
  const dash = cue.auraType === 'concentration'
    ? [Math.max(3, scene.cellSize * .1), Math.max(2, scene.cellSize * .07)]
    : detail === 'minimal' ? [Math.max(5, scene.cellSize * .18), Math.max(3, scene.cellSize * .1)] : []
  drawRing(context, center, activeRadius * phase, style.primary, cue.active === false ? 1 - progress : .72, Math.max(2, scene.cellSize * .045), dash)
  if (cue.auraType === 'concentration') {
    context.save()
    context.globalAlpha = cue.active === false ? Math.max(0, 1 - progress) : .9
    context.fillStyle = style.secondary
    context.font = `800 ${Math.max(10, Math.round(scene.cellSize * .2))}px Manrope, sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText('К', center.x, center.y - scene.cellSize * .42)
    context.restore()
  } else if (detail === 'full') {
    drawRing(context, center, activeRadius * (.72 + progress * .12), style.secondary, .3, Math.max(1, scene.cellSize * .025))
  }
}

function drawChannel(
  context: BoardContext2D,
  scene: BoardScene,
  cue: Extract<SpellAnimationCue, { kind: 'channel' }>,
  input: SpellEffectRenderInput,
  detail: SpellEffectDetail,
) {
  const target = cue.position ?? actorPoint(input.actors, cue.targetId) ?? actorPoint(input.actors, cue.actorId)
  if (!visiblePoint(scene, target)) return
  const center = pointCenter(target, scene.cellSize)
  const style = spellStyle(cue)
  const progress = input.reducedMotion || cue.motion === 'reduced' ? .72 : clamp01(input.progress)
  const motion = envelope(style, progress)
  const radius = scene.cellSize * (
    cue.channelType === 'summon' ? .56 + motion.phase * .12
      : cue.channelType === 'healing' ? .28 + motion.phase * .24
        : .3 + motion.phase * .18
  )
  drawRing(
    context,
    center,
    radius,
    cue.channelType === 'healing' ? '#75ad83' : style.primary,
    Math.max(.28, motion.alpha),
    Math.max(2, scene.cellSize * .055),
    cue.channelType === 'summon' && detail !== 'minimal' ? [Math.max(4, scene.cellSize * .13), Math.max(2, scene.cellSize * .07)] : [],
  )
  if (detail === 'minimal') return
  context.save()
  context.globalAlpha = Math.max(.35, motion.alpha)
  context.fillStyle = cue.channelType === 'healing' ? '#a8d2a5' : style.secondary
  context.font = `900 ${Math.max(12, Math.round(scene.cellSize * .25))}px Manrope, sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  const label = cue.channelType === 'healing'
    ? `+${cue.amount ?? 0}`
    : cue.channelType === 'summon' ? 'ПРИЗЫВ' : style.label.toLocaleUpperCase('ru')
  context.fillText(label, center.x, center.y - scene.cellSize * (.28 + progress * .28))
  context.restore()
}

/** Чистая отрисовка одной реплики; состояние canvas изолирует drawBoardEffects. */
export function drawSpellEffect(
  context: BoardContext2D,
  scene: BoardScene,
  input: SpellEffectRenderInput,
) {
  const detail = cueDetail(input)
  const cue = input.cue
  if (cue.kind === 'projectile') drawProjectile(context, scene, cue, input, detail)
  else if (cue.kind === 'burst') drawBurst(context, scene, cue, input, detail)
  else if (cue.kind === 'beam') drawBeam(context, scene, cue, input, detail)
  else if (cue.kind === 'aura') drawAura(context, scene, cue, input, detail)
  else drawChannel(context, scene, cue, input, detail)
}

/** Готовая точка подключения к публичному `drawBoardEffects`. */
export function createSpellEffectRenderer(input: SpellEffectRenderInput): BoardEffectRenderer {
  return (context, scene) => drawSpellEffect(context, scene, input)
}

/**
 * Длящиеся ауры и концентрация не принадлежат очереди: этот renderer строится
 * из текущей проекции и остаётся на доске до исчезновения состояния.
 */
export function createPersistentSpellEffectsRenderer(
  effects: readonly PersistentSpellEffect[],
  actors: readonly SpellEffectActor[],
  options: { detail?: SpellEffectDetail; reducedMotion?: boolean } = {},
): BoardEffectRenderer {
  return (context, scene) => {
    for (const effect of effects) {
      const profile = spellVisualProfile(effect.spellId ?? '', { school: effect.school })
      const cue: Extract<SpellAnimationCue, { kind: 'aura' }> = {
        id: effect.id,
        kind: 'aura',
        actorId: effect.actorId,
        spellId: effect.spellId ?? '',
        school: effect.school ?? profile.school,
        radiusFeet: effect.kind === 'aura' ? effect.radiusFeet : 0,
        auraType: effect.kind === 'aura' ? 'spell' : 'concentration',
        active: true,
        durationMs: 1,
        motion: options.reducedMotion ? 'reduced' : 'full',
        detail: options.detail,
      }
      drawAura(context, scene, cue, {
        cue,
        progress: .5,
        actors,
        detail: options.detail,
        reducedMotion: options.reducedMotion,
      }, options.detail ?? (options.reducedMotion ? 'minimal' : 'reduced'))
    }
  }
}

export function isSpellAnimationCue(cue: CombatAnimationCue): cue is SpellAnimationCue {
  return cue.kind === 'projectile'
    || cue.kind === 'burst'
    || cue.kind === 'beam'
    || cue.kind === 'aura'
    || cue.kind === 'channel'
}
