import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import {
  MAX_NPC_INVENTORY_ITEMS,
  normalizeNpcWorldState,
} from '../server/npc-positioning.mjs'
import {
  RulesValidationError,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
  resolveCommand,
} from '../server/rules-engine.mjs'
import {
  createTacticalMap,
  serializeTacticalMap,
  setCell,
} from '../server/tactical-map.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

function dice() {
  return new DiceService({
    rng: new SequenceDiceRng([]),
    idFactory: () => 'npc-transfer-roll',
    now: () => '2026-07-31T12:00:00.000Z',
  })
}

function sceneMap() {
  const map = createTacticalMap({
    width: 4,
    height: 4,
    locationId: 'market',
    seed: 'npc-item-transfer',
  })
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      setCell(map, x, y, { passable: true, revealed: true, material: 'stone' })
    }
  }
  return serializeTacticalMap(map)
}

function campaign({
  combat = false,
  placed = true,
  alive = true,
  npcAvailable = true,
  npcLocation = 'Рынок',
  npcVisibility = 'party',
  npcInventory = [],
} = {}) {
  return normalizeCampaignState({
    state_version: 0,
    sessionCode: 'NPC-TRANSFER',
    activePlayerId: 'hero',
    partyMemberIds: ['hero'],
    scene: {
      title: 'Рынок',
      location: 'Рынок',
      location_id: 'market',
      map: sceneMap(),
    },
    players: [{
      id: 'hero',
      character: 'Лира',
      hp: 16,
      maxHp: 16,
      armor: 14,
      abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
      inventory: [{
        id: 'ration',
        catalog_id: 'srd_5_2_1:rations-one-day',
        name: 'Сухой паёк',
        type: 'consumable',
        quantity: 4,
        weight: 2,
      }],
    }],
    social: {
      npcs: [{
        id: 'marta',
        name: 'Марта',
        role: 'трактирщица',
        location: npcLocation,
        visibility: npcVisibility,
        available: npcAvailable,
      }],
      relationships: {},
      conversations: [],
      promises: [],
    },
    npc_world: {
      schema_version: 1,
      placements: placed ? [{
        npc_id: 'marta',
        location_id: 'market',
        x: 2,
        y: 2,
        placement_reason: 'test',
      }] : [],
      vitals: { marta: { hp: alive ? 4 : 0, max_hp: 4, alive } },
      stances: {},
      inventories: npcInventory.length ? { marta: npcInventory } : {},
    },
    mechanics: combat ? {
      combat: {
        active: true,
        round: 1,
        initiative: [{ actor_id: 'hero' }],
        active_index: 0,
        action_economy: {
          hero: { action: true, bonus_action: true, reaction: true, movement_spent: 0 },
        },
      },
    } : {},
  })
}

function resolveTransfer(state, {
  allowedActorIds = ['hero'],
  commandId = 'transfer-to-marta',
  quantity = 2,
} = {}) {
  return resolveCommand({
    command_type: 'TransferItem',
    command_id: commandId,
    actor_id: 'hero',
    item_id: 'ration',
    recipient_id: 'marta',
    quantity,
  }, state, {
    diceService: dice(),
    context: { allowedActorIds },
  })
}

test('TransferItem атомарно убирает предмет у владельца и сохраняет его в npc_world', () => {
  const initial = campaign()
  const result = resolveTransfer(initial)

  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].event_type, 'ItemTransferred')
  assert.equal(result.events[0].payload.recipient_kind, 'npc')
  assert.equal(result.events[0].payload.to_actor_id, 'marta')

  const next = result.events.reduce(applyGameEvent, initial)
  assert.equal(next.players[0].inventory[0].quantity, 2)
  assert.equal(next.npc_world.schema_version, 3)
  assert.equal(next.npc_world.inventories.marta.length, 1)
  assert.equal(next.npc_world.inventories.marta[0].quantity, 2)
  assert.deepEqual(replayEvents(initial, result.events), next)
})

test('player projection не раскрывает накопленный инвентарь NPC', () => {
  const initial = campaign({
    npcInventory: [{
      id: 'server-secret',
      name: 'Секретная связка ключей',
      type: 'quest',
      quantity: 1,
      description: 'Не должно попасть игроку',
    }],
  })
  const next = resolveTransfer(initial).events.reduce(applyGameEvent, initial)
  const projected = campaignStateForViewer(next, { role: 'player' }, 'hero')

  assert.equal(projected.npc_world, undefined)
  assert.equal(projected.scene_npcs[0].inventory, undefined)
  assert.doesNotMatch(JSON.stringify(projected), /server-secret|Секретная связка ключей|inventories/u)
})

