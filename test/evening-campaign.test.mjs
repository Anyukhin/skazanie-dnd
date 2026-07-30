import assert from 'node:assert/strict'
import test from 'node:test'

import { AutonomousCampaignOrchestrator } from '../server/autonomous-orchestrator.mjs'
import { buildCampaignArcPlan } from '../server/campaign-loop-policy.mjs'
import { DiceService } from '../server/dice-service.mjs'
import { DirectorAgent } from '../server/director-agent.mjs'
import {
  RULE_IDS,
  RulesEngine,
  applyGameEvent,
  normalizeCampaignState,
  replayEvents,
} from '../server/rules-engine.mjs'

class SeededDiceRng {
  constructor(seed = 0x0e71e123) {
    this.state = seed >>> 0
  }

  randint(minimum, maximum) {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0
    return minimum + (this.state % (maximum - minimum + 1))
  }
}

class MemoryEventStore {
  constructor(initialState) {
    this.initialState = normalizeCampaignState(initialState)
    this.state = structuredClone(this.initialState)
    this.events = []
    this.commits = new Map()
  }

  async initializeCampaign() {}

  async load() {
    return {
      state: structuredClone(this.state),
      state_version: this.state.state_version,
    }
  }

  async getByIdempotencyKey(_campaignId, key) {
    return this.commits.get(key) ?? null
  }

  async commit(request) {
    const duplicate = this.commits.get(request.idempotency_key)
    if (duplicate) return { ...structuredClone(duplicate), duplicate: true }
    assert.equal(request.expected_state_version, this.state.state_version)
    const committedEvents = request.events.map((entry, index) => ({
      ...structuredClone(entry),
      event_id: entry.event_id || `evening-event-${this.events.length + index + 1}`,
      state_version_before: this.state.state_version + index,
      state_version_after: this.state.state_version + index + 1,
    }))
    for (const entry of committedEvents) this.state = applyGameEvent(this.state, entry)
    this.events.push(...committedEvents)
    const result = {
      duplicate: false,
      events: structuredClone(committedEvents),
      state: structuredClone(this.state),
      state_version: this.state.state_version,
    }
    this.commits.set(request.idempotency_key, structuredClone(result))
    return result
  }

  async getEvents() {
    return structuredClone(this.events)
  }
}

function cells(width = 13, height = 9) {
  return Array.from({ length: width * height }, (_, index) => ({
    x: index % width,
    y: Math.floor(index / width),
    type: 'floor',
    revealed: true,
  }))
}

function eveningState(seed = 'bounded-evening') {
  const arc = buildCampaignArcPlan(seed)
  return normalizeCampaignState({
    sessionCode: 'EVENING-ARC',
    campaign: 'Вечер у старой башни',
    campaignConcept: { arc },
    partyMemberIds: ['hero'],
    activePlayerId: 'hero',
    players: [{
      id: 'hero',
      character: 'Астер',
      level: 5,
      hp: 240,
      maxHp: 240,
      armor: 25,
      speed: 30,
      proficiency: 3,
      abilities: { str: 18, dex: 14, con: 18, int: 10, wis: 12, cha: 12 },
      inventory: [{
        id: 'evening-longsword',
        name: 'Длинный меч',
        type: 'weapon',
        quantity: 1,
        equipped: true,
        combat: {
          kind: 'melee',
          ability: 'str',
          range_feet: 5,
          damage_expression: '1d8+4',
          damage_type: 'slashing',
          proficient: true,
        },
      }],
      x: 1,
      y: 1,
    }],
    enemies: [],
    scene: {
      title: 'Старая дорога',
      location: 'Старая дорога',
      objective: 'Узнать, почему звонит покинутая башня',
      turn: 1,
      cells: cells(),
    },
    adventure: {
      chapter: 1,
      currentHook: 'Колокол зовёт путников к башне',
      visitedLocations: ['Старая дорога'],
      unresolvedThreads: [],
      history: [],
    },
    mechanics: {
      positions: { hero: { x: 1, y: 1 } },
      world_time: { elapsed_minutes: 0 },
    },
    worldMemory: {
      entities: [{
        id: 'old-road',
        kind: 'location',
        name: 'Старая дорога',
        summary: '',
        aliases: [],
        visibility: 'party',
        tags: [],
      }],
      facts: [],
      quests: [
        {
          id: 'quest:chapter:1',
          title: 'Зов колокола',
          summary: '',
          status: 'active',
          visibility: 'party',
          entity_ids: ['old-road'],
          objectives: ['Понять первый знак'],
          clock: { current: 0, max: arc.chapter_clock_max, label: 'Цель сцены', triggered: false },
        },
        {
          id: 'quest:evening-main',
          title: 'Тайна старой башни',
          summary: '',
          status: 'active',
          visibility: 'party',
          entity_ids: ['old-road'],
          objectives: ['Разрешить тайну старой башни'],
          clock: { current: 0, max: arc.target_scenes, label: 'Главная нить', triggered: false },
        },
      ],
      knowledge: {},
    },
    social: {
      npcs: [{
        id: 'guide',
        name: 'Мира',
        role: 'проводница',
        location: 'Старая дорога',
        public_summary: 'Мира слышала колокол.',
        voice: 'Говорит коротко.',
        goals: [],
        beliefs: [],
        known_fact_ids: [],
        visibility: 'party',
        available: true,
        tags: [],
      }],
      relationships: { guide: { hero: 0 } },
      conversations: [],
      promises: [],
    },
  })
}

