import '../../../fixtures-env.mjs'
// Эталон server/encounter-assembler.mjs для Rust (`sk-encounters`):
//
//   node rust/crates/sk-encounters/fixtures/gen-encounter-assembler.mjs
//
// Источники входов сборщика:
//
// - постоянные модуля: версия, пределы, источники, бестиарий SRD 5.2.1, темы,
//   сложности, ярлыки и предупреждение;
// - `encounterDifficultyLabel` и `encounterBarrierSides` на рыхлых входах;
// - открытое поле (как в `test/encounter-assembler.test.mjs`): все темы, все
//   сложности, обе редакции, разный размер и уровень отряда;
// - случайные сцены: стены, вода, двери, перегородки, реквизит, занятые и
//   скрытые клетки, сдвинутое начало сетки, поля больше порога подрайона;
// - корпус карт: 56 нарисованных `data/authored-location-maps-v1.json` и
//   сцены `generateSceneGeometry` по темам, сторонам входа и программам
//   корпуса — клетки собраны так же, как их собирает движок
//   (`encounterAssemblyInput`: занятость реквизитом, тонкие стены и окна);
// - входы, которые передал сборщику настоящий движок (`CreateEncounter` в
//   кампании «Асстоханские равнины»): перехват `assembleEncounter` хуком
//   загрузки модуля. Здесь же известный баг: повторный визит двух героев в
//   Редстоуновку — `NO_SAFE_PLACEMENT_CELLS` на всех сидах;
// - рыхлые и испорченные входы — отказы проверки границ по порядку полей.
//
// Сцена хранится сжато (`encodeScene`): строка на ряд клеток, тип и видимость
// одним символом, тонкие стены — второй сеткой; Rust раскрывает её так же
// (`decode_scene` в тесте). Предложение сборщика — SHA-256 строки
// `JSON.stringify`, рядом — сводка (существа, клетки, бюджет) для отладки.
import { registerHooks } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

const root = new URL('../../../../', import.meta.url)

// Перехват входов `assembleEncounter`: модуль сборщика грузится с одной лишней
// строкой — записью входа в `globalThis.__encounterRecorder`. Поведение не
// меняется; без записывающего хука строка ничего не делает.
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith('/server/encounter-assembler.mjs')) return result
    const source = String(result.source)
    const patched = source.replace(
      /export function assembleEncounter\(input\) \{\r?\n {2}return new EncounterAssembler\(\)\.assemble\(input\)\r?\n\}/u,
      'export function assembleEncounter(input) {\n  globalThis.__encounterRecorder?.(input)\n  return new EncounterAssembler().assemble(input)\n}',
    )
    if (patched === source) throw new Error('не нашёл assembleEncounter для перехвата')
    return { ...result, source: patched }
  },
})

const E = await import(new URL('server/encounter-assembler.mjs', root).href)
const t = await import(new URL('server/tactical-map.mjs', root).href)
const { propMovementPositions } = await import(new URL('server/rules/tactical-geometry.mjs', root).href)
const { generateSceneGeometry } = await import(new URL('server/adventure-director.mjs', root).href)
const { sceneMapRequirementsFor } = await import(new URL('server/scene-requirements.mjs', root).href)
const { listAssets } = await import(new URL('server/asset-registry.mjs', root).href)

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(2026_10_15)
const int = (n) => Math.floor(random() * n)
const pick = (items) => items[int(items.length)]
const chance = (p) => random() < p

const UNDEFINED = '\u0000undefined'
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const errorOf = (error) => ({ name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error) })

// --- сжатая сцена ------------------------------------------------------------

const TYPE_CHAR = { floor: 'f', wall: 'w', water: 'o', door: 'd' }
const CHAR_TYPE = Object.fromEntries(Object.entries(TYPE_CHAR).map(([type, char]) => [char, type]))
const WALL_CHAR = { e: 'e', s: 's', es: 'b' }

/** Клетки (уже в форме входа сборщика) → сжатая сцена. */
function encodeScene(cells, extra = {}) {
  const xs = cells.map((cell) => cell.x)
  const ys = cells.map((cell) => cell.y)
  const ox = Math.min(...xs)
  const oy = Math.min(...ys)
  const w = Math.max(...xs) - ox + 1
  const h = Math.max(...ys) - oy + 1
  const rows = Array.from({ length: h }, () => Array(w).fill(' '))
  const walls = Array.from({ length: h }, () => Array(w).fill('.'))
  const features = []
  const occupied = []
  let anyWall = false
  for (const cell of cells) {
    const char = TYPE_CHAR[cell.type]
    rows[cell.y - oy][cell.x - ox] = cell.revealed ? char : char.toUpperCase()
    if (cell.walls) {
      walls[cell.y - oy][cell.x - ox] = WALL_CHAR[cell.walls]
      anyWall = true
    }
    if (cell.feature != null) features.push([cell.x, cell.y, cell.feature])
    if (cell.occupied === true) occupied.push([cell.x, cell.y])
  }
  return {
    ox, oy, w, h,
    rows: rows.map((row) => row.join('')),
    ...(anyWall ? { walls: walls.map((row) => row.join('')) } : {}),
    ...(features.length ? { features } : {}),
    ...(occupied.length ? { occupied } : {}),
    ...extra,
  }
}