test('NPC-получатель обязан быть живым, viewer-visible и иметь пост в текущей сцене', () => {
  for (const [options, code] of [
    [{ placed: false }, 'NPC_ITEM_RECIPIENT_NOT_VISIBLE'],
    [{ npcVisibility: 'gm_only' }, 'NPC_ITEM_RECIPIENT_NOT_VISIBLE'],
    [{ npcLocation: 'Другая локация' }, 'NPC_ITEM_RECIPIENT_NOT_VISIBLE'],
  ]) {
    assert.throws(
      () => resolveTransfer(campaign(options)),
      (error) => error instanceof RulesValidationError && error.code === code,
    )
  }
  assert.throws(
    () => resolveTransfer(campaign({ npcAvailable: false })),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_ITEM_RECIPIENT_UNAVAILABLE',
  )
  assert.throws(
    () => resolveTransfer(campaign({ alive: false })),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_ITEM_RECIPIENT_DEAD',
  )
  for (const hidden of [
    { npcVisibility: 'gm_only', npcAvailable: false },
    { npcVisibility: 'gm_only', alive: false },
    { npcLocation: 'Другая локация', alive: false },
    { placed: false, alive: false },
  ]) {
    assert.throws(
      () => resolveTransfer(campaign(hidden)),
      (error) => error instanceof RulesValidationError && error.code === 'NPC_ITEM_RECIPIENT_NOT_VISIBLE',
    )
  }
  assert.throws(
    () => resolveCommand({
      command_type: 'TransferItem',
      command_id: 'unknown-recipient',
      actor_id: 'hero',
      item_id: 'ration',
      recipient_id: 'unknown-npc',
      quantity: 1,
    }, campaign(), {
      diceService: dice(),
      context: { allowedActorIds: ['hero'] },
    }),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_ITEM_RECIPIENT_NOT_VISIBLE',
  )
})

test('ACL владельца и запрет передачи в бою применяются до мутации', () => {
  assert.throws(
    () => resolveTransfer(campaign(), { allowedActorIds: ['other'] }),
    (error) => error instanceof RulesValidationError && error.code === 'ACTOR_FORBIDDEN',
  )
  assert.throws(
    () => resolveTransfer(campaign({ combat: true })),
    (error) => error instanceof RulesValidationError && error.code === 'ITEM_TRANSFER_DURING_COMBAT',
  )
})

test('bounded NPC inventory объединяет стопки и отклоняет сто первый вид предмета', () => {
  const matching = {
    id: 'old-ration',
    catalog_id: 'srd_5_2_1:rations-one-day',
    name: 'Сухой паёк',
    type: 'consumable',
    quantity: 3,
    weight: 2,
  }
  const mergeState = campaign({ npcInventory: [matching] })
  const merged = resolveTransfer(mergeState).events.reduce(applyGameEvent, mergeState)
  assert.equal(merged.npc_world.inventories.marta.length, 1)
  assert.equal(merged.npc_world.inventories.marta[0].quantity, 5)

  const fullInventory = Array.from({ length: MAX_NPC_INVENTORY_ITEMS }, (_, index) => ({
    id: `keepsake-${index}`,
    name: `Памятная вещь ${index}`,
    type: 'other',
    quantity: 1,
  }))
  assert.throws(
    () => resolveTransfer(campaign({ npcInventory: fullInventory })),
    (error) => error instanceof RulesValidationError && error.code === 'NPC_INVENTORY_CAPACITY_EXCEEDED',
  )
})

test('legacy npc_world v1 нормализуется в bounded v3 и replay остаётся точным', () => {
  const legacy = {
    schema_version: 1,
    placements: [{
      npc_id: 'marta',
      location_id: 'market',
      x: 2,
      y: 2,
      placement_reason: 'legacy',
    }],
    vitals: {},
    stances: {},
  }
  const upgraded = normalizeNpcWorldState(legacy)
  assert.equal(upgraded.schema_version, 3)
  assert.deepEqual(upgraded.inventories, {})

  const initial = campaign()
  const result = resolveTransfer(initial, { commandId: 'legacy-replay' })
  const next = result.events.reduce(applyGameEvent, initial)
  assert.deepEqual(replayEvents(initial, result.events), next)
})

test('клиент не может подделать вычисляемый сервером recipient_kind', () => {
  assert.throws(
    () => resolveCommand({
      command_type: 'TransferItem',
      command_id: 'forged-recipient-kind',
      actor_id: 'hero',
      item_id: 'ration',
      recipient_id: 'marta',
      recipient_kind: 'hero',
      quantity: 2,
    }, campaign(), {
      diceService: dice(),
      context: { allowedActorIds: ['hero'] },
    }),
    (error) => error instanceof RulesValidationError && error.code === 'ITEM_COMMAND_UNKNOWN_FIELD',
  )
})

test('повтор commit с тем же idempotency_key не передаёт предмет NPC дважды', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-npc-transfer-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const initial = campaign()
  const resolved = resolveTransfer(initial, { commandId: 'transfer-idempotent' })
  const store = new FileEventStore({
    rootDir,
    reducer: applyGameEvent,
    normalizeState: normalizeCampaignState,
  })
  await store.initializeCampaign({ campaign_id: 'npc-transfer', initial_state: initial })
  const request = {
    campaign_id: 'npc-transfer',
    expected_state_version: 0,
    idempotency_key: 'same-npc-transfer',
    command_id: 'transfer-idempotent',
    events: resolved.events,
  }

  const first = await store.commit(request)
  const retry = await store.commit(request)
  const replayed = await store.replay('npc-transfer')

  assert.equal(first.state.players[0].inventory[0].quantity, 2)
  assert.equal(first.state.npc_world.inventories.marta[0].quantity, 2)
  assert.equal(retry.duplicate, true)
  assert.equal(retry.state.players[0].inventory[0].quantity, 2)
  assert.equal(retry.state.npc_world.inventories.marta[0].quantity, 2)
  assert.deepEqual(replayed.state, first.state)
})
