import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `haste-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

/** Волшебник, воин пятого уровня со скоростью 30 и цель для ударов. */
function party() {
  const cells = Array.from({ length: 60 }, (_, index) => ({ x: index % 15, y: Math.floor(index / 15), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'HASTE-1',
    partyMemberIds: ['mage', 'fighter'],
    players: [
      { id: 'mage', character: 'Аль', characterClass: 'wizard', level: 9, hp: 30, maxHp: 30, armor: 12, speed: 30, proficiency: 4, abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 }, inventory: [], x: 1, y: 0 },
      { id: 'fighter', character: 'Бранн', characterClass: 'fighter', level: 5, hp: 40, maxHp: 40, armor: 16, speed: 30, proficiency: 3, abilities: { str: 16, dex: 12, con: 16, int: 10, wis: 10, cha: 10 }, inventory: [SWORD], x: 1, y: 1 },
    ],
    enemies: [{ id: 'ogre', name: 'Огр', creature_type: 'giant', hp: 300, maxHp: 300, armor: 11, speed: 30, abilities: { str: 18, dex: 8, con: 16, int: 5, wis: 7, cha: 7 }, x: 2, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'mage', total: 20 }, { actor_id: 'fighter', total: 15 }, { actor_id: 'ogre', total: 8 }],
        action_economy: {
          mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          fighter: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          ogre: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const strike = (state, values) => resolveCommand(
  authoritative({ command_type: 'MakeAttack', actor_id: 'fighter', target_id: 'ogre', item_id: 'sword' }),
  state,
  options(dice(values)),
)

const endCurrentTurn = (state) => {
  const combat = state.mechanics.combat
  const activeId = String(combat.initiative[combat.active_index]?.actor_id ?? '')
  return replayEvents(state, resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: activeId }), state, options(dice([10, 10, 10]))).events)
}

/**
 * Доводит очередь до хода нужного участника. Экономика хода перевыдаётся
 * событием `TurnStarted`, поэтому бонусы Ускорения появляются только так —
 * подменять индекс инициативы вручную здесь нельзя.
 */
function advanceTo(state, actorId) {
  let current = state
  for (let guard = 0; guard < 8; guard += 1) {
    const combat = current.mechanics.combat
    if (String(combat.initiative[combat.active_index]?.actor_id ?? '') === actorId) return current
    current = endCurrentTurn(current)
  }
  throw new Error(`не удалось дойти до хода ${actorId}`)
}

function hasteFighter(state) {
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'haste', target_id: 'fighter', target_ids: ['fighter'] }),
    state,
    options(dice()),
  )
  return { cast, state: replayEvents(state, cast.events) }
}

test('Ускорение поднимает класс доспеха и удваивает скорость', () => {
  const { cast, state } = hasteFighter(party())
  const added = cast.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'hasted')
  assert.deepEqual(added.target_ids, ['fighter'])
  assert.equal(added.payload.duration, 'concentration')

  // КД 16 + 2. Проверяем через атаку огра.
  const swing = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'ogre', target_id: 'fighter' }),
    advanceTo(state, 'ogre'),
    options(dice([14, 5])),
  )
  const resolved = swing.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(resolved.payload.armor_class, 18, 'Ускорение обязано поднять КД на 2')

  // Скорость 60 против обычных 30: путь в десять клеток (огр в (2,1) заставляет
  // обходить по верхнему ряду) проходим только ускоренным.
  const destination = { x: 10, y: 0 }
  // Уход из-под огра провоцирует атаку по возможности — на неё тоже нужны кости.
  const far = resolveCommand(authoritative({ command_type: 'MoveActor', actor_id: 'fighter', to: destination }), advanceTo(state, 'fighter'), options(dice([9, 4])))
  assert.ok(far.events.some((event) => event.event_type === 'ActorMoved'), 'ускоренный обязан пройти 50 футов')
  assert.throws(
    () => resolveCommand(authoritative({ command_type: 'MoveActor', actor_id: 'fighter', to: destination }), advanceTo(party(), 'fighter'), options(dice())),
    (error) => error.code === 'SPEED_EXCEEDED',
    'без Ускорения тот же путь недоступен',
  )
})

test('Ускорение даёт дополнительное действие и ровно одну лишнюю атаку', () => {
  const hasted = advanceTo(hasteFighter(party()).state, 'fighter')
  assert.equal(hasted.mechanics.combat.action_economy.fighter.extra_actions, 1, 'начало хода обязано выдать дополнительное действие')

  let current = hasted
  for (let index = 0; index < 3; index += 1) {
    const swing = strike(current, [15, 5])
    assert.ok(swing.events.some((event) => event.event_type === 'AttackResolved'), `удар ${index + 1} обязан пройти`)
    current = replayEvents(current, swing.events)
  }
  assert.equal(current.mechanics.combat.action_economy.fighter.attacks_used, 3)
  assert.equal(current.mechanics.combat.action_economy.fighter.attacks_allowed, 3, 'два удара действия плюс один от Ускорения')
  assert.throws(() => strike(current, [15, 5]), (error) => error.code === 'ACTION_SPENT', 'четвёртый удар недоступен')
})

test('дополнительным действием Ускорения нельзя творить магию', () => {
  const state = party()
  const mageHasted = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'haste', target_id: 'mage', target_ids: ['mage'] }),
    state,
    options(dice()),
  )
  // Дополнительное действие выдаётся началом следующего хода, поэтому круг
  // нужно провернуть целиком.
  const magesTurn = advanceTo(endCurrentTurn(replayEvents(state, mageHasted.events)), 'mage')
  assert.equal(magesTurn.mechanics.combat.action_economy.mage.extra_actions, 1)

  const first = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'magic-missile', target_id: 'ogre', target_ids: ['ogre'] }),
    magesTurn,
    options(dice([2, 2, 2])),
  )
  const afterFirst = replayEvents(magesTurn, first.events)
  assert.throws(
    () => resolveCommand(
      authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'magic-missile', target_id: 'ogre', target_ids: ['ogre'] }),
      afterFirst,
      options(dice([2, 2, 2])),
    ),
    (error) => error.code === 'ACTION_SURGE_MAGIC_FORBIDDEN',
  )
})

test('Замедление режет скорость вдвое, снимает 2 с КД и запрещает реакции', () => {
  const state = party()
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'slow', target_id: 'ogre', target_ids: ['ogre'] }),
    state,
    options(dice([3])),
  )
  const added = cast.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'slowed')
  assert.deepEqual(added.target_ids, ['ogre'])
  assert.equal(added.payload.repeat_save_timing, 'turn-end')

  const slowed = replayEvents(state, cast.events)
  const attack = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'fighter', target_id: 'ogre', item_id: 'sword' }),
    { ...slowed, mechanics: { ...slowed.mechanics, combat: { ...slowed.mechanics.combat, active_index: 1 } } },
    options(dice([10, 5])),
  )
  assert.equal(attack.events.find((event) => event.event_type === 'AttackResolved').payload.armor_class, 9, 'КД 11 минус 2')

  const ogresTurn = advanceTo(slowed, 'ogre')
  assert.equal(ogresTurn.mechanics.combat.action_economy.ogre.reaction, false, 'замедленный лишается реакции')
  assert.throws(
    () => resolveCommand(authoritative({ command_type: 'MoveActor', actor_id: 'ogre', to: { x: 6, y: 1 } }), ogresTurn, options(dice())),
    (error) => error.code === 'SPEED_EXCEEDED',
    'на половине скорости четыре клетки недоступны',
  )
})

test('прежние источники КД и скорости считаются той же таблицей', () => {
  const state = party()
  const shielded = normalizeCampaignState({
    ...state,
    mechanics: { ...state.mechanics, conditions: { fighter: [{ id: 'shield-of-faith' }], ogre: [{ id: 'speed-reduced-10' }] } },
  })
  const attack = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'ogre', target_id: 'fighter' }),
    { ...shielded, mechanics: { ...shielded.mechanics, combat: { ...shielded.mechanics.combat, active_index: 2 } } },
    options(dice([10, 5])),
  )
  assert.equal(attack.events.find((event) => event.event_type === 'AttackResolved').payload.armor_class, 18, 'КД 16 плюс 2 от защитных чар')
  assert.throws(
    () => resolveCommand(
      authoritative({ command_type: 'MoveActor', actor_id: 'ogre', to: { x: 7, y: 1 } }),
      { ...shielded, mechanics: { ...shielded.mechanics, combat: { ...shielded.mechanics.combat, active_index: 2 } } },
      options(dice()),
    ),
    (error) => error.code === 'SPEED_EXCEEDED',
    'скорость 20 не покрывает пять клеток',
  )
})
