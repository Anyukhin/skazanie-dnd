#!/usr/bin/env node
/** Детерминированные локальные карточки фокусов, компонентов и инструментов. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { encodePng } from './png-codec.mjs'

const SIDE = 512
const OUTPUT = fileURLToPath(new URL('../public/assets/items/', import.meta.url))
const PREFIX = 'item-srd-5-2-1-'

const KEYS = Object.freeze([
  'arcane-focus-crystal', 'arcane-focus-orb', 'arcane-focus-rod', 'arcane-focus-staff', 'arcane-focus-wand',
  'component-pouch', 'diamond-50gp',
  'druidic-focus-mistletoe', 'druidic-focus-totem', 'druidic-focus-wooden-staff', 'druidic-focus-yew-wand',
  'holy-symbol-amulet', 'holy-symbol-emblem', 'holy-symbol-reliquary',
  'material-circle-of-death-500gp', 'material-dawn-100gp', 'material-diamond-dust-100gp', 'material-shadow-of-moil-150gp',
  'material-summon-aberration-400gp', 'material-summon-beast-200gp', 'material-summon-celestial-500gp',
  'material-summon-construct-400gp', 'material-summon-draconic-spirit-500gp', 'material-summon-elemental-400gp',
  'material-summon-fey-300gp', 'material-summon-fiend-600gp', 'material-summon-shadowspawn-300gp', 'material-summon-undead-300gp',
  'bagpipes', 'drum', 'dulcimer', 'flute', 'lute', 'lyre', 'horn', 'pan-flute', 'shawm', 'viol',
])

const PALETTES = Object.freeze({
  arcane: ['#181426', '#39275c', '#70c2e8', '#d9f4ff'],
  druid: ['#151c16', '#334c32', '#84a95b', '#e3dec0'],
  holy: ['#211b16', '#5e4630', '#d8aa4e', '#fff0b2'],
  material: ['#17161c', '#39354a', '#9885b7', '#e5d9ef'],
  instrument: ['#1c1511', '#513522', '#bd7b3f', '#f0d09c'],
})

function rgb(value) {
  const hex = value.slice(1)
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16), 255]
}

function hash32(value) {
  return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16) >>> 0
}

function paletteFor(key) {
  if (key.startsWith('arcane-')) return PALETTES.arcane
  if (key.startsWith('druidic-')) return PALETTES.druid
  if (key.startsWith('holy-')) return PALETTES.holy
  if (['bagpipes', 'drum', 'dulcimer', 'flute', 'lute', 'lyre', 'horn', 'pan-flute', 'shawm', 'viol'].includes(key)) return PALETTES.instrument
  return PALETTES.material
}

function canvas(key) {
  const data = new Uint8Array(SIDE * SIDE * 4)
  const colors = paletteFor(key).map(rgb)
  let seed = hash32(key)
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    return (seed >>> 0) / 0xffffffff
  }
  for (let y = 0; y < SIDE; y += 1) {
    for (let x = 0; x < SIDE; x += 1) {
      const radial = Math.min(1, Math.hypot(x - 256, y - 240) / 360)
      const noise = Math.floor((random() - .5) * 26)
      const index = (y * SIDE + x) * 4
      for (let channel = 0; channel < 3; channel += 1) data[index + channel] = Math.max(0, Math.min(255, colors[0][channel] * (1 - radial * .45) + noise))
      data[index + 3] = 255
    }
  }
  return { width: SIDE, height: SIDE, data, colors }
}

function blend(image, x, y, color, alpha = 1) {
  const ix = Math.round(x); const iy = Math.round(y)
  if (ix < 0 || iy < 0 || ix >= SIDE || iy >= SIDE) return
  const at = (iy * SIDE + ix) * 4
  for (let channel = 0; channel < 3; channel += 1) image.data[at + channel] = Math.round(image.data[at + channel] * (1 - alpha) + color[channel] * alpha)
}

function circle(image, cx, cy, radius, color, alpha = 1) {
  const r2 = radius * radius
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
    const distance = (x - cx) ** 2 + (y - cy) ** 2
    if (distance <= r2) blend(image, x, y, color, alpha * Math.min(1, (r2 - distance) / Math.max(1, radius * 2)))
  }
}

function line(image, x1, y1, x2, y2, width, color, alpha = 1) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1))
  for (let step = 0; step <= steps; step += 1) {
    const at = step / Math.max(1, steps)
    circle(image, x1 + (x2 - x1) * at, y1 + (y2 - y1) * at, width / 2, color, alpha)
  }
}

function rect(image, x, y, width, height, color, alpha = 1) {
  for (let iy = y; iy < y + height; iy += 1) for (let ix = x; ix < x + width; ix += 1) blend(image, ix, iy, color, alpha)
}

function halo(image) {
  for (let radius = 150; radius > 80; radius -= 3) circle(image, 256, 245, radius, image.colors[2], .003)
}

function gem(image, cx = 256, cy = 245, size = 100) {
  const points = [[cx, cy - size], [cx + size * .72, cy - size * .2], [cx + size * .48, cy + size], [cx - size * .48, cy + size], [cx - size * .72, cy - size * .2], [cx, cy - size]]
  for (let index = 1; index < points.length; index += 1) line(image, ...points[index - 1], ...points[index], 20, image.colors[2])
  for (const point of points.slice(0, -1)) line(image, cx, cy + 12, ...point, 7, image.colors[3], .8)
}

function staff(image, wand = false) {
  line(image, 210, wand ? 360 : 420, 302, wand ? 150 : 95, wand ? 25 : 34, image.colors[1])
  circle(image, 310, wand ? 137 : 82, wand ? 38 : 46, image.colors[2])
  circle(image, 310, wand ? 137 : 82, wand ? 20 : 26, image.colors[3], .8)
}

function wand(image) {
  line(image, 205, 380, 305, 130, 14, image.colors[1])
  line(image, 214, 358, 294, 158, 5, image.colors[2], .8)
  circle(image, 309, 120, 22, image.colors[2])
  circle(image, 309, 120, 9, image.colors[3], .85)
}

function rod(image) {
  line(image, 222, 395, 286, 145, 40, image.colors[1])
  for (const offset of [0, 62, 124]) line(image, 217 + offset * .25, 388 - offset, 250 + offset * .25, 397 - offset, 9, image.colors[2])
  gem(image, 300, 121, 45)
}

function solarRune(image, cx, cy, radius, color = image.colors[3]) {
  circle(image, cx, cy, radius * .34, color)
  for (let index = 0; index < 8; index += 1) {
    const angle = index * Math.PI / 4
    line(image,
      cx + Math.cos(angle) * radius * .5, cy + Math.sin(angle) * radius * .5,
      cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius,
      Math.max(8, radius * .14), color)
  }
}

function holy(image, kind) {
  if (kind === 'amulet') {
    circle(image, 256, 280, 86, image.colors[2]); circle(image, 256, 280, 62, image.colors[0])
    line(image, 175, 105, 256, 220, 14, image.colors[2]); line(image, 337, 105, 256, 220, 14, image.colors[2])
  } else if (kind === 'emblem') {
    circle(image, 256, 250, 125, image.colors[1]); circle(image, 256, 250, 112, image.colors[2]); circle(image, 256, 250, 93, image.colors[0])
  } else {
    rect(image, 170, 155, 172, 230, image.colors[2]); rect(image, 191, 179, 130, 174, image.colors[0]); line(image, 170, 155, 256, 88, 25, image.colors[2]); line(image, 342, 155, 256, 88, 25, image.colors[2])
  }
  solarRune(image, 256, kind === 'reliquary' ? 265 : 260, kind === 'reliquary' ? 57 : 66)
}

function pouch(image) {
  circle(image, 256, 280, 118, image.colors[1]); rect(image, 150, 155, 212, 100, image.colors[1]); line(image, 170, 210, 342, 210, 22, image.colors[2])
  for (const x of [205, 256, 307]) circle(image, x, 212, 11, image.colors[3])
}

function vial(image, color = image.colors[2]) {
  rect(image, 205, 150, 102, 34, image.colors[3])
  rect(image, 192, 184, 128, 178, color)
  circle(image, 256, 330, 64, color)
  line(image, 194, 205, 318, 205, 12, image.colors[3])
}

function skull(image) {
  circle(image, 256, 240, 108, image.colors[2])
  rect(image, 208, 300, 96, 66, image.colors[2])
  for (const x of [220, 292]) circle(image, x, 230, 25, image.colors[0])
  gem(image, 256, 280, 22)
  for (const x of [228, 256, 284]) line(image, x, 327, x, 365, 9, image.colors[0])
}

function material(image, key) {
  if (key === 'diamond-50gp') return gem(image, 256, 250, 92)
  if (key === 'material-diamond-dust-100gp') {
    vial(image, image.colors[1])
    for (const [x, y, r] of [[218, 318, 13], [251, 292, 17], [283, 328, 11], [292, 272, 8], [230, 260, 9]]) circle(image, x, y, r, image.colors[3])
    return
  }
  if (key === 'material-circle-of-death-500gp') {
    circle(image, 256, 330, 105, image.colors[2]); circle(image, 256, 315, 92, image.colors[0])
    for (const [x, y, r] of [[210, 295, 13], [242, 340, 18], [282, 302, 15], [305, 350, 11], [190, 350, 9]]) circle(image, x, y, r, image.colors[1])
    return
  }
  if (key === 'material-dawn-100gp') {
    line(image, 170, 105, 256, 205, 13, image.colors[2]); line(image, 342, 105, 256, 205, 13, image.colors[2])
    circle(image, 256, 270, 82, image.colors[1]); solarRune(image, 256, 270, 72)
    return
  }
  if (key === 'material-shadow-of-moil-150gp') {
    gem(image, 256, 255, 120)
    circle(image, 256, 265, 50, image.colors[3]); circle(image, 256, 265, 29, image.colors[0]); circle(image, 246, 253, 8, image.colors[2])
    return
  }
  if (key === 'material-summon-aberration-400gp') {
    vial(image)
    circle(image, 270, 240, 27, image.colors[3]); circle(image, 270, 240, 13, image.colors[0])
    line(image, 220, 340, 238, 255, 18, image.colors[3]); line(image, 238, 255, 216, 220, 18, image.colors[3]); line(image, 238, 255, 252, 215, 15, image.colors[3])
    return
  }
  if (key === 'material-summon-beast-200gp') {
    circle(image, 256, 292, 82, image.colors[2]); line(image, 205, 250, 256, 155, 34, image.colors[2]); line(image, 307, 250, 256, 155, 34, image.colors[2])
    line(image, 175, 350, 235, 190, 22, image.colors[3]); for (const y of [235, 275, 315]) line(image, 185, y, 226, y - 20, 11, image.colors[3])
    return
  }
  if (key === 'material-summon-celestial-500gp') {
    rect(image, 180, 180, 152, 198, image.colors[2]); line(image, 180, 180, 256, 105, 24, image.colors[2]); line(image, 332, 180, 256, 105, 24, image.colors[2]); solarRune(image, 256, 280, 66)
    return
  }
  if (key === 'material-summon-construct-400gp') {
    rect(image, 160, 205, 192, 160, image.colors[2]); rect(image, 170, 170, 172, 60, image.colors[1]); line(image, 160, 230, 352, 230, 14, image.colors[3]); circle(image, 256, 285, 30, image.colors[3]); rect(image, 246, 285, 20, 50, image.colors[3])
    return
  }
  if (key === 'material-summon-draconic-spirit-500gp') {
    circle(image, 256, 270, 118, image.colors[1]); line(image, 256, 328, 256, 190, 22, image.colors[3]); line(image, 256, 205, 178, 155, 26, image.colors[3]); line(image, 256, 205, 334, 155, 26, image.colors[3]); line(image, 256, 280, 190, 335, 22, image.colors[3]); line(image, 256, 280, 322, 335, 22, image.colors[3]); circle(image, 256, 185, 30, image.colors[2])
    return
  }
  if (key === 'material-summon-elemental-400gp') {
    vial(image)
    line(image, 195, 275, 317, 275, 10, image.colors[3]); line(image, 256, 205, 256, 360, 10, image.colors[3])
    circle(image, 225, 240, 14, image.colors[3]); circle(image, 286, 240, 18, image.colors[0]); line(image, 205, 322, 238, 302, 11, image.colors[3]); line(image, 238, 302, 250, 330, 11, image.colors[3]); circle(image, 286, 320, 22, image.colors[3])
    return
  }
  if (key === 'material-summon-fey-300gp') {
    for (let index = 0; index < 6; index += 1) { const angle = index * Math.PI / 3; circle(image, 256 + Math.cos(angle) * 65, 245 + Math.sin(angle) * 65, 48, image.colors[2]) }
    circle(image, 256, 245, 46, image.colors[3]); line(image, 256, 285, 256, 400, 20, image.colors[2]); line(image, 256, 340, 200, 310, 17, image.colors[2])
    return
  }
  if (key === 'material-summon-fiend-600gp') {
    vial(image, rgb('#7b2635'))
    line(image, 215, 175, 185, 118, 20, image.colors[3]); line(image, 297, 175, 327, 118, 20, image.colors[3]); circle(image, 256, 290, 35, rgb('#d15b61'))
    return
  }
  if (key === 'material-summon-shadowspawn-300gp') {
    gem(image, 256, 250, 120); circle(image, 256, 250, 35, image.colors[0]); line(image, 256, 220, 235, 270, 18, image.colors[3]); line(image, 235, 270, 256, 292, 18, image.colors[3]); line(image, 256, 292, 277, 270, 18, image.colors[3]); line(image, 277, 270, 256, 220, 18, image.colors[3])
    return
  }
  if (key === 'material-summon-undead-300gp') return skull(image)
}

function instrument(image, key) {
  const wood = image.colors[2]; const light = image.colors[3]; const dark = image.colors[1]
  if (key === 'drum') {
    circle(image, 256, 255, 125, light); circle(image, 256, 255, 105, dark)
    for (let index = 0; index < 8; index += 1) { const a = index * Math.PI / 4; line(image, 256, 255, 256 + Math.cos(a) * 105, 255 + Math.sin(a) * 105, 8, wood) }
  } else if (key === 'flute' || key === 'shawm' || key === 'pan-flute') {
    if (key === 'pan-flute') for (let index = 0; index < 7; index += 1) line(image, 170 + index * 28, 360, 170 + index * 28, 135 + index * 18, 20, index % 2 ? light : wood)
    else { line(image, 190, 390, 320, 105, key === 'flute' ? 23 : 32, wood); for (let i = 0; i < 6; i += 1) circle(image, 216 + i * 18, 332 - i * 40, 8, light) }
  } else if (key === 'horn') {
    line(image, 170, 355, 205, 180, 38, wood); line(image, 205, 180, 350, 145, 52, wood); circle(image, 362, 142, 52, light); circle(image, 362, 142, 28, image.colors[0])
  } else if (key === 'bagpipes') {
    circle(image, 235, 295, 110, dark); circle(image, 270, 275, 90, wood)
    for (const x of [205, 255, 305]) line(image, x, 250, x + 25, 85, 24, light)
  } else if (key === 'dulcimer') {
    for (const [a, b] of [[[160,350],[210,130]], [[210,130],[330,130]], [[330,130],[370,350]], [[370,350],[160,350]]]) line(image, ...a, ...b, 30, wood)
    for (const x of [210, 240, 270, 300, 330]) line(image, x, 145, 256 + (x - 270) * .7, 335, 7, light)
  } else if (key === 'lyre') {
    line(image, 190, 360, 170, 145, 34, wood); line(image, 322, 360, 342, 145, 34, wood); line(image, 170, 145, 342, 145, 34, wood); circle(image, 256, 360, 75, dark)
    for (const x of [205, 230, 256, 282, 307]) line(image, x, 165, 256 + (x - 256) * .4, 350, 7, light)
  } else {
    circle(image, 235, 315, key === 'viol' ? 96 : 115, wood); circle(image, 277, 235, key === 'viol' ? 74 : 88, wood); line(image, 285, 235, 320, 75, 36, dark); rect(image, 292, 55, 80, 45, dark)
    for (const x of [250, 270, 290]) line(image, x, 365, x + 45, 75, 6, light)
  }
}

function draw(image, key) {
  halo(image)
  if (key === 'component-pouch') return pouch(image)
  if (key.startsWith('material-') || key === 'diamond-50gp') return material(image, key)
  if (key.startsWith('holy-symbol-')) return holy(image, key.slice('holy-symbol-'.length))
  if (key.includes('staff')) return staff(image, false)
  if (key.includes('wand')) return wand(image)
  if (key === 'arcane-focus-crystal') return gem(image)
  if (key === 'arcane-focus-orb') { circle(image, 256, 245, 120, image.colors[2]); circle(image, 230, 215, 55, image.colors[3], .55); return }
  if (key === 'arcane-focus-rod') return rod(image)
  if (key === 'druidic-focus-mistletoe') {
    line(image, 250, 395, 270, 125, 24, image.colors[1]); for (const [x, y] of [[195,190],[320,165],[190,270],[325,250]]) { line(image, 260, y + 25, x, y, 17, image.colors[2]); circle(image, x, y, 38, image.colors[2]) } return
  }
  if (key === 'druidic-focus-totem') { staff(image, true); circle(image, 315, 130, 52, image.colors[2]); line(image, 280, 85, 245, 55, 18, image.colors[3]); line(image, 340, 85, 380, 55, 18, image.colors[3]); return }
  return instrument(image, key)
}

mkdirSync(OUTPUT, { recursive: true })
for (const key of KEYS) {
  const file = `${OUTPUT}${PREFIX}${key}.png`
  if (existsSync(file) && !process.argv.includes('--force')) continue
  const image = canvas(key)
  draw(image, key)
  writeFileSync(file, encodePng(image))
}
process.stdout.write(`${JSON.stringify({ generated: KEYS.length, directory: OUTPUT }, null, 2)}\n`)
