// Общий корпус для эталонов sk-scene-base: живые русские фразы из данных
// кампаний и детерминированный генератор выборки. Только чтение репозитория.
import { readFileSync } from 'node:fs'

const root = new URL('../../../../', import.meta.url)

/** @param {string} path */
export function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, root), 'utf8'))
}

/** @param {string} path */
export function readText(path) {
  return readFileSync(new URL(path, root), 'utf8')
}

/** Все строки JSON-дерева по порядку обхода. */
export function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out)
  return out
}

/** mulberry32: детерминированная выборка. */
export function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Детерминированно перемешанная копия. */
export function shuffled(list, seed) {
  const next = rng(seed)
  const copy = [...list]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1))
    ;[copy[index], copy[other]] = [copy[other], copy[index]]
  }
  return copy
}

/** Фразы кириллицей из данных кампаний и сценария, без повторов. */
export function sentences() {
  const sources = [
    ...collectStrings(readJson('data/campaign-worlds-v1.json')),
    ...collectStrings(readJson('data/campaign-scenarios-v1.json')),
    ...collectStrings(readJson('data/campaign-dialogues-v1.json')),
    readText('docs/astohan-scenario.md'),
  ]
  const seen = new Set()
  const result = []
  for (const text of sources) {
    for (const sentence of text.split(/(?<=[.!?…])\s+/u)) {
      const value = sentence.trim()
      if (value.length < 12 || value.length > 400 || !/[а-яё]/iu.test(value) || seen.has(value)) continue
      seen.add(value)
      result.push(value)
    }
  }
  return result
}

/** Имена мест, описания и биомы из карт миров. */
export function worldLocations() {
  const worlds = readJson('data/campaign-worlds-v1.json').templates
  const result = []
  for (const world of worlds) {
    const map = world.world_map ?? {}
    for (const location of map.locations ?? []) result.push({ world, map, location })
  }
  return result
}

/** Стабильная запись JSON: `undefined` в массивах — `null`, как у JSON.stringify. */
export function jsonOf(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value))
}
