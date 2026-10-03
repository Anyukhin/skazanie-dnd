// Страница сборки рисованного стиля: выполняется в браузере, файлы отдаёт tools/build-graphics-styles.mjs.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'

const log = (line) => { document.getElementById('log').textContent += `${line}\n` }

function image(url) {
  return new Promise((ok, fail) => {
    const element = new Image()
    element.onload = () => ok(element)
    element.onerror = () => fail(new Error(`не загрузилась картинка ${url}`))
    element.src = url
  })
}

/** Холст width×height из картинки или её прямоугольника. */
function canvasOf(source, width, height = width, rect = null) {
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.imageSmoothingQuality = 'high'
  if (rect) context.drawImage(source, rect[0], rect[1], rect[2], rect[3], 0, 0, width, height)
  else context.drawImage(source, 0, 0, width, height)
  return canvas
}

const blob = (canvas, quality) => new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', quality))

async function post(path, body) {
  const response = await fetch(`/out?path=${encodeURIComponent(path)}`, { method: 'POST', body })
  if (!response.ok) throw new Error(`${path}: ${await response.text()}`)
}

// ---------------------------------------------------------------- полы

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
function ormFrom(width, height, { roughness, ao, metal = 0, roughnessValue = .85 }) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d'); const out = context.createImageData(width, height)
  const r = roughness ? roughness.getContext('2d').getImageData(0, 0, width, height).data : null
  const a = ao ? ao.getContext('2d').getImageData(0, 0, width, height).data : null
  for (let i = 0; i < width * height; i++) {
    out.data[i * 4] = a ? Math.round(160 + a[i * 4] * 95 / 255) : 255
    out.data[i * 4 + 1] = r ? r[i * 4] : Math.round(roughnessValue * 255)
    out.data[i * 4 + 2] = Math.round(metal * 255)
    out.data[i * 4 + 3] = 255
  }
  context.putImageData(out, 0, 0)
  return canvas
}

/** Детерминированный генератор: та же фактура при каждой сборке. */
function seeded(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

/** Периодический плавный шум: решётка cells×cells, края сшиты, значения 0..1. */
function periodicNoise(side, cells, seed) {
  const random = seeded(seed)
  const lattice = Array.from({ length: cells * cells }, () => random())
  const out = new Float32Array(side * side)
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const gx = x / side * cells, gy = y / side * cells
    const x0 = Math.floor(gx), y0 = Math.floor(gy)
    const fx = gx - x0, fy = gy - y0
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy)
    const at = (cx, cy) => lattice[((cy % cells + cells) % cells) * cells + ((cx % cells + cells) % cells)]
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1)
    out[y * side + x] = (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy
  }
  return out
}

/**
 * Рисованная трава в духе Stylized Nature MegaKit: пятна сочной зелени трёх
 * масштабов, тысячи мазков-травинок светлее и темнее основы, редкие точки
 * цветов. Повтор бесшовный: всё у края рисуется и со сдвигом на сторону.
 */
