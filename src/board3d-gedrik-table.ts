import * as THREE from 'three'
import { finishLandmarkMaterial } from './board3d-landmark-materials'
import { geometry, material, part, type Resources } from './board3d-prop-resources'

/** Верхняя рабочая плоскость походного стола в клетках. Реквизит на столе
 * получает эту высоту через обычный `surfaceHeight` предмета. */
export const GEDRIK_TABLE_SURFACE_HEIGHT = 0.73

const WOOD = '#654431'
const WOOD_DARK = '#38291f'
const WOOD_EDGE = '#8d6240'
const MAP_PAPER = '#b4a477'
const MAP_LOW = '#64705a'
const MAP_HIGH = '#8d8059'
const BRASS = '#b18a4c'
const RED_MARK = '#7f3b32'

function lineGeometry(points: readonly [number, number, number][], radius: number) {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)))
  return new THREE.TubeGeometry(curve, Math.max(4, points.length * 3), radius, 5, false)
}

function makeMapTexture() {
  const canvas = typeof document === 'undefined' ? null : document.createElement('canvas')
  if (!canvas) return null
  canvas.width = 256
  canvas.height = 192
  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillStyle = MAP_PAPER
  context.fillRect(0, 0, 256, 192)
  // Горные хребты условными штрихами. Они читаются как карта местности,
  // не превращаясь в случайные пятна и буквенные подписи.
  context.globalAlpha = .48
  context.strokeStyle = '#586050'
  context.lineWidth = 2
  for (const [startX, startY, count, slope] of [[14,75,9,-4],[28,90,6,-6],[148,155,6,-3]]) {
    for (let n=0; n<count; n++) {
      const x = startX + n * 13
      const y = startY + n * slope + 5 * Math.sin(n * .8)
      const summit = y - 5 - 6 * Math.sin((n+1)/(count+1)*Math.PI)
      context.beginPath()
      context.moveTo(x, y + 3)
      context.lineTo(x + 7, summit)
      context.lineTo(x + 17, y + 2)
      context.moveTo(x + 7, summit + 2)
      context.lineTo(x + 9, y - 1)
      context.stroke()
    }
  }
  // Лес условными группами коротких треугольных знаков.
  context.fillStyle = '#526348'
  context.globalAlpha = .55
  for (let cluster = 0; cluster < 14; cluster += 1) {
    const x = 18 + (cluster * 53) % 220
    const y = 17 + (cluster * 31) % 150
    context.beginPath()
    context.moveTo(x, y + 11); context.lineTo(x + 5, y); context.lineTo(x + 10, y + 11); context.closePath(); context.fill()
    context.beginPath()
    context.moveTo(x + 11, y + 10); context.lineTo(x + 15, y + 2); context.lineTo(x + 19, y + 10); context.closePath(); context.fill()
  }
  // Река и приток с более тонкой линией.
  context.globalAlpha = .58
  context.strokeStyle = '#354d45'
  context.lineWidth = 5
  context.beginPath()
  context.moveTo(10, 132)
  context.bezierCurveTo(54, 110, 73, 150, 112, 121)
  context.bezierCurveTo(148, 94, 182, 121, 246, 59)
  context.stroke()
  context.lineWidth = 2
  context.beginPath()
  context.moveTo(105, 126)
  context.bezierCurveTo(94, 94, 76, 82, 58, 68)
  context.stroke()
  // Главный маршрут и складки бумаги.
  context.strokeStyle = '#8a3b31'
  context.lineWidth = 3
  context.beginPath()
  context.moveTo(25, 28)
  context.lineTo(85, 59)
  context.lineTo(139, 45)
  context.lineTo(206, 92)
  context.stroke()
  context.globalAlpha = .12
  context.strokeStyle = '#fff4cd'
  context.lineWidth = 1
  for (const y of [24, 82, 151]) {
    context.beginPath(); context.moveTo(8, y); context.bezierCurveTo(80, y - 3, 170, y + 4, 248, y - 1); context.stroke()
  }
  context.globalAlpha = 1
  context.globalAlpha = 1
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
  texture.anisotropy = 4
  texture.needsUpdate = true
  return texture
}

/** Авторский стол Гедрика. Карта условная и декоративная, поэтому содержит
 * только рельеф, маршрутную линию и цветные грузики без буквенных названий. */
