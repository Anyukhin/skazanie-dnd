import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ENGINE_MODES,
  RETIRED_ENGINE_MODES,
  EngineModeError,
  EngineModeResolver,
  explainEngineMode,
  isEngineMode,
  normalizeEngineMode,
} from '../server/engine-mode.mjs'

test('enforce is the only executable engine mode', () => {
  assert.deepEqual(ENGINE_MODES, ['enforce'])
  assert.deepEqual(RETIRED_ENGINE_MODES, ['legacy', 'shadow'])
  assert.equal(isEngineMode('enforce'), true)
  assert.equal(isEngineMode('legacy'), false)
  assert.equal(isEngineMode('shadow'), false)
})

test('retired configuration values normalize to enforce without reactivating runtime branches', () => {
  assert.equal(normalizeEngineMode('legacy'), 'enforce')
  assert.equal(normalizeEngineMode('shadow'), 'enforce')
  assert.deepEqual(explainEngineMode({ campaignMode: 'shadow' }, { env: {} }), {
    mode: 'enforce',
    source: 'campaign',
    retired_value: 'shadow',
  })
  const resolver = new EngineModeResolver({ env: { GAME_ENGINE_MODE: 'legacy' } })
  assert.equal(resolver.resolve(), 'enforce')
})

test('unknown engine mode still fails closed', () => {
  assert.throws(
    () => normalizeEngineMode('experimental'),
    (error) => error instanceof EngineModeError && error.code === 'INVALID_ENGINE_MODE',
  )
})