function paintGrass(side) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = side
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const large = periodicNoise(side, 3, 11), middle = periodicNoise(side, 7, 12), small = periodicNoise(side, 17, 13)
  // Цвета в sRGB, как их рисует художник: смешиваются прямо в байтах холста.
  const hex = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16))
  const dark = hex('#41702a'), light = hex('#6f9a3f'), dry = hex('#9aa34c')
  const mix = (a, b, t) => a.map((channel, index) => channel + (b[index] - channel) * t)
  const data = context.createImageData(side, side)
  for (let i = 0; i < side * side; i++) {
    const value = large[i] * .5 + middle[i] * .32 + small[i] * .18
    let color = mix(dark, light, Math.min(1, Math.max(0, (value - .22) * 1.6)))
    color = mix(color, dry, Math.min(1, Math.max(0, (middle[i] - .66) / .2)) * .4)
    data.data[i * 4] = color[0]; data.data[i * 4 + 1] = color[1]; data.data[i * 4 + 2] = color[2]; data.data[i * 4 + 3] = 255
  }
  context.putImageData(data, 0, 0)
  const random = seeded(7)
  const wrapped = (x, y, reach, draw) => {
    for (const dx of [-side, 0, side]) for (const dy of [-side, 0, side]) {
      if (x + dx < -reach || x + dx > side + reach || y + dy < -reach || y + dy > side + reach) continue
      draw(x + dx, y + dy)
    }
  }
  // Тёмные «ямки» под гуще растущей травой.
  for (let i = 0; i < 26; i++) {
    const x = random() * side, y = random() * side, radius = side * (.03 + random() * .05)
    wrapped(x, y, radius, (px, py) => {
      const gradient = context.createRadialGradient(px, py, 0, px, py, radius)
      gradient.addColorStop(0, 'rgba(44, 84, 28, .2)'); gradient.addColorStop(1, 'rgba(44, 84, 28, 0)')
      context.fillStyle = gradient
      context.fillRect(px - radius, py - radius, radius * 2, radius * 2)
    })
  }
  // Травинки: короткие изогнутые мазки, светлые сверху тёмных.
  const strokes = [
    { count: 2600, colors: ['rgba(44, 82, 26, .45)', 'rgba(52, 92, 30, .4)'], width: [2.4, 3.6], length: [8, 15] },
    { count: 4200, colors: ['rgba(108, 156, 60, .5)', 'rgba(120, 166, 68, .45)', 'rgba(96, 144, 52, .5)'], width: [2, 3.2], length: [7, 14] },
    { count: 1500, colors: ['rgba(152, 192, 92, .42)', 'rgba(170, 202, 108, .36)'], width: [1.6, 2.4], length: [5, 10] },
  ]
  context.lineCap = 'round'
  for (const layer of strokes) {
    for (let i = 0; i < layer.count; i++) {
      const x = random() * side, y = random() * side
      const length = (layer.length[0] + random() * (layer.length[1] - layer.length[0])) * side / 1024
      const angle = -Math.PI / 2 + (random() - .5) * 1.1
      const bend = (random() - .5) * length * .6
      const tipX = Math.cos(angle) * length, tipY = Math.sin(angle) * length
      context.strokeStyle = layer.colors[Math.floor(random() * layer.colors.length)]
      context.lineWidth = (layer.width[0] + random() * (layer.width[1] - layer.width[0])) * side / 1024
      wrapped(x, y, length + 4, (px, py) => {
        context.beginPath()
        context.moveTo(px, py)
        context.quadraticCurveTo(px + tipX * .5 + bend, py + tipY * .5, px + tipX, py + tipY)
        context.stroke()
      })
    }
  }
  // Редкие цветы: две-три точки рядом.
  for (let i = 0; i < 46; i++) {
    const x = random() * side, y = random() * side
    const tone = ['#f4ecc8', '#f1d150', '#e8e4f2'][Math.floor(random() * 3)]
    for (let k = 0; k < 2 + Math.floor(random() * 3); k++) {
      const px = x + (random() - .5) * 18, py = y + (random() - .5) * 18, radius = (1.6 + random() * 1.4) * side / 1024
      wrapped(px, py, radius + 1, (qx, qy) => {
        context.fillStyle = tone
        context.beginPath(); context.arc(qx, qy, radius, 0, Math.PI * 2); context.fill()
      })
    }
  }
  return canvas
}

/**
 * Рисованная утоптанная земля: пятна охры и бурого, мягкие мазки, россыпь
 * гальки с тенью и бликом. Тот же повтор без шва, что у травы.
 */
function paintDirt(side) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = side
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const large = periodicNoise(side, 3, 21), middle = periodicNoise(side, 8, 22), small = periodicNoise(side, 19, 23)
  const hex = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16))
  const dark = hex('#6a5038'), light = hex('#8e7353')
  const data = context.createImageData(side, side)
  for (let i = 0; i < side * side; i++) {
    const value = large[i] * .5 + middle[i] * .3 + small[i] * .2
    const t = Math.min(1, Math.max(0, (value - .2) * 1.6))
    for (let c = 0; c < 3; c++) data.data[i * 4 + c] = dark[c] + (light[c] - dark[c]) * t
    data.data[i * 4 + 3] = 255
  }
  context.putImageData(data, 0, 0)
  const random = seeded(31)
  const wrapped = (x, y, reach, draw) => {
    for (const dx of [-side, 0, side]) for (const dy of [-side, 0, side]) {
      if (x + dx < -reach || x + dx > side + reach || y + dy < -reach || y + dy > side + reach) continue
      draw(x + dx, y + dy)
    }
  }
  context.lineCap = 'round'
  for (const layer of [
    { count: 1300, colors: ['rgba(98, 70, 44, .3)', 'rgba(88, 62, 40, .26)'], width: [7, 13], length: [2, 7] },
    { count: 1000, colors: ['rgba(176, 146, 102, .28)', 'rgba(190, 160, 114, .24)'], width: [6, 11], length: [2, 6] },
  ]) {
    for (let i = 0; i < layer.count; i++) {
      const x = random() * side, y = random() * side
      const length = (layer.length[0] + random() * (layer.length[1] - layer.length[0])) * side / 1024
      const angle = random() * Math.PI * 2
      context.strokeStyle = layer.colors[Math.floor(random() * layer.colors.length)]
      context.lineWidth = (layer.width[0] + random() * (layer.width[1] - layer.width[0])) * side / 1024
      wrapped(x, y, length + 6, (px, py) => {
        context.beginPath(); context.moveTo(px, py); context.lineTo(px + Math.cos(angle) * length, py + Math.sin(angle) * length); context.stroke()
      })
    }
  }
  // Галька: тень вниз-вправо, камешек, блик сверху-слева.
  for (let i = 0; i < 170; i++) {
    const x = random() * side, y = random() * side
    const rx = (3 + random() * 6) * side / 1024, ry = rx * (.6 + random() * .35), turn = random() * Math.PI
    const tone = ['#9d9282', '#b4a894', '#8a7e70', '#a89a84'][Math.floor(random() * 4)]
    wrapped(x, y, rx + 3, (px, py) => {
      context.fillStyle = 'rgba(64, 46, 30, .45)'
      context.beginPath(); context.ellipse(px + rx * .25, py + rx * .3, rx, ry, turn, 0, Math.PI * 2); context.fill()
      context.fillStyle = tone
      context.beginPath(); context.ellipse(px, py, rx, ry, turn, 0, Math.PI * 2); context.fill()
      context.fillStyle = 'rgba(255, 248, 230, .35)'
      context.beginPath(); context.ellipse(px - rx * .3, py - ry * .35, rx * .45, ry * .35, turn, 0, Math.PI * 2); context.fill()
    })
  }
  return canvas
}

