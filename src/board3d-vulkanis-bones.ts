import * as THREE from 'three'
import { finishLandmarkMaterial } from './board3d-landmark-materials'
import { geometry, material, type Resources } from './board3d-prop-resources'

type Point = [number, number, number]
export type FossilPart = 'neck' | 'spine' | 'chest' | 'hips' | 'tail' | 'rib' | 'wing'

/** Одна сетка на фрагмент скелета. Проходы между разрозненными костями
 * заданы авторской картой. Кости внутри каждой клетки сидят прямо на грунте. */
function fossilGeometry(kind: FossilPart) {
  const vertices: number[] = [], indices: number[] = [], colors: number[] = []
  const bone = new THREE.Color('#bbad93'), shadow = new THREE.Color('#7c7362'), color = new THREE.Color()
  const sides = 9
  function limb(points: Point[], radii: number[]) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)))
    const steps = (points.length - 1) * 3
    const frame = curve.computeFrenetFrames(steps, false)
    const first = vertices.length / 3
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, center = curve.getPointAt(t)
      const f = t * (radii.length - 1), k = Math.min(radii.length - 2, Math.floor(f))
      const radius = THREE.MathUtils.lerp(radii[k], radii[k + 1], f - k)
      for (let s = 0; s < sides; s++) {
        const a = s * 2 * Math.PI / sides
        const p = center.clone().addScaledVector(frame.normals[i], Math.cos(a) * radius)
          .addScaledVector(frame.binormals[i], Math.sin(a) * radius * (.9 + .1 * Math.cos(3*a)))
        vertices.push(p.x,p.y,p.z)
        color.copy(shadow).lerp(bone, .57 + .32 * Math.sin(a + .4) + .09 * Math.cos(f * 3 + a))
        colors.push(color.r,color.g,color.b)
      }
    }
    for (let i = 0; i < steps; i++) for (let s = 0; s < sides; s++) {
      const a = first + i * sides + s, b = first + i * sides + (s + 1) % sides
      indices.push(a,b,b+sides, a,b+sides,a+sides)
    }
    for (let s=1; s<sides-1; s++) {
      const end=first+steps*sides
      indices.push(first,first+s+1,first+s,end,end+s,end+s+1)
    }
  }
  function vertebra(x:number, z:number, size:number) {
    const pts = (p:Point[]):Point[]=>p.map(([a,b,c])=>[x+a*size,b*size,z+c*size])
    const tube = (p:Point[],r:number[])=>limb(pts(p),r.map(v=>v*size))
    tube([[-.115,.14,0],[-.09,.14,0],[0,.13,0],[.09,.145,0],[.115,.145,0]],[.098,.135,.088,.13,.1])
    tube([[0,.15,-.10],[-.015,.26,-.105],[-.025,.32,0],[-.012,.26,.105],[0,.15,.10]],[.052,.044,.061,.044,.052])
    tube([[-.016,.31,0],[.01,.415,0],[.06,.48,.012]],[.053,.034,.018])
    for (const side of [-1,1]) tube([[0,.19,side*.07],[.02,.21,side*.17],[.07,.235,side*.23]],[.052,.036,.025])
  }
  if (kind === 'rib') {
    limb([[-.42,.03,-.04],[-.25,.23,.06],[-.02,.32,.11],[.22,.21,.06],[.41,.052,-.06]],[.082,.059,.042,.029,.017])
  } else if (kind === 'wing') {
    limb([[-.38,.08,-.34],[-.16,.14,-.04],[.045,.10,.13]],[.087,.058,.065])
    for (const z of [-.36,-.10,.20,.40]) limb([[.045,.10,.13],[.20,.073,z*.64+.07],[.43,.045,z]],[.045,.027,.012])
  } else {
    const count = kind === 'chest' ? 5 : 4
    for (let i=0;i<count;i++) {
      const t=i/(count-1), s=kind==='tail'? .80-.40*t : kind==='neck' ? .88+.1*t : .93
      vertebra((t-.5)*.78, .026*Math.sin(t*Math.PI*2), s)
    }
    if (kind==='chest') for (const side of [-1,1]) {
      for (let i=0;i<5;i++) {
        const t=i/4, x=-.36+.61*t
        const z=side*(.32+.13*Math.sin((t+.10)*Math.PI)), h=.37+.14*Math.sin(t*Math.PI)
        limb([[x,.23,side*.075],[x+.018,h*.86,side*.20],[x+.04,h,z*.83],
          [x+.08,h*.64,z],[x+.10,.06+.065*((i+side+1)%3),z*.90]],[.048,.037,.029,.024,.011])
      }
    }
    if (kind==='hips') for (const side of [-1,1]) {
      limb([[-.29,.21,side*.09],[-.21,.30,side*.22],[.04,.36,side*.30],[.28,.27,side*.28],[.36,.19,side*.25]],
        [.08,.089,.082,.061,.032])
      limb([[-.19,.27,side*.19],[-.10,.10,side*.26],[.06,.074,side*.34],[.22,.13,side*.32],[.25,.28,side*.28]],
        [.059,.05,.041,.049,.061])
    }
  }
  const g=new THREE.BufferGeometry()
  g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3))
  g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3))
  g.setIndex(indices);g.computeVertexNormals()
  return g
}

export function buildVulkanisBones(owned: Resources, group: THREE.Group, kind:FossilPart, width:number, depth:number) {
  const bone = material(owned,'vulkanis-bone-surface','#ffffff',{vertexColors:true,roughness:.95})
  finishLandmarkMaterial(bone, 'bone')
  const mesh = new THREE.Mesh(geometry(owned,'vulkanis-bones-'+kind,()=>fossilGeometry(kind)), bone)
  mesh.name = 'vulkanis-fossil-'+kind
  mesh.scale.set(width, Math.min(2.85,width,kind==='rib'?2:depth), depth)
  mesh.castShadow = true
  mesh.receiveShadow = true
  group.add(mesh)
}
