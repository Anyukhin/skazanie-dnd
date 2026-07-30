export const ATMOSPHERE_SETTINGS_KEY = 'skazanie:atmosphere-audio:v1'

export const ATMOSPHERE_MOODS = [
  'building', 'temple', 'crypt', 'cave', 'forest', 'road', 'settlement', 'combat', 'finale',
] as const

export const ATMOSPHERE_EFFECTS = [
  'dice', 'hit', 'miss', 'heal', 'coins', 'door', 'level', 'victory', 'defeat', 'narration',
] as const

export type AtmosphereMood = typeof ATMOSPHERE_MOODS[number]
export type AtmosphereEffect = typeof ATMOSPHERE_EFFECTS[number]

export type AtmosphereSettings = {
  ambientVolume: number
  effectsVolume: number
  muted: boolean
}

export const DEFAULT_ATMOSPHERE_SETTINGS: Readonly<AtmosphereSettings> = Object.freeze({
  ambientVolume: 0.28,
  effectsVolume: 0.62,
  muted: false,
})

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
type AudioContextFactory = () => AudioContext | null

export type AtmosphereEvent = {
  event_type?: unknown
  payload?: Record<string, unknown> | null
}

export type AtmosphereAudio = {
  unlock(): Promise<boolean>
  isUnlocked(): boolean
  setMood(mood: AtmosphereMood, fadeSeconds?: number): void
  playEffect(effect: AtmosphereEffect): void
  playEvents(events: readonly (string | AtmosphereEvent)[]): void
  setAmbientVolume(volume: number): AtmosphereSettings
  setEffectsVolume(volume: number): AtmosphereSettings
  setMuted(muted: boolean): AtmosphereSettings
  getSettings(): AtmosphereSettings
  dispose(): Promise<void>
}

type AmbientLayer = {
  gain: GainNode
  sources: AudioScheduledSourceNode[]
}

type MoodProfile = {
  base: number
  harmony: number
  wave: OscillatorType
  pulse: number
  noise: number
  cutoff: number
}

const MOOD_PROFILES: Record<AtmosphereMood, MoodProfile> = Object.freeze({
  building: { base: 82, harmony: 123, wave: 'triangle', pulse: 0.10, noise: 0.12, cutoff: 620 },
  temple: { base: 110, harmony: 165, wave: 'sine', pulse: 0.07, noise: 0.05, cutoff: 980 },
  crypt: { base: 46, harmony: 69, wave: 'sine', pulse: 0.05, noise: 0.15, cutoff: 340 },
  cave: { base: 55, harmony: 83, wave: 'sine', pulse: 0.06, noise: 0.22, cutoff: 430 },
  forest: { base: 98, harmony: 147, wave: 'sine', pulse: 0.12, noise: 0.24, cutoff: 1_250 },
  road: { base: 73, harmony: 110, wave: 'triangle', pulse: 0.09, noise: 0.27, cutoff: 900 },
  settlement: { base: 92, harmony: 138, wave: 'triangle', pulse: 0.15, noise: 0.18, cutoff: 1_100 },
  combat: { base: 65, harmony: 98, wave: 'sawtooth', pulse: 2.25, noise: 0.16, cutoff: 720 },
  finale: { base: 74, harmony: 148, wave: 'triangle', pulse: 0.32, noise: 0.10, cutoff: 1_400 },
})

const EVENT_EFFECTS: Readonly<Record<string, AtmosphereEffect>> = Object.freeze({
  PublicDieRolled: 'dice',
  DieRolled: 'dice',
  AttackResolved: 'hit',
  DamageApplied: 'hit',
  HealingApplied: 'heal',
  TemporaryHitPointsGranted: 'heal',
  MerchantItemBought: 'coins',
  MerchantItemSold: 'coins',
  MerchantPurchaseCompleted: 'coins',
  MerchantSaleCompleted: 'coins',
  MerchantServicePurchased: 'coins',
  CurrencyChanged: 'coins',
  DoorStateChanged: 'door',
  DoorForced: 'door',
  CharacterLeveledUp: 'level',
  LevelUpCompleted: 'level',
  EncounterWon: 'victory',
  CampaignCompleted: 'victory',
  CampaignFailed: 'defeat',
  HeroDied: 'defeat',
  NarrationCreated: 'narration',
  NarratorMessageCreated: 'narration',
  NarrativeSummaryRecorded: 'narration',
})

const HIDDEN_TRAP_EVENTS = new Set([
  'TrapPlaced', 'TrapHidden', 'HiddenTrapRecorded', 'SceneObjectTrapConfigured',
])

export function clampAtmosphereVolume(value: unknown, fallback = 0): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return Math.max(0, Math.min(1, fallback))
  return Math.max(0, Math.min(1, numeric))
}

