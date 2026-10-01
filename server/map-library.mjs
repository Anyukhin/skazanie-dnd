// @ts-check
/**
 * Библиотека готовых карт: импортированные из TaleSpire постройки, из которых
 * генератор сцены сам выбирает карту под новую локацию.
 *
 * Где живёт. `<storage>/map-library/`: `index.json` — паспорта и метаданные,
 * `maps/<id>.json` — этажи. Это данные владельца, а не исходники проекта:
 * чужие постройки с TalesTavern в репозиторий не попадают, у каждой записи
 * сохранены автор, ссылка и лицензия.
 *
 * Как выбирает. `libraryRequestFor` переводит заявку сцены (тема, назначение
 * здания, климат, вид точки карты мира, объявленные этажи) в требования, а
 * `chooseLibraryMap` отбирает подходящие записи: вид места обязан совпасть,
 * климат не должен спорить, уже использованная в кампании карта не повторяется.
 * Из лучших выбор детерминирован по сиду места. Ничего не подошло — работает
 * обычный генератор: подгонять историю под чужую карту нельзя.
 *
 * Библиотека не участвует в replay: выбранная карта едет в событии
 * `SceneAdvanced` целиком, и повтор журнала её уже не спрашивает.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MAP_LIBRARY_DIR = 'map-library'
export const MAP_LIBRARY_SCHEMA_VERSION = 1
export const LIBRARY_SEED_PREFIX = 'library:'
const ENTRY_ID = /^[a-z0-9][a-z0-9-]{0,99}$/u

/**
 * Виды мест, на которых говорят библиотека и генератор.
 * @typedef {'tavern'|'shop'|'temple'|'crypt'|'cave'|'dungeon'|'fortress'|'manor'|'house'|'village'|'camp'|'ruins'|'wilds'|'docks'|'ship'|'arena'|'bridge'} PlaceKind
 */

/**
 * @typedef {object} LibraryEntry
 * @property {string} id
 * @property {string} title
 * @property {{ site: string, url: string, author: string, author_url?: string, license: string, license_url?: string, created?: string, downloads?: number }} source
 * @property {PlaceKind[]} place_kinds
 * @property {string} climate '', 'arid', 'cold' или 'wetland'
 * @property {string[]} terrains
 * @property {string[]} types
 * @property {ReturnType<typeof import('./talespire-import.mjs').mapPassport> & { genre?: string }} passport
 * @property {Array<{ index: number, label: string }>} levels
 * @property {string} slab_sha256
 * @property {string} added_at
 */

/**
 * Типы мест TalesTavern → наш вид места. Слева — слаг таксономии
 * `slab-type` / `slab-terrain` сайта.
 * @type {Record<string, PlaceKind>}
 */
const TALESTAVERN_KINDS = Object.freeze({
  inn: 'tavern',
  merchant: 'shop', market: 'shop', trade: 'shop', blacksmith: 'shop', warehouse: 'shop',
  church: 'temple',
  catacombs: 'crypt',
  caves: 'cave', mine: 'cave',
  maze: 'dungeon', prison: 'dungeon', lab: 'dungeon', dungeon: 'dungeon', underground: 'dungeon',
  fortress: 'fortress', gatehouse: 'fortress', tower: 'fortress', castle: 'fortress',
  palace: 'manor',
  home: 'house', 'single-structure': 'house',
  village: 'village', 'multiple-structures': 'village', farm: 'village', city: 'village',
  camp: 'camp',
  ruins: 'ruins',
  nature: 'wilds', area: 'wilds', wilderness: 'wilds', woodland: 'wilds', jungle: 'wilds', swamp: 'wilds', mountain: 'wilds',
  docks: 'docks',
  arena: 'arena',
  bridge: 'bridge',
})

/** Климат по местности TalesTavern; остальные местности климата не задают. */
const TALESTAVERN_CLIMATES = /** @type {Record<string, string>} */ (Object.freeze({
  desert: 'arid', volcanic: 'arid', tundra: 'cold', swamp: 'wetland', jungle: 'wetland',
}))

