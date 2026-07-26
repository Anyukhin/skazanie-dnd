// Граница полномочий агента при импровизации: что он может предложить и что
// сервер обязан отвергнуть. Тесты стерегут именно отказы — они и есть защита.
import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import {
  ACTION_COSTS,
  ENVIRONMENT_HAZARDS,
  IMPROVISED_EFFECTS,
  planImprovisedEffect,
  resolveActionCost,
} from '../server/improvised-effects.mjs'
import { normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

function battlefield(economy = { action: true, bonus_action: true, movement: true, movement_spent: 0 }) {
  return normalizeCampaignState({
    players: [
      { id: 'hero', hp: 12, maxHp: 12, armor: 14, speed: 30, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, x: 0, y: 0, inventory: [] },
      { id: 'ally', hp: 10, maxHp: 10, armor: 13, speed: 30, abilities: { str: 10, dex: 14 }, x: 1, y: 0, inventory: [] },
    ],
    enemies: [{ id: 'ogre', hp: 20, maxHp: 20, armor: 12, alive: true, x: 2, y: 0 }],
    scene: { cells: Array.from({ length: 4 }, (_, x) => ({ x, y: 0, type: 'floor', revealed: true })), turn: 1 },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero' }, { actor_id: 'ogre' }],
        action_economy: { hero: economy },
      },
    },
  })
}

test('незнакомый эффект не исполняется, а сводится к «ничего не произошло»', () => {
  const plan = planImprovisedEffect(battlefield(), { actorId: 'hero', effectId: 'instant_kill', targetId: 'ogre' })
  assert.equal(plan.effect.id, 'none')
  assert.deepEqual(plan.commands, [], 'выдуманный агентом эффект не должен породить ни одной команды')
})

test('эффект нельзя навести на неподходящую сторону или на отсутствующую цель', () => {
  const state = battlefield()
  const onAlly = planImprovisedEffect(state, { actorId: 'hero', effectId: 'prone', targetId: 'ally' })
  assert.equal(onAlly.effect.id, 'none')
  assert.match(onAlly.rejected, /противник/)

  const helpEnemy = planImprovisedEffect(state, { actorId: 'hero', effectId: 'help_ally', targetId: 'ogre' })
  assert.equal(helpEnemy.effect.id, 'none')
  assert.match(helpEnemy.rejected, /союзник/)

  const ghost = planImprovisedEffect(state, { actorId: 'hero', effectId: 'prone', targetId: 'дракон' })
  assert.equal(ghost.effect.id, 'none')
  assert.match(ghost.rejected, /нет на поле/)
})

test('разрешённый эффект превращается в команду, которую движок уже умеет исполнять', () => {
  const state = battlefield()
  const plan = planImprovisedEffect(state, { actorId: 'hero', effectId: 'prone', targetId: 'ogre' })
  assert.equal(plan.commands.length, 1)
  assert.deepEqual(plan.commands[0], {
    command_type: 'AddCondition', actor_id: 'hero', target_id: 'ogre', condition: 'prone', source: 'improvised-action',
  })
  const events = resolveCommand(plan.commands[0], state, { diceService: new DiceService({ rng: new SequenceDiceRng([1]) }) }).events
  assert.equal(events[0].event_type, 'ConditionAdded')
  assert.equal(events[0].payload.condition, 'prone')
})

test('урон окружением берёт кости из серверной таблицы, а не от агента', () => {
  const state = battlefield()
  const plan = planImprovisedEffect(state, {
    actorId: 'hero', effectId: 'hazard_damage', targetId: 'ogre', hazardId: 'fire', risk: 'serious',
  })
  assert.equal(plan.commands[0].expression, ENVIRONMENT_HAZARDS.fire.expressions.serious)
  assert.equal(plan.commands[0].damage_type, 'fire')

  // Ставка выбирается сервером, поэтому подмена риска не даёт агенту усилить удар
  // сверх таблицы: значения ограничены её же строками.
  const capped = planImprovisedEffect(state, {
    actorId: 'hero', effectId: 'hazard_damage', targetId: 'ogre', hazardId: 'fire', risk: '99d99',
  })
  assert.equal(capped.commands[0].expression, ENVIRONMENT_HAZARDS.fire.expressions.minor)

  const unknownHazard = planImprovisedEffect(state, {
    actorId: 'hero', effectId: 'hazard_damage', targetId: 'ogre', hazardId: 'meteor', risk: 'deadly',
  })
  assert.equal(unknownHazard.effect.id, 'none')
  assert.match(unknownHazard.rejected, /опасности нет/)
})

test('цена хода проверяется по экономии, а не по желанию агента', () => {
  assert.deepEqual(resolveActionCost(normalizeCampaignState({ players: [{ id: 'hero' }] }), 'hero', 'action'), { cost: 'free', available: true },
    'вне боя импровизация ничего не стоит')

  const fresh = resolveActionCost(battlefield(), 'hero', 'action')
  assert.equal(fresh.available, true)

  const spent = resolveActionCost(battlefield({ action: false, bonus_action: true, movement: true, movement_spent: 0 }), 'hero', 'action')
  assert.equal(spent.available, false, 'потраченное действие нельзя потратить второй раз')

  const bonusLeft = resolveActionCost(battlefield({ action: false, bonus_action: true, movement: true, movement_spent: 0 }), 'hero', 'bonus_action')
  assert.equal(bonusLeft.available, true)

  const asMovement = resolveActionCost(battlefield(), 'hero', 'movement')
  assert.equal(asMovement.cost, 'action', 'перемещение движок отдельным слотом не списывает — цена сводится к действию')

  const invented = resolveActionCost(battlefield(), 'hero', 'сделать бесплатно')
  assert.equal(invented.cost, 'action', 'неизвестный слот трактуется как самый дорогой')
  assert.ok(ACTION_COSTS.includes(invented.cost))
})

test('каталог эффектов закрыт и каждый эффект знает свою сторону', () => {
  for (const [id, effect] of Object.entries(IMPROVISED_EFFECTS)) {
    assert.equal(effect.id, id)
    assert.ok(['none', 'ally', 'enemy'].includes(effect.target), `${id}: сторона обязана быть объявлена`)
    assert.ok(effect.summary, `${id}: нужен текст для игрока`)
  }
})
