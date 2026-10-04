// @ts-check
import { createHash } from 'node:crypto'

import { assetById } from './asset-registry.mjs'
import { addProp, cellAt, edgeList, edgeNeighbor, setCell, setEdge } from './tactical-map.mjs'

/**
 * Глубина карты поверх планировки: сюжетные виньетки, трудная местность и
 * развалины. Генератор расставляет предметы по назначению комнаты и поштучно,
 * поэтому карта читалась складом реквизита: ни следа того, что здесь было до
 * отряда, ни места, где шаг даётся дороже, ни укрытия посреди поля. Модуль —
 * лист: он знает только реестр ассетов и тактическую карту, ничего не
 * спрашивает у модели и детерминирован по сиду.
 *
 * Приёмы — из практики разметки боевых карт: «история в обстановке»
 * (брошенный лагерь, разорённое погребение), трудная местность как
 * тактический выбор (подлесок, завал, низкая мебель) и развалины как укрытие
 * и узкое место на открытой местности.
 */

/** @typedef {import('./tactical-map.mjs').TacticalMap} TacticalMap */
/** @typedef {{ asset: string, dx: number, dy: number, rotation?: number, state?: string }} VignettePart */
/**
 * `cue` — корни слов, по которым сцену узнают в тексте места, заголовке,
 * настроении и прибытии. `ambient` — тихая примета без события (старая могила,
 * грибной грот): она может встать и без слов. Виньетка с событием (брошенный
 * лагерь, драка, обряд) встаёт только по слову описания — иначе карта
 * рассказывала бы историю, которой нет ни у Рассказчика, ни у ведущего.
 * @typedef {{ id: string, parts: VignettePart[], nearRoad?: boolean, cue?: RegExp, ambient?: boolean }} Vignette
 */

/**
 * Виньетки по обстановке. Сломанным или опрокинутым ставится только
 * неинтерактивное (урна, мешок, колесо): состояние интерактивного предмета —
 * событие правил, а не декор генератора.
 * @type {Readonly<Record<'wild'|'cave'|'crypt'|'settlement'|'tavern', readonly Vignette[]>>}
 */
