import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import { decodeSlab, SLAB_MAX_INSTANCES, SLAB_MAX_LAYOUTS, SLAB_MAX_TEXT_LENGTH } from '../server/talespire-slab.mjs'
import { TALESPIRE_MAX_SOURCE_CELLS, importTaleSpireSlab, repairImportedLevel, roomLabelFor } from '../server/talespire-import.mjs'
import { addProp, cellAt, createTacticalMap, deserializeTacticalMap, edgeList, reachableCells, setCell, validateTacticalMap } from '../server/tactical-map.mjs'
import { DOORWAY_SIGHT_CELLS, cellsVisibleFrom } from '../server/rules/tactical-geometry.mjs'
import { ASSETS, HOUSE_SLAB, encodeSlabV1, encodeSlabV1Raw, encodeSlabV2, housePlacements, pickAsset } from './talespire-fixtures.mjs'

/**
 * Импорт карт из TaleSpire: разбор слэба и проекция на клетки.
 *
 * Слэбы собираются в тесте кодировщиком по описанию формата: настоящие
 * постройки с TalesTavern — чужая работа, и в репозиторий они не кладутся.
 */

/** @param {string} slab @returns {Map<number, import('../server/tactical-map.mjs').TacticalMap>} */
function importedLevels(slab) {
  const result = importTaleSpireSlab(slab, { locationId: 'loc-house' })
  return new Map(result.levels.map((level) => [level.index, deserializeTacticalMap(level.map)]))
}

// --- разбор слэба ----------------------------------------------------------

test('слэб v2 разбирается в экземпляры с координатами в клетках и поворотом по 15°', () => {
  const slab = decodeSlab(encodeSlabV2([
    { asset: ASSETS.floor, x: 3, y: 0.5, z: 7.25 },
    { asset: ASSETS.door, x: 6.75, y: 0.5, z: 3, rotation: 90 },
  ]))
  assert.equal(slab.version, 2)
  assert.equal(slab.kinds, 2)
  assert.deepEqual(slab.instances.map((instance) => instance.assetId).sort(), [ASSETS.door.id, ASSETS.floor.id].sort())
  const door = slab.instances.find((instance) => instance.assetId === ASSETS.door.id)
  assert.deepEqual(door, { assetId: ASSETS.door.id, x: 6.75, y: 0.5, z: 3, rotation: 90 })
})

test('слэб v1 несёт габарит в мировых координатах и четверти оборота', () => {
  const slab = decodeSlab(encodeSlabV1([{ asset: ASSETS.door, x: 6.75, y: 0.5, z: 3, rotation: 90 }]))
  assert.equal(slab.version, 1)
  const [door] = slab.instances
  assert.ok('center' in door)
  assert.deepEqual(door.center, { x: 7, y: 1.5, z: 3.5 })
  assert.deepEqual(door.extent, { x: 0.25, y: 1, z: 0.5 })
  assert.equal(door.rotation, 90)
})

test('обрамление тройными кавычками и переносы строк из мессенджера не мешают', () => {
  const wrapped = `\n\`\`\`${HOUSE_SLAB.slice(0, 40)}\n${HOUSE_SLAB.slice(40)}\`\`\`  `
  assert.equal(decodeSlab(wrapped).instances.length, decodeSlab(HOUSE_SLAB).instances.length)
})

test('мусор вместо слэба получает понятный код, а не исключение zlib', () => {
  const badMagic = gzipSync(Buffer.from([1, 2, 3, 4, 2, 0, 0, 0, 0, 0])).toString('base64')
  const version3 = Buffer.from(gzipSync(Buffer.from([0xCE, 0xFA, 0xCE, 0xD1, 3, 0, 0, 0]))).toString('base64')
  const truncatedHeader = Buffer.alloc(10)
  truncatedHeader.writeUInt32LE(0xD1CEFACE, 0)
  truncatedHeader.writeUInt16LE(2, 4)
  truncatedHeader.writeUInt16LE(5, 6)
  const truncated = gzipSync(truncatedHeader).toString('base64')
  for (const [input, code] of [
    ['', 'SLAB_EMPTY'],
    [42, 'SLAB_EMPTY'],
    ['это не слэб!', 'SLAB_NOT_BASE64'],
    [Buffer.from('просто текст').toString('base64'), 'SLAB_NOT_GZIP'],
    [badMagic, 'SLAB_BAD_MAGIC'],
    [version3, 'SLAB_VERSION_UNSUPPORTED'],
    [truncated, 'SLAB_TRUNCATED'],
    ['A'.repeat(SLAB_MAX_TEXT_LENGTH + 1), 'SLAB_TOO_LARGE'],
  ]) {
    assert.throws(() => decodeSlab(input), (error) => error.code === code, `ожидался ${code}`)
  }
})

