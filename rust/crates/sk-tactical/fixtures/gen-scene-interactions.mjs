import '../../../fixtures-env.mjs'
// Эталон server/scene-interactions.mjs для Rust:
//
//   node rust/crates/sk-tactical/fixtures/gen-scene-interactions.mjs
//
// Каталог по каждому синониму (с путями, расширениями, регистром и мусором),
// metadata пропа и выбор точек интереса на случайных наборах, определения
// объектов, находки, разбор свободного текста, ближайшая команда, расстояние
// и рассказ о взаимодействии; нормализация памяти сцены о тронутых объектах
// (`normalizeSceneInteractions` движка).
import * as m from '../../../../server/scene-interactions.mjs'
import { sceneHazardAssetIds } from '../../../../server/scene-hazards.mjs'
import { normalizeCampaignState } from '../../../../server/rules-engine.mjs'
import { attempt, encode, mulberry32, writeFixture } from './common.mjs'

// Копия `normalizeSceneInteractions` и `uniqueStrings` из rules-engine.mjs (не
// экспортируются); копия сверяется с `normalizeCampaignState` ниже.
function uniqueStrings(value) {
  return [...new Set(Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [])]
}
function normalizeSceneInteractions(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  return Object.fromEntries(Object.entries(source).slice(0, 2_000).flatMap(([propId, value]) => {
    if (!propId || !value || typeof value !== 'object' || Array.isArray(value)) return []
    return [[String(propId).slice(0, 120), {
      state: String(value.state ?? 'idle').slice(0, 40),
      inspected: value.inspected === true,
      inspection_attempted: value.inspection_attempted === true || value.inspected === true,
      inspection_attempted_by: uniqueStrings(value.inspection_attempted_by).slice(0, 120),
      opened: value.opened === true,
      taken: value.taken === true,
      used: value.used === true,
      used_by: uniqueStrings(value.used_by).slice(0, 120),
      loot_claimed: value.loot_claimed === true,
      loot_revealed: value.loot_revealed === true,
      trap_detected: value.trap_detected === true,
      lockpicked: value.lockpicked === true,
      lockpicked_by: value.lockpicked_by == null ? null : String(value.lockpicked_by).slice(0, 120),
      knowledge_ids: uniqueStrings(value.knowledge_ids).slice(0, 24),
      last_actor_id: value.last_actor_id == null ? null : String(value.last_actor_id).slice(0, 120),
    }]]
  }))
}

const random = mulberry32(2026_10_15)
const pick = (items) => items[Math.floor(random() * items.length)]
const chance = (p) => random() < p

const catalogIds = m.sceneInteractionAssetIds()
const ruKeys = ['chest', 'chandelier', 'royal_throne', 'milestone', 'wardrobe', 'bar_shelf', 'prayer_bench', 'temple_banner']
const keys = [...new Set([...catalogIds, ...ruKeys, ...sceneHazardAssetIds(), 'stairs_up', 'trapdoor', 'chair', 'mug', 'well', 'torch_wall', ''])]
const assetIds = [
  ...keys,
  ...keys.map((key) => `props/${key}.png`),
  ...keys.map((key) => `${key}_small`),
  ...keys.map((key) => `old-${key}-2`),
  ...keys.map((key) => key.toUpperCase()),
  ...keys.map((key) => `  ${key}  `),
  ...keys.map((key) => `x${key}`),
  'barrel_stack', 'crate_stack', 'table_round', 'table_long', 'bedroll', 'stable', 'tables', 'bar_shelf_left', 'shelf', 'a/b/', '/', 'Bookshelf',
  'x'.repeat(118) + 'chest', 'x'.repeat(115) + '/chest', null, undefined, 5, ['bookshelf'], ['a', 'chest'], { id: 'bookshelf' }, true,
]
const assets = assetIds.map((assetId) => ({
  assetId: encode(assetId),
  shrine: m.isSceneShrineAsset(assetId),
  shrineVerbs: m.sceneShrineVerbsFor(assetId),
  label: m.sceneObjectLabelFor(assetId),
  catalog: encode(m.sceneInteractionCatalogEntry(assetId)),
}))

