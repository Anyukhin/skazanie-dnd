import { attackOutcome, attackVisualStyleForActor, strikeImpactProgress, strikeLaunchProgress, strikeUsesProjectile, type AttackActorVisual, type AttackOutcome, type AttackVisualStyle, type CombatAnimationCue, type SpellAnimationCue } from './combat-animation'
import { spellEffectPalette, type MagicSchool, type SpellSoundFamily } from './spell-effects'

export type CombatAudioPhase = 'start' | 'launch' | 'contact' | 'complete'

export type CombatAudioSettings = {
  muted: boolean
  effectsVolume: number
}

export const DEFAULT_COMBAT_AUDIO_SETTINGS: Readonly<CombatAudioSettings> = Object.freeze({
  muted: true,
  effectsVolume: 0.72,
})

export type CombatAudioProfile = {
  key: string
  url: string
  candidates: string[]
  clipIds: string[]
}

export type CombatAudioClip = {
  url: string
  durationMs?: number
  sourceId?: string
}

export type CombatAudioStructuredManifest = {
  version: 1
  clips: Readonly<Record<string, CombatAudioClip>>
  profiles: Readonly<Record<string, Readonly<Record<string, string | readonly string[]>>>>
}

/** Единственный runtime-контракт записанных боевых клипов. */
export type CombatAudioManifest = CombatAudioStructuredManifest

/**
 * Положение источника звука на экране: панорама -1 (слева) … 1 (справа) и
 * множитель громкости 0…1 для далёкого или ушедшего за кадр события. Это
 * обработка записи, а не синтез: сигнал по-прежнему берётся только из файла.
 */
export type CombatAudioSpatial = {
  pan?: number
  gain?: number
}

export type CombatAudioCueOptions = {
  /** Прослушивание в выборе действия не блокирует подтверждённое событие. */
  preview?: boolean
  /** Публичный снимок actor нужен для профиля natural/beast атаки. */
  actor?: AttackActorVisual | null
  /**
   * Экранное положение исполнителя (`source`: cast/launch) и цели (`target`:
   * contact). Без него звук остаётся по центру и без ослабления.
   */
  spatial?: {
    source?: CombatAudioSpatial | null
    target?: CombatAudioSpatial | null
  } | null
}

/** Просьба приглушить атмосферную петлю на время громкого боевого звука. */
export type CombatAudioDuckRequest = {
  /** Доля, на которую убирается фон: 0 — не трогать, .5 — вдвое тише. */
  depth: number
  holdMs: number
}

export type CombatAudioLoader = (url: string, context: AudioContext) => Promise<AudioBuffer>
export type CombatAudioContextFactory = () => AudioContext | null
export type CombatAudioTimer = ReturnType<typeof setTimeout>

export type CombatAudioSchedule = {
  id: string
  cancel(): void
}

export type CombatAudio = {
  unlock(): Promise<boolean>
  isUnlocked(): boolean
  schedule(cue: CombatAnimationCue, options?: CombatAudioCueOptions): CombatAudioSchedule | null
  playCue(cue: CombatAnimationCue, phase?: CombatAudioPhase, options?: CombatAudioCueOptions): Promise<boolean>
  preload(cues: readonly CombatAnimationCue[]): Promise<void>
  cancel(id?: string): void
  setMuted(muted: boolean): CombatAudioSettings
  setVolume(volume: number): CombatAudioSettings
  setEffectsVolume(volume: number): CombatAudioSettings
  setVisible(visible: boolean): void
  getSettings(): CombatAudioSettings
  dispose(): Promise<void>
}

export const COMBAT_AUDIO_MANIFEST_URL = '/assets/audio/combat/manifest.json'
const CACHE_LIMIT = 12
const DEDUPE_LIMIT = 2048
export const COMBAT_AUDIO_VOICE_LIMIT = 8
const PHASE_MIN_WINDOW_MS = 120
const MAX_AUDIO_TAIL_MS = 1_400
const FADE_MIN_MS = 20
const FADE_MAX_MS = 40
/** Обрезанный окном длинный клип (лечение, щит) уходит мягко, а не щелчком. */
const TRUNCATED_FADE_MAX_MS = 260
/** Перехват голоса лимитом полифонии — короткий спад вместо щелчка. */
const STEAL_FADE_S = .015
/** Одна запись звучит не больше чем двумя голосами одновременно. */
export const COMBAT_AUDIO_CLIP_VOICE_LIMIT = 2

/**
 * Уровни фаз относительно попадания, дБ. Все записи пакета приведены к одной
 * громкости (-18 LUFS), поэтому иерархию «замах тише удара, крит громче»
 * задаёт воспроизведение: иначе подготовка заклинания звучит как его взрыв.
 */
export const COMBAT_AUDIO_PHASE_LEVEL_DB: Readonly<Record<string, number>> = Object.freeze({
  cast: -5,
  launch: -3,
  impact: 0,
  critical: 2,
  blocked: -2,
  miss: -4,
  complete: -6,
})
/** Подложка крита (`criticalLayer`) — тело удара под основной записью. */
const CRITICAL_LAYER_LEVEL_DB = -5
/** Случайный разброс повтора: ±5 % скорости и ±1.5 дБ громкости. */
export const COMBAT_AUDIO_RATE_SPREAD = .05
export const COMBAT_AUDIO_GAIN_SPREAD_DB = 1.5
/** Крит звучит чуть ниже — тяжелее, но в пределах естественного разброса. */
const CRITICAL_RATE = .97
/** Панорама не уходит в один канал: в наушниках жёсткий край режет слух. */
export const COMBAT_AUDIO_MAX_PAN = .7
const MIN_SPATIAL_GAIN = .5
/** Насколько убирается атмосфера под громкой фазой. */
const DUCK_DEPTH: Readonly<Record<string, number>> = Object.freeze({ impact: .35, critical: .5, blocked: .3 })

