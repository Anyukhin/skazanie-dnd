import '../../../fixtures-env.mjs'
// Эталон server/agent-context.mjs для Rust (`sk-encounters`, модуль `agent_context`):
//
//   node rust/crates/sk-encounters/fixtures/gen-agent-context.mjs [каталог корпуса]
//
// Каталог корпуса по умолчанию — `SK_AGENT_CONTEXT_CORPUS` или
// `C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1` (если есть).
//
// Состояния:
//
// - из `test/agent-context*.test.mjs`: зал с семнадцатью столами, пустая и
//   испорченная карта, причал со сводкой поля, обещание карты мира, замысел
//   кампании;
// - корпус паритета (`states/*.json`): выборка с картой и без, с программой
//   сцены, жителями, летописью, врагами; состояние сведено к полям, которые
//   читает модуль, и сведённое обязано давать те же ответы, что полное;
// - сцены генератора (`generateSceneGeometry`) по местам и программам корпуса:
//   отряд на точках входа, враги и жители на своих точках, программа сцены;
// - правки этих состояний заплатками (путь и значение): имена и тексты с
//   NFKC и пробелами, ОЗ и состояния, ключи прототипа, программа сцены с
//   отсутствующим, канон, летопись, карта мира, замысел кампании.
//
// Карта сцены (`scene.map`) и крупные поддеревья состояния (`BLOB_KEYS`)
// хранятся один раз в `maps`, состояние ссылается на них `{"$map": индекс}`.
// Крупный ответ — SHA-256 строки `JSON.stringify`. Раздел `math` — побитная
// сверка `Math.atan2`/`Math.hypot` (против `sk_core::v8math`).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

const root = new URL('../../../../', import.meta.url)
const A = await import(new URL('server/agent-context.mjs', root).href)
const T = await import(new URL('server/tactical-map.mjs', root).href)
const { normalizeCampaignState } = await import(new URL('server/rules-engine.mjs', root).href)
const { generateSceneGeometry } = await import(new URL('server/adventure-director.mjs', root).href)
const R = await import(new URL('server/scene-requirements.mjs', root).href)

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(2026_10_15)
const int = (n) => Math.floor(random() * n)
const pick = (items) => items[int(items.length)]
const chance = (p) => random() < p

const UNDEFINED = '\u0000undefined'
const encode = (value) => (value === undefined ? UNDEFINED : value)
const decode = (value) => (value === UNDEFINED ? undefined : value)
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const asJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

/** Ответ функции: малый — целиком, крупный — хешем. */
function outcome(fn) {
  try {
    const value = fn()
    if (value === undefined) return { result: UNDEFINED }
    const text = JSON.stringify(value)
    return text.length > 600 ? { hash: sha(value) } : { result: JSON.parse(text) }
  } catch (error) {
    return { error: { name: error?.name ?? 'Error', message: String(error?.message ?? error) } }
  }
}

// --- состояния и карты ---------------------------------------------------------

const maps = []
const mapIndex = new Map()
const states = []
const stateIndex = new Map()

/** Крупное поддерево — одной записью в `maps`, на месте — `{"$map": индекс}`. */
function blobOf(value) {
  const key = JSON.stringify(value)
  if (!mapIndex.has(key)) {
    maps.push(value)
    mapIndex.set(key, maps.length - 1)
  }
  return { $map: mapIndex.get(key) }
}
const BLOB_KEYS = ['worldMemory', 'campaignConcept', 'campaign_concept', 'worldMap', 'social', 'npc_world', 'messages', 'players', 'enemies', 'mechanics']

/** Состояние с картой и крупными поддеревьями ссылками. */
function addState(state) {
  const copy = asJson(state)
  if (copy?.scene && copy.scene.map && typeof copy.scene.map === 'object') copy.scene.map = blobOf(copy.scene.map)
  for (const key of BLOB_KEYS) {
    if (copy && typeof copy === 'object' && Object.hasOwn(copy, key) && JSON.stringify(copy[key]).length > 400) copy[key] = blobOf(copy[key])
  }
  const key = JSON.stringify(copy)
  if (!stateIndex.has(key)) {
    states.push(copy)
    stateIndex.set(key, states.length - 1)
  }
  return stateIndex.get(key)
}

/** Состояние из таблицы с подставленными поддеревьями. */
function stateAt(index) {
  const copy = asJson(states[index])
  if (copy?.scene?.map?.$map != null) copy.scene.map = asJson(maps[copy.scene.map.$map])
  for (const key of BLOB_KEYS) if (copy?.[key]?.$map != null) copy[key] = asJson(maps[copy[key].$map])
  return copy
}

const pickKeys = (object, keys) => {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return object
  const result = {}
  for (const key of keys) if (Object.hasOwn(object, key)) result[key] = object[key]
  return result
}
const mapArray = (value, fn) => (Array.isArray(value) ? value.map(fn) : value)

