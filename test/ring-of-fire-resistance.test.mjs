import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { ITEM_CATALOG, itemViewerCapabilities, materializeCatalogItem } from '../server/item-catalog.mjs'
import { ItemLifecycleValidationError, activeItemMechanicEffects, validateItemLifecycleCommand } from '../server/item-lifecycle.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { mechanicsForViewer } from '../server/viewer-projection.mjs'

const CATALOG_ID = 'srd_5_2_1:ring-of-fire-resistance'
const diceService = new DiceService({
  rng: new SequenceDiceRng([]),
  idFactory: () => 'ring-fire-resistance-roll',
  now: () => '2026-07-31T12:00:00.000Z',
})

function campaignState({ heroInventory = [], enemyInventory = [] } = {}) {
  return normalizeCampaignState({
    sessionCode: 'RING-FIRE-RESISTANCE',
    partyMemberIds: ['hero'],
    players: [{
      id: 'hero',
      character: 'Испытатель',
      hp: 30,
      maxHp: 30,
      armor: 14,
      abilities: { str: 10, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
      x: 0,
      y: 0,
      inventory: heroInventory,
    }],
    enemies: [{
      id: 'foe',
      name: 'Огненный дух',
      hp: 30,
      maxHp: 30,
      armor: 12,
      alive: true,
      abilities: { str: 10, dex: 12, con: 12, int: 8, wis: 10, cha: 8 },
      x: 1,
      y: 0,
      inventory: enemyInventory,
    }],
    scene: {
      turn: 1,
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: true },
        { x: 1, y: 0, type: 'floor', revealed: true },
      ],
    },
    mechanics: {
      positions: { hero: { x: 0, y: 0 }, foe: { x: 1, y: 0 } },
      combat: { active: false },
    },
  })
}

function damage(state, targetId, damageType = 'fire', commandId = `damage-${targetId}-${damageType}`) {
  return resolveCommand({
    command_type: 'ApplyDamage',
    command_id: commandId,
    actor_id: targetId === 'hero' ? 'foe' : 'hero',
    target_id: targetId,
    amount: 9,
    damage_type: damageType,
  }, state, { diceService, context: { isAdmin: true } })
}

function damageEvent(result) {
  return result.events.find((event) => event.event_type === 'DamageApplied')
}

test('Кольцо сопротивления (огонь) имеет точный SRD 5.2.1 профиль без настройки', () => {
  const entry = ITEM_CATALOG[CATALOG_ID]
  assert.ok(entry)
  assert.equal(entry.name, 'Кольцо сопротивления (огонь)')
  assert.equal(entry.rarity, 'редкий')
  assert.equal(entry.magic_item.rarity, 'rare')
  assert.equal(entry.magic_item.variant, 'fire')
  assert.equal(entry.source_page, 237)
  assert.equal(entry.attunement.required, false)
  assert.deepEqual(entry.availability, { shop: false, loot: false, crafting: false })
  assert.equal(entry.mechanics_status, 'partial')
  assert.match(entry.limitation, /общим серверным damage pipeline/u)

  const item = materializeCatalogItem(CATALOG_ID, {
    id: 'fire-ring',
    passive_effects: [{ schema_version: 1, effect_id: 'forged', group: 'forged', damage_resistances: ['all'] }],
  })
  assert.deepEqual(item.passive_effects, entry.passive_effects)
  assert.equal(item.requires_attunement, undefined)
  assert.deepEqual(itemViewerCapabilities(item), {
    equippable: true,
    equip_slot: 'ring-fire-resistance',
    usable: false,
    use: null,
    charges: null,
    recharge: null,
    requires_attunement: false,
    mechanics_status: 'partial',
    limitation: entry.limitation,
  })

  const state = campaignState({ heroInventory: [item] })
  assert.throws(() => validateItemLifecycleCommand({
    command_type: 'AttuneItem', actor_id: 'hero', item_id: 'fire-ring', attuned: true,
  }, state, { allowedActorIds: ['hero'] }), (error) => (
    error instanceof ItemLifecycleValidationError && error.code === 'ITEM_NOT_ATTUNABLE'
  ))
})

