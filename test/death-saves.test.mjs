import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { RulesValidationError, applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `death-save-roll-${++id}`,
    now: () => '2026-07-18T12:00:00.000Z',
  })
}

function applyAll(state, events) {
  return events.reduce((current, event) => applyGameEvent(current, event), state)
}

function fixture({ tracker, fallenHp = 0, medicLevel = 5 } = {}) {
  const cells = Array.from({ length: 15 }, (_, index) => ({ x: index % 5, y: Math.floor(index / 5), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'DEATH-SAVES',
    partyMemberIds: ['medic', 'fallen'],
    players: [
      { id: 'medic', character: 'Иара', characterClass: 'cleric', level: medicLevel, hp: 24, maxHp: 24, armor: 16, speed: 30, proficiency: medicLevel >= 5 ? 3 : 2, skills: ['medicine'], abilities: { str: 10, dex: 12, con: 14, int: 10, wis: 16, cha: 10 }, x: 1, y: 1, inventory: [] },
      { id: 'fallen', character: 'Кел', characterClass: 'fighter', level: 5, hp: fallenHp, maxHp: 30, armor: 17, speed: 30, proficiency: 3, abilities: { str: 16, dex: 12, con: 16, int: 10, wis: 10, cha: 10 }, x: 2, y: 1, inventory: [] },
    ],
    enemies: [{ id: 'foe', name: 'Враг', hp: 20, maxHp: 20, armor: 12, speed: 30, attackBonus: 4, damageDice: 6, damageBonus: 2, x: 3, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      positions: { medic: { x: 1, y: 1 }, fallen: { x: 2, y: 1 }, foe: { x: 3, y: 1 } },
      conditions: fallenHp === 0 ? { fallen: [{ id: 'unconscious' }] } : {},
      death: { saving_throws: tracker ? { fallen: tracker } : {}, heroes: {}, campaign_status: 'active' },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'medic', total: 18 }, { actor_id: 'fallen', total: 12 }, { actor_id: 'foe', total: 8 }],
        action_economy: {
          medic: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          fallen: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

test('начало хода автоматически делает серверный спасбросок от смерти и replay сохраняет счётчики', () => {
  const initial = fixture()
  const result = resolveCommand({ command_type: 'EndTurn', actor_id: 'medic', server_authoritative: true }, initial, {
    diceService: dice([12]), context: { serverAuthoritativeCombat: true },
  })
  assert.deepEqual(result.events.map((event) => event.event_type), ['TurnEnded', 'TurnStarted', 'DeathSavingThrowRolled'])
  assert.equal(result.events[2].payload.success, true)
  assert.equal(result.events[2].payload.successes_after, 1)
  const after = applyAll(initial, result.events)
  assert.deepEqual(after.mechanics.death.saving_throws.fallen, { successes: 1, failures: 0, stable: false })
  assert.deepEqual(replayEvents(initial, result.events), after)
})

test('натуральная 1 даёт два провала, третий провал убивает героя', () => {
  const initial = fixture({ tracker: { successes: 1, failures: 1, stable: false } })
  const result = resolveCommand({ command_type: 'EndTurn', actor_id: 'medic', server_authoritative: true }, initial, {
    diceService: dice([1]), context: { serverAuthoritativeCombat: true },
  })
  assert.deepEqual(result.events.slice(-2).map((event) => event.event_type), ['DeathSavingThrowRolled', 'HeroDied'])
  assert.equal(result.events.at(-2).payload.failure_increment, 2)
  const after = applyAll(initial, result.events)
  assert.equal(after.mechanics.death.heroes.fallen.status, 'dead')
  assert.equal(after.mechanics.death.saving_throws.fallen, undefined)
  assert.ok(after.mechanics.conditions.fallen.some((condition) => condition.id === 'dead'))
})

test('натуральная 20 возвращает 1 ОЗ, снимает бессознательность и сбрасывает счётчики', () => {
  const initial = fixture({ tracker: { successes: 0, failures: 2, stable: false } })
  const result = resolveCommand({ command_type: 'EndTurn', actor_id: 'medic', server_authoritative: true }, initial, {
    diceService: dice([20]), context: { serverAuthoritativeCombat: true },
  })
  assert.deepEqual(result.events.slice(-2).map((event) => event.event_type), ['DeathSavingThrowRolled', 'HealingApplied'])
  const after = applyAll(initial, result.events)
  assert.equal(after.players.find((hero) => hero.id === 'fallen').hp, 1)
  assert.equal(after.mechanics.death.saving_throws.fallen, undefined)
  assert.equal(after.mechanics.conditions.fallen.some((condition) => condition.id === 'unconscious'), false)
})

test('три успеха стабилизируют героя, а стабильный герой больше не бросает', () => {
  const initial = fixture({ tracker: { successes: 2, failures: 2, stable: false } })
  const result = resolveCommand({ command_type: 'EndTurn', actor_id: 'medic', server_authoritative: true }, initial, {
    diceService: dice([10]), context: { serverAuthoritativeCombat: true },
  })
  assert.deepEqual(result.events.slice(-2).map((event) => event.event_type), ['DeathSavingThrowRolled', 'HeroStabilized'])
  const stable = applyAll(initial, result.events)
  assert.deepEqual(stable.mechanics.death.saving_throws.fallen, { successes: 0, failures: 0, stable: true })
  stable.mechanics.combat.active_index = 0
  const next = resolveCommand({ command_type: 'EndTurn', actor_id: 'medic', server_authoritative: true }, stable, {
    diceService: dice([]), context: { serverAuthoritativeCombat: true },
  })
  assert.equal(next.events.some((event) => event.event_type === 'DeathSavingThrowRolled'), false)
})

test('урон при 0 ОЗ добавляет провалы, критический урон добавляет два, а массивный урон убивает сразу', () => {
  const initial = fixture({ tracker: { successes: 1, failures: 0, stable: true } })
  const damaged = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'foe', target_id: 'fallen', amount: 4, damage_type: 'slashing' }, initial, { diceService: dice([]) })
  assert.deepEqual(damaged.events.map((event) => event.event_type), ['DamageApplied', 'DeathSaveFailureRecorded'])
  let after = applyAll(initial, damaged.events)
  assert.deepEqual(after.mechanics.death.saving_throws.fallen, { successes: 1, failures: 1, stable: false })

  const critical = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'foe', target_id: 'fallen', amount: 4, damage_type: 'slashing', critical_hit: true }, after, { diceService: dice([]) })
  assert.deepEqual(critical.events.slice(-2).map((event) => event.event_type), ['DeathSaveFailureRecorded', 'HeroDied'])

  const fresh = fixture()
  const massive = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'foe', target_id: 'fallen', amount: 30, damage_type: 'slashing' }, fresh, { diceService: dice([]) })
  assert.deepEqual(massive.events.map((event) => event.event_type), ['DamageApplied', 'HeroDied'])
})