async function buildFloor(key, floor) {
  let color, normal, orm, height
  if (floor.procedural === 'dirt') {
    color = paintDirt(1024); height = heightFromColor(color, 1024)
    normal = normalFromHeight(height, 3); orm = ormFrom(512, 512, { ao: canvasOf(height, 512), roughnessValue: .95 })
    height = canvasOf(height, 512)
  } else if (floor.procedural === 'grass') {
    color = paintGrass(1024); height = heightFromColor(color, 1024)
    normal = normalFromHeight(height, 2.6); orm = ormFrom(512, 512, { ao: canvasOf(height, 512), roughnessValue: .92 })
    height = canvasOf(height, 512)
  } else if (floor.quaternius) {
    const base = `/source/quaternius-village/tex/${floor.quaternius}_`
    const [c, n, r] = await Promise.all(['BaseColor', 'Normal', 'Roughness'].map((map) => image(`${base}${map}.png`)))
    color = canvasOf(c, 1024); normal = canvasOf(n, 1024); height = heightFromColor(color, 512)
    orm = ormFrom(512, 512, { roughness: canvasOf(r, 512), ao: height })
  } else {
    const c = await image(`/public/${floor.painted}`)
    const side = Math.min(1024, Math.max(512, c.naturalWidth))
    color = canvasOf(c, side); height = heightFromColor(color, side)
    normal = normalFromHeight(height, 3.2); orm = ormFrom(512, 512, { ao: canvasOf(height, 512) })
    height = canvasOf(height, 512)
  }
  for (const [name, canvas, quality] of [['color', color, .86], ['normal', normal, .9], ['orm', orm, .85], ['height', height, .9]]) {
    await post(`floors/${key}/${name}.jpg`, await blob(canvas, quality))
  }
}

// ---------------------------------------------------------- материалы

/**
 * Бесшовность по оси: картинка, сдвинутая на половину, подмешивается только
 * у краёв, где у исходника шов. Середина остаётся нетронутой.
 */
function seamless(canvas, axes) {
  const { width, height } = canvas
  const context = canvas.getContext('2d', { willReadFrequently: true })
  for (const axis of axes) {
    const source = context.getImageData(0, 0, width, height)
    const out = context.createImageData(width, height)
    const size = axis === 'x' ? width : height
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const along = axis === 'x' ? x : y
      const distance = Math.abs(along + .5 - size / 2) / (size / 2)
      const t = Math.min(1, Math.max(0, (distance - .55) / .45))
      const weight = t * t * (3 - 2 * t)
      const sx = axis === 'x' ? (x + width / 2) % width : x
      const sy = axis === 'y' ? (y + height / 2) % height : y
      const i = (y * width + x) * 4, j = (Math.floor(sy) * width + Math.floor(sx)) * 4
      for (let c = 0; c < 4; c++) out.data[i + c] = Math.round(source.data[i + c] * (1 - weight) + source.data[j + c] * weight)
    }
    context.putImageData(out, 0, 0)
  }
  return canvas
}

