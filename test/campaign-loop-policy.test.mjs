import assert from 'node:assert/strict'
import test from 'node:test'

import {
  QUEST_ABANDONMENT_NEXT_OBJECTIVE,
  authorizeDirectorIntent,
  assembleSocialNpc,
  buildCampaignArcPlan,
  campaignArcClimaxSatisfied,
  campaignArcPosition,
  completedDowntime,
  directorObjectiveAfterQuestAbandonment,
  nextWorldMapDestination,
  pacingForDirectorIntent,
  planServerTravel,
} from '../server/campaign-loop-policy.mjs'

const baseState = {
  sessionCode: 'LOOP-1',
  partyMemberIds: ['hero-a', 'hero-b'],
  players: [{ id: 'hero-a' }, { id: 'hero-b' }],
  scene: { location: 'Северный тракт', scene_kind: 'wilderness' },
  adventure: { chapter: 2 },
  mechanics: { world_time: { elapsed_minutes: 120 }, death: { heroes: {} } },
  worldMemory: {
    entities: [{ id: 'wardens', kind: 'faction' }],
      facts: [{ id: 'fact-1', predicate: 'discovery', subject_id: 'wardens', source_event_ids: ['event-1'], status: 'active', visibility: 'party' }],
      quests: [{ id: 'quest-1', status: 'active', entity_ids: ['wardens'], clock: { current: 0, max: 6 } }],
  },
  autonomy: { pacing: { beat: 4, phase: 'escalation', tension: 82 } },
}

test('server pacing derives bounded tension from a narrative-only intent', () => {
  const pacing = pacingForDirectorIntent(baseState, { type: 'advance_quest_clock' })
  assert.deepEqual(pacing, {
    beat: 5,
    phase: 'climax',
    tension_before: 82,
    tension_after: 96,
    delta: 14,
    intent_type: 'advance_quest_clock',
    policy: 'campaign-pacing-v1',
  })
})

test('Rules policy replaces repeated and phase-incompatible Director intents', () => {
  const state = structuredClone(baseState)
  state.autonomy.director_history = [{ intent: { type: 'open_social_scene' } }]
  state.autonomy.director_outcomes = [{ intent_type: 'open_social_scene', state_changed: false }, { state_changed: true, progress_before: 'a', progress_after: 'b' }]
  state.autonomy.pacing = { beat: 7, phase: 'escalation', tension: 68 }

  const authorized = authorizeDirectorIntent(state, { type: 'open_social_scene' })

  assert.equal(authorized.replaced, true)
  assert.equal(authorized.reason, 'anti_stall_replacement')
  assert.equal(authorized.intent.type, 'advance_quest_clock')
  assert.equal(authorized.intent.quest_id, 'quest-1')
  assert.ok(!authorized.allowed_types.includes('open_social_scene'))
})

test('pacing grows on social and hook beats instead of rewarding stagnation', () => {
  assert.equal(pacingForDirectorIntent({ autonomy: { pacing: { tension: 10 } } }, { type: 'open_social_scene' }).tension_after, 18)
  assert.equal(pacingForDirectorIntent({ autonomy: { pacing: { tension: 18 } } }, { type: 'offer_next_hook' }).tension_after, 24)
})

test('travel policy is deterministic and owns time, risk and random encounter mechanics', () => {
  const options = { campaignId: 'LOOP-1', destination: 'Заброшенный склеп', idempotencyKey: 'travel-1' }
  const first = planServerTravel(baseState, options)
  const second = planServerTravel(baseState, options)
  assert.deepEqual(first, second)
  assert.ok(first.duration_minutes >= 75)
  assert.ok(first.risk_score >= 65)
  assert.equal(typeof first.random_encounter, 'boolean')
  if (first.random_encounter) {
    assert.ok(['undead', 'raiders'].includes(first.encounter.theme))
    assert.ok(['easy', 'medium', 'hard'].includes(first.encounter.difficulty))
  }
  const triggered = Array.from({ length: 200 }, (_, index) => planServerTravel(baseState, {
    ...options,
    idempotencyKey: `travel-risk-${index}`,
  })).find((travel) => travel.random_encounter)
  assert.ok(triggered, 'high server-owned travel risk must be able to trigger a random encounter')
  assert.ok(['undead', 'raiders'].includes(triggered.encounter.theme))
})

