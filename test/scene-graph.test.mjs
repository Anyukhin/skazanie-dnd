import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SceneGraphError,
  addSceneLink,
  addSceneZone,
  createSceneGraph,
  progressionWaves,
  reachableZones,
  validateSceneGraph,
} from '../server/scene-graph.mjs'

/** Двор → зал → кладовая за запертой дверью, ключ в кухне. */
function tavernGraph(overrides = {}) {
  return createSceneGraph({
    entranceZoneId: 'yard',
    goalZoneId: 'store',
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
    ...overrides,
  })
}

test('исправный граф проходит проверку', () => {
  const report = validateSceneGraph(tavernGraph())
  assert.deepEqual(report.errors, [])
  assert.equal(report.ok, true)
})

test('ключ добирается за две волны, и это видно в достижимости', () => {
  const graph = tavernGraph()
  const reached = reachableZones(graph)
  assert.deepEqual([...reached.zones].sort(), ['hall', 'kitchen', 'store', 'yard'])
  assert.deepEqual([...reached.keys], ['store-key'])
  assert.ok(reached.rounds >= 2, 'кладовая открывается только после второго обхода — сначала нужен ключ')
})

test('порядок волн показывает, где лежит ключ и когда открывается цель', () => {
  const waves = progressionWaves(tavernGraph())
  assert.deepEqual(waves[0].zones, ['yard'])
  assert.deepEqual(waves[1].zones, ['hall'])
  assert.deepEqual(waves[2].zones, ['kitchen'])
  assert.deepEqual(waves[2].keysGained, ['store-key'])
  assert.deepEqual(waves[3].zones, ['store'], 'цель открывается только после того, как найден ключ')
})

test('ключ за собственной дверью отклоняется', () => {
  // Ключ от кладовой переложен в саму кладовую.
  const graph = createSceneGraph({
    entranceZoneId: 'yard',
    goalZoneId: 'store',
    zones: [
      { id: 'yard', kind: 'exterior' },
      { id: 'hall', kind: 'interior' },
      { id: 'store', kind: 'interior', keys: ['store-key'] },
    ],
    links: [
      { id: 'front', from: 'yard', to: 'hall', kind: 'door' },
      { id: 'to-store', from: 'hall', to: 'store', kind: 'locked', keyId: 'store-key' },
    ],
  })
  const report = validateSceneGraph(graph)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'KEY_BEHIND_ITS_OWN_DOOR'),
    `коды: ${report.errors.map((issue) => issue.code).join(', ')}`)
  assert.ok(report.errors.some((issue) => issue.code === 'GOAL_UNREACHABLE'))
})

test('цель за запертой дверью без ключа отклоняется', () => {
  const graph = tavernGraph()
  graph.zones.find((zone) => zone.id === 'kitchen').keys = []
  const report = validateSceneGraph(graph)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'KEY_NEVER_PLACED'))
  assert.ok(report.errors.some((issue) => issue.code === 'GOAL_UNREACHABLE'))
})

test('недостижимая обязательная зона отклоняется', () => {
  const graph = tavernGraph()
  addSceneZone(graph, { id: 'cellar', kind: 'interior', required: true, label: 'Подвал' })
  const report = validateSceneGraph(graph)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'REQUIRED_ZONE_UNREACHABLE' && issue.at === 'cellar'))
})

test('запертая связь без ключа и висячая ссылка отклоняются', () => {
  const graph = tavernGraph()
  addSceneLink(graph, { id: 'broken-lock', from: 'hall', to: 'kitchen', kind: 'locked' })
  addSceneLink(graph, { id: 'dangling', from: 'hall', to: 'nowhere', kind: 'open' })
  const report = validateSceneGraph(graph)
  assert.ok(report.errors.some((issue) => issue.code === 'LOCKED_LINK_WITHOUT_KEY'))
  assert.ok(report.errors.some((issue) => issue.code === 'LINK_END_MISSING'))
})

test('односторонний проход не пускает обратно', () => {
  const graph = createSceneGraph({
    entranceZoneId: 'ledge',
    goalZoneId: 'pit',
    zones: [{ id: 'ledge', kind: 'exterior' }, { id: 'pit', kind: 'interior' }],
    links: [{ id: 'drop', from: 'ledge', to: 'pit', kind: 'oneway' }],
  })
  assert.deepEqual([...reachableZones(graph).zones].sort(), ['ledge', 'pit'])
  assert.deepEqual([...reachableZones(graph, 'pit').zones], ['pit'], 'из ямы обратно на уступ хода нет')
  assert.equal(validateSceneGraph(graph).ok, true)
})

test('цепочка из трёх ключей разбирается по порядку', () => {
  const graph = createSceneGraph({
    entranceZoneId: 'a',
    goalZoneId: 'd',
    zones: [
      { id: 'a', keys: ['k1'] },
      { id: 'b', keys: ['k2'] },
      { id: 'c', keys: ['k3'] },
      { id: 'd' },
    ],
    links: [
      { id: 'ab', from: 'a', to: 'b', kind: 'locked', keyId: 'k1' },
      { id: 'bc', from: 'b', to: 'c', kind: 'locked', keyId: 'k2' },
      { id: 'cd', from: 'c', to: 'd', kind: 'locked', keyId: 'k3' },
    ],
  })
  const report = validateSceneGraph(graph)
  assert.deepEqual(report.errors, [])
  const waves = progressionWaves(graph)
  assert.deepEqual(waves.map((entry) => entry.zones), [['a'], ['b'], ['c'], ['d']])
  assert.deepEqual(waves.map((entry) => entry.keysGained), [['k1'], ['k2'], ['k3'], []])
})

test('перепутанный порядок ключей ловится: второй ключ заперт третьей дверью', () => {
  const graph = createSceneGraph({
    entranceZoneId: 'a',
    goalZoneId: 'c',
    zones: [{ id: 'a', keys: ['k1'] }, { id: 'b' }, { id: 'c', keys: ['k2'] }],
    links: [
      { id: 'ab', from: 'a', to: 'b', kind: 'locked', keyId: 'k1' },
      { id: 'bc', from: 'b', to: 'c', kind: 'locked', keyId: 'k2' },
    ],
  })
  const report = validateSceneGraph(graph)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'KEY_BEHIND_ITS_OWN_DOOR' && issue.at === 'bc'))
})

test('зона без идентификатора и связь без конца не создаются', () => {
  const graph = createSceneGraph({ entranceZoneId: 'a', zones: [{ id: 'a' }] })
  assert.throws(() => addSceneZone(graph, { kind: 'interior' }),
    (error) => error instanceof SceneGraphError && error.code === 'ZONE_ID_REQUIRED')
  assert.throws(() => addSceneLink(graph, { from: 'a', kind: 'open' }),
    (error) => error instanceof SceneGraphError && error.code === 'LINK_ENDS_REQUIRED')
})

test('граф без входа не роняет проверку, а получает внятный отказ', () => {
  const report = validateSceneGraph(createSceneGraph({ zones: [{ id: 'a' }], goalZoneId: 'a' }))
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((issue) => issue.code === 'ENTRANCE_ZONE_MISSING'))
})

test('секретный проход не запирает путь', () => {
  const graph = createSceneGraph({
    entranceZoneId: 'hall',
    goalZoneId: 'vault',
    zones: [{ id: 'hall' }, { id: 'vault', required: true }],
    links: [{ id: 'hidden', from: 'hall', to: 'vault', kind: 'secret' }],
  })
  const report = validateSceneGraph(graph)
  assert.deepEqual(report.errors, [], 'секрет — это видимость, а не замок; отдельная механика поиска не дело графа')
})
