import * as THREE from 'three'
import { propModelFor } from './prop-model-catalog'
import type { PropModelAssets } from './prop-model-assets'
import type { GraphicsStylePack } from './board3d-style'
import type { TacticalProp } from './types'

export type StructuralModelAssets = Pick<PropModelAssets, 'catalog' | 'models'>

/** Модели, которые крепятся к уже существующей геометрии карты. */
export const STRUCTURAL_ROLES = [
  'rope_bridge', 'swamp_boardwalk', 'ruin_wall_arch', 'ruin_corner_brick',
  'round_window_brick', 'chimney_brick', 'roof_dormer_roundtile', 'ornate_iron_fence', 'sandstone_arch',
] as const

export type StructuralRole = typeof STRUCTURAL_ROLES[number]

/**
 * Служебные пропы нужны только загрузчику моделей: в TacticalMap они не
 * попадают и поэтому не получают ни футпринта, ни игровых свойств.
 */
export function structuralLoadProps(pack: GraphicsStylePack | null | undefined, roles: readonly StructuralRole[] = STRUCTURAL_ROLES): TacticalProp[] {
  if (!pack) return []
  const selected = new Set(roles)
  return STRUCTURAL_ROLES.filter((assetId) => selected.has(assetId) && pack.props[assetId]?.length).map((assetId) => ({
    id: `__structural-${assetId}`,
    assetId,
    x: 0,
    y: 0,
    rotation: 0,
    scale: 1,
    footprint: [],
    zOrder: 0,
    blocksMove: false,
    blocksSight: false,
    cover: 'none' as const,
    destructible: false,
    hp: 0,
    interactive: false,
    state: 'default',
  }))
}

/** Шаблон модели из style pack и его запись с поворотом/ограничением высоты. */
export function structuralTemplate(assets: StructuralModelAssets | null | undefined, role: StructuralRole) {
  if (!assets) return null
  const entry = propModelFor(assets.catalog, role, `__structural-${role}`)
  if (!entry || entry.source !== 'style') return null
  const template = assets.models.get(entry.key)
  return template ? { entry, template } : null
}

export type StructuralInstanceOptions = {
  role: StructuralRole
  x: number
  y: number
  z: number
  yaw?: number
  /** Целевые размеры модели в локальных осях после поворота. */
  width: number
  height: number
  depth: number
  /** Крышные детали скрываются вместе со сплошной крышей в cutaway. */
  opaqueRoof?: boolean
}

/**
 * Клонирует шаблон и вписывает его в заданный якорь. Оси модели не влияют на
 * TacticalMap: визуальный экземпляр получает собственную матрицу и только
 * после расчёта габарита поворачивается вдоль ребра или пролёта.
 */
export function structuralInstance(
  assets: StructuralModelAssets | null | undefined,
  options: StructuralInstanceOptions,
): THREE.Group | null {
  const source = structuralTemplate(assets, options.role)
  if (!source) return null
  const model = source.template.clone(true)
  model.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(model)
  const size = bounds.getSize(new THREE.Vector3())
  if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)
    || size.x <= 1e-5 || size.y <= 1e-5 || size.z <= 1e-5) return null

  const fitted = new THREE.Group()
  fitted.name = `structural:${options.role}`
  fitted.userData.board3dStructural = true
  fitted.userData.structuralRole = options.role
  if (options.opaqueRoof) {
    fitted.userData.board3dRoof = true
    fitted.userData.board3dOpaqueRoof = true
  }
  // Центрируем после учёта yaw, который записан в самом style entry.
  model.position.set(
    -(bounds.min.x + bounds.max.x) / 2,
    -bounds.min.y,
    -(bounds.min.z + bounds.max.z) / 2,
  )
  fitted.add(model)
  fitted.position.set(options.x, options.y, options.z)
  fitted.rotation.y = options.yaw ?? 0
  fitted.scale.set(
    Math.max(.001, options.width / size.x),
    Math.max(.001, options.height / size.y),
    Math.max(.001, options.depth / size.z),
  )
  fitted.updateMatrixWorld(true)
  return fitted
}