const seeds = ['', 'seed-1', 'карта-7', '  spaced  ', 'metadata-seed', 'x'.repeat(170), 'container-12']
const ids = () => pick(['prop-1', 'prop-2', 'chest-a', '  spaced id ', '', '   ', 'дверь', 'p'.repeat(130), 7, null, undefined, 'prop-3', 'prop-4', 'id-' + Math.floor(random() * 40)])
const assetPool = [...catalogIds, ...catalogIds.map((key) => `props/${key}.png`), 'chair', 'mug', 'stairs_up', 'barrel_stack', null, 'table_round', 'altar']
const randomProp = () => {
  const prop = {}
  const id = ids()
  if (id !== undefined) prop.id = id
  const assetId = pick(assetPool)
  if (assetId !== undefined) prop.assetId = assetId
  if (chance(0.7)) prop.x = Math.floor(random() * 12) + (chance(0.5) ? 0.5 : 0)
  if (chance(0.7)) prop.y = Math.floor(random() * 12) + 0.5
  if (chance(0.5)) {
    const count = Math.floor(random() * 3)
    prop.footprint = Array.from({ length: count }, () => ({ x: Math.floor(random() * 12), y: Math.floor(random() * 12) }))
    if (chance(0.1)) prop.footprint.push({ x: 'a', y: 2 })
  }
  if (chance(0.2)) prop.interaction = { kind: 'forged', verbs: ['steal'], pointOfInterest: true, detailKey: 'secret', rewardKey: 'wish' }
  return prop
}

const metadataForProp = []
for (let index = 0; index < 600; index += 1) {
  const mapSeed = pick(seeds)
  const prop = chance(0.05) ? pick([null, undefined, 'chest', 5]) : randomProp()
  const pointOfInterest = chance(0.5)
  metadataForProp.push({ mapSeed, prop: encode(prop), pointOfInterest, result: encode(m.interactionMetadataForProp({ mapSeed, prop, pointOfInterest })) })
}

const lists = []
for (let index = 0; index < 300; index += 1) {
  const mapSeed = pick(seeds)
  const count = Math.floor(random() * 16)
  const props = Array.from({ length: count }, () => (chance(0.03) ? pick([null, 4, 'x']) : randomProp()))
  const metadata = [...m.sceneInteractionMetadata({ mapSeed, props })].map(([id, value]) => [id, value])
  const propIds = [...props.slice(0, 4).map((prop) => prop?.id), 'нет-такого', '', '  prop-1 ']
  const definitions = propIds.map((propId) => ({ propId: encode(propId), result: encode(m.sceneInteractionDefinition({ mapSeed, props, propId })) }))
  lists.push({ mapSeed, props, metadata, definitions })
}

const loot = []
for (let index = 0; index < 120; index += 1) {
  const mapSeed = pick(seeds)
  const prop = chance(0.05) ? null : randomProp()
  loot.push({ mapSeed, prop, ...attempt(() => m.sceneObjectLoot({ mapSeed, prop })) })
}

const verbs = ['помолиться', 'помолюсь у', 'вознести молитву у', 'вознёс молитву', 'преклонить колени перед', 'отмычкой вскрыть', 'вскрыть замок', 'взломать замок', 'поковырять в замке', 'подобрать ключ к',
  'взять', 'забрать', 'поднять', 'обыскать', 'использовать', 'активировать', 'отдохнуть у', 'привал у', 'открыть', 'разбить', 'сломать', 'взломать', 'выломать', 'осмотреть', 'изучить',
  'прочитать', 'проверить', 'посмотреть на', 'ударить топором', 'пнуть', 'Разбить', 'ОСМОТРЕТЬ']
const objects = ['бочку', 'сундук', 'ларец', 'алтарь', 'статую', 'костёр', 'очаг', 'полку', 'книги', 'стол', 'трон', 'кости', 'останки', 'могилу', 'буфет', 'гардероб', 'стойку', 'полка за стойкой',
  'дверь', 'ворота', 'рычаг', 'люк', 'окно', 'лестницу', 'мост', 'стену', 'арку', 'проход', 'дверцу', 'ящик', 'нишу', 'ковёр', 'скамью', 'молитвенная скамья', 'жаровню', '']