/** Средний цвет канвы приводится к серому 0.8: оттенок задаёт цвет вершин модели. */
function neutralize(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const data = context.getImageData(0, 0, canvas.width, canvas.height)
  const sum = [0, 0, 0]
  for (let i = 0; i < data.data.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += data.data[i + c]
  const count = data.data.length / 4
  const scale = sum.map((value) => 204 / Math.max(8, value / count))
  for (let i = 0; i < data.data.length; i += 4) for (let c = 0; c < 3; c++) data.data[i + c] = Math.min(255, Math.round(data.data[i + c] * scale[c]))
  context.putImageData(data, 0, 0)
  return canvas
}

/** Средний тон нейтральной фактуры в линейном пространстве: sRGB 0.8. */
const NEUTRAL_LINEAR = Math.pow((.8 + .055) / 1.055, 2.4)


async function buildPaintedMaterial(key, spec) {
  const [w, h] = [spec.rect[2], spec.rect[3]]
  const long = Math.max(w, h)
  const width = Math.round(1024 * w / long), height = Math.round(1024 * h / long)
  const seams = spec.seam ?? 'xy'
  const source = await image(`/source/${spec.color}`)
  const seamed = seamless(canvasOf(source, width, height, spec.rect), seams)
  // Стены сохраняют цвет фактуры; перекрашенные модели получают нейтральную.
  const color = spec.neutral === false ? seamed : neutralize(seamed)
  const normal = spec.normal ? seamless(canvasOf(await image(`/source/${spec.normal}`), width, height, spec.rect), seams) : null
  const ow = Math.max(64, Math.round(width / 2)), oh = Math.max(64, Math.round(height / 2))
  let orm
  if (spec.orm) {
    orm = seamless(canvasOf(await image(`/source/${spec.orm}`), ow, oh, spec.rect), seams)
    if (spec.metalness !== undefined) {
      const context = orm.getContext('2d'); const data = context.getImageData(0, 0, ow, oh)
      for (let i = 0; i < data.data.length; i += 4) data.data[i + 2] = Math.round(Math.max(data.data[i + 2], spec.metalness * 255))
      context.putImageData(data, 0, 0)
    }
  } else {
    const roughness = spec.roughness ? seamless(canvasOf(await image(`/source/${spec.roughness}`), ow, oh, spec.rect), seams) : null
    orm = ormFrom(ow, oh, { roughness, metal: spec.metalness ?? 0, roughnessValue: spec.roughnessValue ?? .85 })
  }
  await post(`materials/${key}/color.jpg`, await blob(color, .86))
  if (normal) await post(`materials/${key}/normal.jpg`, await blob(normal, .9))
  await post(`materials/${key}/orm.jpg`, await blob(orm, .85))
  return { color: true, normal: Boolean(normal), orm: true, metalness: 1, roughness: 1, doubleSided: false, aspect: +(height / width).toFixed(4) }
}

/** Материалы наборов Quaternius: исходные карты, только уменьшенные. */
async function buildKitMaterial(key, kit) {
  const color = await image(kit.color)
  const side = Math.min(1024, color.naturalWidth)
  await post(`materials/${key}/color.jpg`, await blob(canvasOf(color, side), .86))
  if (kit.normal) await post(`materials/${key}/normal.jpg`, await blob(canvasOf(await image(kit.normal), side), .9))
  const half = Math.max(64, side / 2)
  let orm = null
  if (kit.orm && kit.ormKind === 'orm') orm = canvasOf(await image(kit.orm), half)
  else if (kit.orm) orm = ormFrom(half, half, { roughness: canvasOf(await image(kit.orm), half) })
  if (orm) await post(`materials/${key}/orm.jpg`, await blob(orm, .85))
  return { color: true, normal: Boolean(kit.normal), orm: Boolean(orm), metalness: kit.metalness, roughness: kit.roughness, doubleSided: kit.doubleSided }
}

// --------------------------------------------------- классы материалов

const FLAT = /flame|ember|glow|lava|coal-glow|glass|water|liquid|orb|crystal|opening|recess|cavity|shadow|hole|pool|wick|^dark$/i
const CLASS_RULES = [
  ['bark', /bark|кора/i],
  ['plaster', /statue|idol|figure|bust|sculpt|статуя|идол|фигур|бюст|изваян/i],
  ['metal', /iron|metal|brass|bronze|copper|steel|chain|hinge|bolt|screw|nail|washer|blade|wire|winch|lock|rail|gold|silver|coin|hoop|band|rivet|bracket|кольц|желез|металл|латун|бронз|цеп|болт|гвозд|лезви|провол/i],
  ['straw', /straw|hay|thatch|wicker|bristle|reed|broom-head|солом|сено|прут/i],
  ['cloth', /cloth|fabric|canvas|blanket|pillow|cushion|curtain|tent|sail|leather|rope|cord|twine|thread|banner|rug|felt|cork|mattress|sheet|sack|bag|net|upholster|сиден|подушк|подлокот|спинк|обивк|матрас|покрыв|простын|ковр|мешк|мешок|ткан|одеял|подуш|полот|штор|кожа|канат|верёв|бечев/i],
  ['stone', /coal|уголь/i],
  ['brick', /brick|masonry|hearth|fireplace|chimney|oven|forge|furnace|кирп/i],
  ['plaster', /ceramic|clay|pottery|porcelain|bone|skull|plaster|food|bread|cheese|stew|dough|wax|candle|leaf|leaves|grass|moss|plant|flower|petal|fruit|apple|carrot|cabbage|paper|parchment|scroll|map|page|globe/i],
  ['stone', /stone|rock|marble|granite|slab|pillar|capital|groove|niche|grave|tomb|sarcoph|statue|carving|altar|dirt|earth|mortar|cobble|coal|кам|скал|плит|уголь/i],
  ['wood', /wood|plank|board|table|shelf|counter|log|stump|beam|post|frame|leg|handle|lid|seat|chair|wheel|barrel|crate|дерев|доск|ножк|рама|полк|стол|брус|балк|столб|бочк|ящик/i],
]

function classifyByColor(color) {
  const hsl = color.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace)
  if (hsl.s < .16) return 'stone'
  if (hsl.h < .14 || hsl.h > .95) return 'wood'
  return 'cloth'
}

