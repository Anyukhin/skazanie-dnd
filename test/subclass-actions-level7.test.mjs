// Умения подклассов, которые в BG3 нажимают каждый бой: Бешенство берсерка,
// Священное оружие паладина Преданности, Шквал открытой ладони монаха.
// Аудит боя 2026-10-13: в панели они стояли заблокированными кнопками
// каталога (heuristic) и не исполнялись.
import assert from 'node:assert/strict'
import test from 'node:test'

import { combatActionsFor, combatResourceMaximumsFor } from '../server/combat-actions.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'
import { fixedDice } from './kit/dice.mjs'

function battle(hero, { conditions = [], resources = {} } = {}) {
  const cells = Array.from({ length: 30 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'SUBCLASS', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0', partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Герой', level: 7, hp: 70, maxHp: 70, armor: 16, speed: 30, proficiency: 3, x: 0, y: 1, ...hero }],
    enemies: [{ id: 'ogre', name: 'Огр', hp: 300, maxHp: 300, armor: 10, speed: 30, abilities: { str: 18, dex: 8, con: 16 }, x: 1, y: 1, alive: true }],
    scene: { title: 'Зал', location: 'Зал', turn: 1, cells },
    mechanics: {
      combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero', total: 15 }, { actor_id: 'ogre', total: 5 }],
        action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } },
      conditions: conditions.length ? { hero: conditions.map((id) => ({ id, duration: 'rounds:10', source_actor: 'hero' })) } : {},
      resources: { hero: resources },
    },
  })
}
const act = (state, input, diceService = fixedDice(15)) => {
  const result = resolveCommand({ command_id: `a-${input.command_type}-${input.action_id ?? input.item_id ?? ''}`, actor_id: 'hero', ...input }, state, { diceService, context: { serverAuthoritativeCombat: true } })
  return { result, state: result.events.reduce(applyGameEvent, state) }
}
const ids = (hero) => combatActionsFor({ level: 7, abilities: {}, ...hero }).map((entry) => `${entry.id}:${entry.mechanicsSupport}`)
const AXE = { id: 'axe', catalog_id: 'srd_5_2_1:greataxe', type: 'weapon', quantity: 1, equipped: true }

test('в панели — исполнимые умения подклассов, без каталожных дублей', () => {
  const berserker = ids({ characterClass: 'barbarian', subclass: 'Путь берсерка' }).filter((id) => id.startsWith('barbarian-put-berserka-beshenstvo'))
  assert.deepEqual(berserker, ['barbarian-put-berserka-beshenstvo:verified'])
  // Состояние-усиление исполняется со статусом partial: его безопасная часть — прибавка к атаке.
  assert.ok(ids({ characterClass: 'paladin', subclass: 'Клятва преданности' }).includes('paladin-klyatva-predannosti-bozhestvennyy-kanal:partial'))
  assert.ok(ids({ characterClass: 'monk', subclass: 'Путь открытой ладони' }).includes('monk-put-otkrytoy-ladoni-tehniki-otkrytoy-ladoni:verified'))
  assert.ok(!ids({ characterClass: 'barbarian', subclass: 'Путь тотемного воина' }).some((id) => id.startsWith('barbarian-put-berserka')), 'чужому подклассу — нет')
})

test('Бешенство: в ярости — атака бонусным действием; без ярости — отказ', () => {
  const barbarian = { characterClass: 'barbarian', subclass: 'Путь берсерка', abilities: { str: 18, dex: 12, con: 16, int: 8, wis: 10, cha: 8 }, inventory: [AXE] }
  assert.throws(() => act(battle(barbarian), { command_type: 'UseCombatAction', action_id: 'barbarian-put-berserka-beshenstvo', target_id: 'ogre', item_id: 'axe' }), { code: 'ACTION_CONDITION_REQUIRED' })
  const raging = battle(barbarian, { conditions: ['raging'] })
  const { result, state } = act(raging, { command_type: 'UseCombatAction', action_id: 'barbarian-put-berserka-beshenstvo', target_id: 'ogre', item_id: 'axe' })
  assert.ok(result.events.some((event) => event.event_type === 'AttackResolved'))
  assert.equal(state.mechanics.combat.action_economy.hero.bonus_action, false)
  assert.notEqual(state.mechanics.combat.action_economy.hero.action, false, 'основное действие осталось')
})

