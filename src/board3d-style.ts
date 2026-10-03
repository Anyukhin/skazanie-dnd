/**
 * Рисованный стиль 3D-доски: пол, общие материалы и модели предметов из пакета
 * `public/assets/styles/stylized/`. Меняет только вид — игровые данные,
 * правила и то, что видит другой игрок, от него не зависят.
 *
 * Модели пакета не несут своих текстур: материалы с именем `skz:<ключ>`
 * заменяются общими материалами пакета (рисованные фактуры Quaternius), а
 * оттенок детали задают цвета вершин. Так сотня моделей делит десяток текстур.
 */
import * as THREE from 'three'

export const GRAPHICS_STYLE = 'stylized'

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

export type StyleMaterial = {
  color: string
  normal?: string
  orm?: string
  metalness: number
  roughness: number
  doubleSided: boolean
  /** Порог альфа-теста для листвы и других вырезанных деталей. */
  alphaTest?: number
  /** Высота фактуры к ширине: у вырезок-полос повтор не квадратный. */
  aspect: number
}

/** Вид стены: материал пакета и сколько клеток накрывает его повтор по горизонтали. */
export type StyleWallLook = { material: string; cells: number }

export type StylePreview = { x: number; y: number; w: number; h: number }
export type StyleProp = { key: string; url: string; yaw: number; preview?: StylePreview; maxHeight?: number; size?: [number, number, number] }
export type StyleAtlas = { image: string; key: string }

export type GraphicsStylePack = {
  style: typeof GRAPHICS_STYLE
  revision: string
  floors: Record<string, StyleFloor>
  materials: Record<string, StyleMaterial>
  walls: Record<string, StyleWallLook>
  props: Record<string, StyleProp[]>
  atlas?: StyleAtlas
}

const ROOT = '/assets/styles/'
const KEY = /^[a-z][a-z-]{0,23}$/u
const MATERIAL_KEY = /^[a-z][a-z0-9-]{0,47}$/u
const ASSET_ID = /^[a-z][a-z0-9_]{0,47}$/u
const FLOOR_FILE = /^floors\/[a-z-]+\/(?:color|normal|orm|height)\.jpg$/u
const MATERIAL_FILE = /^materials\/[a-z0-9-]+\/(?:color\.png|(?:color|normal|orm)\.jpg)$/u
const STYLE_ATLAS_FILE = /^topdown\.(?:png|webp)$/u
const PROP_FILE = /^props\/[a-z0-9_]+\.glb$/u
/** Готовые модели Quaternius из выпуска окружения: стиль ссылается на них, а не копирует. */
const RELEASE_FILE = /^\/assets\/models\/environment\/releases\/[a-f0-9]{24}\/(?:quaternius|quaternius-nature)\/[a-z0-9_]+\.glb$/u
const MANIFEST_LIMIT = 256_000

