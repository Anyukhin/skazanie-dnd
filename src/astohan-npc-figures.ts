import * as THREE from 'three'
import type { ActorModelInput } from './actor-models'
export type AstohanNpcStyle = 'ares' | 'oren' | 'gedrik' | 'sargat' | 'ivara' | 'mira' | 'lomar' | 'lars' | 'toban' | 'trent'

const clean = (value: unknown) => String(value ?? '').toLocaleLowerCase('ru-RU').normalize('NFKC')
  .replace(/[^\p{L}\p{N}\s-]/gu, ' ').replace(/\s+/gu, ' ').trim()

const names: Readonly<Record<string, AstohanNpcStyle>> = {
  'король арес':'ares','арес':'ares','king ares':'ares','ares':'ares',
  'маршал ивара тейн':'ivara','ивара тейн':'ivara','marshal ivara thain':'ivara',
  'орен фаль':'oren','oren fal':'oren','мира венн':'mira','mira venn':'mira',
  'ломар':'lomar','lomar':'lomar',
  'саргат':'sargat','sargat':'sargat','ларс':'lars','lars':'lars','тобан':'toban','toban':'toban',
  'гедрик сол':'gedrik','gedrik sol':'gedrik','трент':'trent','trent':'trent',
}

export function astohanNpcStyle(input: Pick<ActorModelInput, 'label' | 'archetype'>): AstohanNpcStyle | null {
  return names[clean(input.label).replace(/\s+\d+$/u,'')] ?? null
}

function parentByName(root: THREE.Object3D, names: readonly string[]) {
  let found: THREE.Object3D | undefined
  root.traverse(object => { if (!found && names.includes(object.name)) found = object })
  return found ?? root
}

function mat(color: string, options: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: .82, metalness: .02, ...options })
}

function part(parent: THREE.Object3D, name: string, geometry: THREE.BufferGeometry, material: THREE.Material, position: [number, number, number], rotation: [number, number, number] = [0, 0, 0]) {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'astohan-npc-' + name
  mesh.position.set(...position)
  mesh.rotation.set(...rotation)
  mesh.castShadow = true
  mesh.receiveShadow = true
  mesh.userData.board3dPickable = false
  parent.add(mesh)
  return mesh
}

function cape(root: THREE.Object3D, color: string, orientation: 'glb' | 'procedural', length = .72) {
  // Развёрнутое полотно: ворот у ключиц, плечи шире шеи, подол лежит за бёдрами.
  const points:number[] = [], colors:number[] = [], indices:number[] = []
  const cuts = 36, rows = 7, pigment = new THREE.Color(color)
  const front = orientation === 'glb' ? 1 : -1
  for (let i=0; i<=rows; i++) for(let j=0; j<=cuts; j++) {
    const t=i/rows, u=j/cuts
    const gap=.48+.96*Math.min(1,t*2.3)
    const a=gap+(Math.PI*2-2*gap)*u, fold=Math.cos(12*a+.3*t)
    const drop=Math.min(1,t*3.5)
    const width=.122+.117*drop+.082*t
    const depth=.125+.060*drop+.061*t
    const y=.321-length*t-.042*drop*Math.abs(Math.sin(a))+.012*t*Math.cos(8*a)
    points.push((1+.036*fold)*width*Math.sin(a),y,front*(depth*Math.cos(a)*(1+.055*fold)-.074*t))
    const gain=.81+.17*fold, c= j===0||j===cuts ? new THREE.Color('#ae9063') : pigment
    colors.push(c.r*gain,c.g*gain,c.b*gain)
    if(i<rows && j<cuts){const v=i*(cuts+1)+j;indices.push(v,v+cuts+1,v+1,v+1,v+cuts+1,v+cuts+2)}
  }
  const geo=new THREE.BufferGeometry()
  geo.setAttribute('position',new THREE.Float32BufferAttribute(points,3))
  geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3))
  geo.setIndex(indices);geo.computeVertexNormals()
  return part(parentByName(root,['spine_02','rig-torso']),'cape',geo,mat('#ffffff',{vertexColors:true,side:THREE.DoubleSide}),[0,0,0])
}