/**
 * Виды места по таксономии TalesTavern, а если автор её не дал — по паспорту
 * карты. Паспорт не дописывает виды к авторским: кладбище у деревянной церкви
 * не делает церковь склепом, а таверна без найденного зала всё равно таверна —
 * так её назвал автор.
 *
 * Корабль — всегда только «корабль»: в TalesTavern торговое судно часто
 * отмечено типом «торговец», но лавкой или портом оно от этого не становится.
 *
 * @param {string[]} types слаги `slab-type`
 * @param {string[]} terrains слаги `slab-terrain`
 * @param {{ features: string[], interior_share: number }} passport
 * @param {string} [title] название постройки
 * @returns {PlaceKind[]}
 */
export function placeKindsFor(types, terrains, passport, title = '') {
  if (/\b(ship|boat|galleon|sloop|vessel|ketch|cog|frigate|caravel|brig|longship|airship|spelljammer|barque|bark|lugger|cutter|xebec|warship|schooner|corvette|uss|hms)\b/iu.test(title)) return ['ship']
  /** @type {Set<PlaceKind>} */
  const kinds = new Set()
  for (const slug of types) if (TALESTAVERN_KINDS[slug]) kinds.add(TALESTAVERN_KINDS[slug])
  // Местность добавляет вид только там, где он однозначен.
  for (const slug of terrains) if (['dungeon', 'underground', 'docks', 'castle'].includes(slug)) kinds.add(TALESTAVERN_KINDS[slug])
  const features = new Set(passport.features)
  if (!kinds.size) {
    if (features.has('common_room') && features.has('bedrooms')) kinds.add('tavern')
    if (features.has('shrine') && passport.interior_share >= 0.5) kinds.add('temple')
    if (features.has('crypt')) kinds.add('crypt')
  }
  if (!kinds.size) {
    if (terrains.some((slug) => TALESTAVERN_KINDS[slug] === 'wilds') && passport.interior_share < 0.3) kinds.add('wilds')
  }
  return [...kinds].sort()
}

/**
 * @param {string[]} terrains
 * @param {{ material: string }} passport
 */
export function climateFor(terrains, passport) {
  for (const slug of terrains) if (TALESTAVERN_CLIMATES[slug]) return TALESTAVERN_CLIMATES[slug]
  if (passport.material === 'sand') return 'arid'
  if (passport.material === 'ice') return 'cold'
  return ''
}

/**
 * Что сцена просит от карты. Тема и назначение здания — из той же
 * эвристики, что выбирает процедурный генератор, поэтому библиотека и
 * генератор понимают «таверну» одинаково.
 *
 * `place` — название и тема места, `world` — описание мира: по ним видно
 * корабль и научно-фантастический мир, которых нет среди тем генератора.
 *
 * @param {{ themeId: string, buildingUse?: string, topology?: string, climate?: string, worldKind?: string, levels?: Array<{ offset: number }>, width?: number, height?: number, place?: string, world?: string }} input
 * @returns {{ placeKinds: PlaceKind[], exterior: boolean, climate: string, genre: 'scifi'|'fantasy', wantsCellar: boolean, wantsUpstairs: boolean, area: number }}
 */
export function libraryRequestFor({ themeId, buildingUse = '', topology = '', climate = '', worldKind = '', levels = [], width = 26, height = 22, place = '', world = '' }) {
  /** @type {PlaceKind[]} */
  let placeKinds = []
  let exterior = false
  if (themeId === 'building') {
    placeKinds = buildingUse === 'tavern' ? ['tavern']
      : buildingUse === 'shop' ? ['shop']
        : buildingUse === 'manor' ? ['manor', 'fortress']
          : ['house']
  } else if (themeId === 'temple') placeKinds = ['temple']
  else if (themeId === 'crypt') placeKinds = ['crypt']
  else if (themeId === 'cave') placeKinds = worldKind === 'dungeon' ? ['dungeon', 'cave'] : ['cave']
  else if (themeId === 'forest') { placeKinds = ['wilds']; exterior = true }
  else if (themeId === 'road') { placeKinds = ['wilds', 'bridge']; exterior = true }
  else if (themeId === 'settlement') {
    placeKinds = topology === 'harbor' ? ['docks'] : topology === 'market' ? ['village', 'shop'] : topology === 'gate' ? ['fortress', 'village'] : ['village']
    exterior = true
  }
  if (/корабл|судн|палуб|галеон|драккар|ладь[яиеюё]|шхун|фрегат|каравелл/iu.test(place)) {
    placeKinds = ['ship']
    exterior = false
  }
  if (worldKind === 'ruin' && !exterior) placeKinds = [...placeKinds, 'ruins']
  if (worldKind === 'fortress' && !placeKinds.includes('fortress')) placeKinds = [...placeKinds, 'fortress']
  return {
    placeKinds,
    exterior,
    climate: climate === 'temperate' ? '' : climate,
    genre: /кибер|космос|космич|звездолёт|звездолет|орбит|станци[яи] «|футур|будущ|sci-?fi|киберпанк|робот/iu.test(`${place} ${world}`) ? 'scifi' : 'fantasy',
    wantsCellar: levels.some((level) => Number(level.offset) < 0),
    wantsUpstairs: levels.some((level) => Number(level.offset) > 0),
    area: Math.max(256, width * height),
  }
}

