import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PostCommitCoordinator,
  combatPositionKey,
  directorPositionKey,
  stageOrderForReview,
} from '../server/post-commit-coordinator.mjs'

/**
 * Шаг 6 плана `docs/agent-architecture-plan.md`. Проверяется ровно то, ради чего
 * координатор заводится: детерминированный порядок последствий и два разных
 * правила ключей — одноразовое последствие против продолжения цикла.
 */

function stateInCombat({ round = 1, index = 0, encounterId = 'enc-1' } = {}) {
  return {
    mechanics: {
      encounter: { id: encounterId, status: 'active' },
      combat: {
        active: true,
        round,
        active_index: index,
        initiative: [{ actor_id: 'hero' }, { actor_id: 'wolf' }],
      },
    },
  }
}

function trackingDeps(order) {
  const record = (name) => async () => { order.push(name) }
  return {
    applyQuestConsequences: record('quest-consequences'),
    continueCombat: record('combat-continuation'),
    completeEncounter: record('encounter-completion'),
    runDirector: record('director-trigger'),
    persistProjection: record('visible-projection'),
    narrate: record('narration'),
  }
}

test('порядок стадий объявлен данными и совпадает с фактическим', async () => {
  assert.deepEqual(stageOrderForReview(), [
    { name: 'quest-consequences', keyKind: 'once' },
    { name: 'combat-continuation', keyKind: 'loop' },
    { name: 'encounter-completion', keyKind: 'once' },
    { name: 'director-trigger', keyKind: 'loop' },
    { name: 'visible-projection', keyKind: 'once' },
    { name: 'narration', keyKind: 'once' },
  ])

  const order = []
  const coordinator = new PostCommitCoordinator({ deps: trackingDeps(order) })
  await coordinator.run({
    campaignId: 'ORDER',
    state: stateInCombat(),
    events: [{ event_id: 'e1', event_type: 'QuestResolved' }],
    commitKey: 'commit-1',
  })
  assert.deepEqual(order, ['quest-consequences', 'combat-continuation', 'visible-projection', 'narration'],
    'встреча ещё идёт, Режиссёр в бою не вызывается')
})

test('одноразовое последствие не выполняется дважды по тому же источнику', async () => {
  const order = []
  const coordinator = new PostCommitCoordinator({ deps: trackingDeps(order) })
  const state = { mechanics: { encounter: { id: 'enc-7', status: 'ended' }, combat: { active: false } } }
  const events = [{ event_id: 'e2', event_type: 'EncounterRewardsDistributed' }]

  await coordinator.run({ campaignId: 'ONCE', state, events, commitKey: 'commit-2' })
  const afterFirst = order.filter((name) => name === 'encounter-completion').length
  await coordinator.run({ campaignId: 'ONCE', state, events, commitKey: 'commit-2' })
  const afterSecond = order.filter((name) => name === 'encounter-completion').length

  assert.equal(afterFirst, 1)
  assert.equal(afterSecond, 1, 'завершение встречи ключуется идентификатором встречи и не повторяется')
})

test('продолжение цикла ключуется позицией: новый ход очереди — новый запуск', async () => {
  const order = []
  const coordinator = new PostCommitCoordinator({ deps: trackingDeps(order) })
  const events = [{ event_id: 'e3', event_type: 'TurnStarted' }]

  await coordinator.run({ campaignId: 'LOOP', state: stateInCombat({ index: 0 }), events })
  await coordinator.run({ campaignId: 'LOOP', state: stateInCombat({ index: 0 }), events })
  await coordinator.run({ campaignId: 'LOOP', state: stateInCombat({ index: 1 }), events })
  await coordinator.run({ campaignId: 'LOOP', state: stateInCombat({ round: 2, index: 0 }), events })

  // Ожидание пересмотрено при подключении боя (шаг 7, часть 3): память процесса
  // больше не скипает продолжения цикла. Работа внутри одной позиции бывает
  // легитимной дважды — окно реакции решается без смены позиции, — поэтому
  // повтор по позиции отсекает Event Store ключом коммита планировщика, а не
  // координатор памятью. Все четыре вызова доходят до стадии.
  assert.equal(order.filter((name) => name === 'combat-continuation').length, 4,
    'координатор не должен скипать продолжение боя по памяти процесса')
})

