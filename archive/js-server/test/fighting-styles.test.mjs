// Боевые стили и Улучшенный критический удар героя 7-го уровня
// (PHB 2014, гл. 3). Аудит боя 2026-10-13: стиль выбирался при создании
// героя, но работала только «Защита» — «Стрельба», «Дуэлянт» и «Сражение
// большим оружием» молча ничего не давали, а Чемпион критовал только на 20.
import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { dice, fixedDice } from './kit/dice.mjs'

const weapon = (id, catalogId, extra = {}) => ({ id, catalog_id: catalogId, type: 'weapon', quantity: 1, equipped: true, ...extra })
const SHIELD = { id: 'shield', catalog_id: 'srd_5_2_1:shield', type: 'armor', quantity: 1, equipped: true }
const ARROWS = { id: 'arrows', catalog_id: 'srd_5_2_1:arrows-20', type: 'gear', quantity: 1 }

function battle({ styles = [], subclass = 'Чемпион', inventory, enemyAt = { x: 1, y: 0 }, enemyArmor = 12 } = {}) {
  const cells = []
  for (let x = 0; x < 12; x += 1) cells.push({ x, y: 0, type: 'floor', revealed: true })
  return normalizeCampaignState({
    sessionCode: 'FIGHTING-STYLES',
    partyMemberIds: ['hero'],
    ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    players: [{
      id: 'hero', character: 'Брен', characterClass: 'fighter', subclass, level: 7, hp: 60, maxHp: 60,
      armor: 18, speed: 30, proficiency: 3, abilities: { str: 16, dex: 16, con: 14, int: 10, wis: 10, cha: 10 },
      selectedFeatureIds: styles, inventory, x: 0, y: 0,
    }],
    enemies: [{
      id: 'ogre', name: 'Огр', creature_type: 'giant', hp: 200, maxHp: 200, armor: enemyArmor, speed: 30,
      abilities: { str: 19, dex: 8, con: 16 }, ...enemyAt, alive: true,
    }],
    scene: { title: 'Зал', location: 'Зал', turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 15 }, { actor_id: 'ogre', total: 5 }],
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
    },
  })
}

const attack = (state, item, diceService, extra = {}) => resolveCommand({
  command_id: `attack-${item}`, command_type: 'MakeAttack', actor_id: 'hero', target_id: 'ogre', item_id: item, server_authoritative: true, ...extra,
}, state, { diceService, context: { serverAuthoritativeCombat: true } })
const attackEvent = (result) => result.events.find((event) => event.event_type === 'AttackResolved')
const damageEvent = (result) => result.events.find((event) => event.event_type === 'DamageApplied')

test('«Стрельба»: +2 к броску атаки луком, но не брошенным кинжалом', () => {
  const inventory = [weapon('bow', 'srd_5_2_1:longbow'), ARROWS, weapon('dagger', 'srd_5_2_1:dagger', { equipped: false })]
  const at = { x: 6, y: 0 }
  const plain = attackEvent(attack(battle({ inventory, enemyAt: at }), 'bow', fixedDice(10)))
  const archer = attackEvent(attack(battle({ styles: ['fighting-style-archery'], inventory, enemyAt: at }), 'bow', fixedDice(10)))
  assert.equal(archer.payload.modifier, plain.payload.modifier + 2, 'Ловкость +3, мастерство +3 и стиль +2')
  const daggerOnly = [weapon('dagger', 'srd_5_2_1:dagger')]
  const thrownPlain = attackEvent(attack(battle({ inventory: daggerOnly, enemyAt: { x: 3, y: 0 } }), 'dagger', fixedDice(10), { attack_mode: 'thrown' }))
  const thrownArcher = attackEvent(attack(battle({ styles: ['fighting-style-archery'], inventory: daggerOnly, enemyAt: { x: 3, y: 0 } }), 'dagger', fixedDice(10), { attack_mode: 'thrown' }))
  assert.equal(thrownArcher.payload.modifier, thrownPlain.payload.modifier, 'кинжал — оружие ближнего боя, даже брошенный')
})

test('«Дуэлянт»: +2 к урону мечом в одной руке со щитом; двуручным хватом — без прибавки', () => {
  const inventory = [weapon('sword', 'srd_5_2_1:longsword'), SHIELD]
  const oneHand = attack(battle({ styles: ['fighting-style-dueling'], inventory }), 'sword', fixedDice(15))
  assert.equal(damageEvent(oneHand).payload.applied_amount, 8 + 3 + 2, 'd8 на максимуме-прижиме 8, Сила +3, стиль +2')
  const twoHands = attack(battle({ styles: ['fighting-style-dueling'], inventory: [weapon('sword', 'srd_5_2_1:longsword')] }), 'sword', fixedDice(15), { attack_mode: 'two-handed' })
  assert.equal(damageEvent(twoHands).payload.applied_amount, 10 + 3, 'двуручный хват — стиль не работает')
})

test('«Сражение метательным оружием»: +2 к урону брошенным топориком', () => {
  const inventory = [weapon('axe', 'srd_5_2_1:handaxe')]
  const thrown = attack(battle({ styles: ['fighting-style-thrown'], inventory, enemyAt: { x: 3, y: 0 } }), 'axe', fixedDice(15), { attack_mode: 'thrown' })
  assert.equal(damageEvent(thrown).payload.applied_amount, 6 + 3 + 2)
})

test('«Сражение большим оружием»: 1 и 2 на костях двуручника перебрасываются один раз', () => {
  const inventory = [weapon('greatsword', 'srd_5_2_1:greatsword')]
  // d20 = 15 (попадание), 2к6 = 1 и 4, переброс единицы — 2 (второй раз не перебрасывается).
  const result = attack(battle({ styles: ['fighting-style-great-weapon'], inventory }), 'greatsword', dice([15, 1, 4, 2]))
  assert.equal(damageEvent(result).payload.applied_amount, 2 + 4 + 3)
  const rerolls = result.events.filter((event) => event.event_type === 'DieRolled' && event.payload.great_weapon_fighting === true)
  assert.equal(rerolls.length, 2, 'итоговый бросок урона и сам переброс')
  assert.ok(rerolls.some((event) => event.payload.replaces === 1 && event.payload.dice[0] === 2))
  const replayed = replayEvents(battle({ styles: ['fighting-style-great-weapon'], inventory }), result.events)
  assert.equal(replayed.enemies.find((enemy) => enemy.id === 'ogre').hp, 200 - 9, 'replay снимает те же хиты')
  // Без стиля — те же кости, без переброса.
  const plain = attack(battle({ inventory }), 'greatsword', dice([15, 1, 4]))
  assert.equal(damageEvent(plain).payload.applied_amount, 1 + 4 + 3)
})

test('Чемпион 7-го уровня критует на 19 — и такой удар попадает; у Мастера боевых искусств 19 — обычный бросок', () => {
  const inventory = [weapon('sword', 'srd_5_2_1:longsword')]
  const champion = attackEvent(attack(battle({ inventory, enemyArmor: 30 }), 'sword', fixedDice(19)))
  assert.equal(champion.payload.hit, true)
  assert.equal(champion.payload.critical, true)
  assert.equal(champion.payload.improved_critical, true)
  const master = attackEvent(attack(battle({ subclass: 'Мастер боевых искусств', inventory, enemyArmor: 30 }), 'sword', fixedDice(19)))
  assert.equal(master.payload.hit, false, '19 + 6 против КД 30 — промах')
  assert.equal(master.payload.critical, false)
})
