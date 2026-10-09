import * as THREE from 'three'

/**
 * Объёмный пол: смещение вершин по карте высот пакета стиля. Верх клетки
 * делится на сетку, и каждая вершина опускается там, где на карте высот шов
 * или впадина, — камни и доски получают настоящий силуэт и тень, а не только
 * иллюзию параллакса. Только представление: высота клетки для правил прежняя,
 * смещение — вниз от верха плитки, поэтому предметы и фигуры не тонут.
 */

/** Варианты рельефа: число делений стороны клетки и множитель глубины к `relief` пола. */
export const BOARD3D_FLOOR_RELIEF = {
  medium: { subdivisions: 8, depthScale: 2.5 },
  strong: { subdivisions: 12, depthScale: 4 },
} as const

export type FloorReliefLevel = keyof typeof BOARD3D_FLOOR_RELIEF

/**
 * Предел вершин верха на одну сетку покрытия: большая карта получает меньше
 * делений. Сборка идёт в главном потоке на каждой пересборке доски: на карте
 * 30×24 — около 60 мс, на 84×70 с этим пределом — около 100 мс (замер 2026-10-10).
 */
export const FLOOR_RELIEF_MAX_VERTICES = 300_000

/** Сколько делений стороны клетки допустимо при данном числе клеток. */
export function reliefSubdivisions(cells: number, wanted: number): number {
  let subdivisions = Math.max(1, Math.floor(wanted))
  while (subdivisions > 2 && cells * (subdivisions + 1) ** 2 > FLOOR_RELIEF_MAX_VERTICES) subdivisions -= 1
  return subdivisions
}

/**
 * Высота 0..1 по UV в повторах фактуры (с заворотом). Картинка сначала
 * усредняется до `samples` × `samples` на повтор — частоте вершин сетки,
 * иначе тонкие швы давали бы рваную «пилу» между вершинами, — затем
 * читается билинейно. Канал — красный (карты высот серые).
 */
export function createHeightSampler(data: Uint8ClampedArray | Uint8Array, width: number, height: number, samples: number): (u: number, v: number) => number {
  const size = Math.max(2, Math.min(Math.round(samples), width, height))
  const grid = new Float32Array(size * size)
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const x0 = Math.floor(x * width / size), x1 = Math.max(x0 + 1, Math.floor((x + 1) * width / size))
    const y0 = Math.floor(y * height / size), y1 = Math.max(y0 + 1, Math.floor((y + 1) * height / size))
    let sum = 0
    for (let sy = y0; sy < y1; sy += 1) for (let sx = x0; sx < x1; sx += 1) sum += data[(sy * width + sx) * 4]
    grid[y * size + x] = sum / ((x1 - x0) * (y1 - y0) * 255)
  }
  const at = (x: number, y: number) => grid[(((y % size) + size) % size) * size + (((x % size) + size) % size)]
  return (u, v) => {
    // Центры ячеек сетки — в серединах пикселей усреднения.
    const fx = u * size - .5, fy = v * size - .5
    const x = Math.floor(fx), y = Math.floor(fy)
    const tx = fx - x, ty = fy - y
    return (at(x, y) * (1 - tx) + at(x + 1, y) * tx) * (1 - ty) + (at(x, y + 1) * (1 - tx) + at(x + 1, y + 1) * tx) * ty
  }
}

/** Карта высот загруженной фактуры; null — без DOM или картинка не читается. */
export function heightSamplerFromTexture(texture: THREE.Texture, samples: number): ((u: number, v: number) => number) | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
  const image = texture.image as (CanvasImageSource & { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number }) | null | undefined
  const width = image?.naturalWidth || image?.width || 0
  const height = image?.naturalHeight || image?.height || 0
  if (!image || !width || !height) return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(image, 0, 0)
    const sampler = createHeightSampler(context.getImageData(0, 0, width, height).data, width, height, samples)
    // Строка 0 картинки — её верх. С flipY (так грузит TextureLoader) шейдер
    // читает v = 0 из нижней строки: выборка повторяет это, иначе выпуклость
    // камня разошлась бы с его рисунком.
    return texture.flipY ? (u, v) => sampler(u, 1 - v) : sampler
  } catch {
    return null
  }
}
