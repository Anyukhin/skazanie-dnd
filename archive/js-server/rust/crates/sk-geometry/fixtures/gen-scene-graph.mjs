// Эталон `server/scene-graph.mjs` для Rust-переноса
// (`rust/crates/sk-geometry/src/scene_graph.rs`).
//
// Запуск из корня репозитория:
//   node rust/crates/sk-geometry/fixtures/gen-scene-graph.mjs
// Пишет `scene-graph.json` рядом со скриптом: случайные рецепты графа (сид
// фиксирован, mulberry32), собранный граф или отказ, проверка, достижимость от
// входа и от случайной зоны, волны прогрессии. `{"$u":1}` — `undefined`.

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LINK_KINDS,
  SCENE_GRAPH_VERSION,
  createSceneGraph,
  progressionWaves,
  reachableZones,
  validateSceneGraph,
} from '../../../../server/scene-graph.mjs'

const UNDEFINED = Object.freeze({ $u: 1 })
const here = dirname(fileURLToPath(import.meta.url))

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = mulberry32(0x9a7e5)
const int = (min, max) => min + Math.floor(random() * (max - min + 1))
const pick = (list) => list[Math.floor(random() * list.length)]
const maybe = (probability, value) => random() < probability ? value() : undefined

const ZONE_IDS = ['yard', 'hall', 'kitchen', 'store', 'cellar', 'tower', 'vault', 'gate']
const KEYS = ['k1', 'k2', 'k3', 'store-key']

function zoneId(pool = ZONE_IDS) {
  return random() < 0.97 ? pick(random() < 0.9 ? pool : ZONE_IDS) : pick([' hall ', '', null, 42, 'нет-такой', 'x'.repeat(130), '　yard'])
}

function zone(count) {
  if (random() < 0.02) return pick([null, 'зона', 7])
  const value = {}
  const id = random() < 0.97 ? ZONE_IDS[count % ZONE_IDS.length] : zoneId()
  if (id !== undefined) value.id = id
  if (random() < 0.8) value.kind = pick(['interior', 'exterior', 'EXTERIOR', 'outside', null])
  if (random() < 0.5) value.required = pick([true, false, 'true', 1])
  if (random() < 0.5) {
    value.keys = random() < 0.9
      ? Array.from({ length: int(0, 3) }, () => random() < 0.85 ? pick(KEYS) : pick(['', '  k1  ', 5, null, ['k2']]))
      : pick(['k1', null, { k1: true }])
  }
  if (random() < 0.6) value.label = pick(['Двор', 'Зал', ' Кухня ', 5, null])
  return value
}

function link(pool) {
  if (random() < 0.02) return pick([null, 'связь'])
  const value = {}
  if (random() < 0.7) value.id = pick(['front', 'back', 'to-store', 'drop', 'hidden', '', ' gate ', 9])
  if (random() < 0.995) value.from = zoneId(pool)
  if (random() < 0.995) value.to = zoneId(pool)
  value.kind = random() < 0.85 ? pick(LINK_KINDS) : pick(['LOCKED', ['door'], null, 'portal', 3])
  if (random() < 0.6) value.keyId = random() < 0.8 ? pick(KEYS) : pick([null, '', 5, ' k2 '])
  if (random() < 0.3) value.bidirectional = pick([true, false, 'false', 0])
  return value
}

function recipe() {
  if (random() < 0.02) return pick([null, 'рецепт', 5, []])
  const value = {}
  if (random() < 0.92) value.entranceZoneId = random() < 0.85 ? pick(ZONE_IDS.slice(0, 4)) : zoneId()
  if (random() < 0.85) value.goalZoneId = random() < 0.85 ? pick(ZONE_IDS.slice(0, 6)) : zoneId()
  const zoneCount = int(1, 8)
  value.zones = random() < 0.97 ? Array.from({ length: zoneCount }, (_, index) => zone(index)) : pick([null, 'zones'])
  const pool = ZONE_IDS.slice(0, zoneCount)
  value.links = random() < 0.97 ? Array.from({ length: int(0, Math.max(2, zoneCount + 3)) }, () => link(pool)) : pick([null, {}])
  return value
}

function outcome(input) {
  let graph
  try {
    graph = createSceneGraph(input === UNDEFINED ? undefined : input)
  } catch (error) {
    return { error: { code: error.code ?? 'TYPE_ERROR', message: error.message } }
  }
  const from = pick([UNDEFINED, ...ZONE_IDS, ' hall ', '', 'нет'])
  const fromReached = reachableZones(graph, from === UNDEFINED ? undefined : from)
  const reached = reachableZones(graph)
  return {
    graph,
    report: validateSceneGraph(graph),
    reached: { zones: [...reached.zones], keys: [...reached.keys], rounds: reached.rounds },
    from,
    fromReached: { zones: [...fromReached.zones], keys: [...fromReached.keys], rounds: fromReached.rounds },
    waves: progressionWaves(graph),
  }
}

const cases = []
// Ручные графы: таверна, цепочка ключей и ключ, найденный уже после
// проверки запертой двери в том же обходе.
const manual = [
  {
    entranceZoneId: 'yard', goalZoneId: 'store',
    zones: [
      { id: 'yard', kind: 'exterior', label: 'Участок' },
      { id: 'hall', kind: 'interior', required: true, label: 'Общий зал' },
      { id: 'kitchen', kind: 'interior', keys: ['store-key'], label: 'Кухня' },
      { id: 'store', kind: 'interior', label: 'Кладовая' },
    ],
    links: [
      { id: 'front', from: 'yard', to: 'hall', kind: 'door' },
      { id: 'to-kitchen', from: 'hall', to: 'kitchen', kind: 'open' },
      { id: 'to-store', from: 'hall', to: 'store', kind: 'locked', keyId: 'store-key' },
    ],
  },
  {
    entranceZoneId: 'a', goalZoneId: 'c',
    zones: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd', keys: ['k'] }],
    links: [
      { id: 'ab', from: 'a', to: 'b', kind: 'open' },
      { id: 'bc', from: 'b', to: 'c', kind: 'locked', keyId: 'k' },
      { id: 'bd', from: 'b', to: 'd', kind: 'open' },
    ],
  },
  UNDEFINED,
]
for (const input of manual) cases.push({ input, ...outcome(input) })
for (let index = 0; index < 500; index += 1) {
  const input = recipe()
  cases.push({ input, ...outcome(input) })
}

const fixture = { version: SCENE_GRAPH_VERSION, linkKinds: LINK_KINDS, cases }
const target = join(here, 'scene-graph.json')
writeFileSync(target, `${JSON.stringify(fixture)}\n`)
console.log(`scene-graph: ${cases.length} графов, отказов ${cases.filter((entry) => entry.error).length} → ${target}`)
