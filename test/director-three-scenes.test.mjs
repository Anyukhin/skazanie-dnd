import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DirectorAgent } from '../server/director-agent.mjs'
import { AutonomousCampaignOrchestrator } from '../server/autonomous-orchestrator.mjs'
import { DiceService } from '../server/dice-service.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { RulesEngine, applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

function cells() {
  return Array.from({ length: 117 }, (_, index) => ({
    x: index % 13, y: Math.floor(index / 13), type: 'floor', revealed: true,
  }))
}

test('offline Director связывает три сцены и позволяет избежать второго столкновения', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'skazanie-three-scenes-'))
  t.after(() => rmSync(rootDir, { recursive: true, force: true }))
  const initial = normalizeCampaignState({
    sessionCode: 'THREE-SCENES', campaign: 'Три сцены', partyMemberIds: ['hero'], activePlayerId: 'hero',
    players: [{ id: 'hero', character: 'Астер', level: 3, hp: 30, maxHp: 30, armor: 16, speed: 30, proficiency: 2, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], x: 1, y: 1 }],
    enemies: [], scene: { title: 'Глава 1', location: 'Старая дорога', objective: 'Идти по следу', turn: 4, cells: cells() },
    adventure: { chapter: 1, currentHook: 'Идти по следу', visitedLocations: ['Старая дорога'], history: [] },
    mechanics: { positions: { hero: { x: 1, y: 1 } }, encounter: { id: 'encounter-first', encounter_id: 'encounter-first', status: 'ended', outcome: 'enemies_defeated' } },
    autonomy: {
      director_history: [{ intent: { type: 'request_encounter' } }],
      encounter_outcomes: [{ encounter_id: 'encounter-first', outcome: 'enemies_defeated' }],
    },
    worldMemory: {
      entities: [{ id: 'road', kind: 'location', name: 'Старая дорога', summary: '', aliases: [], visibility: 'party', tags: [] }],
      facts: [], knowledge: {},
      quests: [{ id: 'trail', title: 'След', summary: '', status: 'active', visibility: 'party', entity_ids: ['road'], objectives: ['Идти по следу'], clock: { current: 1, max: 4, label: 'Улики' } }],
    },
  })
  const eventStore = new FileEventStore({ rootDir, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await eventStore.initializeCampaign({ campaign_id: 'THREE-SCENES', initial_state: initial })
  const orchestrator = new AutonomousCampaignOrchestrator({ eventStore, rulesEngine: new RulesEngine({ diceService: new DiceService() }) })
  const director = new DirectorAgent()

  const chosen = []
  for (let turn = 1; turn <= 4; turn += 1) {
    const loaded = await orchestrator.load('THREE-SCENES')
    const decision = await director.choose({ state: loaded.state, playerAction: 'Продолжить' })
    chosen.push(decision.intent.type)
    await orchestrator.runIntent({ campaignId: 'THREE-SCENES', intent: decision.intent, idempotencyKey: `three-scenes-${turn}` })
  }

  const final = await orchestrator.load('THREE-SCENES')
  const events = await eventStore.getEvents('THREE-SCENES')
  assert.deepEqual(chosen, ['end_scene', 'continue_exploration', 'advance_quest_clock', 'end_scene'])
  assert.equal(final.state.adventure.chapter, 3)
  assert.equal(events.filter((event) => event.event_type === 'SceneAdvanced').length, 2)
  assert.equal(events.some((event) => event.event_type === 'EncounterCreated'), false)
  assert.equal(final.state.autonomy.admin_interventions, 0)
})