export const VIGNETTES = Object.freeze({
  wild: Object.freeze([
    // Костёр ещё горит, а хозяев нет: скатка, мешок, бревно вместо скамьи.
    { id: 'abandoned-camp', cue: /кострищ|костёр|костер|костра|ночлег|ночёвк|ночевк|следы (?:[а-яё]+ )?(?:стоянки|привала)|брошенн[а-яё]* (?:стоянк|лагер)/u, parts: [
      { asset: 'campfire', dx: 0, dy: 0 },
      { asset: 'bedroll_cluster', dx: 1, dy: 1 },
      { asset: 'sack', dx: 1, dy: -1 },
      { asset: 'fallen_log', dx: -2, dy: 1 },
    ] },
    // Телега у обочины: колесо отлетело, мешок распорот.
    { id: 'cart-wreck', nearRoad: true, cue: /телег|повозк|обоз|фургон|караван|опрокинут|засад/u, parts: [
      { asset: 'cart', dx: 0, dy: 0 },
      { asset: 'wagon_wheel', dx: 2, dy: 1, rotation: 90, state: 'broken' },
      { asset: 'sack', dx: -1, dy: 1, state: 'broken' },
      { asset: 'pebbles', dx: 1, dy: 1 },
    ] },
    // Могила у дороги — тихая примета: цветы и свеча, за ней кто-то ходит.
    { id: 'wayside-grave', nearRoad: true, ambient: true, cue: /могил|надгроб|похорон|погост|памятн/u, parts: [
      { asset: 'grave', dx: 0, dy: 0 },
      { asset: 'flowers', dx: 0, dy: 1 },
      { asset: 'candle', dx: 1, dy: 1 },
      { asset: 'rock_small', dx: 2, dy: 0 },
    ] },
    // Лёжка зверя: кости, палая листва, бурелом.
    { id: 'beast-lair', cue: /звер|волк|волч|медвед|берлог|логов|хищн|чудищ|чудовищ|твар[ьи]/u, parts: [
      { asset: 'bone_pile', dx: 0, dy: 0 },
      { asset: 'bone_pile', dx: 1, dy: 1 },
      { asset: 'leaf_litter', dx: -1, dy: 0 },
      { asset: 'dead_bramble', dx: 1, dy: -1 },
      { asset: 'fallen_log', dx: -1, dy: 2 },
    ] },
    // Бурелом — тихая примета леса: ствол поперёк, пень, листва и папоротник.
    { id: 'fallen-tree', ambient: true, cue: /бурелом|поваленн|упавш[а-яё]* (?:дерев|ствол)|ветровал/u, parts: [
      { asset: 'fallen_log', dx: 0, dy: 0 },
      { asset: 'tree_stump', dx: 2, dy: 0 },
      { asset: 'leaf_litter', dx: 0, dy: 1 },
      { asset: 'fern', dx: 1, dy: 1 },
    ] },
  ]),
  cave: Object.freeze([
    // Тот, кто дошёл сюда раньше: кости, распоротый мешок, рассыпанные монеты.
    { id: 'fallen-adventurer', cue: /искател|авантюрист|пропавш|погибш|сгинул|останк|скелет|экспедиц/u, parts: [
      { asset: 'bone_pile', dx: 0, dy: 0 },
      { asset: 'sack', dx: 1, dy: 0, state: 'broken' },
      { asset: 'coin_pile', dx: 0, dy: 1 },
      { asset: 'rock_small', dx: -1, dy: 1 },
    ] },
    // Тайник контрабандистов: ящик, бочка, мешки и огарок.
    { id: 'smuggler-cache', cue: /контрабанд|тайник|схрон|награбл|разбойн|бандит|краден/u, parts: [
      { asset: 'crate', dx: 0, dy: 0 },
      { asset: 'barrel', dx: 1, dy: 0 },
      { asset: 'sack', dx: 0, dy: 1 },
      { asset: 'candle', dx: 1, dy: 1 },
    ] },
    // Грибной грот — тихая примета сырой пещеры.
    { id: 'mushroom-grotto', ambient: true, cue: /гриб|плесен|сырост/u, parts: [
      { asset: 'giant_fungus', dx: 0, dy: 0 },
      { asset: 'mushroom_cluster', dx: 2, dy: 0 },
      { asset: 'mushroom_cluster', dx: 0, dy: 2 },
      { asset: 'pebbles', dx: 2, dy: 2 },
    ] },
  ]),
  crypt: Object.freeze([
    // Разорённое погребение: урны разбиты, кости разбросаны, монеты обронены.
    { id: 'looted-burial', cue: /разграбл|разорен|разорён|мародёр|мародер|грабител|осквернён|осквернен|вскрыт/u, parts: [
      { asset: 'urn', dx: 0, dy: 0, state: 'broken' },
      { asset: 'bone_pile', dx: 1, dy: 0 },
      { asset: 'urn', dx: 1, dy: 1, rotation: 90, state: 'toppled' },
      { asset: 'coin_pile', dx: 0, dy: 1 },
      { asset: 'rubble_heap', dx: -1, dy: 0 },
    ] },
    // Место обряда: круг на полу, свечи по краю, кости в стороне.
    { id: 'ritual-site', cue: /обряд|ритуал|культ|жертвоприн|некромант|сектант|призыв|колдовск|чернокниж/u, parts: [
      { asset: 'ritual_circle', dx: 0, dy: 0 },
      { asset: 'candle', dx: -1, dy: -1 },
      { asset: 'candle', dx: 1, dy: -1 },
      { asset: 'candle', dx: 0, dy: 1 },
      { asset: 'bone_heap', dx: 2, dy: 1 },
    ] },
    // Поминальное место — тихая примета: урна, свечи и чаша подношений.
    { id: 'memorial', ambient: true, cue: /помин|памят|предк|родов/u, parts: [
      { asset: 'urn', dx: 0, dy: 0 },
      { asset: 'candle', dx: 1, dy: 0 },
      { asset: 'candle', dx: -1, dy: 0 },
      { asset: 'offering_bowl', dx: 0, dy: 1 },
    ] },
  ]),
  tavern: Object.freeze([
    // Общий зал после драки: стулья опрокинуты, вино разлито, бутылка
    // разбита, кружка закатилась под стол.
    { id: 'after-brawl', cue: /драк|потасовк|поножовщ|дебош|буян|разгром|погром|скандал|мордобо/u, parts: [
      { asset: 'chair', dx: 0, dy: 0, rotation: 90, state: 'toppled' },
      { asset: 'wine_stain', dx: 1, dy: 0 },
      { asset: 'stool', dx: 2, dy: 1, state: 'toppled' },
      { asset: 'mug', dx: 1, dy: 1 },
      { asset: 'bottle', dx: 0, dy: 1, state: 'broken' },
    ] },
  ]),
  settlement: Object.freeze([
    { id: 'cart-wreck', nearRoad: true, cue: /телег|повозк|обоз|фургон|караван|опрокинут/u, parts: [
      { asset: 'cart', dx: 0, dy: 0 },
      { asset: 'wagon_wheel', dx: 2, dy: 1, rotation: 90, state: 'broken' },
      { asset: 'sack', dx: -1, dy: 1, state: 'broken' },
    ] },
    // Дровяной двор — тихая примета деревни: козлы, пень и поленница.
    { id: 'woodcutting', ambient: true, cue: /дров|лесоруб|плотник|пилорам/u, parts: [
      { asset: 'sawhorse', dx: 0, dy: 0 },
      { asset: 'tree_stump', dx: 2, dy: 0 },
      { asset: 'woodpile', dx: 0, dy: 2 },
      { asset: 'sawdust', dx: 2, dy: 1 },
    ] },
  ]),
})