/**
 * Профили намеренно конечны: десятки карт заклинаний делят записанный звук по
 * семейству и фазе, а не получают по отдельному файлу. `soundFamily` — общий
 * контракт с визуальным renderer; earth/wind/water/swarm/weapon не сводятся к
 * utility.
 */
export const COMBAT_AUDIO_FAMILIES: readonly SpellSoundFamily[] = [
  'flame', 'frost', 'electric', 'thunder', 'acid', 'poison', 'necrotic',
  'radiant', 'force', 'psychic', 'healing', 'ward', 'control', 'teleport',
  'summon', 'illusion', 'divination', 'light', 'darkness', 'environment',
  'enchantment', 'restoration', 'invisibility', 'flight', 'mobility',
  'transmutation', 'communication', 'earth', 'wind', 'water', 'swarm',
  'weapon', 'utility', 'silence',
] as const

/** Полный union физического renderer; manifest обязан иметь profile для каждого. */
export const COMBAT_AUDIO_ATTACK_STYLES: readonly AttackVisualStyle[] = [
  'slash', 'pierce', 'bludgeon', 'unarmed', 'natural', 'bow', 'crossbow',
  'sling', 'dart', 'firearm', 'wand', 'net', 'thrown',
] as const

export const DEFAULT_COMBAT_AUDIO_MANIFEST: CombatAudioManifest = Object.freeze({ version: 1, clips: {}, profiles: {} })

function clampVolume(value: unknown, fallback: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.min(1, number))
}

export function normalizeCombatAudioSettings(value: unknown): CombatAudioSettings {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<CombatAudioSettings>
    : {}
  return {
    muted: source.muted !== false,
    effectsVolume: clampVolume(source.effectsVolume, DEFAULT_COMBAT_AUDIO_SETTINGS.effectsVolume),
  }
}

function defaultAudioContextFactory(): AudioContext | null {
  const scope = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }
  const Constructor = globalThis.AudioContext ?? scope.webkitAudioContext
  return Constructor ? new Constructor() : null
}

function defaultLoader(url: string, context: AudioContext): Promise<AudioBuffer> {
  return fetch(url).then((response) => {
    if (!response.ok) throw new Error(`combat audio ${response.status}`)
    return response.arrayBuffer()
  }).then((encoded) => context.decodeAudioData(encoded))
}

function isSpellCue(cue: CombatAnimationCue): cue is SpellAnimationCue {
  return cue.kind === 'projectile' || cue.kind === 'burst' || cue.kind === 'beam'
    || cue.kind === 'aura' || cue.kind === 'channel'
}

function cueIsHidden(cue: CombatAnimationCue): boolean {
  const candidate = cue as CombatAnimationCue & {
    hidden?: boolean
    visible?: boolean
    visibility?: string
  }
  return candidate.hidden === true || candidate.visible === false
    || candidate.visibility === 'hidden' || candidate.visibility === 'gm_only'
}

/**
 * Заклинание без смысловой семьи (неизвестный id, палитра «по школе») раньше
 * всегда звучало `spell:utility`, а профиль `spell:school` никто не читал.
 * Теперь школа выбирает ближайший записанный материал.
 */
export const COMBAT_AUDIO_SCHOOL_FAMILIES: Readonly<Record<MagicSchool, SpellSoundFamily>> = Object.freeze({
  abjuration: 'ward',
  conjuration: 'summon',
  divination: 'divination',
  enchantment: 'enchantment',
  evocation: 'force',
  illusion: 'illusion',
  necromancy: 'necrotic',
  transmutation: 'transmutation',
})

function spellSoundFamilyCandidates(cue: SpellAnimationCue): string[] {
  const damageType = 'damageType' in cue ? cue.damageType : undefined
  const hints = {
    school: cue.school,
    damageType,
    ...(cue.visualFamily ? { visualFamily: cue.visualFamily } : {}),
  } as Parameters<typeof spellEffectPalette>[1]
  const palette = spellEffectPalette(cue.spellId, {
    ...hints,
  })
  // Известная семья — ровно один профиль: пустая фаза (например, `silence`)
  // обязана остаться тишиной, а не провалиться в соседний профиль.
  if (palette.soundFamily) return [`spell:${palette.soundFamily}`]
  const bySchool = COMBAT_AUDIO_SCHOOL_FAMILIES[cue.school]
  return [...(bySchool ? [`spell:${bySchool}`] : []), 'spell:school', 'spell:utility']
}

function profileCandidates(cue: CombatAnimationCue, actor?: AttackActorVisual | null): string[] {
  if (isSpellCue(cue)) return spellSoundFamilyCandidates(cue)
  if (cue.kind === 'strike') return [`attack:${attackVisualStyleForActor(cue, actor)}`]
  if (cue.kind === 'impact') return [`impact:${cue.tone}`, 'impact']
  if (cue.kind === 'death') return ['death']
  if (cue.kind === 'condition') return ['condition']
  if (cue.kind === 'move') return ['move']
  return ['combat:unknown']
}

function explicitSpellMiss(cue: SpellAnimationCue): boolean | null {
  const values = Object.values(cue.targetOutcomes ?? {}) as AttackOutcome[]
  if (!values.length) return null
  if (values.some((value) => value === 'hit' || value === 'critical')) return false
  if (values.every((value) => value === 'miss' || value === 'blocked')) return true
  return null
}

function spellHasCritical(cue: SpellAnimationCue): boolean {
  return Object.values(cue.targetOutcomes ?? {}).some((value) => value === 'critical')
}

function profilePhaseAliases(cue: CombatAnimationCue, phase: CombatAudioPhase): string[] {
  if (cue.kind === 'strike' && phase === 'contact') {
    const outcome = attackOutcome(cue)
    return outcome === 'hit' ? ['impact'] : [outcome, 'impact']
  }
  if (isSpellCue(cue) && phase === 'contact' && explicitSpellMiss(cue) === true) return ['miss']
  if (isSpellCue(cue) && phase === 'contact' && spellHasCritical(cue)) return ['critical', 'impact']
  if (phase === 'start') return ['cast']
  if (phase === 'contact') return ['impact']
  if (phase === 'complete') return ['complete']
  return ['launch']
}