/** Состояние, сведённое к полям, которые читает `server/agent-context.mjs`. */
function reduceState(state) {
  if (!state || typeof state !== 'object') return state
  const reduced = pickKeys(state, ['sessionCode', 'campaign_id', 'campaignId', 'state_version', 'stateVersion', 'version', 'activePlayerId', 'campaignConcept', 'campaign_concept'])
  if (Object.hasOwn(state, 'campaign')) reduced.campaign = pickKeys(state.campaign, ['id'])
  if (Object.hasOwn(state, 'scene')) reduced.scene = pickKeys(state.scene, ['title', 'location', 'mood', 'objective', 'theme', 'scene_kind', 'layout', 'map', 'map_requirements', 'location_id'])
  if (Object.hasOwn(state, 'worldMap')) {
    reduced.worldMap = pickKeys(state.worldMap, ['currentLocationId', 'locations'])
    if (Object.hasOwn(reduced.worldMap ?? {}, 'locations')) reduced.worldMap.locations = mapArray(reduced.worldMap.locations, (entry) => pickKeys(entry, ['id', 'name', 'summary', 'known']))
  }
  if (Object.hasOwn(state, 'worldMemory')) {
    reduced.worldMemory = pickKeys(state.worldMemory, ['facts', 'knowledge_ledger', 'knowledge_revealed'])
    if (Object.hasOwn(reduced.worldMemory ?? {}, 'facts')) {
      // Закрытый факт модуль читает только через летопись знаний героя
      // (`knowledgeGateVisible`); прочие закрытые факты ни на что не влияют.
      const ledger = new Set([...(reduced.worldMemory.knowledge_ledger ?? []), ...(reduced.worldMemory.knowledge_revealed ?? [])].map((entry) => entry?.fact_id))
      const facts = Array.isArray(reduced.worldMemory.facts)
        ? reduced.worldMemory.facts.filter((fact) => fact?.predicate === 'scene_canon' || ['party', 'public'].includes(String(fact?.visibility)) || ledger.has(fact?.id))
        : reduced.worldMemory.facts
      reduced.worldMemory.facts = mapArray(facts, (fact) => pickKeys(fact, ['id', 'subject_id', 'predicate', 'status', 'visibility', 'summary', 'recorded_at_minutes', 'source_event_ids']))
    }
  }
  if (Object.hasOwn(state, 'players')) reduced.players = mapArray(state.players, (entry) => pickKeys(entry, ['id', 'character', 'name', 'hp', 'maxHp', 'max_hp', 'alive', 'healthStatus', 'x', 'y', 'role', 'characterClass', 'species', 'background', 'backstory', 'bonds', 'ideals']))
  if (Object.hasOwn(state, 'actors')) reduced.actors = mapArray(state.actors, (entry) => pickKeys(entry, ['id', 'x', 'y']))
  if (Object.hasOwn(state, 'enemies')) reduced.enemies = mapArray(state.enemies, (entry) => pickKeys(entry, ['id', 'name', 'hp', 'maxHp', 'max_hp', 'alive', 'healthStatus', 'x', 'y']))
  if (Object.hasOwn(state, 'mechanics')) {
    reduced.mechanics = pickKeys(state.mechanics, ['positions', 'death', 'combat'])
    if (Object.hasOwn(reduced.mechanics ?? {}, 'death')) reduced.mechanics.death = pickKeys(reduced.mechanics.death, ['heroes'])
    if (Object.hasOwn(reduced.mechanics ?? {}, 'combat')) reduced.mechanics.combat = pickKeys(reduced.mechanics.combat, ['active'])
  }
  if (Object.hasOwn(state, 'npc_world')) {
    reduced.npc_world = pickKeys(state.npc_world, ['placements'])
    if (Object.hasOwn(reduced.npc_world ?? {}, 'placements')) reduced.npc_world.placements = mapArray(reduced.npc_world.placements, (entry) => pickKeys(entry, ['npc_id', 'location_id', 'x', 'y']))
  }
  if (Object.hasOwn(state, 'social')) {
    reduced.social = pickKeys(state.social, ['npcs', 'conversations'])
    if (Object.hasOwn(reduced.social ?? {}, 'npcs')) reduced.social.npcs = mapArray(reduced.social.npcs, (entry) => pickKeys(entry, ['id', 'name', 'role', 'available']))
    if (Object.hasOwn(reduced.social ?? {}, 'conversations')) reduced.social.conversations = mapArray(reduced.social.conversations, (entry) => pickKeys(entry, ['npc_id']))
  }
  if (Object.hasOwn(state, 'messages')) reduced.messages = mapArray(state.messages, (entry) => pickKeys(entry, ['text', 'knowledge_gate']))
  if (Object.hasOwn(state, 'adventure')) reduced.adventure = pickKeys(state.adventure, ['chapter'])
  return asJson(reduced)
}

// --- случаи ------------------------------------------------------------------

const cases = []

