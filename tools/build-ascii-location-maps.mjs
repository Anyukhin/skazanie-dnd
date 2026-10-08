#!/usr/bin/env node
// @ts-check
/**
 * Сборщик авторских карт, нарисованных буквами.
 *
 * Карта — JSON-файл в `data/authored-maps/`: помещения нарисованы символами по
 * клеткам (`rows`), что значит каждый символ — в `legend`, предметы и декали —
 * списком `props` с координатами клетки. Так планировку видно глазами и её
 * можно поправить без редактора. Сборщик переводит рисунок в native-grid
 * раскладку и отдаёт её общему `buildAuthoredLocationMap`
 * (`tools/build-authored-location-maps.mjs`): тот проверяет досягаемость,
 * двери и валидность и пишет карту в каталог `data/authored-location-maps-v1.json`.
 *
 * Символы рисунка:
 *   - символ из `legend` с `zone` — пол этой зоны;
 *   - символ из `legend` с `"void": true` — клетки нет (пропасть, скала, край);
 *   - символ из `legend` с `"solid": true` — клетка есть, но непроходима
 *     (обвал, колонна кладки); стены вокруг сборщик ставит сам;
 *   - `"hazardId"` у символа — опасность клетки (`lava-fire` — лава: огонь для
 *     механики, свечение в 3D);
 *   - `"moveCost": 2` у символа — трудная местность (бурелом, подлесок, грязь);
 *   - `"elevation"` у символа — высота площадки в футах: целое со знаком,
 *     кратное 5. Без поля клетка лежит на уровне земли;
 *   - `D` — закрытая дверь, `O` — открытая, `B` — выломанная, `L` — запертая,
 *     `W` — окно. Знак стоит в клетке-пороге: клетка достаётся помещению
 *     (зоне `interior`), а дверь или окно — ребру к соседней зоне;
 *   - `@` — вход отряда, `E` — точка врагов, `N` — жители; клетка берёт зону
 *     и высоту соседей.
 *
 * Между клетками разных зон, если хотя бы одна из них — помещение, сборщик
 * ставит стену. Между уличными зонами стены нет.
 *
 * Высота. Соседние проходимые клетки с разницей до 5 футов — ступень или
 * склон: по ним ходят без лазания. Разница больше — обрыв: сборщик ставит на
 * ребро кромку (`ledge`), которая не пускает шагом, но не закрывает ни обзора,
 * ни выстрела, и даёт половинное укрытие тому, кто за ней. Лазания движок пока
 * не знает, поэтому на каждую площадку рисуется подъём ступенями по 5 футов.
 * Дверь и окно над обрывом — ошибка рисунка.
 *
 *   node tools/build-ascii-location-maps.mjs data/authored-maps/astohan-forgotten-cliffs.json
 *   node tools/build-ascii-location-maps.mjs --all          # все файлы каталога
 *   node tools/build-ascii-location-maps.mjs --all --check  # только проверка, без записи
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assetById } from '../server/asset-registry.mjs'
import { auditTacticalMap } from '../server/map-quality.mjs'
import { deserializeTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'
import { buildAuthoredLocationMap } from './build-authored-location-maps.mjs'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
export const ASCII_MAP_DIR = resolve(ROOT, 'data/authored-maps')
const CATALOG = resolve(ROOT, 'data/authored-location-maps-v1.json')

const DOOR_MARKS = Object.freeze({ D: 'closed', O: 'open', B: 'broken', L: 'locked' })
const SPAWN_MARKS = Object.freeze({ '@': 'party', E: 'enemy', N: 'neutral' })
const MARKS = new Set([...Object.keys(DOOR_MARKS), 'W', ...Object.keys(SPAWN_MARKS)])
const SIDES = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]])
/** Наибольшая разница высот соседних клеток, которую проходят шагом, в футах. */
export const STEP_FEET = 5
/** Высота клетки хранится в Int8 (футы): берутся кратные 5 в этих пределах. */
const ELEVATION_LIMIT = 125

/** @param {string} message @returns {never} */
function fail(message) {
  throw new Error(message)
}

/**
 * Рисунок → native-grid раскладка общего сборщика.
 * @param {any} source
 */