/** Сжатая сцена → клетки входа (ряд за рядом), как `decode_scene` в Rust. */
function decodeScene(scene) {
  const features = new Map((scene.features ?? []).map(([x, y, feature]) => [`${x},${y}`, feature]))
  const occupied = new Set((scene.occupied ?? []).map(([x, y]) => `${x},${y}`))
  const cells = []
  for (let y = 0; y < scene.h; y += 1) {
    for (let x = 0; x < scene.w; x += 1) {
      const char = scene.rows[y][x]
      if (char === ' ') continue
      const cx = scene.ox + x
      const cy = scene.oy + y
      const key = `${cx},${cy}`
      const wall = scene.walls?.[y][x] ?? '.'
      cells.push({
        x: cx,
        y: cy,
        type: CHAR_TYPE[char.toLowerCase()],
        revealed: scene.reveal === true ? true : char === char.toLowerCase(),
        ...(features.has(key) ? { feature: features.get(key) } : {}),
        ...(occupied.has(key) ? { occupied: true } : {}),
        ...(wall === '.' ? {} : { walls: wall === 'b' ? 'es' : wall }),
      })
    }
  }
  return cells
}

const sortCells = (cells) => [...cells].sort((a, b) => a.y - b.y || a.x - b.x)

// --- сборка случаев ----------------------------------------------------------

const scenes = []
const cases = []

const sceneIndex = new Map()
function addScene(scene) {
  const key = JSON.stringify(scene)
  if (!sceneIndex.has(key)) {
    scenes.push(scene)
    sceneIndex.set(key, scenes.length - 1)
  }
  return sceneIndex.get(key)
}

function inputFor(entry) {
  return {
    scene: { cells: decodeScene(scenes[entry.scene]) },
    party: entry.party,
    difficulty: entry.difficulty,
    theme: entry.theme,
    seed: entry.seed,
    ...(Object.hasOwn(entry, 'ruleset_id') ? { ruleset_id: entry.ruleset_id } : {}),
  }
}

function summary(proposal) {
  return {
    hash: sha(proposal),
    enemies: proposal.enemies.map((enemy) => [enemy.stat_block_id, enemy.x, enemy.y, enemy.footprint?.size ?? 1]),
    xp: [proposal.xp_budget, proposal.xp_spent, proposal.threat.quantity_cap],
  }
}

function run(input) {
  try {
    return summary(E.assembleEncounter(input))
  } catch (error) {
    return { error: errorOf(error) }
  }
}

function addCase(entry, label = '') {
  const result = run(inputFor(entry))
  cases.push({ ...(label ? { label } : {}), ...entry, out: result })
  return result
}

const walkableFree = (cells) => cells.filter((cell) => cell.revealed && (cell.type === 'floor' || cell.type === 'door'))

const ID_POOL = ['hero-1', 'hero-2', 'hero-10', 'Hero', 'hero', 'герой', 'Ёж', 'ёж', 'a-b', 'a_b', 'ab', 'AB', 'z', '1', '10', '2', 'β', 'Ω', 'x y', 'hero 3', 'hero-01']

function randomParty(cells, size, levels) {
  const free = walkableFree(cells)
  const used = new Set()
  const ids = new Set()
  const party = []
  for (let attempt = 0; party.length < size && attempt < 200; attempt += 1) {
    const cell = pick(free)
    if (!cell) break
    const key = `${cell.x},${cell.y}`
    if (used.has(key)) continue
    let id = chance(0.6) ? `hero-${party.length + 1}` : pick(ID_POOL)
    if (ids.has(id)) id = `${id}-${party.length}`
    ids.add(id)
    used.add(key)
    party.push({ id, level: levels(party.length), x: cell.x, y: cell.y })
  }
  return party
}

const levelPolicy = () => {
  const roll = random()
  if (roll < 0.35) {
    const level = pick([1, 1, 2, 3, 4, 5])
    return () => level
  }
  if (roll < 0.7) return () => 1 + int(6)
  if (roll < 0.9) return () => 1 + int(20)
  const level = pick([10, 15, 20])
  return () => level
}
const randomSeed = () => pick([
  () => `seed-${int(100_000)}`,
  () => `campaign:chapter-${int(9)}:encounter-${int(30)}`,
  () => `засада-${int(1000)}`,
  () => `  padded-${int(100)}  `,
  () => `${'x'.repeat(int(4) + 1)}:${int(50)}`,
])()
const rulesetChoice = () => {
  const roll = random()
  if (roll < 0.45) return {}
  if (roll < 0.8) return { ruleset_id: 'dnd_5e_2014' }
  if (roll < 0.92) return { ruleset_id: 'srd_5_2_1' }
  return { ruleset_id: null }
}

