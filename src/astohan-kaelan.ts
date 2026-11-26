import * as THREE from 'three'

type P = [number, number, number]
// Ось сечения, смещение поперёк, высота/глубина центра и два полуразмера.
type Slice = [number, number, number, number, number]

function loft(axis:'y'|'z', rows:Slice[], sides=18) {
  const xyz:number[]=[],indices:number[]=[]
  for(const [d,cx,cy,rx,ry] of rows) for(let j=0;j<sides;j++){
    const a=j*Math.PI*2/sides,x=cx+rx*Math.cos(a),v=cy+ry*Math.sin(a)
    xyz.push(x,axis==='y'?d:v,axis==='y'?v:d)
  }
  const tri=(a:number,b:number,c:number)=>indices.push(a,axis==='z'?b:c,axis==='z'?c:b)
  for(let i=0;i<rows.length-1;i++) for(let j=0;j<sides;j++){
    const a=i*sides+j,b=i*sides+(j+1)%sides
    tri(a,b,b+sides);tri(a,b+sides,a+sides)
  }
  const end=(rows.length-1)*sides
  for(let j=1;j+1<sides;j++){tri(0,j+1,j);tri(end,end+j,end+j+1)}
  const geo=new THREE.BufferGeometry()
  geo.setAttribute('position',new THREE.Float32BufferAttribute(xyz,3));geo.setIndex(indices);geo.computeVertexNormals()
  return geo
}

/** Каэлан верхом, лицом в +Z. Кираса заканчивается полым воротом. Лик
 * отстоит от металла и виден над ним при повороте камеры. */