const SIDES = /** @type {const} */ ([[1, 0], [-1, 0], [0, 1], [0, -1]])

/** @param {number} x @param {number} y */
const cellKey = (x, y) => `${x},${y}`

/** @param {string} seed @returns {() => number} */
function randomFor(seed) {
  let state = createHash('sha256').update(String(seed)).digest().readUInt32LE(0) || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/**
 * Перемешивание по сиду: порядок кандидатов не зависит от обхода карты, и одна
 * и та же карта получает ту же обстановку.
 * @template T
 * @param {T[]} items
 * @param {() => number} random
 * @returns {T[]}
 */
function shuffled(items, random) {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1))
    ;[copy[index], copy[other]] = [copy[other], copy[index]]
  }
  return copy
}

/**
 * Клетки, которые обстановка не трогает: вход отряда и его окрестность,
 * подходы к дверям, лестницы и люки, край карты. Остальная расстановка бережёт
 * их же — иначе следующий шаг снял бы виньетку ремонтом доступа.
 * @param {TacticalMap} map
 * @param {number} spawnRadius
 * @returns {Set<string>}
 */
function reservedCells(map, spawnRadius) {
  /** @type {Set<string>} */
  const reserved = new Set()
  for (const point of map.spawnPoints) {
    const radius = point.role === 'party' ? spawnRadius : 1
    for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) reserved.add(cellKey(point.x + dx, point.y + dy))
  }
  for (const door of map.doors) {
    const next = edgeNeighbor(door)
    const step = { x: next.x - door.x, y: next.y - door.y }
    for (const point of [{ x: door.x, y: door.y }, next, { x: door.x - step.x, y: door.y - step.y }, { x: next.x + step.x, y: next.y + step.y }]) reserved.add(cellKey(point.x, point.y))
  }
  for (const prop of map.props) {
    if (!prop.transition) continue
    for (const point of prop.footprint ?? []) reserved.add(cellKey(point.x, point.y))
  }
  for (let x = 0; x < map.width; x += 1) { reserved.add(cellKey(x, 0)); reserved.add(cellKey(x, map.height - 1)) }
  for (let y = 0; y < map.height; y += 1) { reserved.add(cellKey(0, y)); reserved.add(cellKey(map.width - 1, y)) }
  return reserved
}

/**
 * Клетки под предметами и у рёбер-стен: виньетка не встаёт ни на предмет, ни
 * вплотную к стене (иначе встаёт поперёк прохода в пролом), а второй остов
 * развалин — на первый.
 * @param {TacticalMap} map
 * @returns {Set<string>}
 */
function occupiedCells(map) {
  /** @type {Set<string>} */
  const occupied = new Set()
  for (const prop of map.props) {
    const footprint = prop.footprint?.length ? prop.footprint : [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]
    for (const point of footprint) occupied.add(cellKey(point.x, point.y))
  }
  for (const edge of edgeList(map)) {
    if (edge.kind === 'door') continue
    const next = edgeNeighbor(edge)
    occupied.add(cellKey(edge.x, edge.y))
    occupied.add(cellKey(next.x, next.y))
  }
  return occupied
}

/**
 * Дорога: утоптанная земля поверх иного покрытия поля, а в поселении — улица
 * и площадь. Где земля и есть покрытие (болото), дороги отдельно не видно.
 * @param {TacticalMap} map
 * @param {number} x
 * @param {number} y
 */
function onRoad(map, x, y) {
  const cell = cellAt(map, x, y)
  if (!cell) return false
  if (cell.zone === 'street' || cell.zone === 'square') return true
  if (cell.material !== 'earth') return false
  const zone = map.zones.find((entry) => entry.id === cell.zone)
  return Boolean(zone && zone.material !== 'earth')
}