const failsWith = (code) => (error) => error.code === code

test('аудит PR #131, MAP-BOUNDARY-01: число видов и объектов ограничено до сборки экземпляров', () => {
  // Одинаковые записи сжимаются почти без остатка: предел сжатого слэба такую
  // лавину не держит, держит только предел числа объектов.
  const flood = encodeSlabV2(Array.from({ length: SLAB_MAX_INSTANCES + 1 }, () => ({ asset: ASSETS.floor, x: 1, y: 0, z: 1 })))
  assert.ok(Buffer.from(flood, 'base64').length < 30720)
  const started = performance.now()
  assert.throws(() => decodeSlab(flood), failsWith('SLAB_TOO_MANY_INSTANCES'))
  assert.throws(() => importTaleSpireSlab(flood), failsWith('SLAB_TOO_MANY_INSTANCES'))
  assert.ok(performance.now() - started < 2000, 'отказ по заголовкам видов, без сборки экземпляров')

  // Видов больше, чем ассетов во всей таблице: отказ до чтения их описаний.
  const header = Buffer.alloc(10)
  header.writeUInt32LE(0xD1CEFACE, 0)
  header.writeUInt16LE(2, 4)
  header.writeUInt16LE(SLAB_MAX_LAYOUTS + 1, 6)
  const kinds = gzipSync(Buffer.concat([header, Buffer.alloc((SLAB_MAX_LAYOUTS + 1) * 20 + 2)])).toString('base64')
  assert.throws(() => decodeSlab(kinds), failsWith('SLAB_TOO_MANY_LAYOUTS'))
})

test('аудит PR #131, MAP-BOUNDARY-01: стопка плит у предела объектов разбирается без квадрата', () => {
  // Прежде каждая поверхность клетки сверялась с каждой: 50 тысяч плит в одной
  // клетке — больше десятка секунд. Теперь это доли секунды, а карта та же,
  // что у комнаты без стопки: нижние плиты — подложка.
  const room = []
  for (let x = 0; x < 10; x += 1) for (let z = 0; z < 10; z += 1) room.push({ asset: ASSETS.floor, x, y: 0, z })
  const stack = Array.from({ length: SLAB_MAX_INSTANCES - room.length }, () => ({ asset: ASSETS.floor, x: 1, y: 0, z: 1 }))
  const slab = encodeSlabV2([...stack, ...room])
  const started = performance.now()
  const result = importTaleSpireSlab(slab)
  assert.ok(performance.now() - started < 5000, `стопка разбиралась ${Math.round(performance.now() - started)} мс`)
  assert.equal(result.source.instances, SLAB_MAX_INSTANCES)
  assert.equal(result.stats.floorCells, 100)
})

test('аудит PR #131, MAP-BOUNDARY-01: площадь исходных коробок ограничена до первого обхода клеток', () => {
  const big = pickAsset((row) => row[0] === 't' && row[1] === 'floor' && Math.abs(row[5] - 4) < 0.01 && Math.abs(row[7] - 4) < 0.01)
  const side = 8
  const count = Math.floor(TALESPIRE_MAX_SOURCE_CELLS / (side * side)) + 1
  const tiles = Array.from({ length: count }, (_, index) => ({ asset: big, x: (index % 10) * side, y: 0, z: (Math.floor(index / 10) % 10) * side }))
  assert.throws(() => importTaleSpireSlab(encodeSlabV2(tiles)), failsWith('TALESPIRE_SLAB_TOO_COMPLEX'))
  // На пределе — обычная карта 80×80 из крупных плит внахлёст.
  const result = importTaleSpireSlab(encodeSlabV2(tiles.slice(0, -1)))
  assert.equal(result.stats.floorCells, 80 * 80)
})

