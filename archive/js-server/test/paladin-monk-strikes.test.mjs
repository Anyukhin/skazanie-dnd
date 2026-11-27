// Божественная кара, Ошеломляющий удар и Наложение рук героя 7-го уровня
// (PHB 2014). Аудит боя 2026-10-13: кара тратила ячейку до броска, всегда
// 1-го круга и делала излучением весь урон удара; Ошеломляющий удар брал СЛ
// по Силе или Ловкости и тратил ци на промахе; Наложение рук лечило ровно 5.
import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { fixedDice } from './kit/dice.mjs'

const SWORD = { id: 'sword', catalog_id: 'srd_5_2_1:longsword', type: 'weapon', quantity: 1, equipped: true }
const BOW = { id: 'bow', catalog_id: 'srd_5_2_1:longbow', type: 'weapon', quantity: 1, equipped: true }
const ARROWS = { id: 'arrows', catalog_id: 'srd_5_2_1:arrows-20', type: 'gear', quantity: 1 }

function battle({ hero = {}, enemy = {}, resources = {}, ally = null } = {}) {
  const cells = []
  for (let x = 0; x < 12; x += 1) cells.push({ x, y: 0, type: 'floor', revealed: true })
  const players = [{
    id: 'hero', character: 'Айрис', characterClass: 'paladin', level: 7, hp: 60, maxHp: 60, armor: 18, speed: 30, proficiency: 3,
    abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 16, cha: 16 }, inventory: [SWORD], x: 0, y: 0, ...hero,
  }]
  if (ally) players.push({ id: 'ally', character: 'Тор', characterClass: 'fighter', level: 7, hp: 20, maxHp: 50, armor: 16, speed: 30, proficiency: 3, abilities: { str: 14, dex: 10, con: 14 }, x: 0, y: 1, ...ally })
  if (ally) cells.push({ x: 0, y: 1, type: 'floor', revealed: true })
  return normalizeCampaignState({
    sessionCode: 'STRIKES', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    partyMemberIds: players.map((player) => player.id), players,
    enemies: [{ id: 'foe', name: 'Враг', creature_type: 'giant', hp: 300, maxHp: 300, armor: 12, speed: 30, abilities: { str: 16, dex: 10, con: 10 }, x: 1, y: 0, alive: true, ...enemy }],
    scene: { title: 'Зал', location: 'Зал', turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero', total: 15 }, { actor_id: 'foe', total: 5 }],
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
      },
      resources: { hero: resources },
    },
  })
}

const PALADIN_SLOTS = { spell_slots_1: { current: 4, max: 4 }, spell_slots_2: { current: 3, max: 3 }, lay_on_hands: { current: 35, max: 35 } }
const act = (state, input, diceService = fixedDice(15)) => resolveCommand({ command_id: `act-${input.action_id}`, command_type: 'UseCombatAction', actor_id: 'hero', target_id: 'foe', ...input },
  state, { diceService, context: { serverAuthoritativeCombat: true } })
const spent = (result, resource) => result.events.filter((event) => event.event_type === 'ResourceSpent' && event.payload.resource === resource)
const damages = (result) => result.events.filter((event) => event.event_type === 'DamageApplied')

test('Божественная кара: ячейка 2-го круга на попадании — 3к8 излучением отдельно от рубящего урона меча', () => {
  const state = battle({ resources: PALADIN_SLOTS })
  const result = act(state, { action_id: 'divine-smite', item_id: 'sword', slot_level: 2 })
  assert.equal(spent(result, 'spell_slots_2').length, 1)
  assert.equal(spent(result, 'spell_slots_1').length, 0)
  const smiteDice = result.events.find((event) => event.event_type === 'DieRolled' && event.payload.divine_smite === true)
  assert.equal(smiteDice.payload.dice.length, 3, '2к8 + 1к8 за круг выше первого')
  const [weapon, radiant] = damages(result)
  assert.equal(weapon.payload.damage_type, 'slashing', 'меч рубит как меч')
  assert.equal(radiant.payload.damage_type, 'radiant')
  assert.equal(radiant.payload.spell_id, 'divine-smite')
  assert.equal(radiant.payload.applied_amount, 24)
  const replayed = replayEvents(state, result.events)
  assert.equal(replayed.mechanics.resources.hero.spell_slots_2.current, 2)
  assert.equal(replayed.enemies[0].hp, 300 - weapon.payload.applied_amount - 24)
})