/**
 * Свободная земля для обстановки: проходимая сухая клетка разрешённой зоны,
 * не занятая предметом, не дорога и не бережёная.
 * @param {TacticalMap} map
 * @param {number} x
 * @param {number} y
 * @param {{ zones: Set<string>|null, occupied: Set<string>, reserved: Set<string> }} context
 */
function freeGround(map, x, y, { zones, occupied, reserved }) {
  const cell = cellAt(map, x, y)
  if (!cell?.passable || cell.surface === 'water' || cell.surface === 'oil') return false
  if (zones && !zones.has(cell.zone)) return false
  const key = cellKey(x, y)
  return !occupied.has(key) && !reserved.has(key) && !onRoad(map, x, y)
}

/**
 * Клетки части виньетки: футпринт предмета либо одна клетка под наклейкой.
 * @param {VignettePart} part
 * @param {number} ax
 * @param {number} ay
 */
function partCells(part, ax, ay) {
  const asset = assetById(part.asset)
  if (!asset) return null
  const quarter = Math.round((((part.rotation ?? 0) % 360) + 360) % 360 / 90) % 2 === 1
  const width = Math.max(1, quarter ? asset.baseFootprint.h : asset.baseFootprint.w)
  const height = Math.max(1, quarter ? asset.baseFootprint.w : asset.baseFootprint.h)
  /** @type {Array<{x: number, y: number}>} */
  const cells = []
  for (let dy = 0; dy < height; dy += 1) for (let dx = 0; dx < width; dx += 1) cells.push({ x: ax + part.dx + dx, y: ay + part.dy + dy })
  return { asset, cells, width, height, flat: !asset.baseFootprint.w }
}

/**
 * Какие виньетки набора названы текстом сцены.
 * @param {keyof typeof VIGNETTES} set
 * @param {string} text
 * @returns {string[]}
 */
export function vignettesNamedBy(set, text) {
  const lower = String(text ?? '').toLocaleLowerCase('ru')
  return (VIGNETTES[set] ?? []).filter((recipe) => recipe.cue?.test(lower)).map((recipe) => recipe.id)
}

/**
 * Сюжетные виньетки: небольшие группы готовых предметов, которые читаются
 * историей места. Названное текстом сцены (`text`: место, заголовок,
 * настроение, прибытие) встаёт всегда, сколько бы его ни было; свободные
 * места до `limit` занимают только тихие приметы. Ставятся до обычной
 * расстановки, поэтому её случайный добор обходит их стороной. Возвращает
 * идентификаторы поставленных.
 *
 * @param {TacticalMap} map
 * @param {{ seed: string|number, set: keyof typeof VIGNETTES, zones?: string[]|null, limit?: number, text?: string }} options
 * @returns {string[]}
 */
export function placeVignettes(map, { seed, set, zones = null, limit = 1, text = '' }) {
  const recipes = VIGNETTES[set] ?? []
  if (!recipes.length) return []
  const random = randomFor(`vignettes:${set}:${seed}`)
  const named = new Set(vignettesNamedBy(set, text))
  const wanted = shuffled(recipes.filter((recipe) => named.has(recipe.id)), random)
  const quiet = shuffled(recipes.filter((recipe) => recipe.ambient && !named.has(recipe.id)), random)
  const budget = Math.max(limit, wanted.length)
  if (budget <= 0) return []
  const reserved = reservedCells(map, 3)
  const occupied = occupiedCells(map)
  const allowed = zones ? new Set(zones) : null
  /** @type {Array<{x: number, y: number}>} */
  const ground = []
  for (let y = 1; y < map.height - 1; y += 1) for (let x = 1; x < map.width - 1; x += 1) {
    if (freeGround(map, x, y, { zones: allowed, occupied, reserved })) ground.push({ x, y })
  }
  /** @type {string[]} */
  const placed = []
  /** @type {Array<{x: number, y: number}>} */
  const anchors = []
  for (const recipe of [...wanted, ...quiet]) {
    // Тихая примета — только на свободное место в пределе; названное — сверх.
    if (placed.length >= (named.has(recipe.id) ? budget : limit)) continue
    for (const anchor of shuffled(ground, random)) {
      // Виньетки — не кучей: каждая своя история и своё место.
      if (anchors.some((other) => Math.abs(other.x - anchor.x) + Math.abs(other.y - anchor.y) < 7)) continue
      if (recipe.nearRoad && !nearRoad(map, anchor.x, anchor.y)) continue
      const layout = recipe.parts.map((part) => ({ part, cells: partCells(part, anchor.x, anchor.y) }))
      /** @type {Set<string>} */
      const used = new Set()
      const fits = layout.every(({ cells }) => cells && cells.cells.every((point) => {
        const key = cellKey(point.x, point.y)
        if (used.has(key) || !freeGround(map, point.x, point.y, { zones: allowed, occupied, reserved })) return false
        used.add(key)
        return true
      }))
      if (!fits) continue
      layout.forEach(({ part, cells }, index) => {
        if (!cells) return
        const { asset } = cells
        addProp(map, {
          id: `vignette-${recipe.id}-${placed.length + 1}-${index + 1}`,
          assetId: asset.id,
          x: anchor.x + part.dx + cells.width / 2,
          y: anchor.y + part.dy + cells.height / 2,
          rotation: part.rotation ?? 0,
          scale: 1,
          footprint: cells.flat ? [] : cells.cells,
          zOrder: 0,
          blocksMove: asset.blocksMove,
          blocksSight: asset.blocksSight,
          cover: asset.cover,
          destructible: asset.destructible,
          hp: asset.hp,
          interactive: asset.interactive,
          ...(part.state ? { state: part.state } : {}),
        })
      })
      // Клетки виньетки и кольцо вокруг заняты: следующая встанет поодаль.
      for (const key of used) {
        const [x, y] = key.split(',').map(Number)
        for (const [dx, dy] of [[0, 0], ...SIDES]) occupied.add(cellKey(x + dx, y + dy))
      }
      anchors.push(anchor)
      placed.push(recipe.id)
      break
    }
  }
  return placed
}

