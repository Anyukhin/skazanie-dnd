#!/usr/bin/env node
/**
 * Просмотр сгенерированной тактической карты текстом — без кампании и браузера.
 *
 *   pnpm maps:preview -- --location "Таверна «Рог»" --theme таверна
 *   node tools/map-preview.mjs --location "Деревня Кленовка" --theme деревня --settlement village --seed s1
 *   node tools/map-preview.mjs --preset all --audit      # эталонные сцены, только сводка проверок
 *
 * Клетка — два символа по горизонтали, рёбра между клетками рисуются
 * отдельными символами: «|» и «-» — стена, «D» — дверь, «w» — окно,
 * «:» — перила/уступ. Пол: «.» помещение, «,» улица, «~» вода, «#» глухая
 * клетка. Предметы — буквой из легенды под картой. «@» — точка входа отряда.
 *
 * Сводка внизу — та же проверка качества, что гоняют тесты
 * (`server/map-quality.mjs`): двери, окна, комнаты, досягаемость, предметы
 * за краем и в дверях.
 */
import { generateSceneGeometry } from '../server/adventure-director.mjs'
import { cellAt, edgeBetween } from '../server/tactical-map.mjs'
import { MAP_PREVIEW_PRESETS, auditTacticalMap } from '../server/map-quality.mjs'
import { pathToFileURL } from 'node:url'
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
/** @param {string} name */
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}
const has = (/** @type {string} */ name) => args.includes(`--${name}`)

const GLYPHS = /** @type {Record<string, string>} */ ({
  table_round: 'T', table_long: 'T', table_small: 't', table_royal: 'T', bench: 'b', chair: 'h', stool: 'h',
  bar_counter: '=', bar_shelf: '[', fireplace: 'F', hearth_fire: 'F', cauldron: 'c', barrel: 'o', barrel_stack: 'O', keg: 'o',
  crate: 'x', crate_stack: 'X', sack: 's', chest: 'C', cupboard: '[', wardrobe: '[', bookshelf: '[', shelf_wall: '[',
  bed: 'B', bunk_bed: 'B', night_table: 'n', washbasin: 'u', stairs_up: '^', stairs_down: 'v', trapdoor: 'v',
  tree_oak: 'Y', tree_pine: 'Y', tree_birch: 'Y', tree_dead: 'Y', tree_spruce: 'Y', tree_stump: 'y', bush: '*', shrub: '*',
  rock_small: 'r', boulder: 'R', well: 'W', water_trough: '_', market_stall: 'M', cart: 'K', campfire: 'f', haystack: 'H',
  altar: 'A', statue: 'S', pillar: 'I', sarcophagus: 'Z', grave: '+', village_fence: '%', rail_fence: '%', lamp_post: 'l',
  signpost: 'P', door_closed: 'D', door_open: 'D', rug: '~',
})

/**
 * @param {any} map
 * @returns {string}
 */