function classify(meshName, material, tint) {
  const name = `${material.name ?? ''}`
  const text = `${meshName} ${name}`
  if (material.transparent || material.opacity < 1 || (material.emissive && material.emissive.getHex() !== 0) || FLAT.test(text)) return 'flat'
  // Общее имя материала (wood, stone…) уточняется деталью: «brick-hearth» с
  // материалом stone — кирпич. Особое имя материала (woodBark) сильнее детали «log».
  const generic = /^(wood|stone|metal|cloth|flat|_defaultMat)?$/i.test(name)
  for (const subject of generic ? [meshName, name] : [name, meshName]) for (const [key, rule] of CLASS_RULES) if (rule.test(subject)) return key
  return classifyByColor(tint)
}

const meanCache = new Map()
/** Средний цвет текстуры в линейном пространстве. */
function textureMean(texture) {
  const source = texture?.image
  if (!source) return new THREE.Color(1, 1, 1)
  if (meanCache.has(source)) return meanCache.get(source)
  const canvas = canvasOf(source, 16)
  const data = canvas.getContext('2d').getImageData(0, 0, 16, 16).data
  const sum = [0, 0, 0]
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += data[i + c]
  const color = new THREE.Color().setRGB(sum[0] / 256 / 255, sum[1] / 256 / 255, sum[2] / 256 / 255, THREE.SRGBColorSpace)
  meanCache.set(source, color)
  return color
}

// --------------------------------------------------------- перекраска

/**
 * Перекраска модели рисованными материалами. Каждый примитив получает класс
 * (дерево, камень, металл…), UV коробочной проекцией в метрах модели — прожилки
 * идут вдоль длинной стороны детали — и цвет вершин, который возвращает
 * исходный оттенок поверх нейтральной фактуры. Свечение, вода и стекло
 * остаются прежними материалами без текстур.
 */
function restyle(root, plan) {
  root.updateMatrixWorld(true)
  const hinges = []
  const markers = []
  root.traverse((object) => {
    if (object === root) return
    if (/^hinge-/.test(object.name) && !hinges.some((hinge) => isInside(object, hinge))) hinges.push(object)
    else if (!object.isMesh && (object.name === 'surface-top' || object.userData?.role)) markers.push(object)
  })
  const group = restyleMeshes(root, plan, (object) => hinges.some((hinge) => isInside(object, hinge)))
  // Откидная крышка и метки поверхности переживают перекраску: доска ищет их по имени.
  for (const hinge of hinges) {
    const world = hinge.matrixWorld.clone()
    const parent = hinge.parent
    parent.remove(hinge)
    hinge.position.set(0, 0, 0); hinge.quaternion.identity(); hinge.scale.set(1, 1, 1)
    const restyled = restyleMeshes(hinge, plan, () => false)
    restyled.name = hinge.name
    restyled.userData = { ...hinge.userData }
    world.decompose(restyled.position, restyled.quaternion, restyled.scale)
    group.add(restyled)
  }
  for (const marker of markers) {
    const copy = new THREE.Object3D()
    copy.name = marker.name
    copy.userData = { ...marker.userData }
    marker.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale)
    group.add(copy)
  }
  return group
}

function isInside(object, ancestor) {
  for (let node = object; node; node = node.parent) if (node === ancestor) return true
  return false
}

