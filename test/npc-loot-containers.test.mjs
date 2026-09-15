import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  NPC_LOOT_PAYLOAD_SCHEMA_VERSION,
  NPC_LOOT_SOURCE,
  applyLootContainerEvent,
  lootCommitTouchesContainers,
  lootContainerList,
  planLootContainerDrafts,
} from '../server/loot-containers.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommands } from '../server/rules-engine.mjs'

function state({ inventory = [], level = 0, withCombatActor = false, socialInventory = [] } = {}) {
  return {
    scene: { location: 'Рынок', location_id: 'market', level: { index: level } },
    mechanics: {
      world_time: { elapsed_minutes: 120 },
      positions: withCombatActor ? { marta: { x: 8, y: 4 } } : {},
    },
    social: {
      npcs: [{ id: 'marta', name: 'Марта', inventory: socialInventory }],
    },
    npc_world: {
      schema_version: 3,
      placements: [{ npc_id: 'marta', location_id: 'market', x: 2, y: 3 }],
      vitals: { marta: { hp: 4, max_hp: 4, alive: true } },
      stances: {},
      inventories: inventory.length ? { marta: inventory } : {},
    },
    enemies: withCombatActor ? [{
      id: 'marta', name: 'Марта', hp: 4, alive: true,
      origin: { kind: 'authored-npc', npc_id: 'marta' },
      loadout: { items: [] },
    }] : [],
    loot_containers: { schema_version: 1, containers: [] },
  }
}

function death() {
  return {
    event_type: 'NpcDied',
    event_id: 'npc-died:marta',
    payload: { npc_id: 'marta', npc_name: 'Марта' },
    target_ids: ['marta'],
  }
}

function knownItem(overrides = {}) {
  return {
    id: 'marta-item',
    catalog_id: 'srd_5_2_1:dagger',
    name: 'Кинжал из снимка',
    type: 'weapon',
    quantity: 1,
    origin: 'gifted',
    ...overrides,
  }
}

function draftsFor(before, event = death()) {
  const after = structuredClone(before)
  after.npc_world.vitals.marta = { hp: 0, max_hp: 4, alive: false }
  return planLootContainerDrafts(before, after, [event])
}

test('NpcDied переносит только фактический npc_world inventory в тело на текущем этаже', () => {
  const before = state({
    level: 2,
    inventory: [knownItem({
      item_instance_id: 'marta-instance',
      snapshot: {
        catalog_id: 'srd_5_2_1:dagger', name: 'Кинжал Марты', type: 'weapon',
        weight: 1, description: 'Старый снимок',
      },
    })],
    socialInventory: [{ name: 'Меч из текста ведущего', type: 'weapon' }],
  })
  assert.equal(lootCommitTouchesContainers(before, [death()]), true)
  const drafts = draftsFor(before)
  assert.equal(drafts.length, 1)
  const created = drafts[0]
  assert.deepEqual(created.target_ids, ['marta'])
  assert.deepEqual(created.payload.npc_loot, {
    schema_version: NPC_LOOT_PAYLOAD_SCHEMA_VERSION,
    source: NPC_LOOT_SOURCE,
    npc_id: 'marta',
    part_index: 0,
    part_count: 1,
    clear_inventory: true,
  })
  const container = created.payload.container
  assert.equal(container.source_npc_id, 'marta')
  assert.equal(container.location_id, 'market@L2')
  assert.deepEqual({ x: container.x, y: container.y }, { x: 2, y: 3 })
  assert.equal(container.items[0].item_instance_id, 'marta-instance')
  assert.equal(container.items[0].snapshot.description, 'Старый снимок')
  assert.equal(container.items[0].origin.kind, 'gifted')
  assert.equal(container.items[0].owner.kind, 'container')
  assert.doesNotMatch(JSON.stringify(container), /Меч из текста/u)

  const reduced = structuredClone(before)
  applyLootContainerEvent(reduced, created)
  assert.equal(reduced.npc_world.inventories.marta, undefined)
  assert.equal(lootContainerList(reduced).length, 1)
  assert.equal(lootContainerList(reduced)[0].items[0].item_instance_id, 'marta-instance')

  const replayed = structuredClone(reduced)
  applyLootContainerEvent(replayed, created)
  assert.deepEqual(replayed, reduced, 'повтор создания не должен дублировать контейнер или стирать другое состояние')
})

test('raw origin сохраняет допустимый вид и источник экземпляра', () => {
  const before = state({ inventory: [knownItem({
    item_instance_id: 'marta-instance',
    origin: { kind: 'enemy_loadout', template_id: 'guard-v1', source_id: 'encounter-7' },
  })] })
  const [draft] = draftsFor(before)
  assert.deepEqual(draft.payload.container.items[0].origin, {
    kind: 'enemy_loadout', template_id: 'guard-v1', source_id: 'encounter-7',
  })
})

test('social NPC и его authored combat actor получают одно тело, привязанное к позиции боя', () => {
  const before = state({ inventory: [knownItem({ item_instance_id: 'marta-instance' })], withCombatActor: true })
  const drafts = draftsFor(before)
  assert.equal(drafts.length, 1)
  assert.deepEqual({ x: drafts[0].payload.container.x, y: drafts[0].payload.container.y }, { x: 8, y: 4 })
  assert.equal(drafts[0].payload.container.source_enemy_id, '')
  assert.equal(drafts[0].payload.container.source_npc_id, 'marta')
})

