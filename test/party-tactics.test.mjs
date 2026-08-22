import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HEAL_THRESHOLD_RATIO,
  UNCANNY_DODGE_DAMAGE_PERCENT,
  healingTargetFor,
  planHeroReaction,
  planHeroTurn,
} from '../server/party-tactics.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { withStarterKit } from '../server/starter-kit.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `party-tactics-roll-${++id}`,
    now: () => '2026-08-18T12:00:00.000Z',
  })
}

const applyAll = (state, events) => events.reduce(applyGameEvent, state)
const authoritative = (values = []) => ({ diceService: dice(values), context: { serverAuthoritativeCombat: true } })

const POTION = { id: 'item-potion', catalog_id: 'srd_5_2_1:potion-of-healing', name: 'Зелье лечения', quantity: 1, type: 'consumable' }
// Форма `combat` повторяет каталог снаряжения (`server/starter-kit.mjs`):
// дальность там называется `normalRange`/`longRange`, и выдуманное поле в
// фикстуре скрыло бы ровно ту ошибку, ради которой этот файл и существует.
const SWORD = { id: 'item-sword', catalog_id: 'srd_5_2_1:longsword', name: 'Длинный меч', quantity: 1, type: 'weapon', equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

// Пустая сцена ломает поиск пути: без клеток герой не может дойти никуда, и
// любой план вырождается в EndTurn. Проверять тактику на такой карте бессмысленно.
const floor = (size = 12) => {
  const cells = []
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) cells.push({ x, y, type: 'floor', revealed: true })
  return cells
}

function battle({ heroes = [], enemies = [], positions = {}, size = 12 } = {}) {
  return normalizeCampaignState({
    sessionCode: 'TACTICS',
    partyMemberIds: heroes.map((hero) => hero.id),
    activePlayerId: heroes[0]?.id,
    scene: { title: 'Схватка', location: 'Ворота', cells: floor(size) },
    players: heroes,
    enemies,
    mechanics: {
      positions,
      combat: { active: true, round: 1, initiative: [], active_index: 0 },
    },
  })
}

const hero = (id, overrides = {}) => ({
  id, character: id, hp: 12, maxHp: 12, speed: 30,
  abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
  inventory: [SWORD], ...overrides,
})

const enemy = (id, overrides = {}) => ({
  id, name: id, hp: 10, maxHp: 10, armor: 12, speed: 30, attackBonus: 3, damageDice: 6, damageBonus: 1,
  action_profiles: [{ id: 'claw', name: 'Коготь', kind: 'melee', attack_modifier: 3, damage_expression: '1d6+1', damage_type: 'slashing', range_feet: 5 }],
  ...overrides,
})

test('упавший союзник лечится раньше, чем наносится ещё один удар', () => {
  const state = battle({
    heroes: [hero('medic', { inventory: [SWORD, POTION] }), hero('fallen', { hp: 0 })],
    enemies: [enemy('wolf', { hp: 1 })],
    positions: { medic: { x: 1, y: 1 }, fallen: { x: 2, y: 1 }, wolf: { x: 1, y: 2 } },
  })
  const plan = planHeroTurn(state, 'medic')

  assert.equal(plan.rule, 'heal-ally')
  const use = plan.commands.find((command) => command.command_type === 'UseItem')
  assert.ok(use, 'зелье обязано быть применено')
  assert.equal(use.target_id, 'fallen')
  assert.equal(use.item_id, 'item-potion')
  assert.equal(plan.commands.at(-1).command_type, 'EndTurn')
})

test('без зелья в сумке герой не пытается лечить и просто дерётся', () => {
  const state = battle({
    heroes: [hero('medic'), hero('fallen', { hp: 0 })],
    enemies: [enemy('wolf')],
    positions: { medic: { x: 1, y: 1 }, fallen: { x: 2, y: 1 }, wolf: { x: 1, y: 2 } },
  })
  const plan = planHeroTurn(state, 'medic')

  assert.equal(plan.commands.some((command) => command.command_type === 'UseItem'), false)
  assert.equal(plan.rule, 'attack-adjacent')
})