// 1. Открытое поле: все темы × сложности × редакции × состав отряда.
function openField(width, height) {
  const cells = []
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) cells.push({ x, y, type: 'floor', revealed: true })
  return cells
}
const field7x5 = addScene(encodeScene(openField(7, 5)))
const field14x10 = addScene(encodeScene(openField(14, 10)))
const field12x12 = addScene(encodeScene(openField(12, 12)))
for (const theme of E.ENCOUNTER_THEMES) {
  for (const difficulty of E.ENCOUNTER_DIFFICULTIES) {
    for (const ruleset of [{}, { ruleset_id: 'dnd_5e_2014' }]) {
      for (const [scene, size, level] of [[field7x5, 4, 1], [field14x10, 1, 3], [field14x10, 2, 5], [field14x10, 4, 1], [field12x12, 5, 9], [field14x10, 6, 2]]) {
        const party = Array.from({ length: size }, (_, index) => ({ id: `hero-${index + 1}`, level, x: index, y: 0 }))
        addCase({ scene, party, difficulty, theme, seed: `open:${theme}:${difficulty}:${size}`, ...ruleset })
      }
    }
  }
}
// Бюджет растёт с отрядом и уровнем; deadly — вдвое выше hard (`encounter-deadly-tier`).
for (const level of [1, 4, 9, 15, 20]) {
  for (const size of [2, 3, 4, 5]) {
    for (const difficulty of E.ENCOUNTER_DIFFICULTIES) {
      const party = Array.from({ length: size }, (_, index) => ({ id: `hero-${index + 1}`, level, x: index, y: 0 }))
      addCase({ scene: field14x10, party, difficulty, theme: 'beasts', seed: `seed-${size}-${level}-${difficulty}` })
    }
  }
}
// Пределы: восемь героев 20-го уровня, двенадцать существ.
{
  const scene = addScene(encodeScene(openField(10, 3)))
  const party = Array.from({ length: 8 }, (_, index) => ({ id: `hero-${index}`, level: 20, x: index, y: 0 }))
  for (const theme of ['undead', 'generic', 'vermin']) {
    for (const ruleset of [{}, { ruleset_id: 'dnd_5e_2014' }]) addCase({ scene, party, difficulty: 'hard', theme, seed: 'campaign:chapter-1:encounter-1', ...ruleset })
  }
}
// Сиды: сотни сборок одного поля — расстановка и ростер по сиду.
for (let index = 0; index < 160; index += 1) {
  const party = [{ id: 'hero-1', level: 1 + (index % 7), x: 0, y: 0 }, { id: 'hero-2', level: 1 + (index % 5), x: 1, y: 0 }]
  addCase({ scene: field14x10, party, difficulty: E.ENCOUNTER_DIFFICULTIES[index % 4], theme: E.ENCOUNTER_THEMES[index % E.ENCOUNTER_THEMES.length], seed: `sweep:${index}`, ...(index % 3 === 0 ? { ruleset_id: 'dnd_5e_2014' } : {}) })
}

// 2. Узкие места из `test/encounter-assembler.test.mjs`.
const named = (cells) => addScene(encodeScene(cells))
{
  const hero = (level = 1, x = 0, y = 0) => [{ id: 'hero', level, x, y }]
  const strip = named([
    { x: 0, y: 0, type: 'floor', revealed: true }, { x: 1, y: 0, type: 'floor', revealed: true },
    { x: 2, y: 0, type: 'floor', revealed: true, feature: 'chest' }, { x: 3, y: 0, type: 'floor', revealed: true },
    { x: 4, y: 0, type: 'door', revealed: true }, { x: 5, y: 0, type: 'wall', revealed: true },
    { x: 6, y: 0, type: 'water', revealed: true }, { x: 7, y: 0, type: 'door', revealed: false }, { x: 9, y: 0, type: 'floor', revealed: true },
  ])
  for (const ruleset of [{}, { ruleset_id: 'dnd_5e_2014' }]) addCase({ scene: strip, party: hero(), difficulty: 'hard', theme: 'beasts', seed: 'campaign:chapter-1:encounter-1', ...ruleset }, 'strip')
  const street = named([...[0, 1, 2, 3, 4].map((x) => ({ x, y: 0, type: 'floor', revealed: true })), { x: 5, y: 0, type: 'door', revealed: true }, ...[6, 7, 8, 9].map((x) => ({ x, y: 0, type: 'floor', revealed: true }))])
  const cramped = named([{ x: 0, y: 0, type: 'floor', revealed: true }, { x: 1, y: 0, type: 'door', revealed: true }, ...[2, 3, 4, 5].map((x) => ({ x, y: 0, type: 'floor', revealed: true }))])
  const island = named([{ x: 0, y: 0, type: 'floor', revealed: true }, { x: 1, y: 0, type: 'floor', revealed: true }, { x: 2, y: 0, type: 'wall', revealed: true }, { x: 3, y: 0, type: 'floor', revealed: true }])
  const single = named([{ x: 0, y: 0, type: 'floor', revealed: true }])
  const windowed = named([...[0, 1, 2, 3].map((x) => ({ x, y: 0, type: 'floor', revealed: true })), { x: 4, y: 0, type: 'floor', revealed: true, walls: 'e' }, ...[5, 6, 7, 8, 9].map((x) => ({ x, y: 0, type: 'floor', revealed: true }))])
  for (const theme of ['beasts', 'goblinoids', 'undead']) {
    for (const difficulty of E.ENCOUNTER_DIFFICULTIES) {
      for (const ruleset of [{}, { ruleset_id: 'dnd_5e_2014' }]) {
        for (const [scene, label] of [[street, 'street'], [cramped, 'cramped'], [island, 'island'], [single, 'single'], [windowed, 'window']]) {
          addCase({ scene, party: hero(), difficulty, theme, seed: `${label}:${theme}:${difficulty}`, ...ruleset }, label)
        }
      }
    }
  }
  const walled = named(openField(12, 10).map((cell) => ({ ...cell, walls: 'e' })))
  for (const difficulty of E.ENCOUNTER_DIFFICULTIES) {
    for (const theme of ['generic', 'beasts', 'cave']) {
      addCase({ scene: walled, party: [1, 2, 3, 4].map((index) => ({ id: `hero-${index}`, level: 1, x: index - 1, y: 0 })), difficulty, theme, seed: `walls:${difficulty}` }, 'walled')
    }
  }
  const corridor = Array.from({ length: 10 }, (_, x) => ({ x, y: 2, type: 'floor', revealed: true }))
  const pocketCells = [6, 7, 8].flatMap((x) => [4, 5].map((y) => ({ x, y, type: 'floor', revealed: true })))
  const pocket = named([...corridor, { x: 7, y: 3, type: 'floor', revealed: true }, ...pocketCells])
  for (const ruleset of [{}, { ruleset_id: 'dnd_5e_2014' }]) {
    for (const difficulty of ['easy', 'medium', 'hard', 'deadly']) {
      for (let seed = 1; seed <= 6; seed += 1) addCase({ scene: pocket, party: hero(5, 0, 2), difficulty, theme: 'beasts', seed: `pocket:${difficulty}:${seed}`, ...ruleset }, 'pocket')
    }
  }
  for (let seed = 1; seed <= 8; seed += 1) addCase({ scene: field14x10, party: [1, 2, 3, 4].map((index) => ({ id: `hero-${index}`, level: 1, x: index - 1, y: 0 })), difficulty: 'hard', theme: 'beasts', seed: `open:${seed}`, ruleset_id: 'dnd_5e_2014' }, 'open-large')
  for (const theme of ['vermin', 'crypt', 'cave']) {
    for (let seed = 1; seed <= 12; seed += 1) addCase({ scene: field14x10, party: [1, 2, 3, 4].map((index) => ({ id: `hero-${index}`, level: 1, x: index - 1, y: 0 })), difficulty: 'easy', theme, seed: `rats:${theme}:${seed}`, ruleset_id: 'dnd_5e_2014' }, 'rats')
  }
  for (const difficulty of ['easy', 'medium', 'hard']) {
    for (const ruleset of [{}, { ruleset_id: 'dnd_5e_2014' }]) addCase({ scene: field7x5, party: [1, 2, 3, 4].map((index) => ({ id: `hero-${index}`, level: 1, x: index - 1, y: 0 })), difficulty, theme: 'cult', seed: `cult-${difficulty}`, ...ruleset }, 'cult')
  }
  addCase({ scene: field12x12, party: hero(10), difficulty: 'hard', theme: 'raiders', seed: 'footprint-encounter' }, 'footprint')
  // Поле с перегородкой посередине: дверь в стене, комната за ней.
  const rooms = []
  for (let y = 0; y < 9; y += 1) for (let x = 0; x < 15; x += 1) rooms.push({ x, y, type: x === 7 ? (y === 4 ? 'door' : 'wall') : 'floor', revealed: true })
  const roomScene = named(rooms)
  for (const difficulty of E.ENCOUNTER_DIFFICULTIES) {
    for (const ruleset of [{}, { ruleset_id: 'dnd_5e_2014' }]) {
      addCase({ scene: roomScene, party: hero(3, 1, 4), difficulty, theme: 'generic', seed: `rooms:${difficulty}`, ...ruleset }, 'rooms')
      addCase({ scene: roomScene, party: hero(3, 7, 4), difficulty, theme: 'generic', seed: `rooms-door:${difficulty}`, ...ruleset }, 'rooms-on-door')
      addCase({ scene: roomScene, party: [{ id: 'a', level: 2, x: 6, y: 4 }, { id: 'b', level: 2, x: 8, y: 4 }], difficulty, theme: 'warband', seed: `rooms-both:${difficulty}`, ...ruleset }, 'rooms-both-sides')
    }
  }
}