test('social assembler creates a replay-stable bounded NPC using only known public facts', () => {
  const options = { campaignId: 'LOOP-1', idempotencyKey: 'social-1' }
  const first = assembleSocialNpc(baseState, options)
  assert.deepEqual(first, assembleSocialNpc(baseState, options))
  assert.match(first.id, /^npc-[a-f0-9]{16}$/u)
  assert.equal(first.location, 'Северный тракт')
  assert.deepEqual(first.known_fact_ids, ['fact-1'])
  assert.deepEqual(first.tags, ['faction:wardens'])
  assert.deepEqual(first.inventory, [])
})

test('downtime excludes dead heroes and derives its own duration', () => {
  const state = structuredClone(baseState)
  state.mechanics.death.heroes['hero-b'] = { status: 'dead' }
  const downtime = completedDowntime(state)
  assert.deepEqual(downtime.participant_ids, ['hero-a'])
  assert.equal(downtime.duration_minutes, 480)
  assert.equal(downtime.policy, 'server-downtime-v1')
})

test('one-evening arc is seed-stable, bounded to 3-5 scenes and leaves legacy pacing untouched', () => {
  const first = buildCampaignArcPlan('evening-seed')
  const second = buildCampaignArcPlan('evening-seed')
  const structure = (plan) => Array.from({ length: plan.target_scenes }, (_, index) => campaignArcPosition({
    campaignConcept: { arc: plan },
    adventure: { chapter: index + 1 },
    autonomy: { director_history: [] },
    worldMemory: { quests: [] },
  }).phase)

  assert.deepEqual(first, second)
  assert.deepEqual(structure(first), structure(second))
  assert.ok(first.target_scenes >= 3 && first.target_scenes <= 5)
  assert.equal(first.chapter_clock_max, 2)
  assert.equal(pacingForDirectorIntent(baseState, { type: 'advance_quest_clock' }).policy, 'campaign-pacing-v1')
})

test('one-evening policy preserves player pacing and allows a non-combat final resolution', () => {
  const plan = buildCampaignArcPlan('forced-evening')
  const state = structuredClone(baseState)
  state.campaignConcept = { arc: plan }
  state.adventure.chapter = 1
  state.worldMemory.quests = [
    { id: 'quest:chapter:1', status: 'active', clock: { current: 0, max: 2, triggered: false } },
    { id: 'quest:main', status: 'active', clock: { current: 0, max: plan.target_scenes, triggered: false } },
  ]
  state.autonomy.director_history = [
    { intent: { type: 'continue_exploration' } },
    { intent: { type: 'open_social_scene' } },
  ]

  const clock = authorizeDirectorIntent(state, { type: 'offer_next_hook', hook: 'stall' })
  assert.equal(clock.intent.type, 'offer_next_hook')
  assert.equal(clock.reason, 'intent_allowed')

  state.worldMemory.quests[0].clock.current = 1
  const openingEncounter = authorizeDirectorIntent(state, {
    type: 'request_encounter',
    theme: 'beasts',
    difficulty: 'medium',
  })
  assert.notEqual(openingEncounter.intent.type, 'advance_quest_clock')
  assert.notEqual(openingEncounter.intent.difficulty, 'hard')

  state.worldMemory.quests[0].status = 'completed'
  state.worldMemory.quests[0].clock.triggered = true
  const transition = authorizeDirectorIntent(state, { type: 'offer_next_hook', hook: 'stall again' })
  assert.equal(transition.intent.type, 'offer_next_hook')
  assert.equal(transition.reason, 'intent_allowed')

  state.adventure.chapter = plan.target_scenes
  state.worldMemory.quests[0] = {
    id: `quest:chapter:${plan.target_scenes}`,
    status: 'completed',
    clock: { current: 2, max: 2, triggered: true },
  }
  state.autonomy.director_history = [
    { intent: { type: 'continue_exploration' } },
    { intent: { type: 'advance_quest_clock' } },
  ]
  const climax = authorizeDirectorIntent(state, { type: 'request_encounter', theme: 'undead', difficulty: 'medium' })
  assert.ok(['request_encounter', 'continue_exploration', 'offer_next_hook', 'resolve_scene'].includes(climax.intent.type))
  assert.notEqual(climax.intent.difficulty, 'hard')
  assert.equal(campaignArcPosition(state).phase, 'climax')
})

