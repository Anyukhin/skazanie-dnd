import * as THREE from 'three'
import { finishLandmarkMaterial } from './board3d-landmark-materials'
import { material, part, type Resources } from './board3d-prop-resources'

function addFlask(owned: Resources, parent: THREE.Group, name: string, x: number, z: number, scale: number, color: string, surfaceY: number) {
  const glass = material(owned, 'lomar-glass', '#c4d9d3', { transparent: true, opacity: .36, depthWrite: false, roughness: .14 })
  const liquid = material(owned, 'lomar-liquid-' + color, color, { roughness: .29 })
  const copper = material(owned, 'lomar-copper', '#a96638', { metalness: .62, roughness: .32 })
  const turned = (profile: number[][]) => new THREE.LatheGeometry(profile.map(([r,y]) => new THREE.Vector2(r,y)), 18)
  const size: [number,number,number] = [scale,scale,scale]
  part(owned, parent, name + '-glass', 'lomar-flask-glass', () => turned([
    [.006,0],[.09,.008],[.14,.07],[.14,.13],[.12,.18],[.064,.23],[.039,.28],[.039,.38],[.05,.39],[.05,.417],[.036,.419]
  ]), glass, size, [x,surfaceY,z], undefined,false)
  part(owned, parent, name + '-liquid', 'lomar-flask-content', () => turned([
    [0,.015],[.084,.018],[.130,.073],[.130,.132],[.125,.152],[0,.151]
  ]), liquid, size, [x,surfaceY,z], undefined,false)
  part(owned, parent, name + '-copper-band','lomar-flask-band',() => new THREE.TorusGeometry(.043,.008,6,16),
    copper, size, [x,surfaceY+scale*.337,z],[Math.PI/2,0,0],false)
  if (name !== 'flask-amber') {
    const cork = material(owned,'lomar-stopper','#815537',{roughness:.98})
    part(owned,parent,'cork-stopper','lomar-cork',()=>new THREE.CylinderGeometry(.045,.035,.05,10),
      cork,size,[x,surfaceY+scale*.43,z],undefined,false)
  }
}