test('лечение при 0 ОЗ возвращает сознание, но обычное лечение не воскрешает погибшего', () => {
  const initial = fixture({ tracker: { successes: 0, failures: 2, stable: false } })
  const healed = resolveCommand({ command_type: 'ApplyHealing', actor_id: 'fallen', amount: 7 }, initial, { diceService: dice([]) })
  const after = applyAll(initial, healed.events)
  assert.equal(after.players.find((hero) => hero.id === 'fallen').hp, 7)
  assert.equal(after.mechanics.death.saving_throws.fallen, undefined)
  assert.equal(after.mechanics.conditions.fallen.some((condition) => condition.id === 'unconscious'), false)

  after.players.find((hero) => hero.id === 'fallen').hp = 0
  after.mechanics.death.heroes.fallen = { status: 'dead' }
  assert.throws(
    () => resolveCommand({ command_type: 'ApplyHealing', actor_id: 'fallen', amount: 7 }, after, { diceService: dice([]) }),
    (error) => error instanceof RulesValidationError && error.code === 'HERO_DEAD_UNRESOLVED',
  )
})

test('погибший участник инициативы может только завершить ход, чтобы бой не застрял', () => {
  const state = fixture()
  state.mechanics.combat.active_index = 1
  state.activePlayerId = 'fallen'
  state.players.find((hero) => hero.id === 'fallen').hp = 0
  state.mechanics.death.heroes.fallen = { status: 'dead' }
  state.mechanics.conditions.fallen = [{ id: 'dead' }]

  const skipped = resolveCommand(
    { command_type: 'EndTurn', actor_id: 'fallen', server_authoritative: true },
    state,
    { diceService: dice([]), context: { serverAuthoritativeCombat: true } },
  )

  assert.deepEqual(skipped.events.slice(0, 2).map((event) => event.event_type), ['TurnEnded', 'TurnStarted'])
  assert.equal(applyAll(state, skipped.events).activePlayerId, 'foe')
})

