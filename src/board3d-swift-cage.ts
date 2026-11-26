import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import { material, part, type Resources } from './board3d-prop-resources'

type CageLayout = { width: number; depth: number }

function mergeWireGeometry(parts: THREE.BufferGeometry[]) {
  const merged = mergeGeometries(parts, false)
  parts.forEach((part) => part.dispose())
  if (!merged) throw new Error('Не удалось собрать каркас клетки')
  merged.computeVertexNormals()
  return merged
}

function wireBox(size: [number, number, number], position: [number, number, number], rotation: [number, number, number] = [0, 0, 0]) {
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  geometry.scale(...size)
  geometry.rotateX(rotation[0]); geometry.rotateY(rotation[1]); geometry.rotateZ(rotation[2])
  geometry.translate(...position)
  return geometry
}

function wireRod(radius: number, length: number, position: [number, number, number], rotation: [number, number, number] = [0, 0, 0]) {
  const geometry = new THREE.CylinderGeometry(radius, radius, length, radius < .007 ? 5 : 8, 1, radius < .007)
  geometry.rotateX(rotation[0]); geometry.rotateY(rotation[1]); geometry.rotateZ(rotation[2])
  geometry.translate(...position)
  return geometry
}

/** Птичья клетка с арочным сводом. Просветы между прутьями существенно уже птицы. */
export function buildSwiftCage(resources: Resources, parent: THREE.Group, layout: CageLayout) {
  const w = Math.min(.33, layout.width * .37), d = Math.min(.27, layout.depth * .30)
  const foot = .087, eave = .54, rise = .168, doorBottom = .18, doorTop = .47, doorHalf = w * .34
  const iron = material(resources, 'swift-iron', '#51554e', { metalness: .38, roughness: .64 })
  const bronze = material(resources, 'swift-fasteners', '#9c7645', { metalness: .51, roughness: .55 })
  const wood = material(resources, 'swift-oak', '#714e37', { roughness: .93 })
  const key = `${w}:${d}`
  const plank = () => new THREE.BoxGeometry(1, 1, 1)
  part(resources, parent, 'swift-cage-wooden-floor', 'swift-plank', plank, wood, [2*w+.026, foot, 2*d+.026], [0,foot/2,0])
  const mesh = (name: string, make: () => THREE.BufferGeometry, surface: THREE.Material) =>
    part(resources, parent, name, name+':'+key, make, surface, [1,1,1], [0,0,0])
  const wireRadius = .0038
  mesh('swift-cage-wireframe', () => {
    const bars: THREE.BufferGeometry[] = []
    const vertical = (x: number, z: number, bottom: number, top: number) =>
      bars.push(wireRod(wireRadius, top-bottom, [x,(bottom+top)/2,z]))
    const archHeight = (x: number) => eave + rise*Math.sqrt(Math.max(0, 1-(x/w)**2))
    const arch = (z: number, radius: number) => {
      const pts = Array.from({ length: 19 }, (_, i) => {
        const angle = Math.PI*i/18
        return new THREE.Vector3(w*Math.cos(angle), eave+rise*Math.sin(angle), z)
      })
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, radius, radius < .007 ? 4 : 6, false)
    }
    for (let i=0; i<=24; i++) {
      const x = w*(i/12-1), top = archHeight(x)
      vertical(x, -d, foot, top)
      if (Math.abs(x) < doorHalf) {
        vertical(x, d, foot, doorBottom)
        vertical(x, d, doorTop, top)
      } else vertical(x, d, foot, top)
    }
    for (let i=0; i<=20; i++) {
      const z = d*(i/10-1)
      bars.push(arch(z, i === 0 || i === 20 ? .009 : wireRadius))
      if (i > 0 && i < 20) for (const side of [-1,1]) vertical(side*w,z,foot,eave)
    }
    // Продольные пояса лежат точно на том же своде, что и поперечные дуги.
    for (const angle of [0, Math.PI/4, Math.PI/2, 3*Math.PI/4, Math.PI]) {
      bars.push(wireRod(.007,2*d,[w*Math.cos(angle),eave+rise*Math.sin(angle),0],[Math.PI/2,0,0]))
    }
    for (const side of [-1,1]) {
      bars.push(wireBox([2*w+.016,.016,.016],[0,foot,side*d]))
      bars.push(wireBox([.016,.016,2*d],[side*w,foot,0]))
      bars.push(wireBox([.013,.012,2*d],[side*w,.29,0]))
      bars.push(wireBox([2*w,.014,.014],[0,eave,side*d]))
    }
    return mergeWireGeometry(bars)
  }, iron)

  // Дверца заполняет проём: по двум краям привязаны петли и поперечный засов.
  mesh('swift-cage-door-frame', () => {
    const z = d+.006, h = doorTop-doorBottom, middle = (doorTop+doorBottom)/2
    const pieces: THREE.BufferGeometry[] = [wireBox([doorHalf*2,.014,.016],[0,doorBottom,z]),wireBox([doorHalf*2,.014,.016],[0,doorTop,z])]
    for (const side of [-1,1]) pieces.push(wireBox([.014,h,.016],[side*doorHalf,middle,z]))
    for (let i=1;i<9;i++) pieces.push(wireRod(wireRadius,h,[doorHalf*(i/4.5-1),middle,z]))
    return mergeWireGeometry(pieces)
  }, iron)
  mesh('swift-cage-latch', () => mergeWireGeometry([
    wireRod(.008,.093,[doorHalf,.34,d+.019],[0,0,Math.PI/2]),
    wireBox([.013,.025,.02],[doorHalf+.029,.34,d+.011]),
    wireRod(.008,.039,[doorHalf-.036,.351,d+.019]),
    wireRod(.011,.029,[-doorHalf,doorBottom+.05,d+.012]),
    wireRod(.011,.029,[-doorHalf,doorTop-.05,d+.012]),
  ]), bronze)
  const handle = new THREE.CatmullRomCurve3([new THREE.Vector3(-.061,eave+rise,0),new THREE.Vector3(-.045,eave+rise+.064,0),
    new THREE.Vector3(.035,eave+rise+.066,0),new THREE.Vector3(.061,eave+rise,0)])
  mesh('swift-cage-carry-loop', () => new THREE.TubeGeometry(handle,20,.008,8,false), bronze)
  part(resources, parent, 'swift-cage-perch', 'swift-round-perch', () => new THREE.CylinderGeometry(.5,.5,1,12), wood,
    [.022,2*w,.022], [0,.26,-d*.35], [0,0,Math.PI/2])
  const clay = material(resources, 'swift-cups', '#a66c4a', { roughness: .84 })
  const cup = () => new THREE.LatheGeometry([[.01,0],[.035,0],[.047,.049],[.049,.055],[.042,.058],[.034,.049],[.026,.013],[.001,.011]].map(([x,y]) => new THREE.Vector2(x,y)),20)
  for (const [name, x] of [['swift-cage-feed-cup', -w*.64],['swift-cage-water-cup', w*.64]] as const) {
    part(resources,parent,name,'swift-clay-bowl',cup,clay,[1,1,1],[x,foot,d*.5])
  }
  const water = material(resources, 'swift-water', '#779ba1', { metalness: .14, roughness: .22 })
  part(resources,parent,'swift-water-surface','swift-water-surface',() => new THREE.CircleGeometry(.038,20).rotateX(-Math.PI/2),
    water,[1,1,1],[w*.64,foot+.05,d*.5])
  const straw = material(resources,'swift-bedding','#b1945e',{roughness:1})
  mesh('swift-cage-straw', () => {
    const pieces = Array.from({length:18},(_,i) => wireBox([.055+(i%4)*.018,.003,.005],
      [Math.sin(i*13.9)*w*.73,foot+.003+(i%2)*.002,Math.sin(1+i*37.1)*d*.69],[0,i*.85,0]))
    return mergeWireGeometry(pieces)
  },straw)
}