const VIEWERS = [undefined, { isPartyMember: true }, { isPartyMember: false }, { role: 'admin' }, { isAdmin: true }, { playerId: 'hero', isPartyMember: true }]
const OPTIONS = [
  undefined,
  { role: 'narrator', actorId: 'hero', targetId: 'npc-1', contractVersion: 'narrator/v13' },
  { role: '  scene\tcontext  ', actorId: '   ', targetId: null, contractVersion: 'x'.repeat(90) },
  { role: '', actorId: 5, contractVersion: 'ﬁ-v1' },
  { role: null, actorId: 'Ａ'.repeat(130) },
]

/** Вызовы модуля на одном состоянии (по индексу таблицы). */
function casesFor(index, label, { actors = null, heroes = null, npcs = null, deep = true } = {}) {
  const state = stateAt(index)
  const playerIds = (Array.isArray(state?.players) ? state.players : []).map((player) => player?.id).filter((id) => id != null).slice(0, 3)
  const actorList = actors ?? [...playerIds.slice(0, 2), '', undefined, 'stranger']
  for (const actor of actorList) cases.push({ fn: 'sceneContextForAgent', label, state: index, actor: encode(actor), out: outcome(() => A.sceneContextForAgent(stateAt(index), actor)) })
  cases.push({ fn: 'fieldSummaryFor', label, state: index, out: outcome(() => A.fieldSummaryFor(stateAt(index))) })
  if (!deep) return
  for (const hero of heroes ?? [...playerIds, '', 'nobody']) cases.push({ fn: 'heroCardForAgent', label, state: index, actor: encode(hero), out: outcome(() => A.heroCardForAgent(stateAt(index), hero)) })
  for (const viewer of pick([VIEWERS.slice(0, 2), VIEWERS.slice(2, 4), VIEWERS.slice(4)])) cases.push({ fn: 'campaignConceptForAgent', label, state: index, viewer: encode(viewer), out: outcome(() => A.campaignConceptForAgent(stateAt(index), viewer)) })
  cases.push({ fn: 'sceneCanonFor', label, state: index, out: outcome(() => A.sceneCanonFor(stateAt(index))) })
  const npcList = npcs ?? (Array.isArray(state?.social?.npcs) ? state.social.npcs.slice(0, 3) : [])
  for (const npc of npcList) cases.push({ fn: 'npcKnownByName', label, state: index, npc, out: outcome(() => A.npcKnownByName(stateAt(index), npc)) })
  const options = pick(OPTIONS)
  cases.push({ fn: 'agentContextMetadata', label, state: index, options: encode(options), out: outcome(() => A.agentContextMetadata(stateAt(index), options)) })
}