// 3. Случайные сцены.
const FEATURE_POOL = ['chest', 'altar', 'torch', 'rune', 'stairs', 'enemy', 'bed', 'table', 'chair', 'fireplace', 'bookshelf', 'barrel', 'crate',
  'rock', 'mushroom', 'bones', 'campfire', 'grave', 'pillar', 'statue', 'tree', 'bush', 'wagon', 'well', 'console',
  ...listAssets().slice(0, 40).map((asset) => asset.id)]

function syntheticScene() {
  const big = chance(0.15)
  const width = big ? 26 + int(40) : 3 + int(20)
  const height = big ? 20 + int(36) : 2 + int(16)
  const ox = chance(0.06) ? -(1 + int(4)) : chance(0.1) ? int(6) : 0
  const oy = chance(0.06) ? -(1 + int(4)) : chance(0.1) ? int(6) : 0
  const wallRate = random() * 0.18
  const waterRate = random() * 0.06
  const doorRate = random() * 0.05
  const hiddenRate = chance(0.3) ? random() * 0.4 : 0.02
  const featureRate = random() * 0.12
  const occupiedRate = random() * 0.06
  const thinRate = chance(0.4) ? random() * 0.2 : 0
  const cells = []
  const divider = chance(0.3) ? 1 + int(Math.max(1, width - 2)) : -1
  const doorRow = int(height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (chance(0.02)) continue
      let type = 'floor'
      const roll = random()
      if (x === divider) type = y === doorRow ? 'door' : 'wall'
      else if (roll < wallRate) type = 'wall'
      else if (roll < wallRate + waterRate) type = 'water'
      else if (roll < wallRate + waterRate + doorRate) type = 'door'
      const cell = { x: ox + x, y: oy + y, type, revealed: !chance(hiddenRate) }
      if (chance(featureRate)) cell.feature = pick(FEATURE_POOL)
      if (chance(occupiedRate)) cell.occupied = true
      if (chance(thinRate)) cell.walls = pick(['e', 's', 'es'])
      cells.push(cell)
    }
  }
  return cells
}

