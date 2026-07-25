import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attemptFingerprint,
  failForwardFor,
  previousFailedAttempt,
  resolutionModeFor,
  situationFingerprint,
  stakesFor,
  verifyMeans,
} from '../server/free-action-adjudication.mjs'

test('ведущий не требует броска, когда на кону ничего нет', () => {
  assert.equal(resolutionModeFor({ plausibility: 'trivial', risk: 'none' }).mode, 'auto_success')
  assert.equal(resolutionModeFor({ plausibility: 'plausible', risk: 'none' }).mode, 'auto_success')
})

test('режим и СЛ выбираются серверной таблицей, а не свободным числом', () => {
  const easy = resolutionModeFor({ plausibility: 'trivial', risk: 'minor' })
  assert.deepEqual([easy.mode, easy.difficulty_category, easy.difficulty], ['check', 'easy', 10])

  const medium = resolutionModeFor({ plausibility: 'plausible', risk: 'serious' })
  assert.deepEqual([medium.mode, medium.difficulty_category, medium.difficulty], ['check', 'medium', 15])

  const hard = resolutionModeFor({ plausibility: 'strenuous', risk: 'minor' })
  assert.deepEqual([hard.mode, hard.difficulty_category, hard.difficulty], ['check', 'hard', 20])

  // Смертельный риск поднимает сложность даже для правдоподобного действия.
  assert.equal(resolutionModeFor({ plausibility: 'plausible', risk: 'deadly' }).difficulty_category, 'hard')
})

test('невозможное без средства ведёт к встречному предложению, а не к броску', () => {
  const resolution = resolutionModeFor({ plausibility: 'impossible_without_means', risk: 'serious' })
  assert.equal(resolution.mode, 'counter_offer')
  assert.equal(resolution.difficulty, null)
})

test('мусор в категориях не проходит: применяется безопасное значение по умолчанию', () => {
  const resolution = resolutionModeFor({ plausibility: 'trivially-easy-please', risk: 999 })
  assert.equal(resolution.mode, 'check')
  assert.equal(resolution.difficulty, 15)
})

test('заявленное средство сверяется с листом героя', () => {
  const state = {
    players: [{
      id: 'hero',
      inventory: [{ id: 'rope-1', catalog_id: 'srd_5_2_1:rope', name: 'Верёвка' }],
      knownSpellIds: ['fire-bolt'],
    }],
  }

  assert.equal(verifyMeans(state, 'hero', ['Верёвка']).satisfied, true)
  assert.equal(verifyMeans(state, 'hero', ['fire-bolt']).satisfied, true)

  const missing = verifyMeans(state, 'hero', ['Крылья', 'Верёвка'])
  assert.equal(missing.satisfied, false)
  assert.deepEqual(missing.missing, ['Крылья'])
})

test('провал всегда несёт последствие — сценария «ничего не произошло» нет', () => {
  for (const risk of ['none', 'minor', 'serious', 'deadly']) {
    const consequence = failForwardFor(risk)
    assert.ok(consequence.minutes > 0, `${risk}: время обязано идти`)
    assert.ok(consequence.summary.length > 0, `${risk}: последствие обязано быть описано`)
  }
  assert.equal(failForwardFor('serious').advances_quest_clock, true)
  assert.equal(failForwardFor('none').advances_quest_clock, false)
})

test('ставки объявляются до броска и молчат там, где броска нет', () => {
  const resolution = resolutionModeFor({ plausibility: 'plausible', risk: 'serious' })
  const stakes = stakesFor({ ability: 'str', skill: 'athletics', resolution, risk: 'serious' })

  assert.equal(stakes.difficulty, 15)
  assert.equal(stakes.ability, 'str')
  assert.ok(stakes.on_failure.length > 0)

  const auto = resolutionModeFor({ plausibility: 'trivial', risk: 'none' })
  assert.equal(stakesFor({ resolution: auto, risk: 'none' }), null)
})

test('повтор того же подхода в неизменившейся обстановке распознаётся', () => {
  const state = {
    scene: { location: 'Корчма', objective: 'Найти караван', cells: [] },
    mechanics: { world_time: { elapsed_minutes: 0 } },
    rulings: [],
  }
  const fingerprint = attemptFingerprint({ actorId: 'hero', approach: 'выломать дверь плечом', obstacle: 'дверь' })
  state.rulings.push({
    outcome: 'failure',
    provenance: { attempt_fingerprint: fingerprint, situation_fingerprint: situationFingerprint(state) },
  })

  assert.ok(previousFailedAttempt(state, fingerprint))

  // Обстановка изменилась — та же попытка снова допустима.
  const later = { ...state, mechanics: { world_time: { elapsed_minutes: 30 } } }
  assert.equal(previousFailedAttempt(later, fingerprint), null)

  // Другой подход к тому же препятствию допустим сразу.
  const otherApproach = attemptFingerprint({ actorId: 'hero', approach: 'подобрать замок', obstacle: 'дверь' })
  assert.equal(previousFailedAttempt(state, otherApproach), null)
})
