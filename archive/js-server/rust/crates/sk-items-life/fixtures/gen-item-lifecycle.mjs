import '../../../fixtures-env.mjs'
// Эталон item-lifecycle: состояния корпуса паритета и случайные отряды.
//
// - корпус (`tmp/corpus-v1/states` прогона Dnd-narrator-live): герои с
//   настоящими инвентарями; на каждом — производные числа снаряжения и
//   команды всех пяти типов от каждого героя к каждой его вещи (вне боя и в
//   бою), а события принятых команд применяются к героям;
// - случайные отряды: вещи каталога, старые вещи без catalog_id, ключи
//   прототипа, мусор старых сохранений (null, строки, числа вместо вещей и
//   полей), NPC сцены для передачи; цепочки команд, где герои следующей
//   команды — итог событий предыдущей; события с мусорными полями.
//
//   node rust/crates/sk-items-life/fixtures/gen-item-lifecycle.mjs [каталог-корпуса]
//
// Пишет item-lifecycle.json рядом с собой. Корпус необязателен: без него
// остаются случайные отряды (в отчёте генератора видно, сколько состояний
// корпуса вошло).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { chooser, dispatch, fixtureWriter, mulberry32, stripState, viaJson } from './common.mjs'

const lifecycle = await import('../../../../server/item-lifecycle.mjs')
const catalog = await import('../../../../server/item-catalog.mjs')
const retention = await import('../../../../server/retention-context.mjs')

const writer = fixtureWriter()
const calls = dispatch(lifecycle)
const random = mulberry32(0x17e3)
const c = chooser(random)

const PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype)
const CATALOG_IDS = [...Object.keys(catalog.ITEM_CATALOG), ...Object.keys(catalog.SCENARIO_ITEM_CATALOG)]
const FEATURED = CATALOG_IDS.filter((id) => {
  const entry = catalog.catalogItem(id)
  return entry?.passive_effects || entry?.activation || entry?.charges || entry?.use || entry?.attunement?.required || entry?.equip?.armor || entry?.combat
})

// Частые отказы проверки (нет профиля применения, чужой герой) не должны
// вытеснять редкие ветки: случаев с одним исходом — не больше предела.
const perOutcome = (key) => (key.endsWith(':ok') ? 2500 : key.startsWith('validateItemLifecycleCommand:') ? 250 : 400)

function run(name, args, options = {}) {
  const mode = options.retention ?? 'current'
  return writer.call(name, (...plain) => retention.withRetentionMode(mode, () => calls[name](...plain)), args, { retention: mode, cap: options.cap, perOutcome: options.perOutcome ?? perOutcome })
}

// --- производные числа героя ---------------------------------------------
function actorBattery(actor, itemIds) {
  run('inventoryWeight', [actor])
  run('carryingCapacity', [actor])
  run('inventoryLoadFor', [actor])
  run('activeItemEffectTotals', [actor])
  run('equippedShieldBonus', [actor])
  run('derivedEquipmentArmorClass', [actor])
  run('derivedEquipmentArmorClass', [actor, { includeItemEffects: false }])
  run('derivedEquipmentArmorClass', [actor, { includeItemEffects: 0 }])
  run('activeItemMechanicEffects', [actor])
  for (const itemId of itemIds.slice(0, 4)) {
    run('activeItemMechanicEffects', [actor, { selectedItemId: itemId, selectedCountsAsEquipped: true }])
    run('weaponDamageRidersForItem', [actor, itemId])
    run('weaponDamageRidersForItem', [actor, itemId, { selectedCountsAsEquipped: true }])
  }
  run('weaponDamageRidersForItem', [actor, undefined])
}