function crown(root: THREE.Object3D, orientation: 'glb' | 'procedural') {
  const head=parentByName(root,['Head','head','rig-head']), front=orientation==='glb'?1:-1
  const gold=mat('#c49842',{metalness:.59,roughness:.41}), blue=mat('#245890',{metalness:.31,roughness:.21})
  const pts:number[]=[], ids:number[]=[]
  for(let i=0;i<48;i++){
    const a=i*Math.PI/24, point=i%6===0, corner=i%6===1||i%6===5
    const x=Math.sin(a),z=Math.cos(a)
    pts.push(.118*x,.165,.107*z, (.121+(point?.014:0))*x,.202+(point?.069:corner?.013:0),(.110+(point?.014:0))*z)
    const v=i*2,next=(i+1)%48*2;ids.push(v,next,v+1,v+1,next,next+1)
  }
  const shape=new THREE.BufferGeometry()
  shape.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));shape.setIndex(ids);shape.computeVertexNormals()
  gold.side=THREE.DoubleSide
  part(head,'crown',shape,gold,[0,0,0])
  for(const a of [-.8,0,.8]){
    const gem=part(head,'crown-sapphire',new THREE.OctahedronGeometry(.019),blue,[Math.sin(a)*.12,.197,front*Math.cos(a)*.114])
    gem.scale.set(.83,1.38,.6)
  }
}

function spectacles(root: THREE.Object3D, orientation: 'glb' | 'procedural') {
  const head = parentByName(root, ['Head', 'head', 'rig-head'])
  // Quaternius `Head` already has its origin at the neck/head joint.  The
  // previous normalized-world Y value put the rings several body-heights
  // above the skull after `fitToHeight`; keep the offset local to the bone so
  // animation and the GLB scale both carry the glasses with the face.
  const headY = .105
  const frontZ = orientation === 'glb' ? .120 : -.12
  const glass = mat('#2a2d31', { metalness: .65, roughness: .25 })
  part(head, 'spectacles-left', new THREE.TorusGeometry(.039, .005, 8, 20), glass, [-.045, headY, frontZ])
  part(head, 'spectacles-right', new THREE.TorusGeometry(.039, .005, 8, 20), glass, [.045, headY, frontZ])
  part(head, 'spectacles-bridge', new THREE.BoxGeometry(.035, .009, .008), glass, [0, headY, frontZ])
}

function armorAndSash(root: THREE.Object3D, color: string, sash: string, orientation: 'glb' | 'procedural') {
  const torso = parentByName(root, ['spine_02', 'spine_03', 'rig-torso'])
  const frontZ = orientation === 'glb' ? .20 : -.20
  part(torso, 'npc-sash', new THREE.BoxGeometry(.07, .39, .018), mat(sash, { roughness: .68 }), [.17, -.02, frontZ], [0, 0, -.22])
  const pauldron = part(torso, 'npc-pauldron', new THREE.SphereGeometry(.11, 8, 5), mat(color, { metalness: .28, roughness: .5 }), [-.24, .14, 0], [0, 0, .25])
  pauldron.scale.set(.95, .65, .78)
}