function phaseClipIds(profile: Readonly<Record<string, string | readonly string[]>> | undefined, phase: string): string[] {
  const value = profile?.[phase]
  return Array.isArray(value) ? value.filter((clipId) => typeof clipId === 'string' && clipId) : typeof value === 'string' && value ? [value] : []
}

function profileClipIds(
  manifest: CombatAudioManifest,
  keys: readonly string[],
  phases: readonly string[],
): { key: string; clipIds: string[]; soundPhase: string } {
  for (const key of keys) {
    const profile = manifest.profiles[key]
    if (!profile) continue
    for (const phase of phases) {
      const clipIds = phaseClipIds(profile, phase)
      if (clipIds.length) return { key, clipIds, soundPhase: phase }
    }
  }
  return { key: keys[0] ?? 'combat:unknown', clipIds: [], soundPhase: phases[0] ?? 'impact' }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function clipUrl(manifest: CombatAudioManifest, clipId: string): string {
  const clip = manifest.clips[clipId]
  if (!clip || typeof clip.url !== 'string') return ''
  const url = clip.url.trim()
  if (!url) return ''
  return url.startsWith('/') || /^https?:\/\//u.test(url) ? url : `/assets/${url.replace(/^assets\//u, '')}`
}

function profileUrls(manifest: CombatAudioManifest, clipIds: readonly string[]): string[] {
  return clipIds.map((clipId) => clipUrl(manifest, clipId)).filter(Boolean)
}

export type CombatAudioResolvedProfile = CombatAudioProfile & {
  /**
   * Задуманный исход фазы (`cast`, `impact`, `critical`, `miss`…). По нему
   * выбирается уровень: крит без своей записи звучит записью попадания, но
   * громче.
   */
  intent: string
  /** Фаза manifest, из которой реально взяты клипы. */
  soundPhase: string
  /** Подложка крита из `criticalLayer`; пусто — без слоя. */
  layerClipIds: string[]
  layerUrls: string[]
}

export function combatAudioProfile(
  cue: CombatAnimationCue,
  phase: CombatAudioPhase = 'start',
  manifest: CombatAudioManifest = DEFAULT_COMBAT_AUDIO_MANIFEST,
  options: Pick<CombatAudioCueOptions, 'actor'> = {},
): CombatAudioResolvedProfile {
  const candidates = unique(profileCandidates(cue, options.actor))
  const aliases = profilePhaseAliases(cue, phase)
  const resolved = profileClipIds(manifest, candidates, aliases)
  const urls = profileUrls(manifest, resolved.clipIds)
  const intent = aliases[0] ?? resolved.soundPhase
  const layerClipIds = intent === 'critical' && resolved.clipIds.length
    ? phaseClipIds(manifest.profiles[resolved.key], 'criticalLayer').filter((clipId) => clipUrl(manifest, clipId))
    : []
  return {
    key: resolved.key,
    url: urls[0] ?? '',
    candidates: urls,
    clipIds: resolved.clipIds,
    intent,
    soundPhase: resolved.soundPhase,
    layerClipIds,
    layerUrls: profileUrls(manifest, layerClipIds),
  }
}

/** Линейный множитель громкости из децибел. */
export function combatAudioDbToGain(db: number): number {
  return Number.isFinite(db) ? 10 ** (db / 20) : 1
}

/** Уровень фазы по её задуманному исходу; неизвестный исход — как попадание. */
export function combatAudioPhaseGain(intent: string): number {
  return combatAudioDbToGain(COMBAT_AUDIO_PHASE_LEVEL_DB[intent] ?? 0)
}

/** FNV-1a: дешёвый устойчивый хеш строки для разброса без Math.random. */
function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function unitFromHash(hash: number): number {
  // Перемешивание битов разводит соседние seed, отличающиеся одной цифрой.
  let value = hash ^ (hash >>> 16)
  value = Math.imul(value, 0x45d9f3b) >>> 0
  value ^= value >>> 16
  return (value >>> 0) / 0x1_0000_0000
}

export type CombatAudioVariation = {
  playbackRate: number
  gainDb: number
  gain: number
}

/**
 * Разброс одного проигрывания: серия ударов одним клипом не должна звучать
 * пулемётом. Значение выводится из seed (id реплики, фаза, клип), поэтому
 * повтор той же реплики звучит так же, а соседние удары — по-разному. Сдвиг
 * скорости воспроизведения — обработка записи, а не синтез.
 */
export function combatAudioVariation(seed: string, intent = 'impact'): CombatAudioVariation {
  const hash = hashString(String(seed))
  const rateUnit = unitFromHash(hash)
  const gainUnit = unitFromHash(hashString(`${seed}#gain`))
  const spreadRate = 1 + (rateUnit * 2 - 1) * COMBAT_AUDIO_RATE_SPREAD
  const playbackRate = Math.round(spreadRate * (intent === 'critical' ? CRITICAL_RATE : 1) * 10_000) / 10_000
  const gainDb = Math.round((gainUnit * 2 - 1) * COMBAT_AUDIO_GAIN_SPREAD_DB * 100) / 100
  return { playbackRate, gainDb, gain: combatAudioDbToGain(gainDb) }
}

/**
 * Порядок вариантов фазы: стартовый клип выбирается по seed и не совпадает с
 * только что звучавшим, остальные остаются запасными на случай ошибки загрузки.
 */
export function combatAudioClipOrder<T>(variants: readonly T[], seed: string, previous?: T): T[] {
  if (variants.length <= 1) return [...variants]
  let start = hashString(String(seed)) % variants.length
  if (previous !== undefined && variants[start] === previous) start = (start + 1) % variants.length
  return [...variants.slice(start), ...variants.slice(0, start)]
}

/** Горизонталь экрана → панорама с ограничением, чтобы звук не уходил в одно ухо. */
export function combatAudioStereoPan(screenX: number, viewportWidth: number): number {
  const width = Number(viewportWidth)
  const x = Number(screenX)
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(x)) return 0
  const normalized = Math.max(0, Math.min(1, x / width)) * 2 - 1
  return Math.round(normalized * COMBAT_AUDIO_MAX_PAN * 1000) / 1000
}