test('противник вплотную бьётся первым, а не тот, у кого меньше ОЗ на другом конце карты', () => {
  const state = battle({
    heroes: [hero('fighter')],
    enemies: [enemy('adjacent-orc', { hp: 9 }), enemy('far-wounded', { hp: 1 })],
    positions: { fighter: { x: 1, y: 1 }, 'adjacent-orc': { x: 1, y: 2 }, 'far-wounded': { x: 9, y: 9 } },
  })
  const plan = planHeroTurn(state, 'fighter')

  assert.equal(plan.rule, 'attack-adjacent')
  assert.equal(plan.commands.some((command) => command.command_type === 'MoveActor'), false)
  const attack = plan.commands.find((command) => command.command_type === 'MakeAttack')
  assert.equal(attack.target_id, 'adjacent-orc')
  assert.equal(attack.item_id, 'item-sword', 'автономный герой обязан бить экипированным оружием, а не базовым уроном')
})

// Стартовое снаряжение берётся у самого каталога, а не переписывается руками:
// разойтись с ним — и тактика снова начнёт считать дальность по полю, которого
// у настоящего предмета нет.
const ranger = () => withStarterKit({ id: 'ranger', character: 'ranger', characterClass: 'ranger', hp: 12, maxHp: 12, speed: 30 })

test('лучник стреляет с дистанции, а не идёт в упор', () => {
  const bow = ranger().inventory.find((item) => item.catalog_id === 'srd_5_2_1:shortbow')
  assert.equal(bow?.equipped, true, 'следопыт обязан выходить с экипированным луком')
  assert.equal(bow.combat.normalRange, 80, 'обычная дальность лука — 80 футов')

  const state = battle({
    heroes: [ranger()],
    enemies: [enemy('orc')],
    // Восемь клеток — 40 футов: далеко для меча и близко для лука.
    positions: { ranger: { x: 1, y: 1 }, orc: { x: 9, y: 1 } },
  })
  const plan = planHeroTurn(state, 'ranger')

  assert.equal(plan.rule, 'attack-focus')
  assert.equal(plan.commands.some((command) => command.command_type === 'MoveActor'), false, 'подходить незачем — цель уже на дистанции выстрела')
  const attack = plan.commands.find((command) => command.command_type === 'MakeAttack')
  assert.equal(attack?.item_id, bow.id)
})

test('за пределом обычной дальности лучник подходит, а не стреляет с помехой', () => {
  const state = battle({
    size: 30,
    heroes: [ranger()],
    // Двадцать четыре клетки — 120 футов: в предельные 320 укладывается, но
    // выстрел оттуда идёт с помехой за дальность.
    enemies: [enemy('orc')],
    positions: { ranger: { x: 1, y: 1 }, orc: { x: 25, y: 1 } },
  })
  const plan = planHeroTurn(state, 'ranger')

  assert.equal(plan.rule, 'advance')
  assert.equal(plan.commands.some((command) => command.command_type === 'MakeAttack'), false)
  assert.deepEqual(plan.commands.find((command) => command.command_type === 'MoveActor')?.to, { x: 7, y: 1 }, 'герой проходит все 30 футов навстречу')
})

test('сбитый с ног автономный герой встаёт до атаки и платит половиной скорости', () => {
  const state = battle({
    heroes: [hero('fighter')],
    enemies: [enemy('adjacent-wolf')],
    positions: { fighter: { x: 1, y: 1 }, 'adjacent-wolf': { x: 1, y: 2 } },
  })
  state.mechanics.conditions.fighter = [{ id: 'prone', source_actor: 'adjacent-wolf' }]

  const plan = planHeroTurn(state, 'fighter')
  assert.deepEqual(plan.commands.map((command) => command.command_type), ['UseCombatAction', 'MakeAttack', 'EndTurn'])
  assert.equal(plan.commands[0].action_id, 'stand-up')

  const distant = battle({
    heroes: [hero('fighter')],
    enemies: [enemy('distant-wolf')],
    positions: { fighter: { x: 1, y: 1 }, 'distant-wolf': { x: 6, y: 1 } },
  })
  distant.mechanics.conditions.fighter = [{ id: 'prone', source_actor: 'distant-wolf' }]
  const advance = planHeroTurn(distant, 'fighter')
  const move = advance.commands.find((command) => command.command_type === 'MoveActor')
  assert.deepEqual(move?.to, { x: 4, y: 1 }, 'после подъёма остаётся только 15 футов движения')
  assert.equal(advance.commands.some((command) => command.command_type === 'MakeAttack'), false)
})