export function asciiMapToLayout(source) {
  const id = String(source?.location_id ?? '')
  const rows = Array.isArray(source?.rows) ? source.rows.map(String) : fail(`${id}: rows обязателен`)
  const height = rows.length
  const width = rows[0]?.length ?? 0
  if (!width || rows.some((row, index) => row.length !== width || void index)) {
    const bad = rows.findIndex((row) => row.length !== width)
    fail(`${id}: строка ${bad} длиной ${rows[bad]?.length}, ожидалось ${width}`)
  }
  const legend = source.legend && typeof source.legend === 'object' ? source.legend : fail(`${id}: legend обязателен`)
  const zones = Array.isArray(source.zones) ? source.zones : fail(`${id}: zones обязателен`)
  const zoneById = new Map(zones.map((zone) => [String(zone.id), zone]))
  for (const [symbol, entry] of Object.entries(legend)) {
    if (symbol.length !== 1 || MARKS.has(symbol)) fail(`${id}: символ легенды «${symbol}» занят или длиннее одного знака`)
    if (entry.zone && !zoneById.has(entry.zone)) fail(`${id}: символ «${symbol}» ссылается на неизвестную зону ${entry.zone}`)
    if (!entry.zone && !entry.void) fail(`${id}: символу «${symbol}» нужна zone или void`)
    if (entry.elevation !== undefined
      && (!Number.isSafeInteger(entry.elevation) || entry.elevation % STEP_FEET !== 0 || Math.abs(entry.elevation) > ELEVATION_LIMIT)) {
      fail(`${id}: высота символа «${symbol}» — целые футы, кратные ${STEP_FEET}, от -${ELEVATION_LIMIT} до ${ELEVATION_LIMIT}`)
    }
  }
  /** @param {string} symbol */
  const symbolElevation = (symbol) => Number(legend[symbol]?.elevation ?? 0)
  const symbolAt = (x, y) => (x >= 0 && y >= 0 && x < width && y < height ? rows[y][x] : ' ')
  const isFloorSymbol = (symbol) => Boolean(legend[symbol]?.zone) || MARKS.has(symbol)

  /** Зона клетки-знака: по соседям; у двери и окна — помещение. */
  const markZone = new Map()
  /** Высота клетки-знака — того же соседа, чью зону она берёт. */
  const markElevation = new Map()
  /** @type {Array<{ x: number, y: number, to: { x: number, y: number }, kind: string, state?: string }>} */
  const openings = []
  const plainZone = (x, y) => {
    const entry = legend[symbolAt(x, y)]
    return entry?.zone && !entry.void ? String(entry.zone) : ''
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const symbol = rows[y][x]
      if (!MARKS.has(symbol)) {
        if (!legend[symbol]) fail(`${id}: символ «${symbol}» в (${x},${y}) не описан в legend`)
        continue
      }
      const neighbours = SIDES.map(([dx, dy]) => ({ x: x + dx, y: y + dy, zone: plainZone(x + dx, y + dy) })).filter((entry) => entry.zone)
      if (!neighbours.length) fail(`${id}: знак «${symbol}» в (${x},${y}) без соседнего пола`)
      if (SPAWN_MARKS[symbol]) {
        markZone.set(`${x},${y}`, neighbours[0].zone)
        markElevation.set(`${x},${y}`, symbolElevation(symbolAt(neighbours[0].x, neighbours[0].y)))
        continue
      }
      // Порог: напротив друг друга — две разные зоны. Клетка — помещению.
      const pairs = [[[1, 0], [-1, 0]], [[0, 1], [0, -1]]].map(([[ax, ay], [bx, by]]) => [
        { x: x + ax, y: y + ay, zone: plainZone(x + ax, y + ay) },
        { x: x + bx, y: y + by, zone: plainZone(x + bx, y + by) },
      ]).filter(([a, b]) => a.zone && b.zone && a.zone !== b.zone)
      if (pairs.length !== 1) fail(`${id}: знак «${symbol}» в (${x},${y}) должен стоять между двумя разными зонами (найдено пар: ${pairs.length})`)
      const [a, b] = pairs[0]
      const interior = (zone) => zoneById.get(zone)?.kind !== 'exterior'
      const [own, other] = interior(a.zone) && !interior(b.zone) ? [a, b] : interior(b.zone) && !interior(a.zone) ? [b, a] : [a, b]
      markZone.set(`${x},${y}`, own.zone)
      markElevation.set(`${x},${y}`, symbolElevation(symbolAt(own.x, own.y)))
      if (Math.abs(symbolElevation(symbolAt(own.x, own.y)) - symbolElevation(symbolAt(other.x, other.y))) > STEP_FEET) {
        fail(`${id}: знак «${symbol}» в (${x},${y}) стоит над обрывом — высоты по сторонам расходятся больше чем на ${STEP_FEET} фт`)
      }
      openings.push(symbol === 'W'
        ? { x, y, to: { x: other.x, y: other.y }, kind: 'window' }
        : { x, y, to: { x: other.x, y: other.y }, kind: 'door', state: DOOR_MARKS[symbol] })
    }
  }
  const zoneAt = (x, y) => markZone.get(`${x},${y}`) ?? plainZone(x, y)
  const elevationAt = (x, y) => markElevation.get(`${x},${y}`) ?? symbolElevation(symbolAt(x, y))

  const terrain = [{ rect: [0, 0, width, height], present: false }]
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const symbol = rows[y][x]
      const entry = legend[symbol]
      if (entry?.void) continue
      const zone = zoneAt(x, y)
      const zoneDef = zoneById.get(zone)
      terrain.push({
        rect: [x, y, 1, 1],
        present: true,
        passable: entry?.solid !== true,
        zone,
        material: entry?.material ?? zoneDef?.material ?? source.default_material ?? 'stone',
        ...(entry?.surface ? { surface: entry.surface } : {}),
        ...(Number.isSafeInteger(entry?.moveCost) ? { moveCost: entry.moveCost } : {}),
        ...(typeof entry?.hazardId === 'string' && entry.hazardId ? { hazardId: entry.hazardId } : {}),
        ...(elevationAt(x, y) ? { elevation: elevationAt(x, y) } : {}),
      })
    }
  }

  // Стены между помещением и соседней зоной (проёмы пропускаются), кромки
  // обрывов между площадками без стены.
  const opened = new Set(openings.map((opening) => [`${opening.x},${opening.y}`, `${opening.to.x},${opening.to.y}`].sort().join('|')))
  const walls = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isFloorSymbol(rows[y][x]) || legend[rows[y][x]]?.solid) continue
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = x + dx
        const ny = y + dy
        if (!isFloorSymbol(symbolAt(nx, ny)) || legend[symbolAt(nx, ny)]?.solid) continue
        const left = zoneAt(x, y)
        const right = zoneAt(nx, ny)
        const indoor = left !== right
          && (zoneById.get(left)?.kind !== 'exterior' || zoneById.get(right)?.kind !== 'exterior')
        const key = [`${x},${y}`, `${nx},${ny}`].sort().join('|')
        if (!indoor) {
          // Обрыв между площадками: кромка вместо стены, проём здесь невозможен.
          if (Math.abs(elevationAt(x, y) - elevationAt(nx, ny)) > STEP_FEET) {
            walls.push({ from: [x, y], to: [nx, ny], kind: 'ledge', blocksMove: true, blocksSight: false, cover: 'half' })
          }
          continue
        }
        const window = openings.find((opening) => opening.kind === 'window'
          && [`${opening.x},${opening.y}`, `${opening.to.x},${opening.to.y}`].sort().join('|') === key)
        if (window) walls.push({ from: [x, y], to: [nx, ny], kind: 'window', blocksMove: true, blocksSight: false, cover: 'half' })
        else if (!opened.has(key)) walls.push({ from: [x, y], to: [nx, ny] })
      }
    }
  }
  // Общий сборщик кладёт дверь на ребро к соседу справа или снизу (`dir` из
  // пары клеток), поэтому пара упорядочивается: левая/верхняя клетка первой.
  const ordered = (opening) => (opening.to.x < opening.x || opening.to.y < opening.y
    ? { from: [opening.to.x, opening.to.y], to: [opening.x, opening.y] }
    : { from: [opening.x, opening.y], to: [opening.to.x, opening.to.y] })
  const doors = openings.filter((opening) => opening.kind === 'door').map((opening, index) => ({
    id: `${id}:door-${index + 1}`,
    ...ordered(opening),
    state: opening.state,
    ...(opening.state === 'locked' ? { lockDc: Number(source.lock_dc ?? 15) } : {}),
  }))
  const spawns = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const role = SPAWN_MARKS[rows[y][x]]
      if (role) spawns.push({ id: `${role}:${id}:${spawns.filter((spawn) => spawn.role === role).length + 1}`, x, y, role })
    }
  }
  // Правила каталога (`test/small-tactical-maps.test.mjs`): предметы и
  // декали не делят клетку, вытянутый предмет повёрнут по своей длинной
  // стороне, точка появления не стоит на предмете.
  const taken = new Map()
  const spawnCells = new Set(spawns.map((spawn) => `${spawn.x},${spawn.y}`))
  const props = (Array.isArray(source.props) ? source.props : []).map((prop, index) => {
    const assetId = String(prop.asset ?? '')
    if (!assetById(assetId)) fail(`${id}: предмет ${index + 1} — неизвестный asset ${assetId}`)
    const [x, y, w = 1, h = 1] = Array.isArray(prop.at) ? prop.at.map(Number) : fail(`${id}: предмет ${assetId} без at`)
    const rotation = Number(prop.rot ?? 0)
    if (w > h && ![0, 180].includes(rotation)) fail(`${id}: ${assetId} в (${x},${y}) шире, чем выше, — нужен rot 0 или 180`)
    if (h > w && ![90, 270].includes(rotation)) fail(`${id}: ${assetId} в (${x},${y}) выше, чем шире, — нужен rot 90 или 270`)
    for (let dy = 0; dy < h; dy += 1) {
      for (let dx = 0; dx < w; dx += 1) {
        const symbol = symbolAt(x + dx, y + dy)
        const cell = `${x + dx},${y + dy}`
        if (!isFloorSymbol(symbol) || legend[symbol]?.solid) fail(`${id}: ${assetId} в (${cell}) стоит не на полу`)
        if (taken.has(cell)) fail(`${id}: ${assetId} и ${taken.get(cell)} делят клетку (${cell})`)
        if (spawnCells.has(cell)) fail(`${id}: ${assetId} стоит на точке появления (${cell})`)
        taken.set(cell, assetId)
      }
    }
    return {
      id: `${id}:${prop.id ?? `${assetId}-${index + 1}`}`,
      assetId,
      rect: [x, y, w, h],
      rotation: Number(prop.rot ?? 0),
      ...(prop.state ? { state: prop.state } : {}),
      ...(prop.blocksMove !== undefined ? { blocksMove: prop.blocksMove } : {}),
    }
  })
  if (!spawns.some((spawn) => spawn.role === 'party')) fail(`${id}: нужен вход отряда «@»`)
  if (!spawns.some((spawn) => spawn.role === 'enemy')) fail(`${id}: нужна точка врагов «E»`)
  const revealDistance = Number(source.reveal_distance ?? 8)
  if (!Number.isSafeInteger(revealDistance) || revealDistance < 1 || revealDistance > 8) fail(`${id}: reveal_distance — от 1 до 8`)
  const usedZones = new Set(terrain.filter((entry) => entry.present).map((entry) => entry.zone))
  for (const zone of zones) if (!usedZones.has(String(zone.id))) fail(`${id}: зона ${zone.id} объявлена, но на рисунке её нет`)
  return {
    location_id: id,
    name: source.name,
    width,
    height,
    source_width: width,
    source_height: height,
    native_grid: true,
    // Край улицы открыт: стены у края карты получают только помещения.
    open_outer_edges: true,
    seed: `authored-tactical:${id}:v1`,
    // Тот же контракт каталога, что у малых карт (`build-small-tactical-maps.mjs`):
    // нарисованная карта отличается источником, а не форматом.
    generator: { id: 'authored-tactical-scene', version: '1' },
    theme: source.theme ?? 'building',
    default_material: source.default_material ?? 'stone',
    default_zone: zones[0].id,
    reveal_distance: revealDistance,
    ...(source.surroundings ? { surroundings: source.surroundings } : {}),
    zones,
    terrain,
    walls,
    doors,
    props,
    spawns,
    checks: Array.isArray(source.checks) ? source.checks : [],
  }
}