function finite(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

/**
 * Проверяет манифест стиля и переводит пути пакета в абсолютные. Любая
 * неожиданность — отказ целиком: доска остаётся с прежним полом и моделями.
 */
export function validateGraphicsStylePack(raw: unknown): GraphicsStylePack {
  const input = raw as Record<string, unknown> | null
  if (!input || typeof input !== 'object' || input.schema !== 'graphics-style/v1' || input.style !== GRAPHICS_STYLE) throw new Error('Некорректный пакет стиля')
  if (typeof input.revision !== 'string' || !/^[0-9a-f]{8,64}$/u.test(input.revision)) throw new Error('Нет ревизии пакета стиля')
  const base = `${ROOT}${GRAPHICS_STYLE}/`
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
  const materials: Record<string, StyleMaterial> = {}
  const rawMaterials = (input.materials ?? {}) as Record<string, Record<string, unknown>>
  if (typeof rawMaterials !== 'object' || Object.keys(rawMaterials).length > 64) throw new Error('Некорректный список материалов')
  for (const [key, material] of Object.entries(rawMaterials)) {
    if (!MATERIAL_KEY.test(key) || !material || typeof material !== 'object') throw new Error(`Некорректный материал ${key}`)
    const optional = (name: string) => material[name] === undefined ? undefined : material[name]
    if (typeof material.color !== 'string' || !MATERIAL_FILE.test(material.color)) throw new Error(`Некорректная фактура материала ${key}`)
    for (const name of ['normal', 'orm']) {
      const file = optional(name)
      if (file !== undefined && (typeof file !== 'string' || !MATERIAL_FILE.test(file))) throw new Error(`Некорректная карта материала ${key}`)
    }
    if (!finite(material.metalness, 0, 1) || !finite(material.roughness, 0, 1)) throw new Error(`Некорректные свойства материала ${key}`)
    if (material.alphaTest !== undefined && !finite(material.alphaTest, 0, 1)) throw new Error(`Некорректный альфа-тест материала ${key}`)
    if (material.aspect !== undefined && !finite(material.aspect, .05, 20)) throw new Error(`Некорректная пропорция материала ${key}`)
    materials[key] = {
      color: base + material.color,
      ...(typeof material.normal === 'string' ? { normal: base + material.normal } : {}),
      ...(typeof material.orm === 'string' ? { orm: base + material.orm } : {}),
      metalness: material.metalness as number, roughness: material.roughness as number, doubleSided: material.doubleSided === true,
      ...(typeof material.alphaTest === 'number' ? { alphaTest: material.alphaTest } : {}),
      aspect: typeof material.aspect === 'number' ? material.aspect : 1,
    }
  }
  const walls: Record<string, StyleWallLook> = {}
  const rawWalls = (input.walls ?? {}) as Record<string, Record<string, unknown>>
  if (typeof rawWalls !== 'object' || Object.keys(rawWalls).length > 32) throw new Error('Некорректный список стен')
  for (const [key, look] of Object.entries(rawWalls)) {
    if (!KEY.test(key) || !look || typeof look !== 'object' || typeof look.material !== 'string' || !materials[look.material] || !finite(look.cells, .1, 8)) {
      throw new Error(`Некорректный вид стены ${key}`)
    }
    walls[key] = { material: look.material, cells: look.cells as number }
  }
  const props: Record<string, StyleProp[]> = {}
  const rawProps = (input.props ?? {}) as Record<string, unknown>
  // Защитный предел, а не смысловой: в пакете 264 вида, место для роста есть.
  if (typeof rawProps !== 'object' || Object.keys(rawProps).length > 512) throw new Error('Некорректный список предметов')
  const rawAtlas = input.atlas
  let atlas: StyleAtlas | undefined
  if (rawAtlas !== undefined) {
    if (!rawAtlas || typeof rawAtlas !== 'object' || Array.isArray(rawAtlas)) throw new Error('Некорректный атлас предметов стиля')
    const atlasInput = rawAtlas as Record<string, unknown>
    if (typeof atlasInput.image !== 'string' || !STYLE_ATLAS_FILE.test(atlasInput.image)
      || typeof atlasInput.key !== 'string' || !/^[0-9a-f]{8,64}$/u.test(atlasInput.key)) {
      throw new Error('Некорректный атлас предметов стиля')
    }
    atlas = { image: base + atlasInput.image, key: atlasInput.key }
  }
  for (const [assetId, list] of Object.entries(rawProps)) {
    if (!ASSET_ID.test(assetId) || !Array.isArray(list) || !list.length || list.length > 8) throw new Error(`Некорректный предмет ${assetId}`)
    props[assetId] = list.map((entry: Record<string, unknown>) => {
      const url = entry?.url
      const local = typeof url === 'string' && PROP_FILE.test(url)
      if (!entry || typeof url !== 'string' || !(local || RELEASE_FILE.test(url)) || typeof entry.key !== 'string' || !/^[a-z0-9_-]{1,80}$/u.test(entry.key)) {
        throw new Error(`Некорректная модель предмета ${assetId}`)
      }
      const yaw = finite(entry.yaw, -360, 360) ? entry.yaw as number : 0
      let preview: StylePreview | undefined
      if (entry.preview !== undefined) {
        if (!atlas || !entry.preview || typeof entry.preview !== 'object' || Array.isArray(entry.preview)) throw new Error(`Некорректный preview предмета ${assetId}`)
        const rawPreview = entry.preview as Record<string, unknown>
        if (!['x', 'y', 'w', 'h'].every((name) => typeof rawPreview[name] === 'number' && Number.isSafeInteger(rawPreview[name]) && Number(rawPreview[name]) >= 0 && Number(rawPreview[name]) <= 16_384)
          || Number(rawPreview.w) < 1 || Number(rawPreview.h) < 1
          || Number(rawPreview.x) + Number(rawPreview.w) > 16_384 || Number(rawPreview.y) + Number(rawPreview.h) > 16_384) {
          throw new Error(`Некорректный preview предмета ${assetId}`)
        }
        preview = { x: Number(rawPreview.x), y: Number(rawPreview.y), w: Number(rawPreview.w), h: Number(rawPreview.h) }
      }
      const maxHeight = entry.maxHeight
      if (maxHeight !== undefined && !finite(maxHeight, 0.0001, 8)) throw new Error(`Некорректная высота модели ${assetId}`)
      const size = entry.size
      if (size !== undefined && (!Array.isArray(size) || size.length !== 3 || size.some((value) => !finite(value, 0.0001, 10_000)))) {
        throw new Error(`Некорректный габарит модели ${assetId}`)
      }
      return {
        key: entry.key, url: local ? base + url : url, yaw,
        ...(preview ? { preview } : {}),
        ...(typeof maxHeight === 'number' ? { maxHeight } : {}),
        ...(Array.isArray(size) ? { size: [size[0] as number, size[1] as number, size[2] as number] } : {}),
      }
    })
  }
  return { style: GRAPHICS_STYLE, revision: input.revision, floors, materials, walls, props, ...(atlas ? { atlas } : {}) }
}

let pack: Promise<GraphicsStylePack | null> | null = null
let loadedPack: GraphicsStylePack | null = null

/**
 * Уже загруженный пакет без ожидания: сцена, пересобранная после первой,
 * строит стены и двери стиля сразу, а не прежними на один кадр.
 */
export function peekGraphicsStylePack(): GraphicsStylePack | null {
  return loadedPack
}

/** Пакет стиля, один запрос на сессию; при ошибке — null и повтор при следующем обращении. */
export function loadGraphicsStylePack(): Promise<GraphicsStylePack | null> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return Promise.resolve(null)
  if (pack) return pack
  const promise = fetch(`${ROOT}${GRAPHICS_STYLE}/manifest.json`, { cache: 'no-cache', signal: AbortSignal.timeout(10_000) })
    .then(async (response) => {
      if (!response.ok) return null
      const text = await response.text()
      if (text.length > MANIFEST_LIMIT) return null
      return validateGraphicsStylePack(JSON.parse(text))
    })
    .catch(() => null)
    .then((result) => {
      if (!result && pack === promise) pack = null
      if (result) loadedPack = result
      return result
    })
  pack = promise
  return promise
}

