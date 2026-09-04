// Импровизация внутри раунда: она обязана стоить хода, не двигать время и
// применять только тот эффект, который каталог признал исполнимым.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AutonomousCampaignOrchestrator } from '../server/autonomous-orchestrator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { RollRegistry } from '../server/roll-registry.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

const CAMPAIGN_ID = 'IMPROV-1'

function battle({ economy = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 } } = {}) {
  return normalizeCampaignState({
    sessionCode: CAMPAIGN_ID,
    campaign: 'Improvisation test',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{
      id: 'hero', character: 'Аster', level: 3, hp: 30, maxHp: 30, armor: 15, speed: 30, proficiency: 2,
      abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 10 }, x: 0, y: 0, inventory: [],
    }],
    enemies: [{ id: 'ogre', name: 'Огр', hp: 25, maxHp: 25, armor: 12, alive: true, x: 1, y: 0 }],
    scene: {
      title: 'Каменный мост', location: 'Каменный мост', objective: 'Удержать мост', turn: 1,
      cells: Array.from({ length: 12 }, (_, index) => ({ x: index % 6, y: Math.floor(index / 6), type: 'floor', revealed: true })),
    },
    mechanics: {
      positions: { hero: { x: 0, y: 0 }, ogre: { x: 1, y: 0 } },
      world_time: { elapsed_minutes: 0 },
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'hero' }, { actor_id: 'ogre' }],
        action_economy: { hero: economy },
      },
    },
  })
}

async function fixture(t, initialState = battle()) {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-improv-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const eventStore = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState, snapshotEvery: 7 })
  await eventStore.initializeCampaign({ campaign_id: CAMPAIGN_ID, initial_state: initialState })
  // 18 на d20 проходит любую СЛ этой политики, остальные кости мелкие.
  const diceService = new DiceService({ rng: new SequenceDiceRng(Array.from({ length: 500 }, (_, index) => (index % 3 === 0 ? 18 : 3))) })
  const rulesEngine = new RulesEngine({ diceService })
  return { eventStore, autonomy: new AutonomousCampaignOrchestrator({ eventStore, rulesEngine, now: () => 1_784_466_000_000 }) }
}

const improvise = (autonomy, key, action) => autonomy.handleUnknownAction({
  campaignId: CAMPAIGN_ID, playerId: 'hero', action, idempotencyKey: key,
})

test('боевое предложение показывает действительную цену провала и ждёт подтверждения', async (t) => {
  const { autonomy, eventStore } = await fixture(t)
  autonomy.rollRegistry = new RollRegistry({ diceService: new DiceService({ rng: new SequenceDiceRng([20, 20]) }) })
  const result = await improvise(autonomy, 'offer-combat', 'Опрокидываю жаровню под ноги огру, чтобы он оступился.')
  assert.equal(result.kind, 'check_required')
  assert.equal(result.check.proposal.cost, 'действие')
  assert.match(result.check.proposal.on_failure, /действие будет потрачено/u)
  assert.doesNotMatch(result.check.proposal.on_failure, /минут|время|час/u)
  assert.deepEqual(result.events, [])
  assert.equal((await eventStore.load(CAMPAIGN_ID)).state_version, 0)

  const roll = autonomy.rollRegistry.issue({ checkId: result.check.check_id, campaignId: CAMPAIGN_ID, actorId: 'hero' })
  const verifiedRoll = autonomy.rollRegistry.consume(roll.roll_id, { campaignId: CAMPAIGN_ID, actorId: 'hero', idempotencyKey: 'accept-combat' })
  const request = { campaignId: CAMPAIGN_ID, playerId: 'hero', action: 'Опрокидываю жаровню под ноги огру, чтобы он оступился.', idempotencyKey: 'accept-combat', verifiedRoll }
  const resolved = await autonomy.handleUnknownAction(request)
  assert.equal(resolved.kind, 'check_success')
  const current = await eventStore.load(CAMPAIGN_ID)
  assert.equal(current.state.mechanics.combat.action_economy.hero.action, false)
  assert.deepEqual((await eventStore.replay(CAMPAIGN_ID, { useSnapshots: false })).state, current.state)
  const duplicate = await autonomy.handleUnknownAction(request)
  assert.equal(duplicate.kind, resolved.kind)
  assert.equal(duplicate.narration, resolved.narration)
  assert.deepEqual(duplicate.events, resolved.events)
  assert.equal((await eventStore.load(CAMPAIGN_ID)).state_version, current.state_version)
})

