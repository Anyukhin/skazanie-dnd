export const ATMOSPHERE_SETTINGS_KEY = 'skazanie:atmosphere-audio:v1'

/**
 * Настроения атмосферы — ровно те места, у которых есть записанная петля в
 * `public/assets/audio/ambience`. Синтезированного фона больше нет: владелец
 * сравнил его с записями и попросил оставить только загруженное. Вместе с ним
 * ушли и отдельные настроения «бой» и «финал» — своей записи у них не было, а
 * гул осцилляторов под них звучал хуже тишины. Бой и финал теперь звучат
 * петлёй места, в котором происходят: место от начала боя не меняется.
 */
export const ATMOSPHERE_MOODS = [
  'building', 'temple', 'crypt', 'cave', 'forest', 'road', 'settlement',
] as const

export type AtmosphereMood = typeof ATMOSPHERE_MOODS[number]

export type AtmosphereSettings = {
  ambientVolume: number
  muted: boolean
}

export const DEFAULT_ATMOSPHERE_SETTINGS: Readonly<AtmosphereSettings> = Object.freeze({
  ambientVolume: 0.28,
  muted: false,
})

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>
type AudioContextFactory = () => AudioContext | null

export type AtmosphereAudio = {
  unlock(): Promise<boolean>
  isUnlocked(): boolean
  setMood(mood: AtmosphereMood, fadeSeconds?: number): void
  setWaiting(waiting: boolean): void
  /** Во сколько раз тише звучит фон на текущем экране: 0 — тишина, 1 — игра. */
  setScreenAttenuation(scale: number): void
  setAmbientVolume(volume: number): AtmosphereSettings
  setMuted(muted: boolean): AtmosphereSettings
  getSettings(): AtmosphereSettings
  dispose(): Promise<void>
}

type AmbientLayer = {
  mood: AtmosphereMood
  gain: GainNode
  sources: AudioScheduledSourceNode[]
}

/**
 * Уровень записи в слое. У записи свой естественный разброс громкости, и на
 * уровне прежнего гула она превращалась в шорох — отсюда запас.
 */
const RECORDED_AMBIENCE_LEVEL = 0.55

export function clampAtmosphereVolume(value: unknown, fallback = 0): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return Math.max(0, Math.min(1, fallback))
  return Math.max(0, Math.min(1, numeric))
}

/**
 * Сохранённые настройки старого образца несли ещё `effectsVolume` — громкость
 * синтезированных эффектов. Поле молча отбрасывается: эффектов больше нет, а
 * ломать сохранённую громкость фона из-за лишнего ключа не за что.
 */