test('когда рядом никого — прежнее сосредоточение огня на самом раненом', () => {
  const state = battle({
    heroes: [hero('fighter')],
    enemies: [enemy('healthy', { hp: 10 }), enemy('wounded', { hp: 2 })],
    positions: { fighter: { x: 1, y: 1 }, healthy: { x: 5, y: 1 }, wounded: { x: 4, y: 1 } },
  })
  const plan = planHeroTurn(state, 'fighter')

  const attack = plan.commands.find((command) => command.command_type === 'MakeAttack')
  assert.ok(plan.commands.some((command) => command.command_type === 'MoveActor'), 'до цели надо дойти')
  assert.equal(attack?.target_id, 'wounded')
})

test('герой лечит сам себя, когда упал ниже порога и рядом никого нет', () => {
  const state = battle({
    heroes: [hero('lonely', { hp: 3, inventory: [SWORD, POTION] })],
    enemies: [enemy('wolf')],
    positions: { lonely: { x: 1, y: 1 }, wolf: { x: 8, y: 8 } },
  })
  const plan = planHeroTurn(state, 'lonely')

  assert.equal(plan.rule, 'heal-self')
  const use = plan.commands.find((command) => command.command_type === 'UseItem')
  assert.equal(use.target_id, 'lonely')
})

test('здоровый отряд зелья не тратит', () => {
  const state = battle({
    heroes: [hero('fighter', { inventory: [SWORD, POTION] }), hero('ally', { hp: 12 })],
    enemies: [enemy('wolf')],
    positions: { fighter: { x: 1, y: 1 }, ally: { x: 2, y: 1 }, wolf: { x: 1, y: 2 } },
  })
  const plan = planHeroTurn(state, 'fighter')

  assert.equal(plan.commands.some((command) => command.command_type === 'UseItem'), false)
  assert.equal(plan.rule, 'attack-adjacent')
})

test('порог лечения объявлен и применяется к максимуму ОЗ, а не к абсолютному числу', () => {
  assert.ok(HEAL_THRESHOLD_RATIO > 0 && HEAL_THRESHOLD_RATIO < 1)
  const state = battle({
    heroes: [hero('tank', { hp: 30, maxHp: 100 }), hero('scout', { hp: 5, maxHp: 8 })],
    enemies: [enemy('wolf')],
    positions: { tank: { x: 1, y: 1 }, scout: { x: 2, y: 1 }, wolf: { x: 8, y: 8 } },
  })
  // 30/100 ниже порога, 5/8 выше — цель выбирается по доле, а не по числу ОЗ.
  assert.equal(healingTargetFor(state, 'tank')?.id, 'tank')
})

test('окончательно погибшего героя политика лечить не пытается', () => {
  const state = battle({
    heroes: [hero('medic', { inventory: [SWORD, POTION] }), hero('lost', { hp: 0 })],
    enemies: [enemy('wolf')],
    positions: { medic: { x: 1, y: 1 }, lost: { x: 2, y: 1 }, wolf: { x: 8, y: 8 } },
  })
  state.mechanics.death = { campaign_status: 'active', heroes: { lost: { status: 'dead' } } }
  assert.equal(healingTargetFor(state, 'medic'), null)
})

test('план детерминирован: то же состояние даёт тот же порядок команд', () => {
  const make = () => battle({
    heroes: [hero('a', { inventory: [SWORD, POTION] }), hero('b', { hp: 2 })],
    enemies: [enemy('x', { hp: 4 }), enemy('y', { hp: 4 })],
    positions: { a: { x: 1, y: 1 }, b: { x: 4, y: 4 }, x: { x: 6, y: 1 }, y: { x: 7, y: 1 } },
  })
  assert.deepEqual(planHeroTurn(make(), 'a'), planHeroTurn(make(), 'a'))
})

test('план всегда завершается EndTurn — иначе автономный бой зависнет', () => {
  const cases = [
    battle({ heroes: [hero('h')], enemies: [], positions: { h: { x: 1, y: 1 } } }),
    battle({ heroes: [hero('h')], enemies: [enemy('e')], positions: { h: { x: 1, y: 1 }, e: { x: 20, y: 20 } } }),
    battle({ heroes: [hero('h', { inventory: [] })], enemies: [enemy('e')], positions: { h: { x: 1, y: 1 }, e: { x: 1, y: 2 } } }),
  ]
  for (const state of cases) {
    assert.equal(planHeroTurn(state, 'h').commands.at(-1).command_type, 'EndTurn')
  }
})

