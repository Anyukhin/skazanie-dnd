// Эталон для `projection_integrity.rs`: каноническая проекция и её хеш на
// сотнях случайных состояний — прогоном самого JS.
//
//   node rust/crates/sk-narration-base/fixtures/gen-projection-integrity.mjs
//
// Состояние хранится текстом JSON: обе стороны разбирают одну и ту же строку,
// поэтому большие целые и дроби округляются одинаково.
import { writeFileSync } from 'node:fs'

import { CANONICAL_PROJECTION_FIELDS, canonicalProjection, compareProjection, projectionHash } from '../../../../server/projection-integrity.mjs'

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(131)
const chance = (p) => random() < p
const int = (min, max) => min + Math.floor(random() * (max - min + 1))
const choice = (list) => list[Math.floor(random() * list.length)]

const KEYS = [
  'id', 'name', 'hp', 'x', 'y', 'online', 'Zeta', 'alpha', 'Alpha', 'ё', 'е', 'я', 'A', 'a', '_', '-', ' ', '',
  '0', '1', '2', '10', '01', '-1', '4294967294', '4294967295', '9007199254740993', '__proto__', 'constructor',
  '\u{1F600}', '｡', 'é', 'é', 'ключ', 'Ключ', 'key with space',
]
const STRINGS = [
  '', 'Мира', 'строка "в кавычках"', 'обратный \\ слэш', 'перенос\nстроки', 'таб\tи\rвозврат', '\u0001\u001f\u007f',
  '  ', 'эмодзи \u{1F409}', '</script>', 'NFKC Ｍ', 'é', 'é', '0', 'null',
]
const NUMBERS = [0, 1, -1, 2, 3.5, -0.25, 0.1, 0.30000000000000004, 1e21, 1.5e21, 1e-7, 1.5e-7, 123456789.123, 2 ** 53, -(2 ** 53), 1 / 3, 100, 7e-10]

function randomValue(depth) {
  const roll = random()
  if (depth <= 0 || roll < 0.45) {
    return choice([
      () => choice(STRINGS),
      () => choice(NUMBERS),
      () => int(-1000, 1000),
      () => random() * 1000,
      () => chance(0.5),
      () => null,
    ])()
  }
  if (roll < 0.7) return Array.from({ length: int(0, 4) }, () => randomValue(depth - 1))
  const object = {}
  for (let index = int(0, 5); index > 0; index -= 1) object[choice(KEYS)] = randomValue(depth - 1)
  return object
}

function randomPlayer() {
  return choice([
    () => ({ id: `hero-${int(1, 4)}`, online: chance(0.5), character: choice(STRINGS), stats: randomValue(2), [choice(KEYS)]: randomValue(1) }),
    () => ({ online: true }),
    () => randomValue(1),
    () => [1, 'два', { online: true }],
    () => null,
  ])()
}

function randomState() {
  const state = {}
  for (const field of CANONICAL_PROJECTION_FIELDS) {
    if (!chance(0.45)) continue
    state[field] = field === 'players'
      ? (chance(0.85) ? Array.from({ length: int(0, 4) }, randomPlayer) : randomValue(1))
      : randomValue(3)
  }
  // Поля комнаты, которых нет в проекции.
  for (const extra of ['chat', 'online', 'presence', 'viewer', 'updatedAt']) if (chance(0.3)) state[extra] = randomValue(2)
  return state
}

const states = []
for (let index = 0; index < 250; index += 1) states.push(JSON.stringify(randomState()))
// Ручные случаи: большие целые и формы чисел, которые JSON.stringify печатает иначе, чем serde_json.
states.push('{"scene":{"big":9007199254740993,"bigger":123456789012345678901234,"float":1.0,"neg":-0,"exp":1E2,"small":0.0000001}}')
states.push('{"players":[{"id":"a","online":true},{"id":"b","online":false,"10":1,"9":2}],"agentInteraction":null}')
states.push('{}')
states.push('{"__proto__":{"x":1},"scene":{"__proto__":[1,2],"constructor":3}}')
states.push('{"agentInteraction":{"b":1,"a":[{"d":4,"c":3}]}}')

const cases = states.map((text) => {
  const state = JSON.parse(text)
  return { state: text, canonical: JSON.stringify(canonicalProjection(state)), hash: projectionHash(state) }
})

// Пары для compareProjection: одинаковые с точностью до online и порядка ключей
// и случайные разные.
const comparisons = []
for (let index = 0; index < 60; index += 1) {
  const left = JSON.parse(choice(states))
  const right = chance(0.5) ? structuredClone(left) : JSON.parse(choice(states))
  if (Array.isArray(right.players)) for (const player of right.players) if (player && typeof player === 'object' && !Array.isArray(player)) player.online = !player.online
  comparisons.push({ left: JSON.stringify(left), right: JSON.stringify(right), result: compareProjection(left, right) })
}

const lines = (list) => list.map((item) => JSON.stringify(item)).join(',\n')
writeFileSync(new URL('./projection-integrity.json', import.meta.url), `{\n"cases": [\n${lines(cases)}\n],\n"comparisons": [\n${lines(comparisons)}\n]\n}\n`)
console.log(`состояний ${cases.length}, сравнений ${comparisons.length}, совпало ${comparisons.filter((item) => item.result.matched).length}`)