export function normalizeAtmosphereSettings(value: unknown): AtmosphereSettings {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<AtmosphereSettings>
    : {}
  return {
    ambientVolume: clampAtmosphereVolume(source.ambientVolume, DEFAULT_ATMOSPHERE_SETTINGS.ambientVolume),
    effectsVolume: clampAtmosphereVolume(source.effectsVolume, DEFAULT_ATMOSPHERE_SETTINGS.effectsVolume),
    muted: source.muted === true,
  }
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof globalThis.localStorage === 'object' ? globalThis.localStorage : null
  } catch {
    return null
  }
}

export function loadAtmosphereSettings(storage: StorageLike | null = defaultStorage()): AtmosphereSettings {
  if (!storage) return { ...DEFAULT_ATMOSPHERE_SETTINGS }
  try {
    const raw = storage.getItem(ATMOSPHERE_SETTINGS_KEY)
    return raw ? normalizeAtmosphereSettings(JSON.parse(raw)) : { ...DEFAULT_ATMOSPHERE_SETTINGS }
  } catch {
    return { ...DEFAULT_ATMOSPHERE_SETTINGS }
  }
}

export function saveAtmosphereSettings(
  settings: AtmosphereSettings,
  storage: StorageLike | null = defaultStorage(),
): AtmosphereSettings {
  const normalized = normalizeAtmosphereSettings(settings)
  try {
    storage?.setItem(ATMOSPHERE_SETTINGS_KEY, JSON.stringify(normalized))
  } catch {
    // Private mode and exhausted storage must not break the game.
  }
  return normalized
}

export function normalizeAtmosphereMood(
  value: unknown,
  flags: { combat?: boolean, finale?: boolean } = {},
): AtmosphereMood {
  if (flags.finale) return 'finale'
  if (flags.combat) return 'combat'
  const normalized = String(value ?? '').trim().toLowerCase()
  if ((ATMOSPHERE_MOODS as readonly string[]).includes(normalized)) return normalized as AtmosphereMood
  if (/temple|altar|shrine|храм|свят|алтар/ui.test(normalized)) return 'temple'
  if (/crypt|grave|tomb|склеп|могил|кладбищ/ui.test(normalized)) return 'crypt'
  if (/cave|cavern|подзем|пещер|шахт/ui.test(normalized)) return 'cave'
  if (/forest|wood|лес|роща|чащ/ui.test(normalized)) return 'forest'
  if (/road|trail|дорог|тракт|путь/ui.test(normalized)) return 'road'
  if (/settlement|village|town|city|тавер|деревн|город|поселен/ui.test(normalized)) return 'settlement'
  return 'building'
}

export function atmosphereEffectForEvent(event: string | AtmosphereEvent): AtmosphereEffect | null {
  const type = typeof event === 'string' ? event : String(event?.event_type ?? '')
  if (!type || HIDDEN_TRAP_EVENTS.has(type)) return null
  if (type === 'AttackResolved' && typeof event !== 'string') {
    return event.payload?.hit === false ? 'miss' : 'hit'
  }
  if (type === 'EncounterEnded' || type === 'CombatEnded') {
    if (typeof event !== 'string') {
      const outcome = String(event.payload?.outcome ?? event.payload?.reason ?? '').toLowerCase()
      if (/defeat|failed|party_defeated|поражен/ui.test(outcome)) return 'defeat'
    }
    return 'victory'
  }
  return EVENT_EFFECTS[type] ?? null
}

export function atmosphereEffectsForEvents(
  events: readonly (string | AtmosphereEvent)[],
): AtmosphereEffect[] {
  const result: AtmosphereEffect[] = []
  for (const event of events) {
    const effect = atmosphereEffectForEvent(event)
    if (effect && result.at(-1) !== effect) result.push(effect)
    if (result.length >= 12) break
  }
  return result
}

function browserAudioContextFactory(): AudioContext | null {
  const scope = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext
  }
  const Constructor = globalThis.AudioContext ?? scope.webkitAudioContext
  return Constructor ? new Constructor() : null
}