// 1. Состояния тестов модуля.
function hallState({ props = true } = {}) {
  const map = T.createTacticalMap({ width: 20, height: 2, locationId: 'hall', seed: 'agent-context', fill: { passable: true, revealed: true, material: 'stone' } })
  T.addZone(map, { id: 'hall', label: 'Зал', kind: 'interior' })
  if (props) for (let index = 0; index < 17; index += 1) {
    T.addProp(map, { id: `table-${index}`, assetId: 'table_long', x: index + 0.5, y: 0.5, footprint: [{ x: index, y: 0 }], ...(index === 16 ? { visibility: 'gm_only' } : {}) })
  }
  return {
    sessionCode: 'CONTEXT-1', state_version: 7,
    scene: { title: 'Зал', location: 'Зал', location_id: 'hall', map: T.serializeTacticalMap(map) },
    players: [{ id: 'hero', character: 'Ада', x: 0, y: 0 }],
    mechanics: { positions: { hero: { x: 0, y: 0 } } },
  }
}
function pierState() {
  const map = T.createTacticalMap({ width: 6, height: 3, locationId: 'pier', seed: 'field', sizeClass: 'arena' })
  T.addZone(map, { id: 'pier', kind: 'exterior', material: 'wood', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Причал' })
  T.addZone(map, { id: 'hall', kind: 'interior', material: 'wood', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Общий зал' })
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 6; x += 1) T.setCell(map, x, y, { passable: true, revealed: x < 5, zone: x < 3 ? 'pier' : 'hall' })
  return normalizeCampaignState({
    scene: { title: 'Причал', location: 'Серый Причал', location_id: 'pier', map: T.serializeTacticalMap(map) },
    players: [{ id: 'mirel', character: 'Мирель', hp: 20, maxHp: 20, x: 0, y: 1 }, { id: 'borin', character: 'Борин', hp: 9, maxHp: 31, x: 1, y: 1 }],
    enemies: [{ id: 'cult', name: 'Культист 1', hp: 3, maxHp: 9, alive: true, x: 2, y: 1 }, { id: 'hidden', name: 'Культист 2', hp: 9, maxHp: 9, alive: true, x: 5, y: 1 }],
    mechanics: { combat: { active: true }, positions: { mirel: { x: 0, y: 1 }, borin: { x: 1, y: 1 }, cult: { x: 2, y: 1 }, hidden: { x: 5, y: 1 } } },
  })
}
const testStates = [
  ['hall', hallState()],
  ['hall-empty', hallState({ props: false })],
  ['broken-map', { scene: { title: 'Зал', map: { width: 3, height: 3, layers: { present: 'broken' } } } }],
  ['place', { scene: { title: 'Свет над скалой', location: 'Заброшенный маяк' }, worldMap: { currentLocationId: 'lh', locations: [{ id: 'lh', name: 'Заброшенный маяк', summary: 'Маяк на скале, чей свет вновь замечают по ночам.', known: true }] } }],
  ['place-none', { scene: { title: 'Свет над скалой', location: 'Заброшенный маяк' } }],
  ['pier', pierState()],
  ['concept', { campaignConcept: { preset: 'Frontier', tone: 'Hopeful mystery', premise: 'A vanished road returns each new moon.', boundaries: 'No sexual violence; fade to black.', themes: 'memory, duty', private_solution: 'The road is a dragon.' }, secretGmNotes: 'Never expose this.' }],
  ['arcs', { adventure: { chapter: 1 }, campaignConcept: { arc: { arc_number: 5 }, arc_history: Array.from({ length: 4 }, (_, index) => ({ arc_number: index + 1, title: `Арка ${index + 1}`, epilogue: `${'Итог '.repeat(300)}${index + 1}`, private_solution: 'не передавать' })) } }],
  ['world', { campaignConcept: { world_template_id: 'league-nine-tides', world_template_version: '1.0.0', worldSummary: 'Лига островов живёт по картам прилива.', worldHistory: `${'Старая дамба помнит бурю. '.repeat(200)}конец`, factions: [{ id: 'dam-keepers', name: 'Смотрители дамб', summary: 'Чинят берег и хранят правду.', goal: 'Не дать морю забрать города.', private_solution: 'не передавать' }], story_arcs: [{ title: 'Город под водой', levels: '1–4', summary: 'Экспедиция в затонувшие кварталы.', stakes: 'Будущее побережья.' }] } }],
  ['empty', {}],
]
const baseStates = []
for (const [label, state] of testStates) {
  const index = addState(state)
  baseStates.push(index)
  casesFor(index, `test:${label}`, { actors: ['hero', 'borin', 'mirel', '', undefined] })
}

// 2. Корпус.
const corpusDir = process.argv[2] ?? process.env.SK_AGENT_CONTEXT_CORPUS ?? 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'
let corpusStates = 0
let corpusDropped = 0
if (existsSync(join(corpusDir, 'states'))) {
  const files = readdirSync(join(corpusDir, 'states')).filter((name) => name.endsWith('.json')).sort()
  const MAP_BUDGET = 2_200_000
  let mapBytes = 0
  const chosen = []
  const want = (state) => (state?.scene?.map_requirements ? 6 : 0) + (state?.npc_world?.placements?.length ? 3 : 0) + (state?.enemies?.length ? 1 : 0)
    + (state?.messages?.length ? 2 : 0) + (state?.worldMemory?.facts?.length ? 1 : 0) + (state?.campaignConcept ? 1 : 0)
  for (const [index, file] of files.entries()) {
    const priority = index % 7 === 0
    const text = readFileSync(join(corpusDir, 'states', file), 'utf8')
    const state = JSON.parse(text)
    const score = want(state)
    if (!priority && score < 4) continue
    const map = state?.scene?.map
    const size = map && typeof map === 'object' ? JSON.stringify(map).length : 0
    const known = map && typeof map === 'object' && mapIndex.has(JSON.stringify(map))
    if (size > 140_000 || (!known && mapBytes + size > MAP_BUDGET)) continue
    const reduced = reduceState(state)
    // Сведённое состояние обязано отвечать как полное.
    const actor = Array.isArray(state.players) ? state.players[0]?.id : undefined
    const sameReduced = [
      [() => A.sceneContextForAgent(state, actor), () => A.sceneContextForAgent(asJson(reduced), actor)],
      [() => A.fieldSummaryFor(state), () => A.fieldSummaryFor(asJson(reduced))],
      [() => A.heroCardForAgent(state, actor), () => A.heroCardForAgent(asJson(reduced), actor)],
      [() => A.campaignConceptForAgent(state), () => A.campaignConceptForAgent(asJson(reduced))],
      [() => A.campaignConceptForAgent(state, { isPartyMember: false }), () => A.campaignConceptForAgent(asJson(reduced), { isPartyMember: false })],
      [() => A.campaignConceptForAgent(state, { playerId: 'hero', isPartyMember: false }), () => A.campaignConceptForAgent(asJson(reduced), { playerId: 'hero', isPartyMember: false })],
      [() => A.sceneContextForAgent(state, ''), () => A.sceneContextForAgent(asJson(reduced), '')],
      ...(Array.isArray(state.social?.npcs) ? state.social.npcs.slice(0, 3) : []).map((npc) => [() => A.npcKnownByName(state, npc), () => A.npcKnownByName(asJson(reduced), npc)]),
      [() => A.sceneCanonFor(state), () => A.sceneCanonFor(asJson(reduced))],
    ].every(([full, small]) => isDeepStrictEqual(outcome(full), outcome(small)))
    if (!sameReduced) {
      corpusDropped += 1
      continue
    }
    if (!known) mapBytes += size
    chosen.push({ file, index: addState(reduced) })
    if (chosen.length >= 380) break
  }
  for (const { file, index } of chosen) casesFor(index, `corpus:${file.slice(0, 16)}`, { deep: true })
  corpusStates = chosen.length
  for (const { index } of chosen) baseStates.push(index)
  console.log(`  корпус: ${corpusStates} состояний (отброшено ${corpusDropped}), карт ${maps.length}, ${mapBytes} байт карт`)
} else {
  console.log(`  корпуса нет: ${corpusDir}`)
}

// 3. Сцены генератора.
const locations = ['Таверна', 'Храм', 'Склеп', 'Пещера', 'Тёмный лес', 'Деревня', 'Замок', 'Порт', 'Рынок', 'Руины']
const generatorInputs = locations.map((location) => ({ location, seed: `ctx:${location}` }))
const programCorpus = JSON.parse(readFileSync(new URL('test/fixtures/scene-programs/corpus.json', root), 'utf8'))
for (const scene of programCorpus.scenes.slice(0, 12)) {
  const program = R.sceneMapRequirementsFor([scene.location, scene.text], { npcs: scene.npcs })
  generatorInputs.push({ location: scene.location, theme: scene.theme, settlementType: scene.settlementType ?? '', requirements: program?.items ?? [], program, seed: `ctx-corpus:${scene.id}`, text: scene.text })
}
for (const input of generatorInputs) {
  let built
  try {
    built = generateSceneGeometry({ ...input, useLibrary: false })
  } catch {
    continue
  }
  const map = built.map
  const party = map.spawnPoints.filter((point) => point.role === 'party')
  const foes = map.spawnPoints.filter((point) => point.role === 'enemy')
  const neutral = map.spawnPoints.filter((point) => point.role === 'neutral')
  const players = party.slice(0, 3).map((point, index) => ({ id: `hero-${index + 1}`, character: ['Мира', 'Борин', 'Тень'][index], hp: [20, 9, 0][index], maxHp: 20, x: point.x, y: point.y }))
  const enemies = foes.slice(0, 3).map((point, index) => ({ id: `foe-${index + 1}`, name: `Разбойник ${index + 1}`, hp: 5 + index, maxHp: 11, alive: true, x: point.x, y: point.y }))
  const npcs = neutral.slice(0, 3).map((point, index) => ({ id: `npc-${index + 1}`, name: ['Орен Фаль', 'Марта', 'Ёж'][index], role: ['трактирщик', 'служанка', 'нищий'][index] }))
  const program = input.program ?? R.sceneMapRequirementsFor([input.location, `Здесь стол, сундук и алтарь у колодца`])
  const state = {
    sessionCode: `CTX-${input.seed}`, state_version: 3,
    scene: { title: input.location, location: input.location, location_id: map.locationId || input.seed, objective: 'Осмотреться', mood: 'тревожно', map: T.serializeTacticalMap(map), ...(program ? { map_requirements: program } : {}) },
    players,
    enemies,
    mechanics: { combat: { active: false }, positions: Object.fromEntries([...players, ...enemies].map((actor) => [actor.id, { x: actor.x, y: actor.y }])) },
    social: { npcs, conversations: npcs.length ? [{ npc_id: 'npc-1' }] : [] },
    npc_world: { placements: neutral.slice(0, 3).map((point, index) => ({ npc_id: `npc-${index + 1}`, location_id: map.locationId || input.seed, x: point.x, y: point.y })) },
    messages: [{ text: 'Марта кивает вам из-за стойки.' }],
    worldMemory: { facts: [{ id: 'canon-1', predicate: 'scene_canon', visibility: 'party', summary: `  В ${input.location}  ночью тихо.  ` }] },
  }
  const index = addState(state)
  baseStates.push(index)
  casesFor(index, `generated:${input.seed}`)
}

// 4. Заплатки.
function setPath(target, path, value) {
  let current = target
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]
    const nextKey = path[index + 1]
    let child = current[key]
    if (!child || typeof child !== 'object' || (typeof nextKey === 'number') !== Array.isArray(child)) {
      child = typeof nextKey === 'number' ? [] : {}
      if (Array.isArray(current) && key === current.length) current.push(child)
      else current[key] = child
    }
    current = child
  }
  const last = path.at(-1)
  if (value === undefined) {
    if (Array.isArray(current)) current.splice(last, 1)
    else delete current[last]
  } else if (Array.isArray(current) && last === current.length) current.push(value)
  else current[last] = value
}

const TEXTS = ['', '   ', 'Зал', '  Старый   зал  ', 'ﬁнал ｆｕｌｌ', 'Ё'.repeat(320), '😀 улица', 5, null, 'a\tb\nc', 'Заброшенный маяк', 'Свет над скалой. Ещё. И ещё!  Конец? Нет… да. ']
const NAMES = ['Мирель', 'Борин', 'Орен Фаль', 'Ёжик Ёлкин', 'Ли', 'Ада Лавлейс', '', '   ', null, 7, '  Марта  Вдова ', 'Ëлка']
const HEALTH = ['unharmed', 'wounded', 'bloodied', 'critical', 'defeated', 'constructor', '__proto__', 'toString', 'unknown', null]
const KIND_IDS = [...R.SCENE_REQUIREMENT_KINDS.map((kind) => kind.id), 'нет-такого']
const STRUCTURES = R.SCENE_STRUCTURE_KINDS.map((kind) => kind.id)
const ACTORS = ['hero', 'hero-1', 'hero-2', 'borin', 'mirel', 'npc-1', '', undefined, 'constructor', '__proto__', 5]
const coordinate = () => pick([0, 1, 2, 3, 5, 8, 12, 2.5, -1, '3', null, undefined, 'x'])
const position = () => {
  const value = {}
  const x = coordinate()
  const y = coordinate()
  if (x !== undefined) value.x = x
  if (y !== undefined) value.y = y
  return value
}
const randomActor = (prefix, index) => {
  const actor = { id: pick([`${prefix}-${index + 1}`, 'hero', 'borin', 'mirel', 'cult', 5, '']) }
  if (chance(0.8)) actor.name = pick(NAMES)
  if (chance(0.5)) actor.character = pick(NAMES)
  if (chance(0.7)) actor.hp = pick([0, 1, 5, 9, 20, 31, -3, '7', null, 2.5])
  if (chance(0.6)) actor.maxHp = pick([20, 31, 0, '20', null, 10])
  if (chance(0.15)) actor.max_hp = pick([20, 40])
  if (chance(0.3)) actor.alive = pick([true, false, null])
  if (chance(0.3)) actor.healthStatus = pick(HEALTH)
  if (chance(0.8)) Object.assign(actor, position())
  if (chance(0.3)) actor.role = pick(['Воин · ур. 3', 'не выбран', '  Плут · ур. 1 ', '', 'Волшебник'])
  if (chance(0.3)) actor.characterClass = pick(['wizard', 'не определено', ''])
  if (chance(0.3)) actor.backstory = pick(TEXTS.concat([`${'Сестра ушла в море на баркасе «Чайка». '.repeat(12)}Конец.`, `${'Долгая история без точек '.repeat(20)}`]))
  if (chance(0.2)) actor.bonds = pick(TEXTS)
  if (chance(0.2)) actor.ideals = pick(TEXTS)
  if (chance(0.2)) actor.species = pick(['Человек', 'ожидает игрока', ''])
  if (chance(0.2)) actor.background = pick(['Странник', 'герой ещё не создан'])
  return actor
}
const randomConcept = () => {
  const concept = {}
  for (const key of ['preset', 'era', 'genre', 'tone', 'premise', 'boundaries', 'world_template_id', 'worldSummary', 'worldHistory']) if (chance(0.3)) concept[key] = pick(TEXTS)
  if (chance(0.3)) concept[pick(['themes', 'theme'])] = pick(TEXTS)
  if (chance(0.3)) concept[pick(['magicLevel', 'magic_level'])] = pick(['высокая', 5, null])
  if (chance(0.3)) concept[pick(['technologyLevel', 'technology_level'])] = pick(['средняя', ''])
  if (chance(0.4)) concept.arc_history = Array.from({ length: int(5) }, (_, index) => ({ arc_number: pick([index + 1, 0, '2', 1.5, null]), title: pick(TEXTS), epilogue: pick(TEXTS), concluded_at: pick(['2026-10-01', null]) }))
  if (chance(0.4)) concept.factions = Array.from({ length: int(8) }, (_, index) => ({ id: pick([`f-${index}`, '', null]), name: pick(NAMES), summary: pick(TEXTS), goal: pick(TEXTS) }))
  if (chance(0.4)) concept[pick(['story_arcs', 'storyArcs'])] = Array.from({ length: int(6) }, () => ({ title: pick(TEXTS), levels: pick(['1–4', '', 5]), summary: pick(TEXTS), stakes: pick(TEXTS) }))
  if (chance(0.3)) concept.campaign_mode = pick(['persistent', 'adventure'])
  if (chance(0.4)) concept.story_history = Array.from({ length: int(5) }, (_, index) => ({ story_id: `s-${index}`, title: pick(TEXTS), outcome: pick(['success', 'failure', '']), summary: pick(TEXTS), story_number: index + 1, ...(chance(0.4) ? { knowledge_gate: pick([{ visibility: 'public' }, { visibility: 'party' }, { visibility: 'specific_player', player_ids: ['hero'] }, { visibility: 'gm', fact_ids: ['f1'] }]) } : {}) }))
  if (chance(0.3)) concept.arc = { arc_number: pick([1, 3, 0, '4', null]) }
  return concept
}
const randomRequirements = () => {
  const value = { version: 'scene-requirements/v3', items: Array.from({ length: int(5) }, () => ({ id: pick(KIND_IDS), count: pick([1, 2, 3, 0, '2']) })) }
  if (chance(0.5)) value.focus = pick(KIND_IDS)
  if (chance(0.4)) value.missing = Array.from({ length: 1 + int(3) }, () => pick([...STRUCTURES, ...KIND_IDS, 5, null]))
  return pick([value, value, value.items, null, 'x'])
}
const PATCHES = [
  () => [['scene', pick(['title', 'location', 'mood', 'objective', 'theme', 'scene_kind', 'layout'])], pick(TEXTS)],
  () => [['scene', 'location_id'], pick(['hall', 'pier', '', null, undefined, 'tavern-hall'])],
  () => [['scene', 'map_requirements'], randomRequirements()],
  () => [['scene', 'map'], pick([undefined, null, 'map', [], { width: 3, height: 3, layers: { present: 'broken' } }])],
  () => [['players'], Array.from({ length: int(4) }, (_, index) => randomActor('hero', index))],
  () => [['players', 0], randomActor('hero', 0)],
  () => [['enemies'], Array.from({ length: int(4) }, (_, index) => randomActor('foe', index))],
  () => [['actors'], [{ id: pick(['npc-1', 'hero']), ...position() }]],
  (actor) => [['mechanics', 'positions', typeof actor === 'string' ? actor : 'hero'], pick([position(), null, 0, 5])],
  () => [['mechanics', 'combat', 'active'], pick([true, false, 1, undefined])],
  () => [['mechanics', 'death', 'heroes'], pick([{ hero: { status: 'dead' } }, { 'hero-1': { status: 'dead' }, borin: { status: 'stable' } }, {}])],
  () => [['activePlayerId'], pick(['hero', 'hero-1', 'borin', '', null])],
  () => [['social', 'npcs'], Array.from({ length: int(4) }, (_, index) => ({ id: pick([`npc-${index + 1}`, 'npc-1', 5]), name: pick(NAMES), role: pick(['трактирщик', '', null, 'служанка у очага']), ...(chance(0.2) ? { available: pick([false, true]) } : {}) }))],
  () => [['social', 'conversations'], Array.from({ length: int(3) }, () => ({ npc_id: pick(['npc-1', 'npc-2', 5, null]) }))],
  () => [['npc_world', 'placements'], Array.from({ length: int(4) }, (_, index) => ({ npc_id: pick([`npc-${index + 1}`, 'npc-1']), location_id: pick(['hall', 'pier', 'x', undefined]), ...position() }))],
  () => [['messages'], Array.from({ length: int(4) }, () => ({ text: pick(['Орен кивает.', 'Мирель смеётся', 'ЁЖИК ЁЛКИН входит', 'Ада Лавлейс пишет', null, 'Ничего']) }))],
  () => [['worldMemory', 'facts'], Array.from({ length: int(10) }, (_, index) => ({ id: `f${index}`, predicate: pick(['scene_canon', 'scene_canon', 'discovery']), status: pick(['active', 'superseded', undefined]), visibility: pick(['party', 'public', 'gm_only']), summary: pick(TEXTS.concat(['Борин ранен', 'Марта знает тайну'])) }))],
  () => [['worldMap'], { currentLocationId: pick(['lh', '', undefined, 5]), locations: Array.from({ length: int(3) }, () => ({ id: pick(['lh', 'x', undefined]), name: pick(['Заброшенный маяк', 'ЗАБРОШЕННЫЙ  МАЯК', 'Зал', '']), summary: pick(TEXTS), known: pick([true, false, undefined]) })) }],
  () => [['campaignConcept'], randomConcept()],
  () => [['campaign_concept'], randomConcept()],
  () => [['adventure', 'chapter'], pick([1, 3, 0, '2', null, 2.5])],
  () => [[pick(['sessionCode', 'campaign_id', 'campaignId'])], pick(['CTX', '  code  ', '', null, 5])],
  () => [['campaign'], { id: pick(['camp-1', '']) }],
  () => [[pick(['state_version', 'stateVersion', 'version'])], pick([0, 7, -1, 2.5, '9', null])],
]
for (let index = 0; index < 900; index += 1) {
  const base = pick(baseStates)
  const actor = pick(ACTORS)
  const patch = []
  for (let step = 0, count = 1 + int(5); step < count; step += 1) {
    const [path, value] = pick(PATCHES)(actor)
    patch.push([path, encode(value)])
  }
  const run = (fn) => outcome(() => {
    const state = stateAt(base)
    for (const [path, value] of patch) setPath(state, path, decode(value))
    return fn(asJson(state))
  })
  const fn = pick(['sceneContextForAgent', 'sceneContextForAgent', 'fieldSummaryFor', 'heroCardForAgent', 'campaignConceptForAgent', 'sceneCanonFor', 'npcKnownByName', 'agentContextMetadata'])
  const entry = { fn, label: 'patch', state: base, patch }
  if (fn === 'sceneContextForAgent') Object.assign(entry, { actor: encode(actor), out: run((state) => A.sceneContextForAgent(state, actor)) })
  else if (fn === 'fieldSummaryFor') Object.assign(entry, { out: run((state) => A.fieldSummaryFor(state)) })
  else if (fn === 'heroCardForAgent') Object.assign(entry, { actor: encode(actor), out: run((state) => A.heroCardForAgent(state, actor)) })
  else if (fn === 'campaignConceptForAgent') {
    const viewer = pick(VIEWERS)
    Object.assign(entry, { viewer: encode(viewer), out: run((state) => A.campaignConceptForAgent(state, viewer)) })
  } else if (fn === 'sceneCanonFor') Object.assign(entry, { out: run((state) => A.sceneCanonFor(state)) })
  else if (fn === 'npcKnownByName') {
    const npc = { id: pick(['npc-1', 'npc-2', '', 5, undefined]), name: pick(NAMES) }
    Object.assign(entry, { npc, out: run((state) => A.npcKnownByName(state, npc)) })
  } else {
    const options = pick(OPTIONS)
    Object.assign(entry, { options: encode(options), out: run((state) => A.agentContextMetadata(state, options)) })
  }
  cases.push(entry)
}

// 5. Ограниченная выборка — чистая функция.
const selection = []
for (const scope of [undefined, null, 'visible', '  scope  ', 'x'.repeat(200), 5]) {
  for (const candidateCount of [undefined, 0, 3, 16, 17, -2, '20', null, 2.5]) {
    for (const limit of [undefined, 0, 16, '16', -1, null]) {
      for (const sourceAvailable of [undefined, true, false, null, 0, 'yes']) {
        if (!chance(0.2)) continue
        const options = {}
        if (scope !== undefined) options.scope = scope
        if (candidateCount !== undefined) options.candidateCount = candidateCount
        if (limit !== undefined) options.limit = limit
        if (sourceAvailable !== undefined) options.sourceAvailable = sourceAvailable
        selection.push({ options, out: A.boundedSelectionMetadata(options) })
      }
    }
  }
}
selection.push({ options: UNDEFINED, out: A.boundedSelectionMetadata() })

// 6. `Math.atan2` и `Math.hypot` побитно: сторона света якоря и порядок
// предметов по расстоянию. Числа — шестнадцатеричные биты f64 (держат −0 и NaN).
const bits = (value) => {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}
const math = []
const mathPair = (y, x) => math.push([bits(y), bits(x), bits(Math.atan2(y, x)), bits(Math.hypot(y, x))])
for (let index = 0; index < 1500; index += 1) {
  // Смещения центра якоря от героя: дроби с малыми знаменателями.
  const q = 1 + int(12)
  mathPair((int(121) - 60) / q, (int(121) - 60) / (1 + int(12)))
}
for (let sector = 0; sector < 16; sector += 1) {
  // Границы секторов по 22,5°: здесь решает последний бит.
  const angle = (sector * 22.5 * Math.PI) / 180
  for (const radius of [3.5, 7, 10, 25, 61.25]) {
    for (const nudge of [-2, -1, 0, 1, 2]) mathPair(radius * Math.sin(angle) + nudge * 1e-15 * radius, radius * Math.cos(angle))
  }
}
for (const [y, x] of [[0, 0], [-0, 0], [0, -0], [-0, -0], [0, -3], [-0, -3], [1, Infinity], [-1, -Infinity], [Infinity, Infinity], [NaN, 1], [1, NaN], [3, 0], [-3, 0], [1e-300, 1e300], [1e300, 1e-300], [1, 1], [2, 1], [-2.5, 1], [1e-20, -1], [5, 1e-80]]) mathPair(y, x)
for (let index = 0; index < 300; index += 1) mathPair((random() - 0.5) * 200, (random() - 0.5) * 200)

const constants = { AGENT_CONTEXT_SCHEMA_VERSION: A.AGENT_CONTEXT_SCHEMA_VERSION, SPATIAL_CONTEXT_SCHEMA_VERSION: A.SPATIAL_CONTEXT_SCHEMA_VERSION }
const sections = { constants, maps, states, cases, selection, math }
const lines = Object.entries(sections).map(([key, value]) => (Array.isArray(value)
  ? `${JSON.stringify(key)}: [\n${value.map((item) => JSON.stringify(item)).join(',\n')}\n]`
  : `${JSON.stringify(key)}: ${JSON.stringify(value)}`))
writeFileSync(new URL('./agent-context.json', import.meta.url), `{\n${lines.join(',\n')}\n}\n`)
const byFn = new Map()
for (const entry of cases) byFn.set(entry.fn, (byFn.get(entry.fn) ?? 0) + 1)
console.log(`agent-context.json: maps ${maps.length}, states ${states.length}, cases ${cases.length} (${[...byFn].map(([fn, count]) => `${fn} ${count}`).join(', ')}), selection ${selection.length}`)