for (let index = 0; index < 420; index += 1) {
  const cells = syntheticScene()
  if (!cells.length) continue
  const scene = addScene(encodeScene(cells))
  const sizes = [1, 1, 2, 2, 3, 4, 4, 5, 6, 8]
  const repeats = 1 + int(3)
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const party = randomParty(cells, pick(sizes), levelPolicy())
    if (!party.length) break
    addCase({ scene, party, difficulty: pick(E.ENCOUNTER_DIFFICULTIES), theme: pick(E.ENCOUNTER_THEMES), seed: randomSeed(), ...rulesetChoice() }, 'random')
  }
}

// 4. Корпус карт: клетки так, как их собирает движок (`encounterAssemblyInput`).
function engineCells(map, { revealAll = false } = {}) {
  const blocked = propMovementPositions(map)
  return t.legacyCellsFromTacticalMap(map).map((cell) => ({
    x: Number(cell?.x),
    y: Number(cell?.y),
    type: String(cell?.type ?? 'floor'),
    revealed: revealAll || cell?.revealed === true,
    ...(cell?.feature == null ? {} : { feature: String(cell.feature) }),
    ...(blocked.has(`${Number(cell?.x)},${Number(cell?.y)}`) ? { occupied: true } : {}),
    ...(E.encounterBarrierSides(cell) ? { walls: E.encounterBarrierSides(cell) } : {}),
  }))
}

function spawnParty(map, cells, size, levels) {
  const free = new Map(walkableFree(cells).map((cell) => [`${cell.x},${cell.y}`, cell]))
  const party = []
  for (const point of map.spawnPoints.filter((entry) => entry.role === 'party')) {
    if (party.length >= size) break
    if (!free.has(`${point.x},${point.y}`)) continue
    party.push({ id: `hero-${party.length + 1}`, level: levels(party.length), x: point.x, y: point.y })
    free.delete(`${point.x},${point.y}`)
  }
  return party
}

function corpusCases(map, label) {
  for (const revealAll of [false, true]) {
    const cells = engineCells(map, { revealAll })
    if (!cells.length) continue
    const scene = addScene(encodeScene(cells))
    for (let repeat = 0; repeat < 4; repeat += 1) {
      const size = pick([1, 2, 3, 4, 5])
      const levels = levelPolicy()
      let party = repeat < 2 ? spawnParty(map, cells, size, levels) : []
      if (!party.length) party = randomParty(cells, size, levels)
      if (!party.length) continue
      addCase({ scene, party, difficulty: pick(E.ENCOUNTER_DIFFICULTIES), theme: pick(E.ENCOUNTER_THEMES), seed: `${label}:${repeat}:${revealAll}`, ...rulesetChoice() }, `${label}${revealAll ? ':revealed' : ''}`)
    }
  }
}

const authored = JSON.parse(readFileSync(new URL('data/authored-location-maps-v1.json', root), 'utf8'))
authored.maps.forEach((raw, index) => corpusCases(t.deserializeTacticalMap(raw), `authored:${index}`))

const locations = ['Таверна', 'Храм', 'Склеп', 'Подземелье', 'Пещера', 'Тёмный лес', 'Дорога', 'Кладбище', 'Деревня', 'Город', 'Замок', 'Мост через ущелье', 'Порт', 'Кузница', 'Рынок', 'Руины', 'Болото']
const generatorInputs = []
for (const location of locations) {
  generatorInputs.push({ location, seed: `fixture:${location}` })
  generatorInputs.push({ location, seed: `fixture-2:${location}`, entrySide: pick(['east', 'north', 'south']) })
}
const programCorpus = JSON.parse(readFileSync(new URL('test/fixtures/scene-programs/corpus.json', root), 'utf8'))
for (const scene of programCorpus.scenes) {
  const program = sceneMapRequirementsFor([scene.location, scene.text], { npcs: scene.npcs })
  generatorInputs.push({ location: scene.location, theme: scene.theme, settlementType: scene.settlementType ?? '', requirements: program?.items ?? [], program, seed: `corpus:${scene.id}` })
}
for (const input of generatorInputs) {
  let built
  try {
    built = generateSceneGeometry({ ...input, useLibrary: false })
  } catch (error) {
    console.log(`  генератор отказал на ${input.location}: ${error.message}`)
    continue
  }
  corpusCases(built.map, `generated:${input.seed}`)
}

// 5. Входы настоящего движка (`CreateEncounter`).
const recorded = []
globalThis.__encounterRecorder = (input) => recorded.push(clone(input))

function addRecorded(input, label) {
  const cells = input.scene.cells
  const scene = encodeScene(cells)
  if (!isDeepStrictEqual(sortCells(decodeScene(scene)), sortCells(cells))) throw new Error(`сцена движка не сжимается без потерь: ${label}`)
  const entry = { scene: addScene(scene), party: input.party, difficulty: input.difficulty, theme: input.theme, seed: input.seed }
  if (Object.hasOwn(input, 'ruleset_id')) entry.ruleset_id = input.ruleset_id
  // Тот же исход на сжатой сцене, что у движка на исходной.
  const direct = run(input)
  const result = addCase(entry, label)
  if (!isDeepStrictEqual(direct, result)) throw new Error(`исход на сжатой сцене расходится: ${label}`)
  return result
}

