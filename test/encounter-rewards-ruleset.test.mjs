import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AutonomousCampaignOrchestrator } from '../server/autonomous-orchestrator.mjs'
import { combatNarration } from '../server/combat-narration.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { freezeEncounterOutcomePlan } from '../server/encounter-rewards.mjs'
import { applyGameEvent, normalizeCampaignState, RulesEngine } from '../server/rules-engine.mjs'

function defeated2014Wolf() {
  const statBlockId = 'dnd_5e_2014:monster:wolf'
  return {
    ruleset_id: 'dnd_5e_2014',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', hp: 10, maxHp: 10, inventory: [], currency: {} }],
    enemies: [{
      id: 'wolf-1', hp: 0, alive: false, stat_block_id: statBlockId,
      provenance: { ruleset_id: 'dnd_5e_2014', stat_block_id: statBlockId, xp: 50 },
    }],
    mechanics: {
      death: { heroes: {} },
      encounter: {
        id: 'encounter-2014-wolf', status: 'ended', outcome: 'enemies_defeated',
        difficulty: 'easy', theme: 'beasts', enemy_ids: ['wolf-1'],
        enemies: [{ id: 'wolf-1', stat_block_id: statBlockId }],
      },
    },
  }
}

test('2014 encounter reward catalog accepts a server-owned wolf stat block', () => {
  const state = defeated2014Wolf()
  state.enemies[0].xp = 999_999
  state.enemies[0].armor = 0
  state.enemies[0].maxHp = 999_999
  const plan = freezeEncounterOutcomePlan(state, 'enemies_defeated')
  assert.equal(plan.total_xp, 50)
  assert.deepEqual(plan.enemies, [{
    enemy_id: 'wolf-1', stat_block_id: 'dnd_5e_2014:monster:wolf', xp: 50,
  }])
})

test('reward catalog rejects mixed-edition and unknown stat block IDs', () => {
  const mixed = defeated2014Wolf()
  mixed.ruleset_id = 'srd_5_2_1'
  assert.throws(() => freezeEncounterOutcomePlan(mixed, 'enemies_defeated'), { code: 'ENCOUNTER_RULESET_MISMATCH' })

  const unknown = defeated2014Wolf()
  unknown.enemies[0].stat_block_id = 'dnd_5e_2014:monster:made-up-wolf'
  unknown.enemies[0].provenance.stat_block_id = unknown.enemies[0].stat_block_id
  unknown.mechanics.encounter.enemies[0].stat_block_id = unknown.enemies[0].stat_block_id
  assert.throws(() => freezeEncounterOutcomePlan(unknown, 'enemies_defeated'), { code: 'ENCOUNTER_STAT_BLOCK_UNKNOWN' })
})

test('2014 completion distributes XP, coins and loot once across retry and restart', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-encounter-reward-2014-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const campaignId = 'REWARD-2014'
  const initial = normalizeCampaignState({
    ...defeated2014Wolf(),
    sessionCode: campaignId,
    scene: { title: 'Луг', location: 'Луг', objective: 'Продолжить путь', cells: [{ x: 0, y: 0, type: 'floor', revealed: true }] },
    mechanics: {
      ...defeated2014Wolf().mechanics,
      positions: { hero: { x: 0, y: 0 }, 'wolf-1': { x: 2, y: 0 } },
      world_time: { elapsed_minutes: 0 },
    },
  })
  const eventStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaign_id: campaignId, initial_state: initial })
  const makeAutonomy = (store) => new AutonomousCampaignOrchestrator({
    eventStore: store,
    rulesEngine: new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng(Array(64).fill(4)) }) }),
  })

  const first = await makeAutonomy(eventStore).completeEncounter({ campaignId, outcome: 'enemies_defeated' })
  const afterFirst = await eventStore.load(campaignId)
  const firstHero = afterFirst.state.players.find((player) => player.id === 'hero')
  assert.equal(firstHero.experience, 50)
  assert.ok(firstHero.currency.gold > 0 || firstHero.currency.silver > 0 || firstHero.currency.copper > 0)
  const firstInventorySize = firstHero.inventory.length
  // Летопись «Продолжим» строится из тех же событий (`tacticalNarrationOr`,
  // маршрут autonomy/advance): награда и отдых названы словами, вещи — те,
  // что легли в инвентарь (плейтест 2026-10-04, MC-03 и MC-05).
  const chronicle = combatNarration(first.events, afterFirst.state)
  const rewardItems = firstHero.inventory.filter((item) => item.origin === 'reward')
  assert.ok(rewardItems.length > 0, 'фикстура обязана выдать вещь награды')
  assert.match(chronicle, /Награда встречи — доля отряда за победу: [^.]*опыт: 50\./u)
  for (const item of rewardItems) assert.ok(chronicle.includes(`«${item.name}»`), `в летописи нет «${item.name}»`)
  assert.match(chronicle, /После победы отряд отдыхает 8 часов и восстанавливает силы/u)
  assert.equal((chronicle.match(/Награда встречи/gu) ?? []).length, 1)
  const repeated = await makeAutonomy(eventStore).completeEncounter({ campaignId, outcome: 'enemies_defeated', idempotencyKey: 'retry-after-browser' })
  assert.equal(repeated.duplicate, true)
  assert.equal(repeated.state_version, first.state_version)
  // Повтор не возвращает событий — и второй строки награды не будет.
  assert.equal(combatNarration(repeated.events, afterFirst.state), '')
  const afterRetry = await eventStore.load(campaignId)
  assert.equal(afterRetry.state.players.find((player) => player.id === 'hero').experience, 50)
  assert.equal(afterRetry.state.players.find((player) => player.id === 'hero').inventory.length, firstInventorySize)

  const restartedStore = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  const restarted = await makeAutonomy(restartedStore).completeEncounter({ campaignId, outcome: 'enemies_defeated', idempotencyKey: 'retry-after-restart' })
  assert.equal(restarted.duplicate, true)
  assert.equal(restarted.state_version, first.state_version)
  assert.deepEqual((await restartedStore.load(campaignId)).state, afterFirst.state)
})