/** @param {TacticalMap} map @param {number} x @param {number} y */
function nearRoad(map, x, y) {
  for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
    if (onRoad(map, x + dx, y + dy)) return true
  }
  return false
}

/** Наклейки, которыми отмечена трудная местность. */
const ROUGH_DECALS = Object.freeze({
  undergrowth: ['fern', 'leaf_litter', 'forest_plant'],
  rubble: ['scree', 'pebbles'],
  snow: ['snowdrift'],
  sand: ['sand_dune'],
  mud: ['mud_patch'],
})

/** Покрытие клетки под трудной местностью; подлесок и наносы его не меняют. */
const ROUGH_SURFACES = Object.freeze({ rubble: 'rubble', mud: 'mud' })

/**
 * Трудная местность пятнами: подлесок в лесу и у дороги, завал в пещере,
 * склепе, тюрьме и разрушенном храме, снежные заносы зимой, песчаные наносы
 * в пустыне, грязь во дворах деревни. Шаг по такой клетке стоит вдвое
 * (`moveCost` 2, правило движка), и доска штрихует её в 2D и 3D. Пятно —
 * несколько клеток, а не полоса: обойти можно, но обход стоит хода. Дорога,
 * улица, вход и подходы к дверям не трогаются.
 *
 * @param {TacticalMap} map
 * @param {{ seed: string|number, kind: keyof typeof ROUGH_DECALS, zones?: string[]|null, patches?: number }} options
 * @returns {number} сколько клеток стало трудными
 */
