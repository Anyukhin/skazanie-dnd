import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `shape-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

/** Друид и раненый союзник: у него 9 хитов из 40, КД 16, скорость 25. */
function shapeField() {
  const cells = Array.from({ length: 30 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'SHAPE-1',
    partyMemberIds: ['druid', 'ally'],
    players: [
      { id: 'druid', character: 'Вейл', characterClass: 'druid', level: 9, hp: 40, maxHp: 40, armor: 14, speed: 30, proficiency: 4, abilities: { str: 10, dex: 14, con: 14, int: 12, wis: 18, cha: 10 }, inventory: [], x: 1, y: 1 },
      { id: 'ally', character: 'Бранн', characterClass: 'fighter', level: 5, hp: 9, maxHp: 40, armor: 16, speed: 25, proficiency: 3, abilities: { str: 16, dex: 12, con: 16, int: 10, wis: 10, cha: 10 }, inventory: [], x: 2, y: 1 },
    ],
    enemies: [{ id: 'ogre', name: 'Огр', hp: 60, maxHp: 60, armor: 11, speed: 30, attackBonus: 6, damageDice: 12, damageBonus: 4, abilities: { str: 18, dex: 8, con: 16, int: 5, wis: 7, cha: 7 }, x: 3, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'druid', total: 20 }, { actor_id: 'ally', total: 15 }, { actor_id: 'ogre', total: 8 }],
        action_economy: { druid: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

const polymorph = (state) => resolveCommand(
  authoritative({ command_type: 'CastSpell', actor_id: 'druid', spell_id: 'polymorph', target_id: 'ally', target_ids: ['ally'] }),
  state,
  options(dice()),
)

const heroOf = (state, id) => state.players.find((hero) => hero.id === id)

test('превращение подменяет лист существа целиком и запоминает исходный', () => {
  const state = shapeField()
  const cast = polymorph(state)
  const changed = cast.events.find((event) => event.event_type === 'ShapeChanged')
  assert.ok(changed, 'заклинание обязано сменить облик')
  assert.equal(changed.payload.form.name, 'Гигантский паук')

  const shaped = replayEvents(state, cast.events)
  const beast = heroOf(shaped, 'ally')
  assert.equal(beast.hp, 26, 'у облика собственные хиты')
  assert.equal(beast.maxHp, 26)
  assert.equal(beast.armor, 14)
  assert.equal(beast.attack_profile.damage_expression, '1d8+3')

  const remembered = shaped.mechanics.shapes.ally
  assert.equal(remembered.original.hp, 9, 'исходные хиты сохранены как были')
  assert.equal(remembered.original.maxHp, 40)
  assert.equal(remembered.original.armor, 16)
  assert.equal(remembered.original.speed, 25)
})

test('облик работает буфером: урон уходит в него, а не в настоящее тело', () => {
  const state = shapeField()
  const shaped = replayEvents(state, polymorph(state).events)
  const hurt = resolveCommand(
    authoritative({ command_type: 'ApplyDamage', actor_id: 'ogre', target_id: 'ally', amount: 10, damage_type: 'bludgeoning' }),
    shaped,
    options(dice()),
  )
  const after = replayEvents(shaped, hurt.events)
  assert.equal(heroOf(after, 'ally').hp, 16, 'бьют по облику')
  assert.equal(after.mechanics.shapes.ally.original.hp, 9, 'настоящее тело не тронуто')
})

test('когда облик кончается, существо возвращается в себя, а лишний урон переходит на него', () => {
  const state = shapeField()
  const shaped = replayEvents(state, polymorph(state).events)
  // 30 урона по облику с 26 хитами: четыре лишних достаются настоящему телу.
  const hurt = resolveCommand(
    authoritative({ command_type: 'ApplyDamage', actor_id: 'ogre', target_id: 'ally', amount: 30, damage_type: 'bludgeoning' }),
    shaped,
    options(dice()),
  )
  const reverted = hurt.events.find((event) => event.event_type === 'ShapeReverted')
  assert.ok(reverted, 'облик обязан развеяться')
  assert.equal(reverted.payload.reason, 'form-destroyed')
  assert.equal(reverted.payload.excess_damage, 4)
  assert.equal(hurt.events.some((event) => event.event_type === 'HitPointsReducedToZero'), false, 'зверь не падает без сознания вместо героя')

  const after = replayEvents(shaped, hurt.events)
  const hero = heroOf(after, 'ally')
  assert.equal(hero.hp, 5, '9 исходных минус 4 лишних')
  assert.equal(hero.maxHp, 40, 'настоящий максимум вернулся')
  assert.equal(hero.armor, 16)
  assert.equal(hero.speed, 25)
  assert.equal(after.mechanics.shapes.ally, undefined, 'облик больше не хранится')
})

test('исход превращения воспроизводится replay-ем', () => {
  const state = shapeField()
  const cast = polymorph(state)
  const shaped = replayEvents(state, cast.events)
  const hurt = resolveCommand(
    authoritative({ command_type: 'ApplyDamage', actor_id: 'ogre', target_id: 'ally', amount: 30, damage_type: 'bludgeoning' }),
    shaped,
    options(dice()),
  )
  assert.deepEqual(replayEvents(state, [...cast.events, ...hurt.events]), replayEvents(shaped, hurt.events))
})