export function createAtmosphereAudio(options: {
  settings?: AtmosphereSettings
  storage?: StorageLike | null
  audioContextFactory?: AudioContextFactory
} = {}): AtmosphereAudio {
  const storage = options.storage === undefined ? defaultStorage() : options.storage
  const factory = options.audioContextFactory ?? browserAudioContextFactory
  let settings = normalizeAtmosphereSettings(options.settings ?? loadAtmosphereSettings(storage))
  let context: AudioContext | null = null
  let ambientBus: GainNode | null = null
  let effectsBus: GainNode | null = null
  let currentLayer: AmbientLayer | null = null
  let desiredMood: AtmosphereMood = 'building'
  let disposed = false
  const activeSources = new Set<AudioScheduledSourceNode>()

  const remember = () => {
    settings = saveAtmosphereSettings(settings, storage)
    return { ...settings }
  }

  const track = <T extends AudioScheduledSourceNode>(source: T): T => {
    activeSources.add(source)
    source.addEventListener('ended', () => activeSources.delete(source), { once: true })
    return source
  }

  const updateBuses = (at = context?.currentTime ?? 0) => {
    if (!ambientBus || !effectsBus) return
    const ambient = settings.muted ? 0 : settings.ambientVolume
    const effects = settings.muted ? 0 : settings.effectsVolume
    ambientBus.gain.cancelScheduledValues(at)
    effectsBus.gain.cancelScheduledValues(at)
    ambientBus.gain.setTargetAtTime(ambient, at, 0.025)
    effectsBus.gain.setTargetAtTime(effects, at, 0.025)
  }

  const noiseBuffer = (seconds: number): AudioBuffer | null => {
    if (!context) return null
    const length = Math.max(1, Math.floor(context.sampleRate * seconds))
    const buffer = context.createBuffer(1, length, context.sampleRate)
    const channel = buffer.getChannelData(0)
    for (let index = 0; index < channel.length; index += 1) channel[index] = Math.random() * 2 - 1
    return buffer
  }

  const startAmbientLayer = (mood: AtmosphereMood, fadeSeconds: number) => {
    if (!context || !ambientBus || disposed) return
    const profile = MOOD_PROFILES[mood]
    const now = context.currentTime
    const duration = Math.max(0.05, Math.min(8, fadeSeconds))
    const layerGain = context.createGain()
    layerGain.gain.setValueAtTime(0, now)
    layerGain.gain.linearRampToValueAtTime(1, now + duration)
    layerGain.connect(ambientBus)
    const sources: AudioScheduledSourceNode[] = []

    for (const [frequency, level] of [[profile.base, 0.055], [profile.harmony, 0.035]] as const) {
      const oscillator = track(context.createOscillator())
      const gain = context.createGain()
      oscillator.type = profile.wave
      oscillator.frequency.setValueAtTime(frequency, now)
      gain.gain.setValueAtTime(level, now)
      oscillator.connect(gain).connect(layerGain)
      oscillator.start(now)
      sources.push(oscillator)
    }

    const lfo = track(context.createOscillator())
    const lfoGain = context.createGain()
    lfo.type = 'sine'
    lfo.frequency.setValueAtTime(profile.pulse, now)
    lfoGain.gain.setValueAtTime(mood === 'combat' ? 0.035 : 0.012, now)
    lfo.connect(lfoGain).connect(layerGain.gain)
    lfo.start(now)
    sources.push(lfo)

    const buffer = noiseBuffer(2)
    if (buffer) {
      const noise = track(context.createBufferSource())
      const filter = context.createBiquadFilter()
      const gain = context.createGain()
      noise.buffer = buffer
      noise.loop = true
      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(profile.cutoff, now)
      gain.gain.setValueAtTime(profile.noise, now)
      noise.connect(filter).connect(gain).connect(layerGain)
      noise.start(now)
      sources.push(noise)
    }

    const previous = currentLayer
    currentLayer = { gain: layerGain, sources }
    if (previous) {
      previous.gain.gain.cancelScheduledValues(now)
      previous.gain.gain.setValueAtTime(previous.gain.gain.value, now)
      previous.gain.gain.linearRampToValueAtTime(0, now + duration)
      for (const source of previous.sources) {
        try { source.stop(now + duration + 0.05) } catch {}
      }
    }
  }

  const effectTone = (
    frequency: number,
    duration: number,
    delay = 0,
    type: OscillatorType = 'sine',
    endFrequency = frequency,
    level = 0.16,
  ) => {
    if (!context || !effectsBus || disposed) return
    const start = context.currentTime + Math.max(0, delay)
    const end = start + Math.max(0.02, duration)
    const oscillator = track(context.createOscillator())
    const gain = context.createGain()
    oscillator.type = type
    oscillator.frequency.setValueAtTime(Math.max(20, frequency), start)
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), end)
    gain.gain.setValueAtTime(0.0001, start)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, level), start + Math.min(0.02, duration / 3))
    gain.gain.exponentialRampToValueAtTime(0.0001, end)
    oscillator.connect(gain).connect(effectsBus)
    oscillator.start(start)
    oscillator.stop(end + 0.01)
  }

  const effectNoise = (duration: number, cutoff: number, level = 0.16, delay = 0) => {
    if (!context || !effectsBus || disposed) return
    const buffer = noiseBuffer(Math.max(0.03, duration))
    if (!buffer) return
    const start = context.currentTime + Math.max(0, delay)
    const end = start + duration
    const noise = track(context.createBufferSource())
    const filter = context.createBiquadFilter()
    const gain = context.createGain()
    noise.buffer = buffer
    filter.type = 'bandpass'
    filter.frequency.setValueAtTime(cutoff, start)
    filter.Q.setValueAtTime(0.8, start)
    gain.gain.setValueAtTime(Math.max(0.001, level), start)
    gain.gain.exponentialRampToValueAtTime(0.0001, end)
    noise.connect(filter).connect(gain).connect(effectsBus)
    noise.start(start)
    noise.stop(end + 0.01)
  }

  const playEffect = (effect: AtmosphereEffect) => {
    if (!context || !effectsBus || disposed || settings.muted || settings.effectsVolume <= 0) return
    switch (effect) {
      case 'dice':
        for (let index = 0; index < 4; index += 1) effectNoise(0.045, 1_800 + index * 420, 0.11, index * 0.055)
        break
      case 'hit':
        effectNoise(0.13, 520, 0.22)
        effectTone(96, 0.15, 0, 'triangle', 58, 0.18)
        break
      case 'miss':
        effectTone(760, 0.16, 0, 'sine', 310, 0.10)
        break
      case 'heal':
        effectTone(392, 0.22, 0, 'sine', 523, 0.10)
        effectTone(659, 0.28, 0.09, 'sine', 784, 0.08)
        break
      case 'coins':
        for (const [frequency, delay] of [[1_760, 0], [2_340, 0.055], [1_980, 0.11]] as const) {
          effectTone(frequency, 0.12, delay, 'sine', frequency * 0.94, 0.09)
        }
        break
      case 'door':
        effectNoise(0.32, 210, 0.17)
        effectTone(72, 0.34, 0, 'sawtooth', 48, 0.08)
        break
      case 'level':
        for (const [frequency, delay] of [[392, 0], [494, 0.10], [587, 0.20], [784, 0.30]] as const) {
          effectTone(frequency, 0.24, delay, 'triangle', frequency, 0.10)
        }
        break
      case 'victory':
        for (const [frequency, delay] of [[262, 0], [330, 0.10], [392, 0.20], [523, 0.34]] as const) {
          effectTone(frequency, 0.55, delay, 'triangle', frequency * 1.01, 0.11)
        }
        break
      case 'defeat':
        for (const [frequency, delay] of [[294, 0], [247, 0.14], [196, 0.28], [147, 0.42]] as const) {
          effectTone(frequency, 0.52, delay, 'sine', frequency * 0.92, 0.10)
        }
        break
      case 'narration':
        effectTone(523, 0.18, 0, 'sine', 587, 0.045)
        break
    }
  }

  return {
    async unlock() {
      if (disposed) return false
      if (!context) {
        try {
          context = factory()
        } catch {
          return false
        }
        if (!context) return false
        ambientBus = context.createGain()
        effectsBus = context.createGain()
        ambientBus.connect(context.destination)
        effectsBus.connect(context.destination)
        updateBuses(context.currentTime)
      }
      try {
        if (context.state !== 'running' && context.state !== 'closed') await context.resume()
      } catch {
        return false
      }
      if (!currentLayer) startAmbientLayer(desiredMood, 0.25)
      return context.state === 'running'
    },
    isUnlocked() {
      return context?.state === 'running'
    },
    setMood(mood, fadeSeconds = 1.4) {
      if (disposed || !(ATMOSPHERE_MOODS as readonly string[]).includes(mood)) return
      if (desiredMood === mood && currentLayer) return
      desiredMood = mood
      if (context) startAmbientLayer(mood, fadeSeconds)
    },
    playEffect,
    playEvents(events) {
      for (const effect of atmosphereEffectsForEvents(events)) playEffect(effect)
    },
    setAmbientVolume(volume) {
      settings = { ...settings, ambientVolume: clampAtmosphereVolume(volume, settings.ambientVolume) }
      updateBuses()
      return remember()
    },
    setEffectsVolume(volume) {
      settings = { ...settings, effectsVolume: clampAtmosphereVolume(volume, settings.effectsVolume) }
      updateBuses()
      return remember()
    },
    setMuted(muted) {
      settings = { ...settings, muted: muted === true }
      updateBuses()
      return remember()
    },
    getSettings() {
      return { ...settings }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      const now = context?.currentTime ?? 0
      for (const source of activeSources) {
        try { source.stop(now) } catch {}
      }
      activeSources.clear()
      currentLayer = null
      ambientBus?.disconnect()
      effectsBus?.disconnect()
      ambientBus = null
      effectsBus = null
      if (context && context.state !== 'closed') {
        try { await context.close() } catch {}
      }
      context = null
    },
  }
}