function insignia(root: THREE.Object3D, style: AstohanNpcStyle, orientation: 'glb' | 'procedural') {
  const torso = parentByName(root,['spine_02','rig-torso'])
  const head = parentByName(root,['Head','rig-head'])
  const front = orientation === 'glb' ? 1 : -1
  const brass=mat('#a7844d',{metalness:.54,roughness:.47}), iron=mat('#687476',{metalness:.48})
  const ball=new THREE.SphereGeometry(1,14,10)
  const oval=(p:THREE.Object3D,name:string,m:THREE.Material,at:[number,number,number],size:[number,number,number])=>{
    part(p,name,ball,m,at).scale.set(...size)
  }
  if (style==='ares'||style==='oren') {
    const silver=mat(style==='ares'?'#bdb6a4':'#948c81')
    // Седые виски и клин бороды обрамляют исходное анимированное лицо.
    for(const side of [-1,1]) oval(head,'sideburn',silver,[side*.077,.077,front*.061],[.023,.060,.030])
    const beard=part(head,'beard',new THREE.ConeGeometry(.065,style==='oren'?.117:.075,12),silver,[0,-.004,front*.085],[Math.PI,0,0])
    beard.scale.z=.58
  }
  if (style==='ares') {
    const ermine=mat('#c5bcaa')
    for(let i=0;i<15;i++){
      const a=i*Math.PI/14
      oval(torso,'mantle-ermine',ermine,[.202*Math.cos(a),.253,-front*.126*Math.sin(a)],[.051,.047,.053])
    }
    oval(torso,'royal-breastplate',iron,[0,.126,front*.067],[.177,.179,.12])
    oval(torso,'royal-clasp',brass,[.116,.241,front*.112],[.036,.029,.012])
  }
  if (style==='ivara'||style==='gedrik') {
    oval(torso,'steel-cuirass',iron,[0,.104,front*.058],[.188,.19,.119])
    for(let i=0;i<3;i++){
      const plate=ovalPlate(.174-i*.008,.059)
      part(torso,'fauld',plate,iron,[0,-.023-i*.042,front*.025])
    }
  }
  if(style==='oren') {
    for(let i=0;i<3;i++){
      const x=.152+.024*i
      part(torso,'archive-key-bow',new THREE.TorusGeometry(.015,.0035,6,12),brass,[x,-.191,front*.119])
      part(torso,'archive-key',new THREE.BoxGeometry(.007,.049,.008),brass,[x,-.228,front*.119])
      part(torso,'archive-key-bit',new THREE.BoxGeometry(.018,.008,.008),brass,[x+.007,-.247,front*.119])
    }
  }
  if(style==='mira') {
    const wood=mat('#714a33')
    const path=new THREE.CatmullRomCurve3([new THREE.Vector3(-.25,-.27,-front*.17),new THREE.Vector3(-.15,-.06,-front*.225),new THREE.Vector3(.07,.22,-front*.22),new THREE.Vector3(.275,.45,-front*.15)])
    part(torso,'riding-bow',new THREE.TubeGeometry(path,24,.015,7,false),wood,[0,0,0])
    part(torso,'bowstring',new THREE.TubeGeometry(new THREE.LineCurve3(path.points[0],path.points[3]),1,.003,5,false),brass,[0,0,0])
  }
  if(style==='toban') {
    const linen=mat('#c6b89d',{side:THREE.DoubleSide})
    const s=new THREE.Shape();s.moveTo(-.10,.14);s.lineTo(.10,.14);s.lineTo(.155,-.10);s.lineTo(.164,-.44);s.lineTo(-.163,-.43);s.lineTo(-.16,-.10);s.closePath()
    part(torso,'miller-apron',new THREE.ExtrudeGeometry(s,{depth:.009,bevelEnabled:false}),linen,[0,-.023,front*.16])
    oval(head,'miller-cap',linen,[0,.173,0],[.122,.066,.111])
  }
  if(style==='lars') {
    part(head,'ferryman-earring',new THREE.TorusGeometry(.018,.005,7,15),brass,[.103,.073,.022])
    const hemp=mat('#a58a60')
    for(let i=0;i<3;i++)part(torso,'mooring-rope',new THREE.TorusGeometry(.068,.008,6,22),hemp,[.156,-.21-i*.010,front*.068],[0,.46,0]).scale.y=1.43
  }
}

function ovalPlate(width:number,height:number){
  const g=new THREE.SphereGeometry(1,16,7,0,Math.PI*2,.25*Math.PI,.48*Math.PI)
  return g.scale(width,height,.133)
}

