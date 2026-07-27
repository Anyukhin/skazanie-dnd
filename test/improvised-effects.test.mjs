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
    // Союзник и огр стоят вплотную к герою: импровизация — это касание, и
    // расстановка не должна мешать проверять сторону цели.
    players: [
      { id: 'hero', hp: 12, maxHp: 12, armor: 14, speed: 30, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, x: 0, y: 0, inventory: [] },
      { id: 'ally', hp: 10, maxHp: 10, armor: 13, speed: 30, abilities: { str: 10, dex: 14 }, x: 0, y: 1, inventory: [] },
    ],
    enemies: [{ id: 'ogre', hp: 20, maxHp: 20, armor: 12, alive: true, x: 1, y: 0 }],
    scene: {
      cells: Array.from({ length: 30 }, (_, index) => ({
        x: index % 15, y: Math.floor(index / 15), type: 'floor', revealed: true,
      })),
      turn: 1,
    },
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

// Сторона и живость цели проверялись, а дальность — нет: агент называл любого
// противника на карте, и сервер сбивал его с ног или подставлял под огонь через
// весь коридор. Продуктовые принципы требуют, чтобы сервер проверял дальность
// сам, а не полагался на выбор модели.
test('эффект нельзя навести на цель вне досягаемости', () => {
  const state = battlefield()
  // Огр отходит на двенадцать клеток — это 60 футов, дальше любого касания.
  state.enemies[0] = { ...state.enemies[0], x: 12, y: 0 }
  state.mechanics.positions.ogre = { x: 12, y: 0 }

  const prone = planImprovisedEffect(state, { actorId: 'hero', effectId: 'prone', targetId: 'ogre' })
  assert.equal(prone.effect.id, 'none')
  assert.match(prone.rejected, /далеко/)
  assert.deepEqual(prone.commands, [])

  const hazard = planImprovisedEffect(state, {
    actorId: 'hero', effectId: 'hazard_damage', targetId: 'ogre', hazardId: 'fire', risk: 'deadly',
  })
  assert.equal(hazard.effect.id, 'none')
  assert.match(hazard.rejected, /далеко/)
  assert.deepEqual(hazard.commands, [], 'урон через весь коридор не должен породить ни одной команды')

  // Тот же эффект вплотную проходит: отвергается дистанция, а не сам эффект.
  const adjacent = planImprovisedEffect(battlefield(), { actorId: 'hero', effectId: 'prone', targetId: 'ogre' })
  assert.equal(adjacent.effect.id, 'prone')
  assert.equal(adjacent.commands.length, 1)
})

// Решение пользователя от 2026-07-27: окрик и брошенная в глаза горсть песка
// работают на расстоянии, остальное — касание. Проверяется именно граница между
// двумя группами, а не одно число: иначе тест переживёт любую правку каталога.
test('окрик и ослепление достают дальше касания, остальные эффекты — нет', () => {
  const state = battlefield()
  // Четыре клетки — 20 футов: дальше касания, но в пределах слышимости.
  state.enemies[0] = { ...state.enemies[0], x: 4, y: 0 }
  state.mechanics.positions.ogre = { x: 4, y: 0 }

  for (const effectId of ['distract', 'blind']) {
    const plan = planImprovisedEffect(state, { actorId: 'hero', effectId, targetId: 'ogre' })
    assert.equal(plan.effect.id, effectId, `${effectId}: должен доставать на 20 футов`)
    assert.equal(plan.commands.length, 1)
  }
  for (const effectId of ['prone', 'restrain', 'hazard_damage']) {
    const plan = planImprovisedEffect(state, { actorId: 'hero', effectId, targetId: 'ogre', hazardId: 'fire' })
    assert.equal(plan.effect.id, 'none', `${effectId}: касание не должно доставать на 20 футов`)
    assert.match(plan.rejected, /далеко/)
  }

  // И у дальних эффектов дальность не бесконечна.
  const far = battlefield()
  far.enemies[0] = { ...far.enemies[0], x: 8, y: 0 }
  far.mechanics.positions.ogre = { x: 8, y: 0 }
  const shout = planImprovisedEffect(far, { actorId: 'hero', effectId: 'distract', targetId: 'ogre' })
  assert.equal(shout.effect.id, 'none', 'на 40 футах окрик тоже обязан получить отказ')
  assert.match(shout.rejected, /далеко/)
})

test('каталог эффектов закрыт и каждый эффект знает свою сторону и досягаемость', () => {
  for (const [id, effect] of Object.entries(IMPROVISED_EFFECTS)) {
    assert.equal(effect.id, id)
    assert.ok(['none', 'ally', 'enemy'].includes(effect.target), `${id}: сторона обязана быть объявлена`)
    assert.ok(effect.summary, `${id}: нужен текст для игрока`)
    // Эффект без объявленной досягаемости получил бы её нулём и не сработал бы
    // никогда. Новый эффект обязан назвать дистанцию, а не унаследовать молчание.
    if (effect.target !== 'none') {
      assert.ok(Number.isInteger(effect.range_feet) && effect.range_feet > 0, `${id}: досягаемость обязана быть объявлена`)
    }
  }
})