function restyleMeshes(root, plan, skip) {
  root.updateMatrixWorld(true)
  const buckets = new Map()
  const flats = []
  let part = 0
  root.traverse((object) => {
    if (!object.isMesh || skip(object)) return
    part += 1
    const materials = Array.isArray(object.material) ? object.material : [object.material]
    const source = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone()
    source.applyMatrix4(object.matrixWorld)
    if (!source.attributes.normal) source.computeVertexNormals()
    const groups = object.geometry.groups.length && Array.isArray(object.material)
      ? object.geometry.groups.map((group) => ({ ...group }))
      : [{ start: 0, count: source.attributes.position.count, materialIndex: 0 }]
    if (object.geometry.index && groups.length > 1) {
      // toNonIndexed сохраняет порядок индексов, поэтому группы остаются теми же диапазонами.
    }
    for (const group of groups) {
      const material = materials[group.materialIndex] ?? materials[0]
      const tint = material.color.clone().multiply(material.map ? textureMean(material.map) : new THREE.Color(1, 1, 1))
      const sourceColor = source.attributes.color
      const kind = classify(object.name, material, tint)
      const positions = source.attributes.position, normals = source.attributes.normal
      const start = group.start, end = Math.min(positions.count, group.start + group.count)
      const count = end - start
      if (count < 3) continue
      const position = new Float32Array(count * 3), normal = new Float32Array(count * 3)
      const color = new Uint8Array(count * 3), uv = new Float32Array(count * 2)
      const box = new THREE.Box3()
      for (let i = start; i < end; i++) box.expandByPoint(new THREE.Vector3(positions.getX(i), positions.getY(i), positions.getZ(i)))
      const size = box.getSize(new THREE.Vector3())
      const longAxis = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2
      const spec = plan.materials[kind]
      const aspect = spec ? spec.rect[3] / spec.rect[2] : 1
      const uMeters = spec ? spec.meters : 1, vMeters = uMeters * aspect
      const offsetU = (part * .618) % 1, offsetV = (part * .382) % 1
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), faceNormal = new THREE.Vector3()
      for (let i = start; i < end; i += 3) {
        a.fromBufferAttribute(positions, i); b.fromBufferAttribute(positions, i + 1); c.fromBufferAttribute(positions, i + 2)
        faceNormal.subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b))
        const n = [Math.abs(faceNormal.x), Math.abs(faceNormal.y), Math.abs(faceNormal.z)]
        const dominant = n[0] >= n[1] && n[0] >= n[2] ? 0 : n[1] >= n[2] ? 1 : 2
        const tangents = [0, 1, 2].filter((axis) => axis !== dominant)
        // Прожилки фактуры идут вдоль u (у коры и ткани — вдоль v) и вдоль длинной стороны детали.
        let grain = tangents.includes(longAxis) ? longAxis : (size.getComponent(tangents[0]) >= size.getComponent(tangents[1]) ? tangents[0] : tangents[1])
        const cross = tangents.find((axis) => axis !== grain)
        const [uAxis, vAxis] = spec?.along === 'v' ? [cross, grain] : [grain, cross]
        for (let k = 0; k < 3; k++) {
          const vertex = i + k, out = vertex - start
          const p = [positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex)]
          position.set(p, out * 3)
          normal.set([normals.getX(vertex), normals.getY(vertex), normals.getZ(vertex)], out * 3)
          uv[out * 2] = p[uAxis] / uMeters + offsetU
          uv[out * 2 + 1] = p[vAxis] / vMeters + offsetV
          const base = sourceColor ? new THREE.Color(sourceColor.getX(vertex), sourceColor.getY(vertex), sourceColor.getZ(vertex)).multiply(tint) : tint
          const scale = kind === 'flat' ? 1 : 1 / NEUTRAL_LINEAR
          color.set([base.r, base.g, base.b].map((value) => Math.round(Math.min(1, value * scale) * 255)), out * 3)
        }
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(position, 3))
      geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
      geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
      geometry.setAttribute('color', new THREE.BufferAttribute(color, 3, true))
      if (kind === 'flat') {
        const flat = new THREE.MeshStandardMaterial({
          name: `flat-${material.name || 'part'}`, color: 0xffffff, vertexColors: true,
          roughness: material.roughness ?? .8, metalness: material.metalness ?? 0,
          emissive: material.emissive ?? new THREE.Color(0), emissiveIntensity: material.emissiveIntensity ?? 1,
          transparent: material.transparent, opacity: material.opacity, side: material.side,
        })
        flats.push(new THREE.Mesh(geometry, flat))
      } else {
        if (!buckets.has(kind)) buckets.set(kind, [])
        buckets.get(kind).push(geometry)
      }
    }
    source.dispose()
  })
  const group = new THREE.Group()
  for (const [kind, geometries] of buckets) {
    const merged = mergeVertices(mergeGeometries(geometries, false), 1e-5)
    geometries.forEach((geometry) => geometry.dispose())
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ name: `skz:${kind}`, vertexColors: true }))
    mesh.name = kind
    group.add(mesh)
    plan.usedPainted.add(kind)
  }
  for (const mesh of flats) group.add(mesh)
  return group
}