{
  const S = await import(new URL('server/campaign-scenario.mjs', root).href)
  const { CampaignBootstrapper } = await import(new URL('server/campaign-bootstrap.mjs', root).href)
  const { normalizeCampaignState, resolveCommands, resolveCommand } = await import(new URL('server/rules-engine.mjs', root).href)
  const { SceneArchitectAgent } = await import(new URL('server/scene-architect.mjs', root).href)
  const { DiceService } = await import(new URL('server/dice-service.mjs', root).href)
  const { fixedDice } = await import(new URL('test/kit/dice.mjs', root).href)

  const HERO = { role: 'Воин · ур. 7', species: 'Человек', background: 'Странник', level: 7, hp: 64, maxHp: 64, armor: 18, speed: 30 }
  const heroes = [
    { id: 'attention-hero', character: 'Ирма', name: 'Игрок', ...HERO },
    { id: 'attention-mage', character: 'Олвин', name: 'Второй', ...HERO, hp: 40, maxHp: 40, armor: 12 },
  ]
  const director = { isDirector: true }
  const admin = { isAdmin: true }

  async function campaign(code, party) {
    const run = { state: normalizeCampaignState(await new CampaignBootstrapper().create({ code, worldTemplateId: 'astohan-plains', players: party })), step: 0 }
    run.apply = (command, context = admin) => {
      run.step += 1
      try {
        const result = resolveCommands([{ command_id: `${code}-${run.step}`, ...command }], run.state, { diceService: fixedDice(10), context })
        run.state = normalizeCampaignState(result.state)
        return result
      } catch {
        return null
      }
    }
    run.travel = async (locationId) => {
      for (let hop = 0; hop < 8 && S.scenarioLocationId(run.state) !== locationId; hop += 1) {
        const { sceneArgs } = await new SceneArchitectAgent().plan({ state: run.state, decision: `Идём в ${locationId}`, destinationLocationId: locationId })
        if (!run.apply({ command_type: 'AdvanceScene', scene_args: sceneArgs })) break
      }
    }
    run.fight = (label, seed, theme = 'raiders', difficulty = 'easy') => {
      for (const suffix of ['', '-b', '-c', '-d', '-e', '-f']) {
        recorded.length = 0
        const ok = run.apply({ command_type: 'CreateEncounter', theme, difficulty, seed: `${seed}${suffix}` }, director)
        for (const input of recorded.splice(0)) addRecorded(input, `${label}${suffix}`)
        if (ok) return true
      }
      return false
    }
    return run
  }

  // Редстоуновка: первый визит собирает встречу, повторный — ни на одном сиде.
  const redstone = await campaign('ENC-R', heroes)
  await redstone.travel('astohan-redstone')
  const first = redstone.fight('engine:redstone-first', 'attention-fight')
  await redstone.travel('astohan-lomar-tower')
  redstone.fight('engine:lomar-tower', 'tower-fight', 'undead', 'medium')
  await redstone.travel('astohan-redstone')
  const second = redstone.fight('engine:redstone-second', 'attention-fight-2')
  console.log(`  Редстоуновка: первый визит ${first ? 'собран' : 'отказ'}, повторный ${second ? 'собран' : 'отказ на всех сидах'}`)
  for (const [location, theme, difficulty] of [['astohan-ash-watch', 'raiders', 'medium'], ['astohan-mittlayd', 'raiders', 'easy'], ['astohan-wild-forest', 'beasts', 'hard'], ['astohan-smugglers-cave', 'cave', 'deadly']]) {
    const run = await campaign(`ENC-${location}`, heroes.slice(0, location.length % 2 + 1))
    await run.travel(location)
    run.fight(`engine:${location}`, `${location}-fight`, theme, difficulty)
  }
  // Засада у логова: сборщик обходит клетки главного противника и его стражи.
  const lair = await campaign('ENC-L', heroes)
  await lair.travel('astohan-obsidian-pass')
  await lair.travel('astohan-vulkanis-brazier')
  lair.state = normalizeCampaignState({ ...lair.state, scenario_attention: { ...lair.state.scenario_attention, value: 6 } })
  recorded.length = 0
  lair.apply({ command_type: 'CreateEncounter', npc_id: 'astohan-sargat', difficulty: 'deadly', seed: 'lair-6' }, director)
  for (const input of recorded.splice(0)) addRecorded(input, 'engine:lair-ambush')

  // Реквизит, перекрывающий поле (`test/encounter-assembler.test.mjs`).
  const field = openField(7, 5)
  const map = t.tacticalMapFromLegacyCells(field)
  map.props.push({ id: 'blocking-crates', assetId: 'crate', x: 2, y: 2, blocksMove: true, footprint: field.filter((cell) => cell.x >= 2 || cell.y >= 2).map(({ x, y }) => ({ x, y })) })
  const state = normalizeCampaignState({ sessionCode: 'PROP-SPAWN', ruleset_id: 'dnd_5e_2014', players: [{ id: 'hero', hp: 20, maxHp: 20, level: 1, x: 0, y: 0 }], partyMemberIds: ['hero'], enemies: [], scene: { cells: field, map: t.serializeTacticalMap(map) } })
  recorded.length = 0
  resolveCommand({ command_type: 'CreateEncounter', command_id: 'prop-spawn', actor_id: 'hero', difficulty: 'easy', theme: 'goblinoids', seed: 'prop-spawn' }, state, { diceService: new DiceService(), context: { isAdmin: true } })
  for (const input of recorded.splice(0)) addRecorded(input, 'engine:prop-spawn')
  globalThis.__encounterRecorder = undefined
}

