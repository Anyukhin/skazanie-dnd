import { attackOutcome, attackVisualStyleForActor, strikeImpactProgress, strikeLaunchProgress, strikeUsesProjectile, type AttackActorVisual, type AttackOutcome, type AttackVisualStyle, type CombatAnimationCue, type SpellAnimationCue } from './combat-animation'
import { spellEffectPalette, type SpellSoundFamily } from './spell-effects'

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

export type CombatAudioCueOptions = {
  /** Прослушивание в выборе действия не блокирует подтверждённое событие. */
  preview?: boolean
  /** Публичный снимок actor нужен для профиля natural/beast атаки. */
  actor?: AttackActorVisual | null
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

function spellSoundFamily(cue: SpellAnimationCue): SpellSoundFamily {
  const damageType = 'damageType' in cue ? cue.damageType : undefined
  const hints = {
    school: cue.school,
    damageType,
    ...(cue.visualFamily ? { visualFamily: cue.visualFamily } : {}),
  } as Parameters<typeof spellEffectPalette>[1]
  const palette = spellEffectPalette(cue.spellId, {
    ...hints,
  })
  return palette.soundFamily ?? 'utility'
}

function profileCandidates(cue: CombatAnimationCue, actor?: AttackActorVisual | null): string[] {
  if (isSpellCue(cue)) {
    const family = spellSoundFamily(cue)
    return [`spell:${family}`]
  }
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

function profilePhaseAliases(cue: CombatAnimationCue, phase: CombatAudioPhase): string[] {
  if (cue.kind === 'strike' && phase === 'contact') {
    const outcome = attackOutcome(cue)
    return outcome === 'hit' ? ['impact'] : [outcome, 'impact']
  }
  if (isSpellCue(cue) && phase === 'contact' && explicitSpellMiss(cue) === true) return ['miss']
  if (phase === 'start') return ['cast']
  if (phase === 'contact') return ['impact']
  if (phase === 'complete') return ['complete']
  return ['launch']
}

function profileClipIds(
  manifest: CombatAudioManifest,
  keys: readonly string[],
  phases: readonly string[],
): { key: string; clipIds: string[] } {
  for (const key of keys) {
    const profile = manifest.profiles[key]
    if (!profile) continue
    for (const phase of phases) {
      const value = profile[phase]
      const clipIds = Array.isArray(value) ? [...value] : value ? [value] : []
      if (clipIds.length) return { key, clipIds }
    }
  }
  return { key: keys[0] ?? 'combat:unknown', clipIds: [] }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function profileUrls(manifest: CombatAudioManifest, clipIds: readonly string[]): string[] {
  return clipIds.flatMap((clipId) => {
    const clip = manifest.clips[clipId]
    if (!clip || typeof clip.url !== 'string') return []
    const url = clip.url.trim()
    if (!url) return []
    return [url.startsWith('/') || /^https?:\/\//u.test(url) ? url : `/assets/${url.replace(/^assets\//u, '')}`]
  })
}

export function combatAudioProfile(
  cue: CombatAnimationCue,
  phase: CombatAudioPhase = 'start',
  manifest: CombatAudioManifest = DEFAULT_COMBAT_AUDIO_MANIFEST,
  options: Pick<CombatAudioCueOptions, 'actor'> = {},
): CombatAudioProfile {
  const candidates = unique(profileCandidates(cue, options.actor))
  const resolved = profileClipIds(manifest, candidates, profilePhaseAliases(cue, phase))
  const urls = profileUrls(manifest, resolved.clipIds)
  return {
    key: resolved.key,
    url: urls[0] ?? '',
    candidates: urls,
    clipIds: resolved.clipIds,
  }
}

export type CombatAudioPlanEntry = {
  cueId: string
  phase: CombatAudioPhase
  atMs: number
  windowMs: number
  profileKey: string
  clipIds: string[]
  urls: string[]
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
    return {
      cueId: cue.id,
      phase,
      atMs: scheduleDelay(cue, progress),
      windowMs: phaseWindowMs(cue, index, plan),
      profileKey: profile.key,
      clipIds: profile.clipIds,
      urls: profile.candidates,
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
  compressor.threshold.value = -12
  compressor.knee.value = 18
  compressor.ratio.value = 4
  compressor.attack.value = .003
  compressor.release.value = .2
}

function scheduleVoiceEnvelope(gain: GainNode, source: AudioBufferSourceNode, now: number, durationMs: number): void {
  const playableMs = Math.max(1, durationMs)
  const fadeMs = Math.min(FADE_MAX_MS, Math.max(FADE_MIN_MS, playableMs * .18))
  const fadeAt = now + Math.max(0, playableMs - fadeMs) / 1000
  const stopAt = now + playableMs / 1000
  gain.gain.cancelScheduledValues(now)
  gain.gain.setValueAtTime(1, now)
  gain.gain.setValueAtTime(1, fadeAt)
  gain.gain.linearRampToValueAtTime(0, stopAt)
  source.start(now)
  source.stop(stopAt)
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
  const active = new Map<AudioBufferSourceNode, string>()
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
    const profile = combatAudioProfile(cue, phase, runtimeManifest, cueOptions)
    const buffer = await loadProfile(profile)
    if (!allowed() || !isAudible(cue) || !context || !effectsBus || !buffer) return false
    const remainingWindowMs = timing
      ? timing.dueAt + timing.windowMs - monotonicNowMs()
      : MAX_AUDIO_TAIL_MS
    if (remainingWindowMs <= 0) return false
    const bufferDurationMs = Number(buffer.duration) * 1000
    const playableMs = Math.min(remainingWindowMs, Number.isFinite(bufferDurationMs) && bufferDurationMs > 0 ? bufferDurationMs : remainingWindowMs)
    if (playableMs <= 0) return false
    const source = context.createBufferSource()
    const gain = context.createGain()
    while (active.size >= COMBAT_AUDIO_VOICE_LIMIT) {
      const oldest = active.keys().next().value
      if (!oldest) break
      try { oldest.stop(context.currentTime) } catch {}
      active.delete(oldest)
    }
    source.buffer = buffer
    // effectsVolume применяется один раз на effectsBus. Gain этого голоса —
    // только фазовая огибающая, поэтому записи не умножают настройку громкости.
    gainSet(gain, 1, context.currentTime)
    source.connect(gain).connect(effectsBus)
    active.set(source, cue.id)
    source.addEventListener('ended', () => {
      active.delete(source)
      try { source.disconnect() } catch {}
      try { gain.disconnect() } catch {}
    }, { once: true })
    try {
      scheduleVoiceEnvelope(gain, source, context.currentTime, playableMs)
      remember(playedKeys, dedupeKey)
      return true
    } catch {
      active.delete(source)
      try { source.disconnect() } catch {}
      try { gain.disconnect() } catch {}
      return false
    }
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
    if (dedupe && !options.preview && (seenCueIds.has(cue.id) || playedKeys.has(key) || pendingKeys.has(key))) return false
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
    for (const [scheduleId, entry] of scheduled) {
      if (id && scheduleId !== id && entry.cueId !== id) continue
      cueIds.add(entry.cueId)
      entry.cancelled = true
      entry.timers.forEach((timer) => clearScheduleTimer(timer))
      scheduled.delete(scheduleId)
    }
    for (const [source, cueId] of active) {
      if (id && cueId !== id && !cueIds.has(cueId)) continue
      try { source.stop(context?.currentTime ?? 0) } catch {}
      active.delete(source)
    }
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
      if (!cueOptions.preview) remember(seenCueIds, cue.id)
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
      return play(cue, phase, cueOptions)
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
          if (profile.candidates.length) profiles.set(profile.key, profile)
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
    },
  }
}
