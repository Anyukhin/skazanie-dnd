import assert from 'node:assert/strict'
import test from 'node:test'

import { createSceneTransition } from '../server/adventure-director.mjs'
import { buildDirectorTransitionCommands } from '../server/director-scene-transition.mjs'
import { locationsMatch, merchantIsAtLocation } from '../server/merchant-economy.mjs'
import { assembleShop } from '../server/shop-assembler.mjs'
import { createCampaignWorldMap, reconcileWorldMap, worldLocationById } from '../server/world-map.mjs'

function twinMarketMap() {
  return createCampaignWorldMap({
    seed: 'LOCATION-IDENTITY-1',
    campaignName: 'Identity test',
    startingLocation: 'Twin Market',
    startingLocationId: 'market-west',
    source: {
      locations: [
        { id: 'market-east', name: 'Twin Market', kind: 'town', x: 300, y: 280 },
        { id: 'market-west', name: 'Twin Market', kind: 'town', x: 650, y: 310 },
      ],
    },
  })
}

function state(overrides = {}) {
  const worldMap = twinMarketMap()
  return {
    sessionCode: 'LOCATION-IDENTITY-1',
    campaign: 'Identity test',
    state_version: 4,
    worldMap,
    scene: { title: 'Market', location: 'Twin Market', location_id: 'market-west', objective: 'Leave', turn: 1, cells: [] },
    adventure: { chapter: 1, history: [], visitedLocations: ['Twin Market'], visitedLocationIds: ['market-west'] },
    merchants: [],
    agentInteraction: {
      id: 'location-vote', type: 'vote', status: 'resolved', resolvedOptionId: 'east',
      options: [{ id: 'east', label: 'Travel east' }], votes: { hero: 'east' },
    },
    ...overrides,
  }
}

const eastScene = {
  title: 'Eastern Twin Market',
  location: 'Incorrect label must not override an ID',
  location_id: 'market-east',
  theme: 'city streets',
  objective: 'Find supplies',
  seed: 'east-market',
  map: { layout: 'streets', width: 11, height: 9 },
}

test('world map selects and links duplicate labels by canonical location_id', () => {
  const map = twinMarketMap()
  assert.equal(map.currentLocationId, 'market-west')
  assert.equal(worldLocationById(map, 'market-east')?.name, 'Twin Market')

  const updated = reconcileWorldMap(map, {
    campaignName: 'Identity test',
    currentLocation: 'Twin Market',
    currentLocationId: 'market-east',
    previousLocation: 'Twin Market',
    previousLocationId: 'market-west',
    knownLocations: ['Twin Market'],
    transition: 'Travel east',
  })
  assert.equal(updated.currentLocationId, 'market-east')
  assert.ok(updated.routes.some((route) => route.from === 'market-west' && route.to === 'market-east'
    || route.from === 'market-east' && route.to === 'market-west'))
})

test('scene transitions retain a canonical location_id and prior history identity', () => {
  const transition = createSceneTransition(eastScene, state())
  assert.equal(transition.scene.location_id, 'market-east')
  assert.equal(transition.scene.location, 'Twin Market')
  assert.equal(transition.adventure.history.at(-1).location_id, 'market-west')
  assert.ok(transition.adventure.visitedLocationIds.includes('market-east'))
})

test('merchant location matching prioritizes IDs and falls back to legacy labels', () => {
  assert.equal(locationsMatch(
    { location: 'Twin Market', location_id: 'market-west' },
    { location: 'Twin Market', location_id: 'market-east' },
  ), false)
  assert.equal(merchantIsAtLocation(
    { location: 'Twin Market', location_id: 'market-west' },
    { location: 'Twin Market', location_id: 'market-east' },
  ), false)
  assert.equal(merchantIsAtLocation(' TWIN   MARKET ', { location: 'twin market', location_id: 'market-east' }), true)
})

test('shop proposals bind merchant identity to location_id', () => {
  const common = { location: 'Twin Market', settlement_type: 'town', theme: 'general', seed: 'shop-location-id', budget_cp: 20_000 }
  const east = assembleShop({ ...common, location_id: 'market-east' })
  const west = assembleShop({ ...common, location_id: 'market-west' })
  assert.equal(east.merchant.location_id, 'market-east')
  assert.notEqual(east.merchant.id, west.merchant.id)
})

test('director transition creates or reuses a shop using location_id before the duplicate label', () => {
  const westMerchant = { id: 'west-shop', location: 'Twin Market', location_id: 'market-west', stock: [] }
  const created = buildDirectorTransitionCommands({
    campaignId: 'LOCATION-IDENTITY-1', action: 'travel east', state: state({ merchants: [westMerchant] }), sceneArgs: eastScene,
    shopIntent: { action: 'create', settlement_type: 'city', theme: 'general', budget_cp: 20_000 },
  })
  assert.deepEqual(created.commands.map((command) => command.command_type), ['AdvanceTime', 'AdvanceScene', 'CreateMerchant'])
  assert.equal(created.commands[1].scene_args.location_id, 'market-east')
  assert.equal(created.commands[2].merchant.location_id, 'market-east')

  const eastMerchant = { id: 'east-shop', location: 'Twin Market', location_id: 'market-east', stock: [] }
  const reused = buildDirectorTransitionCommands({
    campaignId: 'LOCATION-IDENTITY-1', action: 'return east', state: state({ merchants: [eastMerchant] }), sceneArgs: eastScene,
    shopIntent: { action: 'create', settlement_type: 'city', theme: 'general', budget_cp: 20_000 },
  })
  assert.deepEqual(reused.commands.map((command) => command.command_type), ['AdvanceTime', 'AdvanceScene'])
  assert.equal(reused.existingMerchantId, 'east-shop')
})
