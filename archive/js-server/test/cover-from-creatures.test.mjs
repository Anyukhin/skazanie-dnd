import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `cover-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

const BOW = { id: 'bow', name: 'Длинный лук', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'ranged', ability: 'dex', damage: '1d8', damageType: 'piercing', normalRange: 150 } }
const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: false, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

/**
 * Archer at (1,1), target at (6,1).  The optional ally sits at (3,1) — squarely
 * on the line of fire, which is the whole point of the rule.
 */
function shootingRange({ allyAt = null, archerClass = 'ranger' } = {}) {
  const cells = Array.from({ length: 30 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  const players = [{ id: 'archer', character: 'Лучница', characterClass: archerClass, level: 5, hp: 30, maxHp: 30, armor: 15, speed: 30, proficiency: 3, abilities: { str: 10, dex: 16, con: 12, int: 10, wis: 14, cha: 10 }, inventory: [BOW, SWORD], x: 1, y: 1 }]
  if (allyAt) players.push({ id: 'ally', character: 'Щит', characterClass: 'fighter', level: 5, hp: 40, maxHp: 40, armor: 18, speed: 30, proficiency: 3, abilities: { str: 16, dex: 10, con: 16, int: 10, wis: 10, cha: 10 }, inventory: [], x: allyAt.x, y: allyAt.y })
  return normalizeCampaignState({
    sessionCode: 'COVER-1',
    partyMemberIds: players.map((player) => player.id),
    players,
    enemies: [{ id: 'brigand', name: 'Разбойник', creature_type: 'humanoid', hp: 40, maxHp: 40, armor: 13, speed: 30, abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, x: 6, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'archer', total: 20 }, { actor_id: 'brigand', total: 8 }],
        action_economy: { archer: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

const shoot = (state, values, extra = {}) => resolveCommand(
  authoritative({ command_type: 'MakeAttack', actor_id: 'archer', target_id: 'brigand', item_id: 'bow', ...extra }),
  state,
  options(dice(values)),
)

const resolved = (result) => result.events.find((event) => event.event_type === 'AttackResolved').payload

test('чистая линия огня не даёт цели укрытия', () => {
  const payload = resolved(shoot(shootingRange(), [10, 4]))
  assert.equal(payload.armor_class, 13)
  assert.equal(payload.cover, undefined)
})

test('союзник на линии огня даёт цели половинное укрытие: +2 к КД', () => {
  const payload = resolved(shoot(shootingRange({ allyAt: { x: 3, y: 1 } }), [10, 4]))
  assert.equal(payload.cover, 'half')
  assert.equal(payload.cover_bonus, 2)
  assert.deepEqual(payload.cover_blockers, ['ally'])
  assert.equal(payload.armor_class, 15, 'укрытие обязано поднять КД цели')
})

test('укрытие решает исход выстрела, а не только украшает протокол', () => {
  // Ловкость 16 (+3) и мастерство 3 дают +6: бросок 8 даёт итог 14.
  const clear = resolved(shoot(shootingRange(), [8, 4]))
  assert.equal(clear.total, 14)
  assert.equal(clear.hit, true, 'без укрытия 14 против КД 13 — попадание')

  const covered = resolved(shoot(shootingRange({ allyAt: { x: 3, y: 1 } }), [8, 4]))
  assert.equal(covered.total, 14)
  assert.equal(covered.hit, false, 'с половинным укрытием тот же бросок не достаёт до КД 15')
})

test('союзник в стороне от линии укрытия не даёт', () => {
  const payload = resolved(shoot(shootingRange({ allyAt: { x: 3, y: 2 } }), [10, 4]))
  assert.equal(payload.cover, undefined)
  assert.equal(payload.armor_class, 13)
})

test('в ближнем бою укрытия не бывает: между соседями некому встать', () => {
  const state = shootingRange({ allyAt: { x: 3, y: 1 } })
  const adjacent = normalizeCampaignState({
    ...state,
    players: [{ ...state.players[0], inventory: [{ ...SWORD, equipped: true }] }, state.players[1]],
    enemies: [{ ...state.enemies[0], x: 2, y: 1 }],
    // Позиции живут отдельно от полей x/y, поэтому переносить цель нужно в обоих местах.
    mechanics: { ...state.mechanics, positions: { ...state.mechanics.positions, brigand: { x: 2, y: 1 } } },
  })
  const payload = resolved(resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'archer', target_id: 'brigand', item_id: 'sword' }),
    adjacent,
    options(dice([10, 4])),
  ))
  assert.equal(payload.cover, undefined)
  assert.equal(payload.armor_class, 13)
})

test('бочка на линии огня даёт половинное укрытие, колонна — три четверти', () => {
  const withFeature = (feature) => {
    const state = shootingRange()
    return normalizeCampaignState({
      ...state,
      scene: {
        ...state.scene,
        cells: state.scene.cells.map((cell) => (cell.x === 3 && cell.y === 1 ? { ...cell, feature } : cell)),
      },
    })
  }

  const barrel = resolved(shoot(withFeature('barrel'), [10, 4]))
  assert.equal(barrel.cover, 'half')
  assert.equal(barrel.cover_bonus, 2)
  assert.deepEqual(barrel.cover_scenery, ['barrel'])
  assert.equal(barrel.armor_class, 15)

  const pillar = resolved(shoot(withFeature('pillar'), [10, 4]))
  assert.equal(pillar.cover, 'three-quarters')
  assert.equal(pillar.cover_bonus, 5)
  assert.equal(pillar.armor_class, 18, 'колонна прячет цель заметно лучше бочки')

  const rug = resolved(shoot(withFeature('chair'), [10, 4]))
  assert.equal(rug.cover, undefined, 'за стулом не спрячешься — список укрытий серверный и явный')
})

test('лучшее укрытие не складывается с остальными', () => {
  const state = shootingRange({ allyAt: { x: 2, y: 1 } })
  const withPillar = normalizeCampaignState({
    ...state,
    scene: {
      ...state.scene,
      cells: state.scene.cells.map((cell) => (cell.x === 3 && cell.y === 1 ? { ...cell, feature: 'pillar' } : cell)),
    },
  })
  const payload = resolved(shoot(withPillar, [10, 4]))
  assert.equal(payload.cover, 'three-quarters')
  assert.equal(payload.cover_bonus, 5, 'союзник и колонна вместе дают лучшее укрытие, а не сумму')
  assert.deepEqual(payload.cover_blockers, ['ally'])
})

test('мёртвое тело на линии огня укрытия не даёт', () => {
  const state = shootingRange({ allyAt: { x: 3, y: 1 } })
  const fallen = normalizeCampaignState({
    ...state,
    players: [state.players[0], { ...state.players[1], hp: 0 }],
  })
  const payload = resolved(shoot(fallen, [10, 4]))
  assert.equal(payload.cover, undefined, 'укрытие даёт живое существо, а не тело')
})
