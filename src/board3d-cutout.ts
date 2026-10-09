import * as THREE from 'three'

/**
 * Листва, вырезанная по альфе: кроны, кусты, цветы, папоротник, плющ. Только
 * представление — модуль правит фактуры и материалы уже загруженных моделей и
 * не знает ни карты, ни правил.
 *
 * Фактуры листвы Quaternius хранят под прозрачными пикселями чёрный цвет.
 * Мипмапы усредняют его с зеленью, и чем дальше камера, тем темнее лист: на
 * обзоре доски кроны и кусты были почти чёрными пятнами. Пустые пиксели
 * получают цвет ближайших непрозрачных, альфа и рисунок листа не меняются.
 */

/** Пиксели прозрачнее порога считаются пустыми и перекрашиваются. */
export const CUTOUT_EMPTY_ALPHA = 8

/**
 * Заливает цвет пустых пикселей RGBA цветом ближайших непрозрачных:
 * пирамида уменьшений с весом по альфе («push-pull»). Пустой пиксель берёт
 * цвет самого мелкого уровня, где в его окрестности уже есть лист, поэтому
 * мипмапы смешивают зелень с зеленью, а не с чёрным. Непрозрачные пиксели не
 * трогаются. Возвращает число перекрашенных пикселей; 0 — либо пустых нет,
 * либо нет ни одного непрозрачного.
 */
export function bleedTransparentTexels(data: Uint8ClampedArray | Uint8Array, width: number, height: number, threshold = CUTOUT_EMPTY_ALPHA): number {
  if (!(width > 0 && height > 0) || data.length < width * height * 4) return 0
  type Level = { width: number; height: number; sums: Float32Array }
  const levels: Level[] = []
  // Первый уровень пирамиды — уже вдвое меньше: исходник читается из data.
  let level: Level = { width: Math.ceil(width / 2), height: Math.ceil(height / 2), sums: new Float32Array(Math.ceil(width / 2) * Math.ceil(height / 2) * 4) }
  let empty = 0, solid = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = (y * width + x) * 4
      const alpha = data[from + 3]
      if (alpha < threshold) { empty += 1; continue }
      solid += 1
      const weight = alpha / 255
      const to = ((y >> 1) * level.width + (x >> 1)) * 4
      level.sums[to] += data[from] * weight
      level.sums[to + 1] += data[from + 1] * weight
      level.sums[to + 2] += data[from + 2] * weight
      level.sums[to + 3] += weight
    }
  }
  if (!empty || !solid) return 0
  levels.push(level)
  while (level.width > 1 || level.height > 1) {
    const next: Level = { width: Math.ceil(level.width / 2), height: Math.ceil(level.height / 2), sums: new Float32Array(0) }
    next.sums = new Float32Array(next.width * next.height * 4)
    for (let y = 0; y < level.height; y += 1) {
      for (let x = 0; x < level.width; x += 1) {
        const from = (y * level.width + x) * 4
        const to = ((y >> 1) * next.width + (x >> 1)) * 4
        for (let channel = 0; channel < 4; channel += 1) next.sums[to + channel] += level.sums[from + channel]
      }
    }
    levels.push(next)
    level = next
  }
  // Сверху вниз: у кого вес есть — свой средний цвет, у кого нет — цвет родителя.
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    const current = levels[index], parent = levels[index + 1]
    for (let y = 0; y < current.height; y += 1) {
      for (let x = 0; x < current.width; x += 1) {
        const at = (y * current.width + x) * 4
        const weight = current.sums[at + 3]
        if (weight > 0) {
          current.sums[at] /= weight
          current.sums[at + 1] /= weight
          current.sums[at + 2] /= weight
        } else if (parent) {
          const from = ((y >> 1) * parent.width + (x >> 1)) * 4
          current.sums[at] = parent.sums[from]
          current.sums[at + 1] = parent.sums[from + 1]
          current.sums[at + 2] = parent.sums[from + 2]
        }
      }
    }
  }
  const first = levels[0]
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const to = (y * width + x) * 4
      if (data[to + 3] >= threshold) continue
      const from = ((y >> 1) * first.width + (x >> 1)) * 4
      data[to] = Math.round(first.sums[from])
      data[to + 1] = Math.round(first.sums[from + 1])
      data[to + 2] = Math.round(first.sums[from + 2])
    }
  }
  return empty
}

type CutoutMaterial = THREE.Material & { map: THREE.Texture | null }

/** Непрозрачный материал с вырезом по альфе фактуры — лист, а не стекло. */
export function isCutoutMaterial(material: THREE.Material | null | undefined): material is CutoutMaterial {
  return Boolean(material && material.alphaTest > 0 && !material.transparent && (material as Partial<CutoutMaterial>).map)
}

const bledSources = new WeakSet<object>()
/** Картинки, в которых нашлись пустые пиксели, — настоящая листва, а не кора. */
const foliageSources = new WeakSet<object>()

/**
 * Заливает пустые пиксели загруженной фактуры. Картинка ещё не загружена — ничего
 * не делает: загрузчик вызовет функцию повторно. Одна картинка обрабатывается
 * один раз, даже если её делят несколько фактур.
 */
export function bleedCutoutTexture(texture: THREE.Texture): boolean {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false
  const source = texture.source
  if (bledSources.has(source)) return false
  const image = texture.image as (CanvasImageSource & { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number; complete?: boolean }) | null | undefined
  if (!image || image.complete === false) return false
  const width = image.naturalWidth || image.width || 0
  const height = image.naturalHeight || image.height || 0
  if (!width || !height) return false
  let pixels: ImageData
  try {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return false
    context.drawImage(image, 0, 0)
    pixels = context.getImageData(0, 0, width, height)
  } catch {
    return false
  }
  bledSources.add(source)
  if (!bleedTransparentTexels(pixels.data, width, height)) return false
  foliageSources.add(source)
  // ImageData не умножена на альфу: цвет под пустыми пикселями доходит до
  // видеокарты как есть, и мипмапы строятся уже из него.
  texture.image = pixels
  texture.needsUpdate = true
  return true
}

/**
 * Готовит листву модели: заливка пустых пикселей фактуры и сглаживание края
 * листа через MSAA (alpha to coverage) — край выреза больше не рвётся
 * ступеньками, а дальняя крона не редеет до отдельных точек. Возвращает число
 * подготовленных материалов.
 */
export function prepareCutoutMaterials(root: THREE.Object3D): number {
  const seen = new Set<THREE.Material>()
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (seen.has(material) || !isCutoutMaterial(material)) continue
      seen.add(material)
      prepareCutoutMaterial(material)
    }
  })
  return seen.size
}

function prepareCutoutMaterial(material: CutoutMaterial): void {
  if (!material.alphaToCoverage) {
    material.alphaToCoverage = true
    material.needsUpdate = true
  }
  if (material.map) bleedCutoutTexture(material.map)
}

/**
 * Лист с просветами: материал вырезан по альфе, и в его фактуре есть пустые
 * пиксели. Кора и камень с формальным альфа-тестом (у Quaternius он стоит на
 * всём наборе) сюда не входят. Затенение (GTAO) листву не учитывает: проход
 * нормалей рисует её карточки сплошными прямоугольниками, и густая крона
 * затеняла сама себя почти до черноты.
 */
export function isFoliageMaterial(material: THREE.Material | null | undefined): boolean {
  return isCutoutMaterial(material) && Boolean(material.map && foliageSources.has(material.map.source))
}