test('кара по нежити — ещё 1к8; без названного круга берётся младшая ячейка', () => {
  const result = act(battle({ resources: PALADIN_SLOTS, enemy: { creature_type: 'undead' } }), { action_id: 'divine-smite', item_id: 'sword' })
  assert.equal(spent(result, 'spell_slots_1').length, 1)
  assert.equal(result.events.find((event) => event.payload?.divine_smite === true).payload.dice.length, 3)
})

test('промах кары ячейку не тратит; кара луком — отказ; ячейки названного круга нет — отказ', () => {
  const miss = act(battle({ resources: PALADIN_SLOTS }), { action_id: 'divine-smite', item_id: 'sword' }, fixedDice(2))
  assert.equal(miss.events.find((event) => event.event_type === 'AttackResolved').payload.hit, false)
  assert.equal(spent(miss, 'spell_slots_1').length, 0)
  assert.ok(!miss.events.some((event) => event.payload?.divine_smite === true))
  assert.throws(() => act(battle({ resources: PALADIN_SLOTS, hero: { inventory: [BOW, ARROWS] }, enemy: { x: 5 } }), { action_id: 'divine-smite', item_id: 'bow' }), { code: 'DIVINE_SMITE_MELEE_ONLY' })
  assert.throws(() => act(battle({ resources: PALADIN_SLOTS }), { action_id: 'divine-smite', item_id: 'sword', slot_level: 3 }), { code: 'SPELL_SLOT_UNAVAILABLE' })
})

test('после кары у паладина 7-го уровня остаётся вторая атака действия Атака', () => {
  const state = battle({ resources: PALADIN_SLOTS })
  const smite = act(state, { action_id: 'divine-smite', item_id: 'sword' })
  const after = replayEvents(state, smite.events)
  const second = resolveCommand({ command_id: 'second', command_type: 'MakeAttack', actor_id: 'hero', target_id: 'foe', item_id: 'sword', server_authoritative: true },
    after, { diceService: fixedDice(15), context: { serverAuthoritativeCombat: true } })
  assert.ok(second.events.some((event) => event.event_type === 'AttackResolved'), 'Дополнительная атака не сгорела')
})

test('Ошеломляющий удар: СЛ ци по Мудрости, ци — только на попадании', () => {
  const monk = { characterClass: 'monk', subclass: 'Путь открытой ладони', abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 16, cha: 10 }, inventory: [{ id: 'staff', catalog_id: 'srd_5_2_1:quarterstaff', type: 'weapon', quantity: 1, equipped: true }] }
  const resources = { ki: { current: 7, max: 7 } }
  const hit = act(battle({ hero: monk, resources }), { action_id: 'stunning-strike', item_id: 'staff' })
  assert.equal(spent(hit, 'ki').length, 1)
  const save = hit.events.find((event) => event.event_type === 'SavingThrowResolved')
  assert.equal(save.payload.difficulty, 8 + 3 + 3, '8 + мастерство + Мудрость')
  const miss = act(battle({ hero: monk, resources }), { action_id: 'stunning-strike', item_id: 'staff' }, fixedDice(2))
  assert.equal(spent(miss, 'ki').length, 0, 'промах ци не тратит')
})

test('Наложение рук лечит столько, сколько не хватает, или названную сумму — из запаса', () => {
  const state = battle({ resources: PALADIN_SLOTS, ally: {} })
  const full = act(state, { action_id: 'lay-on-hands', target_id: 'ally' })
  assert.equal(full.events.find((event) => event.event_type === 'HealingApplied').payload.applied_amount, 30)
  assert.equal(spent(full, 'lay_on_hands')[0].payload.amount, 30)
  const some = act(state, { action_id: 'lay-on-hands', target_id: 'ally', amount: 7 })
  assert.equal(some.events.find((event) => event.event_type === 'HealingApplied').payload.applied_amount, 7)
  assert.equal(replayEvents(state, some.events).mechanics.resources.hero.lay_on_hands.current, 28)
})