/** Модель предмета из пакета стиля; вариант выбирается тем же хешем, что и в основном каталоге. */
export function stylePropFor(stylePack: GraphicsStylePack | null | undefined, assetId: string, propId: string): StyleProp | null {
  const choices = stylePack?.props[assetId]
  if (!choices?.length) return null
  let seed = 2166136261
  for (const char of propId) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0
  return choices[seed % choices.length]
}

export type StyleMaterialBinder = {
  /** Заменяет материалы `skz:*` в модели; возвращает число замен. */
  bind: (root: THREE.Object3D) => number
  /** Все текстуры, запрошенные до сих пор, загружены (или не загрузились). */
  ready: () => Promise<void>
}

/**
 * Подстановка общих материалов пакета вместо `skz:<ключ>`. Один экземпляр
 * на загрузку моделей сцены: материал и его текстуры создаются один раз и
 * освобождаются вместе с моделями. Неизвестный ключ оставляет материал файла.
 * `loadTexture` внедряется в тестах: возвращает текстуру и вызывает `done`, когда картинка пришла.
 */
export function createStyleMaterialBinder(
  stylePack: GraphicsStylePack,
  loadTexture: (url: string, done: () => void) => THREE.Texture = (url, done) => new THREE.TextureLoader().load(url, done, undefined, done),
): StyleMaterialBinder {
  const textures = new Map<string, THREE.Texture>()
  const pending: Promise<void>[] = []
  const materials = new Map<string, THREE.MeshStandardMaterial>()
  const texture = (url: string, color: boolean) => {
    let map = textures.get(url)
    if (!map) {
      let done = () => {}
      pending.push(new Promise<void>((resolve) => { done = resolve }))
      map = loadTexture(url, () => done())
      // UV моделей glTF: начало в верхнем левом углу картинки.
      map.flipY = false
      map.wrapS = map.wrapT = THREE.RepeatWrapping
      map.anisotropy = 4
      if (color) map.colorSpace = THREE.SRGBColorSpace
      textures.set(url, map)
    }
    return map
  }
  const material = (key: string, vertexColors: boolean) => {
    const spec = stylePack.materials[key]
    if (!spec) return null
    const id = `${key}:${vertexColors}`
    let result = materials.get(id)
    if (!result) {
      const orm = spec.orm ? texture(spec.orm, false) : null
      result = new THREE.MeshStandardMaterial({
        name: `skz:${key}`, vertexColors,
        map: texture(spec.color, true), normalMap: spec.normal ? texture(spec.normal, false) : null,
        roughnessMap: orm, metalnessMap: orm, aoMap: orm, aoMapIntensity: .8,
        roughness: spec.roughness, metalness: orm ? spec.metalness : 0, alphaTest: spec.alphaTest ?? 0,
        side: spec.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      })
      materials.set(id, result)
    }
    return result
  }
  const bind = (root: THREE.Object3D) => {
    let bound = 0
    root.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const replace = (current: THREE.Material) => {
        if (!current.name.startsWith('skz:')) return current
        const shared = material(current.name.slice(4), Boolean(mesh.geometry.getAttribute('color')))
        if (!shared) return current
        current.dispose()
        bound += 1
        return shared
      }
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(replace) : replace(mesh.material)
    })
    return bound
  }
  return { bind, ready: () => Promise.all(pending).then(() => undefined) }
}
