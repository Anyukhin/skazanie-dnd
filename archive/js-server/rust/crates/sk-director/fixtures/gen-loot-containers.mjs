import '../../../fixtures-env.mjs'
// Эталон server/loot-containers.mjs для Rust:
//
//   node rust/crates/sk-director/fixtures/gen-loot-containers.mjs
//
// Секция `calls` (`loot-containers.json.gz`): вызовы экспортов модуля —
//   - перехват тестов JS (контейнеры добычи, тела NPC, брошенное оружие,
//     свободное действие «обыскиваю тело», панель добычи, последствия мира,
//     проклятый рыцарь, проекция для зрителя);
//   - корпус `Dnd-narrator-live/tmp/corpus-v1`: команды `LootContainer`,
//     события контейнеров, фиксации с выбытием (`planLootContainerDrafts` по
//     состоянию «до» и «после» событий фиксации) и стол добычи для каждого
//     героя;
//   - сотни случайных контейнеров, отрядов, обысков, бросков и мусор старых
//     сохранений.
// Состояние урезано до полей, которые читает модуль; урезанное проверено тем
// же исходом. У `applyLootContainerEvent` в исход входит и состояние после
// вызова (функция правит его на месте).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { argsFrom, argsOf, captureTests, errorOf, mulberry32, picker, plain, writeFixture } from './common.mjs'

const root = new URL('../../../../', import.meta.url)
const lc = await import(new URL('server/loot-containers.mjs', root).href)
const { applyGameEvent } = await import(new URL('server/rules-engine.mjs', root).href)
const { enemyLoadoutFor } = await import(new URL('server/enemy-loadouts.mjs', root).href)
const { SRD_5_2_1_MONSTER_ALLOWLIST } = await import(new URL('server/encounter-assembler.mjs', root).href)
const { createItemInstance } = await import(new URL('server/item-instances.mjs', root).href)
const { materializeCatalogItem } = await import(new URL('server/item-catalog.mjs', root).href)

const FIXTURE = new URL('./loot-containers.json.gz', import.meta.url)
const CORPUS_DIR = 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'
const { int, pick, chance } = picker(mulberry32(2026_10_17_1))
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const FNS = [
  'normalizeLootContainer', 'normalizeLootContainersState', 'lootContainerList', 'lootContainerFor', 'sceneLootLocationKey',
  'lootContainersInScene', 'lootContainerIdFor', 'lootCommitTouchesContainers', 'planLootContainerDrafts', 'normalizeLootLines',
  'thrownWeaponDropDraft', 'lootCombatActionFor', 'inventoryItemFromInstance', 'validateLootContainerCommand',
  'lootContainerCommandEvents', 'applyLootContainerEvent', 'lootItemForViewer', 'lootContainerReachFor',
  'lootContainerForViewer', 'lootContainersForViewer',
]

// --- урезание состояния ----------------------------------------------------------------

const STATE_KEYS = ['loot_containers', 'scene', 'worldMap', 'mechanics', 'players', 'partyMemberIds', 'enemies', 'npc_world', 'social']
const APPLY_KEYS = ['loot_containers', 'players', 'enemies', 'npc_world']
const isPlain = (value) => value && typeof value === 'object' && !Array.isArray(value)
const pickKeys = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)))

