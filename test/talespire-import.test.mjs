import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import { decodeSlab, SLAB_MAX_TEXT_LENGTH } from '../server/talespire-slab.mjs'
import { importTaleSpireSlab, roomLabelFor } from '../server/talespire-import.mjs'
import { cellAt, deserializeTacticalMap, edgeList, validateTacticalMap } from '../server/tactical-map.mjs'
import { ASSETS, HOUSE_SLAB, encodeSlabV1, encodeSlabV2, housePlacements } from './talespire-fixtures.mjs'

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
  // За дверью — нераскрытая комната.
  const door = ground.doors[0]
  const behind = door.dir === 'e' ? cellAt(ground, door.x + 1, door.y) : cellAt(ground, door.x, door.y + 1)
  const before = cellAt(ground, door.x, door.y)
  assert.ok(behind && before)
  assert.notEqual(behind.revealed, before.revealed, 'дверь разделяет раскрытую и нераскрытую части')
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