/* ------------------------------------------------------------------------ *
 * Реакции автономной партии
 *
 * Окно реакции открывает движок, и все проверки — ячейка, оружие, свободная
 * реакция — уже сделаны им. Поэтому тесты ниже намеренно не подсовывают
 * политике выдуманные окна, а прогоняют настоящий удар и настоящий отход:
 * иначе они проверяли бы не поведение автономного героя, а собственную
 * фикстуру.
 * ------------------------------------------------------------------------ */

function reactionBattle({ heroOverrides = {}, enemyOverrides = {}, positions = null } = {}) {
  const state = battle({
    heroes: [{
      id: 'mage',
      character: 'Иллейна',
      characterClass: 'wizard',
      role: 'Волшебник · ур. 3',
      level: 3,
      hp: 20,
      maxHp: 20,
      armor: 15,
      speed: 30,
      proficiency: 2,
      abilities: { str: 10, dex: 12, con: 12, int: 16, wis: 10, cha: 10 },
      inventory: [SWORD],
      ...heroOverrides,
    }],
    enemies: [enemy('goblin', { attackBonus: 4, damageDice: 6, damageBonus: 2, ...enemyOverrides })],
    positions: positions ?? { mage: { x: 1, y: 1 }, goblin: { x: 2, y: 1 } },
  })
  // Бьёт и уходит противник, поэтому указатель инициативы стоит на нём.
  state.mechanics.combat.initiative = [{ actor_id: 'goblin', total: 18 }, { actor_id: 'mage', total: 12 }]
  state.mechanics.combat.active_index = 0
  state.mechanics.combat.action_economy = {
    goblin: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
    mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
  }
  return normalizeCampaignState(state)
}

const enemyAttack = { command_type: 'MakeAttack', actor_id: 'goblin', target_id: 'mage', server_authoritative: true }

test('автономный волшебник поднимает «Щит», и попадание перестаёт быть попаданием', () => {
  const state = reactionBattle()
  const attacked = applyAll(state, resolveCommand(enemyAttack, state, authoritative([14, 4])).events)
  assert.ok(attacked.mechanics.combat.reaction_window.action_ids.includes('cast:shield'))
  assert.ok(attacked.players[0].hp < 20, 'удар обязан пройти, иначе окно ничего не значит')

  const plan = planHeroReaction(attacked)
  assert.equal(plan.rule, 'cast:shield')
  assert.equal(plan.commands.length, 1)
  assert.deepEqual(plan.commands[0], {
    command_type: 'UseCombatAction', actor_id: 'mage', action_id: 'cast:shield',
    target_id: 'goblin', server_authoritative: true,
  })

  const shielded = applyAll(attacked, resolveCommand(plan.commands[0], attacked, authoritative()).events)
  assert.equal(shielded.players[0].hp, 20, 'Щит обязан вернуть весь урон')
  assert.equal(shielded.mechanics.combat.reaction_window, null)
  assert.equal(shielded.mechanics.combat.action_economy.mage.reaction, false)
  assert.equal(shielded.mechanics.resources.mage.spell_slots_1.current, 3)
  assert.ok(shielded.mechanics.conditions.mage.some((condition) => condition.id === 'shielded'))
})

test('без ячейки «Щит» не предлагается вовсе и политика честно отказывается', () => {
  const state = reactionBattle()
  state.mechanics.resources.mage.spell_slots_1 = { current: 0, max: 4 }
  state.mechanics.resources.mage.spell_slots_2 = { current: 0, max: 2 }
  const attacked = applyAll(normalizeCampaignState(state), resolveCommand(enemyAttack, state, authoritative([14, 4])).events)

  assert.equal(attacked.mechanics.combat.reaction_window, null, 'пустые ячейки не открывают окно «Щита» вовсе')
  const plan = planHeroReaction(attacked)
  assert.equal(plan.rule, 'decline-reaction')
  assert.deepEqual(plan.commands, [{
    command_type: 'UseCombatAction', actor_id: '', action_id: 'decline-reaction', server_authoritative: true,
  }])
})

