// Умения классов до 7-го уровня, которые работают сами, без кнопки:
// Увёртливость плута и монаха, Чувство опасности и Дикий инстинкт варвара,
// Быстрое передвижение и Движение без доспехов. Аудит боя 2026-10-13: ни
// одно из них не действовало, а дыхание Саргата (16к6, Ловкость) — главный
// удар финала Асстохана.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { enemyFrom2014 } from '../server/combat-lab-monsters.mjs'
import { applyGameEvent, movementForActor, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { dice, diceThen } from './kit/dice.mjs'

const records = JSON.parse(readFileSync(new URL('../data/compendia/dnd_5e_2014/monsters.json', import.meta.url), 'utf8')).monsters
const context = { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true }

function arena(hero, { conditions = [] } = {}) {
  const dragon = enemyFrom2014(records.find((monster) => monster.id.endsWith(':young-red-dragon')), { x: 0, y: 2 })
  const player = { id: 'hero', name: 'Герой', hp: 500, maxHp: 500, armor: 15, speed: 30, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, x: 4, y: 2, ...hero }
  return normalizeCampaignState({
    sessionCode: 'CLASS-FEATURES', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    players: [player], partyMemberIds: ['hero'], enemies: [dragon],
    scene: { turn: 1, cells: Array.from({ length: 75 }, (_, i) => ({ x: i % 15, y: Math.floor(i / 15), type: 'floor', revealed: true })) },
    mechanics: {
      combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: dragon.id, total: 20 }, { actor_id: 'hero', total: 10 }],
        action_economy: Object.fromEntries([dragon, player].map((actor) => [actor.id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])) },
      conditions: conditions.length ? { hero: conditions.map((id) => ({ id, duration: 'rounds:1' })) } : {},
    },
  })
}

/** Огненное дыхание молодого красного дракона по герою: 16к6 на единицах — 16, спасбросок — заданной костью. */
function breathOn(state, saveDie, { advantage = false } = {}) {
  const dragon = state.enemies[0]
  const values = [...Array(16).fill(1), saveDie, ...(advantage ? [saveDie] : [])]
  const result = resolveCommand({ command_type: 'UseMonsterAction', command_id: 'breath', actor_id: dragon.id, action_id: 'fire-breath', to: { x: 4, y: 2 }, server_authoritative: true },
    state, { diceService: dice(values), context })
  return {
    result,
    damage: result.events.find((event) => event.event_type === 'DamageApplied')?.payload?.applied_amount ?? 0,
    save: result.events.find((event) => event.event_type === 'SavingThrowResolved')?.payload,
  }
}

test('Увёртливость плута 7-го уровня: провал — половина, успех — ничего; до 7-го и без сознания — как у всех', () => {
  const rogue = { characterClass: 'rogue', level: 7 }
  assert.equal(breathOn(arena(rogue), 1).damage, 8, 'провал — половина от 16')
  const saved = breathOn(arena(rogue), 20)
  assert.equal(saved.save.saved, true)
  assert.equal(saved.damage, 0, 'успех — без урона')
  assert.equal(breathOn(arena({ characterClass: 'rogue', level: 6 }), 1).damage, 16, 'Увёртливость — с 7-го уровня')
  assert.equal(breathOn(arena({ characterClass: 'monk', level: 7 }), 1).damage, 8, 'у монаха 7-го уровня тоже')
  assert.equal(breathOn(arena(rogue, { conditions: ['stunned'] }), 1).damage, 16, 'ошеломлённый увернуться не может')
  const { result } = breathOn(arena(rogue), 1)
  const after = result.events.reduce(applyGameEvent, arena(rogue))
  assert.deepEqual(replayEvents(arena(rogue), result.events).players[0].hp, after.players[0].hp)
})

test('Чувство опасности варвара: преимущество на спасбросок Ловкости от дыхания; ослеплённый его не получает', () => {
  const barbarian = breathOn(arena({ characterClass: 'barbarian', level: 2 }), 12, { advantage: true }).save
  assert.equal(barbarian.danger_sense, true)
  assert.equal(barbarian.mode, 'advantage')
  const blinded = breathOn(arena({ characterClass: 'barbarian', level: 2 }, { conditions: ['blinded'] }), 12).save
  assert.equal(blinded.danger_sense, undefined)
  assert.notEqual(blinded.mode, 'advantage')
})

test('Дикий инстинкт варвара 7-го уровня — инициатива с преимуществом', () => {
  const state = arena({ characterClass: 'barbarian', level: 7 })
  state.mechanics.combat = { active: false }
  const result = resolveCommand({ command_type: 'StartCombat', command_id: 'start', server_authoritative: true }, state, { diceService: diceThen([], 10), context: { isAdmin: true, isDirector: true } })
  const started = result.events.find((event) => event.event_type === 'CombatStarted')
  const hero = (started?.payload?.initiative ?? []).find((entry) => entry.actor_id === 'hero')
  assert.ok(hero, JSON.stringify(result.events.map((event) => event.event_type)))
  assert.equal(hero.mode, 'advantage')
  assert.ok(hero.advantage_sources.some((source) => source.feature_id === 'feral-instinct'))
})

test('Быстрое передвижение варвара и Движение без доспехов монаха прибавляют скорость, доспех их снимает', () => {
  const plate = { id: 'plate', catalog_id: 'srd_5_2_1:plate-armor', type: 'armor', quantity: 1, equipped: true }
  const leather = { id: 'leather', catalog_id: 'srd_5_2_1:leather-armor', type: 'armor', quantity: 1, equipped: true }
  const speed = (hero) => movementForActor(arena({ abilities: { str: 16, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, ...hero }), 'hero').current_speed
  assert.equal(speed({ characterClass: 'barbarian', level: 7 }), 40)
  assert.equal(speed({ characterClass: 'barbarian', level: 7, inventory: [plate] }), 30, 'в тяжёлом доспехе — без прибавки')
  assert.equal(speed({ characterClass: 'barbarian', level: 4 }), 30, 'Быстрое передвижение — с 5-го уровня')
  assert.equal(speed({ characterClass: 'monk', level: 7 }), 45, 'монах 6–9 уровня: +15')
  assert.equal(speed({ characterClass: 'monk', level: 7, inventory: [leather] }), 30, 'в доспехе — без прибавки')
})