test('Rules Engine добавляет тело authored NPC в тот же commit, что и NpcDied', () => {
  const before = normalizeCampaignState({
    sessionCode: 'NPC-LOOT-ENGINE',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    scene: { title: 'Рынок', location: 'Рынок', location_id: 'market', turn: 1 },
    players: [{
      id: 'hero', character: 'Лира', hp: 16, maxHp: 16, armor: 14, speed: 30,
      abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 }, inventory: [], x: 7, y: 4,
    }],
    social: { npcs: [{ id: 'marta', name: 'Марта', location: 'Рынок', visibility: 'party', available: true }], relationships: {}, conversations: [], promises: [] },
    npc_world: {
      schema_version: 3,
      placements: [{ npc_id: 'marta', location_id: 'market', x: 8, y: 4 }],
      vitals: { marta: { hp: 4, max_hp: 4, alive: true } },
      stances: {},
      inventories: { marta: [knownItem({ id: 'marta-item', item_instance_id: 'marta-instance' })] },
    },
    enemies: [{ id: 'marta', name: 'Марта', hp: 4, maxHp: 4, alive: true, x: 8, y: 4, origin: { kind: 'authored-npc', npc_id: 'marta' }, loadout: [] }],
    mechanics: {
      positions: { hero: { x: 7, y: 4 }, marta: { x: 8, y: 4 } },
      combat: {
        active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero', total: 20 }],
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
  const result = resolveCommands([{
    command_type: 'ApplyDamage', command_id: 'kill-marta', actor_id: 'hero', target_id: 'marta', amount: 4, damage_type: 'slashing',
  }], before, {
    diceService: new DiceService({ rng: new SequenceDiceRng([]) }),
    context: { allowedActorIds: ['hero'], serverAuthoritativeCombat: true },
  })
  const deathIndex = result.events.findIndex((event) => event.event_type === 'NpcDied')
  const lootIndex = result.events.findIndex((event) => event.event_type === 'LootContainerCreated')
  assert.ok(deathIndex >= 0)
  assert.ok(lootIndex > deathIndex)
  assert.equal(result.events.filter((event) => event.event_type === 'LootContainerCreated').length, 1)
  assert.equal(result.state.npc_world.inventories.marta, undefined)
  assert.equal(result.state.loot_containers.containers[0].source_npc_id, 'marta')
  assert.deepEqual(result.state, result.events.reduce(applyGameEvent, before))
})

test('текстовый social inventory не создаёт механическую добычу', () => {
  const before = state({ socialInventory: [{ name: 'Меч из описания', type: 'weapon' }] })
  assert.equal(lootCommitTouchesContainers(before, [death()]), false)
  assert.deepEqual(draftsFor(before), [])
})

test('quantity больше лимита экземпляра разбивается без потери остатка', () => {
  const before = state({ inventory: [knownItem({ item_instance_id: 'marta-bolts', quantity: 2_500 })] })
  const drafts = draftsFor(before)
  assert.equal(drafts.length, 1)
  const items = drafts[0].payload.container.items
  assert.deepEqual(items.map((item) => item.quantity), [999, 999, 502])
  assert.equal(new Set(items.map((item) => item.item_instance_id)).size, 3)
  assert.equal(items[0].item_instance_id, 'marta-bolts')
  assert.equal(items.every((item) => item.snapshot.catalog_id === 'srd_5_2_1:dagger'), true)
  const reduced = drafts.reduce((current, draft) => {
    applyLootContainerEvent(current, draft)
    return current
  }, structuredClone(before))
  assert.equal(reduced.npc_world.inventories.marta, undefined)
  const replayed = drafts.reduce((current, draft) => {
    applyLootContainerEvent(current, draft)
    return current
  }, structuredClone(reduced))
  assert.deepEqual(replayed, reduced)
})

test('больше 24 сегментов разбивается на контейнеры без усечения', () => {
  const inventory = Array.from({ length: 25 }, (_, index) => knownItem({
    id: `marta-item-${index}`,
    item_instance_id: `marta-instance-${index}`,
  }))
  const before = state({ inventory })
  const drafts = draftsFor(before)
  assert.equal(drafts.length, 2)
  const containers = drafts.map((draft) => draft.payload.container)
  assert.deepEqual(containers.map((container) => container.items.length), [24, 1])
  assert.equal(new Set(containers.flatMap((container) => container.items.map((item) => item.item_instance_id))).size, 25)
  assert.deepEqual(drafts.map((draft) => draft.payload.npc_loot.part_index), [0, 1])
  assert.deepEqual(drafts.map((draft) => draft.payload.npc_loot.part_count), [2, 2])
})

test('неизвестная raw вещь сохраняется как явно неизвестная, без оружия из каталога', () => {
  const before = state({ inventory: [{ id: 'mystery', name: 'Непонятная реликвия', quantity: 1 }] })
  const [draft] = draftsFor(before)
  const item = draft.payload.container.items[0]
  assert.equal(item.snapshot.name, 'Непонятная реликвия')
  assert.notEqual(item.snapshot.type, 'weapon')
  assert.equal(item.origin.kind, 'unknown')
  assert.equal(draft.payload.npc_loot.unknown_items.length, 1)
  assert.match(item.catalog_id, /^npc-raw:/u)
})

test('реальная raw вещь сохраняет имя, механику и потраченные заряды вместо нового экземпляра каталога', () => {
  const before = state({ inventory: [knownItem({ name: 'Дарованный кинжал',
    combat: { kind: 'melee', damage: '1d4', damageType: 'piercing', attackBonus: 1 },
    charges: { current: 1, max: 3 }, quantity: 2,
  })] })
  const item = draftsFor(before)[0].payload.container.items[0]
  assert.equal(item.snapshot.name, 'Дарованный кинжал')
  assert.equal(item.snapshot.combat.attackBonus, 1)
  assert.deepEqual(item.charges, { current: 1, max: 3 })
  assert.equal(item.quantity, 2)
})
