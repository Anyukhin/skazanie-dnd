import * as THREE from 'three'
import { material, part, type Resources } from './board3d-prop-resources'

type Point = [number, number, number]

/** Обломок стелы у старого межевого камня. Нижняя часть уходит в грунт,
 * наверху наклонная поверхность излома с острым ребром. */
function fracturedStone() {
  const positions: number[] = [], colors: number[] = []
  const color = new THREE.Color()
  const face = (a: Point, b: Point, c: Point, pigment: string, shade: number) => {
    positions.push(...a, ...b, ...c)
    color.set(pigment).multiplyScalar(shade)
    for (let j = 0; j < 3; j++) colors.push(color.r, color.g, color.b)
  }
  const crown = [1.08, 1.12, 1.15, .95, .905, .835, .85, 1.01]
  const profile = [[-.34,-.12],[-.34,.12],[-.23,.215],[.225,.215],[.31,.135],[.31,-.103],[.212,-.22],[-.225,-.22]]
  const ring = (scale: number, height: number | number[], lean: number): Point[] => profile.map(([x,z],i) =>
    [x*scale-lean, typeof height === 'number' ? height : height[i], z*scale-.12])
  const rings = [ring(1.07,-.06,0),ring(1.06,.14,0),ring(.90,.76,.016),ring(.84,crown,.038)]
  for (let row = 0; row < 3; row++) {
    for (let j = 0; j < 8; j++) {
      const k = (j+1)%8, a = rings[row], b = rings[row+1]
      const gain = .94 + .075*Math.cos(j*1.8)
      face(a[j],a[k],b[k],'#58606a',gain); face(a[j],b[k],b[j],'#58606a',gain+.035)
    }
  }
  for (let j = 0; j < 8; j++) {
    face(rings[3][j], rings[3][(j+1)%8], [-.075,1.018,-.14],'#777d82',.94+.20*Math.sin(j*2))
  }
  // Короткие высечки на широких гранях. Светлая и тёмная стороны реза
  // следуют наклону камня и сходятся на обоих концах.
  for (const side of [-1,1]) for (let i=0;i<3;i++) {
    const point = (x:number,y:number):Point => {
      const t=(y-.14)/.62, width=1.06-.16*t
      return [x-.016*t,y,(side>0?.215:-.22)*width-.12+side*.002]
    }
    const x = -.125+i*.066, y=.445+i*.019
    const a=point(x,y), b=point(x+.014,y+.14-i*.011), m=point(x+.010,y+.062), shadow=point(x+.020,y+.062)
    const lit=point(x+.026,y+.062)
    if (side>0) { face(a,shadow,b,'#303942',1); face(a,lit,shadow,'#a6a098',1) }
    else { face(a,b,shadow,'#303942',1); face(a,shadow,lit,'#a6a098',1) }
    face(a,m,b,'#41484b',1)
  }
  const geo=new THREE.BufferGeometry()
  geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3))
  geo.setAttribute('color',new THREE.Float32BufferAttribute(colors,3))
  geo.computeVertexNormals()
  return geo
}

export function addOldBoundaryStone(resources: Resources, parent: THREE.Group, parentScale: number) {
  const group = new THREE.Group()
  group.name = 'old-boundary-stone'
  group.scale.setScalar(1 / Math.max(.25,parentScale))
  part(resources,group,'boundary-shaft','old-boundary-shaft',fracturedStone,
    material(resources,'old-boundary-basalt','#ffffff',{vertexColors:true,roughness:.84}),[1,1,1],[0,0,0])
  parent.add(group)
  return group
}