export function roughenGround(map, { seed, kind, zones = null, patches = 2 }) {
  const random = randomFor(`rough:${kind}:${seed}`)
  const reserved = reservedCells(map, 4)
  const allowed = zones ? new Set(zones) : null
  const occupied = new Set()
  /** @param {number} x @param {number} y */
  const eligible = (x, y) => {
    const cell = cellAt(map, x, y)
    return Boolean(cell && cell.moveCost <= 1 && freeGround(map, x, y, { zones: allowed, occupied, reserved }))
  }
  /** @type {Array<{x: number, y: number}>} */
  const ground = []
  for (let y = 1; y < map.height - 1; y += 1) for (let x = 1; x < map.width - 1; x += 1) if (eligible(x, y)) ground.push({ x, y })
  /** @type {Array<{x: number, y: number}>} */
  const centers = []
  let changed = 0
  const busy = occupiedCells(map)
  const surface = ROUGH_SURFACES[/** @type {keyof typeof ROUGH_SURFACES} */ (kind)]
  for (const center of shuffled(ground, random)) {
    if (centers.length >= patches) break
    if (centers.some((other) => Math.abs(other.x - center.x) + Math.abs(other.y - center.y) < 6)) continue
    const radius = 1.3 + random()
    /** @type {Array<{x: number, y: number}>} */
    const cells = []
    for (let dy = -3; dy <= 3; dy += 1) for (let dx = -3; dx <= 3; dx += 1) {
      const x = center.x + dx
      const y = center.y + dy
      // Неровный край пятна: шум по углу, а не ровный круг.
      const wobble = 1 + Math.sin(Math.atan2(dy, dx) * 3 + center.x) * 0.25
      if (Math.hypot(dx, dy) > radius * wobble || !eligible(x, y)) continue
      cells.push({ x, y })
    }
    if (cells.length < 3) continue
    centers.push(center)
    for (const point of cells) {
      setCell(map, point.x, point.y, { moveCost: 2, ...(surface ? { surface } : {}) })
      changed += 1
    }
    // Чем пятно трудно — видно и без штриховки: папоротник и листва в
    // подлеске, щебень и галька в завале. Наклейки — поодаль друг от друга:
    // три одинаковых вплотную проверка карты считает кучей.
    const decals = ROUGH_DECALS[kind]
    /** @type {Array<{x: number, y: number}>} */
    const chosen = []
    /** @param {{x: number, y: number}} a @param {{x: number, y: number}} b */
    const touching = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1
    for (const point of shuffled(cells, random)) {
      if (chosen.length >= Math.min(3, Math.ceil(cells.length / 3))) break
      if (busy.has(cellKey(point.x, point.y))) continue
      if (chosen.some((other) => touching(other, point))) continue
      // Такой же предмет рядом — и по диагонали — уже стоит: третий в ряд
      // проверка карты считает кучей.
      const assetId = decals[chosen.length % decals.length]
      if (map.props.some((prop) => prop.assetId === assetId && touching({ x: Math.floor(prop.x), y: Math.floor(prop.y) }, point))) continue
      chosen.push(point)
    }
    chosen.forEach((point, index) => {
      const asset = assetById(decals[index % decals.length])
      if (!asset) return
      addProp(map, {
        id: `rough-${kind}-${centers.length}-${index + 1}`,
        assetId: asset.id,
        x: point.x + 0.5,
        y: point.y + 0.5,
        rotation: Math.floor(random() * 4) * 90,
        scale: 0.9 + random() * 0.25,
        footprint: [],
        zOrder: 0,
        blocksMove: false,
        blocksSight: false,
        cover: 'none',
        destructible: false,
        hp: 0,
        interactive: false,
      })
      busy.add(cellKey(point.x, point.y))
    })
  }
  return changed
}

/**
 * Низкая мебель — трудная местность (5e): клетки под скамьями и подушками для
 * коленопреклонения, через которые проходят, но не шагают свободно. Мебель,
 * которая держит шаг целиком, сюда не входит — её клетка и так непроходима.
 *
 * @param {TacticalMap} map
 * @param {readonly string[]} assetIds
 * @returns {number} сколько клеток стало трудными
 */
export function markLowFurniture(map, assetIds) {
  const ids = new Set(assetIds)
  const reserved = reservedCells(map, 1)
  let changed = 0
  for (const prop of map.props) {
    if (!ids.has(prop.assetId) || prop.blocksMove) continue
    for (const point of prop.footprint ?? []) {
      const cell = cellAt(map, point.x, point.y)
      if (!cell?.passable || cell.moveCost > 1 || reserved.has(cellKey(point.x, point.y))) continue
      setCell(map, point.x, point.y, { moveCost: 2 })
      changed += 1
    }
  }
  return changed
}

/**
 * Остов развалин в виде рамки или линии стен-рёбер. `house` — дом без крыши,
 * `tower` — квадрат сторожевой башни, где уцелело почти всё, `wall` —
 * обрывок крепостной стены.
 * @typedef {'house'|'tower'|'wall'} RuinShape
 */

/** @type {readonly RuinShape[]} */
const RUIN_SHAPES = Object.freeze(['house', 'house', 'tower', 'wall'])

/**
 * Развалины: остов постройки — обрывки стен по периметру с проломами, плиты
 * пола местами, завал внутри и уцелевшая колонна, либо обрывок крепостной
 * стены. Это укрытие и узкие места на открытом месте, где иначе укрыться
 * можно только за деревом. Стены — рёбра клеток, как у построек; в остов
 * ведут проломы шириной от двух клеток, поэтому досягаемость не меняется.
 * Зона остаётся прежней: это не дом, у него нет ни двери, ни окон, ни крыши.
 *
 * @param {TacticalMap} map
 * @param {{ seed: string|number, zone?: string, shape?: RuinShape|null, index?: number }} options
 * @returns {{ x: number, y: number, width: number, height: number, shape: RuinShape }|null}
 */