test('окно «Щита» без ячейки закрывается отказом, а не выдуманной ячейкой', () => {
  const state = reactionBattle()
  const attacked = applyAll(state, resolveCommand(enemyAttack, state, authoritative([14, 4])).events)
  // Ячейка тратится между открытием окна и ответом — политика обязана увидеть
  // это по самому окну, а не по собственной памяти.
  const emptied = {
    ...attacked,
    mechanics: {
      ...attacked.mechanics,
      combat: {
        ...attacked.mechanics.combat,
        reaction_window: { ...attacked.mechanics.combat.reaction_window, action_ids: [], action_options: [] },
      },
    },
  }
  assert.equal(planHeroReaction(emptied).rule, 'decline-reaction')
  assert.equal(planHeroReaction(emptied).commands[0].actor_id, 'mage')
})

test('автономный герой бьёт вдогонку уходящему противнику', () => {
  const state = reactionBattle({
    heroOverrides: { characterClass: 'fighter', role: 'Воин · ур. 3', abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 } },
  })
  const moved = applyAll(state, resolveCommand({
    command_type: 'MoveActor', actor_id: 'goblin', to: { x: 5, y: 1 }, server_authoritative: true,
  }, state, authoritative()).events)

  assert.deepEqual(moved.mechanics.combat.reaction_window.action_ids, ['opportunity-attack'])
  const plan = planHeroReaction(moved)
  assert.equal(plan.rule, 'opportunity-attack')

  const struck = resolveCommand(plan.commands[0], moved, authoritative([18, 5]))
  const attack = struck.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(attack.payload.hit, true)
  const after = applyAll(moved, struck.events)
  assert.ok(after.enemies[0].hp < moved.enemies[0].hp, 'удар вдогонку обязан снять хиты')
  assert.equal(after.mechanics.combat.action_economy.mage.reaction, false)
})

test('«Невероятное уклонение» тратится на крупный удар и не тратится на царапину', () => {
  const rogue = {
    characterClass: 'rogue', role: 'Плут · ур. 5', level: 5, proficiency: 3,
    hp: 40, maxHp: 40, abilities: { str: 10, dex: 16, con: 14, int: 12, wis: 10, cha: 10 },
  }
  const claw = (damage) => ({
    action_profiles: [{ id: 'claw', name: 'Коготь', kind: 'melee', attack_modifier: 4, damage_expression: damage, damage_type: 'slashing', range_feet: 5 }],
  })
  const scratch = reactionBattle({ heroOverrides: rogue, enemyOverrides: claw('1d6') })
  const scratched = applyAll(scratch, resolveCommand(enemyAttack, scratch, authoritative([18, 1])).events)
  assert.ok(scratched.mechanics.combat.reaction_window.action_ids.includes('uncanny-dodge'))
  assert.equal(planHeroReaction(scratched).rule, 'decline-reaction')

  const heavy = reactionBattle({ heroOverrides: rogue, enemyOverrides: claw('4d6+8') })
  const wounded = applyAll(heavy, resolveCommand(enemyAttack, heavy, authoritative([18, 6, 6, 6, 6])).events)
  const taken = 40 - wounded.players[0].hp
  assert.ok(taken * 100 >= 40 * UNCANNY_DODGE_DAMAGE_PERCENT, `удар обязан быть крупным, а снял ${taken}`)
  const plan = planHeroReaction(wounded)
  assert.equal(plan.rule, 'uncanny-dodge')

  const dodged = applyAll(wounded, resolveCommand(plan.commands[0], wounded, authoritative()).events)
  assert.equal(dodged.players[0].hp, 40 - Math.floor(taken / 2))
  assert.equal(dodged.mechanics.combat.action_economy.mage.reaction, false)
})

test('политика детерминирована и не трогает окно, которого нет', () => {
  const state = reactionBattle()
  const attacked = applyAll(state, resolveCommand(enemyAttack, state, authoritative([14, 4])).events)
  assert.deepEqual(planHeroReaction(attacked), planHeroReaction(attacked))
  assert.equal(planHeroReaction(state).rule, 'decline-reaction')
  assert.equal(planHeroReaction(state, null).commands[0].action_id, 'decline-reaction')
})