export function renderAscii(map) {
  const width = map.width
  const height = map.height
  /** @type {string[][]} */
  const canvas = Array.from({ length: height * 2 + 1 }, () => Array.from({ length: width * 3 + 1 }, () => ' '))
  const propAt = new Map()
  for (const prop of map.props ?? []) {
    const cells = prop.footprint?.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]
    for (const cell of cells) if (!propAt.has(`${cell.x},${cell.y}`)) propAt.set(`${cell.x},${cell.y}`, prop.assetId)
  }
  const party = (map.spawnPoints ?? []).find((/** @type {any} */ point) => point.role === 'party')
  const zones = new Map((map.zones ?? []).map((/** @type {any} */ zone) => [zone.id, zone]))
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cell = cellAt(map, x, y)
      const row = y * 2 + 1
      const col = x * 3 + 1
      if (!cell) continue
      const zone = zones.get(cell.zone)
      let floor = zone?.kind === 'interior' ? '.' : ','
      if (cell.surface === 'water') floor = '~'
      if (!cell.passable) floor = '#'
      const asset = propAt.get(`${x},${y}`)
      const glyph = party && party.x === x && party.y === y ? '@' : asset ? (GLYPHS[asset] ?? '?') : floor
      canvas[row][col] = glyph
      canvas[row][col + 1] = cell.elevation ? String(Math.min(9, Math.round(Math.abs(cell.elevation) / 5))) : (asset ? glyph : floor)
      const east = edgeBetween(map, x, y, x + 1, y)
      const south = edgeBetween(map, x, y, x, y + 1)
      const west = x === 0 ? edgeBetween(map, x - 1, y, x, y) : null
      const north = y === 0 ? edgeBetween(map, x, y - 1, x, y) : null
      const mark = (/** @type {any} */ edge, /** @type {string} */ wall) => !edge ? null
        : edge.kind === 'wall' ? wall : edge.kind === 'door' ? 'D' : edge.kind === 'window' ? 'w' : ':'
      const e = mark(east, '|')
      if (e) canvas[row][col + 2] = e
      const w = mark(west, '|')
      if (w) canvas[row][col - 1] = w
      const s = mark(south, '-')
      if (s) { canvas[row + 1][col] = s; canvas[row + 1][col + 1] = s === '-' ? '-' : s }
      const n = mark(north, '-')
      if (n) { canvas[row - 1][col] = n; canvas[row - 1][col + 1] = n === '-' ? '-' : n }
    }
  }
  // Углы стен — там, где сходятся стены.
  for (let row = 0; row < canvas.length; row += 2) {
    for (let col = 0; col < canvas[0].length; col += 3) {
      const near = [canvas[row][col - 1], canvas[row][col + 1], canvas[row - 1]?.[col], canvas[row + 1]?.[col]]
      if (near.some((symbol) => symbol === '-' || symbol === '|' || symbol === 'D' || symbol === 'w')) canvas[row][col] = '+'
    }
  }
  return canvas.map((line) => line.join('').replace(/\s+$/u, '')).filter((line, index, all) => line || index < all.length - 1).join('\n')
}

/** @param {Array<{code: string, detail?: string}>} problems */
function summarizeProblems(problems) {
  if (!problems.length) return 'чисто'
  /** @type {Map<string, {count: number, first: string}>} */
  const grouped = new Map()
  for (const problem of problems) {
    const entry = grouped.get(problem.code) ?? { count: 0, first: problem.detail ?? '' }
    entry.count += 1
    grouped.set(problem.code, entry)
  }
  return [...grouped].map(([code, entry]) => `${code}×${entry.count}${entry.first ? ` [${entry.first}]` : ''}`).join('; ')
}

/** Размеры карты для прогона: маленькая хижина, обычная сцена, большая. */
const SIZES = Object.freeze({
  small: { width: 16, height: 14 },
  medium: { width: 26, height: 26 },
  large: { width: 40, height: 32 },
})

function printOne(input, { audit = true, ascii = true } = {}) {
  const geometry = generateSceneGeometry(input)
  const map = geometry.map
  const report = auditTacticalMap(map)
  const header = `== ${input.location} | тема ${map.theme} | ${map.width}×${map.height} | генератор ${map.generator?.id ?? '?'} | сид ${input.seed}`
  console.log(header)
  if (ascii) {
    console.log(renderAscii(map))
    const zones = (map.zones ?? []).filter((/** @type {any} */ zone) => zone.label).map((/** @type {any} */ zone) => `${zone.label}(${zone.kind === 'interior' ? 'в' : 'у'})`)
    console.log(`зоны: ${zones.join(', ')}`)
  }
  if (audit) {
    console.log(`проверка: ${summarizeProblems(report.problems)}`)
    if (report.warnings.length) console.log(`  замечания: ${summarizeProblems(report.warnings)}`)
    console.log(`  ${Object.entries(report.stats).map(([key, value]) => `${key}=${value}`).join(' ')}`)
  }
  return { map, report }
}