test('аудит PR #131, MAP-BOUNDARY-02: v1 — конечное, но огромное отклоняется при разборе; далёкая доска законна', () => {
  const floor = (center, extent = [0.5, 0.25, 0.5]) => ({ asset: ASSETS.floor, center, extent })
  const room = []
  for (let x = 0; x < 10; x += 1) for (let z = 0; z < 10; z += 1) room.push(floor([x + 0.5, 0.25, z + 0.5]))
  // Центр 1e30 конечен; у числа больше 2^53 `x += 1` ничего не прибавляет,
  // и обход клеток такой коробки не кончился бы.
  assert.throws(() => importTaleSpireSlab(encodeSlabV1Raw([...room, floor([1e30, 0.25, 0.5])])), failsWith('SLAB_COORDINATE_OUT_OF_RANGE'))
  assert.throws(() => importTaleSpireSlab(encodeSlabV1Raw([...room, floor([1e17, 0.25, 0.5], [20, 0.25, 0.5])])), failsWith('SLAB_COORDINATE_OUT_OF_RANGE'))
  // Коробка в сто тысяч клеток поперёк — не ассет TaleSpire.
  assert.throws(() => importTaleSpireSlab(encodeSlabV1Raw([...room, floor([5, 0.25, 5], [100_000, 0.25, 100_000])])), failsWith('SLAB_EXTENT_TOO_LARGE'))

  // Старые слэбы несут мировые координаты: постройка вдали от начала доски
  // даёт ту же карту, что и у начала.
  const near = importTaleSpireSlab(encodeSlabV1Raw(room))
  const far = importTaleSpireSlab(encodeSlabV1Raw(room.map((record) => ({ ...record, center: [record.center[0] + 100_000, record.center[1], record.center[2] - 100_000] }))))
  const withoutSeed = (result) => result.levels.map((level) => ({ ...level.map, seed: '' }))
  assert.deepEqual(withoutSeed(far), withoutSeed(near))
})

// --- проекция на клетки ------------------------------------------------------

test('двухэтажный дом: этажи, стены, дверь, предмет и пара лестниц', () => {
  const levels = importedLevels(HOUSE_SLAB)
  assert.deepEqual([...levels.keys()], [0, 1])
  const ground = /** @type {import('../server/tactical-map.mjs').TacticalMap} */ (levels.get(0))
  const upper = /** @type {import('../server/tactical-map.mjs').TacticalMap} */ (levels.get(1))
  for (const map of levels.values()) {
    assert.deepEqual(validateTacticalMap(map).errors, [])
    assert.equal(map.generator.id, 'talespire-slab')
    assert.ok(map.width >= 16 && map.height >= 16, 'минимум карты 16×16 соблюдается дополнением')
  }
  assert.equal(ground.levelLabel, 'Первый этаж')
  assert.equal(upper.levelLabel, 'Второй этаж')

  // Внутренняя стена с дверью и западная стена: 7 + 8 рёбер стен и одна дверь.
  const kinds = edgeList(ground).map((edge) => edge.kind)
  assert.equal(kinds.filter((kind) => kind === 'wall').length, 15)
  assert.equal(ground.doors.length, 1)
  assert.equal(ground.doors[0].state, 'closed')
  assert.equal(edgeList(upper).length, 0, 'наверху стен в доме нет')

  // Стол переехал видом каталога «Сказания».
  assert.ok(ground.props.some((prop) => prop.assetId === 'table_small'))

  // Марш даёт пару переходов, которые ищет UseLevelTransition.
  const up = ground.props.filter((prop) => prop.transition)
  const down = upper.props.filter((prop) => prop.transition)
  assert.deepEqual(up.map((prop) => [prop.assetId, prop.transition?.toLevel]), [['stairs_up', 1]])
  assert.deepEqual(down.map((prop) => [prop.assetId, prop.transition?.toLevel]), [['stairs_down', 0]])
  assert.equal(up[0].transition?.label, 'Второй этаж')
  assert.equal(down[0].transition?.label, 'Первый этаж')

  // Вход — свободная клетка этажа входа, вокруг неё всё раскрыто до первой двери.
  const entrance = ground.spawnPoints.find((point) => point.role === 'party')
  assert.ok(entrance)
  assert.equal(cellAt(ground, entrance.x, entrance.y)?.passable, true)
  assert.equal(cellAt(ground, entrance.x, entrance.y)?.revealed, true)
  // Раскрыто ровно то, куда можно дойти без дверей, и то, что видно от входа
  // правилом движка (`cellsVisibleFrom`): сквозь решётку и окно — да, сквозь
  // закрытую дверь и стену — нет. Остальное остаётся туманом.
  const walk = reachableCells(ground, entrance.x, entrance.y, { throughDoors: false })
  const seen = new Set(cellsVisibleFrom(ground, entrance, { radius: DOORWAY_SIGHT_CELLS }).map((cell) => `${cell.x},${cell.y}`))
  let hidden = 0
  for (let y = 0; y < ground.height; y += 1) for (let x = 0; x < ground.width; x += 1) {
    const cell = cellAt(ground, x, y)
    if (!cell) continue
    if (!cell.revealed) hidden += 1
    else assert.ok(walk.has(`${x},${y}`) || seen.has(`${x},${y}`) || (x === entrance.x && y === entrance.y), `клетка ${x},${y} раскрыта без причины`)
  }
  assert.ok(hidden > 0, 'за закрытой дверью остаётся туман')
})

