import * as THREE from 'three'
import { finishLandmarkMaterial } from './board3d-landmark-materials'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { material, part, type Resources } from './board3d-prop-resources'

type Section = [number, number, number, number]

/** Поперечники следуют оси кости. Просветы в носу и глазницах образованы
 * соединениями дуг, поэтому сквозь них видна дальняя сторона черепа. */
function strut(sections: Section[], flatten = 1) {
  const curve = new THREE.CatmullRomCurve3(sections.map(([x,y,z]) => new THREE.Vector3(x,y,z)))
  const steps = (sections.length - 1) * 4
  const frames = curve.computeFrenetFrames(steps, false)
  const points: number[] = [], colors: number[] = [], faces: number[] = []
  const sides = 10
  for (let i=0; i<=steps; i++) {
    const t=i/steps, at=curve.getPointAt(t), u=curve.getUtoTmapping(t, 0) * (sections.length-1)
    const k=Math.min(sections.length-2, Math.floor(u))
    const radius=THREE.MathUtils.lerp(sections[k][3],sections[k+1][3],u-k)
    for (let j=0; j<sides; j++) {
      const a=j*2*Math.PI/sides, irregular=1+.045*Math.sin(a*3+i*.43)
      const p=at.clone().addScaledVector(frames.normals[i],radius*Math.cos(a)*irregular)
        .addScaledVector(frames.binormals[i],radius*Math.sin(a)*flatten)
      points.push(p.x,p.y,p.z)
      const shade=.91+.08*Math.cos(3*a+i*.31)
      colors.push(shade,shade*.98,shade*.94)
      if (i<steps) {
        const v=i*sides+j, w=i*sides+(j+1)%sides
        faces.push(v,w,w+sides,v,w+sides,v+sides)
      }
    }
  }
  const end=steps*sides
  for (let j=1;j<sides-1;j++) faces.push(0,j+1,j,end,end+j,end+j+1)
  const g=new THREE.BufferGeometry()
  g.setAttribute('position',new THREE.Float32BufferAttribute(points,3))
  g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3))
  g.setIndex(faces);g.computeVertexNormals()
  return g
}

function join(parts: THREE.BufferGeometry[]) {
  const merged=mergeGeometries(parts, false)!
  for(const g of parts) g.dispose()
  return merged
}

/** Клин крыши черепа; края свода заходят в надглазничные дуги. */
function vault() {
  const pts:number[]=[], cols:number[]=[], idx:number[]=[]
  const rows=[[-1.31,.56,.105,.06],[-1.12,.64,.16,.075],[-.92,.70,.19,.09],[-.67,.77,.24,.11],
    [-.46,.83,.27,.12],[-.23,.94,.31,.14],[.02,1.00,.375,.14],[.30,.98,.41,.14],[.55,.87,.37,.18],[.78,.72,.24,.15],[.87,.63,.13,.08]]
  for (let i=0;i<rows.length;i++) {
    const [x,y,w,rise]=rows[i]
    for (let j=0;j<=8;j++) {
      const u=j/4-1
      pts.push(x+.025*Math.abs(u),y+rise*(1-u*u),u*w)
      const shade=.83+.12*(1-Math.abs(u))+.055*Math.sin(i*1.8+j*.7)
      cols.push(shade,shade*.98,shade*.91)
      const nasalOpening = i >= 1 && i <= 3 && (j === 2 || j === 5)
      if (i<rows.length-1 && j<8 && !nasalOpening) {const a=i*9+j;idx.push(a,a+1,a+10,a,a+10,a+9)}
    }
  }
  const g=new THREE.BufferGeometry()
  g.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));g.setAttribute('color',new THREE.Float32BufferAttribute(cols,3))
  g.setIndex(idx);g.computeVertexNormals()
  return g
}

