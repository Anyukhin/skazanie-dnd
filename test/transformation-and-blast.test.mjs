import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `tf-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

function field({ casterClass = 'wizard', level = 12, inventory = [SWORD], foeAt = { x: 2, y: 2 }, conditions = {} } = {}) {
  const cells = Array.from({ length: 96 }, (_, index) => ({ x: index % 16, y: Math.floor(index / 16), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'TF-1',
    partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Аль', characterClass: casterClass, level, hp: 50, maxHp: 50, armor: 13, speed: 30, proficiency: 4, abilities: { str: 18, dex: 14, con: 14, int: 18, wis: 18, cha: 14 }, inventory, x: 1, y: 2 }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 120, maxHp: 120, armor: 10, speed: 30, abilities: { str: 10, dex: 8, con: 10, int: 8, wis: 8, cha: 8 }, x: foeAt.x, y: foeAt.y, alive: true, inventory: [SWORD] }],
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

const cast = (state, spellId, values, extra = {}) => resolveCommand(
  authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: spellId, ...extra }),
  state,
  options(dice(values)),
)
const damages = (result) => result.events.filter((event) => event.event_type === 'DamageApplied').map((event) => event.payload)

/** Новый ход: применение заклинания уже потратило действие. */
const freshTurn = (state, id = 'mage') => ({
  ...state,
  mechanics: {
    ...state.mechanics,
    combat: {
      ...state.mechanics.combat,
      action_economy: { ...state.mechanics.combat.action_economy, [id]: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
    },
  },
})

test('Громовой шаг бьёт по покинутой клетке, а не по точке прибытия', () => {
  const state = field({ foeAt: { x: 2, y: 2 } })
  const result = cast(state, 'thunder-step', [4, 4, 4, 2], { to: { x: 12, y: 2 } })
  const moved = result.events.find((event) => event.event_type === 'ActorMoved')
  assert.equal(moved.payload.teleport, true)
  assert.deepEqual(moved.payload.to, { x: 12, y: 2 })

  const damage = damages(result)[0]
  assert.ok(damage, 'стоявший рядом с точкой отправления получает удар')
  assert.equal(damage.damage_type, 'thunder')
  assert.equal(damage.raw_amount, 12)
  assert.equal(damages(result).some((entry) => entry.hp_before === 50), false, 'сам заклинатель не задет')
})

test('стоящий у точки прибытия под гром не попадает', () => {
  const state = field({ foeAt: { x: 12, y: 2 } })
  const result = cast(state, 'thunder-step', [4, 4, 4], { to: { x: 12, y: 3 } })
  assert.equal(damages(result).length, 0, 'гром остаётся там, откуда ушли')
})

test('Пляска Отто топчет на месте и подставляет под удар', () => {
  const state = field({ casterClass: 'bard' })
  const danced = replayEvents(state, cast(state, 'otto-s-irresistible-dance', [2], { target_id: 'brute' }).events)
  assert.ok(danced.mechanics.conditions.brute.some((condition) => String(condition.id) === 'dancing'))

  const swing = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'brute', target_id: 'mage', item_id: 'sword' }),
    { ...danced, mechanics: { ...danced.mechanics, combat: { ...danced.mechanics.combat, active_index: 1 } } },
    options(dice([15, 3, 5])),
  )
  assert.equal(swing.rolls.find((roll) => roll.purpose === 'attack').mode, 'disadvantage', 'пляшущий бьёт с помехой')

  const back = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'mage', target_id: 'brute', item_id: 'sword' }),
    freshTurn(danced),
    options(dice([15, 3, 5])),
  )
  assert.equal(back.rolls.find((roll) => roll.purpose === 'attack').mode, 'advantage', 'по пляшущему бьют с преимуществом')
})

test('Превращение Тензера даёт временные хиты и лишние кости урона', () => {
  const state = field()
  const result = cast(state, 'tenser-s-transformation', [], { target_id: 'mage' })
  const temporary = result.events.find((event) => event.event_type === 'TemporaryHitPointsGranted')
  assert.equal(temporary.payload.offered, 50)

  const transformed = replayEvents(state, result.events)
  const swing = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'mage', target_id: 'brute', item_id: 'sword' }),
    freshTurn(transformed),
    options(dice([15, 15, 5, 6, 6])),
  )
  assert.equal(swing.rolls.find((roll) => roll.purpose === 'attack').mode, 'advantage', 'преимущество на атаку')
  const bonus = swing.rolls.find((roll) => roll.purpose === 'condition_damage:tensers-transformation')
  assert.equal(bonus.expression, '2d12')
  assert.equal(damages(swing)[0].raw_amount, 5 + 4 + 12)
})

test('Страж природы: обе формы дают кость, но разные преимущества', () => {
  const state = field({ casterClass: 'druid' })
  const tree = replayEvents(state, cast(state, 'guardian-of-nature', [], { target_id: 'mage', spell_option: 'great-tree' }).events)
  assert.ok(tree.mechanics.conditions.mage.some((condition) => String(condition.id) === 'guardian-great-tree'))

  const beast = replayEvents(state, cast(state, 'guardian-of-nature', [], { target_id: 'mage', spell_option: 'primal-beast' }).events)
  assert.ok(beast.mechanics.conditions.mage.some((condition) => String(condition.id) === 'guardian-primal-beast'))

  const swing = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'mage', target_id: 'brute', item_id: 'sword' }),
    freshTurn(beast),
    options(dice([15, 5, 3])),
  )
  assert.equal(swing.rolls.find((roll) => roll.purpose === 'condition_damage:guardian-primal-beast').expression, '1d6')
  assert.equal(damages(swing)[0].raw_amount, 5 + 4 + 3)
})

test('Кости земли и Превращение камня бьют площадью', () => {
  // Громилу уводим подальше: иначе заклинатель попадает в собственную область
  // и бросков нужно вдвое больше, а проверяем мы не это.
  const bones = cast(field({ casterClass: 'druid', foeAt: { x: 10, y: 2 } }), 'bones-of-the-earth', [4, 4, 4, 4, 4, 4, 2], { to: { x: 10, y: 2 }, target_id: undefined })
  assert.equal(damages(bones)[0].raw_amount, 24)

  const rock = cast(field({ casterClass: 'druid', foeAt: { x: 10, y: 2 } }), 'transmute-rock', [4, 4, 4, 4, 2], { to: { x: 10, y: 2 }, target_id: undefined })
  assert.equal(damages(rock)[0].raw_amount, 16)
  assert.ok(rock.events.some((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'prone'))
  assert.equal(rock.events.find((event) => event.event_type === 'SpellAreaCreated').payload.effect.difficult_terrain, true)
})

test('Пылевой вихрь бьёт и отбрасывает', () => {
  const result = cast(field({ casterClass: 'druid', foeAt: { x: 10, y: 2 } }), 'dust-devil', [4, 2], { to: { x: 10, y: 2 }, target_id: undefined })
  assert.equal(damages(result)[0].raw_amount, 4)
  const pushed = result.events.find((event) => event.event_type === 'ActorMoved' && event.payload.forced_movement)
  assert.ok(pushed, 'провалившего спасбросок Силы сдувает')
})
