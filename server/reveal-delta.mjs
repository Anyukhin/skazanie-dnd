// @ts-check
import { MATERIALS, SURFACES, cellAt, deserializeTacticalMap, setCell } from './tactical-map.mjs'

/**
 * Дельты раскрытия вместо полной сетки (`docs/tactical-map-plan.md`, 11.2).
 *
 * Базовая карта передаётся один раз и кэшируется клиентом по хешу; дальше идут
 * только изменения. Раскрытие — единственное, что меняется у карты каждый ход,
 * и передавать ради него всю сетку незачем.
 *
 * Дельта хранит **интервалы индексов**, а не список координат: раскрытие идёт
 * связной областью вокруг отряда, поэтому интервалов получается единицы. Замер:
 * раскрытие круга радиусом 6 клеток на карте 100×100 — 13 интервалов против 113
 * координат.
 *
 * **Формат v2 несёт ещё и значения слоёв.** Проекция обезличивает нераскрытую
 * клетку: `viewer-projection.mjs` ставит ей `material: 'stone'`, `variant: 0` и
 * `surface: 'none'`, а при раскрытии возвращает настоящие значения. Дельта из
 * одних интервалов раскрытия воспроизвести это не могла, поэтому собранная из
 * неё карта расходилась с проекцией и транспорт всегда откатывался на полную
 * карту. Теперь дельта несёт значения этих трёх слоёв для каждой затронутой
 * клетки.
 *
 * Пакуются они тем же приёмом, что и слои самой карты (`encodeLayer` в
 * `tactical-map.mjs`): однородный слой — одно число, разнородный — base64 по
 * байту на клетку. Материал и поверхность в раскрываемой области однородны и
 * сжимаются в одно число. Вариант тайла однородным не бывает: настоящие
 * генераторы ставят его как `Math.floor(random() * 6)` на каждую клетку, и
 * длины серий его не сжимают, а раздувают — замер на 565 клетках даёт 2.8 КБ
 * сериями против 0.75 КБ упаковкой по байту.
 *
 * Чего дельта по-прежнему не несёт: предметы, рёбра, двери и опасности,
 * появляющиеся вместе с раскрытием. Сторож в `reveal-transport.mjs` сравнивает
 * собранную карту с проекцией и в таких случаях честно отдаёт карту целиком.
 */

export const REVEAL_DELTA_VERSION = 'skazanie:reveal-delta-v2'

/**
 * Значения слоёв затронутых клеток. Каждое поле — либо одно число (весь слой
 * однороден), либо base64 по байту на клетку.
 *
 * @typedef {object} RevealDeltaValues
 * @property {string|number} material коды в MATERIALS
 * @property {string|number} variant варианты тайла
 * @property {string|number} surface коды в SURFACES
 */

/**
 * @typedef {object} RevealDelta
 * @property {string} version
 * @property {string} baseHash хеш карты, к которой дельта применима
 * @property {number} width ширина карты: без неё индексы бессмысленны
 * @property {Array<[number, number]>} revealed интервалы индексов [начало, длина]
 * @property {Array<[number, number]>} hidden интервалы, которые снова скрыты
 * @property {RevealDeltaValues} values значения слоёв затронутых клеток
 */

/**
 * @param {number[]} indexes отсортированные индексы
 * @returns {Array<[number, number]>}
 */
function toRuns(indexes) {
  /** @type {Array<[number, number]>} */
  const runs = []
  let start = -1
  let length = 0
  for (const index of indexes) {
    if (start >= 0 && index === start + length) { length += 1; continue }
    if (start >= 0) runs.push([start, length])
    start = index
    length = 1
  }
  if (start >= 0) runs.push([start, length])
  return runs
}

/**
 * @param {Uint8Array} values
 * @returns {string|number}
 */
function encodeValues(values) {
  const first = values[0]
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] !== first) return Buffer.from(values).toString('base64')
  }
  return values.length ? first : 0
}

/**
 * Длина обязана совпасть с числом затронутых клеток: дельта, которая покрывает
 * не все клетки, испорчена, и молча дорисовывать её нельзя — это была бы карта,
 * расходящаяся с проекцией.
 *
 * @param {unknown} value
 * @param {number} expected
 * @param {string} label
 * @returns {Uint8Array}
 */
function decodeValues(value, expected, label) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const filled = new Uint8Array(expected)
    filled.fill(value & 0xff)
    return filled
  }
  if (typeof value !== 'string') {
    throw new Error(`Слой ${label} дельты раскрытия должен быть строкой base64 или числом`)
  }
  const bytes = Uint8Array.from(Buffer.from(value, 'base64'))
  if (bytes.length !== expected) {
    throw new Error(`Слой ${label} дельты раскрытия покрывает ${bytes.length} клеток из ${expected}`)
  }
  return bytes
}

/**
 * Индексы интервала подряд. Порядок здесь — часть формата: значения слоёв
 * уложены ровно в этом порядке, сначала раскрытые клетки, затем скрытые.
 *
 * @param {unknown} runs
 * @param {number} limit число клеток карты
 * @returns {number[]}
 */
function runIndexes(runs, limit) {
  /** @type {number[]} */
  const indexes = []
  for (const run of Array.isArray(runs) ? runs : []) {
    const start = Number(run?.[0])
    const length = Number(run?.[1])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > limit) {
      throw new Error('Интервал дельты раскрытия выходит за пределы карты')
    }
    for (let index = start; index < start + length; index += 1) indexes.push(index)
  }
  return indexes
}

