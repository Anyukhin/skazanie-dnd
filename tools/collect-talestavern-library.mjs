#!/usr/bin/env node
// @ts-check
/**
 * Стартовый набор библиотеки карт с TalesTavern.
 *
 * Обходит категории сайта (тип места и местность), читает страницы слэбов как
 * обычный посетитель — по одной, с паузой — и кладёт в библиотеку
 * `<storage>/map-library` то, что проходит фильтры:
 *
 * - лицензия Creative Commons, разрешающая переработку (BY, BY-SA, BY-NC,
 *   BY-NC-SA, CC0); «без производных» и страницы без лицензии пропускаются;
 * - статус «Complete» и ровно один слэб на странице (многочастные постройки
 *   собираются вручную через окно импорта);
 * - импорт без ошибок, достаточно пола, у построек есть стены или двери,
 *   незнакомых ассетов не больше десятой части.
 *
 * Внутри категории берутся самые скачиваемые. Автор, ссылка и лицензия
 * сохраняются в записи: игра показывает их под картой.
 *
 * Запуск:
 *   node tools/collect-talestavern-library.mjs                 # набор по умолчанию в ./storage
 *   node tools/collect-talestavern-library.mjs --dry-run       # только отчёт
 *   node tools/collect-talestavern-library.mjs --storage <dir> --scale 2 --max-pages 12
 *   node tools/collect-talestavern-library.mjs --cache <каталог>   # кэш страниц для повторных прогонов
 *   node tools/collect-talestavern-library.mjs --url https://talestavern.com/slab/<имя>/
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MapLibrary, climateFor, placeKindsFor } from '../server/map-library.mjs'
import { importTaleSpireSlab } from '../server/talespire-import.mjs'
import { cellAt, deserializeTacticalMap, reachableCells } from '../server/tactical-map.mjs'

const SITE = 'https://talestavern.com'
const USER_AGENT = 'SkazanieMapLibrary/1.0 (private tabletop campaign tool; one request at a time)'

/**
 * Что собирать: вид места → категории сайта и сколько карт взять.
 * @type {Array<{ kind: string, sources: string[], take: number }>}
 */
export const DEFAULT_PLAN = [
  { kind: 'tavern', sources: ['slab-type/inn'], take: 7 },
  { kind: 'shop', sources: ['slab-type/merchant', 'slab-type/market', 'slab-type/blacksmith'], take: 5 },
  { kind: 'temple', sources: ['slab-type/church'], take: 4 },
  { kind: 'crypt', sources: ['slab-type/catacombs'], take: 4 },
  { kind: 'cave', sources: ['slab-type/caves', 'slab-type/mine'], take: 5 },
  { kind: 'dungeon', sources: ['slab-terrain/dungeon', 'slab-type/prison', 'slab-type/maze'], take: 6 },
  { kind: 'fortress', sources: ['slab-type/fortress', 'slab-type/tower', 'slab-type/gatehouse'], take: 4 },
  { kind: 'manor', sources: ['slab-type/palace'], take: 2 },
  { kind: 'house', sources: ['slab-type/home'], take: 5 },
  { kind: 'village', sources: ['slab-type/village', 'slab-type/farm'], take: 4 },
  { kind: 'wilds', sources: ['slab-type/nature', 'slab-terrain/woodland', 'slab-terrain/wilderness'], take: 6 },
  { kind: 'docks', sources: ['slab-terrain/docks'], take: 3 },
  { kind: 'ship', sources: ['slab-type/vehicle', 'slab-terrain/docks'], take: 3 },
  { kind: 'ruins', sources: ['slab-type/ruins'], take: 3 },
  { kind: 'camp', sources: ['slab-type/camp'], take: 2 },
  { kind: 'bridge', sources: ['slab-type/bridge'], take: 2 },
]

/** Виды мест, где карта без стен — не постройка, а ошибка подбора. */
const BUILT_KINDS = new Set(['tavern', 'shop', 'temple', 'crypt', 'dungeon', 'fortress', 'manor', 'house'])
const ALLOWED_LICENSES = /^(by|by-sa|by-nc|by-nc-sa|zero)$/u

const wait = (/** @type {number} */ ms) => new Promise((done) => setTimeout(done, ms))

/** @param {string} value */
function decodeEntities(value) {
  return value
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/gu, '&').replace(/&quot;/gu, '"').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&nbsp;/gu, ' ')
}

