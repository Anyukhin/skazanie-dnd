// Синтетические слэбы TaleSpire для тестов импорта.
//
// Настоящие слэбы с TalesTavern в репозиторий не кладутся: это чужие постройки.
// Здесь слэб собирается кодировщиком по описанию формата (v2 — по format.md
// Bouncyrock, v1 — по восстановленной раскладке) из ассетов нашей таблицы.
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const TABLE = JSON.parse(readFileSync(new URL('../data/talespire-assets-v1.json', import.meta.url), 'utf8')).assets

/** @param {string} guid */
function guidBytes(guid) {
  const hex = guid.replace(/-/gu, '')
  const bytes = Buffer.from(hex, 'hex')
  // .NET: первые три поля little-endian
  return Buffer.concat([
    Buffer.from([bytes[3], bytes[2], bytes[1], bytes[0], bytes[5], bytes[4], bytes[7], bytes[6]]),
    bytes.subarray(8, 16),
  ])
}

/**
 * Первый по идентификатору ассет, подходящий под условие.
 * @param {(row: any[]) => boolean} predicate
 */
export function pickAsset(predicate) {
  const found = Object.entries(TABLE).sort(([left], [right]) => left.localeCompare(right)).find(([, row]) => predicate(row))
  if (!found) throw new Error('В таблице нет подходящего ассета')
  return { id: found[0], row: found[1] }
}

const near = (/** @type {number} */ value, /** @type {number} */ expected) => Math.abs(value - expected) < 0.01

export const ASSETS = {
  floor: pickAsset((row) => row[0] === 't' && row[1] === 'floor' && near(row[5], 0.5) && near(row[6], 0.25) && near(row[7], 0.5) && near(row[2], 0.5) && near(row[4], 0.5)),
  // тонкая по x стена: тянется вдоль z
  wallAlongZ: pickAsset((row) => row[0] === 't' && row[1] === 'wall' && near(row[5], 0.25) && near(row[6], 1) && near(row[7], 0.5)),
  door: pickAsset((row) => row[0] === 't' && row[1] === 'door' && near(row[5], 0.5) && near(row[7], 0.25) && row[6] >= 0.8),
  stairs: pickAsset((row) => row[0] === 't' && row[1] === 'stairs' && near(row[5], 0.5) && near(row[6], 0.5) && near(row[7], 0.5)),
  table: pickAsset((row) => row[0] === 'p' && row[1] === 'prop' && row[9] === 'table_small' && row[5] * row[7] * 4 >= 0.3 && row[6] * 2 >= 0.5),
}

/**
 * @typedef {{ asset: { id: string, row: any[] }, x: number, y: number, z: number, rotation?: number }} Placement
 * x, y, z — минимальный угол повёрнутого габарита, как в слэбе v2.
 */

/** @param {Placement[]} placements */
function grouped(placements) {
  /** @type {Map<string, Placement[]>} */
  const byAsset = new Map()
  // Дописываем в список, а не копируем его: слэбы на пределе числа объектов
  // собираются из десятков тысяч записей.
  for (const placement of placements) {
    const list = byAsset.get(placement.asset.id)
    if (list) list.push(placement)
    else byAsset.set(placement.asset.id, [placement])
  }
  return [...byAsset.entries()]
}

/** @param {Placement[]} placements */
export function encodeSlabV2(placements) {
  const groups = grouped(placements)
  const header = Buffer.alloc(10)
  header.writeUInt32LE(0xD1CEFACE, 0)
  header.writeUInt16LE(2, 4)
  header.writeUInt16LE(groups.length, 6)
  header.writeUInt16LE(0, 8)
  const layouts = groups.map(([id, list]) => {
    const layout = Buffer.alloc(20)
    guidBytes(id).copy(layout, 0)
    layout.writeUInt16LE(list.length, 16)
    return layout
  })
  const instances = groups.flatMap(([, list]) => list.map((placement) => {
    const packed = BigInt(Math.round(placement.x * 100))
      | (BigInt(Math.round(placement.y * 100)) << 18n)
      | (BigInt(Math.round(placement.z * 100)) << 36n)
      | (BigInt(Math.round((placement.rotation ?? 0) / 15)) << 54n)
    const buffer = Buffer.alloc(8)
    buffer.writeBigUInt64LE(packed)
    return buffer
  }))
  return gzipSync(Buffer.concat([header, ...layouts, ...instances, Buffer.alloc(2)])).toString('base64')
}

