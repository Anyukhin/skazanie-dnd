import { Vector3, type OrthographicCamera } from 'three'
import type { TacticalBounds } from './types'

/** Вписывает объём сцены в реальную проекцию, включая пропорции окна и высоту фигурок. */
export function boardCameraFitZoom(
  camera: OrthographicCamera,
  bounds: TacticalBounds,
  width: number,
  height: number,
  heightRange: { min: number; max: number } = { min: 0, max: 0 },
) {
  camera.updateMatrixWorld()
  let extentX = 0, extentY = 0
  const point = new Vector3()
  const minHeight = Number.isFinite(heightRange.min) ? heightRange.min : 0
  const maxHeight = Number.isFinite(heightRange.max) ? heightRange.max : 0
  for (const x of [bounds.minX, bounds.maxX + 1]) for (const z of [bounds.minY, bounds.maxY + 1]) for (const y of [minHeight, maxHeight + 2]) {
    point.set(x, y, z).project(camera)
    extentX = Math.max(extentX, Math.abs(point.x))
    extentY = Math.max(extentY, Math.abs(point.y))
  }
  const freeX = 1 - Math.min(.25, 40 / Math.max(1, width))
  const freeY = 1 - Math.min(.35, 150 / Math.max(1, height))
  return Math.max(.05, Math.min(5, camera.zoom * Math.min(freeX / Math.max(.001, extentX), freeY / Math.max(.001, extentY))))
}