/** @param {string} path */
export function buildAsciiMapFile(path) {
  const source = JSON.parse(readFileSync(path, 'utf8'))
  if (basename(path) !== `${source.location_id}.json`) fail(`${basename(path)}: имя файла должно совпадать с location_id ${source.location_id}`)
  const map = buildAuthoredLocationMap(asciiMapToLayout(source))
  return { source, map }
}

function main() {
  const argv = process.argv.slice(2)
  const checkOnly = argv.includes('--check')
  const files = argv.includes('--all')
    ? readdirSync(ASCII_MAP_DIR).filter((name) => name.endsWith('.json')).map((name) => resolve(ASCII_MAP_DIR, name))
    : argv.filter((arg) => !arg.startsWith('--')).map((arg) => resolve(arg))
  if (!files.length) fail('Укажите файл карты или --all')
  const catalog = existsSync(CATALOG) ? JSON.parse(readFileSync(CATALOG, 'utf8')) : { schema_version: 1, maps: [] }
  const byId = new Map(catalog.maps.map((entry) => [String(entry.locationId), entry]))
  const report = []
  for (const file of files) {
    const { map } = buildAsciiMapFile(file)
    const audit = auditTacticalMap(deserializeTacticalMap(serializeTacticalMap(map)))
    const issues = (audit?.problems ?? []).map((issue) => `${issue.code}${issue.detail ? ` ${issue.detail}` : ""}`)
    report.push({ file: basename(file), location: map.locationId, size: `${map.width}x${map.height}`, props: map.props.length, doors: map.doors.length, issues })
    byId.set(map.locationId, serializeTacticalMap(map))
  }
  if (!checkOnly) {
    const maps = [...byId.values()].sort((left, right) => String(left.locationId).localeCompare(String(right.locationId)))
    writeFileSync(CATALOG, `${JSON.stringify({ schema_version: catalog.schema_version ?? 1, maps }, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify({ ok: true, written: !checkOnly, maps: report }, null, 2)}\n`)
}

if (process.argv[1] && basename(process.argv[1]) === 'build-ascii-location-maps.mjs') {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