/**
 * v1: габарит в мировых координатах. Повёрнутый габарит считается так же, как
 * его считает импортёр для v2, поэтому один и тот же дом даёт одни и те же карты.
 * @param {Placement[]} placements
 */
export function encodeSlabV1(placements) {
  const groups = grouped(placements)
  const header = Buffer.alloc(8)
  header.writeUInt32LE(0xD1CEFACE, 0)
  header.writeUInt16LE(1, 4)
  header.writeUInt16LE(groups.length, 6)
  const layouts = groups.map(([id, list]) => {
    const layout = Buffer.alloc(20)
    guidBytes(id).copy(layout, 0)
    layout.writeUInt16LE(list.length, 16)
    return layout
  })
  const instances = groups.flatMap(([, list]) => list.map((placement) => {
    const [, , , , , ex, ey, ez] = placement.asset.row
    const quarter = Math.round((placement.rotation ?? 0) / 90) % 2 === 1
    const halfX = quarter ? ez : ex
    const halfZ = quarter ? ex : ez
    const buffer = Buffer.alloc(28)
    ;[placement.x + halfX, placement.y + ey, placement.z + halfZ, halfX, ey, halfZ].forEach((value, index) => buffer.writeFloatLE(value, index * 4))
    buffer.writeUInt8(Math.round((placement.rotation ?? 0) / 22.5) % 16, 24)
    return buffer
  }))
  return gzipSync(Buffer.concat([header, ...layouts, ...instances, Buffer.alloc(24)])).toString('base64')
}

/**
 * v1 с центром и полуразмером как есть, без таблицы: так собираются слэбы с
 * координатами, которых настоящая постройка не даёт.
 * @param {Array<{ asset: { id: string }, center: [number, number, number], extent: [number, number, number] }>} records
 */
export function encodeSlabV1Raw(records) {
  const groups = grouped(records.map((record) => ({ ...record, x: 0, y: 0, z: 0 })))
  const header = Buffer.alloc(8)
  header.writeUInt32LE(0xD1CEFACE, 0)
  header.writeUInt16LE(1, 4)
  header.writeUInt16LE(groups.length, 6)
  const layouts = groups.map(([id, list]) => {
    const layout = Buffer.alloc(20)
    guidBytes(id).copy(layout, 0)
    layout.writeUInt16LE(list.length, 16)
    return layout
  })
  const instances = groups.flatMap(([, list]) => list.map((record) => {
    const buffer = Buffer.alloc(28)
    ;[...record.center, ...record.extent].forEach((value, index) => buffer.writeFloatLE(value, index * 4))
    return buffer
  }))
  return gzipSync(Buffer.concat([header, ...layouts, ...instances, Buffer.alloc(24)])).toString('base64')
}

/**
 * Двухэтажный дом:
 * - первый этаж 10×8 на высоте 0 (верх пола 0,5);
 * - стена по западному краю (линия x = 0);
 * - внутренняя стена по линии x = 7 с дверью в клетке z = 3;
 * - марш из трёх ступеней по x = 4 (z = 1…3), ведущий наверх;
 * - второй этаж 4×4 (x 0…3, z 4…7) на высоте 2,5 (верх пола 3,0);
 * - стол на первом этаже.
 * @returns {Placement[]}
 */
export function housePlacements() {
  /** @type {Placement[]} */
  const placements = []
  for (let x = 0; x < 10; x += 1) for (let z = 0; z < 8; z += 1) placements.push({ asset: ASSETS.floor, x, y: 0, z })
  for (let x = 0; x < 4; x += 1) for (let z = 4; z < 8; z += 1) placements.push({ asset: ASSETS.floor, x, y: 2.5, z })
  for (let z = 0; z < 8; z += 1) placements.push({ asset: ASSETS.wallAlongZ, x: 0, y: 0.5, z })
  for (let z = 0; z < 8; z += 1) {
    if (z === 3) placements.push({ asset: ASSETS.door, x: 6.75, y: 0.5, z, rotation: 90 })
    else placements.push({ asset: ASSETS.wallAlongZ, x: 6.75, y: 0.5, z })
  }
  placements.push({ asset: ASSETS.stairs, x: 4, y: 0.5, z: 1 })
  placements.push({ asset: ASSETS.stairs, x: 4, y: 1.0, z: 2 })
  placements.push({ asset: ASSETS.stairs, x: 4, y: 1.5, z: 3 })
  placements.push({ asset: ASSETS.table, x: 2, y: 0.5, z: 1 })
  return placements
}

export const HOUSE_SLAB = encodeSlabV2(housePlacements())
