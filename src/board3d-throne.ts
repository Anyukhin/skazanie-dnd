import * as THREE from 'three'
import { material, part, type Resources } from './board3d-prop-resources'

/** Резьба на спинке замкового трона. Ноль по высоте — верх прежней спинки,
 * лицевая сторона обращена в +Z, как у сиденья. */
export function addCastleThroneBack(owned: Resources, chair: THREE.Group, width: number, top: number, backZ: number) {
  const back = new THREE.Group()
  back.name = 'castle-throne-back'
  back.position.set(0, top, backZ)
  back.scale.setScalar(width)
  chair.add(back)

  const walnut = material(owned, 'throne-walnut', '#5c3827', { roughness: .63 })
  const honey = material(owned, 'throne-carved-edge', '#94643d', { roughness: .64 })
  const bronze = material(owned, 'throne-inlay', '#b3864d', { roughness: .52, metalness: .35 })
  const size: [number, number, number] = [1, 1, 1]
  part(owned, back, 'pierced-back', 'castle-throne-tracery', () => {
    const face = new THREE.Shape()
    face.moveTo(-.445, -.19)
    face.lineTo(-.445, .48)
    face.bezierCurveTo(-.33,.48,-.31,.65,-.26,.69)
    face.bezierCurveTo(-.15,.74,-.065,.82,0,.94)
    face.bezierCurveTo(.065,.82,.15,.74,.26,.69)
    face.bezierCurveTo(.31,.65,.33,.48,.445,.48)
    face.lineTo(.445, -.19)
    face.closePath()
    // Стрельчатые просветы выпилены насквозь, в центре остаётся средник.
    for (const x of [-.199, .199]) {
      const opening = new THREE.Path()
      opening.moveTo(x - .108, .015)
      opening.lineTo(x - .108, .255)
      opening.quadraticCurveTo(x - .108,.355,x,.445)
      opening.quadraticCurveTo(x + .108,.355,x + .108,.255)
      opening.lineTo(x + .108, .015)
      opening.closePath()
      face.holes.push(opening)
    }
    const quatrefoil = new THREE.Path()
    for (let i = 0; i <= 64; i++) {
      const angle = 2 * Math.PI * i / 64
      const radius = .101 + .036 * Math.cos(4 * angle)
      const x = radius * Math.cos(angle), y = .60 + radius * Math.sin(angle)
      if (i === 0) quatrefoil.moveTo(x, y)
      else quatrefoil.lineTo(x, y)
    }
    face.holes.push(quatrefoil)
    return new THREE.ExtrudeGeometry(face, { depth: .075, bevelEnabled: true, bevelThickness: .014, bevelSize: .014, bevelSegments: 2, curveSegments: 8 })
  }, walnut, size, [0, 0, -.045])

  // Два точёных навершия продолжают стойки по бокам; валик спереди
  // обрамляет стрельчатые прорези и ловит свет от жаровен.
  for (const side of [-1, 1]) {
    part(owned, back, 'carved-finial', 'castle-throne-finial', () => {
      const profile = [[.050,-.53],[.053,-.13],[.066,-.11],[.047,-.075],[.047,.40],[.065,.426],[.067,.45],[.044,.476],[.038,.515],[.067,.57],[.052,.61],[.018,.65],[0,.712]]
      return new THREE.LatheGeometry(profile.map(([r,y]) => new THREE.Vector2(r,y)), 12)
    }, honey, size, [side * .402, 0, .008])
    const moulding = part(owned, back, 'carved-ogee', 'castle-throne-ogee', () => {
      const points = [[.39,.48],[.322,.53],[.26,.645],[.17,.722],[.085,.795],[.013,.887]]
      const curve = new THREE.CatmullRomCurve3(points.map(([x,y]) => new THREE.Vector3(x,y,0)))
      return new THREE.TubeGeometry(curve, 18, .019, 7, false)
    }, honey, size, [0,0,.043])
    moulding.scale.x = side
    // Плоский резец оставляет сужающийся лист на старой деревянной филёнке.
    const leaf = part(owned, back, 'carved-leaf', 'castle-throne-leaf', () => {
      const s = new THREE.Shape()
      s.moveTo(.045,-.76)
      s.bezierCurveTo(.20,-.66,.22,-.55,.28,-.47)
      s.quadraticCurveTo(.235,-.49,.215,-.53)
      s.quadraticCurveTo(.235,-.425,.306,-.37)
      s.bezierCurveTo(.25,-.38,.168,-.43,.152,-.535)
      s.quadraticCurveTo(.12,-.48,.10,-.48)
      s.quadraticCurveTo(.16,-.63,.045,-.76)
      return new THREE.ExtrudeGeometry(s, { depth:.012, bevelEnabled:true, bevelThickness:.009, bevelSize:.005, bevelSegments:2, curveSegments:6 })
    }, honey, size, [0,0,.084])
    leaf.scale.x = side
  }
  part(owned, back, 'carved-transom', 'castle-throne-transom', () => new THREE.BoxGeometry(.86,.046,.105), honey, size, [0,-.044,.024])
  // Четыре грани у каждой лучевой насечки по-разному отражают свет.
  part(owned, back, 'compass-inlay', 'castle-throne-star', () => {
    const xyz: number[] = []
    for (let i = 0; i < 16; i++) {
      const rim = (k: number) => {
        const a = k * Math.PI / 8
        const r = k % 2 ? .055 : k % 4 ? .117 : .18
        return [r * Math.cos(a), r * Math.sin(a) * 1.15, 0]
      }
      xyz.push(0,0,.041,...rim(i),...rim(i+1))
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(xyz, 3))
    geometry.computeVertexNormals()
    return geometry
  }, bronze, size, [0,-.30,.073])
}