// --- команды --------------------------------------------------------------
function commandVariants(type, base, others) {
  if (type === 'EquipItem') return [{ ...base }, { ...base, equipped: false }, { ...base, equipped: true, equip_slot: 'off_hand' }, { ...base, equipped: 'no' }]
  if (type === 'UseItem') {
    return [
      { ...base },
      ...others.slice(0, 3).map((target) => ({ ...base, target_id: target })),
      { ...base, charges_to_spend: 1 },
      { ...base, charges_to_spend: 3 },
      { ...base, charges_to_spend: 'x' },
    ]
  }
  if (type === 'TransferItem') {
    return [
      ...others.slice(0, 4).map((recipient) => ({ ...base, recipient_id: recipient })),
      { ...base, recipient_id: base.actor_id },
      { ...base, target_id: others[0] ?? 'nobody', quantity: 2 },
      { ...base, recipient_id: others[0] ?? 'nobody', quantity: 'all' },
    ]
  }
  if (type === 'AttuneItem') return [{ ...base }, { ...base, attuned: false }]
  return [{ ...base, activated: true }, { ...base, activated: false }, { ...base }]
}

const TYPES = ['EquipItem', 'UseItem', 'TransferItem', 'AttuneItem', 'ActivateItem']

/** Команда → события → герои после событий. */
function commandChain(command, state, context, options = {}) {
  const outcome = run('validateItemLifecycleCommand', [command, state, context], options)
  if (!outcome.recorded || outcome.error || !outcome.value) return null
  const events = run('itemLifecycleEvents', [outcome.value], options)
  if (!Array.isArray(events.value)) return null
  let players = state.players
  for (const event of events.value) {
    const applied = run('applyItemLifecycleEventToPlayers', [players, event], options)
    if (applied.error || !Array.isArray(applied.value)) return null
    players = applied.value
  }
  return players
}

function stateBattery(state, { deep = true, retentionMode = 'current' } = {}) {
  const options = { retention: retentionMode }
  const players = Array.isArray(state.players) ? state.players : []
  const actorIds = players.map((player) => String(player?.id ?? player?.actor_id ?? '')).filter(Boolean)
  const npcIds = (Array.isArray(state.social?.npcs) ? state.social.npcs : []).map((npc) => npc?.id).filter(Boolean).slice(0, 3)
  const enemyIds = (Array.isArray(state.enemies) ? state.enemies : []).map((enemy) => enemy?.id).filter(Boolean).slice(0, 2)
  for (const player of players.slice(0, 4)) {
    const ownerId = String(player?.id ?? player?.actor_id ?? '')
    const inventory = Array.isArray(player?.inventory) ? player.inventory : []
    const itemIds = inventory.map((item) => item?.id).filter((id) => id != null)
    const others = [...actorIds.filter((id) => id !== ownerId), ...npcIds, ...enemyIds, 'nobody']
    for (const item of inventory.slice(0, deep ? 8 : 3)) {
      if (!item || typeof item !== 'object') continue
      run('itemProfileFor', [item, { rulesetId: state.ruleset_id }])
      run('itemProfileFor', [item])
      for (const type of TYPES) {
        const base = { command_type: type, command_id: `cmd:${type}:${ownerId}:${item.id}`, actor_id: ownerId, item_id: item.id }
        for (const command of commandVariants(type, base, others)) {
          commandChain(command, state, { allowedActorIds: [ownerId] }, options)
        }
      }
    }
    actorBattery(player, itemIds)
    if (deep && inventory[0]?.id != null) {
      const base = { command_type: 'EquipItem', actor_id: ownerId, item_id: inventory[0].id }
      run('validateItemLifecycleCommand', [base, state, { isAdmin: true }], options)
      run('validateItemLifecycleCommand', [base, state, {}], options)
      run('validateItemLifecycleCommand', [base, state], options)
      run('validateItemLifecycleCommand', [{ ...base, sneaky: 1, alpha: 2 }, state, { isAdmin: true }], options)
    }
  }
}

function combatVariant(state, economy) {
  const ids = (Array.isArray(state.players) ? state.players : []).map((player) => String(player?.id ?? ''))
  return {
    ...state,
    mechanics: { combat: { active: true, action_economy: Object.fromEntries(ids.map((id) => [id, { object_interaction: economy }])) } },
  }
}