export function buildGedrikTable(owned: Resources, parent: THREE.Group, width: number, depth: number) {
  const table = new THREE.Group()
  table.name = 'gedrik-command-table'
  const w = Math.max(1.4, width * .84)
  const d = Math.max(1.4, depth * .84)
  const wood = material(owned, 'gedrik-table-wood', WOOD, { roughness: .84 })
  finishLandmarkMaterial(wood, 'wood')
  const dark = material(owned, 'gedrik-table-dark', WOOD_DARK, { roughness: .9 })
  const edge = material(owned, 'gedrik-table-edge', WOOD_EDGE, { roughness: .76 })
  const brass = material(owned, 'gedrik-table-brass', BRASS, { roughness: .42, metalness: .46 })
  let map = owned.materialPool.get('gedrik-table-map')
  if (!map) {
    const texture = makeMapTexture()
    if (texture) owned.textures.add(texture)
    map = material(owned, 'gedrik-table-map', texture ? '#ffffff' : MAP_PAPER, { roughness: 1, metalness: 0, map: texture })
  }
  const green = material(owned, 'gedrik-table-map-low', MAP_LOW, { roughness: 1 })
  const high = material(owned, 'gedrik-table-map-high', MAP_HIGH, { roughness: 1 })
  const red = material(owned, 'gedrik-table-route-marker', RED_MARK, { roughness: .56, metalness: .12 })

  part(owned, table, 'table-top', 'gedrik-table-top', () => new THREE.BoxGeometry(1, 1, 1), wood, [w, .12, d], [0, GEDRIK_TABLE_SURFACE_HEIGHT - .06, 0])
  part(owned, table, 'table-map', 'gedrik-table-map-slab', () => new THREE.BoxGeometry(1, 1, 1), map, [w * .70, .024, d * .65], [0, GEDRIK_TABLE_SURFACE_HEIGHT + .014, .015], [0, 0, 0], false)

  // Обвязка удерживает карту и даёт крупным граням красивый светлый контур.
  for (const [name, size, position] of [
    ['rim-n', [w, .09, .05], [0, GEDRIK_TABLE_SURFACE_HEIGHT - .02, -d * .48]],
    ['rim-s', [w, .09, .05], [0, GEDRIK_TABLE_SURFACE_HEIGHT - .02, d * .48]],
    ['rim-w', [.05, .09, d * .94], [-w * .48, GEDRIK_TABLE_SURFACE_HEIGHT - .02, 0]],
    ['rim-e', [.05, .09, d * .94], [w * .48, GEDRIK_TABLE_SURFACE_HEIGHT - .02, 0]],
  ] as const) part(owned, table, name, `gedrik-${name}`, () => new THREE.BoxGeometry(1, 1, 1), edge, size as [number, number, number], position as [number, number, number])

  const seam = material(owned, 'gedrik-table-seam', WOOD_DARK, { roughness: .9 })
  for (const z of [-d * .22, d * .22]) part(owned, table, 'plank-seam', 'gedrik-table-plank-seam', () => new THREE.BoxGeometry(1, 1, 1), seam, [w * .86, .008, .012], [0, GEDRIK_TABLE_SURFACE_HEIGHT + .004, z], [0, 0, .01], false)

  for (const x of [-w * .34, w * .34]) for (const z of [-d * .29, d * .29]) {
    part(owned, table, 'trestle-leg', 'gedrik-table-leg', () => new THREE.BoxGeometry(1, 1, 1), dark, [.12, .66, .12], [x, .35, z], [0, 0, (x * z > 0 ? -.12 : .12)])
    part(owned, table, 'brass-foot', 'gedrik-table-foot', () => new THREE.CylinderGeometry(.07, .08, .035, 8), brass, [1, 1, 1], [x, .025, z])
  }
  part(owned, table, 'trestle-crossbar', 'gedrik-table-crossbar', () => new THREE.BoxGeometry(1, 1, 1), dark, [w * .72, .09, .09], [0, .3, 0])

  // Объёмные ориентиры на карте, чтобы предмет читался как рабочий план.
  const route = geometry(owned, 'gedrik-table-route', () => lineGeometry([[-w * .23, GEDRIK_TABLE_SURFACE_HEIGHT + .032, -d * .18], [-w * .10, GEDRIK_TABLE_SURFACE_HEIGHT + .035, d * .06], [w * .15, GEDRIK_TABLE_SURFACE_HEIGHT + .032, d * .12], [w * .30, GEDRIK_TABLE_SURFACE_HEIGHT + .032, -d * .17]], .007))
  const routeMesh = new THREE.Mesh(route, red)
  routeMesh.name = 'route-line'
  routeMesh.castShadow = false
  routeMesh.receiveShadow = true
  table.add(routeMesh)
  for (const [x, z, materialValue] of [[-w * .23, -d * .18, green], [w * .15, d * .12, high], [w * .30, -d * .17, red]] as const) {
    const pin = part(owned, table, 'map-marker', 'gedrik-map-marker', () => new THREE.CylinderGeometry(.045, .06, .10, 8), materialValue, [1, 1, 1], [x, GEDRIK_TABLE_SURFACE_HEIGHT + .09, z])
    pin.rotation.x = .18
  }
  const paperTop = GEDRIK_TABLE_SURFACE_HEIGHT + .014 + .012
  const hide = material(owned, 'gedrik-map-hide', '#705544', { roughness:.93 })
  const scroll = material(owned, 'gedrik-rolled-map', '#b9a17c', { roughness:.98 })
  part(owned, table, 'rolled-orders', 'gedrik-scroll', () => new THREE.CylinderGeometry(.044,.052,.61,16), scroll, [1,1,1],
    [-w*.17,GEDRIK_TABLE_SURFACE_HEIGHT+.049,d*.406],[0,0,Math.PI/2])
  for (const x of [-.16,.17]) part(owned, table, 'scroll-tie','gedrik-scroll-tie',() => new THREE.TorusGeometry(.049,.008,6,14),hide,[1,1,1],
    [-w*.17+x,GEDRIK_TABLE_SURFACE_HEIGHT+.049,d*.406],[0,Math.PI/2,0])
  for (const [x, z] of [[-w * .325, -d * .292], [w * .325, -d * .292], [-w * .325, d * .292], [w * .325, d * .292]] as const) {
    part(owned, table, 'map-clamp', 'gedrik-map-clamp', () => new THREE.CylinderGeometry(.065, .065, .035, 10), brass, [1, 1, 1], [x, paperTop + .0175, z])
  }
  parent.userData.surfaceHeight = GEDRIK_TABLE_SURFACE_HEIGHT
  table.userData.surfaceHeight = GEDRIK_TABLE_SURFACE_HEIGHT
  table.userData.gedrikTable = true
  parent.add(table)
  return table
}
