import assert from 'node:assert/strict'
import test from 'node:test'

import { applyHazardEffects, createHazardEffect, createHazardResolution, findHazard } from '../server/persistent-hazards.mjs'

const state = {
  scene: { turn: 4 },
  players: [{ id: 'mira', abilities: { str: 12, con: 14 } }],
  mechanics: { hazards: {} },
}

test('опасное состояние среды сохраняется в механическом контексте', () => {
  const applied = createHazardEffect({ targetId: 'mira', id: 'drowning', label: 'Тонет', source: 'Бурная вода', severity: 'critical', escapeAbility: 'str', escapeDifficulty: 15, endCondition: 'Выбраться на поверхность' }, state)
  const mechanics = applyHazardEffects(state.mechanics, [applied])
  assert.equal(mechanics.hazards.mira[0].id, 'drowning')
  assert.equal(mechanics.hazards.mira[0].escapeDifficulty, 15)
})

test('заявление игрока не снимает опасность без подходящей успешной серверной проверки', () => {
  const applied = createHazardEffect({ targetId: 'mira', id: 'drowning', label: 'Тонет', escapeAbility: 'str', escapeDifficulty: 15 }, state)
  const activeState = { ...state, mechanics: applyHazardEffects(state.mechanics, [applied]) }

  assert.equal(createHazardResolution({ targetId: 'mira', id: 'drowning' }, activeState).code, 'HAZARD_CHECK_REQUIRED')
  assert.equal(createHazardResolution({ targetId: 'mira', id: 'drowning' }, activeState, { ability: 'dex', difficulty: 15, success: true }).code, 'HAZARD_WRONG_ABILITY')
  assert.equal(createHazardResolution({ targetId: 'mira', id: 'drowning' }, activeState, { ability: 'str', difficulty: 15, success: false }).code, 'HAZARD_CHECK_FAILED')

  const resolved = createHazardResolution({ targetId: 'mira', id: 'drowning', resolution: 'Мириэль выбралась на камни' }, activeState, { roll_id: 'roll-1', ability: 'str', difficulty: 15, success: true })
  const mechanics = applyHazardEffects(activeState.mechanics, [resolved])
  assert.equal(findHazard({ mechanics }, 'mira', 'drowning'), null)
})
