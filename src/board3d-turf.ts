import * as THREE from 'three'

// Фактура нижнего яруса травы. Одна плитка на полторы клетки; концы листьев,
// пересекающие её край, продолжаются на противоположной стороне.
const SIDE = 256
let turfPixels: Uint8Array<ArrayBuffer> | undefined

function paintTurf() {
  const pixels = new Uint8Array(SIDE * SIDE * 4)
  let seed = 782653
  const random = () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0
    return seed / 4294967296
  }
  for (let i = 0; i < pixels.length; i += 4) {
    const speck = random() * 8
    pixels.set([49 + speck, 67 + speck, 40 + speck, 255], i)
  }
  for (let i = 0; i < 5400; i++) {
    const x = random() * SIDE, z = random() * SIDE
    const sweep = Math.sin(x * Math.PI * 2 / SIDE) - Math.cos(z * Math.PI * 4 / SIDE)
    const angle = sweep + (random() - .5) * 4.8
    const dx = Math.cos(angle), dz = Math.sin(angle)
    const length = 5 + random() * 15, halfWidth = .62 + random() * .82
    const bend = (random() - .5) * 3, light = random() * 33, straw = random() ** 5
    const red = 59 + light + 43 * straw, green = 85 + light + 12 * straw, blue = 48 + light * .54 + 8 * straw
    const endX = x + dx * length, endZ = z + dz * length
    for (let pz = Math.floor(Math.min(z, endZ)) - 2; pz <= Math.ceil(Math.max(z, endZ)) + 2; pz++) {
      for (let px = Math.floor(Math.min(x, endX)) - 2; px <= Math.ceil(Math.max(x, endX)) + 2; px++) {
        const along = ((px - x) * dx + (pz - z) * dz) / length
        if (along <= 0 || along >= 1) continue
        const across = (px - x) * dz - (pz - z) * dx - bend * along * (1 - along)
        const coverage = THREE.MathUtils.clamp(halfWidth * (1 - along * .82) + .48 - Math.abs(across), 0, 1)
        const fold = .76 + .28 * along + (across > 0 ? .11 : 0)
        const at = 4 * (((pz & 255) * SIDE) + (px & 255))
        pixels[at] += coverage * (red * fold - pixels[at])
        pixels[at + 1] += coverage * (green * fold - pixels[at + 1])
        pixels[at + 2] += coverage * (blue * fold - pixels[at + 2])
      }
    }
  }
  return pixels
}

export function createTurfTexture() {
  turfPixels ??= paintTurf()
  const texture = new THREE.DataTexture(turfPixels, SIDE, SIDE)
  texture.name = 'ground-grass-blades'
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 8
  texture.needsUpdate = true
  return texture
}
