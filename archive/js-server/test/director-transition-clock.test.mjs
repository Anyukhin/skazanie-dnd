import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { buildDirectorTransitionCommands } from '../server/director-scene-transition.mjs'
import { FileEventStore } from '../server/event-store.mjs'
import { applyGameEvent, normalizeCampaignState, RulesEngine } from '../server/rules-engine.mjs'

function campaign() {
  return normalizeCampaignState({
    sessionCode: 'DIRECTOR-CLOCK',
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{
      id: 'hero', character: 'Герой', hp: 10, maxHp: 10, armor: 12, speed: 30,
      abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
      x: 1, y: 1, inventory: [],
    }],
    scene: {
      title: 'Тихая застава', location: 'Тихая застава', location_id: 'start',
      objective: 'Найти след каравана', turn: 1, cells: [],
    },
    adventure: {
      chapter: 1, history: [], visitedLocations: ['Тихая застава'],
      visitedLocationIds: ['start'], unresolvedThreads: [],
    },
    worldMap: {
      version: 1, seed: 'DIRECTOR-CLOCK', name: 'Карта часов', width: 1000, height: 640,
      currentLocationId: 'start',
      regions: [{ id: 'plains', name: 'Равнины', biome: 'plains', x: 300, y: 300, radius: 200 }],
      locations: [
        { id: 'start', name: 'Тихая застава', kind: 'village', x: 200, y: 300, regionId: 'plains', known: true, visited: true },
        { id: 'target', name: 'Дальний рубеж', kind: 'landmark', x: 600, y: 300, regionId: 'plains', known: true, visited: false },
      ],
      routes: [{ id: 'route-clock', from: 'start', to: 'target', kind: 'road', distance: 4, danger: 'низкая', discovered: true }],
    },
    mechanics: { world_time: { elapsed_minutes: 5 }, combat: { active: false } },
    agentInteraction: {
      id: 'decision-clock', type: 'vote', status: 'resolved', resolvedOptionId: 'target',
      options: [{ id: 'target', label: 'Идти к Дальнему рубежу' }], votes: { hero: 'target' },
    },
  })
}

test('групповой переход ставит авторитетные часы в тот же commit и переживает replay/idempotency', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'skazanie-director-clock-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const initial = campaign()
  const store = new FileEventStore({ rootDir: root, reducer: applyGameEvent, normalizeState: normalizeCampaignState })
  await store.initializeCampaign({ campaign_id: initial.sessionCode, initial_state: initial })

  const planned = buildDirectorTransitionCommands({
    campaignId: initial.sessionCode,
    action: '[РЕШЕНИЕ ГРУППЫ] Идти к Дальнему рубежу',
    state: initial,
    sceneArgs: {
      title: 'Дальний рубеж', location: 'Дальний рубеж', location_id: 'target',
      theme: 'дорога', objective: 'Осмотреть следы', seed: 'director-clock',
    },
    partyDecision: { interaction_id: 'decision-clock', resolved_option_id: 'target' },
  })
  assert.equal(planned.commands[0].command_type, 'AdvanceTime')
  assert.equal(planned.commands[0].amount, 150)
  assert.equal(planned.commands[1].command_type, 'AdvanceScene')

  const engine = new RulesEngine({ diceService: new DiceService({ rng: new SequenceDiceRng([]) }) })
  const resolved = engine.resolvePlan({ proposed_commands: planned.commands }, initial, { isDirector: true })
  const timeEvent = resolved.events.find((event) => event.event_type === 'TimeAdvanced')
  assert.ok(timeEvent)
  assert.equal(timeEvent.payload.amount, 150)
  assert.equal(timeEvent.payload.elapsed_minutes, 150)

  const committed = await store.commit({
    campaign_id: initial.sessionCode,
    expected_state_version: initial.state_version,
    idempotency_key: 'director-clock-1',
    command_id: 'director-clock-1',
    events: resolved.events,
  })
  const loaded = await store.load(initial.sessionCode)
  assert.equal(loaded.state.mechanics.world_time.elapsed_minutes, 155)
  assert.equal(loaded.state.scene.location, 'Дальний рубеж')

  const duplicate = await store.commit({
    campaign_id: initial.sessionCode,
    expected_state_version: initial.state_version,
    idempotency_key: 'director-clock-1',
    command_id: 'director-clock-1',
    events: resolved.events,
  })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.state_version, committed.state_version)
  assert.equal((await store.load(initial.sessionCode)).state.mechanics.world_time.elapsed_minutes, 155)

  const replayed = await store.replay(initial.sessionCode, { use_snapshots: false })
  assert.deepEqual(replayed.state, loaded.state)
})