test('недостижимый эффект отклоняется до броска и расхода действия', async (t) => {
  const initial = battle()
  initial.mechanics.positions.ogre = { x: 5, y: 0 }
  const { autonomy, eventStore } = await fixture(t, initial)
  autonomy.actionAdjudicator = { read: async () => ({
    ability: 'str', skill: 'athletics', plausibility: 'strenuous', risk: 'serious',
    action_cost: 'action', effect: 'prone', effect_target: 'ogre', required_means: [],
  }) }
  const result = await improvise(autonomy, 'far-effect', 'Сбиваю огра с ног рывком верёвки')
  assert.equal(result.kind, 'clarification')
  assert.match(result.narration, /слишком далеко/u)
  assert.deepEqual(result.events, [])
  assert.equal((await eventStore.load(CAMPAIGN_ID)).state_version, 0)
})

test('импровизация в бою тратит действие и не двигает время', async (t) => {
  const { autonomy, eventStore } = await fixture(t)
  const result = await improvise(autonomy, 'improv-1', 'Опрокидываю жаровню под ноги огру, чтобы он оступился.')

  assert.ok(['check_success', 'check_failure'].includes(result.kind), `неожиданный исход: ${result.kind}`)
  const spent = result.events.find((event) => event.event_type === 'CombatActionUsed' && event.payload?.improvised === true)
  assert.ok(spent, 'импровизация обязана потратить слот хода')
  assert.equal(spent.payload.action_type, 'action')

  const loaded = await eventStore.load(CAMPAIGN_ID)
  assert.equal(loaded.state.mechanics.combat.action_economy.hero.action, false, 'действие должно быть израсходовано')
  assert.equal(loaded.state.mechanics.world_time.elapsed_minutes, 0, 'внутри раунда время не идёт')
  assert.equal(loaded.state.scene.objective, 'Удержать мост', 'цель отряда посреди боя не переписывается')
})

test('занятый слот — честный отказ до броска, а не потраченный впустую кубик', async (t) => {
  const { autonomy } = await fixture(t, battle({
    economy: { action: false, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
  }))
  const result = await improvise(autonomy, 'improv-2', 'Опрокидываю жаровню под ноги огру, чтобы он оступился.')

  assert.equal(result.kind, 'clarification')
  assert.match(result.narration, /действие уже потрачено/i)
  assert.equal(result.events.some((event) => event.event_type === 'AbilityCheckResolved'), false, 'кубик не должен быть брошен')
})

test('вне боя поведение прежнее: время идёт и цель обновляется', async (t) => {
  const outOfCombat = battle()
  outOfCombat.mechanics.combat.active = false
  const { autonomy, eventStore } = await fixture(t, normalizeCampaignState(outOfCombat))
  const result = await improvise(autonomy, 'improv-3', 'Подпираю створку ворот обломком бревна.')

  assert.ok(['check_success', 'check_failure', 'auto_success'].includes(result.kind))
  assert.equal(result.events.some((event) => event.event_type === 'CombatActionUsed'), false, 'вне боя слот тратить нечего')
  const loaded = await eventStore.load(CAMPAIGN_ID)
  assert.ok(loaded.state.mechanics.world_time.elapsed_minutes > 0, 'вне боя импровизация занимает время')
})

test('повтор с тем же ключом не тратит действие второй раз', async (t) => {
  const { autonomy, eventStore } = await fixture(t)
  const text = 'Опрокидываю жаровню под ноги огру, чтобы он оступился.'
  await improvise(autonomy, 'improv-4', text)
  const afterFirst = await eventStore.load(CAMPAIGN_ID)

  await improvise(autonomy, 'improv-4', text)
  const afterRetry = await eventStore.load(CAMPAIGN_ID)
  assert.equal(afterRetry.state_version, afterFirst.state_version, 'повтор не должен двигать версию состояния')
})

test('replay потока событий даёт ту же экономию хода', async (t) => {
  const { autonomy, eventStore } = await fixture(t)
  await improvise(autonomy, 'improv-5', 'Опрокидываю жаровню под ноги огру, чтобы он оступился.')
  const direct = await eventStore.load(CAMPAIGN_ID)
  const replayed = await eventStore.load(CAMPAIGN_ID, { ignoreSnapshots: true })
  assert.deepEqual(
    replayed.state.mechanics.combat.action_economy.hero,
    direct.state.mechanics.combat.action_economy.hero,
  )
})