test('серверное боевое заклинание лечения может поднять союзника с 0 ОЗ', () => {
  const initial = fixture({ tracker: { successes: 1, failures: 1, stable: false } })
  assert.ok(initial.players.find((hero) => hero.id === 'medic').combatSpells.some((spell) => spell.id === 'healing-word'))
  const result = resolveCommand({
    command_type: 'CastSpell', actor_id: 'medic', spell_id: 'healing-word', target_id: 'fallen', server_authoritative: true,
  }, initial, { diceService: dice([3]), context: { serverAuthoritativeCombat: true } })
  const after = applyAll(initial, result.events)
  assert.ok(after.players.find((hero) => hero.id === 'fallen').hp > 0)
  assert.equal(after.mechanics.death.saving_throws.fallen, undefined)
  assert.equal(after.mechanics.conditions.fallen.some((condition) => condition.id === 'unconscious'), false)
  assert.equal(after.mechanics.combat.action_economy.medic.bonus_action, false)
})

test('Medicine DC 10 стабилизирует соседнего союзника и расходует действие', () => {
  const initial = fixture()
  const result = resolveCommand({ command_type: 'UseCombatAction', actor_id: 'medic', action_id: 'stabilize', target_id: 'fallen', server_authoritative: true }, initial, {
    diceService: dice([4]), context: { serverAuthoritativeCombat: true },
  })
  assert.deepEqual(result.events.map((event) => event.event_type), ['AbilityCheckResolved', 'HeroStabilized', 'CombatActionUsed'])
  assert.equal(result.events[0].payload.total, 10)
  const after = applyAll(initial, result.events)
  assert.equal(after.mechanics.death.saving_throws.fallen.stable, true)
  assert.equal(after.mechanics.combat.action_economy.medic.action, false)
})

test('бой нельзя завершить до стабилизации, а стабильный герой не объявляется погибшим', () => {
  const initial = fixture()
  assert.throws(
    () => resolveCommand({ command_type: 'EndCombat', actor_id: 'medic', reason: 'enemies_defeated' }, initial, { diceService: dice([]) }),
    (error) => error instanceof RulesValidationError && error.code === 'DEATH_SAVES_PENDING',
  )
  initial.mechanics.death.saving_throws.fallen = { successes: 0, failures: 0, stable: true }
  const ended = resolveCommand({ command_type: 'EndCombat', actor_id: 'medic', reason: 'enemies_defeated' }, initial, { diceService: dice([]) })
  assert.deepEqual(ended.events.map((event) => event.event_type), ['CombatEnded'])
  const after = applyAll(initial, ended.events)
  assert.equal(after.mechanics.death.heroes.fallen, undefined)
  assert.equal(after.players.find((hero) => hero.id === 'fallen').hp, 0)
  assert.equal(after.mechanics.death.saving_throws.fallen.stable, true)
})