export function placeRuins(map, { seed, zone = 'field', shape = null, index = 1 }) {
  const random = randomFor(`ruins:${seed}`)
  const form = shape ?? RUIN_SHAPES[Math.floor(random() * RUIN_SHAPES.length)]
  const preferAlong = random() < 0.5
  const span = form === 'tower' ? 4 + Math.floor(random() * 2) : form === 'wall' ? 8 + Math.floor(random() * 4) : 5 + Math.floor(random() * 3)
  const depth = form === 'tower' ? span : form === 'wall' ? 1 : 4 + Math.floor(random() * 3)
  const reserved = reservedCells(map, 6)
  const occupied = occupiedCells(map)
  const allowed = new Set([zone])
  // Обрывок стены пробует обе ориентации: поперёк дороги он не встаёт, а
  // вдоль — встанет. Остов дома и башни лежат так, как выпали.
  const orientations = form === 'wall' ? [preferAlong, !preferAlong] : [true]
  /** @type {{x: number, y: number}|null} */
  let origin = null
  let along = preferAlong
  let width = span
  let height = depth
  for (const option of orientations) {
    along = option
    width = form === 'wall' && !along ? 1 : span
    height = form === 'wall' && !along ? span : depth
    /** @param {number} x0 @param {number} y0 */
    const fits = (x0, y0) => {
      // Остов и клетка вокруг — свободная земля: стена не встаёт вплотную к
      // воде, скале, дороге, дому или другим развалинам.
      for (let y = y0 - 1; y <= y0 + height; y += 1) for (let x = x0 - 1; x <= x0 + width; x += 1) {
        if (!freeGround(map, x, y, { zones: allowed, occupied, reserved })) return false
      }
      return true
    }
    /** @type {Array<{x: number, y: number}>} */
    const corners = []
    for (let y = 2; y + height + 2 <= map.height; y += 1) for (let x = 2; x + width + 2 <= map.width; x += 1) corners.push({ x, y })
    origin = shuffled(corners, random).find((corner) => fits(corner.x, corner.y)) ?? null
    if (origin) break
  }
  if (!origin) return null
  const { x: x0, y: y0 } = origin
  const wall = { kind: 'wall', blocksMove: true, blocksSight: true, cover: 'three_quarters' }
  /** @param {string} assetId @param {number} x @param {number} y @param {number} number */
  const place = (assetId, x, y, number) => {
    const asset = assetById(assetId)
    if (!asset) return
    const flat = !asset.baseFootprint.w
    addProp(map, {
      id: `ruins-${index}-${assetId}-${number}`,
      assetId,
      x: x + 0.5,
      y: y + 0.5,
      rotation: 0,
      scale: 1,
      footprint: flat ? [] : [{ x, y }],
      zOrder: 0,
      blocksMove: asset.blocksMove,
      blocksSight: asset.blocksSight,
      cover: asset.cover,
      destructible: asset.destructible,
      hp: asset.hp,
      interactive: asset.interactive,
    })
  }
  if (form === 'wall') {
    // Обрывок стены: рёбра вдоль линии, два-три пролома. Обломки кладки и
    // щебень — по обе стороны.
    const cells = along
      ? Array.from({ length: width }, (_, step) => ({ x: x0 + step, y: y0, nx: x0 + step, ny: y0 + 1 }))
      : Array.from({ length: height }, (_, step) => ({ x: x0, y: y0 + step, nx: x0 + 1, ny: y0 + step }))
    const standing = cells.map(() => random() < 0.8)
    for (let gap = 0; gap < 2 + Math.floor(random() * 2); gap += 1) {
      const start = 1 + Math.floor(random() * Math.max(1, cells.length - 3))
      standing[start] = false
      standing[start + 1] = false
    }
    cells.forEach((edge, step) => { if (standing[step]) setEdge(map, edge.x, edge.y, edge.nx, edge.ny, wall) })
    const scatter = shuffled(cells.filter((_, step) => !standing[step]), random)
    if (scatter[0]) place('rubble_heap', scatter[0].x, scatter[0].y, 1)
    if (scatter[1]) place('scree', scatter[1].nx, scatter[1].ny, 1)
    const ends = [cells[0], cells[cells.length - 1]]
    place('mossy_rock', along ? ends[0].x - 1 : ends[0].x, along ? ends[0].y : ends[0].y - 1, 1)
    return { x: x0, y: y0, width, height, shape: form }
  }
  // Периметр — по сторонам, каждая сторона — ряд рёбер изнутри наружу.
  /** @type {Array<Array<{x: number, y: number, nx: number, ny: number}>>} */
  const sides = [
    Array.from({ length: width }, (_, step) => ({ x: x0 + step, y: y0, nx: x0 + step, ny: y0 - 1 })),
    Array.from({ length: width }, (_, step) => ({ x: x0 + step, y: y0 + height - 1, nx: x0 + step, ny: y0 + height })),
    Array.from({ length: height }, (_, step) => ({ x: x0, y: y0 + step, nx: x0 - 1, ny: y0 + step })),
    Array.from({ length: height }, (_, step) => ({ x: x0 + width - 1, y: y0 + step, nx: x0 + width, ny: y0 + step })),
  ]
  // Углы держатся дольше всего; середина стен выкрошена. Башня уцелела почти
  // вся: у неё один пролом, у дома — два.
  const keep = form === 'tower' ? 0.9 : 0.55
  const standing = sides.map((side) => side.map((_, step) => step === 0 || step === side.length - 1 || random() < keep))
  for (const sideIndex of shuffled([0, 1, 2, 3], random).slice(0, form === 'tower' ? 1 : 2)) {
    const side = standing[sideIndex]
    const start = 1 + Math.floor(random() * Math.max(1, side.length - 3))
    side[start] = false
    side[Math.min(side.length - 2, start + 1)] = false
  }
  sides.forEach((side, sideIndex) => side.forEach((edge, step) => {
    if (standing[sideIndex][step]) setEdge(map, edge.x, edge.y, edge.nx, edge.ny, wall)
  }))
  // Пол: плиты местами уцелели, остальное заросло. В углу — завал.
  for (let y = y0; y < y0 + height; y += 1) for (let x = x0; x < x0 + width; x += 1) {
    if (random() < 0.7) setCell(map, x, y, { material: 'stone' })
  }
  const rubbleCorner = { x: random() < 0.5 ? x0 : x0 + width - 2, y: random() < 0.5 ? y0 : y0 + height - 2 }
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) setCell(map, rubbleCorner.x + dx, rubbleCorner.y + dy, { surface: 'rubble', moveCost: 2, material: 'stone' })
  place('rubble_heap', rubbleCorner.x + 1, rubbleCorner.y + 1, 1)
  place('scree', rubbleCorner.x, rubbleCorner.y, 1)
  // Уцелевшая колонна — в углу напротив завала, не в проходе. В башне её
  // место занимает обломок кладки.
  const pillar = { x: rubbleCorner.x === x0 ? x0 + width - 1 : x0, y: rubbleCorner.y === y0 ? y0 + height - 1 : y0 }
  place(form === 'tower' ? 'mossy_rock' : 'pillar', pillar.x, pillar.y, 1)
  // Камни у стен снаружи — обломки кладки.
  const outside = sides.flat().filter((edge) => freeGround(map, edge.nx, edge.ny, { zones: allowed, occupied: occupiedCells(map), reserved }))
  shuffled(outside, random).slice(0, 2).forEach((edge, number) => place(number === 0 ? 'mossy_rock' : 'pebbles', edge.nx, edge.ny, number + 2))
  return { x: x0, y: y0, width, height, shape: form }
}

/**
 * Несколько остовов на карту: по размеру участка, а названные текстом
 * развалины — всегда хотя бы один. Каждый следующий встаёт поодаль от
 * прежних (`occupiedCells` видит их стены).
 *
 * @param {TacticalMap} map
 * @param {{ seed: string|number, zone?: string, asked?: boolean, chance?: number }} options
 * @returns {number} сколько остовов поставлено
 */
export function placeRuinsField(map, { seed, zone = 'field', asked = false, chance = 0.4 }) {
  const random = randomFor(`ruins-field:${seed}`)
  const area = map.width * map.height
  // Карта до 900 клеток держит один остов, больше — до трёх.
  const most = area >= 1500 ? 3 : area >= 900 ? 2 : 1
  let wanted = asked ? 1 : 0
  for (let roll = wanted; roll < most; roll += 1) {
    if (random() < (roll === 0 ? chance : chance * 0.6)) wanted += 1
    else break
  }
  if (asked && most > 1 && random() < 0.5) wanted = Math.max(wanted, 2)
  let placed = 0
  for (let index = 0; index < Math.min(wanted, most); index += 1) {
    if (placeRuins(map, { seed: `${seed}:${index}`, zone, index: index + 1 })) placed += 1
  }
  return placed
}