// ------------------------------------------------------------- детали

const loader = new GLTFLoader()
const kitCache = new Map()

/** Ключ общего материала набора по имени текстуры цвета: T_Trim_Furniture_BaseColor → kit-trim-furniture. */
function kitKey(texture) {
  const name = (texture.name || texture.image?.src?.split('/').pop() || 'unknown').replace(/\.png$/i, '')
  return `kit-${name.replace(/^T_/, '').replace(/_(BaseColor|Diffuse)$/i, '').replace(/_/g, '-').toLowerCase()}`
}

async function kitPart(path, plan) {
  // GLTFLoader в Chrome декодирует в ImageBitmap без адреса: файл восстанавливается по имени картинки.
  const folder = path.split('/')[0]
  const imageUrl = (texture) => texture?.name ? `/source/${folder}/${texture.name}.png` : null
  if (!kitCache.has(path)) kitCache.set(path, loader.loadAsync(`/source/${path}.gltf`))
  const gltf = await kitCache.get(path)
  const scene = gltf.scene.clone(true)
  scene.traverse((object) => {
    if (!object.isMesh) return
    const convert = (material) => {
      if (!material.map) return material.clone()
      const key = kitKey(material.map)
      if (!plan.kits.has(key)) {
        const ormTexture = material.metalnessMap ?? material.roughnessMap
        plan.kits.set(key, {
          color: imageUrl(material.map), normal: imageUrl(material.normalMap), orm: imageUrl(ormTexture),
          ormKind: /orm/i.test(ormTexture?.name ?? imageUrl(ormTexture) ?? '') ? 'orm' : 'roughness',
          metalness: material.metalnessMap ? material.metalness : 0, roughness: material.roughness, doubleSided: material.side === THREE.DoubleSide,
        })
      }
      return new THREE.MeshStandardMaterial({ name: `skz:${key}`, vertexColors: Boolean(object.geometry.attributes.color), side: material.side })
    }
    object.material = Array.isArray(object.material) ? object.material.map(convert) : convert(object.material)
  })
  return scene
}

async function restylePart(path, plan) {
  const [release, ...rest] = path.split('/')
  const id = release === 'old' ? 'bd5c4563074b6e4ef576769c' : plan.release
  const gltf = await loader.loadAsync(`/public/models/environment/releases/${id}/${rest.join('/')}.glb`)
  return restyle(gltf.scene, plan)
}

const detailModules = ['workshop', 'household', 'town', 'dungeon', 'mine-camp', 'urban-wilderness']
let detailFactories = null
async function detailPart(id, plan) {
  detailFactories ??= await Promise.all(detailModules.map((name) => import(`/tools/map-detail-models-${name}.mjs`)))
  const factory = detailFactories.find((module) => module.MODEL_IDS.includes(id))
  if (!factory) throw new Error(`нет рецепта детали ${id}`)
  const root = factory.createModel(id)
  root.updateMatrixWorld(true)
  // Те же размеры, что у прежней модели набора: силуэт и пропорции не меняются.
  const spec = plan.detailDimensions[id]
  if (spec) {
    const bounds = new THREE.Box3().setFromObject(root, true)
    const size = bounds.getSize(new THREE.Vector3())
    root.scale.multiply(new THREE.Vector3(spec[0] / size.x, spec[2] / size.y, spec[1] / size.z))
  }
  const restyled = restyle(root, plan)
  root.traverse((object) => { if (object.isMesh) object.geometry.dispose() })
  return restyled
}

async function buildRecipe(recipe, plan) {
  const root = new THREE.Group()
  const placed = []
  for (const part of recipe.parts) {
    const object = part.kit ? await kitPart(part.kit, plan) : part.restyle ? await restylePart(part.restyle, plan) : await detailPart(part.detail, plan)
    const holder = new THREE.Group()
    holder.add(object)
    if (part.tilt) object.rotation.set(...part.tilt.map((degrees) => degrees * Math.PI / 180))
    const scale = part.scale ?? 1
    holder.scale.set(...(Array.isArray(scale) ? scale : [scale, scale, scale]))
    holder.rotation.y = (part.yaw ?? 0) * Math.PI / 180
    // Деталь ставится основанием на землю (или на верх опоры) — у моделей Quaternius ноль бывает не у основания.
    holder.updateMatrixWorld(true)
    const own = new THREE.Box3().setFromObject(holder, true)
    const at = part.at ?? [0, 0, 0]
    let floor = 0
    if (part.on !== undefined) floor = placed[part.on].max.y
    // `native` — деталь уже стоит на своём месте в координатах набора (ящики под верстаком).
    holder.position.set(at[0], at[1] + (part.native ? 0 : floor - own.min.y), at[2])
    root.add(holder)
    holder.updateMatrixWorld(true)
    placed.push(new THREE.Box3().setFromObject(holder, true))
  }
  // Стол с вещами сверху: высота столешницы — верх опоры, а не макушка свечи.
  if (recipe.parts.some((part) => part.on === 0) && !root.getObjectByName('surface-top')) {
    const top = new THREE.Object3D()
    top.name = 'surface-top'
    top.userData = { role: 'support-surface' }
    top.position.set((placed[0].min.x + placed[0].max.x) / 2, placed[0].max.y, (placed[0].min.z + placed[0].max.z) / 2)
    root.add(top)
  }
  return root
}