test('стабильный герой автоматически получает 1 ОЗ после серверных 1d4 часов, а replay сохраняет таймер', () => {
  const initial = fixture({ tracker: { successes: 0, failures: 0, stable: true } })
  initial.mechanics.combat.active = false

  const firstHour = resolveCommand({ command_type: 'AdvanceTime', amount: 1, unit: 'hour' }, initial, {
    diceService: dice([3]),
  })
  assert.deepEqual(firstHour.events.map((event) => event.event_type), ['TimeAdvanced', 'StableRecoveryScheduled', 'StableRecoveryProgressed'])
  assert.equal(firstHour.rolls[0].expression, '1d4')
  assert.equal(firstHour.rolls[0].total, 3)
  const waiting = applyAll(initial, firstHour.events)
  assert.deepEqual(waiting.mechanics.death.saving_throws.fallen, {
    successes: 0, failures: 0, stable: true, recovery_minutes_remaining: 120,
  })
  assert.deepEqual(replayEvents(initial, firstHour.events), waiting)

  const recovered = resolveCommand({ command_type: 'AdvanceTime', amount: 2, unit: 'hour' }, waiting, {
    diceService: dice([]),
  })
  // Два часа переводят стрелку с утра на день, и мировые часы пишут об этом
  // своё событие (`server/weather.mjs`). Здесь проверяется восстановление
  // стабилизированного героя, поэтому небо из списка отфильтровано.
  assert.deepEqual(
    recovered.events.map((event) => event.event_type).filter((type) => !['TimeOfDayChanged', 'WeatherChanged'].includes(type)),
    ['TimeAdvanced', 'HealingApplied'],
  )
  const after = applyAll(waiting, recovered.events)
  assert.equal(after.players.find((hero) => hero.id === 'fallen').hp, 1)
  assert.equal(after.mechanics.death.saving_throws.fallen, undefined)
  assert.equal(after.mechanics.conditions.fallen.some((condition) => condition.id === 'unconscious'), false)
})

test('урон по стабильному герою сбрасывает таймер восстановления и снова запускает провалы', () => {
  const initial = fixture({ tracker: { successes: 0, failures: 0, stable: true, recovery_minutes_remaining: 180 } })
  const damaged = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'foe', target_id: 'fallen', amount: 2, damage_type: 'slashing' }, initial, {
    diceService: dice([]),
  })
  const after = applyAll(initial, damaged.events)
  assert.deepEqual(after.mechanics.death.saving_throws.fallen, { successes: 0, failures: 1, stable: false })
})

test('Bless и Bane изменяют итог death save, но натуральная 1 всё равно даёт два провала', () => {
  const blessed = fixture()
  blessed.mechanics.conditions.fallen.push({ id: 'bless-d4' })
  const blessedSave = resolveCommand({ command_type: 'EndTurn', actor_id: 'medic', server_authoritative: true }, blessed, {
    diceService: dice([1, 9]), context: { serverAuthoritativeCombat: true },
  })
  const blessedEvent = blessedSave.events.find((event) => event.event_type === 'DeathSavingThrowRolled')
  assert.equal(blessedEvent.payload.natural_roll, 9)
  assert.equal(blessedEvent.payload.modifier, 1)
  assert.equal(blessedEvent.payload.total, 10)
  assert.equal(blessedEvent.payload.success, true)
  assert.deepEqual(blessedEvent.payload.modifier_sources, ['bless'])

  const baned = fixture()
  baned.mechanics.conditions.fallen.push({ id: 'bane-d4' })
  const banedSave = resolveCommand({ command_type: 'EndTurn', actor_id: 'medic', server_authoritative: true }, baned, {
    diceService: dice([1, 10]), context: { serverAuthoritativeCombat: true },
  })
  const banedEvent = banedSave.events.find((event) => event.event_type === 'DeathSavingThrowRolled')
  assert.equal(banedEvent.payload.total, 9)
  assert.equal(banedEvent.payload.success, false)
  assert.deepEqual(banedEvent.payload.modifier_sources, ['bane'])

  const naturalOne = fixture({ tracker: { successes: 0, failures: 0, stable: false } })
  naturalOne.mechanics.conditions.fallen.push({ id: 'bless-d4' })
  const criticalFailure = resolveCommand({ command_type: 'EndTurn', actor_id: 'medic', server_authoritative: true }, naturalOne, {
    diceService: dice([4, 1]), context: { serverAuthoritativeCombat: true },
  }).events.find((event) => event.event_type === 'DeathSavingThrowRolled')
  assert.equal(criticalFailure.payload.natural_roll, 1)
  assert.equal(criticalFailure.payload.success, false)
  assert.equal(criticalFailure.payload.failure_increment, 2)
})