// Печать — только при прямом запуске: `renderAscii` импортируют и снаружи.
const direct = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
const preset = direct ? flag('preset') : undefined
if (!direct) {
  // импорт как модуля: ничего не печатаем
} else if (preset) {
  const seeds = (flag('seeds') ?? 's1,s2,s3').split(',')
  const sizeNames = (flag('sizes') ?? 'medium').split(',').flatMap((name) => name === 'all' ? Object.keys(SIZES) : [name])
  const scenes = preset === 'all' ? MAP_PREVIEW_PRESETS : MAP_PREVIEW_PRESETS.filter((scene) => preset.split(',').includes(scene.id))
  /** @type {Record<string, number>} */
  const totals = {}
  /** @type {Record<string, number>} */
  const warningTotals = {}
  /** @type {Array<{id: string, label: string, size: string, seed: string, map: any, report: any}>} */
  const gallery = []
  for (const scene of scenes) {
    for (const size of sizeNames) {
      for (const seed of seeds) {
        const { map, report } = printOne({ ...scene.input, map: { ...(scene.input.map ?? {}), ...SIZES[/** @type {keyof typeof SIZES} */ (size)] }, seed: `${scene.id}:${seed}`, useLibrary: false }, { audit: true, ascii: !has('audit') })
        for (const problem of report.problems) totals[problem.code] = (totals[problem.code] ?? 0) + 1
        for (const warning of report.warnings) warningTotals[warning.code] = (warningTotals[warning.code] ?? 0) + 1
        gallery.push({ id: scene.id, label: scene.input.location, size, seed, map, report })
      }
    }
  }
  console.log(`\nИтого проблем: ${JSON.stringify(totals)}`)
  console.log(`Итого замечаний: ${JSON.stringify(warningTotals)}`)
  const htmlFile = flag('html')
  if (htmlFile) {
    writeFileSync(htmlFile, galleryHtml(gallery, flag('title') ?? 'Карты'))
    console.log(`Галерея: ${htmlFile}`)
  }
  const jsonFile = flag('json')
  if (jsonFile) {
    writeFileSync(jsonFile, JSON.stringify(gallery.map(({ map, ...rest }) => ({ ...rest, svg: renderSvg(map) }))))
    console.log(`Данные: ${jsonFile}`)
  }
} else {
  printOne({
    location: flag('location') ?? 'Таверна «Рог»',
    theme: flag('theme') ?? '',
    settlementType: flag('settlement') ?? '',
    sceneKind: flag('kind') ?? '',
    worldKind: flag('world-kind') ?? '',
    description: flag('description') ?? '',
    seed: flag('seed') ?? 'preview',
    map: { width: Number(flag('width')) || undefined, height: Number(flag('height')) || undefined, ...(flag('shape') ? { design: { shape: flag('shape') } } : {}) },
    useLibrary: false,
  })
}

/**
 * Простая схема карты в SVG: пол по материалу, глухие клетки, стены, двери и
 * окна на рёбрах, предметы — кружками и прямоугольниками по футпринту с
 * цветом по виду. Это не доска игры, а чертёж для ревью: видно структуру,
 * повторы и пустоты.
 * @param {any} map
 */
