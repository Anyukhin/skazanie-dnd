// Обёртка `server/scene-program-layout.mjs` для записи вызовов
// (см. `scene-program-layout-capture.mjs`).
import * as real from '../../../../server/scene-program-layout.mjs?real'
import { serializeTacticalMap } from '../../../../server/tactical-map.mjs'

const captured = (globalThis.__skSceneProgramCaptured ??= { apply: [], outdoors: [], recording: true })
const snapshot = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)))

export const SCENE_PROGRAM_LAYOUT_VERSION = real.SCENE_PROGRAM_LAYOUT_VERSION
export const PLATFORM_ELEVATION_FEET = real.PLATFORM_ELEVATION_FEET
export const placeSceneFocus = real.placeSceneFocus
export const buildPlatforms = real.buildPlatforms
export const placeThresholdStones = real.placeThresholdStones

export function programFocusOutdoors(program) {
  const result = real.programFocusOutdoors(program)
  if (captured.recording) captured.outdoors.push({ program: snapshot(program), result })
  return result
}

export function applyScenePlan(map, program, options) {
  if (!captured.recording) return real.applyScenePlan(map, program, options)
  const before = serializeTacticalMap(map)
  const result = real.applyScenePlan(map, program, options)
  captured.apply.push({ before, program: snapshot(program), seed: options?.seed, after: serializeTacticalMap(map) })
  return result
}