/** Узнаваемая железная клетка для темницы. Без жерди и кормушки, которые
 * принадлежат только клеткам почтовых стрижей в Редстоуновке. */
export function buildIronCage(resources: Resources, parent: THREE.Group, layout: CageLayout, woodColor: string) {
  const width = Math.min(.86, Math.max(.48, layout.width * .84))
  const depth = Math.min(.86, Math.max(.48, layout.depth * .84))
  const metal = material(resources, 'iron-cage-iron', '#565956', { metalness: .48, roughness: .59 })
  const base = material(resources, 'iron-cage-base', woodColor, { roughness: .9 })
  const w = width / 2, d = depth / 2, top = .74
  part(resources, parent, 'iron-cage-floor', 'iron-cage-floor', () => new THREE.BoxGeometry(1, 1, 1),
    base, [width, .045, depth], [0, .023, 0])
  part(resources, parent, 'iron-cage-bar', `iron-cage-bars:${width}:${depth}`, () => {
    const pieces: THREE.BufferGeometry[] = []
    for (let i = 0; i <= 6; i++) {
      const x = w * (i / 3 - 1), z = d * (i / 3 - 1)
      for (const side of [-1, 1]) {
        pieces.push(wireBox([.024, top, .024], [x, top / 2, side * d]))
        if (i > 0 && i < 6) pieces.push(wireBox([.024, top, .024], [side * w, top / 2, z]))
      }
      pieces.push(wireBox([.025, .025, depth], [x, top, 0]))
    }
    for (const y of [.07, .40, top]) for (const side of [-1, 1]) {
      pieces.push(wireBox([width, .034, .034], [0, y, side * d]))
      pieces.push(wireBox([.034, .034, depth], [side * w, y, 0]))
    }
    return mergeWireGeometry(pieces)
  }, metal, [1, 1, 1], [0, 0, 0])
  part(resources, parent, 'iron-cage-latch', 'iron-cage-ring', () => new THREE.TorusGeometry(.043, .008, 8, 20),
    metal, [1, 1, 1], [width / 6, .40, d + .023])
}
