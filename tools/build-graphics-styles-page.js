// Страница сборки стилей графики: выполняется в браузере, файлы отдаёт tools/build-graphics-styles.mjs.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js'

const log = (line) => { document.getElementById('log').textContent += `${line}\n` }

function image(url) {
  return new Promise((ok, fail) => {
    const element = new Image()
    element.onload = () => ok(element)
    element.onerror = () => fail(new Error(`не загрузилась картинка ${url}`))
    element.src = url
  })
}

/** Квадратный холст стороны side из картинки или из пикселей другого холста. */
function canvasOf(source, side) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = side
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, side, side)
  return canvas
}

const blob = (canvas, quality) => new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', quality))

async function post(style, path, body) {
  const response = await fetch(`/out?style=${style}&path=${encodeURIComponent(path)}`, { method: 'POST', body })
  if (!response.ok) throw new Error(`${path}: ${await response.text()}`)
}

/** Высота из яркости: размытая и растянутая на весь диапазон, тёмные швы — низ. */
function heightFromColor(colorCanvas, side) {
  const source = canvasOf(colorCanvas, side).getContext('2d').getImageData(0, 0, side, side).data
  const luma = new Float32Array(side * side)
  for (let i = 0; i < luma.length; i++) luma[i] = source[i * 4] * .299 + source[i * 4 + 1] * .587 + source[i * 4 + 2] * .114
  const blurred = new Float32Array(luma.length)
  const radius = Math.max(1, Math.round(side / 256))
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    let sum = 0, count = 0
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      sum += luma[((y + dy + side) % side) * side + ((x + dx + side) % side)]; count++
    }
    blurred[y * side + x] = sum / count
  }
  let min = Infinity, max = -Infinity
  for (const value of blurred) { min = Math.min(min, value); max = Math.max(max, value) }
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = side
  const context = canvas.getContext('2d'); const out = context.createImageData(side, side)
  for (let i = 0; i < blurred.length; i++) {
    const value = Math.round(Math.pow((blurred[i] - min) / (max - min || 1), .8) * 255)
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = value; out.data[i * 4 + 3] = 255
  }
  context.putImageData(out, 0, 0)
  return canvas
}

/** Нормали OpenGL (+Y) из карты высот оператором Собеля, швы бесшовные. */
function normalFromHeight(heightCanvas, strength) {
  const side = heightCanvas.width
  const data = heightCanvas.getContext('2d').getImageData(0, 0, side, side).data
  const h = (x, y) => data[(((y + side) % side) * side + ((x + side) % side)) * 4] / 255
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = side
  const context = canvas.getContext('2d'); const out = context.createImageData(side, side)
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const dx = (h(x + 1, y - 1) + 2 * h(x + 1, y) + h(x + 1, y + 1)) - (h(x - 1, y - 1) + 2 * h(x - 1, y) + h(x - 1, y + 1))
    const dy = (h(x - 1, y + 1) + 2 * h(x, y + 1) + h(x + 1, y + 1)) - (h(x - 1, y - 1) + 2 * h(x, y - 1) + h(x + 1, y - 1))
    const n = new THREE.Vector3(-dx * strength, dy * strength, 1).normalize()
    const i = (y * side + x) * 4
    out.data[i] = Math.round((n.x * .5 + .5) * 255); out.data[i + 1] = Math.round((n.y * .5 + .5) * 255); out.data[i + 2] = Math.round((n.z * .5 + .5) * 255); out.data[i + 3] = 255
  }
  context.putImageData(out, 0, 0)
  return canvas
}

/** ORM: R — затенение, G — шероховатость, B — металличность. */
function ormFrom(side, { roughness, ao, metal = 0 }) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = side
  const context = canvas.getContext('2d'); const out = context.createImageData(side, side)
  const r = roughness ? roughness.getContext('2d').getImageData(0, 0, side, side).data : null
  const a = ao ? ao.getContext('2d').getImageData(0, 0, side, side).data : null
  for (let i = 0; i < side * side; i++) {
    out.data[i * 4] = a ? Math.round(160 + a[i * 4] * 95 / 255) : 255
    out.data[i * 4 + 1] = r ? r[i * 4] : 215
    out.data[i * 4 + 2] = metal
    out.data[i * 4 + 3] = 255
  }
  context.putImageData(out, 0, 0)
  return canvas
}