/**
 * Считает, что изменилось в раскрытии между двумя состояниями одной карты.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} before
 * @param {import('./tactical-map.mjs').TacticalMap} after
 * @param {string} baseHash
 * @returns {RevealDelta}
 */
export function revealDelta(before, after, baseHash = '') {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error('Дельта раскрытия строится только между состояниями одной карты')
  }
  /** @type {number[]} */
  const revealed = []
  /** @type {number[]} */
  const hidden = []
  const length = after.width * after.height
  for (let index = 0; index < length; index += 1) {
    const x = index % after.width
    const y = Math.floor(index / after.width)
    const wasCell = cellAt(before, x, y)
    const nowCell = cellAt(after, x, y)
    if (!nowCell) continue
    const was = wasCell?.revealed === true
    const now = nowCell.revealed === true
    if (was === now) continue
    if (now) revealed.push(index)
    else hidden.push(index)
  }
  const touched = [...revealed, ...hidden]
  const material = new Uint8Array(touched.length)
  const variant = new Uint8Array(touched.length)
  const surface = new Uint8Array(touched.length)
  for (let position = 0; position < touched.length; position += 1) {
    const index = touched[position]
    material[position] = after.layers.material[index]
    variant[position] = after.layers.variant[index]
    surface[position] = after.layers.surface[index]
  }
  return {
    version: REVEAL_DELTA_VERSION,
    baseHash,
    width: after.width,
    revealed: toRuns(revealed),
    hidden: toRuns(hidden),
    values: {
      material: encodeValues(material),
      variant: encodeValues(variant),
      surface: encodeValues(surface),
    },
  }
}

/**
 * Накладывает дельту на карту. Карта мутируется; возвращается она же.
 *
 * @param {import('./tactical-map.mjs').TacticalMap} map
 * @param {RevealDelta} delta
 * @returns {import('./tactical-map.mjs').TacticalMap}
 */
export function applyRevealDelta(map, delta) {
  if (!delta || delta.version !== REVEAL_DELTA_VERSION) return map
  if (delta.width !== map.width) {
    throw new Error('Дельта раскрытия не подходит к этой карте: другая ширина')
  }
  const limit = map.width * map.height
  const revealed = runIndexes(delta.revealed, limit)
  const hidden = runIndexes(delta.hidden, limit)
  const touched = revealed.length + hidden.length
  const values = delta.values ?? /** @type {RevealDeltaValues} */ ({})
  const material = decodeValues(values.material, touched, 'material')
  const variant = decodeValues(values.variant, touched, 'variant')
  const surface = decodeValues(values.surface, touched, 'surface')

  let at = 0
  /** @param {number[]} indexes @param {boolean} value */
  const write = (indexes, value) => {
    for (const index of indexes) {
      const position = at
      at += 1
      const x = index % map.width
      const y = Math.floor(index / map.width)
      // Клетки, которой нет, дельта не создаёт: форма карты приходит с картой.
      // Значение при этом всё равно считается израсходованным, иначе порядок
      // разъехался бы у следующих клеток.
      if (!cellAt(map, x, y)) continue
      const materialName = MATERIALS[material[position]]
      const surfaceName = SURFACES[surface[position]]
      if (materialName === undefined || surfaceName === undefined) {
        throw new Error('Дельта раскрытия называет слой, которого нет в перечислении')
      }
      setCell(map, x, y, { revealed: value, material: materialName, variant: variant[position], surface: surfaceName })
    }
  }
  write(revealed, true)
  write(hidden, false)
  return map
}

/**
 * Пуста ли дельта. Пустую незачем отправлять вовсе.
 *
 * @param {RevealDelta} delta
 * @returns {boolean}
 */
export function revealDeltaEmpty(delta) {
  return !delta || ((delta.revealed?.length ?? 0) === 0 && (delta.hidden?.length ?? 0) === 0)
}

/**
 * Сколько клеток затрагивает дельта. Нужно для порога из раздела 13 и для
 * решения, не дешевле ли отправить карту целиком.
 *
 * @param {RevealDelta} delta
 * @returns {number}
 */
export function revealDeltaSize(delta) {
  if (!delta) return 0
  let total = 0
  for (const [, length] of delta.revealed ?? []) total += length
  for (const [, length] of delta.hidden ?? []) total += length
  return total
}

/**
 * Готовит пару «что отправить клиенту»: если карта у клиента та же, идёт
 * дельта; если другая или её нет — карта целиком.
 *
 * @param {object} options
 * @param {Record<string, any>} options.serializedMap текущая карта
 * @param {string} options.currentHash хеш текущей карты
 * @param {string} [options.clientHash] что закэшировано у клиента
 * @param {Record<string, any>} [options.clientMap] прежнее состояние той же карты
 * @returns {{kind: 'full', map: Record<string, any>, hash: string} | {kind: 'delta', delta: RevealDelta}}
 */
export function revealUpdateFor({ serializedMap, currentHash, clientHash, clientMap }) {
  if (!clientHash || !clientMap || clientHash !== currentHash) {
    return { kind: 'full', map: serializedMap, hash: currentHash }
  }
  const before = deserializeTacticalMap(clientMap)
  const after = deserializeTacticalMap(serializedMap)
  return { kind: 'delta', delta: revealDelta(before, after, currentHash) }
}
