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

/**
 * Как вписать модель в якорь.
 * - `stretch` — по каждой оси отдельно: настил моста обязан накрыть пролёт целиком;
 * - `face` — один масштаб для лица (X и Y), глубина свободна: фрагмент стены не
 *   сплющивается в овал, а тонкая плоская модель получает толщину стены;
 * - `contain` — один масштаб по всем осям, модель целиком внутри габарита:
 *   труба, слуховое окно, угловой столб.
 */
export type StructuralFit = 'stretch' | 'face' | 'contain'

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
  /** По умолчанию `contain`: пропорции модели не искажаются. */
  fit?: StructuralFit
  /**
   * Повторить модель вдоль локальной X столько раз, чтобы ряд закрыл ширину:
   * высокая секция ограды в низких перилах иначе стала бы узкой вставкой.
   */
  repeat?: boolean
  /** Крышные детали скрываются вместе со сплошной крышей в cutaway. */
  opaqueRoof?: boolean
}

/**
 * Клонирует шаблон и вписывает его в заданный якорь. Оси модели не влияют на
 * TacticalMap: визуальный экземпляр получает собственную матрицу и только
 * после расчёта габарита поворачивается вдоль ребра или пролёта.
 * `userData.fittedWidth` — ширина, которую модель заняла по локальной X: по ней
 * вызывающий код закрывает остаток ребра обычной кладкой.
 */
export function structuralInstance(
  assets: StructuralModelAssets | null | undefined,
  options: StructuralInstanceOptions,
): THREE.Group | null {
  const source = structuralTemplate(assets, options.role)
  if (!source) return null
  source.template.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(source.template)
  const size = bounds.getSize(new THREE.Vector3())
  if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)
    || size.x <= 1e-5 || size.y <= 1e-5 || size.z <= 1e-5) return null
  if (![options.width, options.height, options.depth].every((value) => Number.isFinite(value) && value > 0)) return null

  const fit = options.fit ?? 'contain'
  const sx = options.width / size.x, sy = options.height / size.y, sz = options.depth / size.z
  let count = 1
  let scale: [number, number, number]
  if (fit === 'stretch') scale = [sx, sy, sz]
  else {
    // Предел по высоте (и по глубине у `contain`) задаёт размер одной копии.
    const limit = fit === 'face' ? sy : Math.min(sy, sz)
    let uniform = Math.min(sx, limit)
    if (options.repeat) {
      count = Math.max(1, Math.round(options.width / (size.x * limit)))
      uniform = Math.min(options.width / (count * size.x), limit)
    }
    scale = [uniform, uniform, fit === 'face' ? sz : uniform]
  }

  const fitted = new THREE.Group()
  fitted.name = `structural:${options.role}`
  fitted.userData.board3dStructural = true
  fitted.userData.structuralRole = options.role
  fitted.userData.fittedWidth = count * size.x * scale[0]
  if (options.opaqueRoof) {
    fitted.userData.board3dRoof = true
    fitted.userData.board3dOpaqueRoof = true
  }
  for (let index = 0; index < count; index += 1) {
    const model = source.template.clone(true)
    // Центрируем после учёта yaw, который записан в самом style entry.
    model.position.set(-(bounds.min.x + bounds.max.x) / 2, -bounds.min.y, -(bounds.min.z + bounds.max.z) / 2)
    const holder = new THREE.Group()
    holder.add(model)
    holder.scale.set(...scale.map((value) => Math.max(.001, value)) as [number, number, number])
    holder.position.x = (index - (count - 1) / 2) * size.x * scale[0]
    fitted.add(holder)
  }
  fitted.position.set(options.x, options.y, options.z)
  fitted.rotation.y = options.yaw ?? 0
  fitted.updateMatrixWorld(true)
  return fitted
}
