import '../../../fixtures-env.mjs'
// Эталон server/scene-hazards.mjs и server/scene-hazard-narration.mjs для Rust:
//
//   node rust/crates/sk-combat-content/fixtures/gen-scene-hazards.mjs
//
// Справочник обстановки по каждому ключу (с путями, расширениями, регистром),
// клетки пропа, источник огня рядом с героем разного размера, запись горящей
// зоны и тексты рассказчика для опрокидывания и поджога каждого пропа.
import * as m from '../../../../server/scene-hazards.mjs'
import * as n from '../../../../server/scene-hazard-narration.mjs'
import { encode, mulberry32, writeFixture } from './common.mjs'

const random = mulberry32(3_2)
const pick = (items) => items[Math.floor(random() * items.length)]

// Ключи прототипа объекта (`constructor`, `__proto__`) JS находит в
// справочнике-объекте; перенос считает их неизвестными (см. отчёт), поэтому
// в эталон они не попадают.
const keys = [...new Set([...m.sceneHazardAssetIds(), ...m.fireSourceAssetIds(), ...m.swingPropAssetIds(), 'rune', 'chair', 'night_table', 'table', ''])]
const assetIds = [
  ...keys, ...keys.map((key) => `props/${key}.png`), ...keys.map((key) => `C:\\atlas\\${key.toUpperCase()}.webp`), ...keys.map((key) => `  ${key}  `),
  'props/table_long.PNG', 'table_long.tar.gz', 'a/b/', '/', 'Bookshelf', null, undefined, 5, ['bookshelf'], { id: 'bookshelf' }, 'x'.repeat(130) + 'bookshelf',
]
const assets = assetIds.map((assetId) => ({
  assetId: encode(assetId),
  key: m.hazardAssetKey(assetId),
  tags: m.sceneHazardTagsFor(assetId),
  verbs: m.sceneHazardVerbsFor(assetId),
  topple: m.toppleDefinitionFor(assetId),
  ignite: m.igniteDefinitionFor(assetId),
  swing: m.swingPropProfileFor(assetId),
}))

const PROPS = [
  { id: 'a', assetId: 'campfire', x: 1.5, y: 0.5, footprint: [{ x: 1, y: 0 }] }, { id: 'b', assetId: 'brazier', x: 4.5, y: 4.5 }, { id: 'c', assetId: 'bookshelf', footprint: [{ x: 0, y: 1 }, { x: 1, y: 1 }] },
  { id: ' d ', assetId: 'props/torch_wall.png', footprint: [{ x: '2', y: 2.7 }, { x: 'x', y: 1 }, null] }, { assetId: 'candle', x: -0.5, y: 0 }, { id: 'f', assetId: 'cauldron', x: 'a', y: 1 },
  { id: 'g', assetId: 'fireplace', footprint: [] , x: 7, y: 7 }, null, 'x',
]
const cellCases = PROPS.map((prop) => ({ prop: encode(prop), cells: m.hazardPropCells(prop) }))

const ACTORS = [
  undefined, null, {}, { size: 'large' }, { footprint: { version: 1, size: 2 } }, { size: 'huge', inventory: [{ id: 'torch-1', name: 'Факел' }] },
  { inventory: [{ catalog_id: 'srd:tinderbox' }] }, { inventory: [{ name: 'Old LANTERN' }] }, { inventory: [{ id: '', name: 'flint and steel' }] }, { inventory: [{ id: 'rope' }, null, 'torch'] },
]
const POSITIONS = [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 5.9, y: 5.2 }, { x: '3', y: '3' }, { x: 'a', y: 0 }, null, { x: 8, y: 8 }, { x: -1, y: 0 }]
const fireCases = []
for (const actor of ACTORS) {
  for (const position of POSITIONS) {
    const props = [PROPS.filter(() => random() < 0.5), PROPS, [], 'x'][Math.floor(random() * 4)]
    fireCases.push({ props: encode(props), position: encode(position), actor: encode(actor), near: m.fireSourceNear(props, position, actor) })
  }
}

