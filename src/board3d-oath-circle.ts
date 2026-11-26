import * as THREE from 'three'
import { geometry, material, type Resources } from './board3d-prop-resources'

// Низкая вымостка круга клятв. Два ряда камней перевязаны; сколы, осадка
// плит и светлые высечки повторяются при повторном входе в ту же сцену.
function paving() {
  const positions: number[] = [], colors: number[] = []
  const color = new THREE.Color()
  let seed = 23451
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  type Point = [number, number, number]
  const polar = (r: number, a: number, y: number): Point => [r * Math.cos(a), y, -r * Math.sin(a)]
  function face(a: Point, b: Point, c: Point, light: number) {
    positions.push(...a, ...b, ...c)
    for (let i = 0; i < 3; i++) colors.push(color.r * light, color.g * light, color.b * light)
  }
  function stone(count: number, inner: number, outer: number, offset: number, incised: boolean) {
    const turn = 2 * Math.PI / count
    for (let i = 0; i < count; i++) {
      const a = (i + offset) * turn + .007, b = a + turn - .016
      const middle = (a+b)/2, top = .053 + random() * .033
      const r = outer - random() * .04
      const outline: Point[] = [
        polar(inner, a+.013, top), polar(r-.045,a,top), polar(r,a+.034,top),
        polar(r+.009,middle,top), polar(r-.012,b-.025,top), polar(r-.05,b,top), polar(inner,b-.006,top),
      ]
      const cx = outline.reduce((sum,p) => sum+p[0],0)/outline.length
      const cz = outline.reduce((sum,p) => sum+p[2],0)/outline.length
      const rim = outline.map(([x,y,z]):Point=>[cx+(x-cx)*.90, y, cz+(z-cz)*.90])
      color.setHSL(.085 + random()*.055,.035 + random()*.06,.36 + random()*.12, THREE.SRGBColorSpace)
      for (let j=0;j<rim.length;j++) {
        const k=(j+1)%rim.length
        const p=outline[j], q=outline[k]
        const u:Point=[p[0],top-.026,p[2]], v:Point=[q[0],top-.026,q[2]]
        const lowU:Point=[u[0],-.035,u[2]], lowV:Point=[v[0],-.035,v[2]]
        face([cx,top+.003,cz],rim[j],rim[k],.97 + random()*.05)
        face(rim[j],u,v,1.13); face(rim[j],v,rim[k],1.12)
        face(u,lowU,lowV,.73); face(u,lowV,v,.77)
      }
      if (!incised || i % 7 === 3) continue
      // Неглубокие расходящиеся насечки с тёмным желобком и светлой гранью.
      const mark=(r0:number, a0:number, r1:number, a1:number) => {
        const p=polar(r0,a0,top+.005), q=polar(r1,a1,top+.005)
        const dx=q[0]-p[0], dz=q[2]-p[2], len=Math.hypot(dx,dz)
        const nx=-dz/len, nz=dx/len
        const side=(point:Point,w:number):Point=>[point[0]+w*nx,point[1],point[2]+w*nz]
        color.set('#30302b'); face(side(p,.010),side(q,.007),side(q,-.007),1); face(side(p,.010),side(q,-.007),side(p,-.010),1)
        color.set('#a79e7f'); face(side(p,-.010),side(q,-.007),side(q,-.012),1); face(side(p,-.010),side(q,-.012),side(p,-.016),1)
      }
      mark(inner+.036,middle,outer-.097,middle+.013)
      mark(inner+.10,middle,outer-.13,middle+.067)
      if (i%3) mark(inner+.13,middle,outer-.098,middle-.067)
    }
  }
  stone(17,.67,1,.15,true)
  stone(12,.47,.646,.62,false)
  stone(7,.13,.445,0,false)
  const result = new THREE.BufferGeometry()
  result.setAttribute('position', new THREE.Float32BufferAttribute(positions,3))
  result.setAttribute('color', new THREE.Float32BufferAttribute(colors,3))
  result.computeVertexNormals()
  return result
}

export function buildOathCircle(owned: Resources, group: THREE.Group, width: number, depth: number) {
  const stone = material(owned, 'oath-circle-stone', '#ffffff', { vertexColors:true, roughness:.97 })
  stone.onBeforeCompile = shader => {
    shader.vertexShader = 'varying vec3 vStonePoint;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vStonePoint = position;')
    shader.fragmentShader = `varying vec3 vStonePoint;
      float grainHash(vec2 p) {
        vec3 q = fract(vec3(p.xyx) * .1031);
        q += dot(q, q.yzx + 33.33);
        return fract((q.x + q.y) * q.z);
      }
      float stoneNoise(vec2 p) {
        vec2 c = floor(p), f = fract(p);
        f = f*f*(3.-2.*f);
        return mix(mix(grainHash(c),grainHash(c+vec2(1,0)),f.x),
                   mix(grainHash(c+vec2(0,1)),grainHash(c+1.),f.x),f.y);
      }\n` + shader.fragmentShader.replace('#include <color_fragment>', `
        #include <color_fragment>
        vec2 uv = vStonePoint.xz + .36*vStonePoint.y;
        float grainPatch = stoneNoise(uv*19.);
        float mineral = stoneNoise(uv*97.);
        float grain = (mineral-.5)*(1.-smoothstep(.25,1.,length(fwidth(uv*97.))));
        diffuseColor.rgb *= .85 + .31*grainPatch + .32*grain;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.205,.204,.135),
          .38*smoothstep(.67,.87,grainPatch+.23*grain));
      `)
  }
  const mesh = new THREE.Mesh(geometry(owned,'oath-circle-paving',paving),stone)
  mesh.name = 'oath-circle-paving'
  mesh.scale.set(width*.47,1,depth*.47)
  mesh.receiveShadow = true
  group.add(mesh)
}