function trimScene(scene) {
  if (!isPlain(scene)) return scene
  const kept = pickKeys(scene, ['location_id', 'locationId', 'location', 'title', 'level', 'cells'])
  if (Array.isArray(kept.cells)) {
    const revealed = kept.cells.filter((cell) => cell?.revealed === true).map((cell) => ({ x: cell.x, y: cell.y, revealed: true }))
    kept.cells = revealed.length ? revealed : kept.cells.slice(0, 1).map((cell) => (isPlain(cell) ? { x: cell.x, y: cell.y, revealed: cell.revealed } : cell))
  }
  return kept
}
function trimMechanics(mechanics) {
  if (!isPlain(mechanics)) return mechanics
  const kept = pickKeys(mechanics, ['positions', 'world_time', 'encounter', 'combat'])
  if (isPlain(kept.encounter)) kept.encounter = pickKeys(kept.encounter, ['id', 'encounter_id'])
  if (isPlain(kept.combat)) kept.combat = pickKeys(kept.combat, ['active', 'action_economy'])
  return kept
}
function trimWorldMap(worldMap) {
  if (!isPlain(worldMap)) return worldMap
  const kept = pickKeys(worldMap, ['currentLocationId', 'locations'])
  if (Array.isArray(kept.locations)) kept.locations = kept.locations.map((location) => (isPlain(location) ? pickKeys(location, ['id', 'name']) : location))
  return kept
}
const ACTOR_KEYS = ['id', 'actor_id', 'name', 'inventory', 'abilities', 'alive', 'hp', 'x', 'y', 'footprint', 'loadout', 'origin']
function trimState(state) {
  if (!isPlain(state)) return state
  const kept = pickKeys(state, STATE_KEYS)
  if ('scene' in kept) kept.scene = trimScene(kept.scene)
  if ('mechanics' in kept) kept.mechanics = trimMechanics(kept.mechanics)
  if ('worldMap' in kept) kept.worldMap = trimWorldMap(kept.worldMap)
  for (const key of ['players', 'enemies']) {
    if (Array.isArray(kept[key])) kept[key] = kept[key].map((actor) => (isPlain(actor) ? pickKeys(actor, ACTOR_KEYS) : actor))
  }
  if (isPlain(kept.social)) kept.social = { npcs: Array.isArray(kept.social.npcs) ? kept.social.npcs.map((npc) => (isPlain(npc) ? pickKeys(npc, ['id', 'name']) : npc)) : kept.social.npcs }
  if (isPlain(kept.npc_world)) kept.npc_world = pickKeys(kept.npc_world, ['inventories', 'placements'])
  return kept
}

// Позиции аргумента-состояния по функции.
const STATE_AT = {
  lootContainerList: [0], lootContainerFor: [0], sceneLootLocationKey: [0], lootContainersInScene: [0], lootCommitTouchesContainers: [0],
  planLootContainerDrafts: [0, 1], thrownWeaponDropDraft: [0], lootCombatActionFor: [0], validateLootContainerCommand: [1],
  lootContainerReachFor: [0], lootContainersForViewer: [0],
}

// --- исход вызова ------------------------------------------------------------------------

function run(fn, encoded) {
  const args = argsFrom(encoded)
  try {
    const value = lc[fn](...args)
    const outcome = { out: value === undefined ? null : plain(value) }
    if (fn === 'applyLootContainerEvent') outcome.state = args[0] === undefined ? null : plain(args[0])
    return outcome
  } catch (error) {
    return { error: errorOf(error) }
  }
}

const calls = []
const seen = new Set()
const counts = {}
function add(fn, args, label, { limit = 400 } = {}) {
  if ((counts[fn] ?? 0) >= limit) return null
  let encoded
  try {
    encoded = argsOf(args)
  } catch {
    return null
  }
  const key = JSON.stringify([fn, encoded])
  if (seen.has(key)) return null
  const outcome = run(fn, encoded)
  if (fn === 'applyLootContainerEvent') {
    // Состояние урезается до ключей, которые читает и пишет редьюсер: прочие
    // поля он не трогает, и исход урезанного — урезанный исход полного.
    const state = encoded.args[0]
    if (isPlain(state)) {
      const candidate = { ...encoded, args: encoded.args.map((value, index) => (index === 0 ? pickKeys(value, APPLY_KEYS) : value)) }
      const trimmed = run(fn, candidate)
      const expected = outcome.state && isPlain(outcome.state) ? pickKeys(outcome.state, APPLY_KEYS) : outcome.state
      if (JSON.stringify({ ...trimmed, state: trimmed.state }) === JSON.stringify({ ...outcome, state: expected })) encoded = candidate
    }
  } else {
    for (const at of STATE_AT[fn] ?? []) {
      const state = encoded.args[at]
      if (!isPlain(state)) continue
      const candidate = { ...encoded, args: encoded.args.map((value, index) => (index === at ? trimState(value) : value)) }
      if (JSON.stringify(run(fn, candidate)) === JSON.stringify(outcome)) encoded = candidate
    }
  }
  const finalOutcome = run(fn, encoded)
  const finalKey = JSON.stringify([fn, encoded])
  if (seen.has(finalKey)) return finalOutcome
  seen.add(key)
  seen.add(finalKey)
  counts[fn] = (counts[fn] ?? 0) + 1
  calls.push({ fn, label, ...encoded, ...finalOutcome })
  return finalOutcome
}