const tails = ['', ' топором', ' осторожно', ', что там творится', ' и открыть запертую дверь башни', ' плечом']
const texts = [
  'Разбить бочку топором', 'Осмотреть стол', 'Открыть ящик', 'посмотреть, что там творится', 'привести в действие рычаг и открыть запертую дверь башни', 'Открыть', 'помолюсь', '', '   ', null, undefined, 42,
  'вскрыть замок отмычкой', 'молитва', 'Помолиться у алтаря и осмотреть изваяние', 'смотрю, кто пытается их открыть',
]
for (let index = 0; index < 900; index += 1) texts.push(`${pick(verbs)} ${pick(objects)}${pick(tails)}`.trim())
const operations = texts.map((text) => ({ text: encode(text), result: encode(m.sceneObjectOperationFromText(text)) }))

const nearest = []
const nearProp = (at) => {
  const prop = randomProp()
  if (chance(0.7)) {
    prop.x = at.x + Math.floor(random() * 3) - 1 + 0.5
    prop.y = at.y + Math.floor(random() * 3) - 1 + 0.5
    if (prop.footprint) prop.footprint = [{ x: Math.floor(prop.x), y: Math.floor(prop.y) }]
  }
  return prop
}
for (let index = 0; index < 1400; index += 1) {
  const count = Math.floor(random() * 8)
  const at = { x: Math.floor(random() * 12), y: Math.floor(random() * 12) }
  const props = Array.from({ length: count }, () => nearProp(at))
  const actorPosition = chance(0.1) ? pick([null, { x: 1.5, y: 2 }, { x: '3', y: '4' }, {}]) : at
  const words = { barrel: 'бочку', chest: 'сундук', altar: 'алтарь', table: 'стол', bookshelf: 'книги', campfire: 'костёр', bones: 'кости', crate: 'ящик', statue: 'статую', grave: 'могилу' }
  const bare = (assetId) => assetId.replace(/^props\//u, '').replace(/\.png$/u, '')
  const named = props.find((prop) => typeof prop.assetId === 'string' && Object.hasOwn(words, bare(prop.assetId)))
  const crafted = named ? `${pick(verbs)} ${words[bare(named.assetId)]}` : pick(['Открыть', 'осмотреть', 'взять', 'помолиться', 'вскрыть замок', 'использовать'])
  const text = chance(0.5) ? crafted : chance(0.8) ? pick(texts) : pick([null, '', 'привет'])
  const propsArg = chance(0.03) ? 'не массив' : props
  nearest.push({ props: propsArg, actorPosition: encode(actorPosition), text: encode(text), result: encode(m.nearestSceneObjectCommand({ props: propsArg, actorPosition, text })) })
}

const distances = []
for (let index = 0; index < 300; index += 1) {
  const prop = chance(0.05) ? pick([null, 3, {}]) : randomProp()
  const actorPosition = chance(0.1) ? pick([null, { x: 1.5, y: 2 }, { x: '3', y: '4' }, {}, { x: null, y: 0 }]) : { x: Math.floor(random() * 12), y: Math.floor(random() * 12) }
  const distance = m.sceneObjectDistance(prop, actorPosition)
  distances.push({ prop: encode(prop), actorPosition: encode(actorPosition), distance: Number.isFinite(distance) ? distance : 'Infinity' })
}

const eventPool = [
  { event_type: 'LockpickNoticed', payload: { reason: 'trace' } },
  { event_type: 'LockpickNoticed', payload: { severity: 'major' } },
  { event_type: 'LockpickNoticed', payload: {} },
  { event_type: 'SceneObjectKnowledgeRevealed', payload: { text: '  Тайна раскрыта.  ' } },
  { event_type: 'SceneObjectKnowledgeRevealed', payload: { text: '' } },
  { event_type: 'SceneObjectLootGranted', payload: { loot: [{ name: 'Кинжал' }, { name: '  ' }, { name: 'Факел' }] } },
  { event_type: 'SceneObjectLootGranted', payload: { loot: 'нет' } },
  { event_type: 'DamageApplied', payload: { reason: 'scene-object-trap', applied_amount: 3 } },
  { event_type: 'DamageApplied', payload: { reason: 'scene-object-trap', applied_amount: -2 } },
  { event_type: 'DamageApplied', payload: { reason: 'scene-object-trap', applied_amount: 'много' } },
  { event_type: 'DamageApplied', payload: { reason: 'attack', applied_amount: 3 } },
  { event_type: 'SceneObjectLootRevealed', payload: { loot: [{ name: 'Монеты' }] } },
  { event_type: 'SceneObjectLootRevealed', payload: { loot: [] } },
  { event_type: 'RestCompleted', payload: { source_prop_id: 'campfire-1' } },
  { event_type: 'RestCompleted', payload: {} },
  { event_type: 'SceneObjectStateChanged', payload: { success: false, intent: 'lockpick' } },
  { event_type: 'SceneObjectStateChanged', payload: { success: false, intent: 'open' } },
  { event_type: 'SceneObjectStateChanged', payload: { state: 'open', intent: 'lockpick' } },
  { event_type: 'SceneObjectStateChanged', payload: { state: 'open' } },
  { event_type: 'SceneObjectStateChanged', payload: { state: 'taken' } },
  { event_type: 'SceneObjectStateChanged', payload: { state: 'used' } },
  { event_type: 'SceneObjectStateChanged', payload: { state: 'idle' } },
  { event_type: 'SceneObjectInspected', payload: { success: false } },
  { event_type: 'SceneObjectInspected', payload: { success: true } },
  { event_type: 'SceneObjectSomething', payload: {} },
  { event_type: 'ActorMoved', payload: {} },
  null,
  { event_type: 5 },
]
const narration = []
for (let index = 0; index < 400; index += 1) {
  const count = Math.floor(random() * 4)
  const events = Array.from({ length: count }, () => pick(eventPool))
  const argument = chance(0.03) ? pick([null, undefined, 'x']) : events
  narration.push({ events: encode(argument), text: m.sceneInteractionNarration(argument) })
}

const entryPool = [
  { state: 'open', opened: true, used_by: ['hero', ' hero ', '', null, 5, 'mage'], knowledge_ids: ['k1', 'k1', 'k2'] },
  { inspected: true, inspection_attempted_by: 'hero', lockpicked: true, lockpicked_by: 7, last_actor_id: '  hero  ' },
  { state: null, taken: 'yes', loot_claimed: true, trap_detected: true, last_actor_id: null },
  { state: 'x'.repeat(60), used: true, knowledge_ids: Array.from({ length: 30 }, (_, index) => 'k' + index) },
  {}, null, [], 'x', 5,
]
const keyPool = ['prop-1', 'prop-2', '', '10', '2', 'p'.repeat(130), 'p'.repeat(125), '__proto__', 'constructor', 'chest-a']
const normalize = []
for (let index = 0; index < 200; index += 1) {
  const input = chance(0.05) ? pick([null, undefined, [], 'x']) : Object.fromEntries(Array.from({ length: Math.floor(random() * 6) }, () => [pick(keyPool), pick(entryPool)]))
  normalize.push({ input: encode(input), result: normalizeSceneInteractions(input) })
}
for (const sample of normalize.slice(0, 40)) {
  const input = sample.input === encode(undefined) ? undefined : sample.input
  const checked = normalizeCampaignState({ sessionCode: 'N', players: [], mechanics: { scene_interactions: input } }).mechanics.scene_interactions
  if (JSON.stringify(checked) !== JSON.stringify(sample.result)) throw new Error('копия normalizeSceneInteractions разошлась с движком')
}

writeFixture(new URL('./scene-interactions.json', import.meta.url), {
  normalize,
  policyId: m.SCENE_INTERACTION_POLICY_ID,
  assetIds: m.sceneInteractionAssetIds(),
  fallbackAssets: m.sceneInteractionFallbackAssets(),
  rewardKinds: m.sceneInteractionRewardKinds(),
  assets,
  metadataForProp,
  lists,
  loot,
  operations,
  nearest,
  distances,
  narration,
})