function applyStyle(root: THREE.Object3D, style: AstohanNpcStyle, orientation: 'glb' | 'procedural') {
  insignia(root,style,orientation)
  switch (style) {
    case 'ares': crown(root, orientation); cape(root, '#334866', orientation, .74); armorAndSash(root, '#a78b4b', '#d9e1e8', orientation); break
    case 'ivara': cape(root,'#344b65',orientation,.64); armorAndSash(root, '#596777', '#31588e', orientation); break
    case 'oren': spectacles(root, orientation); cape(root, '#30323d', orientation, .62); break
    case 'mira': cape(root, '#3f664e', orientation, .64); break
    case 'lomar': cape(root, '#214b57', orientation, .70); break
    // Саргат уже получает полноценную драконью модель. Дополнительная чешуя
    // поверх нормализованного дракона только пересекалась бы с его шеей.
    case 'sargat': break
    case 'lars': cape(root, '#2d5c6d', orientation, .52); break
    case 'toban': cape(root, '#8b714b', orientation, .42); break
    case 'gedrik': armorAndSash(root, '#5c6462', '#8b693c', orientation); break
    case 'trent': {
      const bark = mat('#4b3827', { roughness: .98 })
      const resin = mat('#d7a43b', { roughness: .35, emissive: '#5a3711', emissiveIntensity: .18 })
      const torso = parentByName(root, ['trunk', 'torso', 'rig-torso'])
      // `elder-tree` is a single unrigged bust.  Its face sits around y=1.7,
      // z=.45; using humanoid bone offsets there put the guard plates at the
      // floor and hid the resin eyes inside the trunk.  Keep the humanoid path
      // bone-local, but place the bust's bark shields in its authored frame.
      const bust = torso === root
      const shieldY = bust ? 1.30 : .16
      const shieldZ = bust ? .30 : -.08
      const shieldX = bust ? .43 : .22
      part(torso, 'oak-bark-shield-left', new THREE.BoxGeometry(.12, .45, .07), bark, [-shieldX, shieldY, shieldZ], [0, 0, -.18])
      part(torso, 'oak-bark-shield-right', new THREE.BoxGeometry(.12, .45, .07), bark, [shieldX, shieldY, shieldZ], [0, 0, .18])
      const head = parentByName(root, ['Head', 'head', 'rig-head'])
      const eyeY = bust ? 1.73 : .04
      const eyeZ = bust ? .54 : -.12
      const eyeX = bust ? .18 : .07
      part(head, 'resin-eye-left', new THREE.SphereGeometry(.026, 7, 5), resin, [-eyeX, eyeY, eyeZ])
      part(head, 'resin-eye-right', new THREE.SphereGeometry(.026, 7, 5), resin, [eyeX, eyeY, eyeZ])
      break
    }
  }
}

/** Ивара и Мира открыто описаны как женщины. Их базовая модель выбирается
 * по имени/роли, пока ручной modelKey не отменил автоматический выбор. */
export function astohanNpcModelKey(input: Pick<ActorModelInput, 'kind' | 'label' | 'archetype'>): string | null {
  if (input.kind === 'enemy' && astohanNpcStyle(input) === 'sargat') return 'dragon'
  if (input.kind !== 'neutral') return null
  const style = astohanNpcStyle(input)
  return style === 'ivara' || style === 'mira' ? 'hero-female' : null
}

export function applyAstohanNpcFigure(root: THREE.Object3D, input: Pick<ActorModelInput, 'label' | 'archetype' | 'kind'>, orientation: 'glb' | 'procedural' = 'procedural'): AstohanNpcStyle | null {
  if (input.kind !== 'neutral' && input.kind !== 'enemy') return null
  const style = astohanNpcStyle(input)
  if (!style) return null
  applyStyle(root, style, orientation)
  root.userData.astohanNpcStyle = style
  return style
}