// --- перехват тестов ---------------------------------------------------------------------

const captured = await captureTests(
  ['loot-containers', 'npc-loot-containers', 'thrown-weapon-drop', 'free-action', 'loot-panel-rules', 'npc-world-consequences', 'scenario-knight', 'viewer-projection'],
  { '/server/loot-containers.mjs': FNS },
  { limit: 120 },
)
console.log(`перехвачено вызовов: ${captured.length}`)
for (const record of captured) add(record.fn, argsFrom(record), `test/${record.test}`)
console.log(`  после урезания и дублей: ${calls.length}`)

// --- корпус --------------------------------------------------------------------------------

let corpusRows = 0
let planMatches = 0
let planCases = 0
if (existsSync(CORPUS_DIR)) {
  for (const file of readdirSync(CORPUS_DIR).filter((name) => name.startsWith('corpus-')).sort()) {
    for (const line of readFileSync(join(CORPUS_DIR, file), 'utf8').split('\n')) {
      if (!line.includes('Loot') && !line.includes('"hp_after":0') && !line.includes('NpcDied') && !line.includes('CaptiveTaken') && !line.includes('ParleySettled')) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      const statePath = join(CORPUS_DIR, 'states', `${entry.state}.json`)
      if (!existsSync(statePath)) continue
      const state = JSON.parse(readFileSync(statePath, 'utf8'))
      const label = `corpus/${file}/${entry.command?.command_id ?? ''}`
      corpusRows += 1
      const events = Array.isArray(entry.outcome?.events) ? entry.outcome.events : []
      if (entry.command?.command_type === 'LootContainer') {
        const validated = add('validateLootContainerCommand', [entry.command, state, entry.context ?? {}], label)
        if (validated?.out) add('lootContainerCommandEvents', [validated.out], label)
      }
      for (const event of events.filter((item) => String(item?.event_type ?? '').startsWith('LootContainer'))) {
        add('applyLootContainerEvent', [clone(state), event], label)
      }
      const plainEvents = events.filter((item) => item?.event_type !== 'LootContainerCreated')
      if (lc.lootCommitTouchesContainers(state, plainEvents)) {
        add('lootCommitTouchesContainers', [state, plainEvents], label)
        let after
        try {
          after = plainEvents.reduce(applyGameEvent, structuredClone(state))
        } catch {
          after = null
        }
        if (after) {
          const outcome = add('planLootContainerDrafts', [state, after, plainEvents], label)
          const recorded = events.filter((item) => item?.event_type === 'LootContainerCreated').map((item) => item.payload?.container?.id)
          if (outcome?.out) {
            planCases += 1
            if (JSON.stringify(outcome.out.map((draft) => draft.payload?.container?.id)) === JSON.stringify(recorded)) planMatches += 1
          }
        }
      }
      if (lc.lootContainerList(state).length) {
        add('lootContainersForViewer', [state, { isAdmin: true }], label, { limit: 450 })
        for (const player of (state.players ?? []).slice(0, 3)) add('lootContainersForViewer', [state, { actorId: player?.id }], label, { limit: 450 })
      }
    }
  }
}
console.log(`строк корпуса: ${corpusRows}, черновиков по фиксациям: ${planCases}, совпали с записанными: ${planMatches}`)

// --- случайные входы ------------------------------------------------------------------------

const JUNK = [undefined, null, '', '  ', 'строка', 5, 0, -1, 1.5, true, false, [], {}, ['a'], 'constructor', '__proto__']
const junk = () => pick(JUNK)
const CATALOG = ['srd_5_2_1:dagger', 'srd_5_2_1:scimitar', 'srd_5_2_1:bolts-20', 'srd_5_2_1:light-crossbow', 'srd_5_2_1:javelin', 'srd_5_2_1:handaxe',
  'srd_5_2_1:potion-of-healing', 'srd_5_2_1:rope-hempen-50-feet', 'srd_5_2_1:shortsword', 'srd_5_2_1:healers-kit']
