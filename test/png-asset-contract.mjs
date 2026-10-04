import { decodePng } from '../tools/png-codec.mjs'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Проверяет общий контракт прозрачного PNG-значка.
 *
 * @param {Buffer} bytes
 * @param {{spanMin: number, spanMax: number}} bounds
 * @returns {string[]}
 */
export function pngContractFailures(bytes, { spanMin, spanMax }) {
  const failures = []
  if (bytes.length < 29 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString('ascii', 12, 16) !== 'IHDR') return ['PNG signature/IHDR']
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (bytes[24] !== 8 || bytes[25] !== 6) failures.push('PNG RGBA 8-bit')
  let image
  try {
    image = decodePng(bytes)
  } catch (error) {
    return [...failures, `decode: ${error instanceof Error ? error.message : String(error)}`]
  }
  if (width !== 256 || height !== 256 || image.width !== 256 || image.height !== 256) failures.push('256x256')
  const alphaAt = (x, y) => image.data[(y * image.width + x) * 4 + 3]
  const corners = [alphaAt(0, 0), alphaAt(255, 0), alphaAt(0, 255), alphaAt(255, 255)]
  if (corners.some((alpha) => alpha !== 0)) failures.push(`transparent corners: ${corners.join(',')}`)
  let left = image.width
  let top = image.height
  let right = -1
  let bottom = -1
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (alphaAt(x, y) < 64) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }
  if (right < left || bottom < top) failures.push('non-empty alpha silhouette')
  else {
    const span = Math.max(right - left + 1, bottom - top + 1)
    if (span < spanMin || span > spanMax) failures.push(`opaque span ${span} (expected ${spanMin}..${spanMax})`)
    if (Math.abs(left - (255 - right)) > 16 || Math.abs(top - (255 - bottom)) > 16) failures.push(`centered bbox [${left},${top},${right},${bottom}]`)
  }
  if (bytes.length > 120 * 1024) failures.push(`size ${bytes.length} > 122880`)
  return failures
}