// 6. Рыхлые входы: отказы границ и их порядок.
const raw = []
const rawCase = (label, input) => {
  let out
  try {
    out = summary(E.assembleEncounter(input))
  } catch (error) {
    out = { error: errorOf(error) }
  }
  let stored = input === undefined ? UNDEFINED : clone(input)
  // Крупное поле — ссылкой на сжатую сцену (те же клетки в том же порядке).
  const cells = input?.scene?.cells
  if (Array.isArray(cells) && cells.length > 100) {
    const scene = encodeScene(cells)
    if (!isDeepStrictEqual(decodeScene(scene), cells)) throw new Error(`рыхлый вход не сжимается: ${label}`)
    stored = { ...stored, scene: { ...stored.scene, cells: { $scene: addScene(scene) } } }
  }
  raw.push({ label, input: stored, out })
}
{
  const base = () => ({
    scene: { cells: openField(7, 5) },
    party: [{ id: 'hero-1', level: 1, x: 0, y: 0 }, { id: 'hero-2', level: 1, x: 1, y: 0 }],
    difficulty: 'easy',
    theme: 'generic',
    seed: 'raw-seed',
  })
  const withCell = (patch, index = 0) => {
    const input = base()
    input.scene.cells[index] = { ...input.scene.cells[index], ...patch }
    return input
  }
  const withMember = (patch, index = 0) => {
    const input = base()
    input.party[index] = { ...input.party[index], ...patch }
    return input
  }
  rawCase('ok', base())
  for (const value of [undefined, null, [], 'scene', 5, true]) rawCase(`input:${JSON.stringify(value)}`, value)
  for (const field of ['monster_id', 'xp_budget', 'quantity', 'price', 'secret', 'hp', 'damageDice', '__proto_like', 'constructor']) rawCase(`top:${field}`, { ...base(), [field]: 'forged' })
  for (const scene of [undefined, null, [], 'cells', { cells: [] }, { cells: 'x' }, { cells: openField(7, 5), hidden_information: 'GM only' }, { cells: [null] }, { cells: [[]] }, { cells: [5] }]) rawCase(`scene:${JSON.stringify(scene)?.slice(0, 40)}`, { ...base(), scene })
  rawCase('scene:too-many', { ...base(), scene: { cells: openField(101, 100) } })
  rawCase('scene:max', { ...base(), scene: { cells: openField(100, 100) } })
  for (const [label, patch] of [
    ['price', { price_cp: 1 }], ['x-string', { x: '0' }], ['x-float', { x: 0.5 }], ['x-null', { x: null }], ['x-big', { x: 1001 }], ['x-min', { x: -1001 }],
    ['y-string', { y: '0' }], ['type-bad', { type: 'lava' }], ['type-num', { type: 1 }], ['revealed-num', { revealed: 1 }], ['revealed-null', { revealed: null }],
    ['feature-bad', { feature: 'forged-client-prop' }], ['feature-num', { feature: 5 }], ['feature-null', { feature: null }], ['feature-ok', { feature: 'stalagmite' }],
    ['occupied-num', { occupied: 1 }], ['occupied-false', { occupied: false }], ['occupied-null', { occupied: null }],
    ['walls-n', { walls: 'n' }], ['walls-empty', { walls: '' }], ['walls-se', { walls: 'se' }], ['walls-null', { walls: null }], ['walls-num', { walls: 1 }], ['walls-es', { walls: 'es' }],
    ['several', { x: 'bad', type: 'lava', price: 1 }],
  ]) {
    rawCase(`cell:${label}`, withCell(patch, 10))
  }
  {
    const input = base()
    input.scene.cells.push({ ...input.scene.cells[3] })
    rawCase('cell:duplicate', input)
    const reversed = base()
    reversed.scene.cells.reverse()
    reversed.party.reverse()
    rawCase('cell:reversed', reversed)
  }
  for (const party of [undefined, null, [], {}, 'hero', [null], Array.from({ length: 9 }, (_, index) => ({ id: `h${index}`, level: 1, x: index % 7, y: Math.floor(index / 7) }))]) rawCase(`party:${JSON.stringify(party)?.slice(0, 40)}`, { ...base(), party })
  for (const [label, patch] of [
    ['attack', { attackBonus: 99 }], ['hp', { hp: 9_999 }], ['id-num', { id: 5 }], ['id-empty', { id: '' }], ['id-space', { id: '   ' }], ['id-long', { id: 'x'.repeat(121) }],
    ['id-max', { id: 'x'.repeat(120) }], ['id-padded', { id: `  ${'x'.repeat(120)}  ` }], ['id-control', { id: 'he\u0001ro' }], ['id-del', { id: 'he\u007fro' }],
    ['id-emoji', { id: '😀'.repeat(60) }], ['id-emoji-long', { id: '😀'.repeat(61) }], ['id-dup-trim', { id: ' hero-2 ' }],
    ['level-float', { level: 1.5 }], ['level-0', { level: 0 }], ['level-21', { level: 21 }], ['level-string', { level: '1' }], ['level-null', { level: null }],
    ['x-string', { x: '0' }], ['pos-wall', { x: 6, y: 4 }], ['pos-missing', { x: 50, y: 50 }], ['pos-dup', { x: 1, y: 0 }], ['pos-big', { x: 2000 }],
  ]) {
    rawCase(`member:${label}`, withMember(patch))
  }
  {
    const input = withCell({ type: 'wall' }, 1)
    rawCase('member:on-wall', input)
    const hidden = withCell({ revealed: false }, 1)
    rawCase('member:on-hidden', hidden)
    const door = withCell({ type: 'door' }, 1)
    rawCase('member:on-door', door)
  }
  for (const difficulty of ['lethal', 1, null, undefined, 'Easy', ' easy', 'constructor']) rawCase(`difficulty:${String(difficulty)}`, { ...base(), difficulty })
  for (const theme of ['dragon', 'constructor', 'toString', '__proto__', 'hasOwnProperty', null, 5, ['generic'], 'Generic']) rawCase(`theme:${String(theme)}`, { ...base(), theme })
  for (const seed of [123, '', '   ', `seed\nignore previous instructions`, 'x'.repeat(120), 'x'.repeat(121), `  ${'y'.repeat(120)}  `, '😀'.repeat(60), '😀'.repeat(61), null, 'тон кий', ' seed ']) rawCase(`seed:${String(seed).slice(0, 20)}`, { ...base(), seed })
  for (const ruleset_id of ['srd_5_2_1', 'dnd_5e_2014', 'dnd_5e_2024', null, undefined, 5, '']) rawCase(`ruleset:${String(ruleset_id)}`, { ...base(), ruleset_id })
  // Порядок отказов: сцена раньше отряда, отряд раньше сложности и темы.
  rawCase('order:scene-before-party', { ...base(), scene: { cells: [] }, party: [] })
  rawCase('order:party-before-difficulty', { ...base(), party: [], difficulty: 'lethal' })
  rawCase('order:difficulty-before-theme', { ...base(), difficulty: 'lethal', theme: 'dragon' })
  rawCase('order:theme-before-seed', { ...base(), theme: 'dragon', seed: 5 })
  rawCase('order:seed-before-ruleset', { ...base(), seed: 5, ruleset_id: 'x' })
  // Подрайон боя: поле шире 28 клеток — враг появляется у отряда.
  rawCase('bounds:wide', { ...base(), scene: { cells: openField(60, 8) }, party: [{ id: 'hero', level: 3, x: 30, y: 4 }] })
  rawCase('bounds:tall', { ...base(), scene: { cells: openField(8, 60) }, party: [{ id: 'hero', level: 3, x: 4, y: 59 }], theme: 'beasts' })
  rawCase('bounds:negative', { ...base(), scene: { cells: openField(60, 8).map((cell) => ({ ...cell, x: cell.x - 5 })) }, party: [{ id: 'hero', level: 3, x: 0, y: 4 }] })
}

