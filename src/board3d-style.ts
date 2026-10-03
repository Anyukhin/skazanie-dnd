/**
 * Стиль графики 3D-доски — личная настройка игрока, как профиль качества.
 * Меняет только вид: пол и модели предметов берутся из пакета стиля
 * `public/assets/styles/<стиль>/`. Игровые данные, правила и то, что видит
 * другой игрок, от стиля не зависят.
 */

export type Board3DGraphicsStyle = 'stylized' | 'realistic'

export const BOARD3D_GRAPHICS_STYLES: Readonly<Record<Board3DGraphicsStyle, { label: string }>> = Object.freeze({
  stylized: { label: 'Рисованный' },
  realistic: { label: 'Реалистичный' },
})

export const GRAPHICS_STYLE_STORAGE_KEY = 'skazanie-3d-style'

export function board3DGraphicsStyle(value: unknown): Board3DGraphicsStyle {
  return value === 'realistic' ? 'realistic' : 'stylized'
}

export type StyleFloor = {
  color: string
  normal: string
  orm: string
  height: string
  /** Сколько клеток накрывает один повтор текстуры. */
  cells: number
  /** Глубина рельефа в мировых единицах (клетка = 1). */
  relief: number
}

export type StyleProp = { key: string; url: string; yaw: number }

export type GraphicsStylePack = {
  style: Board3DGraphicsStyle
  revision: string
  floors: Record<string, StyleFloor>
  props: Record<string, StyleProp[]>
}

const ROOT = '/assets/styles/'
const KEY = /^[a-z][a-z-]{0,23}$/u
const ASSET_ID = /^[a-z][a-z0-9_]{0,47}$/u
const FLOOR_FILE = /^floors\/[a-z-]+\/(?:color|normal|orm|height)\.jpg$/u
const PROP_FILE = /^props\/[a-z0-9_]+\.glb$/u
const MANIFEST_LIMIT = 256_000

function finite(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

/**
 * Проверяет манифест стиля и переводит пути пакета в абсолютные. Любая
 * неожиданность — отказ целиком: доска остаётся с прежним полом и моделями.
 */
export function validateGraphicsStylePack(raw: unknown, style: Board3DGraphicsStyle): GraphicsStylePack {
  const input = raw as Record<string, unknown> | null
  if (!input || typeof input !== 'object' || input.schema !== 'graphics-style/v1' || input.style !== style) throw new Error('Некорректный пакет стиля')
  if (typeof input.revision !== 'string' || !/^[0-9a-f]{8,64}$/u.test(input.revision)) throw new Error('Нет ревизии пакета стиля')
  const base = `${ROOT}${style}/`
  const floors: Record<string, StyleFloor> = {}
  const rawFloors = (input.floors ?? {}) as Record<string, Record<string, unknown>>
  if (typeof rawFloors !== 'object' || Object.keys(rawFloors).length > 64) throw new Error('Некорректный список полов')
  for (const [key, floor] of Object.entries(rawFloors)) {
    if (!KEY.test(key) || !floor || typeof floor !== 'object') throw new Error(`Некорректный пол ${key}`)
    const files = ['color', 'normal', 'orm', 'height'].map((name) => floor[name])
    if (!files.every((file) => typeof file === 'string' && FLOOR_FILE.test(file))) throw new Error(`Некорректные файлы пола ${key}`)
    if (!finite(floor.cells, .2, 16) || !finite(floor.relief, 0, .2)) throw new Error(`Некорректный масштаб пола ${key}`)
    const [color, normal, orm, height] = files as string[]
    floors[key] = { color: base + color, normal: base + normal, orm: base + orm, height: base + height, cells: floor.cells as number, relief: floor.relief as number }
  }
  const props: Record<string, StyleProp[]> = {}
  const rawProps = (input.props ?? {}) as Record<string, unknown>
  if (typeof rawProps !== 'object' || Object.keys(rawProps).length > 256) throw new Error('Некорректный список предметов')
  for (const [assetId, list] of Object.entries(rawProps)) {
    if (!ASSET_ID.test(assetId) || !Array.isArray(list) || !list.length || list.length > 8) throw new Error(`Некорректный предмет ${assetId}`)
    props[assetId] = list.map((entry: Record<string, unknown>) => {
      if (!entry || typeof entry.url !== 'string' || !PROP_FILE.test(entry.url) || typeof entry.key !== 'string' || !/^[a-z0-9_-]{1,80}$/u.test(entry.key)) {
        throw new Error(`Некорректная модель предмета ${assetId}`)
      }
      const yaw = finite(entry.yaw, -360, 360) ? entry.yaw as number : 0
      return { key: entry.key, url: base + entry.url, yaw }
    })
  }
  return { style, revision: input.revision, floors, props }
}

const packs = new Map<Board3DGraphicsStyle, Promise<GraphicsStylePack | null>>()

/** Пакет стиля, один запрос на сессию; при ошибке — null и повтор при следующем обращении. */
export function loadGraphicsStylePack(style: Board3DGraphicsStyle): Promise<GraphicsStylePack | null> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return Promise.resolve(null)
  const cached = packs.get(style)
  if (cached) return cached
  const promise = fetch(`${ROOT}${style}/manifest.json`, { cache: 'no-cache', signal: AbortSignal.timeout(10_000) })
    .then(async (response) => {
      if (!response.ok) return null
      const text = await response.text()
      if (text.length > MANIFEST_LIMIT) return null
      return validateGraphicsStylePack(JSON.parse(text), style)
    })
    .catch(() => null)
    .then((pack) => {
      if (!pack) packs.delete(style)
      return pack
    })
  packs.set(style, promise)
  return promise
}

/** Модель предмета из пакета стиля; вариант выбирается тем же хешем, что и в основном каталоге. */
export function stylePropFor(pack: GraphicsStylePack | null | undefined, assetId: string, propId: string): StyleProp | null {
  const choices = pack?.props[assetId]
  if (!choices?.length) return null
  let seed = 2166136261
  for (const char of propId) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0
  return choices[seed % choices.length]
}