/** Признаки паспорта, которые подтверждают вид места. */
const KIND_EVIDENCE = /** @type {Record<string, string[]>} */ (Object.freeze({
  tavern: ['common_room', 'bedrooms', 'kitchen', 'storage'],
  shop: ['shop', 'storage'],
  temple: ['shrine'],
  crypt: ['crypt'],
  cave: ['cave'],
  dungeon: ['doors', 'storage'],
  fortress: ['barracks', 'doors'],
  manor: ['throne', 'bedrooms', 'library'],
  house: ['bedrooms', 'kitchen'],
  village: ['street', 'yard'],
  wilds: ['grove', 'camp'],
}))

/** @param {string} text */
function hashNumber(text) {
  return createHash('sha256').update(text).digest().readUInt32LE(0)
}

/**
 * Лучшая запись библиотеки под заявку или `null`.
 *
 * @param {LibraryEntry[]} entries
 * @param {ReturnType<typeof libraryRequestFor>} request
 * @param {{ seed: string, usedIds?: Iterable<string> }} options
 * @returns {LibraryEntry|null}
 */
export function chooseLibraryMap(entries, request, { seed, usedIds = [] }) {
  if (!request.placeKinds.length) return null
  const used = new Set(usedIds)
  /** @type {Array<{ entry: LibraryEntry, score: number }>} */
  const scored = []
  for (const entry of entries) {
    if (used.has(entry.id)) continue
    const kinds = new Set(entry.place_kinds)
    const primary = request.placeKinds.findIndex((kind) => kinds.has(kind))
    if (primary < 0) continue
    // Климат не должен спорить: пустынная таверна не встаёт в тундре, а
    // лесная поляна — посреди пустыни.
    if (request.climate && entry.climate && entry.climate !== request.climate) continue
    if (request.climate === 'arid' && !entry.climate && entry.passport.material === 'grass') continue
    if (!request.climate && entry.climate === 'arid') continue
    // Жанр не смешивается: контейнерный посёлок не встаёт в фэнтези-ярмарку.
    if ((entry.passport.genre ?? 'fantasy') !== request.genre) continue
    const share = Number(entry.passport.interior_share) || 0
    // Улица, поле и деревня — сцены под открытым небом: отряд не должен
    // начинать их в кладовой чужой постройки.
    if (request.exterior && share > 0.45) continue
    let score = 10 - primary * 2
    // Карта своего климата лучше нейтральной: пустынный трактир в пустыне.
    if (request.climate && entry.climate === request.climate) score += 3
    const features = new Set(entry.passport.features)
    for (const kind of request.placeKinds) for (const feature of KIND_EVIDENCE[kind] ?? []) if (features.has(feature)) score += 1
    if (request.wantsCellar) score += features.has('cellar') ? 3 : -3
    if (request.wantsUpstairs) score += features.has('upstairs') ? 2 : -2
    const area = Math.max(1, Number(entry.passport.floor_cells) || 1)
    score -= Math.min(3, Math.abs(Math.log2(area / request.area)))
    score += Math.min(2, Math.log10(1 + (Number(entry.source.downloads) || 0)) / 2)
    scored.push({ entry, score })
  }
  if (!scored.length) return null
  scored.sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id))
  // Из близких по качеству — по сиду места, чтобы две таверны одного мира
  // не оказывались одной и той же лучшей картой.
  const top = scored.filter((candidate) => candidate.score >= scored[0].score - 2).slice(0, 4)
  return top[hashNumber(`${seed}:map-library/v1`) % top.length].entry
}

