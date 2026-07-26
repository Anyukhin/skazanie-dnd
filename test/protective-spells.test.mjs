import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `guard-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

function field({ casterClass = 'druid', level = 9, allyHp = 20, foeType = 'humanoid', foeAt = { x: 3, y: 1 }, foe = {} } = {}) {
  const cells = Array.from({ length: 60 }, (_, index) => ({ x: index % 12, y: Math.floor(index / 12), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'GUARD-1',
    partyMemberIds: ['caster', 'ally'],
    players: [
      { id: 'caster', character: 'Аль', characterClass: casterClass, level, hp: 40, maxHp: 40, armor: 14, speed: 30, proficiency: 4, abilities: { str: 10, dex: 12, con: 14, int: 16, wis: 18, cha: 14 }, inventory: [], x: 1, y: 1 },
      { id: 'ally', character: 'Бор', characterClass: 'wizard', level: 9, hp: allyHp, maxHp: 40, armor: 11, speed: 30, proficiency: 4, abilities: { str: 8, dex: 12, con: 12, int: 18, wis: 10, cha: 10 }, inventory: [], x: 2, y: 1 },
    ],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: foeType, hp: 40, maxHp: 40, armor: 13, speed: 30, abilities: { str: 16, dex: 10, con: 14, int: 8, wis: 8, cha: 8 }, x: foeAt.x, y: foeAt.y, alive: true, ...foe }],
    scene: { turn: 1, cells },
    mechanics: {
      resources: { caster: { spell_slots_2: { current: 3, max: 3 }, spell_slots_3: { current: 3, max: 3 } } },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'ally', total: 15 }, { actor_id: 'brute', total: 8 }],
        action_economy: {
          caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          ally: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          brute: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const cast = (state, spellId, values, extra = {}) => resolveCommand(
  authoritative({ command_type: 'CastSpell', actor_id: 'caster', spell_id: spellId, target_id: 'ally', ...extra }),
  state,
  options(dice(values)),
)

test('Кора задаёт нижнюю границу класса доспеха, а не прибавку', () => {
  const state = field()
  const after = replayEvents(state, cast(state, 'barkskin', []).events)
  // Маг в мантии: класс доспеха 11 подтягивается до 16.
  const shot = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'brute', target_id: 'ally' }),
    { ...after, mechanics: { ...after.mechanics, combat: { ...after.mechanics.combat, active_index: 2 } } },
    options(dice([8, 4])),
  )
  const attack = shot.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attack.payload.armor_class, 16, 'класс доспеха подтянут с 11 до 16')
  assert.equal(attack.payload.hit, false, 'бросок, которого хватило бы на 11, против 16 промахивается')
})

test('Кора не складывается с доспехом лучше себя', () => {
  const heavy = field()
  heavy.players[1].armor = 18
  const after = replayEvents(normalizeCampaignState(heavy), cast(normalizeCampaignState(heavy), 'barkskin', []).events)
  const shot = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'brute', target_id: 'ally' }),
    { ...after, mechanics: { ...after.mechanics, combat: { ...after.mechanics.combat, active_index: 2 } } },
    options(dice([14, 4])),
  )
  assert.equal(shot.events.find((event) => event.event_type === 'AttackResolved').payload.armor_class, 18, 'латы лучше коры и остаются')
})

test('Крепость интеллекта даёт сопротивление психике и преимущество на спасбросок Мудрости', () => {
  const state = field({ casterClass: 'bard' })
  assert.ok(replayEvents(state, cast(state, 'intellect-fortress', []).events)
    .mechanics.conditions.ally.some((condition) => String(condition.id) === 'intellect-fortress'))

  // Само преимущество проверяем на противнике: у врагов свой список доступных
  // заклинаний, поэтому вражеский колдун здесь ничего не бросит, а бард — да.
  const guarded = normalizeCampaignState({
    ...state,
    mechanics: { ...state.mechanics, conditions: { brute: [{ id: 'intellect-fortress' }] } },
  })
  const whispers = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'caster', spell_id: 'dissonant-whispers', target_id: 'brute' }),
    guarded,
    options(dice([3, 3, 3, 19, 2])),
  )
  const save = whispers.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(save.payload.ability, 'wis')
  assert.equal(save.payload.save_advantage_condition, 'intellect-fortress', 'преимущество пришло из таблицы состояний')
  assert.equal(save.payload.saved, true, 'из двух костей взята лучшая')
})

test('Массовое лечащее слово лечит всех одним броском', () => {
  const state = field({ casterClass: 'cleric', allyHp: 10 })
  const wounded = normalizeCampaignState({ ...state, players: state.players.map((player) => ({ ...player, hp: player.id === 'caster' ? 25 : 10 })) })
  const result = cast(wounded, 'mass-healing-word', [3], { target_ids: ['caster', 'ally'], target_id: undefined })
  const healed = result.events.filter((event) => event.event_type === 'HealingApplied')
  assert.equal(healed.length, 2, 'обе цели получают лечение')
  assert.equal(result.rolls.filter((roll) => roll.purpose.startsWith('spell_healing')).length, 1, 'бросок один на всех')
  assert.equal(healed.every((event) => event.payload.applied_amount === healed[0].payload.applied_amount), true)
})

test('Невидимость даёт преимущество своим атакам и помеху чужим', () => {
  const state = field({ casterClass: 'wizard' })
  const after = replayEvents(state, cast(state, 'invisibility', []).events)
  assert.ok(after.mechanics.conditions.ally.some((condition) => String(condition.id) === 'invisible'))

  const shot = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'brute', target_id: 'ally' }),
    { ...after, mechanics: { ...after.mechanics, combat: { ...after.mechanics.combat, active_index: 2 } } },
    options(dice([18, 3, 4])),
  )
  assert.equal(shot.rolls.find((roll) => roll.purpose === 'attack').mode, 'disadvantage', 'по невидимому бьют с помехой')
})

test('Успокоение эмоций снимает очарование и испуг с гуманоида', () => {
  // Громилу уводим подальше: сфера в 20 футов накрыла бы и своих, и тогда
  // бросков нужно три, а проверяем мы не это.
  const state = field({ casterClass: 'bard', foeAt: { x: 10, y: 1 } })
  const afraid = normalizeCampaignState({
    ...state,
    mechanics: { ...state.mechanics, conditions: { brute: [{ id: 'frightened' }, { id: 'charmed' }] } },
  })
  const result = cast(afraid, 'calm-emotions', [2], { to: { x: 10, y: 1 }, target_id: undefined })
  const removed = result.events.filter((event) => event.event_type === 'ConditionRemoved').map((event) => event.payload.condition)
  assert.deepEqual(removed.sort(), ['charmed', 'frightened'])
})

test('на негуманоида Успокоение эмоций не действует', () => {
  const state = field({ casterClass: 'bard', foeType: 'undead', foeAt: { x: 10, y: 1 } })
  const afraid = normalizeCampaignState({
    ...state,
    mechanics: { ...state.mechanics, conditions: { brute: [{ id: 'frightened' }] } },
  })
  const result = cast(afraid, 'calm-emotions', [2], { to: { x: 10, y: 1 }, target_id: undefined })
  assert.equal(result.events.find((event) => event.event_type === 'SpellSavingThrowResolved').payload.automatic_success, true)
  assert.equal(result.events.some((event) => event.event_type === 'ConditionRemoved'), false, 'нежить остаётся напуганной')
})