export function renderSvg(map, cell = 14) {
  const floor = /** @type {Record<string, string>} */ ({ wood: '#b8946a', stone: '#9c968c', earth: '#a88c66', grass: '#86a265', sand: '#d2bd8a', marble: '#d8d2c6', metal: '#8c9298', ice: '#cfe3ea' })
  const zones = new Map((map.zones ?? []).map((/** @type {any} */ zone) => [zone.id, zone]))
  const parts = []
  for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) {
    const own = cellAt(map, x, y)
    if (!own) continue
    let fill = floor[own.material] ?? '#999'
    if (own.surface === 'water') fill = '#5b86a8'
    if (!own.passable && own.surface !== 'water') fill = '#3b342c'
    const interior = zones.get(own.zone)?.kind === 'interior' && own.passable
    parts.push(`<rect x="${x * cell}" y="${y * cell}" width="${cell}" height="${cell}" fill="${fill}"${interior ? ' fill-opacity=".92"' : ''}/>`)
  }
  for (const edge of Object.values(map.edges ?? {})) {
    const e = /** @type {any} */ (edge)
    const x1 = e.dir === 'e' ? (e.x + 1) * cell : e.x * cell
    const y1 = e.dir === 'e' ? e.y * cell : (e.y + 1) * cell
    const x2 = e.dir === 'e' ? x1 : x1 + cell
    const y2 = e.dir === 'e' ? y1 + cell : y1
    const color = e.kind === 'wall' ? '#1d1914' : e.kind === 'door' ? '#c0612b' : e.kind === 'window' ? '#7fc3e8' : e.kind === 'rail' ? '#6b4f33' : '#444'
    const width = e.kind === 'wall' ? 2.4 : e.kind === 'door' || e.kind === 'window' ? 3.2 : 1.4
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" stroke-linecap="square"/>`)
  }
  const hue = (/** @type {string} */ id) => {
    let hash = 0
    for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
    return hash % 360
  }
  for (const prop of map.props ?? []) {
    const p = /** @type {any} */ (prop)
    if (p.mount) continue
    const cells = p.footprint?.length ? p.footprint : null
    const title = `<title>${p.assetId}</title>`
    if (!cells) {
      parts.push(`<circle cx="${p.x * cell}" cy="${p.y * cell}" r="${cell * 0.18}" fill="hsl(${hue(p.assetId)} 55% 45%)" opacity=".7">${title}</circle>`)
      continue
    }
    const minX = Math.min(...cells.map((/** @type {any} */ c) => c.x))
    const minY = Math.min(...cells.map((/** @type {any} */ c) => c.y))
    const maxX = Math.max(...cells.map((/** @type {any} */ c) => c.x))
    const maxY = Math.max(...cells.map((/** @type {any} */ c) => c.y))
    const tree = p.assetId.startsWith('tree_') || p.assetId === 'bush'
    const color = tree ? `hsl(${100 + hue(p.assetId) % 40} 45% ${p.assetId === 'bush' ? 38 : 28}%)` : `hsl(${hue(p.assetId)} 50% 40%)`
    if (tree) parts.push(`<circle cx="${(minX + maxX + 1) / 2 * cell}" cy="${(minY + maxY + 1) / 2 * cell}" r="${(maxX - minX + 1) * cell * 0.45}" fill="${color}" stroke="#1f2d17" stroke-width=".8">${title}</circle>`)
    else parts.push(`<rect x="${minX * cell + 1.5}" y="${minY * cell + 1.5}" width="${(maxX - minX + 1) * cell - 3}" height="${(maxY - minY + 1) * cell - 3}" rx="2.5" fill="${color}" stroke="#15110d" stroke-width=".7">${title}</rect>`)
  }
  for (const point of map.spawnPoints ?? []) {
    if (point.role !== 'party') continue
    parts.push(`<circle cx="${(point.x + 0.5) * cell}" cy="${(point.y + 0.5) * cell}" r="${cell * 0.38}" fill="#f4d35e" stroke="#000" stroke-width="1.2"><title>вход отряда</title></circle>`)
  }
  for (const zone of map.zones ?? []) {
    if (!zone.label) continue
    const cells = []
    for (let y = 0; y < map.height; y += 1) for (let x = 0; x < map.width; x += 1) if (cellAt(map, x, y)?.zone === zone.id && cellAt(map, x, y)?.passable) cells.push({ x, y })
    if (!cells.length) continue
    const cx = cells.reduce((sum, c) => sum + c.x, 0) / cells.length
    const cy = cells.reduce((sum, c) => sum + c.y, 0) / cells.length
    const anchor = cells.reduce((best, c) => Math.hypot(c.x - cx, c.y - cy) < Math.hypot(best.x - cx, best.y - cy) ? c : best, cells[0])
    parts.push(`<text x="${(anchor.x + 0.5) * cell}" y="${(anchor.y + 0.5) * cell}" font-size="${Math.max(8, cell * 0.62)}" text-anchor="middle" fill="#fff" stroke="#000" stroke-width="2.4" paint-order="stroke">${zone.label}</text>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${map.width * cell} ${map.height * cell}" width="${map.width * cell}" height="${map.height * cell}">${parts.join('')}</svg>`
}

/**
 * @param {Array<{id: string, label: string, size: string, seed: string, map: any, report: any}>} gallery
 * @param {string} title
 */
function galleryHtml(gallery, title) {
  const cards = gallery.map(({ label, size, seed, map, report }) => `<figure><figcaption><b>${label}</b> · ${map.width}×${map.height} · ${size} · ${seed}<br><small>${summarizeProblems(report.problems)}${report.warnings.length ? ` · ${summarizeProblems(report.warnings)}` : ''}<br>${Object.entries(report.stats).map(([k, v]) => `${k}=${v}`).join(' ')}</small></figcaption>${renderSvg(map)}</figure>`).join('')
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{background:#191612;color:#eee;font:13px sans-serif}figure{display:inline-block;vertical-align:top;margin:8px;background:#26211b;padding:6px}svg{display:block;max-width:560px;height:auto}small{color:#bbb}</style><h1>${title}</h1>${cards}`
}
