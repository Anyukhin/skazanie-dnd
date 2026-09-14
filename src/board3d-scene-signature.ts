import { LEGACY_CATALOG_REVISION } from './prop-model-catalog'
import type { TacticalMap } from './types'

export type Board3DMapSignatures = Readonly<{ staticKey: string; geometryKey: string }>

const signatures = new WeakMap<TacticalMap, Board3DMapSignatures>()

/**
 * Отделяет содержимое окружения от геометрии видимого пола. `terrainHash`
 * включает props, рёбра и материалы, но намеренно не включает раскрытие;
 * geometryKey добавляет только present/revealed/elevation. Номер этажа и
 * выпуск каталога нужны статическому окружению, хотя форму пола не меняют.
 */
export function mapSignaturesFor(map: TacticalMap): Board3DMapSignatures {
  const cached = signatures.get(map)
  if (cached) return cached
  let hash = 0x811c9dc5
  const mix = (value: number) => { hash ^= value & 0xff; hash = Math.imul(hash, 0x01000193) }
  mix(map.width); mix(map.height)
  for (let index = 0; index < map.width * map.height; index += 1) {
    const present = (map.layers.present[index >> 3] & (1 << (index & 7))) !== 0
    const revealed = present && (map.layers.revealed[index >> 3] & (1 << (index & 7))) !== 0
    mix(present ? 1 : 0); mix(revealed ? 1 : 0); mix(revealed ? map.layers.elevation[index] : 0)
  }
  const geometryKey = `${map.width}x${map.height}:${(hash >>> 0).toString(16)}`
  const result = {
    geometryKey,
    staticKey: `${map.levelIndex}:${map.terrainHash}:${map.catalogRevision ?? LEGACY_CATALOG_REVISION}:${geometryKey}`,
  }
  signatures.set(map, result)
  return result
}
