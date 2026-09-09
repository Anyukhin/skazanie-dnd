import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { AuthoritativeExecutor } from '../server/authoritative-executor.mjs'
import { enemyFrom2014 } from '../server/combat-lab-monsters.mjs'
import { monsterActionAvailable, monsterActionSpentMarker } from '../server/monster-actions.mjs'
import { planNpcTurn } from '../server/npc-turn-scheduler.mjs'
import { combatNarration } from '../server/combat-narration.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState, previewMonsterAction, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

const records = JSON.parse(readFileSync(new URL('../data/compendia/dnd_5e_2014/monsters.json', import.meta.url), 'utf8')).monsters
const context = { isAdmin: true, isNpcScheduler: true, serverAuthoritativeCombat: true }
function dice(values = Array(100).fill(1)) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `monster-area-${++id}`, now: () => '2026-09-08T00:00:00.000Z' })
}
function arena({ ally = false, wall = false } = {}) {
  const dragon = enemyFrom2014(records.find(m => m.id.endsWith(':young-red-dragon')), { x: 0, y: 2 })
  const hero = { id: 'hero', name: 'Воин', hp: 500, maxHp: 500, armor: 18, speed: 30, abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, x: 4, y: 2 }
  const enemies = [dragon]
  if (ally) enemies.push({ ...enemyFrom2014(records.find(m => m.id.endsWith(':wolf')), { x: 4, y: 3 }), hp: 100, maxHp: 100 })
  const state = normalizeCampaignState({
    sessionCode: 'MONSTER-AREA', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    players: [hero], partyMemberIds: ['hero'], enemies,
    scene: { turn: 1, cells: Array.from({ length: 75 }, (_, i) => ({ x: i % 15, y: Math.floor(i / 15), type: wall && i % 15 === 2 ? 'wall' : 'floor', revealed: true })) },
    mechanics: { combat: { active: true, round: 1, active_index: 0, initiative: [{ actor_id: dragon.id, total: 20 }, { actor_id: 'hero', total: 10 }],
      action_economy: Object.fromEntries([...enemies, hero].map(actor => [actor.id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }])) } },
  })
  return { state, dragon: state.enemies[0] }
}
const breath = dragon => ({ command_type: 'UseMonsterAction', command_id: 'dragon-breath', actor_id: dragon.id, action_id: 'fire-breath', to: { x: 4, y: 2 }, server_authoritative: true })

function duel(slug, heroPatch = {}) {
  const initial = arena().state
  const monster = enemyFrom2014(records.find(record => record.id.endsWith(`:${slug}`)), { x: 3, y: 2 })
  initial.enemies = [monster]
  Object.assign(initial.players[0], { armor: 10 }, heroPatch)
  initial.mechanics.positions = { hero: { x: 4, y: 2 }, [monster.id]: { x: 3, y: 2 } }
  initial.mechanics.combat.initiative[0].actor_id = monster.id
  initial.mechanics.combat.action_economy[monster.id] = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  return { state: normalizeCampaignState(initial), monster }
}

test('паралич упыря учитывает эльфа, срок и повторный спасбросок', () => {
  for (const elf of [false, true]) {
    const { state, monster } = duel('ghoul', elf ? { speciesBenefits: { race_id: 'elf' } } : {})
    const result = resolveCommand({ command_type: 'MakeAttack', command_id: `claws-${elf}`, actor_id: monster.id, target_id: 'hero', action_id: 'claws', server_authoritative: true }, state, { diceService: dice([15, 1, 1, 1]), context })
    const paralysis = result.events.find(event => event.event_type === 'ConditionAdded' && event.payload.condition === 'paralyzed')
    if (elf) assert.equal(paralysis, undefined)
    else {
      assert.equal(paralysis.payload.duration, 'rounds:10')
      assert.equal(paralysis.payload.repeat_save_timing, 'turn-end')
      assert.equal(paralysis.payload.save_dc, 10)
    }
  }
})

test('яд гигантского паука стабилизирует героя при 0 ОЗ', () => {
  const { state, monster } = duel('giant-spider', { hp: 5, maxHp: 5 })
  const result = resolveCommand({ command_type: 'MakeAttack', command_id: 'spider-poison', actor_id: monster.id, target_id: 'hero', action_id: 'bite', server_authoritative: true }, state, { diceService: dice([15, 1, 1, 8, 8]), context })
  const after = result.events.reduce(applyGameEvent, state)
  assert.equal(after.players[0].hp, 0)
  assert.equal(after.mechanics.death.saving_throws.hero.stable, true)
  assert.equal(result.events.some(event => event.event_type === 'HeroDied'), false)
  assert.ok(after.mechanics.conditions.hero.some(condition => condition.id === 'paralyzed' && condition.expires_at_minutes === 60))
  assert.deepEqual(replayEvents(state, result.events), after)
})