test('one-evening campaign converges in 3-5 scenes and ends after a real hard final combat', { timeout: 60_000 }, async () => {
  const initial = eveningState()
  const targetScenes = initial.campaignConcept.arc.target_scenes
  const eventStore = new MemoryEventStore(initial)
  await eventStore.initializeCampaign({ campaign_id: 'EVENING-ARC', initial_state: initial })
  const rulesEngine = new RulesEngine({ diceService: new DiceService({ rng: new SeededDiceRng() }) })
  const autonomy = new AutonomousCampaignOrchestrator({
    eventStore,
    rulesEngine,
    now: () => 1_785_000_000_000,
  })
  const director = new DirectorAgent()

  for (let step = 0; step < 120; step += 1) {
    const loaded = await autonomy.load('EVENING-ARC')
    if (['completed', 'failed'].includes(loaded.state.mechanics.campaign_lifecycle.status)) break
    if (loaded.state.mechanics.combat.active) {
      const enemies = loaded.state.enemies.filter((enemy) => enemy.alive !== false && Number(enemy.hp) > 0)
      const actorId = String(
        loaded.state.mechanics.combat.initiative[loaded.state.mechanics.combat.active_index]?.actor_id
          ?? loaded.state.players[0]?.id
          ?? '',
      )
      await autonomy.runCommands(
        'EVENING-ARC',
        `evening-combat-${loaded.state.adventure.chapter}:${loaded.state.mechanics.encounter?.id}:authoritative-end`,
        [
          ...enemies.map((enemy) => ({
            command_type: 'ApplyDamage',
            actor_id: loaded.state.players[0].id,
            target_id: enemy.id,
            amount: Math.max(1, Number(enemy.maxHp ?? enemy.max_hp ?? enemy.hp) || 1) * 2,
            damage_type: 'force',
            source_rule_ids: [RULE_IDS.damage],
          })),
          { command_type: 'EndCombat', actor_id: actorId, reason: 'enemies_defeated' },
        ],
      )
      continue
    }
    const encounter = loaded.state.mechanics.encounter
    const outcomeRecorded = encounter?.id
      && loaded.state.autonomy.encounter_outcomes.some((entry) => entry.encounter_id === encounter.id)
    if (encounter?.status === 'ended' && !outcomeRecorded) {
      await autonomy.completeEncounter({
        campaignId: 'EVENING-ARC',
        outcome: encounter.outcome || 'enemies_defeated',
        idempotencyKey: `evening-outcome-${loaded.state.adventure.chapter}:${encounter.id}`,
      })
      continue
    }
    const decision = await director.choose({ state: loaded.state, playerAction: 'Продолжить историю' })
    await autonomy.runIntent({
      campaignId: 'EVENING-ARC',
      intent: decision.intent,
      idempotencyKey: `evening-scene-${loaded.state.adventure.chapter}-beat-${step + 1}`,
    })
  }

  const final = await autonomy.load('EVENING-ARC')
  const events = await eventStore.getEvents('EVENING-ARC')
  const eventTypes = events.map((entry) => entry.event_type)
  const finalEncounterIndex = eventTypes.lastIndexOf('EncounterCreated')
  const lastSceneIndex = eventTypes.lastIndexOf('SceneAdvanced')
  const outcomeIndex = eventTypes.lastIndexOf('EncounterOutcomeRecorded')
  const completionIndex = eventTypes.lastIndexOf('CampaignCompleted')
  const finalEncounter = events[finalEncounterIndex]?.payload?.encounter

  assert.equal(final.state.mechanics.campaign_lifecycle.status, 'completed', JSON.stringify({
    chapter: final.state.adventure.chapter,
    targetScenes,
    quests: final.state.worldMemory.quests.map((quest) => ({
      id: quest.id,
      status: quest.status,
      clock: quest.clock,
    })),
    recentIntents: final.state.autonomy.director_history.slice(-12).map((entry) => entry.intent?.type),
    encounter: final.state.mechanics.encounter,
    combat: final.state.mechanics.combat,
    outcomes: final.state.autonomy.encounter_outcomes,
    eventCounts: Object.fromEntries([...new Set(eventTypes)].map((type) => [
      type,
      eventTypes.filter((candidate) => candidate === type).length,
    ])),
  }))
  assert.ok(targetScenes >= 3 && targetScenes <= 5)
  assert.equal(final.state.adventure.chapter, targetScenes)
  assert.equal(eventTypes.filter((type) => type === 'SceneAdvanced').length + 1, targetScenes)
  assert.ok(finalEncounterIndex > lastSceneIndex)
  assert.equal(finalEncounter?.difficulty, 'hard')
  assert.equal(finalEncounter?.created_in_chapter, targetScenes)
  assert.ok(eventTypes.includes('CombatStarted'))
  assert.ok(eventTypes.includes('DamageApplied'))
  assert.ok(eventTypes.includes('EncounterEnded'))
  assert.ok(outcomeIndex > finalEncounterIndex)
  assert.ok(completionIndex > outcomeIndex)
  assert.equal(final.state.autonomy.admin_interventions, 0)

  assert.deepEqual(replayEvents(initial, events), final.state)
})
