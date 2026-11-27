import * as THREE from 'three'

/** Серый дорожный плащ и глубокий капюшон, видимые отряду при встрече. */
export function buildAshTraveler() {
  const root = new THREE.Group()
  root.name = 'ash-cloaked-traveler'
  const wool = new THREE.MeshStandardMaterial({color:'#c0beb4', roughness:.97, vertexColors:true, side:THREE.DoubleSide})
  const lining = new THREE.MeshStandardMaterial({color:'#252931',roughness:1})
  const leather = new THREE.MeshStandardMaterial({color:'#58483d',roughness:.83})
  const bronze = new THREE.MeshStandardMaterial({color:'#94795a',metalness:.44,roughness:.55})
  function piece(name:string,g:THREE.BufferGeometry,mat:THREE.Material,x=0,y=0,z=0) {
    const m=new THREE.Mesh(g,mat);m.name=name;m.position.set(x,y,z);root.add(m);return m
  }
  function cloth(name:string, profile:number[][], gap:number, offset:number) {
    const pts:number[]=[], cols:number[]=[], idx:number[]=[], n=52
    for(let i=0;i<profile.length;i++) {
      const [y,w,d,shift]=profile[i]
      for(let j=0;j<=n;j++) {
        const a=gap+(Math.PI*2-2*gap)*j/n
        const fold=Math.cos(11*a+.27*i)+.33*Math.cos(6*a-.19*i)
        const r=1+.058*fold
        pts.push(w*r*Math.sin(a), y+(i===0?.015*Math.cos(a*7):0), shift+d*r*Math.cos(a))
        const edge=Math.min(j,n-j), c = new THREE.Color(edge<2?'#867a70':i===0?'#4b4944':'#666865')
        c.multiplyScalar(.86+.09*fold+.05*Math.sin(j*3+i*1.6))
        cols.push(c.r,c.g,c.b)
        if(i<profile.length-1 && j<n){const p=i*(n+1)+j;idx.push(p,p+1,p+n+1,p+1,p+n+2,p+n+1)}
      }
    }
    const g=new THREE.BufferGeometry()
    g.setAttribute('position',new THREE.Float32BufferAttribute(pts,3));g.setAttribute('color',new THREE.Float32BufferAttribute(cols,3))
    g.setIndex(idx);g.computeVertexNormals();piece(name,g,wool,0,0,offset)
  }
  const oval=new THREE.SphereGeometry(1,16,12)
  const inner=piece('дорожный кафтан',oval,lining,0,.68,0);inner.scale.set(.205,.55,.13)
  for(const side of [-1,1]) piece('сапог',oval,leather,side*.103,.094,.052).scale.set(.076,.092,.143)
  cloth('плащ',[ [.14,.318,.21,-.035],[.30,.302,.202,-.033],[.66,.259,.175,-.022],[.99,.235,.157,-.01],[1.16,.248,.15,0],[1.25,.195,.12,0],[1.29,.116,.093,0] ],.245,0)
  cloth('пелерина',[[.94,.28,.19,0],[1.09,.27,.178,0],[1.19,.253,.152,0],[1.285,.122,.110,0]],.19,0)
  cloth('капюшон',[[1.205,.117,.12,.004],[1.29,.150,.155,0],[1.42,.166,.178,-.014],[1.53,.146,.159,-.035],[1.595,.092,.10,-.061],[1.625,.002,.002,-.091]],.58,.01)
  piece('тень под капюшоном',oval,lining,0,1.40,.02).scale.set(.115,.152,.099)
  piece('застёжка',new THREE.TorusGeometry(.031,.008,6,18),bronze,.03,1.207,.143)
  return root
}