export function buildVulkanisSkull(owned: Resources, group: THREE.Group, width: number, depth: number) {
  const skull=new THREE.Group()
  skull.name='vulkanis-dragon-skull'
  skull.scale.setScalar(Math.min(1,width/2.86,depth/1.6))
  const bone=material(owned,'vulkanis-skull-bone','#c7b99d',{vertexColors:true,roughness:.90})
  const horn=material(owned,'vulkanis-horn-core','#9b8a70',{vertexColors:true,roughness:.91})
  finishLandmarkMaterial(bone, 'bone')
  finishLandmarkMaterial(horn, 'bone')
  const ivory=material(owned,'vulkanis-teeth','#e3cf9e',{vertexColors:true,roughness:.67})
  const make=(name:string,key:string,fn:()=>THREE.BufferGeometry,mat:THREE.Material,side=1) =>
    part(owned,skull,name,'vulkanis:'+key,fn,mat,[1,1,side],[0,-.025,0])
  make('skull-vault','vault',vault,bone)
  for (const side of [-1,1]) {
    make('skull-side-plate','side',()=>join([
      // Зубная дуга и предглазничная перемычка обрамляют длинную носовую полость.
      strut([[-1.32,.54,.10,.09],[-1.11,.505,.16,.12],[-.79,.485,.22,.115],[-.48,.49,.285,.135],[-.22,.53,.34,.10],[.15,.59,.43,.065],[.40,.64,.46,.09]],.82),
      strut([[-.67,.51,.255,.075],[-.56,.66,.27,.066],[-.45,.835,.28,.10]],.82),
      // Глазница шире носового отверстия; за ней — скуловая дуга и сустав.
      strut([[-.22,.54,.34,.10],[-.31,.70,.32,.08],[-.25,.90,.33,.10],[-.06,1.01,.38,.12],[.20,1.005,.41,.11],[.39,.89,.44,.115],[.405,.68,.47,.10],[.24,.59,.45,.062]],.85),
      strut([[.38,.67,.46,.088],[.60,.62,.45,.09],[.78,.45,.38,.14],[.79,.30,.34,.135]],.83),
      strut([[.24,.98,.37,.13],[.56,.89,.32,.16],[.80,.66,.27,.15],[.77,.46,.32,.14]],.95),
      strut([[.44,.70,.45,.09],[.59,.73,.54,.075],[.79,.78,.64,.032],[.88,.81,.67,.008]],.8),
      strut([[-.58,.82,.20,.045],[-.26,.96,.29,.038],[.08,1.04,.32,.068],[.35,1.02,.35,.07]],.70),
    ]),bone,side)
    make('skull-jaw-branch','jaw',()=>strut([[-1.25,.13,.09,.072],[-1.04,.105,.145,.076],[-.66,.105,.20,.085],[-.22,.125,.265,.10],[.18,.16,.34,.12],[.51,.215,.38,.135],[.74,.33,.35,.14]],.9),bone,side)
    make('skull-nasal','nasal',()=>strut([[-1.33,.535,.09,.08],[-1.22,.65,.12,.06],[-.95,.72,.18,.052],[-.68,.79,.23,.065],[-.43,.85,.275,.10]]),bone,side)
    const broken=side<0
    make(broken?'skull-broken-horn':'skull-horn',broken?'horn-stump':'horn',()=>broken
      ?strut([[.37,.94,.35,.14],[.54,1.07,.46,.13],[.76,1.16,.51,.092]])
      :strut([[.37,.94,.35,.14],[.57,1.09,.48,.133],[.88,1.24,.57,.095],[1.15,1.26,.63,.048],[1.39,1.17,.66,.006]]),horn,side)
    make('skull-teeth','dentition',()=> {
      const teeth:THREE.BufferGeometry[]=[]
      for(let i=0;i<8;i++) {
        const x=-1.205+i*.135,z=.144+i*.022, y=.49-.026*Math.sin(i*.52)
        const fang=i===1||i===5, length=fang?.255:.145+i%3*.012
        teeth.push(strut([[x,y,z,.053],[x+.004,y-length*.45,z+.007,.034],[x+.048,y-length,z-.005,.003]]))
        if(i%2===0) teeth.push(strut([[x+.062,.147,z*.88,.031],[x+.066,.22,z*.88,.022],[x+.090,.263,z*.88,.003]]))
      }
      return join(teeth)
    },ivory,side)
  }
  make('skull-chin','chin',()=>strut([[-1.21,.125,-.095,.076],[-1.28,.131,0,.073],[-1.21,.126,.095,.076]]),bone)
  skull.rotation.y=.36
  group.add(skull)
  return skull
}
