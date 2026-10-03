// Просмотр собранных моделей рисованного стиля сеткой: та же подстановка
// общих материалов `skz:*`, что делает клиент (src/board3d-style.ts).
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

const params = new URLSearchParams(location.search)
const source = params.get('from') === 'published' ? 'published' : 'staging'
const filter = params.get('only') ? new RegExp(params.get('only')) : null
const columns = Number(params.get('columns') ?? 6)
const cell = Number(params.get('cell') ?? 240)

async function listing() {
  if (source === 'published') {
    const manifest = await (await fetch('/public/styles/stylized/manifest.json')).json()
    const urls = new Map()
    for (const list of Object.values(manifest.props)) for (const entry of list) urls.set(entry.key, entry.url.startsWith('/') ? entry.url.replace('/assets/', '/public/') : `/public/styles/stylized/${entry.url}`)
    return { base: '/public/styles/stylized/', materials: manifest.materials, models: [...urls] }
  }
  const files = await (await fetch('/staging-list.json')).json()
  const meta = files.includes('meta.json') ? await (await fetch('/staging/meta.json')).json() : { materials: {} }
  const materials = Object.fromEntries(Object.entries(meta.materials).map(([key, spec]) => [key, {
    ...spec, color: `materials/${key}/color.jpg`, normal: spec.normal ? `materials/${key}/normal.jpg` : undefined, orm: spec.orm ? `materials/${key}/orm.jpg` : undefined,
  }]))
  return { base: '/staging/', materials, models: files.filter((file) => file.startsWith('props/')).map((file) => [file.slice(6, -4), `/staging/${file}`]) }
}

const textureLoader = new THREE.TextureLoader()
const loaded = new Map()
function texture(url, color) {
  const map = loaded.get(url)
  map.flipY = false
  map.wrapS = map.wrapT = THREE.RepeatWrapping
  map.anisotropy = 8
  if (color) map.colorSpace = THREE.SRGBColorSpace
  return map
}

function materialFactory(base, specs) {
  const cache = new Map()
  return (name, vertexColors) => {
    const key = name.slice(4)
    const spec = specs[key]
    if (!spec) return null
    const id = `${key}:${vertexColors}`
    if (!cache.has(id)) {
      const orm = spec.orm ? texture(base + spec.orm, false) : null
      cache.set(id, new THREE.MeshStandardMaterial({
        name, vertexColors, map: texture(base + spec.color, true), normalMap: spec.normal ? texture(base + spec.normal, false) : null,
        roughnessMap: orm, metalnessMap: orm, aoMap: orm, roughness: spec.roughness ?? 1, metalness: spec.metalness ?? 0,
        side: spec.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      }))
    }
    return cache.get(id)
  }
}

const { base, materials, models } = await listing()
const chosen = models.filter(([key]) => !filter || filter.test(key))
const rows = Math.ceil(chosen.length / columns)
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.setSize(columns * cell, rows * (cell + 18))
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.shadowMap.enabled = true
document.body.appendChild(renderer.domElement)
renderer.domElement.style.display = 'block'
const labels = document.createElement('div')
labels.style.cssText = `position:absolute;left:0;top:0;width:${columns * cell}px;font:12px system-ui;color:#e7dccb`
document.body.appendChild(labels)
renderer.setScissorTest(true)
renderer.setClearColor(0x2a2520)

for (const spec of Object.values(materials)) for (const file of [spec.color, spec.normal, spec.orm]) {
  if (file && !loaded.has(base + file)) loaded.set(base + file, await textureLoader.loadAsync(base + file))
}
const material = materialFactory(base, materials)
const loader = new GLTFLoader()
let index = 0
for (const [key, url] of chosen) {
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xfff1dc, 0x3a3128, 1.4))
  const sun = new THREE.DirectionalLight(0xffe2b8, 2.6)
  sun.position.set(3, 6, 4); sun.castShadow = true
  scene.add(sun)
  try {
    const gltf = await loader.loadAsync(url)
    const root = gltf.scene
    root.traverse((object) => {
      if (!object.isMesh) return
      object.castShadow = object.receiveShadow = true
      if (object.material.name?.startsWith('skz:')) {
        const shared = material(object.material.name, Boolean(object.geometry.attributes.color))
        if (shared) object.material = shared
      }
    })
    const box = new THREE.Box3().setFromObject(root)
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3())
    root.position.sub(new THREE.Vector3(center.x, box.min.y, center.z))
    scene.add(root)
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x6b5b45 }))
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true
    scene.add(ground)
    const radius = Math.max(size.x, size.y, size.z) * .9
    const camera = new THREE.PerspectiveCamera(30, 1, .01, 200)
    camera.position.set(radius * 1.6, radius * 1.5 + size.y * .4, radius * 2.1)
    camera.lookAt(0, size.y * .4, 0)
    sun.shadow.camera.left = sun.shadow.camera.bottom = -radius * 2; sun.shadow.camera.right = sun.shadow.camera.top = radius * 2
    const x = (index % columns) * cell, row = Math.floor(index / columns)
    const y = (rows - 1 - row) * (cell + 18)
    renderer.setViewport(x, y, cell, cell); renderer.setScissor(x, y, cell, cell)
    renderer.render(scene, camera)
  } catch (error) {
    console.error(key, error)
  }
  const label = document.createElement('div')
  label.textContent = key
  label.style.cssText = `position:absolute;left:${(index % columns) * cell + 4}px;top:${Math.floor(index / columns) * (cell + 18) + cell}px`
  labels.appendChild(label)
  index += 1
}
if (params.has('shot')) {
  // Подписи переносятся на холст, чтобы снимок читался без страницы.
  const canvas = document.createElement('canvas')
  canvas.width = renderer.domElement.width; canvas.height = renderer.domElement.height
  const context = canvas.getContext('2d')
  context.drawImage(renderer.domElement, 0, 0)
  context.font = '12px system-ui'; context.fillStyle = '#e7dccb'
  chosen.forEach(([key], i) => context.fillText(key, (i % columns) * cell + 4, Math.floor(i / columns) * (cell + 18) + cell + 13))
  await fetch(`/shot?name=${params.get('shot')}`, { method: 'POST', body: await new Promise((ok) => canvas.toBlob(ok, 'image/png')) })
}
document.title = 'ready'