const definitions = [m.igniteDefinitionFor('haystack'), m.igniteDefinitionFor('rug'), { damage: '1d6', damage_type: 'fire', rounds: 'x', save_ability: 'dex' }, { rounds: 0 }]
const burnCases = []
for (let index = 0; index < 40; index += 1) {
  const input = {
    propId: pick(['prop-1', '  p  ', null, 7, 'x'.repeat(200)]),
    commandId: pick(['cmd-1', undefined, 'c'.repeat(200)]),
    cells: pick([[{ x: 1, y: 2 }], [{ x: 1, y: 2, extra: true }, { x: 3 }], [], [null], [{ y: 1 }]]),
    definition: pick(definitions),
    sourceActorId: pick(['hero', undefined, ' hero ']),
    round: pick([1, 3, '4', null, undefined, -2, 2.5]),
  }
  let effect
  try { effect = m.burningPropEffect(input) } catch { continue }
  burnCases.push({ input: JSON.parse(JSON.stringify(input)), effect })
}

// Рассказчик: каждый проп справочника — опрокинут, устоял, поджог.
const narrationCases = []
const labelKeys = [...m.sceneHazardAssetIds(), 'rune', 'props/pillar.png', 'Statue']
for (const assetId of labelKeys) {
  const state = { scene: { map: { props: [{ id: 'p', assetId }, { id: 'q', assetId: 'campfire' }] } } }
  const batches = [
    [{ event_type: 'SceneObjectStateChanged', payload: { intent: 'topple', prop_id: 'p', success: false } }],
    [{ event_type: 'SceneObjectStateChanged', payload: { intent: 'topple', prop_id: 'p', success: true } }],
    [{ event_type: 'SceneObjectStateChanged', payload: { intent: 'topple', prop_id: 'p' } }, { event_type: 'DamageApplied', payload: { reason: 'scene-object-topple' } }],
    [{ event_type: 'SceneObjectStateChanged', payload: { intent: 'topple', prop_id: 'p' } }, { event_type: 'DamageApplied', payload: { reason: 'scene-object-topple' } }, { event_type: 'ConditionAdded', payload: { condition: 'prone' } }],
    [{ event_type: 'SceneObjectStateChanged', payload: { intent: 'ignite', prop_id: 'p', fire_source: 'prop' } }],
    [{ event_type: 'SceneObjectStateChanged', payload: { intent: 'ignite', prop_id: 'p', fire_source: 'item' } }],
  ]
  for (const events of batches) narrationCases.push({ events, state, matches: n.hasSceneHazardEvent(events), text: n.sceneHazardNarration(events, state) })
}
const odd = [
  [[], {}], [[{ event_type: 'SceneObjectStateChanged', payload: { intent: 'open' } }], {}], [[{ event_type: 'SceneObjectStateChanged', payload: { intent: 'topple', prop_id: 'nope' } }], {}],
  [[{ event_type: 'SceneObjectStateChanged', payload: { intent: ['topple'], prop_id: 'p' } }], { scene: { map: { props: [{ id: 'p', assetId: 'cart' }] } } }],
  [[null, { event_type: 'SceneObjectStateChanged', payload: { intent: 'ignite', prop_id: 5 } }], { scene: { map: { props: [{ id: 5, assetId: 'bed' }] } } }],
  [[{ event_type: 'SceneObjectStateChanged', payload: { intent: 'ignite' } }], { scene: { map: { props: [{ assetId: 'cart' }] } } }],
  [[{ event_type: 'Other', payload: { intent: 'topple' } }, { event_type: 'SceneObjectStateChanged', payload: { intent: 'topple', prop_id: 'p' } }], null],
]
for (const [events, state] of odd) narrationCases.push({ events, state, matches: n.hasSceneHazardEvent(events), text: n.sceneHazardNarration(events, state) })

writeFixture(new URL('scene-hazards.json', import.meta.url), {
  constants: {
    SCENE_SWING_POLICY_ID: m.SCENE_SWING_POLICY_ID,
    hazardIds: m.sceneHazardAssetIds(),
    fireIds: m.fireSourceAssetIds(),
    swingIds: m.swingPropAssetIds(),
    narrator: { id: n.sceneHazardNarrator.id, priority: n.sceneHazardNarrator.priority, promptVersion: n.sceneHazardNarrator.promptVersion, provider: n.sceneHazardNarrator.provider },
  },
  assets,
  cells: cellCases,
  fire: fireCases,
  burning: burnCases,
  narration: narrationCases,
})