/**
 * Идентификаторы библиотечных карт, уже лежащих в памяти локаций кампании.
 * Карта помечает себя сидом `library:<id>:<этаж>`.
 * @param {Record<string, any>|null|undefined} locationMaps
 * @returns {Set<string>}
 */
export function libraryIdsInUse(locationMaps) {
  /** @type {Set<string>} */
  const ids = new Set()
  for (const record of Object.values(locationMaps ?? {})) {
    const seed = String(record?.map?.seed ?? '')
    if (seed.startsWith(LIBRARY_SEED_PREFIX)) ids.add(seed.slice(LIBRARY_SEED_PREFIX.length).split(':')[0])
  }
  return ids
}

/**
 * Запись через временный файл. На Windows переименование поверх файла,
 * который в этот миг держит антивирус или читатель, отказывает с EPERM/EBUSY —
 * тогда несколько коротких повторов, а в крайнем случае прямая запись.
 * @param {string} file @param {unknown} value
 */
function writeJsonAtomic(file, value) {
  const text = `${JSON.stringify(value)}\n`
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, text)
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      renameSync(temporary, file)
      return
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(/** @type {any} */ (error)?.code)) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1))
    }
  }
  writeFileSync(file, text)
  rmSync(temporary, { force: true })
}

export class MapLibrary {
  /** @param {string} storageDir корень хранилища (`DND_STORAGE_DIR`) */
  constructor(storageDir) {
    this.dir = join(storageDir, MAP_LIBRARY_DIR)
    this.indexFile = join(this.dir, 'index.json')
    /** @type {{ mtime: number, entries: LibraryEntry[] }|null} */
    this.cache = null
  }

  /** @returns {LibraryEntry[]} */
  entries() {
    if (!existsSync(this.indexFile)) return []
    const mtime = statSync(this.indexFile).mtimeMs
    if (this.cache?.mtime === mtime) return this.cache.entries
    const parsed = JSON.parse(readFileSync(this.indexFile, 'utf8'))
    const entries = Array.isArray(parsed?.entries) ? parsed.entries.filter((/** @type {any} */ entry) => ENTRY_ID.test(String(entry?.id ?? ''))) : []
    this.cache = { mtime, entries }
    return entries
  }

  /**
   * Этажи записи.
   * @param {string} id
   * @returns {Array<{ index: number, label: string, map: Record<string, unknown> }>|null}
   */
  levels(id) {
    if (!ENTRY_ID.test(id)) return null
    const file = join(this.dir, 'maps', `${id}.json`)
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed?.levels) ? parsed.levels : null
  }

  /**
   * Добавляет или заменяет запись вместе с этажами.
   * @param {LibraryEntry} entry
   * @param {Array<{ index: number, label: string, map: Record<string, unknown> }>} levels
   */
  put(entry, levels) {
    if (!ENTRY_ID.test(entry.id)) throw new Error(`Неверный идентификатор записи библиотеки: ${entry.id}`)
    mkdirSync(join(this.dir, 'maps'), { recursive: true })
    writeJsonAtomic(join(this.dir, 'maps', `${entry.id}.json`), { schema_version: MAP_LIBRARY_SCHEMA_VERSION, id: entry.id, levels })
    const entries = [...this.entries().filter((candidate) => candidate.id !== entry.id), entry]
      .sort((left, right) => left.id.localeCompare(right.id))
    writeJsonAtomic(this.indexFile, { schema_version: MAP_LIBRARY_SCHEMA_VERSION, entries })
    this.cache = null
  }

  /**
   * Карта под заявку сцены вместе с этажами, или `null`.
   * @param {ReturnType<typeof libraryRequestFor>} request
   * @param {{ seed: string, usedIds?: Iterable<string> }} options
   */
  pick(request, options) {
    const entry = chooseLibraryMap(this.entries(), request, options)
    if (!entry) return null
    const levels = this.levels(entry.id)
    return levels?.some((level) => Number(level.index) === 0) ? { entry, levels } : null
  }
}

/** @type {MapLibrary|null} */
let active = null

/**
 * Сервер подключает библиотеку при старте. Тесты движка её не подключают,
 * поэтому генератор сцены в них ведёт себя как раньше.
 * @param {MapLibrary|null} library
 */
export function setActiveMapLibrary(library) {
  active = library
}

/** @returns {MapLibrary|null} */
export function activeMapLibrary() {
  return active
}