// --- корпус ---------------------------------------------------------------
const DEFAULT_CORPUS = 'C:/Users/anton/PycharmProjects/Dnd-narrator-live/tmp/corpus-v1'
const corpusDir = process.argv[2] ?? process.env.SK_ITEMS_CORPUS ?? DEFAULT_CORPUS
let corpusStates = 0
if (existsSync(join(corpusDir, 'states'))) {
  const seenHashes = new Set()
  const seenInventories = new Set()
  const files = readdirSync(corpusDir).filter((name) => name.startsWith('corpus-') && name.endsWith('.jsonl')).sort()
  outer: for (const file of files) {
    for (const line of readFileSync(join(corpusDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (!record.state || seenHashes.has(record.state)) continue
      seenHashes.add(record.state)
      let state
      try {
        state = JSON.parse(readFileSync(join(corpusDir, 'states', `${record.state}.json`), 'utf8'))
      } catch {
        continue
      }
      const stripped = stripState(state)
      const inventories = JSON.stringify((stripped.players ?? []).map((player) => player?.inventory))
      if (seenInventories.has(inventories) || !(stripped.players ?? []).some((player) => player?.inventory?.length)) continue
      seenInventories.add(inventories)
      corpusStates += 1
      stateBattery(stripped, { deep: corpusStates <= 12 })
      if (corpusStates <= 12) stateBattery(stripState(combatVariant(stripped, c.pick([true, false, undefined]))), { deep: false })
      if (corpusStates <= 6) stateBattery(stripped, { deep: false, retentionMode: 'legacy' })
      if (corpusStates >= 22) break outer
    }
  }
}

// --- случайные отряды -----------------------------------------------------
const GARBAGE = [null, 0, 5, '', 'str', true, false, [], {}, [1, 2], { id: null }]

function materialized(id, index, ownerId) {
  const item = catalog.materializeCatalogItem(id, { id: c.chance(0.05) ? 7 : `it-${index}`, quantity: c.pick([1, 1, 1, 2, 5]), equipped: c.chance(0.35) })
  if (c.chance(0.4)) mutate(item, ownerId)
  return item
}

function mutate(item, ownerId) {
  const roll = c.int(0, 15)
  if (roll === 0) item.quantity = c.pick(['2', 'x', -1, 0, null, 1.5, 3, 999999, 1e16])
  else if (roll === 1) item.equipped = c.pick([true, false, 'yes', 1, null])
  else if (roll === 2) item.attuned_to = c.pick([ownerId, 'other-hero', null, '', 5])
  else if (roll === 3) item.activated = c.pick([true, false, 'on'])
  else if (roll === 4) item.equipped_slot = c.pick(['off_hand', 'main_hand', 'ring'])
  else if (roll === 5) item.charges = c.pick([{ current: 0 }, { current: 1 }, { current: '3' }, { current: 99 }, null, 'full', { max: 2 }])
  else if (roll === 6 && Array.isArray(item.passive_effects)) {
    const effect = item.passive_effects[0]
    if (effect) {
      const tamper = c.int(0, 5)
      if (tamper === 0) effect.armor_class_bonus = c.pick([5, '2', -1, 1000])
      else if (tamper === 1) delete effect.schema_version
      else if (tamper === 2) item.passive_effects.push({ ...effect })
      else if (tamper === 3) item.passive_effects.push({ schema_version: 1, effect_id: 'homebrew:x', group: 'homebrew', armor_class_bonus: 3, saving_throw_bonus: 2 })
      else if (tamper === 4) effect.group = c.pick(['', '  Группа  ', 'other'])
      else item.passive_effects.push(null, 'x', 5)
    }
  } else if (roll === 7) item.weight = c.pick([0, '2', -3, 'abc', 1e308, 0.25, null])
  else if (roll === 8) item.catalog_id = c.pick([...PROTOTYPE_KEYS.slice(0, 4), 'nope:item', '', `  ${item.catalog_id}  `])
  else if (roll === 9) {
    delete item.catalog_id
    item.catalogId = c.pick(CATALOG_IDS)
  } else if (roll === 10) item.id = c.pick([null, 5, '', 'dup'])
  else if (roll === 11) item.passive_effects = c.pick([null, 'x', {}, []])
  else if (roll === 12) item.name = c.pick([null, 7, 'Меч', ''])
}

function legacyItem(index, ownerId) {
  const type = c.pick(['weapon', 'weapon', 'armor', 'gear', 'potion', 'focus'])
  const item = {
    id: `legacy-${index}`,
    name: c.pick(['Старый меч', 'Кольчуга', 'Верёвка', 'Посох']),
    type,
    quantity: c.pick([1, 1, 2, '3']),
    weight: c.pick([1, 3, 0, '2']),
    equipped: c.chance(0.3),
  }
  if (type === 'weapon' && c.chance(0.7)) item.combat = c.pick([{ kind: 'melee', damageDice: 8 }, [], 'yes', { properties: ['light'] }])
  if (c.chance(0.2)) item.requires_attunement = c.pick([true, 'yes'])
  if (c.chance(0.2)) item.armor_profile = { kind: c.pick(['shield', 'armor']) }
  if (c.chance(0.2)) mutate(item, ownerId)
  return item
}

function randomItem(index, ownerId) {
  const roll = c.int(0, 99)
  if (roll < 4) return c.pick(GARBAGE)
  if (roll < 40) return materialized(c.pick(FEATURED), index, ownerId)
  if (roll < 65) return materialized(c.pick(CATALOG_IDS), index, ownerId)
  if (roll < 82) return legacyItem(index, ownerId)
  return { id: `odd-${index}`, catalog_id: c.pick([...PROTOTYPE_KEYS, 'nope:item']), quantity: 1, equipped: c.chance(0.5), type: c.pick(['weapon', 'armor', undefined]) }
}

function randomHero(index) {
  const id = `hero-${index}`
  const hero = { id, name: `Герой ${index}`, abilities: { str: c.pick([10, 8, 16, '14', null, 30, 0]), dex: c.pick([14, 10, 18, '12', null, 3]) }, inventory: [] }
  const count = c.int(0, 9)
  for (let i = 0; i < count; i += 1) hero.inventory.push(randomItem(index * 100 + i, id))
  // Вторая рука: пара лёгкого оружия ближнего боя.
  if (c.chance(0.2)) {
    hero.inventory.push(catalog.materializeCatalogItem('srd_5_2_1:shortsword', { id: `${id}-main`, quantity: 1, equipped: true }))
    hero.inventory.push(catalog.materializeCatalogItem(c.pick(['srd_5_2_1:shortsword', 'srd_5_2_1:dagger', 'srd_5_2_1:scimitar', 'srd_5_2_1:longsword']), { id: `${id}-off`, quantity: 1 }))
  }
  const garbage = c.int(0, 40)
  if (garbage === 0) delete hero.id
  else if (garbage === 1) hero.actor_id = hero.id
  else if (garbage === 2) hero.inventory = c.pick([null, {}, 'abc', 5])
  else if (garbage === 3) delete hero.abilities
  return hero
}

function randomState(index) {
  const count = c.int(1, 3)
  const players = Array.from({ length: count }, (_, i) => randomHero(index * 10 + i))
  if (c.chance(0.05)) players.push(c.pick(GARBAGE))
  const ids = players.map((player) => player?.id).filter(Boolean)
  const location = 'loc-market'
  const npcs = [
    { id: 'npc-trader', name: 'Торговка', location_id: location, available: c.pick([true, true, false]) },
    { id: 'npc-ghost', name: 'Призрак', location_id: location, visibility: 'gm_only', reveal_on_presence: c.chance(0.5) },
    { id: 'npc-away', name: 'Путник', location_id: 'loc-road' },
    { id: 'npc-dead', name: 'Павший', location_id: location },
  ]
  const placements = npcs.map((npc, i) => ({ npc_id: npc.id, location_id: npc.location_id, x: i, y: 1 }))
  const inventories = c.chance(0.3) ? { 'npc-trader': [catalog.materializeCatalogItem('srd_5_2_1:torch', { id: 'trader-torch', quantity: c.pick([1, 999998]) })] } : {}
  const state = {
    ruleset_id: c.pick(['srd_5_2_1', 'dnd_5e_2014', 'dnd_5e_2014', undefined, null]),
    players,
    partyMemberIds: c.pick([ids, ids, ids.slice(0, 1), [], undefined, 'ab', { length: 1 }]),
    actors: c.pick([[], [{ id: 'summon-1', name: 'Призванный' }], undefined]),
    enemies: c.pick([[{ id: 'goblin-1', name: 'Гоблин' }], [], undefined, [{ id: 'goblin-1' }, null]]),
    mechanics: c.pick([{ combat: { active: false } }, { combat: { active: true, action_economy: Object.fromEntries(ids.map((id) => [id, { object_interaction: c.pick([true, false, undefined]) }])) } }, {}, undefined]),
    scene: { location_id: location },
    social: { npcs },
    npc_world: { placements, vitals: { 'npc-dead': { hp: 0, max_hp: 4, alive: false } }, inventories },
  }
  if (c.chance(0.03)) state.players = c.pick([null, {}, 'xy'])
  return viaJson(state)
}

function randomCommand(state) {
  const players = Array.isArray(state.players) ? state.players : []
  const owner = c.pick(players.length ? players : [{}])
  const ownerId = c.chance(0.05) ? c.pick(['', 'ghost', 5]) : owner?.id ?? owner?.actor_id
  const inventory = Array.isArray(owner?.inventory) ? owner.inventory : []
  const item = c.pick(inventory.length ? inventory : [{}])
  const itemId = c.chance(0.05) ? c.pick(['undefined', 'missing', null, 7]) : item?.id
  const type = c.chance(0.03) ? c.pick(['CastSpell', undefined, 'equipitem']) : c.pick(TYPES)
  const command = { command_type: type, command_id: `cmd-${c.int(0, 9999)}`, actor_id: ownerId, item_id: itemId }
  const targets = [...players.map((player) => player?.id), 'npc-trader', 'npc-ghost', 'npc-away', 'npc-dead', 'goblin-1', 'summon-1', 'nobody', '', null]
  if (type === 'EquipItem') {
    if (c.chance(0.4)) command.equipped = c.pick([true, false, 'no', 0])
    if (c.chance(0.3)) command.equip_slot = c.pick(['off_hand', 'main_hand', null])
  }
  if (type === 'UseItem') {
    if (c.chance(0.7)) command.target_id = c.pick(targets)
    if (c.chance(0.5)) command.charges_to_spend = c.pick([1, 2, 3, 7, 0, '2', 'x', 1.5])
  }
  if (type === 'TransferItem') {
    if (c.chance(0.8)) command.recipient_id = c.pick(targets)
    else command.target_id = c.pick(targets)
    if (c.chance(0.5)) command.quantity = c.pick([1, 2, 5, 0, -1, '2', 'all', 999999])
  }
  if (type === 'AttuneItem' && c.chance(0.4)) command.attuned = c.pick([true, false, 'no'])
  if (type === 'ActivateItem' && c.chance(0.9)) command.activated = c.pick([true, false, 'yes', 1])
  if (c.chance(0.04)) command[c.pick(['hack', 'item_profile', 'charge_spend'])] = 1
  if (c.chance(0.05)) command.request_fingerprint = c.pick(['fp-1', null, 5])
  return command
}

function randomContext(command) {
  return c.pick([{ allowedActorIds: [command.actor_id] }, { allowedActorIds: [command.actor_id] }, { isAdmin: true }, {}, undefined, { allowedActorIds: 'x' }, { isAdmin: 'true', allowedActorIds: [] }])
}

const EVENT_TYPES = ['ItemEquipped', 'ItemUnequipped', 'ItemAttunementChanged', 'ItemTransferred', 'ItemChargesSpent', 'ItemDestroyed', 'MagicItemActivationChanged', 'Other']

function randomEvent(state) {
  const players = Array.isArray(state.players) ? state.players : []
  const owner = c.pick(players.length ? players : [{}])
  const ownerId = owner?.id ?? owner?.actor_id
  const inventory = Array.isArray(owner?.inventory) ? owner.inventory : []
  const itemId = c.chance(0.1) ? c.pick(['missing', null, 7, 'undefined']) : c.pick(inventory.length ? inventory : [{}])?.id
  const type = c.pick(EVENT_TYPES)
  const other = c.pick(players)?.id
  const payloads = {
    ItemEquipped: { item_id: itemId, equip_slot: c.pick(['main_hand', 'off_hand', 'body', 'ring', undefined]) },
    ItemUnequipped: { item_id: itemId, equip_slot: c.pick(['main_hand', 'body']) },
    ItemAttunementChanged: { item_id: itemId, actor_id: c.pick([ownerId, undefined]), attuned: c.pick([true, false, 'yes', 0]) },
    ItemTransferred: { item_id: itemId, from_actor_id: ownerId, to_actor_id: c.pick([other, 'npc-trader', ownerId]), quantity: c.pick([1, 2, '3', -5, 'x']), item: c.pick(inventory.length ? inventory : [{}]), stackable: c.pick([true, false, undefined]) },
    ItemChargesSpent: { item_id: itemId, before: 3, spent: 1, after: c.pick([2, 0, -1, '1', 99]), max: c.pick([3, '7', -2, undefined]) },
    ItemDestroyed: { schema_version: c.pick([1, '1', 2, undefined]), owner_id: c.pick([ownerId, undefined]), item_id: itemId },
    MagicItemActivationChanged: { schema_version: c.pick([1, 1, '1', 0]), owner_id: c.pick([ownerId, undefined]), item_id: itemId, activated: c.pick([true, false, 'yes']) },
    Other: { item_id: itemId },
  }
  const event = {
    event_type: type,
    event_schema_version: c.pick([1, 1, '1', 2, undefined]),
    payload: c.chance(0.03) ? c.pick([null, 'x', 5]) : payloads[type],
    target_ids: c.pick([[ownerId], [ownerId], undefined, ownerId ?? 'x', [], { 0: ownerId }]),
    actor_id: c.pick([ownerId, undefined]),
  }
  return viaJson(event)
}

let randomStates = 0
for (let index = 0; index < 130; index += 1) {
  let state = randomState(index)
  randomStates += 1
  if (index < 80) stateBattery(state, { deep: false })
  for (let step = 0; step < 12; step += 1) {
    const command = randomCommand(state)
    const players = commandChain(command, state, randomContext(command), { retention: c.chance(0.1) ? 'legacy' : 'current' })
    if (players && c.chance(0.8)) state = { ...state, players }
    if (c.chance(0.35)) {
      const applied = run('applyItemLifecycleEventToPlayers', [state.players, randomEvent(state)])
      if (Array.isArray(applied.value) && c.chance(0.5)) state = { ...state, players: applied.value }
    }
  }
  for (const player of (Array.isArray(state.players) ? state.players : []).slice(0, 3)) {
    actorBattery(player, (Array.isArray(player?.inventory) ? player.inventory : []).map((item) => item?.id).filter((id) => id != null))
  }
  if (c.chance(0.05)) run('applyItemLifecycleEventToPlayers', [c.pick([undefined, 'x', {}]), randomEvent(state)])
}

// Редкие ветки проверки: заряды, предел настройки, щит и двуручное оружие,
// включение, пределы инвентаря и стопки получателя.
const item = (id, instance) => catalog.materializeCatalogItem(id, { quantity: 1, ...instance })
const RATION = CATALOG_IDS.find((id) => catalog.catalogItem(id)?.use?.kind === 'ration')
const SHIELD = CATALOG_IDS.find((id) => catalog.catalogItem(id)?.equip?.armor?.kind === 'shield')
const TWO_HANDED = CATALOG_IDS.find((id) => catalog.catalogItem(id)?.combat?.twoHanded === true || catalog.catalogItem(id)?.combat?.properties?.includes?.('two-handed'))
function party(inventory, { combat = false, mate = [], npcInventory, npcOwners = 0, economy } = {}) {
  const inventories = Object.fromEntries(Array.from({ length: npcOwners }, (_, i) => [`npc-${i}`, [item('srd_5_2_1:torch', { id: `t-${i}` })]]))
  if (npcInventory) inventories['npc-trader'] = npcInventory
  return viaJson({
    ruleset_id: 'dnd_5e_2014',
    players: [{ id: 'hero', name: 'Герой', abilities: { str: 10, dex: 14 }, inventory }, { id: 'mate', name: 'Спутник', abilities: { str: 1, dex: 10 }, inventory: mate }],
    partyMemberIds: ['hero', 'mate'],
    mechanics: { combat: { active: combat, ...(economy ? { action_economy: { hero: economy } } : {}) } },
    enemies: [{ id: 'goblin-1' }],
    scene: { location_id: 'loc-market' },
    social: { npcs: [{ id: 'npc-trader', name: 'Торговка', location_id: 'loc-market' }] },
    npc_world: { placements: [{ npc_id: 'npc-trader', location_id: 'loc-market', x: 1, y: 1 }], inventories },
  })
}
const admin = { allowedActorIds: ['hero'] }
const command = (type, itemId, extra = {}) => ({ command_type: type, command_id: `cmd-${type}-${itemId}`, actor_id: 'hero', item_id: itemId, ...extra })
const targeted = [
  [command('UseItem', 'kit', {}), party([item('srd_5_2_1:healers-kit', { id: 'kit', charges: { current: 0 } })])],
  [command('UseItem', 'kit', {}), party([item('srd_5_2_1:healers-kit', { id: 'kit', charges: { current: 2 } })])],
  [command('UseItem', 'kit', { target_id: 'mate' }), party([item('srd_5_2_1:healers-kit', { id: 'kit' })])],
  ...[undefined, 0, 1, 3, 4, '2', 'x'].map((spend) => [command('UseItem', 'wand', { target_id: 'goblin-1', charges_to_spend: spend }), party([item('srd_5_2_1:wand-of-magic-missiles', { id: 'wand', equipped: true, charges: { current: 2 } })], { combat: true })]),
  [command('UseItem', 'wand', { target_id: 'mate', charges_to_spend: 1 }), party([item('srd_5_2_1:wand-of-magic-missiles', { id: 'wand', equipped: true })], { combat: true })],
  ...(RATION ? [[command('UseItem', 'ration'), party([item(RATION, { id: 'ration' })], { combat: true })], [command('UseItem', 'ration'), party([item(RATION, { id: 'ration' })])]] : []),
  [command('AttuneItem', 'r4'), party([
    item('srd_5_2_1:ring-of-protection', { id: 'r1', attuned_to: 'hero' }), item('srd_5_2_1:cloak-of-protection', { id: 'r2', attuned_to: 'hero' }),
    item('srd_5_2_1:brooch-of-shielding', { id: 'r3', attuned_to: 'hero' }), item('srd_5_2_1:weapon-of-warning-longsword', { id: 'r4' }),
  ])],
  [command('AttuneItem', 'r2'), party([item('srd_5_2_1:ring-of-protection', { id: 'r1', attuned_to: 'hero' }), item('srd_5_2_1:ring-of-protection', { id: 'r2' })])],
  [command('AttuneItem', 'r1'), party([item('srd_5_2_1:ring-of-protection', { id: 'r1', attuned_to: 'mate' })])],
  [command('AttuneItem', 'r1', { attuned: false }), party([item('srd_5_2_1:ring-of-protection', { id: 'r1', attuned_to: 'hero', activated: true })])],
  [command('AttuneItem', 'r1'), party([item('srd_5_2_1:ring-of-protection', { id: 'r1' }), null])],
  ...[true, false].flatMap((activated) => [
    [command('ActivateItem', 'flame', { activated }), party([item('srd_5_2_1:flame-tongue-longsword', { id: 'flame', equipped: true, attuned_to: 'hero', activated: !activated })])],
    [command('ActivateItem', 'flame', { activated }), party([item('srd_5_2_1:flame-tongue-longsword', { id: 'flame', equipped: true, attuned_to: 'hero', activated })])],
    [command('ActivateItem', 'flame', { activated }), party([item('srd_5_2_1:flame-tongue-longsword', { id: 'flame', equipped: true })])],
    [command('ActivateItem', 'flame', { activated }), party([item('srd_5_2_1:flame-tongue-longsword', { id: 'flame', attuned_to: 'hero' })])],
  ]),
  ...(SHIELD && TWO_HANDED ? [
    [command('EquipItem', 'big'), party([item(SHIELD, { id: 'shield', equipped: true }), item(TWO_HANDED, { id: 'big' })], { combat: true })],
    [command('EquipItem', 'big'), party([item(SHIELD, { id: 'shield', equipped: true }), item(TWO_HANDED, { id: 'big' })], { combat: true, economy: { object_interaction: false } })],
    [command('EquipItem', 'big'), party([{ id: 'old-shield', name: 'Щит', type: 'armor', equipped: true, armor_profile: { kind: 'shield' } }, item(TWO_HANDED, { id: 'big' })], { combat: true })],
    [command('EquipItem', 'big', { equipped: false }), party([item(SHIELD, { id: 'shield', equipped: true }), item(TWO_HANDED, { id: 'big', equipped: true })], { combat: true })],
    [command('EquipItem', 'shield'), party([item(SHIELD, { id: 'shield' })], { combat: true })],
  ] : []),
  [command('TransferItem', 'torch', { recipient_id: 'mate' }), party([item('srd_5_2_1:torch', { id: 'torch' })], { mate: Array.from({ length: 200 }, (_, i) => item('srd_5_2_1:dagger', { id: `d-${i}` })) })],
  [command('TransferItem', 'torch', { recipient_id: 'mate' }), party([item('srd_5_2_1:torch', { id: 'torch' })], { mate: [item('srd_5_2_1:torch', { id: 'm-torch', quantity: 999999 })] })],
  [command('TransferItem', 'torch', { recipient_id: 'mate' }), party([item('srd_5_2_1:torch', { id: 'torch' })], { mate: [item('srd_5_2_1:torch', { id: 'm-torch', quantity: 3 })] })],
  [command('TransferItem', 'torch', { recipient_id: 'mate' }), party([item('srd_5_2_1:torch', { id: 'torch' })], { mate: { length: 300 } })],
  [command('TransferItem', 'torch', { recipient_id: 'mate' }), party([item('srd_5_2_1:torch', { id: 'torch' })], { mate: 'x'.repeat(201) })],
  [command('TransferItem', 'torch', { recipient_id: 'npc-trader' }), party([item('srd_5_2_1:torch', { id: 'torch' })], { npcInventory: Array.from({ length: 100 }, (_, i) => item('srd_5_2_1:dagger', { id: `nd-${i}` })) })],
  [command('TransferItem', 'torch', { recipient_id: 'npc-trader' }), party([item('srd_5_2_1:torch', { id: 'torch' })], { npcOwners: 500 })],
  [command('TransferItem', 'torch', { recipient_id: 'npc-trader' }), party([item('srd_5_2_1:torch', { id: 'torch' })], { npcOwners: 499 })],
  [command('TransferItem', 'torch', { recipient_id: 'npc-trader' }), party([item('srd_5_2_1:torch', { id: 'torch', quantity: 3 })], { npcInventory: [item('srd_5_2_1:torch', { id: 'n-torch', quantity: 2 })] })],
]
for (const [targetCommand, targetState] of targeted) {
  for (const mode of ['current', 'legacy']) commandChain(targetCommand, targetState, admin, { retention: mode, perOutcome: Infinity })
  for (const player of targetState.players) actorBattery(player, Array.isArray(player.inventory) ? player.inventory.map((entry) => entry?.id) : [])
}

// Мусор в аргументах верхнего уровня.
for (const value of [...GARBAGE, undefined]) {
  run('inventoryWeight', [value])
  run('inventoryLoadFor', [value])
  run('activeItemEffectTotals', [value])
  run('equippedShieldBonus', [value])
  run('derivedEquipmentArmorClass', [value])
  run('itemProfileFor', [value])
  run('weaponDamageRidersForItem', [value, 'x'])
  run('validateItemLifecycleCommand', [value, { players: [] }])
  run('validateItemLifecycleCommand', [{ command_type: 'EquipItem', actor_id: 'a', item_id: 'b' }, value])
  run('itemLifecycleEvents', [value])
  run('applyItemLifecycleEventToPlayers', [[], value])
  for (const type of TYPES) run('itemLifecycleEvents', [{ command_type: type, actor_id: 'a', item_id: 'b', activation_profile: value }])
}

console.log(`корпус: состояний ${corpusStates}; случайных отрядов ${randomStates}`)
writer.write(new URL('item-lifecycle.json', import.meta.url))