/**
 * Экранная точка события → панорама и ослабление: центр кадра звучит полностью,
 * край — на ~2 дБ тише, событие за кадром — вдвое тише, но не молчит.
 */
export function combatAudioSpatialFromScreen(point: {
  x: number
  y: number
  width: number
  height: number
  visible?: boolean
}): Required<CombatAudioSpatial> {
  const width = Number(point.width)
  const height = Number(point.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { pan: 0, gain: 1 }
  const x = Number(point.x)
  const y = Number(point.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { pan: 0, gain: 1 }
  const pan = combatAudioStereoPan(x, width)
  const offscreen = point.visible === false || x < 0 || y < 0 || x > width || y > height
  if (offscreen) return { pan, gain: MIN_SPATIAL_GAIN }
  const nx = x / width * 2 - 1
  const ny = y / height * 2 - 1
  const distance = Math.min(1, Math.hypot(nx, ny) / Math.SQRT2)
  return { pan, gain: Math.round((1 - distance * .2) * 1000) / 1000 }
}

/** cast/launch звучат у исполнителя, contact — у цели (или у исполнителя, если цели нет). */
export function combatAudioPhaseSpatial(
  phase: CombatAudioPhase,
  spatial: CombatAudioCueOptions['spatial'],
): Required<CombatAudioSpatial> {
  const chosen = phase === 'contact' || phase === 'complete'
    ? spatial?.target ?? spatial?.source
    : spatial?.source ?? spatial?.target
  const pan = Number(chosen?.pan)
  const gain = Number(chosen?.gain)
  return {
    pan: Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0,
    gain: Number.isFinite(gain) ? Math.max(MIN_SPATIAL_GAIN, Math.min(1, gain)) : 1,
  }
}

/** Длина спада в конце голоса: обрезанный окном длинный клип уходит мягче. */
export function combatAudioFadeMs(playableMs: number, truncated: boolean): number {
  const playable = Math.max(1, Number(playableMs) || 0)
  if (truncated) return Math.min(TRUNCATED_FADE_MAX_MS, Math.max(FADE_MIN_MS, playable * .3))
  return Math.min(FADE_MAX_MS, Math.max(FADE_MIN_MS, playable * .18))
}

/** Насколько приглушить атмосферу под фазой; 0 — не трогать. */
export function combatAudioDuckDepth(intent: string): number {
  return DUCK_DEPTH[intent] ?? 0
}

export type CombatAudioPlanEntry = {
  cueId: string
  phase: CombatAudioPhase
  atMs: number
  windowMs: number
  profileKey: string
  clipIds: string[]
  urls: string[]
  /** Задуманный исход фазы — по нему выбирается уровень. */
  intent: string
  /** Линейный уровень фазы относительно попадания. */
  level: number
  /**
   * Фаза не звучит, потому что следующая фаза стартует в тот же момент тем же
   * клипом: у снаряда cast и launch при t=0 иначе дают одну запись дважды.
   */
  duplicateOf?: CombatAudioPhase
}

function sameClipIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length > 0 && left.length === right.length && left.every((clipId, index) => clipId === right[index])
}

/**
 * Фаза, которую поглощает следующая: тот же момент и те же клипы. Две копии
 * одной записи с разницей в миллисекунды звучат «фланжером» и громче вдвое.
 */
export function combatAudioDuplicatePhase(
  cue: CombatAnimationCue,
  phase: CombatAudioPhase,
  manifest: CombatAudioManifest,
  options: Pick<CombatAudioCueOptions, 'actor'> = {},
): CombatAudioPhase | undefined {
  const plan = phasePlan(cue)
  const index = plan.findIndex((entry) => entry.phase === phase)
  const current = plan[index]
  const next = plan[index + 1]
  if (!current || !next || next.progress !== current.progress) return undefined
  const currentClips = combatAudioProfile(cue, current.phase, manifest, options).clipIds
  const nextClips = combatAudioProfile(cue, next.phase, manifest, options).clipIds
  return sameClipIds(currentClips, nextClips) ? next.phase : undefined
}

/** План, которым пользуется runtime и которым можно проверить покрытие manifest. */
export function resolveCombatAudioPlan(
  cue: CombatAnimationCue,
  manifest: CombatAudioManifest,
  options: Pick<CombatAudioCueOptions, 'actor'> = {},
): CombatAudioPlanEntry[] {
  const plan = phasePlan(cue)
  return plan.map(({ phase, progress }, index) => {
    const profile = combatAudioProfile(cue, phase, manifest, options)
    const duplicateOf = combatAudioDuplicatePhase(cue, phase, manifest, options)
    return {
      cueId: cue.id,
      phase,
      atMs: scheduleDelay(cue, progress),
      windowMs: phaseWindowMs(cue, index, plan),
      profileKey: profile.key,
      clipIds: profile.clipIds,
      urls: profile.candidates,
      intent: profile.intent,
      level: combatAudioPhaseGain(profile.intent),
      ...(duplicateOf ? { duplicateOf } : {}),
    }
  })
}

function phasePlan(cue: CombatAnimationCue): Array<{ phase: CombatAudioPhase; progress: number }> {
  if (cue.kind === 'strike') {
    const plan: Array<{ phase: CombatAudioPhase; progress: number }> = [{ phase: 'start', progress: 0 }]
    if (strikeUsesProjectile(cue)) {
      plan.push({ phase: 'launch', progress: strikeLaunchProgress(cue) })
    }
    plan.push({ phase: 'contact', progress: strikeImpactProgress(cue) })
    return plan
  }
  if (cue.kind === 'projectile') return [
    { phase: 'start', progress: 0 },
    { phase: 'launch', progress: 0 },
    { phase: 'contact', progress: .72 },
  ]
  if (cue.kind === 'burst') return [
    { phase: 'start', progress: 0 },
    { phase: 'contact', progress: cue.spellId === 'fireball' ? .56 : .72 },
  ]
  if (cue.kind === 'beam') return [{ phase: 'start', progress: 0 }, { phase: 'contact', progress: .72 }]
  if (cue.kind === 'channel' && cue.channelType === 'teleport') {
    return [{ phase: 'start', progress: 0 }, { phase: 'contact', progress: .6 }]
  }
  return [{ phase: 'start', progress: 0 }]
}

function phaseWindowMs(
  cue: CombatAnimationCue,
  index: number,
  plan: readonly { phase: CombatAudioPhase; progress: number }[],
): number {
  const current = plan[index]
  if (!current || current.phase === 'contact' || current.phase === 'complete') return MAX_AUDIO_TAIL_MS
  const durationMs = Math.max(1, Number(cue.durationMs) || 0)
  const next = plan[index + 1]
  if (!next) return MAX_AUDIO_TAIL_MS
  const deltaMs = (next.progress - current.progress) * durationMs
  // У Projectile cast и launch одна точка t=0. Оставляем короткий хвост cast,
  // а окно полёта отдаём launch, чтобы cast не звучал поверх попадания.
  if (deltaMs <= 0) return PHASE_MIN_WINDOW_MS
  return Math.max(1, Math.min(MAX_AUDIO_TAIL_MS, deltaMs))
}

function scheduleDelay(cue: CombatAnimationCue, progress: number): number {
  return Math.max(0, Number(cue.durationMs) || 0) * Math.max(0, Math.min(1, progress))
}

function gainSet(gain: GainNode, value: number, at: number): void {
  try {
    gain.gain.cancelScheduledValues(at)
    gain.gain.setValueAtTime(value, at)
  } catch {
    gain.gain.value = value
  }
}

function monotonicNowMs(): number {
  return typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now()
}

function configureMasterCompressor(compressor: DynamicsCompressorNode): void {
  // Запас по громкости для одновременных записанных голосов; меняется только
  // master bus, исходные файлы и их высота/скорость не меняются.
  // Крит со слоем и попадание поверх хвоста каста складываются выше 0 dBFS:
  // мягкое колено держит обычный удар нетронутым, а сумму — без клиппинга.
  compressor.threshold.value = -12
  compressor.knee.value = 12
  compressor.ratio.value = 6
  compressor.attack.value = .003
  compressor.release.value = .2
}

function scheduleVoiceEnvelope(
  gain: GainNode,
  source: AudioBufferSourceNode,
  now: number,
  durationMs: number,
  peak = 1,
  truncated = false,
): void {
  const playableMs = Math.max(1, durationMs)
  const fadeMs = combatAudioFadeMs(playableMs, truncated)
  const fadeAt = now + Math.max(0, playableMs - fadeMs) / 1000
  const stopAt = now + playableMs / 1000
  gain.gain.cancelScheduledValues(now)
  gain.gain.setValueAtTime(peak, now)
  gain.gain.setValueAtTime(peak, fadeAt)
  gain.gain.linearRampToValueAtTime(0, stopAt)
  source.start(now)
  source.stop(stopAt)
}

function setPlaybackRate(source: AudioBufferSourceNode, rate: number): number {
  const param = (source as AudioBufferSourceNode & { playbackRate?: AudioParam }).playbackRate
  if (!param || !Number.isFinite(rate) || rate <= 0) return 1
  try {
    param.value = rate
    return rate
  } catch {
    return 1
  }
}

export function createCombatAudio(options: {
  settings?: Partial<CombatAudioSettings>
  /** Короткая форма для App: volume — громкость боевых записей. */
  volume?: number
  muted?: boolean
  manifest?: CombatAudioManifest
  audioContextFactory?: CombatAudioContextFactory
  loader?: CombatAudioLoader
  preloadLimit?: number
  manifestUrl?: string
  isVisible?: () => boolean
  isCueAudible?: (cue: CombatAnimationCue) => boolean
  setTimeout?: (handler: () => void, delayMs: number) => CombatAudioTimer
  clearTimeout?: (handle: CombatAudioTimer) => void
  /**
   * Громкая фаза (попадание, крит, блок) действительно зазвучала: владелец
   * атмосферы может на это время приглушить петлю. Не вызывается в mute.
   */
  onDuck?: (request: CombatAudioDuckRequest) => void
} = {}): CombatAudio {
  let settings = normalizeCombatAudioSettings({
    ...options.settings,
    ...(options.volume === undefined ? {} : { effectsVolume: options.volume }),
    ...(options.muted === undefined ? {} : { muted: options.muted }),
  })
  let manifest = options.manifest
  let manifestLoading: Promise<CombatAudioManifest | null> | null = null
  const manifestUrl = options.manifestUrl ?? COMBAT_AUDIO_MANIFEST_URL
  const factory = options.audioContextFactory ?? defaultAudioContextFactory
  const loader = options.loader ?? defaultLoader
  const preloadLimit = Math.max(1, Math.min(32, Math.floor(options.preloadLimit ?? CACHE_LIMIT)))
  const scheduleTimer = options.setTimeout ?? ((handler, delayMs) => globalThis.setTimeout(handler, delayMs))
  const clearScheduleTimer = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle))
  const externalVisibility = options.isVisible ?? (() => globalThis.document?.visibilityState !== 'hidden')
  const cueAudible = options.isCueAudible ?? ((cue) => !cueIsHidden(cue))

  let context: AudioContext | null = null
  let effectsBus: GainNode | null = null
  let masterCompressor: DynamicsCompressorNode | null = null
  let disposed = false
  let visible = true
  let scheduleSequence = 0
  const scheduled = new Map<string, { cueId: string; timers: Set<CombatAudioTimer>; pending: number; cancelled: boolean }>()
  const playedKeys = new Set<string>()
  const pendingKeys = new Set<string>()
  const seenCueIds = new Set<string>()
  const scheduledCueIds = new Set<string>()
  const cancelledCueIds = new Set<string>()
  const directCueIds = new Set<string>()
  type ActiveVoice = { cueId: string; url: string; gain: GainNode; nodes: AudioNode[] }
  const active = new Map<AudioBufferSourceNode, ActiveVoice>()
  /** Последний звучавший вариант фазы профиля — следующий удар возьмёт другой. */
  const lastClipByProfile = new Map<string, string>()
  const buffers = new Map<string, AudioBuffer>()
  const loading = new Map<string, Promise<AudioBuffer | null>>()
  const failed = new Set<string>()
  const bufferOrder: string[] = []

  const loadManifest = async (): Promise<CombatAudioManifest | null> => {
    if (manifest) return manifest
    if (!manifestLoading) {
      manifestLoading = fetch(manifestUrl).then(async (response) => {
        if (!response.ok) throw new Error(`combat audio manifest ${response.status}`)
        const candidate = await response.json() as Partial<CombatAudioManifest>
        if (candidate.version !== 1 || !candidate.clips || !candidate.profiles) throw new Error('invalid combat audio manifest')
        manifest = candidate as CombatAudioManifest
        return manifest
      }).catch(() => null)
    }
    return manifestLoading
  }

  const isAudible = (cue: CombatAnimationCue) => !disposed && visible && externalVisibility() && !settings.muted && cueAudible(cue)

  const setBusVolume = () => {
    if (!effectsBus || !context) return
    gainSet(effectsBus, settings.muted ? 0 : settings.effectsVolume, context.currentTime)
  }

  const remember = (set: Set<string>, value: string) => {
    set.add(value)
    while (set.size > DEDUPE_LIMIT) {
      const oldest = set.values().next().value
      if (typeof oldest !== 'string') break
      set.delete(oldest)
    }
  }

  const forgetOldBuffers = () => {
    while (bufferOrder.length > preloadLimit) {
      const oldest = bufferOrder.shift()
      if (oldest) buffers.delete(oldest)
    }
  }

  const load = (url: string): Promise<AudioBuffer | null> => {
    if (!context || disposed || failed.has(url)) return Promise.resolve(null)
    const cached = buffers.get(url)
    if (cached) return Promise.resolve(cached)
    const pending = loading.get(url)
    if (pending) return pending
    const request = loader(url, context).then((buffer) => {
      if (disposed) return null
      buffers.set(url, buffer)
      const oldIndex = bufferOrder.indexOf(url)
      if (oldIndex >= 0) bufferOrder.splice(oldIndex, 1)
      bufferOrder.push(url)
      forgetOldBuffers()
      return buffer
    }).catch(() => {
      failed.add(url)
      return null
    }).finally(() => {
      loading.delete(url)
    })
    loading.set(url, request)
    return request
  }

  const loadProfile = async (profile: CombatAudioProfile): Promise<AudioBuffer | null> => {
    for (const url of profile.candidates) {
      const buffer = await load(url)
      if (buffer) return buffer
    }
    return null
  }

  type PlaybackTiming = { dueAt: number; windowMs: number }
  type ClipChoice = { clipId: string; url: string }
  type LoadedClip = { choice: ClipChoice; buffer: AudioBuffer }

  const loadFirst = async (choices: readonly ClipChoice[]): Promise<LoadedClip | null> => {
    for (const choice of choices) {
      const buffer = await load(choice.url)
      if (buffer) return { choice, buffer }
    }
    return null
  }

  const disconnectVoice = (source: AudioBufferSourceNode, nodes: readonly AudioNode[]) => {
    try { source.disconnect() } catch {}
    for (const node of nodes) {
      try { node.disconnect() } catch {}
    }
  }

  /** Лимит полифонии снимает старый голос коротким спадом, а не щелчком. */
  const releaseVoice = (source: AudioBufferSourceNode, voice: ActiveVoice) => {
    const at = context?.currentTime ?? 0
    try {
      voice.gain.gain.cancelScheduledValues(at)
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, at)
      voice.gain.gain.linearRampToValueAtTime(0, at + STEAL_FADE_S)
    } catch {}
    try { source.stop(at + STEAL_FADE_S) } catch {}
    active.delete(source)
  }

  const makeRoomFor = (url: string) => {
    const sameClip = [...active].filter(([, voice]) => voice.url === url)
    const excess = sameClip.length - (COMBAT_AUDIO_CLIP_VOICE_LIMIT - 1)
    for (const [source, voice] of sameClip.slice(0, Math.max(0, excess))) releaseVoice(source, voice)
    while (active.size >= COMBAT_AUDIO_VOICE_LIMIT) {
      const oldest = active.entries().next().value
      if (!oldest) break
      releaseVoice(oldest[0], oldest[1])
    }
  }

  const startVoice = (
    cueId: string,
    loaded: LoadedClip,
    seed: string,
    intent: string,
    level: number,
    pan: number,
    windowMs: number,
    now: number,
  ): { playableMs: number } | null => {
    if (!context || !effectsBus) return null
    const variation = combatAudioVariation(seed, intent)
    const source = context.createBufferSource()
    source.buffer = loaded.buffer
    const rate = setPlaybackRate(source, variation.playbackRate)
    // Скорость меняет и длительность записи: окно фазы считает уже её.
    const bufferDurationMs = Number(loaded.buffer.duration) * 1000 / rate
    const naturalMs = Number.isFinite(bufferDurationMs) && bufferDurationMs > 0 ? bufferDurationMs : windowMs
    const playableMs = Math.min(windowMs, naturalMs)
    if (playableMs <= 0) return null
    makeRoomFor(loaded.choice.url)
    const gain = context.createGain()
    const nodes: AudioNode[] = [gain]
    source.connect(gain)
    let output: AudioNode = gain
    if (Math.abs(pan) >= .01 && typeof context.createStereoPanner === 'function') {
      try {
        const panner = context.createStereoPanner()
        panner.pan.value = pan
        gain.connect(panner)
        nodes.push(panner)
        output = panner
      } catch {
        output = gain
      }
    }
    output.connect(effectsBus)
    active.set(source, { cueId, url: loaded.choice.url, gain, nodes })
    source.addEventListener('ended', () => {
      active.delete(source)
      disconnectVoice(source, nodes)
    }, { once: true })
    try {
      // effectsVolume применяется один раз на effectsBus. Gain голоса — уровень
      // фазы, разброс повтора и ослабление расстояния поверх огибающей.
      scheduleVoiceEnvelope(gain, source, now, playableMs, Math.max(0, level * variation.gain), naturalMs > windowMs + 1)
      return { playableMs }
    } catch {
      active.delete(source)
      disconnectVoice(source, nodes)
      return null
    }
  }

  const playLoaded = async (
    cue: CombatAnimationCue,
    phase: CombatAudioPhase,
    dedupeKey: string,
    cueOptions: CombatAudioCueOptions = {},
    allowed: () => boolean = () => true,
    timing?: PlaybackTiming,
  ): Promise<boolean> => {
    if (!allowed() || !isAudible(cue) || !context || !effectsBus) return false
    const runtimeManifest = await loadManifest()
    if (!allowed() || !runtimeManifest) return false
    // Запланированный cast снаряда с тем же клипом, что и launch в ту же
    // миллисекунду, уступает launch: одна запись не звучит дважды.
    if (timing && combatAudioDuplicatePhase(cue, phase, runtimeManifest, cueOptions)) return false
    const profile = combatAudioProfile(cue, phase, runtimeManifest, cueOptions)
    const variantKey = `${profile.key}:${profile.soundPhase}`
    const choices = profile.clipIds
      .map((clipId) => ({ clipId, url: clipUrl(runtimeManifest, clipId) }))
      .filter((choice) => choice.url)
    const previous = choices.find((choice) => choice.clipId === lastClipByProfile.get(variantKey))
    const ordered = combatAudioClipOrder(choices, `${cue.id}:${phase}`, previous)
    const layerChoices = profile.layerClipIds
      .map((clipId) => ({ clipId, url: clipUrl(runtimeManifest, clipId) }))
      .filter((choice) => choice.url)
    const [primary, layer] = await Promise.all([
      loadFirst(ordered),
      layerChoices.length ? loadFirst(layerChoices) : Promise.resolve(null),
    ])
    if (!allowed() || !isAudible(cue) || !context || !effectsBus || !primary) return false
    const remainingWindowMs = timing
      ? timing.dueAt + timing.windowMs - monotonicNowMs()
      : MAX_AUDIO_TAIL_MS
    if (remainingWindowMs <= 0) return false
    const spatial = combatAudioPhaseSpatial(phase, cueOptions.spatial)
    const now = context.currentTime
    const started = startVoice(
      cue.id, primary, `${cue.id}:${phase}:${primary.choice.clipId}`, profile.intent,
      combatAudioPhaseGain(profile.intent) * spatial.gain, spatial.pan, remainingWindowMs, now,
    )
    if (!started) return false
    lastClipByProfile.set(variantKey, primary.choice.clipId)
    if (layer && layer.choice.url !== primary.choice.url) {
      startVoice(
        cue.id, layer, `${cue.id}:${phase}:layer:${layer.choice.clipId}`, profile.intent,
        combatAudioDbToGain(CRITICAL_LAYER_LEVEL_DB) * spatial.gain, spatial.pan, started.playableMs, now,
      )
    }
    remember(playedKeys, dedupeKey)
    const duckDepth = combatAudioDuckDepth(profile.intent)
    if (duckDepth > 0 && options.onDuck) {
      try { options.onDuck({ depth: duckDepth, holdMs: started.playableMs }) } catch {}
    }
    return true
  }

  const play = async (
    cue: CombatAnimationCue,
    phase: CombatAudioPhase,
    options: CombatAudioCueOptions = {},
    dedupe = true,
    allowed: () => boolean = () => true,
    timing?: PlaybackTiming,
  ) => {
    if (!isAudible(cue)) return false
    const key = `${cue.id}:${phase}`
    if (dedupe && !options.preview && (scheduledCueIds.has(cue.id) || cancelledCueIds.has(cue.id) || playedKeys.has(key) || pendingKeys.has(key))) return false
    if (dedupe && !options.preview) {
      // Dedupe ограничен последними 2048 подтверждёнными cue: этого хватает
      // для SSE/battle-log окна и не оставляет память расти всю сессию.
      remember(seenCueIds, cue.id)
      pendingKeys.add(key)
    }
    try {
      return await playLoaded(cue, phase, key, options, allowed, timing)
    } finally {
      pendingKeys.delete(key)
    }
  }

  const cancel = (id?: string) => {
    const cueIds = new Set<string>()
    if (id) cueIds.add(id)
    else for (const cueId of directCueIds) cueIds.add(cueId)
    for (const [scheduleId, entry] of scheduled) {
      if (id && scheduleId !== id && entry.cueId !== id) continue
      cueIds.add(entry.cueId)
      entry.cancelled = true
      entry.timers.forEach((timer) => clearScheduleTimer(timer))
      scheduled.delete(scheduleId)
    }
    for (const [source, { cueId }] of active) {
      if (id && cueId !== id && !cueIds.has(cueId)) continue
      cueIds.add(cueId)
      try { source.stop(context?.currentTime ?? 0) } catch {}
      active.delete(source)
    }
    for (const cueId of cueIds) remember(cancelledCueIds, cueId)
  }

  const setVisibleState = (value: boolean) => {
    visible = value === true
    if (!visible) cancel()
  }

  const visibilityListener = () => {
    const state = (globalThis.document as Document | undefined)?.visibilityState
    setVisibleState(state !== 'hidden')
  }
  const documentObject = globalThis.document
  documentObject?.addEventListener('visibilitychange', visibilityListener)

  return {
    async unlock() {
      if (disposed) return false
      if (!context) {
        try { context = factory() } catch { return false }
        if (!context) return false
        effectsBus = context.createGain()
        if (typeof context.createDynamicsCompressor === 'function') {
          try {
            masterCompressor = context.createDynamicsCompressor()
            configureMasterCompressor(masterCompressor)
            effectsBus.connect(masterCompressor).connect(context.destination)
          } catch {
            masterCompressor = null
            effectsBus.connect(context.destination)
          }
        } else {
          effectsBus.connect(context.destination)
        }
        setBusVolume()
      }
      try {
        if (context.state !== 'running' && context.state !== 'closed') await context.resume()
      } catch {
        return false
      }
      // Manifest грузится после жеста; старт боя не ждёт сеть, а его фазовые
      // timers дождутся того же promise внутри playLoaded.
      void loadManifest()
      return context.state === 'running'
    },
    isUnlocked() {
      return Boolean(context && context.state !== 'closed' && context.state !== 'suspended')
    },
    schedule(cue, cueOptions = {}) {
      if (!isAudible(cue) || !this.isUnlocked()) return null
      // Два источника одной записи (battle event и последующая battle log) —
      // одна реплика. preview имеет отдельный namespace и не блокирует событие.
      if (!cueOptions.preview && seenCueIds.has(cue.id)) return null
      if (!cueOptions.preview) {
        remember(seenCueIds, cue.id)
        remember(scheduledCueIds, cue.id)
      }
      const id = `combat-audio-${++scheduleSequence}`
      const entry = { cueId: cue.id, timers: new Set<CombatAudioTimer>(), pending: 0, cancelled: false }
      const startedAt = monotonicNowMs()
      scheduled.set(id, entry)
      const plan = phasePlan(cue)
      for (const [index, { phase, progress }] of plan.entries()) {
        const delayMs = scheduleDelay(cue, progress)
        const windowMs = phaseWindowMs(cue, index, plan)
        const dueAt = startedAt + delayMs
        const timer = scheduleTimer(() => {
          entry.timers.delete(timer)
          if (entry.cancelled || !scheduled.has(id)) return
          // Таймер фоновой/заторможенной вкладки не должен воскресить старый
          // cast после того, как визуальный контакт уже произошёл.
          if (monotonicNowMs() > dueAt + windowMs) {
            if (!entry.timers.size && !entry.pending) scheduled.delete(id)
            return
          }
          entry.pending += 1
          void play(cue, phase, cueOptions, false, () => !entry.cancelled, { dueAt, windowMs }).finally(() => {
            entry.pending -= 1
            if (!entry.timers.size && !entry.pending) scheduled.delete(id)
          })
        }, delayMs)
        entry.timers.add(timer)
      }
      return {
        id,
        cancel: () => cancel(id),
      }
    },
    playCue(cue, phase, cueOptions = {}) {
      if (phase === undefined) return Promise.resolve(Boolean(this.schedule(cue, cueOptions)))
      if (!this.isUnlocked()) return Promise.resolve(false)
      if (!cueOptions.preview) remember(directCueIds, cue.id)
      return play(cue, phase, cueOptions, true, () => cueOptions.preview || !cancelledCueIds.has(cue.id))
    },
    async preload(cues) {
      if (!this.isUnlocked() || disposed) return
      const runtimeManifest = await loadManifest()
      if (!runtimeManifest) return
      const profiles = new Map<string, CombatAudioProfile>()
      for (const cue of cues) {
        if (!isAudible(cue)) continue
        for (const { phase } of phasePlan(cue)) {
          const profile = combatAudioProfile(cue, phase, runtimeManifest)
          if (profile.candidates.length) profiles.set(`${profile.key}:${profile.soundPhase}`, profile)
        }
      }
      await Promise.all([...profiles.values()].slice(0, preloadLimit).map((profile) => loadProfile(profile).then(() => undefined)))
    },
    cancel,
    setMuted(muted) {
      settings = { ...settings, muted: muted === true }
      setBusVolume()
      if (settings.muted) cancel()
      return { ...settings }
    },
    setEffectsVolume(volume) {
      settings = { ...settings, effectsVolume: clampVolume(volume, settings.effectsVolume) }
      setBusVolume()
      return { ...settings }
    },
    setVolume(volume) {
      settings = { ...settings, effectsVolume: clampVolume(volume, settings.effectsVolume) }
      setBusVolume()
      return { ...settings }
    },
    setVisible(value) {
      setVisibleState(value)
    },
    getSettings() {
      return { ...settings }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      cancel()
      documentObject?.removeEventListener('visibilitychange', visibilityListener)
      effectsBus?.disconnect()
      effectsBus = null
      masterCompressor?.disconnect()
      masterCompressor = null
      if (context && context.state !== 'closed') {
        try { await context.close() } catch {}
      }
      context = null
      buffers.clear()
      loading.clear()
      failed.clear()
      bufferOrder.length = 0
      playedKeys.clear()
      seenCueIds.clear()
      scheduledCueIds.clear()
      cancelledCueIds.clear()
      directCueIds.clear()
    },
  }
}