function triangles(root) {
  let total = 0
  root.traverse((object) => { if (object.isMesh) total += (object.geometry.index ? object.geometry.index.count : object.geometry.attributes.position.count) / 3 })
  return total
}

async function exportProp(name, root) {
  const glb = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true })
  await post(`props/${name}.glb`, glb)
  return glb.byteLength
}

// ----------------------------------------------------------- сборка

async function build() {
  const plan = await (await fetch('/plan.json')).json()
  const source = plan.style
  plan.materials = source.materials
  plan.usedPainted = new Set()
  plan.kits = new Map()
  const only = new URLSearchParams(location.search).get('only')
  // Полная сборка начинается с чистого staging: от прошлых прогонов не остаётся лишних файлов.
  if (!only) await fetch('/reset', { method: 'POST' })
  if (!only) for (const [key, floor] of Object.entries(source.floors)) { await buildFloor(key, floor); log(`пол ${key}`) }
  plan.detailDimensions = Object.fromEntries((await (await fetch('/public/maps/detail-v1/manifest.json')).json()).models.map((model) => [model.id, model.dimensions]))
  const done = new Set()
  const built = {}
  for (const [assetId, list] of Object.entries(source.props)) for (const recipe of list) {
    if (!recipe.parts || done.has(recipe.name)) continue
    if (only && !new RegExp(only).test(recipe.name)) continue
    done.add(recipe.name)
    try {
      const root = await buildRecipe(recipe, plan)
      const bytes = await exportProp(recipe.name, root)
      built[recipe.name] = { triangles: triangles(root), bytes }
      log(`${assetId}: ${recipe.name} — ${triangles(root)} треуг., ${(bytes / 1024).toFixed(0)} КБ`)
    } catch (error) {
      log(`ОШИБКА ${recipe.name}: ${error.message ?? error}`)
      throw error
    }
  }
  const materials = {}
  // Материалы видов стен собираются, даже если ни одна модель их не берёт.
  for (const look of Object.values(source.walls ?? {})) if (source.materials[look.material]) plan.usedPainted.add(look.material)
  for (const key of [...plan.usedPainted].sort()) { materials[key] = await buildPaintedMaterial(key, source.materials[key]); log(`материал ${key}`) }
  for (const [key, kit] of [...plan.kits].sort()) { materials[key] = await buildKitMaterial(key, kit); log(`материал ${key}`) }
  await post('meta.json', JSON.stringify({ materials, built }))
  if (only) { log('Частичная сборка: пакет не публикуется'); document.title = 'done'; return }
  const response = await fetch('/finish', { method: 'POST', body: JSON.stringify({ materials, built }) })
  log(`Готово: ${await response.text()}`)
}

async function rebuildFloors(keys) {
  const plan = await (await fetch('/plan.json')).json()
  for (const key of keys) { await buildFloor(key, plan.style.floors[key]); log(`пол ${key}`) }
  const response = await fetch('/merge', { method: 'POST' })
  log(`Готово: ${await response.text()}`)
  document.title = 'done'
}

document.getElementById('build').addEventListener('click', () => build().catch((error) => log(`Ошибка: ${error.stack ?? error}`)))
if (new URLSearchParams(location.search).has('floors')) rebuildFloors(new URLSearchParams(location.search).get('floors').split(',')).catch((error) => log(`Ошибка: ${error.stack ?? error}`))
if (new URLSearchParams(location.search).has('auto')) build().catch((error) => log(`Ошибка: ${error.stack ?? error}`)).finally(() => { document.title = 'done' })
// ?paint — снимок рисованной травы без сборки пакета: для подбора цветов.
if (new URLSearchParams(location.search).has('paint')) {
  const kind = new URLSearchParams(location.search).get('paint') === 'dirt' ? 'dirt' : 'grass'
  const canvas = kind === 'dirt' ? paintDirt(1024) : paintGrass(1024)
  canvas.toBlob((png) => fetch(`/shot?name=${kind}-paint`, { method: 'POST', body: png }).then(() => { document.title = 'painted' }), 'image/png')
}