export function normalizeAtmosphereSettings(value: unknown): AtmosphereSettings {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<AtmosphereSettings>
    : {}
  return {
    ambientVolume: clampAtmosphereVolume(source.ambientVolume, DEFAULT_ATMOSPHERE_SETTINGS.ambientVolume),
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

/**
 * Тема сцены → место с записью. Флагов боя и финала здесь больше нет: бой не
 * переносит отряд в другое место, и звучать он обязан тем же лесом или склепом.
 */
export function normalizeAtmosphereMood(value: unknown): AtmosphereMood {
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
  let currentLayer: AmbientLayer | null = null
  let desiredMood: AtmosphereMood = 'building'
  let waiting = false
  // Во сколько раз тише играет фон на текущем экране. Единица — игровая
  // комната; до неё звук приглушён, потому что игрок ещё читает и печатает.
  let screenAttenuation = 1
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

  const updateBus = (at = context?.currentTime ?? 0, glideSeconds = 0.025) => {
    if (!ambientBus) return
    // Приглушение экрана — множитель поверх пользовательской громкости, а не
    // её замена: настройка звука остаётся единственным местом, где игрок
    // задаёт уровень, а экран лишь решает, во сколько раз тише сейчас уместно.
    const ambient = settings.muted ? 0 : settings.ambientVolume * (waiting ? 0.62 : 1) * screenAttenuation
    ambientBus.gain.cancelScheduledValues(at)
    ambientBus.gain.setTargetAtTime(ambient, at, glideSeconds)
  }

  /**
   * Записанные петли грузятся лениво, при первом запросе места. Пока файл
   * летит по сети, продолжает звучать прежнее место — не тишина и не синтез:
   * смена петли происходит уже готовым кроссфейдом, когда буфер раскодирован
   * и настроение к тому моменту не сменилось. Неудача загрузки запоминается,
   * чтобы не долбить сервер на каждой смене сцены; место без записи молчит.
   */
  const ambienceBuffers = new Map<AtmosphereMood, AudioBuffer>()
  const ambienceFailed = new Set<AtmosphereMood>()
  const ambienceLoading = new Set<AtmosphereMood>()

  const loadAmbience = async (mood: AtmosphereMood) => {
    if (!context || disposed) return
    if (ambienceBuffers.has(mood) || ambienceFailed.has(mood) || ambienceLoading.has(mood)) return
    ambienceLoading.add(mood)
    try {
      const response = await fetch(`/assets/audio/ambience/${mood}.ogg`)
      if (!response.ok) throw new Error(`ambience ${mood}: ${response.status}`)
      const encoded = await response.arrayBuffer()
      const decoded = await context.decodeAudioData(encoded)
      if (disposed) return
      ambienceBuffers.set(mood, decoded)
      // Настроение могло смениться, пока файл летел: запускаем только то,
      // что должно играть прямо сейчас.
      if (desiredMood === mood) startAmbientLayer(mood, 1.2)
    } catch {
      ambienceFailed.add(mood)
    } finally {
      ambienceLoading.delete(mood)
    }
  }

  const startAmbientLayer = (mood: AtmosphereMood, fadeSeconds: number) => {
    if (!context || !ambientBus || disposed) return
    if (currentLayer?.mood === mood) return
    const recorded = ambienceBuffers.get(mood)
    if (!recorded) {
      void loadAmbience(mood)
      return
    }
    const now = context.currentTime
    const duration = Math.max(0.05, Math.min(8, fadeSeconds))
    const layerGain = context.createGain()
    layerGain.gain.setValueAtTime(0, now)
    layerGain.gain.linearRampToValueAtTime(1, now + duration)
    layerGain.connect(ambientBus)

    const player = track(context.createBufferSource())
    const gain = context.createGain()
    player.buffer = recorded
    player.loop = true
    gain.gain.setValueAtTime(RECORDED_AMBIENCE_LEVEL, now)
    player.connect(gain).connect(layerGain)
    player.start(now)

    const previous = currentLayer
    currentLayer = { mood, gain: layerGain, sources: [player] }
    if (previous) {
      previous.gain.gain.cancelScheduledValues(now)
      previous.gain.gain.setValueAtTime(previous.gain.gain.value, now)
      previous.gain.gain.linearRampToValueAtTime(0, now + duration)
      for (const source of previous.sources) {
        try { source.stop(now + duration + 0.05) } catch {}
      }
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
        ambientBus.connect(context.destination)
        updateBus(context.currentTime)
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
      if (desiredMood === mood && currentLayer?.mood === mood) return
      desiredMood = mood
      if (context) startAmbientLayer(mood, fadeSeconds)
    },
    setWaiting(value) {
      const next = value === true
      if (waiting === next) return
      waiting = next
      updateBus(context?.currentTime ?? 0, 0.45)
    },
    setScreenAttenuation(value) {
      const next = Math.max(0, Math.min(1, Number(value)))
      if (!Number.isFinite(next) || screenAttenuation === next) return
      screenAttenuation = next
      // Плавно: резкий обрыв фона на открытии окна кампаний слышен как сбой.
      updateBus(context?.currentTime ?? 0, 0.35)
    },
    setAmbientVolume(volume) {
      settings = { ...settings, ambientVolume: clampAtmosphereVolume(volume, settings.ambientVolume) }
      updateBus()
      return remember()
    },
    setMuted(muted) {
      settings = { ...settings, muted: muted === true }
      updateBus()
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
      ambientBus = null
      if (context && context.state !== 'closed') {
        try { await context.close() } catch {}
      }
      context = null
    },
  }
}