test('исчерпав намерения фазы, Режиссёр подсказывает следующий шаг, а не повторяет «ничего не меняется»', () => {
  // Прогон Асстохана с моделью (2026-10-05): после боя главы в фазе обострения
  // разрешено только continue_exploration, защита от застоя его блокирует, и
  // политика брала весь список фазы — тот же continue_exploration по кругу.
  const arc = buildCampaignArcPlan('stall-probe')
  // Глава 2 этой арки — фаза обострения; бой главы уже был, подтверждённой
  // зацепки и собеседника нет — продвинуть сюжет нечем, это и есть тупик главы.
  const state = {
    campaignConcept: { arc }, adventure: { chapter: 2 }, scene: { location: 'Застава' },
    mechanics: { combat: { active: false }, encounter: { id: 'chapter-fight', status: 'ended', difficulty: 'medium', created_in_chapter: 2 } },
    autonomy: {
      director_history: [{ intent: { type: 'request_encounter' } }, { intent: { type: 'continue_exploration' } }],
      director_outcomes: [{ intent_type: 'continue_exploration', state_changed: false }],
      encounter_outcomes: [{ encounter_id: 'chapter-fight', outcome: 'enemies_defeated' }],
    },
    worldMemory: { quests: [{ id: 'q', title: 'Главная нить', status: 'active', clock: { current: 0, max: 4 } }] },
  }
  assert.equal(authorizeDirectorIntent(state, { type: 'continue_exploration' }).phase, 'escalation')
  const result = authorizeDirectorIntent(state, { type: 'continue_exploration' }, { playerAction: 'Продолжить приключение' })
  assert.equal(result.intent.type, 'offer_next_hook')
  assert.equal(result.reason, 'anti_stall_replacement')
  assert.ok(result.intent.hook)
})

test('без модели следующая сцена — соседняя точка карты мира, а не заглушка «След N»', async () => {
  // Прогон Асстохана (2026-10-05): сцены звались «След 3», «След 4», а карта
  // мира стояла на прежней точке — отряд «уходил», не двигаясь.
  const { readFile } = await import('node:fs/promises')
  const { fallbackDirectorIntent } = await import('../server/director-agent.mjs')
  const template = JSON.parse(await readFile(new URL('../data/campaign-worlds-v1.json', import.meta.url), 'utf8')).templates.find((entry) => entry.id === 'astohan-plains')
  const worldMap = structuredClone(template.world_map)
  const at = (id) => ({ worldMap: { ...worldMap, currentLocationId: id }, scene: { location: worldMap.locations.find((entry) => entry.id === id).name } })
  assert.equal(nextWorldMapDestination(at('astohan-stormberg')), 'Пепельная застава', 'непосещённая и ближайшая')
  worldMap.locations.find((entry) => entry.id === 'astohan-stormberg').visited = true
  assert.equal(nextWorldMapDestination(at('astohan-ash-watch')), 'Обсидиановый перевал', 'назад в посещённый Штормберг — только если больше некуда')
  assert.equal(nextWorldMapDestination({ scene: { location: 'Старая дорога' } }), null, 'без карты мира места нет')
  const intent = fallbackDirectorIntent({ ...at('astohan-ash-watch'), adventure: { chapter: 2 }, mechanics: { combat: { active: false } } }, 'Перейти дальше')
  assert.equal(intent.type, 'end_scene')
  assert.equal(intent.destination, 'Обсидиановый перевал')
  // Тупик перевала: оба соседа уже пройдены, дорога к логову ещё не открыта.
  // Прежде отряд шёл назад в заставу и в столицу; теперь — к ближайшему
  // непосещённому месту через пройденные, путь считает сам переход.
  worldMap.locations.find((entry) => entry.id === 'astohan-ash-watch').visited = true
  worldMap.locations.find((entry) => entry.id === 'astohan-obsidian-pass').visited = true
  assert.equal(nextWorldMapDestination(at('astohan-obsidian-pass')), 'Озеро Двух Отражений')
  for (const location of worldMap.locations) location.visited = true
  assert.equal(nextWorldMapDestination(at('astohan-obsidian-pass')), 'Пепельная застава', 'всё пройдено — ближайший сосед')
})