export function buildLomarBench(owned: Resources, group: THREE.Group, width: number, depth: number) {
  const w = THREE.MathUtils.clamp(width * .78, 1.25, 2.35)
  const d = THREE.MathUtils.clamp(depth * .7, .7, 1.05)
  const top = THREE.MathUtils.clamp(Math.min(width, depth) * .34, .52, .62)
  const wood = material(owned, 'lomar-bench-walnut', '#674331', { roughness: .72 })
  finishLandmarkMaterial(wood, 'wood')
  const edge = material(owned, 'lomar-bench-edge', '#9a6842', { roughness: .68 })
  const dark = material(owned, 'lomar-bench-dark', '#34251d', { roughness: .82 })
  const copper = material(owned, 'lomar-copper', '#a96638', { metalness: .62, roughness: .32 })
  const iron = material(owned, 'lomar-iron', '#34383a', { metalness: .48, roughness: .5 })
  const parchment = material(owned, 'lomar-parchment', '#d4b878', { roughness: 1 })
  const flame = material(owned, 'lomar-burner-flame', '#e98336', { emissive: '#aa3d1c', emissiveIntensity: .35, roughness: .5 })
  const detail = new THREE.Group()
  detail.name = 'lomar-alchemy-bench-detail'
  detail.userData.board3dPickable = false
  detail.userData.surfaceHeight = top
  group.userData.surfaceHeight = top
  group.add(detail)

  part(owned, detail, 'workbench-top', 'lomar-workbench-top', () => new THREE.BoxGeometry(1, 1, 1), wood, [w, .11, d], [0, top - .055, 0])
  for (const z of [-d * .22, d * .08, d * .36]) {
    part(owned, detail, 'workbench-plank-seam', 'lomar-workbench-seam', () => new THREE.BoxGeometry(1, 1, 1), dark, [w * .9, .006, .009], [0, top + .004, z], undefined, false)
  }
  const legHeight = top - .11
  for (const x of [-w * .42, w * .42]) for (const z of [-d * .38, d * .38]) {
    part(owned, detail, 'workbench-leg', 'lomar-workbench-leg', () => new THREE.BoxGeometry(1, 1, 1), dark, [.11, legHeight, .11], [x, legHeight / 2, z])
  }
  part(owned, detail, 'workbench-lower-shelf', 'lomar-workbench-shelf', () => new THREE.BoxGeometry(1, 1, 1), wood, [w * .68, .055, d * .58], [0, .15, 0])
  for (const z of [-d * .38, d * .38]) part(owned, detail, 'workbench-lower-brace', 'lomar-workbench-brace', () => new THREE.BoxGeometry(1, 1, 1), dark, [w * .82, .07, .07], [0, .24, z])
  part(owned, detail, 'workbench-front-edge', 'lomar-bench-front-edge', () => new THREE.BoxGeometry(1, 1, 1), iron, [w, .035, .035], [0, top - .018, d * .49])
  part(owned, detail, 'workbench-back-edge', 'lomar-bench-back-edge', () => new THREE.BoxGeometry(1, 1, 1), iron, [w * .8, .035, .035], [0, top - .018, -d * .49])
  for (const x of [-w * .26, w * .26]) {
    part(owned, detail, 'workbench-drawer', 'lomar-workbench-drawer', () => new THREE.BoxGeometry(1, 1, 1), dark, [w * .28, .13, .035], [x, .39, d * .51])
    part(owned, detail, 'workbench-drawer-handle', 'lomar-workbench-drawer-handle', () => new THREE.TorusGeometry(.025, .007, 5, 8), copper, [1, 1, 1], [x, .39, d * .54], [Math.PI / 2, 0, 0], false)
  }
  part(owned, detail, 'bench-back-rail', 'lomar-bench-back-rail', () => new THREE.BoxGeometry(1, 1, 1), dark, [w * .78, .055, .055], [0, top + .055, -d * .40])
  for (const x of [-w * .39, w * .39]) part(owned, detail, 'bench-copper-corner', 'lomar-bench-corner', () => new THREE.BoxGeometry(1, 1, 1), copper, [.055, .04, .055], [x, top + .028, d * .40], [0, 0, .16], false)

  part(owned, detail, 'tool-rack-post-left', 'lomar-tool-rack-post', () => new THREE.CylinderGeometry(.018, .024, .27, 8), iron, [1, 1, 1], [-w * .31, top + .15, -d * .39])
  part(owned, detail, 'tool-rack-post-right', 'lomar-tool-rack-post', () => new THREE.CylinderGeometry(.018, .024, .27, 8), iron, [1, 1, 1], [-w * .06, top + .15, -d * .39])
  part(owned, detail, 'tool-rack-bar', 'lomar-tool-rack-bar', () => new THREE.CylinderGeometry(.018, .018, 1, 8), copper, [1, w*.29, 1], [-w * .185, top + .27, -d * .39], [0, 0, Math.PI / 2])
  part(owned, detail, 'tool-tongs-left', 'lomar-tool-tongs-left', () => new THREE.CylinderGeometry(.012, .016, .43, 8), iron, [1, 1, 1], [-w * .21, top + .035, -d * .28], [0, 0, Math.PI / 2 - .10], false)
  part(owned, detail, 'tool-tongs-right', 'lomar-tool-tongs-right', () => new THREE.CylinderGeometry(.012, .016, .43, 8), iron, [1, 1, 1], [-w * .21, top + .045, -d * .28], [0, 0, Math.PI / 2 + .10], false)

  const burnerX = w * .25
  part(owned, detail, 'burner-ring', 'lomar-burner-ring', () => new THREE.TorusGeometry(.11, .026, 7, 14), copper, [1, 1, 1], [burnerX, top + .055, .03], [Math.PI / 2, 0, 0])
  part(owned, detail, 'burner-foot', 'lomar-burner-foot', () => new THREE.CylinderGeometry(.08, .12, .065, 10), iron, [1, 1, 1], [burnerX, top + .035, .03])
  part(owned, detail, 'burner-flame', 'lomar-burner-flame', () => new THREE.ConeGeometry(.055, .13, 8), flame, [1, 1, 1], [burnerX, top + .16, .03], undefined, false)
  part(owned, detail, 'crucible', 'lomar-crucible', () => new THREE.CylinderGeometry(.11, .085, .10, 10), iron, [1, 1, 1], [burnerX, top + .115, .03])
  part(owned, detail, 'crucible-rim', 'lomar-crucible-rim', () => new THREE.TorusGeometry(.10, .016, 6, 12), copper, [1, 1, 1], [burnerX, top + .17, .03], [Math.PI / 2, 0, 0])

  // Шлем перегонного сосуда сужается к пароотводу. Его конец входит
  // в горлышко янтарной колбы рядом с горелкой.
  part(owned, detail, 'alembic-head', 'lomar-alembic-head', () => new THREE.LatheGeometry(
    [[.108,0],[.126,.026],[.126,.080],[.111,.132],[.072,.166],[.044,.198],[.026,.223]]
      .map(([r,y]) => new THREE.Vector2(r,y)), 22),
    copper, [1,1,1], [burnerX,top+.166,.03])
  const receiverX=w*.075, receiverZ=.13
  const pipe = new THREE.CatmullRomCurve3([
    new THREE.Vector3(burnerX,top+.38,.03), new THREE.Vector3(burnerX-.035,top+.48,.03),
    new THREE.Vector3(receiverX+.06,top+.46,receiverZ), new THREE.Vector3(receiverX,top+.38,receiverZ),
    new THREE.Vector3(receiverX,top+.25,receiverZ),
  ])
  part(owned, detail, 'copper-spout','lomar-spout-'+w,() => new THREE.TubeGeometry(pipe,20,.017,9,false),
    copper,[1,1,1],[0,0,0])
  addFlask(owned, detail, 'flask-red', -w * .27, .10, .86, '#963820', top)
  addFlask(owned, detail, 'flask-blue', -w * .08, .18, .70, '#24737f', top)
  addFlask(owned, detail, 'flask-amber', receiverX, receiverZ, .67, '#a46b23', top)
  part(owned, detail, 'parchment', 'lomar-ward-notes', () => new THREE.BoxGeometry(1, 1, 1), parchment, [.35, .012, .24], [w * .28, top + .026, -.20], [0, .12, -.06], false)
  part(owned, detail, 'parchment-weight', 'lomar-ward-weight', () => new THREE.CylinderGeometry(.042, .05, .045, 8), copper, [1, 1, 1], [w * .39, top + .055, -.20], undefined, false)
  part(owned, detail, 'stirring-rod', 'lomar-stirring-rod', () => new THREE.CylinderGeometry(.013, .013, .45, 8), iron, [1, 1, 1], [w * .20, top + .045, -.24], [0, 0, Math.PI / 2 + .12], false)
  detail.traverse(object => { object.userData.board3dPickable = false })
  return detail
}
