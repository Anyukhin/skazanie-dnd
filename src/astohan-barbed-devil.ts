import * as THREE from 'three'

/** Хамат: костяные шипы на загривке, локтях и хвосте, когтистые лапы. */
export function buildBarbedDevil() {
  const body = new THREE.Group()
  const hide = new THREE.MeshStandardMaterial({color:'#664938',roughness:.85})
  const ridge = new THREE.MeshStandardMaterial({color:'#443a32',roughness:.72})
  const ivory = new THREE.MeshStandardMaterial({color:'#b7a78a',roughness:.83})
  const eyes = new THREE.MeshStandardMaterial({color:'#f0af3e',emissive:'#812c0e',emissiveIntensity:.36})
  type P = [number,number,number]
  const oval = new THREE.SphereGeometry(1,14,9)
  function mass(at:P, scale:P, material=hide) {
    const mesh=new THREE.Mesh(oval,material)
    mesh.position.set(...at);mesh.scale.set(...scale);body.add(mesh)
    return mesh
  }
  function taper(start:P,end:P,base:number,tip:number,material=hide) {
    const a=new THREE.Vector3(...start), b=new THREE.Vector3(...end), axis=b.clone().sub(a)
    const mesh=new THREE.Mesh(new THREE.CylinderGeometry(tip,base,axis.length(),8),material)
    mesh.position.copy(a).lerp(b,.5)
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),axis.normalize());body.add(mesh)
  }
  mass([0,.78,0],[.22,.22,.17])
  mass([0,1.05,-.03],[.28,.36,.18])
  mass([0,1.42,.06],[.15,.18,.13]);mass([0,1.35,.16],[.105,.091,.09],ridge)
  for(const s of [-1,1]) {
    taper([s*.13,.72,.03],[s*.18,.40,.095],.103,.067)
    taper([s*.18,.40,.095],[s*.19,.15,-.037],.067,.046)
    taper([s*.19,.15,-.037],[s*.19,.045,.06],.046,.055)
    mass([s*.19,.049,.085],[.07,.047,.12],ridge)
    mass([s*.256,1.24,0],[.139,.14,.15])
    taper([s*.28,1.24,0],[s*.38,1.04,-.10],.099,.073)
    taper([s*.38,1.04,-.10],[s*.43,.81,.10],.08,.053)
    mass([s*.43,.78,.11],[.07,.078,.055])
    for(let i=0;i<3;i++){
      const x=s*(.39+i*.033)
      taper([x,.765,.13],[x+s*.016,.68,.17],.021,.013)
      taper([x+s*.016,.68,.17],[x,.653,.197],.015,.002,ivory)
    }
    mass([s*.078,1.457,.164],[.030,.017,.017],eyes)
    taper([s*.03,1.50,.164],[s*.145,1.48,.108],.035,.030,ridge)
    taper([s*.10,1.55,.032],[s*.17,1.70,-.045],.055,.004,ridge)
    for(let i=0;i<6;i++){
      const y=.90+i*.066,x=s*(.13+.017*i)
      taper([x,y,-.15],[x+s*(.15+i*.009),y+.09,-.31],.049,.0015,ivory)
    }
    taper([s*.38,1.04,-.11],[s*.44,1.08,-.29],.049,.003,ivory)
  }
  const tail:P[]=[[0,.73,-.13],[.04,.57,-.33],[.17,.48,-.49],[.29,.53,-.63],[.34,.70,-.70],[.32,.81,-.74]]
  for(let i=1;i<tail.length;i++){
    taper(tail[i-1],tail[i],.099-i*.014,.087-i*.014)
    if (i>1) {const [x,y,z]=tail[i];taper([x,y,z],[x-.02,y+.09,z-.04],.032,.002,ivory)}
  }
  body.name='barbed-devil'
  return body
}