let lastRequest = 0
/** Каталог кэша страниц: повторный прогон не ходит на сайт заново. */
let cacheDir = ''
/** @param {string} url @returns {Promise<string|null>} */
async function fetchPage(url) {
  const cacheFile = cacheDir ? join(cacheDir, `${createHash('sha256').update(url).digest('hex').slice(0, 32)}.html`) : ''
  if (cacheFile && existsSync(cacheFile)) return readFileSync(cacheFile, 'utf8')
  const html = await fetchFromSite(url)
  if (html && cacheFile) writeFileSync(cacheFile, html)
  return html
}

/** @param {string} url @returns {Promise<string|null>} */
async function fetchFromSite(url) {
  const pause = 600 - (Date.now() - lastRequest)
  if (pause > 0) await wait(pause)
  lastRequest = Date.now()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
      if (response.status === 404) return null
      if (response.ok) return await response.text()
    } catch { /* сеть — повторим */ }
    await wait(1500 * (attempt + 1))
  }
  return null
}

/**
 * Разбор страницы слэба: метаданные из блока под кодом и JSON-LD.
 * @param {string} html
 * @param {string} url
 */
export function parseSlabPage(html, url) {
  const title = decodeEntities((html.match(/<meta property="og:title" content="([^"]*)"/u)?.[1]
    ?? html.match(/<title>([^<]*)<\/title>/u)?.[1] ?? '').replace(/\s*\(Slab\)\s*-\s*Tales Tavern\s*$/u, '').replace(/\s*-\s*Tales Tavern\s*$/u, '').trim())
  const ld = html.match(/"creator":\s*\{"@type":\s*"Person","name":\s*"([^"]*)","identifier":\s*"[^"]*","url":\s*"([^"]*)"/u)
  const metaStart = html.indexOf('Author:')
  const metaEnd = html.indexOf('creativecommons.org', metaStart)
  const meta = metaStart >= 0 ? html.slice(metaStart, metaEnd > 0 ? metaEnd + 400 : metaStart + 6000) : ''
  const field = (/** @type {string} */ name) => decodeEntities(meta.match(new RegExp(`${name}:\\s*</strong>\\s*([^<]*)`, 'u'))?.[1] ?? '').trim()
  const types = [...meta.matchAll(/slab-type\/([a-z0-9-]+)\//gu)].map((match) => match[1])
  const terrains = [...meta.matchAll(/slab-terrain\/([a-z0-9-]+)\//gu)].map((match) => match[1])
  const license = meta.match(/https:\/\/creativecommons\.org\/(licenses\/([a-z-]+)\/[0-9.]+|publicdomain\/(zero)\/[0-9.]+)\/?['"][^>]*>([^<]*)</u)
  const downloads = Number(html.match(/class="tt-log-download"[\s\S]{0,400}?fa-download"><\/i>\s*(\d+)/u)?.[1] ?? 0)
  const codes = [...new Set(html.match(/H4sI[A-Za-z0-9+/=]{40,}/gu) ?? [])]
  const publishedBoard = /talespire:\/\/published-board\//u.test(html)
  return {
    publishedBoard,
    url,
    title,
    author: decodeEntities(ld?.[1] ?? '').trim(),
    authorUrl: ld?.[2] ?? '',
    status: field('Status'),
    created: field('Created On'),
    types: [...new Set(types)],
    terrains: [...new Set(terrains)],
    licenseCode: license ? (license[2] ?? license[3] ?? '') : '',
    licenseName: license ? decodeEntities(license[4]).trim() : '',
    licenseUrl: license ? `https://creativecommons.org/${license[1]}/` : '',
    downloads,
    codes,
  }
}

/** @param {string} url */
function idFor(url) {
  const slug = url.replace(/\/+$/u, '').split('/').pop()?.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '') ?? ''
  const short = slug.slice(0, 80)
  return `tt-${short || createHash('sha256').update(url).digest('hex').slice(0, 12)}`
}

/**
 * Импорт одной страницы в запись библиотеки или причина отказа.
 * @param {ReturnType<typeof parseSlabPage>} page
 * @param {string} wantedKind
 */
export function libraryRecordFor(page, wantedKind) {
  if (!ALLOWED_LICENSES.test(page.licenseCode)) return { reason: `лицензия «${page.licenseName || 'нет'}»` }
  if (page.status && page.status !== 'Complete') return { reason: `статус «${page.status}»` }
  if (page.codes.length !== 1) {
    return { reason: page.codes.length ? 'несколько слэбов на странице' : page.publishedBoard ? 'опубликованная доска, не слэб' : 'нет кода слэба' }
  }
  // Автор, отметивший все категории разом, ничего о месте не сообщает.
  if (page.types.length > 4) return { reason: 'слишком много категорий' }
  const id = idFor(page.url)
  let imported
  try {
    // Пещера и подземелье — без открытого неба, даже если потолка у тайлов нет.
    // Признак «под землёй» — только если все виды места по категориям автора
    // подземные: башня, отмеченная ещё и «лабораторией», остаётся башней.
    const authorKinds = placeKindsFor(page.types, page.terrains, { features: [], interior_share: 0 }, page.title)
    const underground = authorKinds.length > 0 && authorKinds.every((kind) => kind === 'cave' || kind === 'dungeon')
    imported = importTaleSpireSlab(page.codes[0], { locationId: id, underground })
  } catch (error) {
    return { reason: `импорт: ${/** @type {any} */ (error)?.code ?? /** @type {Error} */ (error).message}` }
  }
  const stats = imported.stats
  if (stats.unknown > stats.instances * 0.1) return { reason: `незнакомых ассетов ${stats.unknown} из ${stats.instances}` }
  if (stats.floorCells < 60) return { reason: `мало пола (${stats.floorCells})` }
  const ground = imported.levels.find((level) => level.index === 0)?.map
  const width = Number(/** @type {any} */ (ground)?.width) || 0
  const height = Number(/** @type {any} */ (ground)?.height) || 0
  if (width > 70 || height > 70) return { reason: `слишком большая (${width}×${height})` }
  // Пол этажа входа должен быть одним местом, а не набором разрозненных
  // заготовок: «каталог комнат» на одном слэбе играть нельзя.
  if (ground) {
    const map = deserializeTacticalMap(ground)
    let passable = 0
    /** @type {{x:number, y:number}|null} */
    let start = null
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        if (cellAt(map, x, y)?.passable) {
          passable += 1
          start ??= { x, y }
        }
      }
    }
    let largest = 0
    /** @type {Set<string>} */
    const seenCells = new Set()
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        if (seenCells.has(`${x},${y}`) || !cellAt(map, x, y)?.passable) continue
        const region = reachableCells(map, x, y, { throughDoors: true })
        for (const key of region) seenCells.add(key)
        largest = Math.max(largest, region.size)
      }
    }
    if (start && largest < passable * 0.6) return { reason: 'разрозненные куски вместо одного места' }
  }
  const placeKinds = placeKindsFor(page.types, page.terrains, imported.passport, page.title)
  if (!placeKinds.length) return { reason: 'не понять, что это за место' }
  if (!placeKinds.includes(/** @type {any} */ (wantedKind))) return { reason: `это ${placeKinds.join('/')}, а нужен ${wantedKind}` }
  if (BUILT_KINDS.has(wantedKind) && stats.walls + stats.doors * 2 < 8) return { reason: 'постройка без стен' }
  if (BUILT_KINDS.has(wantedKind) && imported.passport.interior_share < 0.3 && stats.walls < 40) return { reason: 'постройка почти без помещений' }
  /** @type {import('../server/map-library.mjs').LibraryEntry} */
  const entry = {
    id,
    title: page.title || id,
    source: {
      site: 'TalesTavern',
      url: page.url,
      author: page.author || 'неизвестен',
      ...(page.authorUrl ? { author_url: page.authorUrl } : {}),
      license: page.licenseName,
      license_url: page.licenseUrl,
      ...(page.created ? { created: page.created } : {}),
      downloads: page.downloads,
    },
    place_kinds: placeKinds,
    climate: climateFor(page.terrains, imported.passport),
    terrains: page.terrains,
    types: page.types,
    passport: imported.passport,
    levels: imported.levels.map((level) => ({ index: level.index, label: level.label })),
    slab_sha256: imported.source.sha256,
    added_at: new Date().toISOString(),
  }
  return { entry, levels: imported.levels, stats }
}

/** @param {string} source @param {number} page */
async function listingPage(source, page) {
  const html = await fetchPage(`${SITE}/${source}/${page > 1 ? `page/${page}/` : ''}`)
  if (!html) return []
  return [...new Set([...html.matchAll(/href="(https:\/\/talestavern\.com\/slab\/[a-z0-9-]+\/)"/gu)].map((match) => match[1]))]
}

async function main() {
  const args = process.argv.slice(2)
  const option = (/** @type {string} */ name) => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const dryRun = args.includes('--dry-run')
  const storage = resolve(option('--storage') ?? process.env.DND_STORAGE_DIR ?? join(process.cwd(), 'storage'))
  const scale = Math.max(0.25, Number(option('--scale') ?? 1) || 1)
  const maxPages = Math.max(1, Number(option('--max-pages') ?? 12) || 12)
  // Кэш только по просьбе: страница весит около 120 КБ, и тысячам страниц не
  // место в рабочем хранилище.
  const cacheOption = option('--cache')
  cacheDir = cacheOption ? resolve(cacheOption) : ''
  if (cacheDir) mkdirSync(cacheDir, { recursive: true })
  /** Каждая страница слэба смотрится один раз за прогон. */
  const visited = new Set()
  const library = new MapLibrary(storage)
  const known = new Set(library.entries().map((entry) => entry.id))
  /** @type {Array<Record<string, unknown>>} */
  const report = []

  const explicit = args.filter((value, index) => args[index - 1] === '--url')
  const plan = explicit.length
    ? [{ kind: '', sources: [], take: explicit.length, urls: explicit }]
    : DEFAULT_PLAN.map((step) => ({ ...step, take: Math.max(1, Math.round(step.take * scale)), urls: /** @type {string[]} */ ([]) }))

  for (const step of plan) {
    /** @type {Array<{ page: ReturnType<typeof parseSlabPage>, record: any }>} */
    const accepted = []
    // Источник категории листается до тех пор, пока не набрано вдвое больше
    // нужного (из них потом берутся самые скачиваемые) или не кончились страницы.
    /** @type {string[]} */
    const urls = [...step.urls]
    const cursors = step.sources.map((source) => ({ source, page: 0, done: false }))
    let scanned = 0
    while (true) {
      if (!urls.length) {
        if (accepted.length >= step.take * 2) break
        const cursor = cursors.find((candidate) => !candidate.done)
        if (!cursor) break
        cursor.page += 1
        const found = cursor.page > maxPages ? [] : await listingPage(cursor.source, cursor.page)
        if (!found.length) cursor.done = true
        urls.push(...found.filter((url) => !visited.has(url)))
        // Источники чередуются страницами, чтобы категория не собиралась из одного.
        cursors.push(...cursors.splice(cursors.indexOf(cursor), 1))
        continue
      }
      const url = /** @type {string} */ (urls.shift())
      if (visited.has(url) || known.has(idFor(url))) continue
      visited.add(url)
      scanned += 1
      const html = await fetchPage(url)
      if (!html) continue
      const page = parseSlabPage(html, url)
      const kind = step.kind || placeKindsFor(page.types, page.terrains, { features: [], interior_share: 0 }, page.title)[0] || ''
      const record = libraryRecordFor(page, kind)
      if ('reason' in record) {
        report.push({ kind: step.kind, url, title: page.title, skipped: record.reason })
        continue
      }
      accepted.push({ page, record })
      process.stdout.write(`  + [${step.kind || kind}] ${page.title} — ${page.author} (${page.licenseName}, скачиваний ${page.downloads})\n`)
    }
    accepted.sort((left, right) => right.page.downloads - left.page.downloads || left.page.url.localeCompare(right.page.url))
    for (const { page, record } of accepted.slice(0, step.take)) {
      known.add(record.entry.id)
      report.push({ kind: step.kind, url: page.url, title: page.title, id: record.entry.id, added: !dryRun, summary: record.entry.passport.summary, place_kinds: record.entry.place_kinds, climate: record.entry.climate })
      if (!dryRun) library.put(record.entry, record.levels)
    }
    process.stdout.write(`${step.kind || 'по ссылкам'}: принято ${Math.min(step.take, accepted.length)} из ${scanned} просмотренных\n`)
  }
  const reportFile = option('--report')
  if (reportFile) writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`)
  const added = report.filter((row) => row.id).length
  process.stdout.write(`\nИтого ${dryRun ? 'подошло' : 'добавлено'}: ${added}; в библиотеке теперь ${library.entries().length} записей (${library.dir})\n`)
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) await main()
