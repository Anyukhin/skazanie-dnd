import assert from 'node:assert/strict'
import test from 'node:test'

import { campaignStateForViewer, mechanicsForViewer, turnResultForViewer } from '../server/viewer-projection.mjs'

const user = { role: 'player', heroIds: ['hero'] }

function privateState() {
  return {
    sessionCode: 'VISIBLE',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Лира', inventory: [] }],
    scene: {
      title: 'Архив', location: 'Норвин', mood: 'Тихо', objective: 'Найти печать', turn: 2,
      gm_only: { boss: 'дракон' }, hidden_information: { trap: 'руна' },
      cells: [
        { x: 0, y: 0, type: 'floor', revealed: false, feature: 'enemy', secret: 'засада' },
        { x: 1, y: 0, type: 'floor', revealed: true, feature: 'torch' },
      ],
    },
    adventure: {
      chapter: 2, currentHook: 'Публичный след печати', visitedLocations: ['Норвин'], unresolvedThreads: ['Открыть печать'],
      history: [{ chapter: 1, title: 'Склеп', location: 'Склеп', objective: 'Выйти', outcome: 'Герои вышли', gm_only: 'предательство' }],
      gm_only: { villain: 'канцлер' }, hidden_information: { trueDoor: 'север' }, private_notes: 'не показывать',
    },
    merchants: [
      {
        id: 'here', name: 'Марта', title: 'Торговец', location: '  НОРВИН ', available: true,
        stock: [{ stock_id: 'torch', catalog_id: 'srd_5_2_1:torch', name: 'Факел', type: 'gear', quantity: 2, base_price_cp: 1, secret_supplier: 'культ' }],
        pricing: { mode: 'catalog', agent_adjustment_bps: -500, bargain_dc: 1 }, bargains: { hero: { success: true } }, secret: 'контрабанда',
      },
      { id: 'far', name: 'Дальний', location: 'Лес', available: true, stock: [], pricing: {} },
    ],
  }
}

test('player campaign projection hides private memory, fog features and remote merchant internals', () => {
  const projected = campaignStateForViewer(privateState(), user, 'hero')
  const encoded = JSON.stringify(projected)
  assert.doesNotMatch(encoded, /дракон|засада|предательство|канцлер|trueDoor|контрабанда|secret_supplier|bargains|agent_adjustment_bps/u)
  assert.equal(projected.scene.cells[0].feature, undefined)
  assert.equal(projected.scene.cells[1].feature, 'torch')
  assert.deepEqual(projected.merchants.map((merchant) => merchant.id), ['here'])
  assert.equal(projected.adventure.currentHook, 'Публичный след печати')
  assert.equal(projected.adventure.history[0].outcome, 'Герои вышли')
})

test('player event projection sanitizes SceneAdvanced and MerchantCreated payloads', () => {
  const state = privateState()
  const events = mechanicsForViewer([
    { event_type: 'SceneAdvanced', visibility: 'public', payload: { scene: state.scene, adventure: state.adventure } },
    { event_type: 'MerchantCreated', visibility: 'public', payload: { merchant: state.merchants[0] } },
    { event_type: 'GmSecret', visibility: 'gm_only', payload: { secret: 'никогда' } },
  ], user, 'hero')
  assert.deepEqual(events.map((event) => event.event_type), ['SceneAdvanced', 'MerchantCreated'])
  assert.equal(events[0].payload.scene.cells[0].feature, undefined)
  assert.equal(events[0].payload.adventure.gm_only, undefined)
  assert.equal(events[1].payload.merchant.bargains, undefined)
  assert.doesNotMatch(JSON.stringify(events), /никогда|канцлер|контрабанда/u)
})

test('admin projection remains the trusted object', () => {
  const state = privateState()
  assert.equal(campaignStateForViewer(state, { role: 'admin' }, 'hero'), state)
})

test('turn result projection covers authoritative state, mechanics and effects.scene', () => {
  const state = privateState()
  const projected = turnResultForViewer({
    authoritative_state: state,
    mechanics: [{ event_type: 'SceneAdvanced', payload: { scene: state.scene, adventure: state.adventure } }],
    effects: { scene: { scene: state.scene, adventure: state.adventure, transition: 'Переход', arrival: 'Прибытие', suggestions: [], entrance: { x: 1, y: 1 } } },
  }, user, 'hero')
  const encoded = JSON.stringify(projected)
  assert.doesNotMatch(encoded, /дракон|канцлер|засада|hidden_information|gm_only/u)
  assert.equal(projected.authoritative_state.scene.cells[0].feature, undefined)
  assert.equal(projected.mechanics[0].payload.scene.cells[0].feature, undefined)
  assert.equal(projected.effects.scene.scene.cells[0].feature, undefined)
})