test('ключ продолжения включает встречу, раунд, номер в очереди и актора', () => {
  assert.equal(combatPositionKey(stateInCombat()), 'combat:enc-1:r1:i0:hero')
  assert.equal(combatPositionKey(stateInCombat({ index: 1 })), 'combat:enc-1:r1:i1:wolf')
  assert.equal(combatPositionKey({ mechanics: { combat: { active: false } } }), null,
    'вне боя продолжения нет вовсе')
  const first = directorPositionKey({ campaignConcept: { current_arc_number: 2 }, adventure: { chapter: 3, objective: 'Найти переправу' } })
  const same = directorPositionKey({ campaignConcept: { current_arc_number: 2 }, adventure: { chapter: 3, objective: 'Найти переправу' } })
  const next = directorPositionKey({ campaignConcept: { current_arc_number: 2 }, adventure: { chapter: 3, objective: 'Перейти реку' } })
  assert.equal(first, same)
  assert.notEqual(first, next)
})

test('упавшая стадия повторяется следующим вызовом, а выполненные — нет', async () => {
  const order = []
  const deps = trackingDeps(order)
  let failures = 0
  deps.persistProjection = async () => {
    order.push('visible-projection')
    if (failures++ === 0) throw new Error('проекция не сохранилась')
  }
  const errors = []
  const coordinator = new PostCommitCoordinator({ deps, onError: (error, stage) => errors.push(stage) })
  const state = { mechanics: { encounter: { id: 'enc-9', status: 'active' }, combat: { active: false } } }
  const events = [{ event_id: 'e4', event_type: 'QuestResolved' }]

  const first = await coordinator.run({ campaignId: 'RETRY', state, events, commitKey: 'commit-4' })
  assert.deepEqual(first.failed, ['visible-projection'])
  assert.deepEqual(errors, ['visible-projection'])
  assert.ok(first.ran.includes('narration'), 'падение одной стадии не отменяет следующие')

  const second = await coordinator.run({ campaignId: 'RETRY', state, events, commitKey: 'commit-4' })
  assert.deepEqual(second.ran, ['visible-projection'], 'повторяется только упавшая стадия')
  assert.equal(order.filter((name) => name === 'quest-consequences').length, 1)
})

test('координатор работает только с подтверждёнными событиями и не решает сам, когда запускаться', async () => {
  const coordinator = new PostCommitCoordinator({ deps: {} })
  const result = await coordinator.run({ campaignId: 'EMPTY', state: {}, events: [] })
  assert.deepEqual(result.ran, ['visible-projection'],
    'без событий остаётся только проекция: рассказывать нечего')
  assert.ok(result.skipped.includes('narration'))
})

test('маршрут может отдать координатору подмножество стадий', async () => {
  const order = []
  const coordinator = new PostCommitCoordinator({ deps: trackingDeps(order) })
  const state = { mechanics: { encounter: { id: 'enc-11', status: 'ended' }, combat: { active: false } } }

  const run = await coordinator.run({
    campaignId: 'SUBSET',
    state,
    events: [{ event_id: 'e5', event_type: 'EncounterRewardsDistributed' }],
    commitKey: 'commit-5',
    stages: ['encounter-completion'],
  })

  assert.deepEqual(run.ran, ['encounter-completion'],
    'подключение идёт по одной стадии за раз — так шаг 7 остаётся проверяемым')
  assert.deepEqual(order, ['encounter-completion'], 'остальные стадии не выполняются вовсе')
})

test('результат стадии возвращается вызывающему', async () => {
  const coordinator = new PostCommitCoordinator({
    deps: { completeEncounter: async () => ({ reward: { xp: 120 }, events: [{ event_type: 'ExperienceAwarded' }] }) },
  })
  const run = await coordinator.run({
    campaignId: 'RESULT',
    state: { mechanics: { encounter: { id: 'enc-12', status: 'ended' }, combat: { active: false } } },
    events: [],
    stages: ['encounter-completion'],
  })
  assert.equal(run.results['encounter-completion'].reward.xp, 120,
    'маршрут обязан получить награду обратно, иначе он не сможет её показать')
})