const STAT_BLOCKS = Object.keys(SRD_5_2_1_MONSTER_ALLOWLIST).slice(0, 40)
const LOCATIONS = ['warehouse', 'market', 'crypt', 'склеп', '', 'market@L2']
const KINDS = [...lc.LOOT_CONTAINER_KINDS, 'chest', '', undefined]

function instance(owner = 'foe-1', index = 0) {
  const catalogId = pick(CATALOG)
  try {
    return createItemInstance({
      catalogId,
      instanceId: pick([`${owner}-item-${index}`, `inst-${int(30)}`, `предмет-${index}`]),
      quantity: pick([1, 1, 2, 5, 20, 999]),
      owner: { kind: 'enemy', actor_id: owner },
      origin: { kind: pick(['enemy_loadout', 'found', 'gifted', 'stolen', 'unknown']), template_id: 'tpl', source_id: 'src' },
      lootable: pick([true, true, true, false, null]),
    })
  } catch {
    return null
  }
}

function randomItem(owner, index) {
  if (chance(0.06)) return junk()
  const item = instance(owner, index)
  if (!item) return junk()
  if (chance(0.15)) item.quantity = pick([0, -1, '3', 1000, 2.5])
  if (chance(0.1)) item.charges = pick([{ current: 2, max: 3 }, { current: 'x' }, 5, null])
  if (chance(0.08)) delete item.snapshot
  if (chance(0.08)) item.snapshot = { ...item.snapshot, weight: pick([0, -2, 'тяжёлый', 3.25, 1e9]), image: pick(['a.png', '', 7]), requires_attunement: pick([true, 'true']) }
  return item
}

function randomContainer(index) {
  if (chance(0.05)) return junk()
  const kind = pick(KINDS)
  const container = {
    id: pick([`loot:corpse:${index}`, `loot:${kind}:x${int(9)}`, ' loot:spaced ', '-bad', 'плохой', '', 'x'.repeat(130), `c${index}`]),
    kind,
    ...(chance(0.7) ? { name: pick(['Тело: Разбойник', '', '  Тело   волка ', 5]) } : {}),
    ...(chance(0.6) ? { source_enemy_id: pick(['foe-1', 'foe-2', '', 3]) } : chance(0.3) ? { sourceEnemyId: 'foe-3' } : {}),
    ...(chance(0.5) ? { source_enemy_ids: pick([['foe-1'], ['foe-1', 'foe-1', '', 7], 'foe', Array.from({ length: 15 }, (_, i) => `f${i}`)]) } : {}),
    ...(chance(0.3) ? { source_npc_id: pick(['marta', '', null]) } : chance(0.1) ? { sourceNpcId: 'bob' } : {}),
    ...(chance(0.5) ? { encounter_id: pick(['enc-1', '', 4]) } : {}),
    location_id: pick(LOCATIONS),
    ...(chance(0.3) ? { location_name: 'Склад' } : chance(0.1) ? { locationName: 'Рынок' } : {}),
    x: pick([2, 0, 5, null, undefined, '3', 1.5, -1]),
    y: pick([1, 2, 0, null, undefined, '2']),
    ...(chance(0.3) ? { footprint: pick([{ version: 1, size: 2 }, { version: 1, size: 9 }, { version: 2, size: 1 }, 'large', null]) } : {}),
    status: pick(['available', 'available', 'emptied', 'lost', undefined]),
    ...(chance(0.6) ? { created_at_minutes: pick([120, -5, '30', 1.5, null]) } : chance(0.1) ? { createdAtMinutes: 60 } : {}),
    items: chance(0.1) ? junk() : Array.from({ length: chance(0.03) ? 30 : pick([0, 1, 2, 3]) }, (_, i) => randomItem(`loot-${index}`, i)),
  }
  if (Array.isArray(container.items) && container.items.length && chance(0.1)) container.items.push(clone(container.items[0]))
  return container
}