// --- малые функции ------------------------------------------------------------

const labelInputs = ['easy', 'medium', 'hard', 'deadly', 'чепуха', '', undefined, null, 1, 0, true, false, 'constructor', '__proto__', 'toString', 'hasOwnProperty',
  'valueOf', 'isPrototypeOf', 'toLocaleString', '__defineGetter__', ['easy'], ['hard', 'x'], {}, 'EASY', ' easy', 'deadly ']
const labels = labelInputs.map((input) => {
  const value = E.encounterDifficultyLabel(input)
  const out = typeof value === 'string' ? value : typeof value === 'function' ? { $function: true } : { $object: clone(value) }
  return { input: input === undefined ? UNDEFINED : input, out }
})

const barrierInputs = [undefined, null, {}, { walls: 'e' }, { windows: 'e' }, { walls: 's', windows: 'e' }, { walls: 'es' }, { walls: 'se' }, { windows: 'n' },
  { walls: 5, windows: 's' }, { walls: ['e'] }, { walls: 'wall' }, { windows: 'west' }, { walls: 'E' }, 'es', 5, [], { walls: '', windows: '' }, { walls: 'nesw' }]
for (let index = 0; index < 60; index += 1) {
  const cell = {}
  if (chance(0.6)) cell.walls = pick(['e', 's', 'es', 'se', '', 'n', 'eee', 'xs', 5, null, true])
  if (chance(0.6)) cell.windows = pick(['e', 's', 'es', '', 'w', 'south', 0, null])
  barrierInputs.push(cell)
}
const barriers = barrierInputs.map((input) => ({ input: input === undefined ? UNDEFINED : input, out: E.encounterBarrierSides(input) }))

const constants = {
  version: E.ENCOUNTER_PROPOSAL_VERSION,
  limits: E.ENCOUNTER_ASSEMBLER_LIMITS,
  srd: E.SRD_5_2_1_SOURCE,
  dndsu: E.DND_SU_BESTIARY_SOURCE,
  allowlist: E.SRD_5_2_1_MONSTER_ALLOWLIST,
  themes: E.ENCOUNTER_THEMES,
  difficulties: E.ENCOUNTER_DIFFICULTIES,
  labels: E.ENCOUNTER_DIFFICULTY_LABELS,
  warning: E.DEADLY_ENCOUNTER_WARNING,
}

const sections = { constants, labels, barriers, scenes, cases, raw }
const lines = Object.entries(sections).map(([key, value]) => (Array.isArray(value)
  ? `${JSON.stringify(key)}: [\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`
  : `${JSON.stringify(key)}: ${JSON.stringify(value)}`))
const target = new URL('./encounter-assembler.json', import.meta.url)
writeFileSync(target, `{\n${lines.join(',\n')}\n}\n`)
const errors = new Map()
for (const entry of cases) if (entry.out.error) errors.set(entry.out.error.code ?? entry.out.error.message, (errors.get(entry.out.error.code ?? entry.out.error.message) ?? 0) + 1)
console.log(`encounter-assembler.json: scenes ${scenes.length}, cases ${cases.length} (отказы: ${[...errors].map(([code, count]) => `${code} ${count}`).join(', ')}), raw ${raw.length}, labels ${labels.length}, barriers ${barriers.length}`)