test('подписи комнат следуют обстановке, а один череп склепа не делает', () => {
  const room = (overrides = {}) => ({ cells: 30, interior: true, level: 0, material: 'wood', ...overrides })
  assert.equal(roomLabelFor({ bar_counter: 1, chair: 2 }, room()), 'Общий зал')
  assert.equal(roomLabelFor({ table_small: 2, chair: 4 }, room()), 'Общий зал')
  assert.equal(roomLabelFor({ bed: 1 }, room()), 'Спальня')
  assert.equal(roomLabelFor({ bone_pile: 1, bed: 0 }, room()), 'Комната', 'декоративный череп — не склеп')
  assert.equal(roomLabelFor({ sarcophagus: 1 }, room()), 'Склеп')
  assert.equal(roomLabelFor({ barrel: 2, crate: 2 }, room({ level: -1 })), 'Погреб')
  assert.equal(roomLabelFor({}, room({ interior: false, cells: 300, material: 'grass' })), 'Поляна')
  assert.equal(roomLabelFor({}, room({ interior: false, cells: 300, material: 'stone' })), 'Улица')
  assert.equal(roomLabelFor({}, room({ underground: true, material: 'earth' })), 'Пещера')
  assert.equal(roomLabelFor({}, room({ underground: true, material: 'stone' })), 'Подземелье')
})

test('импорт детерминирован, а v1 и v2 одного дома дают одну геометрию', () => {
  const first = importTaleSpireSlab(HOUSE_SLAB, { locationId: 'loc-house' })
  const second = importTaleSpireSlab(HOUSE_SLAB, { locationId: 'loc-house' })
  assert.deepEqual(first, second)
  const legacy = importTaleSpireSlab(encodeSlabV1(housePlacements()), { locationId: 'loc-house' })
  assert.equal(legacy.source.version, 1)
  assert.deepEqual(legacy.stats, first.stats)
  for (const [index, level] of first.levels.entries()) {
    const left = /** @type {any} */ (level.map)
    const right = /** @type {any} */ (legacy.levels[index].map)
    assert.deepEqual(right.layers, left.layers)
    assert.deepEqual(right.edges, left.edges)
  }
})

test('этаж без лестницы не импортируется, и ведущий об этом узнаёт', () => {
  const withoutStairs = housePlacements().filter((placement) => placement.asset !== ASSETS.stairs)
  const result = importTaleSpireSlab(encodeSlabV2(withoutStairs))
  assert.deepEqual(result.levels.map((level) => level.index), [0])
  assert.ok(result.warnings.some((warning) => warning.includes('Второй этаж') && warning.includes('нет лестницы')))
})

