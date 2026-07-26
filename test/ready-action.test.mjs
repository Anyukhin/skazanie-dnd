import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `ready-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })
const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

/** Боец в (1,1), громила далеко в (8,1): между ними есть куда подходить. */
function field({ inventory = [SWORD], foeAt = { x: 8, y: 1 } } = {}) {
  const cells = Array.from({ length: 60 }, (_, index) => ({ x: index % 12, y: Math.floor(index / 12), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'READY-1',
    partyMemberIds: ['guard'],
    players: [{ id: 'guard', character: 'Страж', characterClass: 'fighter', level: 5, hp: 45, maxHp: 45, armor: 17, speed: 30, proficiency: 3, abilities: { str: 18, dex: 12, con: 16, int: 10, wis: 12, cha: 10 }, inventory, x: 1, y: 1 }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 40, maxHp: 40, armor: 13, speed: 40, abilities: { str: 16, dex: 10, con: 14, int: 8, wis: 8, cha: 8 }, x: foeAt.x, y: foeAt.y, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'guard', total: 20 }, { actor_id: 'brute', total: 8 }],
        action_economy: {
          guard: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          brute: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const ready = (state, trigger = 'enemy-approaches') => resolveCommand(
  authoritative({ command_type: 'UseCombatAction', actor_id: 'guard', action_id: 'ready-action', readied_trigger: trigger }),
  state,
  options(dice()),
)

/** Готовность, передача хода громиле и его подход вплотную. */
function approach(state, to = { x: 2, y: 1 }) {
  const readied = replayEvents(state, ready(state).events)
  const passed = replayEvents(readied, resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'guard' }), readied, options(dice())).events)
  const moved = resolveCommand(authoritative({ command_type: 'MoveActor', actor_id: 'brute', to }), passed, options(dice()))
  return { passed, moved, state: replayEvents(passed, moved.events) }
}

test('Готовность тратит действие и записывает заготовку', () => {
  const state = field()
  const result = ready(state)
  const readiedEvent = result.events.find((event) => event.event_type === 'ActionReadied')
  assert.ok(readiedEvent, 'заготовка обязана попасть в события')
  assert.equal(readiedEvent.payload.trigger, 'enemy-approaches')
  assert.equal(readiedEvent.payload.readied_action_id, 'readied-attack')

  const after = replayEvents(state, result.events)
  assert.equal(after.mechanics.combat.readied.guard.trigger, 'enemy-approaches')
  assert.equal(after.mechanics.combat.action_economy.guard.action, false, 'действие потрачено')
  assert.equal(after.mechanics.combat.action_economy.guard.reaction, true, 'реакция пока цела — она нужна на срабатывание')
})

test('нераспознаваемый триггер отклоняется, а не записывается молча', () => {
  assert.throws(() => ready(field(), 'когда мне покажется подозрительным'), (error) => error.code === 'READIED_TRIGGER_UNKNOWN')
})

test('заготовить можно только то, чем есть чем ударить', () => {
  // Голые руки — законная атака, поэтому пустой рюкзак заготовке не мешает:
  // проверка ровно та же, что у атаки по возможности, и это намеренно.
  assert.ok(ready(field({ inventory: [] })).events.some((event) => event.event_type === 'ActionReadied'))

  // А вот тот, чья единственная атака дальнобойна, заготовить удар не может.
  const spitter = field({ inventory: [] })
  spitter.players[0].attack_profile = { name: 'Плевок кислотой', range_feet: 60, damage: '1d6', damage_type: 'acid' }
  assert.throws(() => ready(normalizeCampaignState(spitter)), (error) => error.code === 'WEAPON_REQUIRED')
})

test('подошедший враг открывает окно, и заготовленный удар проходит', () => {
  const { moved, state } = approach(field())
  const window = moved.events.find((event) => event.event_type === 'ReactionWindowOpened')
  assert.ok(window, 'подход вплотную обязан открыть окно')
  assert.equal(window.payload.trigger, 'readied')
  assert.equal(window.payload.actor_id, 'guard')
  assert.deepEqual(window.payload.action_ids, ['readied-attack'])

  const strike = resolveCommand(
    authoritative({ command_type: 'UseCombatAction', actor_id: 'guard', action_id: 'readied-attack', item_id: 'sword' }),
    state,
    options(dice([18, 5])),
  )
  const attack = strike.events.find((event) => event.event_type === 'AttackResolved')
  assert.ok(attack?.payload.hit, 'заготовленный удар попадает')
  assert.equal(strike.events.find((event) => event.event_type === 'DamageApplied').payload.raw_amount, 9)
  assert.ok(strike.events.some((event) => event.event_type === 'ReadiedActionExpired' && event.payload.reason === 'used'))

  const spent = replayEvents(state, strike.events)
  assert.equal(spent.mechanics.combat.readied.guard, undefined, 'использованная заготовка снимается')
  assert.equal(spent.mechanics.combat.action_economy.guard.reaction, false, 'срабатывание съело реакцию')
})

test('враг, который и так стоял вплотную, триггер не выдаёт', () => {
  // Триггер называется «подойдёт»: шаг вдоль стены рядом со стражем подходом
  // не является, иначе заготовка срабатывала бы на любое шевеление в упор.
  const { moved } = approach(field({ foeAt: { x: 2, y: 1 } }), { x: 2, y: 2 })
  assert.equal(moved.events.some((event) => event.event_type === 'ReactionWindowOpened' && event.payload.trigger === 'readied'), false)
})

test('заготовка пропадает к началу собственного следующего хода', () => {
  const { state } = approach(field(), { x: 5, y: 1 })
  assert.equal(state.mechanics.combat.readied.guard.trigger, 'enemy-approaches', 'враг не дошёл — заготовка ещё цела')

  const round = replayEvents(state, resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'brute' }), state, options(dice())).events)
  assert.equal(round.mechanics.combat.readied.guard, undefined, 'круг замкнулся — несработавшая заготовка сгорела')
})

test('заготовленное заклинание тратит ячейку сразу и держится концентрацией', () => {
  const state = normalizeCampaignState({
    ...field(),
    players: [{ ...field().players[0], characterClass: 'wizard', level: 9, abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 12, cha: 10 } }],
    mechanics: { ...field().mechanics, resources: { guard: { spell_slots_1: { current: 3, max: 3 }, spell_slots_3: { current: 3, max: 3 } } } },
  })
  const result = resolveCommand(
    authoritative({ command_type: 'UseCombatAction', actor_id: 'guard', action_id: 'ready-action', readied_trigger: 'enemy-approaches', readied_spell_id: 'fireball' }),
    state,
    options(dice()),
  )
  const spent = result.events.find((event) => event.event_type === 'ResourceSpent')
  assert.equal(spent.payload.resource, 'spell_slots_3', 'ячейка уходит в момент заготовки, а не при выпуске')
  assert.ok(result.events.some((event) => event.event_type === 'ConcentrationStarted'), 'удержание требует концентрации')

  const readied = result.events.find((event) => event.event_type === 'ActionReadied')
  assert.equal(readied.payload.readied_action_id, 'readied-spell')
  assert.equal(readied.payload.spell_id, 'fireball')

  const after = replayEvents(state, result.events)
  assert.equal(after.mechanics.combat.readied.guard.spell_id, 'fireball')
  assert.equal(after.mechanics.resources.guard.spell_slots_3.current, 2)
  assert.equal(after.mechanics.combat.action_economy.guard.action, false)
})

test('заклинание с временем накладывания «бонусное действие» заготовить нельзя', () => {
  const state = normalizeCampaignState({
    ...field(),
    players: [{ ...field().players[0], characterClass: 'cleric', level: 9, abilities: { str: 10, dex: 12, con: 14, int: 10, wis: 18, cha: 12 } }],
    mechanics: { ...field().mechanics, resources: { guard: { spell_slots_1: { current: 3, max: 3 } } } },
  })
  assert.throws(() => resolveCommand(
    authoritative({ command_type: 'UseCombatAction', actor_id: 'guard', action_id: 'ready-action', readied_trigger: 'enemy-approaches', readied_spell_id: 'healing-word' }),
    state,
    options(dice()),
  ), (error) => error.code === 'READIED_SPELL_ACTION_ONLY')
})

test('подошедший враг получает заготовленное заклинание, а не удар', () => {
  const base = normalizeCampaignState({
    ...field(),
    players: [{ ...field().players[0], characterClass: 'wizard', level: 9, abilities: { str: 10, dex: 14, con: 14, int: 18, wis: 12, cha: 10 } }],
    mechanics: { ...field().mechanics, resources: { guard: { spell_slots_1: { current: 3, max: 3 } } } },
  })
  const readied = replayEvents(base, resolveCommand(
    authoritative({ command_type: 'UseCombatAction', actor_id: 'guard', action_id: 'ready-action', readied_trigger: 'enemy-approaches', readied_spell_id: 'magic-missile' }),
    base,
    options(dice()),
  ).events)
  const passed = replayEvents(readied, resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'guard' }), readied, options(dice())).events)
  const moved = resolveCommand(authoritative({ command_type: 'MoveActor', actor_id: 'brute', to: { x: 2, y: 1 } }), passed, options(dice()))

  const window = moved.events.find((event) => event.event_type === 'ReactionWindowOpened')
  assert.ok(window, 'подход обязан открыть окно')
  assert.deepEqual(window.payload.action_ids, ['readied-spell'], 'предлагается выпуск, а не удар')

  const released = resolveCommand(
    authoritative({ command_type: 'UseCombatAction', actor_id: 'guard', action_id: 'readied-spell', target_id: 'brute' }),
    replayEvents(passed, moved.events),
    options(dice([3])),
  )
  assert.ok(released.events.some((event) => event.event_type === 'SpellCast' && event.payload.spell_id === 'magic-missile'))
  assert.ok(released.events.some((event) => event.event_type === 'DamageApplied'), 'заклинание действительно бьёт')
  // Ячейка уже была потрачена при заготовке — второй раз платить нельзя.
  assert.equal(released.events.some((event) => event.event_type === 'ResourceSpent'), false, 'выпуск ячейку не тратит')
  assert.ok(released.events.some((event) => event.event_type === 'ConcentrationEnded'), 'удержание кончилось')
  assert.ok(released.events.some((event) => event.event_type === 'ReadiedActionExpired'))
})

test('заготовка на заклинание срабатывает, когда враг начинает творить', () => {
  const base = field({ foeAt: { x: 2, y: 1 } })
  const caster = normalizeCampaignState({
    ...base,
    enemies: [{ ...base.enemies[0], characterClass: 'wizard', level: 5, abilities: { str: 10, dex: 12, con: 12, int: 16, wis: 10, cha: 10 } }],
  })
  const readied = replayEvents(caster, ready(caster, 'enemy-casts-spell').events)
  const passed = replayEvents(readied, resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'guard' }), readied, options(dice())).events)

  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'brute', spell_id: 'fire-bolt', target_id: 'guard' }),
    passed,
    options(dice([15, 5, 5, 5, 5, 5])),
  )
  const window = cast.events.find((event) => event.event_type === 'ReactionWindowOpened')
  assert.ok(window, 'начало заклинания обязано открыть окно заготовки')
  assert.equal(window.payload.readied_trigger, 'enemy-casts-spell')
  assert.equal(window.payload.actor_id, 'guard')
})