test('крит удваивает независимый урон укуса, заговор мага растёт по уровню заклинателя', () => {
  const { state, monster } = duel('young-red-dragon')
  const bite = resolveCommand({ command_type: 'MakeAttack', command_id: 'critical-bite', actor_id: monster.id, target_id: 'hero', action_id: 'bite', server_authoritative: true }, state, { diceService: dice([20, 1, 1, 1, 1, 1, 1]), context })
  assert.ok(bite.rolls.some(roll => roll.purpose === 'monster_action_damage' && roll.expression === '2d6'))
  const mage = duel('mage')
  const cantrip = resolveCommand({ command_type: 'CastSpell', command_id: 'mage-cantrip', actor_id: mage.monster.id, target_id: 'hero', spell_id: 'fire-bolt', server_authoritative: true }, mage.state, { diceService: dice([15, 1, 1]), context })
  assert.ok(cantrip.rolls.some(roll => roll.expression === '2d10'))
})

test('дыхание берёт форму, СЛ и урон из статблока и сохраняет события', () => {
  const { state, dragon } = arena()
  const command = { ...breath(dragon), expression: '99d100', amount: 9999, target_ids: ['hero'] }
  const result = resolveCommand(command, state, { diceService: dice(), context })
  const damage = result.events.find(event => event.event_type === 'DamageApplied')
  assert.equal(damage.payload.raw_amount, 16)
  assert.equal(damage.payload.damage_type, 'fire')
  const after = result.events.reduce(applyGameEvent, state)
  assert.equal(after.players[0].hp, 484)
  assert.equal(after.mechanics.combat.action_economy[dragon.id].action, false)
  assert.deepEqual(replayEvents(state, result.events), after)
  assert.throws(() => resolveCommand({ ...command, command_id: 'again' }, after, { diceService: dice(), context }), error => error.code === 'MONSTER_ACTION_SPENT')
  assert.match(combatNarration(result.events, after), /Огненное дыхание/u)
})

test('права, очередь и стены проверяются до расхода приёма', () => {
  const { state, dragon } = arena()
  assert.throws(() => resolveCommand(breath(dragon), state, { diceService: dice(), context: { isAdmin: true } }), error => error.code === 'NPC_ACTION_FORBIDDEN')
  const wrongTurn = structuredClone(state)
  wrongTurn.mechanics.combat.active_index = 1
  assert.throws(() => resolveCommand(breath(dragon), wrongTurn, { diceService: dice(), context }), error => error.code === 'OUT_OF_TURN')
  const blocked = arena({ wall: true })
  assert.throws(() => previewMonsterAction(blocked.state, blocked.dragon.id, 'fire-breath', { x: 4, y: 2 }), error => error.code === 'MONSTER_ACTION_NO_TARGETS')
})

test('область задевает союзника, а планировщик выбирает безопасное направление', () => {
  const { state, dragon } = arena({ ally: true })
  const preview = previewMonsterAction(state, dragon.id, 'fire-breath', { x: 4, y: 2 })
  assert.equal(preview.affectedIds.length, 2)
  const result = resolveCommand(breath(dragon), state, { diceService: dice(), context })
  assert.equal(result.events.filter(event => event.event_type === 'DamageApplied').length, 2)
  assert.equal(planNpcTurn(state, dragon.id).some(command => command.command_type === 'UseMonsterAction'), false)
  const clear = arena()
  assert.equal(planNpcTurn(clear.state, clear.dragon.id)[0].command_type, 'UseMonsterAction')
})

test('несколько применений считаются по одному, общая перезарядка связывает варианты', () => {
  const spike = { id: 'tail-spike', uses: 3 }
  const conditions = new Set()
  for (let i = 0; i < 3; i++) {
    assert.equal(monsterActionAvailable(spike, conditions), true)
    conditions.add(monsterActionSpentMarker(spike, conditions))
  }
  assert.equal(monsterActionAvailable(spike, conditions), false)
  const fire = { id: 'fire-breath', recharge: { success: [5, 6], group: 'breaths' } }
  const sleep = { id: 'sleep-breath', recharge: { success: [5, 6], group: 'breaths' } }
  const spent = new Set([monsterActionSpentMarker(fire, new Set())])
  assert.equal(monsterActionAvailable(sleep, spent), false)
})

test('особый приём коммитится один раз и переживает повторное открытие хранилища', async t => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-bestiary-action-'))
  assert.ok(root.startsWith(join(tmpdir(), 'skazanie-bestiary-action-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { state, dragon } = arena()
  const store = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await store.initializeCampaign({ campaign_id: 'MONSTER-AREA', initial_state: state })
  const executor = new AuthoritativeExecutor({ eventStore: store, rulesEngine: new RulesEngine({ diceService: dice() }) })
  const request = { campaignId: 'MONSTER-AREA', idempotencyKey: 'breath-once', commands: [breath(dragon)], actorIds: [dragon.id], context }
  const first = await executor.executeCommands(request)
  const second = await executor.executeCommands(request)
  assert.equal(second.replayed, true)
  assert.equal(first.commit_id, second.commit_id)
  const reopened = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  const loaded = await reopened.load('MONSTER-AREA')
  assert.equal(loaded.state.players[0].hp, 484)
  assert.equal(loaded.state.mechanics.combat.action_economy[dragon.id].action, false)
})
