import assert from 'node:assert/strict'
import test from 'node:test'

import { hasSceneEvent, sceneNarration } from '../server/scene-narration.mjs'

test('combined narrator keeps committed arrival and auto-created merchant', () => {
  const events = [{
    event_type: 'SceneAdvanced',
    payload: {
      transition: 'Отряд покидает старый тракт.',
      arrival: 'Впереди открываются ворота Норвина.',
    },
  }, {
    event_type: 'MerchantCreated',
    payload: {
      merchant_id: 'shop-norvin',
      merchant: { id: 'shop-norvin', name: 'Илара', location: 'Город Норвин' },
    },
  }]
  const state = { merchants: [{ id: 'shop-norvin', name: 'Илара', location: 'Город Норвин' }] }
  const narration = sceneNarration(events, state)
  assert.match(narration, /Отряд покидает старый тракт/u)
  assert.match(narration, /ворота Норвина/u)
  assert.match(narration, /Илара/u)
  assert.match(narration, /Город Норвин/u)
  assert.equal(hasSceneEvent(events), true)
})

test('non-scene batch is ignored', () => {
  assert.equal(hasSceneEvent([{ event_type: 'MerchantCreated' }]), false)
  assert.equal(sceneNarration([{ event_type: 'MerchantCreated' }], {}), null)
})