async function buildFloor(style, key, floor) {
  let color, normal, orm, height
  if (floor.polyhaven) {
    const base = `/source/polyhaven/${floor.polyhaven}/${floor.polyhaven}_`
    const [c, n, a, d] = await Promise.all(['diff', 'nor_gl', 'arm', 'disp'].map((map) => image(`${base}${map}_1k.jpg`)))
    color = canvasOf(c, 1024); normal = canvasOf(n, 1024); orm = canvasOf(a, 512); height = canvasOf(d, 512)
  } else if (floor.quaternius) {
    const base = `/source/quaternius-village/tex/${floor.quaternius}_`
    const [c, n, r] = await Promise.all(['BaseColor', 'Normal', 'Roughness'].map((map) => image(`${base}${map}.png`)))
    color = canvasOf(c, 1024); normal = canvasOf(n, 1024); height = heightFromColor(color, 512)
    orm = ormFrom(512, { roughness: canvasOf(r, 512), ao: height })
  } else {
    const c = await image(`/public/${floor.painted}`)
    const side = Math.min(1024, Math.max(512, c.naturalWidth))
    color = canvasOf(c, side); height = heightFromColor(color, side)
    normal = normalFromHeight(height, 3.2); orm = ormFrom(512, { ao: canvasOf(height, 512) })
    height = canvasOf(height, 512)
  }
  for (const [name, canvas, quality] of [['color', color, .86], ['normal', normal, .9], ['orm', orm, .85], ['height', height, .9]]) {
    await post(style, `floors/${key}/${name}.jpg`, await blob(canvas, quality))
  }
}

function triangleCount(root) {
  let total = 0
  root.traverse((object) => { if (object.isMesh) total += (object.geometry.index ? object.geometry.index.count : object.geometry.attributes.position.count) / 3 })
  return total
}

async function buildProp(style, prop) {
  const base = `/source/polyhaven/${prop.polyhaven}/`
  const gltf = await new GLTFLoader().setPath(base).loadAsync(`${prop.polyhaven}_1k.gltf`)
  const root = gltf.scene
  const before = triangleCount(root), target = prop.triangles ?? 12000
  if (before > target) {
    // Упрощение на meshoptimizer из поставки three.js: швы UV и нормали учитываются.
    const modifier = new SimplifyModifier()
    const meshes = []
    root.traverse((object) => { if (object.isMesh) meshes.push(object) })
    for (const object of meshes) {
      const geometry = object.geometry
      const vertices = geometry.attributes.position.count
      object.geometry = await modifier.modify(geometry, Math.floor(vertices * (1 - target / before)))
      geometry.dispose()
    }
  }
  root.traverse((object) => {
    if (!object.isMesh) return
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
        if (material[slot]) material[slot].userData.mimeType = 'image/jpeg'
      }
    }
  })
  const glb = await new GLTFExporter().parseAsync(root, { binary: true, maxTextureSize: 512, onlyVisible: true })
  await post(style, `props/${prop.polyhaven}.glb`, glb)
  return `${prop.polyhaven}: ${before} → ${triangleCount(root)} треуг., ${(glb.byteLength / 1024).toFixed(0)} КБ`
}

document.getElementById('build').addEventListener('click', async () => {
  try {
    const plan = await (await fetch('/plan.json')).json()
    for (const [style, source] of Object.entries(plan)) {
      for (const [key, floor] of Object.entries(source.floors)) { await buildFloor(style, key, floor); log(`${style} пол ${key}`) }
      const done = new Set()
      for (const list of Object.values(source.props)) for (const prop of list) {
        if (done.has(prop.polyhaven)) continue
        done.add(prop.polyhaven)
        log(`${style} ${await buildProp(style, prop)}`)
      }
    }
    const result = await (await fetch('/finish', { method: 'POST' })).json()
    log(`Готово: ${JSON.stringify(result)}`)
  } catch (error) {
    log(`Ошибка: ${error.message ?? error}`)
  }
})