test('Маяк надежды можно наложить на героя с 0 ОЗ и он даёт преимущество на death save', () => {
  const initial = fixture()
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'medic', spell_id: 'beacon-of-hope', target_id: 'fallen', target_ids: ['fallen'], server_authoritative: true }, initial, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  })
  const protectedState = applyAll(initial, cast.events)
  assert.ok(protectedState.mechanics.conditions.fallen.some((condition) => condition.id === 'beacon-of-hope'))
  protectedState.mechanics.combat.action_economy.medic.action = true
  const save = resolveCommand({ command_type: 'EndTurn', actor_id: 'medic', server_authoritative: true }, protectedState, {
    diceService: dice([4, 12]), context: { serverAuthoritativeCombat: true },
  })
  const deathSave = save.events.find((event) => event.event_type === 'DeathSavingThrowRolled')
  assert.equal(deathSave.payload.advantage, true)
  assert.deepEqual(deathSave.payload.dice, [4, 12])
  assert.equal(deathSave.payload.natural_roll, 12)
  assert.equal(deathSave.payload.success, true)
})

test('Маяк надежды максимизирует кости получаемого лечения', () => {
  const initial = fixture()
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'medic', spell_id: 'beacon-of-hope', target_id: 'fallen', target_ids: ['fallen'], server_authoritative: true }, initial, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  })
  const protectedState = applyAll(initial, cast.events)
  const healed = resolveCommand({ command_type: 'CastSpell', actor_id: 'medic', spell_id: 'healing-word', target_id: 'fallen', server_authoritative: true }, protectedState, {
    diceService: dice([1]), context: { serverAuthoritativeCombat: true },
  })
  const healing = healed.events.find((event) => event.event_type === 'HealingApplied')
  assert.equal(healing.payload.rolled_amount, 4)
  assert.equal(healing.payload.requested_amount, 7)
  assert.equal(healing.payload.maximized_by, 'beacon-of-hope')
  const after = applyAll(protectedState, healed.events)
  assert.equal(after.players.find((hero) => hero.id === 'fallen').hp, 7)
})

test('Охрана от смерти один раз оставляет цель на 1 ОЗ и расходуется', () => {
  const initial = fixture({ fallenHp: 5, medicLevel: 7 })
  assert.ok(initial.players.find((hero) => hero.id === 'medic').combatSpells.some((spell) => spell.id === 'death-ward'))
  const cast = resolveCommand({ command_type: 'CastSpell', actor_id: 'medic', spell_id: 'death-ward', target_id: 'fallen', server_authoritative: true }, initial, {
    diceService: dice(), context: { serverAuthoritativeCombat: true },
  })
  const warded = applyAll(initial, cast.events)
  assert.ok(warded.mechanics.conditions.fallen.some((condition) => condition.id === 'death-ward'))

  const protectedHit = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'foe', target_id: 'fallen', amount: 40, damage_type: 'slashing' }, warded, { diceService: dice() })
  assert.deepEqual(protectedHit.events.map((event) => event.event_type), ['DamageApplied'])
  assert.equal(protectedHit.events[0].payload.death_ward_triggered, true)
  assert.equal(protectedHit.events[0].payload.hp_after, 1)
  const protectedState = applyAll(warded, protectedHit.events)
  assert.equal(protectedState.players.find((hero) => hero.id === 'fallen').hp, 1)
  assert.equal(protectedState.mechanics.conditions.fallen.some((condition) => condition.id === 'death-ward'), false)
  assert.deepEqual(replayEvents(warded, protectedHit.events), protectedState)

  const secondHit = resolveCommand({ command_type: 'ApplyDamage', actor_id: 'foe', target_id: 'fallen', amount: 1, damage_type: 'slashing' }, protectedState, { diceService: dice() })
  assert.deepEqual(secondHit.events.map((event) => event.event_type), ['DamageApplied', 'HitPointsReducedToZero'])
  assert.equal(applyAll(protectedState, secondHit.events).players.find((hero) => hero.id === 'fallen').hp, 0)
})
