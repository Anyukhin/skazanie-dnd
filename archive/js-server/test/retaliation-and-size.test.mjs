import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `ret-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }
const BOW = { id: 'bow', name: 'Длинный лук', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 150 } }

function field({ casterClass = 'wizard', level = 12, conditions = {}, inventory = [SWORD], foeAt = { x: 2, y: 2 } } = {}) {
  const cells = Array.from({ length: 96 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'RET-1',
    partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Аль', characterClass: casterClass, level, hp: 50, maxHp: 50, armor: 10, speed: 30, proficiency: 4, abilities: { str: 18, dex: 16, con: 14, int: 18, wis: 16, cha: 14 }, inventory, x: 1, y: 2 }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 120, maxHp: 120, armor: 10, speed: 30, abilities: { str: 16, dex: 12, con: 14, int: 8, wis: 8, cha: 8 }, x: foeAt.x, y: foeAt.y, alive: true, inventory: [SWORD] }],
    scene: { turn: 1, cells },
    mechanics: {
      conditions,
      resources: { mage: Object.fromEntries([1, 2, 3, 4, 5, 6].map((slot) => [`spell_slots_${slot}`, { current: 3, max: 3 }])) },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'mage', total: 20 }, { actor_id: 'brute', total: 8 }],
        action_economy: {
          mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          brute: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const brutesTurn = (state) => ({ ...state, mechanics: { ...state.mechanics, combat: { ...state.mechanics.combat, active_index: 1 } } })
const damages = (result) => result.events.filter((event) => event.event_type === 'DamageApplied').map((event) => event.payload)

test('Огненный щит жжёт того, кто ударил в ближнем бою', () => {
  const state = field({ conditions: { mage: [{ id: 'fire-shield-warm' }] } })
  const hit = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'brute', target_id: 'mage', item_id: 'sword' }),
    brutesTurn(state),
    options(dice([15, 5, 4, 4])),
  )
  const back = hit.events.find((event) => event.event_type === 'DamageApplied' && event.payload.retaliation)
  assert.ok(back, 'щит обязан ответить')
  assert.equal(back.payload.damage_type, 'fire')
  assert.equal(back.payload.raw_amount, 8, '2к8 по четвёрке')
  assert.equal(hit.rolls.find((roll) => roll.purpose === 'condition_retaliation:fire-shield-warm').expression, '2d8')
})

test('щит не отвечает на выстрел издалека', () => {
  const state = field({ conditions: { mage: [{ id: 'fire-shield-warm' }] }, foeAt: { x: 9, y: 2 } })
  const shot = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'brute', target_id: 'mage', item_id: 'bow' }),
    brutesTurn({ ...state, enemies: [{ ...state.enemies[0], inventory: [BOW] }] }),
    options(dice([15, 5])),
  )
  assert.equal(shot.events.some((event) => event.event_type === 'DamageApplied' && event.payload.retaliation), false)
})

test('холодный щит даёт сопротивление огню и отвечает холодом', () => {
  const state = field({ conditions: { mage: [{ id: 'fire-shield-chill' }] } })
  const hit = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'brute', target_id: 'mage', item_id: 'sword' }),
    brutesTurn(state),
    options(dice([15, 5, 4, 4])),
  )
  assert.equal(hit.events.find((event) => event.event_type === 'DamageApplied' && event.payload.retaliation).payload.damage_type, 'cold')
})

test('выбор стороны щита решает, какое состояние ляжет', () => {
  const state = field({ casterClass: 'druid' })
  const chill = replayEvents(state, resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'fire-shield', target_id: 'mage', spell_option: 'chill' }),
    state,
    options(dice()),
  ).events)
  assert.ok(chill.mechanics.conditions.mage.some((condition) => String(condition.id) === 'fire-shield-chill'))
  assert.equal(chill.mechanics.conditions.mage.some((condition) => String(condition.id) === 'fire-shield-warm'), false)
})

test('Увеличение добавляет кость урона, Уменьшение — отнимает', () => {
  const strike = (conditions, values) => resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'mage', target_id: 'brute', item_id: 'sword' }),
    field({ conditions }),
    options(dice(values)),
  )
  const plain = damages(strike({}, [15, 5]))[0].raw_amount
  const big = damages(strike({ mage: [{ id: 'enlarged' }] }, [15, 5, 3]))[0].raw_amount
  const small = damages(strike({ mage: [{ id: 'reduced' }] }, [15, 5, 3]))[0].raw_amount

  assert.equal(big - plain, 3, 'увеличенный бьёт на кость сильнее')
  assert.equal(plain - small, 3, 'уменьшенный — на ту же кость слабее')
})

test('штрафная кость не уводит урон в минус', () => {
  const weak = field({ conditions: { mage: [{ id: 'reduced' }] } })
  weak.players[0].abilities.str = 6
  weak.players[0].inventory = [{ id: 'stick', name: 'Палка', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d4', damageType: 'bludgeoning', normalRange: 5 } }]
  const hit = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'mage', target_id: 'brute', item_id: 'stick' }),
    normalizeCampaignState(weak),
    options(dice([18, 1, 4])),
  )
  assert.equal(damages(hit)[0].raw_amount, 0, 'урон не бывает отрицательным')
})

test('Молниеносная стрела заряжает только дальнобойный удар', () => {
  const state = field({ casterClass: 'ranger', level: 9, inventory: [BOW], foeAt: { x: 9, y: 2 } })
  const charged = replayEvents(state, resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'lightning-arrow', target_id: 'mage' }),
    state,
    options(dice()),
  ).events)
  const shot = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'mage', target_id: 'brute', item_id: 'bow' }),
    charged,
    options(dice([16, 5, 3, 3, 3, 3])),
  )
  const bonus = shot.events.find((event) => event.event_type === 'DamageApplied' && event.payload.next_weapon_hit)
  assert.ok(bonus, 'заряд обязан сработать на выстреле')
  assert.equal(bonus.payload.damage_type, 'lightning')
  assert.equal(bonus.payload.raw_amount, 12)
})