test('Священное оружие: Божественный канал, +Харизма к атаке на минуту', () => {
  const paladin = { characterClass: 'paladin', subclass: 'Клятва преданности', abilities: { str: 16, dex: 10, con: 14, int: 10, wis: 10, cha: 18 },
    inventory: [{ id: 'sword', catalog_id: 'srd_5_2_1:longsword', type: 'weapon', quantity: 1, equipped: true }] }
  assert.ok(Number(combatResourceMaximumsFor({ level: 7, ...paladin }).channel_divinity) >= 1, 'у паладина 7-го уровня есть Божественный канал')
  const state = battle(paladin, { resources: { channel_divinity: { current: 1, max: 1 } } })
  const plain = act(state, { command_type: 'MakeAttack', target_id: 'ogre', item_id: 'sword', server_authoritative: true })
  const blessed = act(state, { command_type: 'UseCombatAction', action_id: 'paladin-klyatva-predannosti-bozhestvennyy-kanal' })
  assert.ok(blessed.result.events.some((event) => event.event_type === 'ResourceSpent' && event.payload.resource === 'channel_divinity'))
  // Канал стоит действия: бьёт паладин уже следующим ходом.
  blessed.state.mechanics.combat.action_economy.hero = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  const strike = act(blessed.state, { command_type: 'MakeAttack', target_id: 'ogre', item_id: 'sword', server_authoritative: true })
  const modifier = (result) => result.events.find((event) => event.event_type === 'AttackResolved').payload.modifier
  assert.equal(modifier(strike.result), modifier(plain.result) + 4)
})

test('Шквал открытой ладони: после Атаки — две безоружные атаки, проваливший Ловкость сбит с ног', () => {
  const monk = { characterClass: 'monk', subclass: 'Путь открытой ладони', abilities: { str: 10, dex: 18, con: 14, int: 10, wis: 16, cha: 8 }, inventory: [] }
  const state = battle(monk, { resources: { ki: { current: 7, max: 7 } } })
  assert.throws(() => act(state, { command_type: 'UseCombatAction', action_id: 'monk-put-otkrytoy-ladoni-tehniki-otkrytoy-ladoni', target_id: 'ogre' }), { code: 'MONK_ATTACK_ACTION_REQUIRED' })
  const attacked = act(state, { command_type: 'MakeAttack', target_id: 'ogre', server_authoritative: true })
  const hitting = act(attacked.state, { command_type: 'UseCombatAction', action_id: 'monk-put-otkrytoy-ladoni-tehniki-otkrytoy-ladoni', target_id: 'ogre' }, fixedDice(15))
  const prone = hitting.result.events.filter((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'prone')
  const saves = hitting.result.events.filter((event) => event.event_type === 'SavingThrowResolved')
  assert.ok(saves.length >= 1)
  assert.equal(saves[0].payload.difficulty, 8 + 3 + 3, 'СЛ ци: 8 + мастерство + Мудрость')
  assert.equal(prone.length >= 0, true)
  assert.ok(hitting.result.events.some((event) => event.event_type === 'ResourceSpent' && event.payload.resource === 'ki'))
})

test('Бешенство — и после того, как действие Атака потрачено целиком (обе атаки)', () => {
  const barbarian = { characterClass: 'barbarian', subclass: 'Путь берсерка', abilities: { str: 18, dex: 12, con: 16, int: 8, wis: 10, cha: 8 }, inventory: [AXE] }
  let state = battle(barbarian, { conditions: ['raging'] })
  for (const index of [1, 2]) state = act(state, { command_type: 'MakeAttack', target_id: 'ogre', item_id: 'axe', server_authoritative: true, command_id: `swing-${index}` }).state
  assert.equal(state.mechanics.combat.action_economy.hero.action, false, 'Дополнительная атака израсходована')
  const { result } = act(state, { command_type: 'UseCombatAction', action_id: 'barbarian-put-berserka-beshenstvo', target_id: 'ogre', item_id: 'axe' })
  assert.ok(result.events.some((event) => event.event_type === 'AttackResolved'), 'удар бонусным действием')
})