test('незнакомые ассеты пропускаются с предупреждением; слэб без пола и слишком большой отклоняются', () => {
  const unknown = { id: '00000000-0000-0000-0000-000000000001', row: ['t', 'floor', 0.5, 0.25, 0.5, 0.5, 0.25, 0.5, 'stone', ''] }
  const mixed = importTaleSpireSlab(encodeSlabV2([...housePlacements(), { asset: unknown, x: 20, y: 0, z: 0 }]))
  assert.ok(mixed.warnings.some((warning) => warning.startsWith('Незнакомых ассетов: 1')))
  assert.throws(() => importTaleSpireSlab(encodeSlabV2([{ asset: unknown, x: 0, y: 0, z: 0 }])), (error) => error.code === 'TALESPIRE_NOTHING_KNOWN')
  assert.throws(() => importTaleSpireSlab(encodeSlabV2([{ asset: ASSETS.wallAlongZ, x: 0, y: 0, z: 0 }])), (error) => error.code === 'TALESPIRE_NO_FLOOR')
  const strip = Array.from({ length: 101 }, (_, x) => ({ asset: ASSETS.floor, x, y: 0, z: 0 }))
  assert.throws(() => importTaleSpireSlab(encodeSlabV2(strip)), (error) => error.code === 'TALESPIRE_MAP_TOO_LARGE')
})

test('этап 5: паспорт карты считает якоря программы сцены и оценку качества импорта', () => {
  const result = importTaleSpireSlab(HOUSE_SLAB, { locationId: 'loc-house' })
  assert.equal(result.passport.version, 2)
  assert.equal(typeof result.passport.anchors, 'object')
  for (const [kind, count] of Object.entries(result.passport.anchors)) assert.ok(count > 0, kind)
  const { quality } = result.passport
  assert.ok(quality.score >= 0 && quality.score <= 1)
  assert.ok(quality.reachable > 0.9, 'пол дома досягаем от входа')
  assert.ok(quality.cells > 0)
})

/** Поле 10×8 из травы без зон: основа ручных карт ремонта импорта. */
function grassLevel() {
  const map = createTacticalMap({ width: 10, height: 8, locationId: 'repair', seed: 'repair' })
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 10; x += 1) setCell(map, x, y, { passable: true, material: 'grass' })
  return map
}

test('этап 5: перепад без лестницы получает пандус, высокий островок замуровывается', () => {
  const ramp = grassLevel()
  for (const [x, y] of [[5, 3], [6, 3], [5, 4], [6, 4]]) setCell(ramp, x, y, { elevation: 5 })
  const stats = {}
  repairImportedLevel(ramp, stats)
  assert.equal(stats.ramps, 1)
  const steps = []
  for (let y = 0; y < 8; y += 1) for (let x = 0; x < 9; x += 1) steps.push(Math.abs(cellAt(ramp, x, y).elevation - cellAt(ramp, x + 1, y).elevation))
  assert.ok(steps.some((step) => step > 0 && step <= 3), 'на помост в пять футов ведёт шаг не выше трёх')

  const tower = grassLevel()
  for (const [x, y] of [[5, 3], [6, 3]]) setCell(tower, x, y, { elevation: 15 })
  const towerStats = {}
  repairImportedLevel(tower, towerStats)
  assert.equal(towerStats.sealedCells, 2)
  assert.equal(cellAt(tower, 5, 3).passable, false, 'на площадку в пятнадцать футов без лестницы не встать — она глухая')
})

test('этап 5: предмет на крайней клетке сдвигается внутрь, а если некуда — убирается', () => {
  const map = grassLevel()
  addProp(map, { id: 'barrel-edge', assetId: 'barrel', x: 0.5, y: 3.5, footprint: [{ x: 0, y: 3 }], blocksMove: true })
  addProp(map, { id: 'statue-corner', assetId: 'statue', x: 9.5, y: 7.5, footprint: [{ x: 9, y: 7 }], blocksMove: true })
  addProp(map, { id: 'crate-blocker', assetId: 'crate', x: 8.5, y: 6.5, footprint: [{ x: 8, y: 6 }], blocksMove: true })
  const stats = {}
  repairImportedLevel(map, stats)
  assert.deepEqual(map.props.find((prop) => prop.id === 'barrel-edge')?.footprint, [{ x: 1, y: 3 }])
  assert.equal(map.props.some((prop) => prop.id === 'statue-corner'), false, 'угол занят ящиком — статуя убрана')
  assert.equal(stats.edgePropsMoved, 1)
  assert.equal(stats.edgePropsDropped, 1)
})