export function buildAstohanKaelan(parent:THREE.Object3D) {
  const root=new THREE.Group();root.name='astohan-kaelan-rider';root.userData.astohanKaelan=true
  const paint=(color:string,metalness=0,roughness=.8)=>new THREE.MeshStandardMaterial({color,metalness,roughness})
  const hide=paint('#574238'), mane=paint('#312a28'), armor=paint('#39424c',.47,.5), silver=paint('#929b99',.61,.41)
  const straps=paint('#543b31'), cloak=paint('#424754'), brass=paint('#967448',.47,.44)
  const ghost=new THREE.MeshStandardMaterial({color:'#afc7bd',emissive:'#526f72',emissiveIntensity:.45,transparent:true,opacity:.88,roughness:.79})
  const eye=paint('#282a2c'), gleam=paint('#c7e1dd'), hoof=paint('#3c3736')
  function mesh(name:string,geo:THREE.BufferGeometry,mat:THREE.Material,pos:P=[0,0,0]){
    const m=new THREE.Mesh(geo,mat);m.name=name;m.position.set(...pos);m.castShadow=true;m.receiveShadow=true;m.userData.board3dPickable=false;root.add(m);return m
  }
  const ball=new THREE.SphereGeometry(1,16,11)
  function oval(name:string,p:P,scale:P,mat:THREE.Material){const m=mesh(name,ball,mat,p);m.scale.set(...scale);return m}
  function rod(name:string,a:P,b:P,r0:number,r1:number,mat:THREE.Material){
    const from=new THREE.Vector3(...a),to=new THREE.Vector3(...b),delta=to.clone().sub(from)
    const m=mesh(name,new THREE.CylinderGeometry(r1,r0,delta.length(),11),mat)
    m.position.copy(from).lerp(to,.5);m.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());return m
  }
  function cord(name:string,pts:P[],r:number,mat:THREE.Material){
    return mesh(name,new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(p=>new THREE.Vector3(...p))),18,r,7,false),mat)
  }
  mesh('kaelan-horse-body',loft('z',[
    [-.83,0,1.02,.09,.17],[-.72,0,1.02,.257,.295],[-.50,0,1.03,.31,.325],[-.27,0,1.00,.294,.29],
    [.02,0,.99,.288,.316],[.22,0,1.01,.284,.354],[.38,0,1.04,.257,.36],[.52,0,1.07,.17,.278],[.58,0,1.08,.085,.162],
  ]),hide)
  mesh('kaelan-horse-neck',loft('y',[[1.11,0,.332,.22,.23],[1.27,0,.375,.195,.235],[1.45,0,.457,.149,.187],[1.61,0,.555,.108,.153],[1.705,0,.595,.095,.103]]),hide)
  mesh('kaelan-horse-head',loft('z',[[.487,0,1.65,.09,.09],[.574,0,1.655,.133,.147],[.677,0,1.624,.147,.146],[.780,0,1.56,.115,.124],[.93,0,1.454,.092,.083],[1.031,0,1.425,.095,.079],[1.058,0,1.426,.069,.050]]),hide)
  for(const s of [-1,1]){
    oval('horse-eye',[s*.129,1.66,.697],[.028,.025,.025],eye)
    oval('nostril',[s*.074,1.446,1.017],[.025,.022,.032],mane)
    mesh('pointed-ear',loft('y',[[0,0,0,.046,.044],[.08,0,-.008,.049,.030],[.166,s*.021,-.02,.005,.006]],10),hide,[s*.075,1.73,.568])
    cord('bridle',[[s*.11,1.76,.57],[s*.137,1.641,.713],[s*.098,1.474,.98]],.013,straps)
    cord('rein',[[s*.102,1.45,.962],[s*.212,1.25,.61],[s*.19,1.38,.28],[s*.14,1.55,.10]],.010,straps)
    oval('bit-ring',[s*.108,1.45,.962],[.027,.027,.01],brass)
  }
  cord('kaelan-horse-mane',[[0,1.73,.54],[0,1.60,.41],[0,1.42,.25],[0,1.31,.16]],.072,mane)
  for(let i=0;i<7;i++) {
    const t=i/6;rod('mane-lock',[0,1.71-.36*t,.515-.30*t],[-.116+.025*t,1.49-.31*t,.474-.34*t],.051,.010,mane)
  }
  // Задняя нога сгибается в скакательном суставе; передние запястья обращены вперёд.
  for(const s of [-1,1]) for(const hind of [false,true]){
    const z=hind?-.54:.32,x=s*.185,stride=s*(hind?.105:-.09)
    const knee:P=[x,hind?.6:.49,z+(hind?.16:.018)+stride*.45], hock:P=[x,.29,z+(hind?-.088:.014)+stride]
    const ankle:P=[x,.13,z+(hind?-.052:.045)+stride]
    rod('kaelan-horse-leg',[x,1.02,z],knee,hind?.159:.119,.071,hide)
    oval('carpal-joint',knee,[.076,.080,.09],hide)
    rod('cannon',knee,hock,.068,.048,hide);rod('fetlock',hock,ankle,.049,.043,hide)
    rod('pastern',ankle,[x,.068,ankle[2]+.048],.049,.052,hide)
    mesh('kaelan-horse-hoof',loft('y',[[.004,0,.023,.071,.09],[.032,0,.014,.074,.094],[.088,0,-.009,.052,.062]],12),hoof,[x,0,ankle[2]+.037])
  }
  cord('kaelan-horse-tail',[[0,1.17,-.735],[.03,1.04,-.88],[.069,.77,-.97],[.13,.54,-1.02],[.17,.421,-1.07]],.067,mane)
  // Попона лежит на спине, с отдельными полосами канта на боках.
  mesh('kaelan-saddle-blanket',loft('z',[[-.60,0,1.12,.24,.18],[-.50,0,1.12,.301,.225],[-.15,0,1.12,.31,.207],[.05,0,1.11,.276,.20]]),cloak)
  for (const s of [-1,1]){
    cord('blanket-piping',[[s*.257,1.12,-.595],[s*.307,1.10,-.46],[s*.317,1.09,-.16],[s*.282,1.10,.04]],.011,silver)
    oval('saddle-flap',[s*.252,1.16,-.17],[.052,.20,.185],straps)
    rod('kaelan-rider-thigh',[s*.128,1.38,-.19],[s*.265,1.18,.043],.123,.088,armor)
    rod('kaelan-boot',[s*.26,1.15,.03],[s*.285,.86,-.09],.079,.051,armor)
    oval('sabatons',[s*.285,.849,-.037],[.061,.048,.107],silver)
  }
  mesh('kaelan-armor-skirt',loft('y',[[1.23,0,-.17,.206,.159],[1.30,0,-.17,.21,.148],[1.43,0,-.17,.153,.12]]),armor)
  mesh('kaelan-chest-plate',loft('y',[[1.37,0,-.16,.147,.112],[1.47,0,-.16,.157,.132],[1.61,0,-.15,.217,.156],[1.69,0,-.145,.213,.132],[1.746,0,-.145,.143,.089]]),armor)
  for(const s of [-1,1]){
    oval('kaelan-pauldron',[s*.207,1.65,-.147],[.124,.092,.128],silver)
    rod('vambrace-upper',[s*.211,1.62,-.13],[s*.254,1.45,-.10],.082,.066,armor)
    rod('vambrace',[s*.254,1.45,-.10],[s*.166,1.515,.075],.071,.049,silver)
    oval('gauntlet',[s*.166,1.52,.080],[.049,.053,.058],armor)
  }
  const collar=mesh('kaelan-ghost-collar',new THREE.TorusGeometry(.099,.016,9,22),silver,[0,1.741,-.145]);collar.rotation.x=Math.PI/2
  oval('empty-neck',[0,1.73,-.145],[.082,.01,.077],eye)
  mesh('kaelan-floating-head',loft('y',[[1.84,0,-.129,.046,.070],[1.873,0,-.132,.092,.090],[1.925,0,-.143,.121,.11],[2.024,0,-.15,.127,.112],[2.091,0,-.159,.109,.095],[2.124,0,-.163,.041,.052]]),ghost)
  oval('ghost-nose',[0,1.952,-.032],[.023,.045,.029],ghost)
  for(const s of [-1,1]) {
    oval('ghost-cheek',[s*.075,1.941,-.052],[.039,.032,.026],ghost)
    oval('ghost-eye',[s*.053,1.986,-.043],[.025,.011,.015],gleam)
    rod('ghost-brow',[s*.027,2.011,-.034],[s*.096,2.022,-.067],.017,.011,ghost)
  }
  const hilt:P=[.162,1.524,.087];rod('sword-grip',[.21,1.423,.11],[.13,1.624,.075],.023,.023,straps)
  rod('sword-guard',[.035,1.587,.071],[.248,1.658,.085],.016,.02,silver)
  const blade = new THREE.Shape()
  blade.moveTo(-.041,0);blade.lineTo(.041,0);blade.lineTo(.029,.55);blade.lineTo(0,.72);blade.lineTo(-.029,.55);blade.closePath()
  const sword=mesh('kaelan-moon-judge',new THREE.ExtrudeGeometry(blade,{depth:.010,bevelSize:.005,bevelThickness:.004,bevelSegments:1}),silver,[hilt[0]-.03,1.637,.077]);sword.rotation.z=.34
  root.userData.recommendedHeight=2.05;parent.add(root);return root
}