test('сопротивление огню действует только для надетого кольца и не требует настройки', () => {
  const stored = materializeCatalogItem(CATALOG_ID, { id: 'fire-ring', equipped: false })
  const inactive = damage(campaignState({ heroInventory: [stored] }), 'hero')
  assert.equal(damageEvent(inactive).payload.applied_amount, 9)
  assert.equal((damageEvent(inactive).payload.item_resistance_sources ?? []).length, 0)

  const worn = { ...stored, equipped: true, attuned_to: null }
  const activeState = campaignState({ heroInventory: [worn] })
  const fire = damage(activeState, 'hero')
  assert.equal(damageEvent(fire).payload.raw_amount, 9)
  assert.equal(damageEvent(fire).payload.applied_amount, 4)
  assert.equal(damageEvent(fire).payload.resistant, true)
  assert.deepEqual(damageEvent(fire).payload.item_resistance_sources.map((source) => source.catalog_id), [CATALOG_ID])
  assert.deepEqual(activeItemMechanicEffects(activeState.players[0])[0].damage_resistances, ['fire'])

  const cold = damage(activeState, 'hero', 'cold')
  assert.equal(damageEvent(cold).payload.applied_amount, 9)
  assert.equal((damageEvent(cold).payload.item_resistance_sources ?? []).length, 0)
})

test('кольцо сохраняет результат при retry, replay и reopen Event Store', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-ring-fire-resistance-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const initial = campaignState({
    heroInventory: [{ ...materializeCatalogItem(CATALOG_ID, { id: 'fire-ring' }), equipped: true }],
  })
  const resolution = damage(initial, 'hero', 'fire', 'ring-fire-idempotent')
  const expected = replayEvents(initial, resolution.events)
  assert.deepEqual(expected, resolution.events.reduce((state, event) => applyGameEvent(state, event), initial))

  const store = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await store.initializeCampaign({ campaign_id: 'ring-fire', initial_state: initial })
  const request = {
    campaign_id: 'ring-fire',
    expected_state_version: 0,
    idempotency_key: 'ring-fire-idempotent',
    command_id: 'ring-fire-idempotent',
    events: resolution.events,
  }
  const committed = await store.commit(request)
  const retry = await store.commit(request)
  assert.equal(retry.duplicate, true)
  assert.equal(retry.state_version, committed.state_version)
  assert.equal(retry.state.players[0].hp, 26)

  const reopened = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  const restored = await reopened.replay('ring-fire', { use_snapshots: false })
  assert.deepEqual(restored.state, committed.state)
})

test('поддельный passive effect не даёт сопротивление и источник врага не утекает игроку', () => {
  const forged = {
    id: 'forged-ring',
    catalog_id: 'unknown:ring-of-fire-resistance',
    name: 'Поддельное кольцо',
    type: 'other',
    quantity: 1,
    equipped: true,
    passive_effects: [{
      schema_version: 1,
      effect_id: 'forged-fire-resistance',
      group: 'forged-fire-resistance',
      requires_equipped: true,
      damage_resistances: ['fire'],
    }],
  }
  assert.equal(damageEvent(damage(campaignState({ heroInventory: [forged] }), 'hero')).payload.applied_amount, 9)

  const altered = { ...materializeCatalogItem(CATALOG_ID, { id: 'altered-ring' }), equipped: true }
  altered.passive_effects[0].damage_resistances = ['cold']
  assert.equal(damageEvent(damage(campaignState({ heroInventory: [altered] }), 'hero')).payload.applied_amount, 9)

  const hidden = { ...materializeCatalogItem(CATALOG_ID, { id: 'hidden-fire-ring' }), equipped: true }
  const state = campaignState({ enemyInventory: [hidden] })
  const event = damageEvent(damage(state, 'foe'))
  const projected = mechanicsForViewer([event], { role: 'player', heroIds: ['hero'] }, 'hero', state)
  assert.equal(projected[0].payload.resistant, true)
  assert.equal(projected[0].payload.item_resistance_sources, undefined)
  assert.doesNotMatch(JSON.stringify(projected), /hidden-fire-ring|ring-of-fire-resistance|Кольцо сопротивления/u)
  assert.match(JSON.stringify(mechanicsForViewer([event], { role: 'admin' }, 'hero', state)), /ring-of-fire-resistance/u)
})
