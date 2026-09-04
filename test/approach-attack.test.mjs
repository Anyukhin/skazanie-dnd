import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { GameOrchestrator } from '../server/game-orchestrator.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState, previewApproachAttack } from '../server/rules-engine.mjs'

function battle() {
  return normalizeCampaignState({
    sessionCode: 'MANEUVER', activePlayerId: 'hero', partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Ада', hp: 30, maxHp: 30, armor: 15, speed: 30, x: 0, y: 1, abilities: { str: 16, dex: 14 }, inventory: [] }],
    enemies: [{ id: 'ogre', name: 'Огр', hp: 40, maxHp: 40, armor: 12, alive: true, x: 4, y: 1 }],
    scene: { title: 'Двор', location: 'Двор', cells: Array.from({ length: 18 }, (_, i) => ({ x: i % 6, y: Math.floor(i / 6), type: 'floor', revealed: true })) },
    mechanics: { positions: { hero: { x: 0, y: 1 }, ogre: { x: 4, y: 1 } }, combat: {
      active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero' }, { actor_id: 'ogre' }],
      action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } },
    } },
  })
}

async function fixture(t, initial = battle()) {
  const directory = mkdtempSync(join(tmpdir(), 'skazanie-maneuver-'))
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }))
  const diceService = new DiceService({ rng: new SequenceDiceRng(Array(50).fill(18)) })
  const rulesEngine = new RulesEngine({ diceService })
  const eventStore = new FileEventStore({ rootDir: directory, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaignId: 'MANEUVER', initialState: initial })
  const orchestrator = new GameOrchestrator({ eventStore, rulesEngine, narrator: { render: async () => { throw new Error('Обычный боевой манёвр не вызывает LLM') } } })
  const input = { campaignId: 'MANEUVER', playerId: 'hero', allowedActorIds: ['hero'], state: initial, message: 'Подбегаю к огру и бью его', idempotencyKey: 'offer' }
  return { eventStore, orchestrator, input }
}

test('сервер предлагает маршрут и исполняет движение с атакой одним подтверждённым commit', async (t) => {
  const { eventStore, orchestrator, input } = await fixture(t)
  const offered = await orchestrator.handle(input)
  assert.ok(offered.action_proposal, JSON.stringify(offered))
  assert.equal(offered.action_proposal.movement_feet, 15)
  assert.deepEqual(offered.action_proposal.to, { x: 3, y: 1 })
  assert.deepEqual(offered.mechanics, [])
  assert.equal((await eventStore.load('MANEUVER')).state_version, 0)
  const accepted = { ...input, idempotencyKey: 'accept', confirmedProposalId: offered.action_proposal.id }
  const result = await orchestrator.handle(accepted)
  assert.ok(result.mechanics.some(e => e.event_type === 'ActorMoved'))
  assert.ok(result.mechanics.some(e => e.event_type === 'AttackResolved'))
  assert.deepEqual(result.authoritative_state.mechanics.positions.hero, offered.action_proposal.to)
  assert.equal(result.authoritative_state.mechanics.combat.action_economy.hero.movement_spent, 15)
  assert.equal(result.authoritative_state.mechanics.combat.action_economy.hero.action, false)
  const duplicate = await orchestrator.handle(accepted)
  assert.equal(duplicate.idempotent_replay, true)
  assert.deepEqual(duplicate.mechanics, result.mechanics)
  assert.deepEqual((await eventStore.replay('MANEUVER', { useSnapshots: false })).state, result.authoritative_state)
})

test('нехватка скорости и действия отвергаются до бросков', () => {
  const slow = battle()
  slow.mechanics.combat.action_economy.hero.movement_spent = 25
  assert.throws(() => previewApproachAttack(slow, 'hero', 'ogre'), { code: 'APPROACH_UNREACHABLE' })
  const spent = battle()
  spent.mechanics.combat.action_economy.hero.action = false
  assert.throws(() => previewApproachAttack(spent, 'hero', 'ogre'), { code: 'ACTION_SPENT' })
  const frightened = battle()
  frightened.mechanics.conditions.hero = [{ id: 'frightened', source_actor: 'ogre' }]
  assert.throws(() => previewApproachAttack(frightened, 'hero', 'ogre'), { code: 'APPROACH_UNREACHABLE' })
})

test('стена и неоднозначная цель не превращаются в автоматический выбор', async (t) => {
  const blocked = battle()
  for (const cell of blocked.scene.cells) if (cell.x === 2) cell.type = 'wall'
  assert.throws(() => previewApproachAttack(blocked, 'hero', 'ogre'), { code: 'APPROACH_UNREACHABLE' })
  const crowded = battle()
  crowded.enemies.push({ ...crowded.enemies[0], id: 'ogre-2', x: 5, y: 2 })
  const { orchestrator, input } = await fixture(t, crowded)
  const response = await orchestrator.handle(input)
  assert.equal(response.action_proposal, undefined)
  assert.deepEqual(response.mechanics, [])
})

test('владение героем проверяется до выдачи маршрута', async (t) => {
  const { orchestrator, input } = await fixture(t)
  await assert.rejects(orchestrator.handle({ ...input, allowedActorIds: ['someone-else'] }))
})

test('реакция по пути не откатывается, если герой больше не может атаковать', async (t) => {
  const initial = battle()
  initial.players[0].hp = 1
  initial.enemies.push({ id: 'guard', name: 'Страж', hp: 30, maxHp: 30, alive: true, x: 0, y: 0,
    action_profiles: [{ id: 'smash', kind: 'melee', modifier: 99, damage_amount: 100, range_feet: 5 }],
  })
  initial.mechanics.positions.guard = { x: 0, y: 0 }
  initial.mechanics.combat.action_economy.guard = { reaction: true }
  const { orchestrator, input, eventStore } = await fixture(t, initial)
  const offer = await orchestrator.handle(input)
  assert.ok(offer.action_proposal)
  const result = await orchestrator.handle({ ...input, idempotencyKey: 'interrupted', confirmedProposalId: offer.action_proposal.id })
  assert.ok(result.mechanics.some(event => event.event_type === 'AttackResolved' && event.actor_id === 'guard'))
  assert.equal(result.mechanics.some(event => event.event_type === 'AttackResolved' && event.actor_id === 'hero'), false)
  assert.equal(result.authoritative_state.players[0].hp, 0)
  assert.equal(result.authoritative_state.enemies.find(enemy => enemy.id === 'ogre').hp, 40)
  assert.deepEqual((await eventStore.replay('MANEUVER', { useSnapshots: false })).state, result.authoritative_state)
})

test('поддельное и устаревшее подтверждения не исполняют манёвр', async (t) => {
  const { eventStore, orchestrator, input } = await fixture(t)
  const offer = await orchestrator.handle(input)
  await assert.rejects(orchestrator.handle({ ...input, idempotencyKey: 'forged', confirmedProposalId: 'forged' }), { code: 'STATE_VERSION_CONFLICT' })
  await eventStore.commit({ campaignId: 'MANEUVER', expectedStateVersion: 0, idempotencyKey: 'changed', events: [
    { event_type: 'ActionDeclared', actor_id: 'hero', payload: { action: 'Обстановка изменилась' } },
  ] })
  await assert.rejects(orchestrator.handle({ ...input, idempotencyKey: 'stale', confirmedProposalId: offer.action_proposal.id }), { code: 'STATE_VERSION_CONFLICT' })
  assert.equal((await eventStore.load('MANEUVER')).state_version, 1)
})