function hero(id, x, y) {
  return {
    id,
    name: `Герой ${id}`,
    hp: pick([24, 24, 0, '5']),
    alive: pick([true, true, false, undefined]),
    abilities: { str: pick([16, 10, 1, '12', undefined]) },
    x,
    y,
    ...(chance(0.15) ? { footprint: { version: 1, size: 2 } } : {}),
    inventory: chance(0.08) ? pick([null, 'сумка', {}, [null], undefined]) : [
      ...(chance(0.5) ? [{ ...materializeCatalogItem(pick(CATALOG), { id: `inv-${id}`, quantity: pick([1, 2, 999_999]) }), equipped: chance(0.3) }] : []),
      ...(chance(0.2) ? [{ id: 'anvil', name: 'Наковальня', type: 'gear', quantity: 1, weight: pick([12, 300]) }] : []),
      ...(chance(0.1) ? [{ id: 'dagger', catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', quantity: 2 }] : []),
    ],
  }
}

function bandit(id, x, y, hp) {
  const statBlockId = pick(STAT_BLOCKS)
  const block = SRD_5_2_1_MONSTER_ALLOWLIST[statBlockId]
  return {
    id,
    name: pick([`Разбойник ${id}`, '', undefined]),
    hp,
    alive: hp > 0,
    x,
    y,
    ...(chance(0.15) ? { footprint: { version: 1, size: pick([1, 2, 3]) } } : {}),
    ...(chance(0.1) ? { origin: { kind: 'authored-npc', npc_id: pick(['marta', id]) } } : {}),
    loadout: chance(0.8) ? enemyLoadoutFor({ statBlockId, block, ownerId: id, seed: `seed-${int(5)}` }) : { items: Array.from({ length: int(3) }, (_, i) => randomItem(id, i)) },
  }
}

function npcInventory() {
  return Array.from({ length: pick([1, 2, 3]) }, (_, index) => pick([
    { id: `npc-item-${index}`, catalog_id: pick(CATALOG), name: 'Кинжал Марты', type: 'weapon', quantity: pick([1, 3, 1500]), origin: pick(['gifted', 'stolen', 'bogus']) },
    { item_instance_id: `marta-instance-${index}`, catalog_id: 'srd_5_2_1:dagger', snapshot: { catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', type: 'weapon', weight: 1 }, quantity: 1, origin: { kind: 'enemy_loadout', template_id: 'guard', source_id: 'enc' } },
    { name: 'Самодельная трубка', type: 'other', quantity: 2, charges: { current: 1, max: 2 } },
    { catalog_id: 'srd_5_2_1:healers-kit', name: 'Предмет', type: 'other', weight: 0, quantity: 1 },
    junk(),
  ]))
}

function randomState() {
  if (chance(0.03)) return pick([null, 5, 'state', []])
  const location = pick(LOCATIONS)
  const heroes = [hero('hero', 2, 2), hero('mate', pick([6, 3, 2]), pick([4, 2, 1]))]
  const enemies = Array.from({ length: int(4) }, (_, index) => bandit(`foe-${index + 1}`, pick([2, 3, 7, null]), pick([1, 2, null]), pick([11, 0, 3, '7'])))
  if (chance(0.05)) enemies.push(null)
  const positions = Object.fromEntries([...heroes, ...enemies.filter(Boolean)].filter(() => chance(0.85)).map((actor) => [actor.id, { x: actor.x ?? pick([1, 4]), y: actor.y ?? 2 }]))
  const containers = Array.from({ length: pick([0, 1, 2, 4]) }, (_, index) => {
    const container = randomContainer(index)
    if (isPlain(container) && chance(0.7)) {
      container.location_id = location
      container.kind = pick(lc.LOOT_CONTAINER_KINDS)
      container.id = `loot:corpse:c${index}`
      container.status = 'available'
    }
    return container
  })
  return {
    ...(chance(0.95) ? { scene: { location: pick(['Склад', 'Рынок', '']), ...(chance(0.8) ? { location_id: location } : {}), ...(chance(0.2) ? { level: { index: pick([0, 1, 2, '2', null]) } } : {}),
      ...(chance(0.6) ? { cells: Array.from({ length: 30 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), revealed: chance(0.8) })) } : {}) } } : {}),
    ...(chance(0.2) ? { worldMap: { currentLocationId: pick(['market', '']), locations: [{ id: 'warehouse', name: 'Склад' }] } } : {}),
    mechanics: {
      ...(chance(0.8) ? { positions } : {}),
      ...(chance(0.8) ? { world_time: pick([{ elapsed_minutes: 120 }, { amount: 2, unit: 'hours' }, { elapsed_minutes: 'x' }]) } : {}),
      ...(chance(0.6) ? { encounter: pick([{ id: 'enc-1' }, { encounter_id: 'enc-2' }, {}]) } : {}),
      combat: chance(0.5)
        ? { active: true, action_economy: { hero: { action: pick([true, false]), object_interaction: pick([true, false, undefined]) }, mate: { action: true } } }
        : pick([{ active: false }, {}, undefined]),
    },
    players: chance(0.04) ? junk() : heroes,
    ...(chance(0.8) ? { partyMemberIds: pick([['hero', 'mate'], ['hero'], [], ['hero', 'mate', 7]]) } : {}),
    enemies,
    ...(chance(0.4) ? { npc_world: { inventories: { marta: npcInventory(), ...(chance(0.3) ? { bob: [] } : {}) }, placements: [{ npc_id: 'marta', location_id: location, x: 4, y: 3, ...(chance(0.3) ? { footprint: { version: 1, size: 2 } } : {}) }] } } : {}),
    ...(chance(0.3) ? { social: { npcs: [{ id: 'marta', name: pick(['Марта', '', undefined]) }] } } : {}),
    loot_containers: chance(0.05) ? junk() : { schema_version: 1, containers },
  }
}

const VIEW_LIMIT = 900
for (let index = 0; index < 700; index += 1) {
  const container = randomContainer(index)
  add('normalizeLootContainer', [container], 'random/container', { limit: VIEW_LIMIT })
  add('lootContainerForViewer', [container, pick([undefined, {}, { withContents: true }, { withContents: 'yes', distanceFeet: pick([12.5, -1, '7', null, Infinity]) }, { cellRevealed: pick([false, 0, null]) }])], 'random/container-view', { limit: VIEW_LIMIT })
  if (isPlain(container) && Array.isArray(container.items)) {
    for (const item of container.items.slice(0, 2)) add('lootItemForViewer', [item], 'random/item-view', { limit: VIEW_LIMIT })
  }
}
for (const value of JUNK) {
  add('normalizeLootContainer', [value], 'junk')
  add('normalizeLootContainersState', [value], 'junk')
  add('normalizeLootLines', [value], 'junk')
  add('lootItemForViewer', [value], 'junk')
  add('lootContainerForViewer', [value], 'junk')
  add('lootContainerList', [value], 'junk')
  add('sceneLootLocationKey', [value], 'junk')
  add('lootCommitTouchesContainers', [value, [{ event_type: 'NpcDied', payload: {} }]], 'junk')
  add('lootContainerCommandEvents', [value], 'junk')
  add('applyLootContainerEvent', [value, { event_type: 'LootContainerCreated', event_schema_version: 1, payload: { schema_version: 1, container: randomContainer(1) } }], 'junk')
}
// Переполнение реестра.
for (let index = 0; index < 12; index += 1) {
  const base = randomContainer(index)
  const full = Array.from({ length: pick([59, 60, 61, 70, 130]) }, (_, i) => ({ ...randomContainer(i), items: [{ item_instance_id: 'i' + i, catalog_id: 'srd_5_2_1:dagger', snapshot: {}, quantity: 1, owner: { kind: 'container', actor_id: 'c' }, origin: { kind: 'found' } }], id: `loot:corpse:n${String(i).padStart(3, '0')}`, kind: 'corpse', status: pick(['available', 'emptied']) }))
  add('normalizeLootContainersState', [{ containers: [base, ...full] }], 'random/overflow')
}
for (let index = 0; index < 80; index += 1) {
  add('normalizeLootLines', [Array.from({ length: pick([0, 1, 3, 14]) }, (_, i) => pick([{ item_instance_id: `i${i}`, quantity: pick([1, '2', 1.5, undefined, -3]) }, { itemInstanceId: ` i${i} ` }, junk(), { item_instance_id: '' }]))], 'random/lines')
  add('lootContainerIdFor', [pick(KINDS), Array.from({ length: int(4) }, () => pick(['foe-1', 'б', 'a', '  x  ', 5, null])), pick([{}, { encounterId: 'enc', locationKey: 'market@L1', minutes: pick([0, 120, -4, 1.5, '30']) }, undefined])], 'random/id')
}

for (let index = 0; index < 650; index += 1) {
  const state = randomState()
  const label = 'random/state'
  add('lootContainerList', [state], label, { limit: 200 })
  add('sceneLootLocationKey', [state], label, { limit: 150 })
  add('lootContainersInScene', [state, pick([undefined, {}, { includeEmptied: true }])], label)
  add('lootContainersForViewer', [state, pick([undefined, {}, { actorId: 'hero' }, { actorId: 'mate' }, { actorId: 'hero', isAdmin: true }, { isAdmin: true }, { actorId: null }])], label, { limit: VIEW_LIMIT })
  const containers = isPlain(state) ? lc.lootContainerList(state) : []
  const container = containers.length ? pick(containers) : randomContainer(index)
  add('lootContainerFor', [state, isPlain(container) ? pick([container.id, ` ${container.id} `, 'нет']) : junk()], label)
  add('lootCombatActionFor', [state, pick(['hero', 'mate', undefined, ' hero ']), container], label)
  if (isPlain(state)) {
    for (const actor of [...(Array.isArray(state.players) ? state.players : []), null].slice(0, 3)) add('lootContainerReachFor', [state, actor, container], label, { limit: VIEW_LIMIT })
  }
  // Обыск.
  if (isPlain(container) && isPlain(state)) {
    const items = Array.isArray(container.items) ? container.items.filter(isPlain) : []
    const lines = pick([
      items.map((item) => ({ item_instance_id: item.item_instance_id, quantity: item.quantity })),
      items.slice(0, 1).map((item) => ({ item_instance_id: item.item_instance_id, quantity: 1 })),
      [{ item_instance_id: 'нет', quantity: 1 }],
      [],
      items.slice(0, 1).map((item) => ({ item_instance_id: item.item_instance_id, quantity: 99 })),
      [...items.slice(0, 1), ...items.slice(0, 1)].map((item) => ({ item_instance_id: item.item_instance_id, quantity: 1 })),
    ])
    const command = {
      command_type: pick(['LootContainer', 'LootContainer', 'LootContainer', 'MakeAttack']),
      command_id: `cmd-${index}`,
      campaign_id: 'LOOT',
      actor_id: pick(['hero', 'hero', 'mate', 'foe-1', '']),
      container_id: container.id,
      lines,
      ...(chance(0.3) ? { recipient_id: pick(['mate', 'hero', 'foe-1', '']) } : {}),
      ...(chance(0.05) ? { name: 'Меч +3' } : {}),
      ...(chance(0.2) ? { request_fingerprint: 'f'.repeat(64) } : {}),
    }
    const context = pick([{ allowedActorIds: ['hero', 'mate'] }, { isAdmin: true }, {}, undefined, { allowedActorIds: 'hero' }])
    const validated = add('validateLootContainerCommand', [command, state, context], 'random/loot')
    if (validated?.out?.loot_container) {
      add('lootContainerCommandEvents', [validated.out], 'random/loot')
      for (const event of lc.lootContainerCommandEvents(validated.out)) {
        add('applyLootContainerEvent', [clone(state), event], 'random/taken')
        // Повтор того же события поверх уже применённого.
        const once = clone(state)
        try {
          lc.applyLootContainerEvent(once, event)
          add('applyLootContainerEvent', [once, event], 'random/taken-twice')
        } catch {
          // мусорное состояние — повтор не нужен
        }
      }
    }
  }
  // Выбытие: «до» и «после».
  if (isPlain(state)) {
    const after = clone(state)
    const events = []
    for (const enemy of Array.isArray(after.enemies) ? after.enemies : []) {
      if (!isPlain(enemy) || !chance(0.6)) continue
      const mode = pick(['kill', 'kill', 'captive', 'tribute', 'nothing'])
      if (mode === 'kill') {
        enemy.hp = 0
        events.push({ event_type: 'DamageApplied', target_ids: [enemy.id], payload: { hp_after: 0 } })
      }
      if (mode === 'captive') events.push({ event_type: 'CaptiveTaken', payload: { captive: { actor_id: enemy.id } } })
      if (mode === 'tribute') events.push({ event_type: 'ParleySettled', payload: { outcome: pick(['tribute', 'peace']), enemy_ids: [enemy.id] } })
    }
    if (chance(0.35)) events.push(pick([
      { event_type: 'NpcDied', payload: { npc_id: 'marta', npc_name: 'Марта' }, target_ids: ['marta'] },
      { event_type: 'NpcDied', target_ids: 'marta' },
      { event_type: 'NpcDied', payload: { npc_id: 'bob' } },
    ]))
    if (chance(0.1)) events.push({ event_type: 'DamageApplied', target_ids: ['hero'], payload: { hp_after: 0 } })
    if (chance(0.05)) events.push(junk())
    add('lootCommitTouchesContainers', [state, events], 'random/commit')
    const planned = add('planLootContainerDrafts', [state, after, events], 'random/commit')
    for (const draft of planned?.out ?? []) {
      add('applyLootContainerEvent', [clone(after), draft], 'random/created')
    }
    // Брошенное оружие.
    const inventory = Array.isArray(state.players?.[0]?.inventory) ? state.players[0].inventory : []
    const item = pick([...inventory.filter(isPlain), { id: 'dagger', catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал', quantity: 2, origin: 'purchased', charges: { current: 1, max: 1 } }, { id: 'rock', name: 'Камень' }, junk()])
    const info = pick([{ commandId: `throw-${index}`, ownerId: 'hero', item, position: { x: pick([4, null, '2']), y: 1 } }, { ownerId: 'hero', item }, {}, undefined])
    const drop = add('thrownWeaponDropDraft', [state, info], 'random/thrown')
    if (drop?.out) {
      add('applyLootContainerEvent', [clone(state), drop.out], 'random/thrown')
      const dropped = clone(state)
      try {
        lc.applyLootContainerEvent(dropped, drop.out)
        const container = drop.out.payload.container
        add('validateLootContainerCommand', [{
          command_type: 'LootContainer', command_id: `pick-${index}`, actor_id: 'hero', container_id: container.id,
          lines: container.items.map((entry) => ({ item_instance_id: entry.item_instance_id, quantity: 1 })),
        }, dropped, { isAdmin: true }], 'random/thrown-pickup')
      } catch {
        // мусорное состояние
      }
    }
  }
}
// Экземпляр → вещь героя.
for (let index = 0; index < 60; index += 1) {
  const item = randomItem('x', index)
  add('inventoryItemFromInstance', [item, { id: `loot:${index}`, quantity: pick([1, 2, 5]), containerKind: pick([...lc.LOOT_CONTAINER_KINDS, '']) }], 'random/inventory')
}

// Крупные аргументы (состояния) хранятся один раз: в вызове — `{ $ref: n }`.
const values = []
const refs = new Map()
for (const call of calls) {
  call.args = call.args.map((value) => {
    const text = JSON.stringify(value)
    if (text === undefined || text.length < 1500) return value
    if (!refs.has(text)) {
      refs.set(text, values.length)
      values.push(value)
    }
    return { $ref: refs.get(text) }
  })
}
writeFixture(FIXTURE, { values, calls }, { gzip: true })
const byFn = {}
for (const call of calls) byFn[call.fn] = (byFn[call.fn] ?? 0) + 1
console.log(Object.entries(byFn).map(([fn, n]) => `${fn} ${n}`).join(', '))
