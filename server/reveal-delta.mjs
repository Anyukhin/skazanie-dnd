// @ts-check
import { cellAt, deserializeTacticalMap, setCell } from './tactical-map.mjs'

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
 */

export const REVEAL_DELTA_VERSION = 'skazanie:reveal-delta-v1'

/**
 * @typedef {object} RevealDelta
 * @property {string} version
 * @property {string} baseHash хеш карты, к которой дельта применима
 * @property {number} width ширина карты: без неё индексы бессмысленны
 * @property {Array<[number, number]>} revealed интервалы индексов [начало, длина]
 * @property {Array<[number, number]>} hidden интервалы, которые снова скрыты
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
  return {
    version: REVEAL_DELTA_VERSION,
    baseHash,
    width: after.width,
    revealed: toRuns(revealed),
    hidden: toRuns(hidden),
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
  for (const [start, length] of delta.revealed ?? []) {
    for (let index = start; index < start + length; index += 1) {
      const x = index % map.width
      const y = Math.floor(index / map.width)
      if (cellAt(map, x, y)) setCell(map, x, y, { revealed: true })
    }
  }
  for (const [start, length] of delta.hidden ?? []) {
    for (let index = start; index < start + length; index += 1) {
      const x = index % map.width
      const y = Math.floor(index / map.width)
      if (cellAt(map, x, y)) setCell(map, x, y, { revealed: false })
    }
  }
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