test('one-evening climax requires a matching recorded hard encounter outcome', () => {
  const plan = buildCampaignArcPlan('climax-proof')
  const state = structuredClone(baseState)
  state.campaignConcept = { arc: plan }
  state.adventure.chapter = plan.target_scenes
  state.mechanics.encounter = {
    id: 'final-encounter',
    status: 'ended',
    difficulty: 'medium',
    created_in_chapter: plan.target_scenes,
  }
  state.autonomy.encounter_outcomes = [{ encounter_id: 'final-encounter', outcome: 'enemies_defeated' }]
  assert.equal(campaignArcClimaxSatisfied(state), false)

  state.mechanics.encounter.difficulty = 'hard'
  assert.equal(campaignArcClimaxSatisfied(state), true)
  state.mechanics.encounter.created_in_chapter -= 1
  assert.equal(campaignArcClimaxSatisfied(state), false)
  // Отряд ушёл дальше финальной главы, не дав боя: развязка остаётся достижимой.
  state.adventure.chapter = plan.target_scenes + 2
  state.mechanics.encounter.created_in_chapter = plan.target_scenes + 2
  assert.equal(campaignArcClimaxSatisfied(state), true)
  state.adventure.chapter = plan.target_scenes
  state.mechanics.encounter.created_in_chapter = plan.target_scenes
  state.autonomy.encounter_outcomes = [{ encounter_id: 'other-encounter', outcome: 'enemies_defeated' }]
  assert.equal(campaignArcClimaxSatisfied(state), false)
  // Проигранная кульминация — не победный финал (прогон Асстохана, сид 2).
  for (const lost of ['party_incapacitated', 'party_defeated']) {
    state.autonomy.encounter_outcomes = [{ encounter_id: 'final-encounter', outcome: lost }]
    assert.equal(campaignArcClimaxSatisfied(state), false, lost)
  }
})

test('закрытый квест не возвращается в intent, когда другой квест ещё активен', () => {
  const state = structuredClone(baseState)
  state.worldMemory.quests = [
    { id: 'quest:abandoned', title: 'Старая цель', status: 'abandoned', clock: { current: 1, max: 4 } },
    { id: 'quest:open', title: 'Новая цель', status: 'active', entity_ids: ['wardens'], objectives: ['Найти след'], clock: { current: 0, max: 4 } },
  ]
  state.worldMemory.facts = [{
    id: 'fact:trail', predicate: 'discovery', subject_id: 'wardens', source_event_ids: ['event:trail'],
    summary: 'Найден след.', status: 'active', visibility: 'party',
  }]

  const authorized = authorizeDirectorIntent(state, { type: 'advance_quest_clock', quest_id: 'quest:abandoned' })
  assert.equal(authorized.replaced, true)
  assert.equal(authorized.reason, 'closed_quest_replacement')
  assert.equal(authorized.intent.type, 'advance_quest_clock')
  assert.equal(authorized.intent.quest_id, 'quest:open')
})

test('настоящая улика остаётся допустимой при заполненных часах и другом открытом поручении', () => {
  const state = structuredClone(baseState)
  state.worldMemory.quests = [
    { id: 'quest:other', title: 'Другое дело', status: 'active', entity_ids: ['other'], clock: { current: 0, max: 3 } },
    { id: 'quest:proven', title: 'Найти след', status: 'active', entity_ids: ['wardens'], clock: { current: 3, max: 3, triggered: true } },
  ]
  state.worldMemory.facts = [{ id: 'fact:trail', predicate: 'discovery', subject_id: 'wardens',
    source_event_ids: ['event:trail'], status: 'active', visibility: 'party' }]
  const authorized = authorizeDirectorIntent(state, { type: 'advance_quest_clock', quest_id: 'quest:proven' })
  assert.equal(authorized.replaced, false)
  assert.equal(authorized.intent.quest_id, 'quest:proven')
})

test('отказ в текущей локации даёт нейтральную цель для продолжения', () => {
  const state = structuredClone(baseState)
  const arc = buildCampaignArcPlan('in-place-abandonment')
  state.campaignConcept = { arc }
  state.adventure.chapter = arc.target_scenes
  state.autonomy.pacing = { beat: 9, phase: 'climax', tension: 90 }
  state.worldMemory.quests = [{
    id: 'quest:main', title: 'Старая цель', status: 'abandoned', stay_in_location: true,
    clock: { current: 1, max: arc.target_scenes },
  }]
  assert.equal(directorObjectiveAfterQuestAbandonment(state), QUEST_ABANDONMENT_NEXT_OBJECTIVE)
})
