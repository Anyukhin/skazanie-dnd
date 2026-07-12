import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ENGINE_MODES,
  EngineModeError,
  EngineModeResolver,
  explainEngineMode,
  isEngineMode,
  resolveEngineMode,
} from '../server/engine-mode.mjs'

test('engine mode defaults to legacy and only accepts declared modes', () => {
  assert.deepEqual(ENGINE_MODES, ['legacy', 'shadow', 'enforce'])
  assert.equal(resolveEngineMode({}, { env: {} }), 'legacy')
  assert.equal(isEngineMode(' SHADOW '), true)
  assert.equal(isEngineMode('experimental'), false)
})

test('engine mode precedence is test > user > campaign > global', () => {
  const context = {
    testMode: 'enforce',
    userMode: 'shadow',
    campaignMode: 'enforce',
    globalMode: 'legacy',
  }
  assert.deepEqual(explainEngineMode(context, { env: {} }), { mode: 'enforce', source: 'test' })
  delete context.testMode
  assert.deepEqual(explainEngineMode(context, { env: {} }), { mode: 'shadow', source: 'user' })
  delete context.userMode
  assert.deepEqual(explainEngineMode(context, { env: {} }), { mode: 'enforce', source: 'campaign' })
  delete context.campaignMode
  assert.deepEqual(explainEngineMode(context, { env: {} }), { mode: 'legacy', source: 'global' })
})

test('resolver reads global and test environment flags but scoped values win', () => {
  const resolver = new EngineModeResolver({
    env: { GAME_ENGINE_MODE: 'shadow', GAME_ENGINE_TEST_MODE: 'enforce' },
  })
  assert.equal(resolver.resolve({ campaign: { engine_mode: 'legacy' } }), 'enforce')
  const withoutTest = new EngineModeResolver({ env: { GAME_ENGINE_MODE: 'shadow' } })
  assert.deepEqual(withoutTest.explain({ user: { game_engine_mode: 'enforce' }, campaign: { engine_mode: 'legacy' } }), {
    mode: 'enforce', source: 'user',
  })
  assert.equal(withoutTest.resolve({ test: 'legacy', user: 'enforce', campaign: 'shadow', global: 'enforce' }), 'legacy')
})

test('invalid high-priority override fails closed instead of falling through', () => {
  assert.throws(
    () => resolveEngineMode({ userMode: 'typo', campaignMode: 'legacy' }, { env: {} }),
    (error) => error instanceof EngineModeError && error.code === 'INVALID_ENGINE_MODE' && error.source === 'user',
  )
})
