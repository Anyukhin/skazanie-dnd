import assert from 'node:assert/strict'
import test from 'node:test'
import { COMBAT_SCENARIOS, combatEventChecker, runCombatScenario } from '../eval/combat-lab.mjs'
import { runnerTimeout } from './shared-runner-timeout.mjs'

for (const scenario of COMBAT_SCENARIOS) {
  const seed = scenario === 'concentration' ? 2 : 1
  test(`боевой стенд 2014: ${scenario}, seed=${seed}`, { timeout: runnerTimeout(120_000) }, async () => {
    const report = await runCombatScenario({ scenario, seed })
    assert.equal(report.passed, true, JSON.stringify({ error: report.error, lastStep: report.steps.at(-1) }))
    const types = new Set(report.events.map((event) => event.event_type))
    for (const type of ['CombatStarted', 'AttackResolved', 'DamageApplied', 'CombatEnded']) assert.ok(types.has(type), type)
    if (scenario === 'healing') {
      const healing = report.events.find((event) => event.event_type === 'HealingApplied' && event.payload.item_id === 'potion')
      assert.equal(healing?.target_ids[0], 'ally')
      assert.ok(healing.payload.applied_amount > 0 && healing.payload.hp_after > healing.payload.hp_before)
      assert.equal(report.events.filter((event) => event.event_type === 'ItemConsumed' && event.payload.item_id === 'potion').length, 1)
      assert.ok(!report.final_state.players[0].inventory.some((item) => item.id === 'potion' && item.quantity > 0))
    }
    if (scenario === 'concentration') {
      assert.ok(report.events.some((event) => event.event_type === 'ConcentrationSavingThrowResolved' && !event.payload.saved))
      assert.ok(report.events.some((event) => event.event_type === 'ConcentrationEnded' && event.payload.reason === 'failed-saving-throw'))
      const effectId = report.events.find((event) => event.event_type === 'ConcentrationStarted').payload.effect_id
      assert.equal(report.final_state.mechanics.concentration.hero, undefined)
      assert.ok(!report.final_state.mechanics.active_effects.some((effect) => effect.effect_id === effectId))
      assert.ok(!Object.values(report.final_state.mechanics.conditions).flat().some((condition) => condition.effect_id === effectId))
    }
    if (scenario === 'approach') {
      const moved = report.events.findIndex((event) => event.event_type === 'ActorMoved' && event.actor_id === 'hero')
      assert.ok(moved >= 0)
      const attack = report.events.findIndex((event, index) => index > moved && event.event_type === 'AttackResolved' && event.actor_id === 'hero')
      assert.ok(attack > moved && !report.events.slice(moved, attack).some((event) => event.event_type === 'TurnEnded' && event.actor_id === 'hero'))
    }
    if (scenario === 'ranged') assert.ok(report.events.some((event) => event.event_type === 'AttackResolved' && event.actor_id === 'hero' && event.payload.attack_kind === 'ranged' && event.payload.distance_feet > 5))
    if (scenario === 'opportunity-attack') {
      assert.ok(report.events.some((event) => event.event_type === 'AttackResolved' && event.payload.reaction_attack))
      const wrongOwner = structuredClone(report.events)
      wrongOwner.find((event) => event.event_type === 'CombatActionUsed' && event.payload.action_id === 'opportunity-attack').actor_id = 'hero'
      assert.throws(() => combatEventChecker(report.initial_state)(wrongOwner), /владельцу или цели реакции/)
    }
    if (scenario === 'difficult-terrain') assert.ok(report.events.some((event) => event.event_type === 'ActorMoved' && event.payload.movement_cost > event.payload.distance))
    if (scenario === 'duel') {
      const repeated = await runCombatScenario({ scenario, seed: 1 })
      assert.equal(repeated.passed, true, repeated.error?.message)
      assert.deepEqual(repeated.rolls, report.rolls, 'Одинаковый seed изменил броски')
      assert.deepEqual(repeated.steps.map((step) => step.command), report.steps.map((step) => step.command), 'Одинаковый seed изменил действия')
      // Положительный прогон недостаточен: испорченный результат атаки должен
      // быть замечен независимым проверяющим, даже если движок не выбросил ошибку.
      const broken = structuredClone(report.events)
      const attack = broken.find((event) => event.event_type === 'AttackResolved')
      attack.payload.hit = !attack.payload.hit
      assert.throws(() => combatEventChecker(report.initial_state)(broken), /Неверный результат атаки/)
      const doubleAttack = structuredClone(report.events)
      const index = doubleAttack.findIndex((event) => event.event_type === 'AttackResolved' && !event.payload.reaction_attack)
      doubleAttack.splice(index + 1, 0, structuredClone(doubleAttack[index]))
      assert.throws(() => combatEventChecker(report.initial_state)(doubleAttack), /повторно потрачено action/)
    }
  })
}

test('исчерпанный бюджет боя сохраняет воспроизведение и отказавшую команду', async () => {
  const report = await runCombatScenario({ scenario: 'duel', seed: 1, maxSteps: 1 })
  assert.equal(report.passed, false)
  assert.match(report.error.message, /Бой не завершён/)
  assert.equal(report.steps[0].command.command_type, 'StartCombat')
  assert.ok(report.events.length && report.rolls.length && report.final_state)
})

test('бот обходит занятые клетки, когда точные ОЗ врагов скрыты проекцией', { timeout: runnerTimeout(120_000) }, async () => {
  const report = await runCombatScenario({ scenario: 'two-heroes', seed: 7 })
  assert.equal(report.passed, true, report.error?.message)
})
