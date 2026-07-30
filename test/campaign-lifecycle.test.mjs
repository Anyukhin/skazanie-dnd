import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertCampaignPlayable,
  buildEpilogueNarrationBrief,
  buildDeterministicEpilogue,
  campaignCanAutoComplete,
  collectEpilogueFacts,
  lifecycleEventForAction,
  normalizeCampaignLifecycle,
} from '../server/campaign-lifecycle.mjs'
import { buildCampaignArcPlan } from '../server/campaign-loop-policy.mjs'
import { applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'

function campaign() {
  return normalizeCampaignState({
    sessionCode: 'LIFE-1',
    campaign: 'Предел зимы',
    partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, inventory: [] }],
    scene: { location: 'Северная башня', objective: 'Остановить бурю', cells: [] },
  })
}

function richEpilogueCampaign() {
  const state = campaign()
  state.players.push({ id: 'bran', character: 'Бран', hp: 8, maxHp: 12, inventory: [] })
  state.mechanics.death.heroes.bran = {
    status: 'dead', resolution: null, died_at: '2026-01-01T00:00:00.000Z',
    resolved_at: null, replacement_name: null,
  }
  state.worldMemory.entities.push(
    { id: 'npc:mira', kind: 'npc', name: 'Мира', summary: 'Проводница', aliases: [], visibility: 'party', tags: [] },
    { id: 'npc:mask', kind: 'npc', name: 'Человек в маске', summary: 'Тайный покровитель', aliases: [], visibility: 'gm_only', tags: [] },
    { id: 'faction:wardens', kind: 'faction', name: 'Стражи тракта', summary: '', aliases: [], visibility: 'party', tags: [] },
    { id: 'faction:cabal', kind: 'faction', name: 'Тайный круг', summary: '', aliases: [], visibility: 'gm_only', tags: [] },
    { id: 'location:ford', kind: 'location', name: 'Пепельный брод', summary: '', aliases: [], visibility: 'party', tags: ['visited'] },
  )
  state.worldMemory.quests = [
    {
      id: 'quest:storm', title: 'Остановить бурю', summary: 'Буря рассеялась.',
      status: 'completed', visibility: 'party', entity_ids: [], objectives: [],
      clock: { current: 4, max: 4, label: 'Прогресс', triggered: true },
    },
    {
      id: 'quest:evacuation', title: 'Вывести жителей', summary: 'Не всех удалось спасти.',
      status: 'failed', visibility: 'party', entity_ids: [], objectives: [],
      clock: { current: 4, max: 4, label: 'Прогресс', triggered: true },
    },
    {
      id: 'quest:hidden', title: 'Скрытая цель круга', summary: 'Заговор продолжился.',
      status: 'completed', visibility: 'gm_only', entity_ids: [], objectives: [],
      clock: { current: 4, max: 4, label: 'Прогресс', triggered: true },
    },
    {
      id: 'quest:personal', title: 'Личная тайна', summary: 'Её знает только Ада.',
      status: 'completed', visibility: 'specific_player', entity_ids: [], objectives: [],
      clock: { current: 4, max: 4, label: 'Прогресс', triggered: true },
    },
  ]
  state.worldMemory.facts = [
    {
      id: 'fact:mira-fate', subject_id: 'npc:mira', predicate: 'npc_fate', object: 'survived',
      summary: 'Мира пережила бурю и вернулась к заставе.', status: 'active', visibility: 'party',
    },
    {
      id: 'fact:tower', subject_id: 'location:ford', predicate: 'outcome', object: 'safe',
      summary: 'Пепельный брод снова открыт.', status: 'active', visibility: 'party',
    },
    {
      id: 'fact:mask-fate', subject_id: 'npc:mask', predicate: 'npc_fate', object: 'escaped',
      summary: 'Человек в маске ускользнул.', status: 'active', visibility: 'gm_only',
    },
    {
      id: 'fact:personal', subject_id: 'npc:mira', predicate: 'secret', object: 'known_by_ada',
      summary: 'Только Ада узнала тайное имя Миры.', status: 'active', visibility: 'specific_player',
    },
    {
      id: 'fact:legacy-hidden', subject_id: 'npc:mask', predicate: 'secret', object: 'missing_visibility',
      summary: 'Факт без видимости остаётся скрытым.', status: 'active',
    },
  ]
  state.social = {
    npcs: [
      { id: 'npc:mira', name: 'Мира', visibility: 'party' },
      { id: 'npc:mask', name: 'Человек в маске', visibility: 'gm_only' },
    ],
    promises: [
      {
        id: 'promise:map', npc_id: 'npc:mira', hero_id: 'hero', direction: 'npc_to_party',
        text: 'Показать карту старых троп.', status: 'fulfilled', visibility: 'party',
      },
      {
        id: 'promise:warning', npc_id: 'npc:mira', hero_id: 'hero', direction: 'party_to_npc',
        text: 'Предупредить заставу до заката.', status: 'broken', visibility: 'party',
      },
      {
        id: 'promise:personal', npc_id: 'npc:mira', hero_id: 'hero', direction: 'npc_to_party',
        text: 'Открыть Аде тайное имя.', status: 'fulfilled', visibility: 'specific_player',
      },
      {
        id: 'promise:hidden-npc', npc_id: 'npc:mask', hero_id: 'hero', direction: 'npc_to_party',
        text: 'Вернуться за печатью.', status: 'fulfilled', visibility: 'party',
      },
    ],
  }
  state.autonomy.reputations = { 'faction:wardens': 60, 'faction:cabal': 100 }
  state.adventure.visitedLocations = ['Северная башня', 'Пепельный брод']
  state.adventure.visitedLocationIds = ['location:tower', 'location:ford']
  state.adventure.history = [
    { chapter: 1, location: 'Северная башня', outcome: 'Отряд удержал ворота.', visibility: 'party' },
    { chapter: 2, location: 'Тайное убежище', outcome: 'Круг готовит новый заговор.', visibility: 'gm_only' },
    { chapter: 3, location: 'Личный сон Ады', outcome: 'Только Ада увидела знак.', visibility: 'specific_player' },
  ]
  return state
}

test('lifecycle permits pause, resume, completion and archival in order', () => {
  let state = campaign()
  const paused = lifecycleEventForAction('pause', state, { actorId: 'owner', now: '2026-01-01T00:00:00.000Z' })
  state = applyGameEvent(state, paused)
  assert.equal(state.mechanics.campaign_lifecycle.status, 'paused')
  assert.throws(() => assertCampaignPlayable(state), (error) => error.code === 'CAMPAIGN_PAUSED')

  state = applyGameEvent(state, lifecycleEventForAction('resume', state, { actorId: 'owner' }))
  assert.equal(state.mechanics.campaign_lifecycle.status, 'active')

  state = applyGameEvent(state, lifecycleEventForAction('complete', state, { actorId: 'owner' }))
  assert.equal(state.mechanics.campaign_lifecycle.status, 'completed')
  assert.match(state.mechanics.campaign_lifecycle.epilogue, /Предел зимы/u)
  assert.throws(() => assertCampaignPlayable(state), (error) => error.code === 'CAMPAIGN_READ_ONLY')

  state = applyGameEvent(state, lifecycleEventForAction('archive', state, { actorId: 'owner' }))
  assert.equal(state.mechanics.campaign_lifecycle.status, 'archived')
})

test('completion is rejected during combat and terminal transitions are irreversible', () => {
  const state = campaign()
  state.mechanics.combat.active = true
  assert.throws(() => lifecycleEventForAction('complete', state), (error) => error.code === 'CAMPAIGN_COMBAT_ACTIVE')
  state.mechanics.combat.active = false
  const completed = applyGameEvent(state, lifecycleEventForAction('complete', state))
  assert.throws(() => lifecycleEventForAction('resume', completed), (error) => error.code === 'INVALID_CAMPAIGN_TRANSITION')
})

test('legacy party defeat normalizes to failed and final hero death fails the campaign', () => {
  const legacy = normalizeCampaignLifecycle(null, 'party_defeated')
  assert.equal(legacy.status, 'failed')

  const failed = applyGameEvent(campaign(), {
    event_type: 'HeroDied',
    target_ids: ['hero'],
    payload: {},
    occurred_at: '2026-01-01T00:00:00.000Z',
  })
  assert.equal(failed.mechanics.death.campaign_status, 'party_defeated')
  assert.equal(failed.mechanics.campaign_lifecycle.status, 'failed')
  assert.equal(failed.mechanics.campaign_lifecycle.reason, 'party_final_death')
})

test('новая последняя смерть меняет lifecycle только через системный CampaignFailed', () => {
  const afterDeath = applyGameEvent(campaign(), {
    event_type: 'HeroDied',
    event_schema_version: 2,
    target_ids: ['hero'],
    payload: {},
  })
  assert.equal(afterDeath.mechanics.death.campaign_status, 'party_defeated')
  assert.equal(afterDeath.mechanics.campaign_lifecycle.status, 'active')
  assert.throws(
    () => lifecycleEventForAction('fail', afterDeath, { actorId: 'owner' }),
    (error) => error.code === 'CAMPAIGN_FAILURE_NOT_CONFIRMED',
  )

  const failure = lifecycleEventForAction('fail', afterDeath, {
    actorId: 'system',
    now: null,
  })
  assert.equal(failure.event_type, 'CampaignFailed')
  assert.match(failure.payload.epilogue, /поражением/iu)
  assert.ok(failure.payload.epilogue_fact_keys.includes('hero:hero'))
  const failed = applyGameEvent(afterDeath, failure)
  assert.equal(failed.mechanics.campaign_lifecycle.status, 'failed')
  assert.deepEqual(failed.mechanics.campaign_lifecycle.epilogue_fact_keys, failure.payload.epilogue_fact_keys)
})

test('deterministic epilogue uses committed campaign facts', () => {
  const epilogue = buildDeterministicEpilogue(campaign())
  assert.match(epilogue, /История «Предел зимы» завершена/u)
  assert.match(epilogue, /Последняя цель: Остановить бурю/u)
  assert.match(epilogue, /Северная башня/u)
  assert.match(epilogue, /В летописи мира остаются: Ада/u)
})

test('automatic completion requires climax and a fully resolved main thread', () => {
  const state = campaign()
  state.autonomy.pacing = { beat: 8, phase: 'climax', tension: 84 }
  state.worldMemory.quests = [{
    id: 'quest:storm', title: 'Остановить бурю', summary: 'Буря остановлена.',
    status: 'completed', visibility: 'party', entity_ids: [], objectives: [],
    clock: { current: 4, max: 4, label: 'Прогресс', triggered: true },
  }]
  assert.equal(campaignCanAutoComplete(state), true)
  state.worldMemory.quests.push({
    id: 'quest:chapter:1', title: 'Незавершённая сцена', summary: '',
    status: 'active', visibility: 'party', entity_ids: [], objectives: [],
    clock: { current: 1, max: 4, label: 'Прогресс', triggered: false },
  })
  assert.equal(campaignCanAutoComplete(state), true)
  state.worldMemory.quests[0].status = 'active'
  assert.equal(campaignCanAutoComplete(state), false)
})

test('вечерняя кампания завершается только после hard-боя в целевой сцене', () => {
  const state = campaign()
  const arc = buildCampaignArcPlan('lifecycle-evening-seed')
  state.campaignConcept = { arc }
  state.adventure.chapter = arc.target_scenes
  state.autonomy.pacing = { beat: 9, phase: 'climax', tension: 90 }
  state.worldMemory.quests = [{
    id: 'quest:storm', title: 'Остановить бурю', summary: 'Буря остановлена.',
    status: 'completed', visibility: 'party', entity_ids: [], objectives: [],
    clock: { current: arc.target_scenes, max: arc.target_scenes, label: 'Прогресс', triggered: true },
  }]
  state.mechanics.encounter = {
    id: 'encounter:climax',
    encounter_id: 'encounter:climax',
    status: 'ended',
    difficulty: 'hard',
    created_in_chapter: arc.target_scenes,
  }
  state.autonomy.encounter_outcomes = [{ encounter_id: 'encounter:climax', outcome: 'enemies_defeated' }]

  assert.equal(campaignCanAutoComplete(state), true)
  state.mechanics.encounter.created_in_chapter -= 1
  assert.equal(campaignCanAutoComplete(state), false, 'ранний бой не считается кульминацией')
  state.mechanics.encounter.created_in_chapter = arc.target_scenes
  state.mechanics.encounter.difficulty = 'medium'
  assert.equal(campaignCanAutoComplete(state), false, 'средний бой не считается кульминацией')
  state.mechanics.encounter.difficulty = 'hard'
  state.autonomy.encounter_outcomes = []
  assert.equal(campaignCanAutoComplete(state), false, 'без подтверждённого исхода финала нет')
})

test('epilogue brief contains only party-visible confirmed facts', () => {
  const state = campaign()
  state.worldMemory.facts = [
    { id: 'party-fact', subject_id: 'tower', summary: 'Башня устояла.', status: 'active', visibility: 'party' },
    { id: 'secret-fact', subject_id: 'storm', summary: 'Скрытый повелитель ещё жив.', status: 'active', visibility: 'gm_only' },
  ]
  const brief = buildEpilogueNarrationBrief(state)
  assert.match(JSON.stringify(brief), /Башня устояла/u)
  assert.doesNotMatch(JSON.stringify(brief), /Скрытый повелитель|secret-fact/u)
})

test('epilogue facts use stable keys for visible quests, promises, NPC fates, reputation and visited locations', () => {
  const state = richEpilogueCampaign()
  const facts = collectEpilogueFacts(state)
  const keys = new Set(facts.fact_keys)

  assert.equal(facts.outcome, 'completed')
  for (const key of [
    'hero:hero',
    'hero:bran',
    'quest:quest:storm',
    'quest:quest:evacuation',
    'promise:promise:map',
    'promise:promise:warning',
    'world_fact:fact:mira-fate',
    'world_fact:fact:tower',
    'reputation:faction:wardens',
    'location:location:tower',
    'location:location:ford',
  ]) assert.equal(keys.has(key), true, `missing visible epilogue fact ${key}`)

  assert.equal(facts.heroes.find((hero) => hero.hero_id === 'bran')?.status, 'dead')
  assert.equal(facts.quests.find((quest) => quest.quest_id === 'quest:storm')?.status, 'completed')
  assert.equal(facts.quests.find((quest) => quest.quest_id === 'quest:evacuation')?.status, 'failed')
  assert.equal(facts.promises.find((promise) => promise.promise_id === 'promise:map')?.status, 'fulfilled')
  assert.equal(facts.promises.find((promise) => promise.promise_id === 'promise:warning')?.status, 'broken')
  assert.equal(facts.npc_fates[0]?.fact_id, 'fact:mira-fate')
  assert.equal(facts.faction_reputations[0]?.tier, 'honoured')

  const serialized = JSON.stringify(facts)
  assert.doesNotMatch(serialized, /quest:hidden|Скрытая цель круга|quest:personal|Личная тайна/u)
  assert.doesNotMatch(serialized, /promise:personal|тайное имя|promise:hidden-npc|Вернуться за печатью/u)
  assert.doesNotMatch(serialized, /fact:mask-fate|Человек в маске|fact:personal|fact:legacy-hidden|Факт без видимости/u)
  assert.doesNotMatch(serialized, /faction:cabal|Тайный круг/u)
})

test('victory and defeat epilogues share the same visible fact ledger without leaking private history', () => {
  const victory = richEpilogueCampaign()
  const victoryFacts = collectEpilogueFacts(victory, { outcome: 'completed' })
  const victoryText = buildDeterministicEpilogue(victory, 'completed')
  const victoryBrief = buildEpilogueNarrationBrief(victory, { outcome: 'completed' })

  assert.equal(victoryFacts.outcome, 'completed')
  assert.match(victoryText, /Буря рассеялась|Мира пережила бурю|Показать карту старых троп/u)
  assert.deepEqual(victoryBrief.visible_state_changes[0].confirmed_fact_keys, victoryFacts.fact_keys)
  assert.equal(victoryBrief.visible_events.some((entry) => entry.payload?.quest_id === 'quest:storm'), true)
  assert.equal(victoryBrief.visible_events.some((entry) => entry.payload?.promise_id === 'promise:map'), true)
  assert.equal(victoryBrief.known_environment.confirmed_facts.some((fact) => fact.fact_id === 'fact:mira-fate'), true)

  const defeated = richEpilogueCampaign()
  defeated.mechanics.death.heroes.hero = {
    status: 'dead', resolution: null, died_at: '2026-01-01T00:05:00.000Z',
    resolved_at: null, replacement_name: null,
  }
  defeated.mechanics.death.campaign_status = 'party_defeated'
  defeated.mechanics.campaign_lifecycle.status = 'failed'
  const defeatFacts = collectEpilogueFacts(defeated)
  const defeatText = buildDeterministicEpilogue(defeated)
  const defeatBrief = buildEpilogueNarrationBrief(defeated)

  assert.equal(defeatFacts.outcome, 'failed')
  assert.equal(defeatFacts.heroes.every((hero) => hero.status === 'dead'), true)
  assert.match(defeatText, /завершилась поражением/u)
  assert.match(defeatText, /память о павших героях/u)
  assert.equal(defeatBrief.visible_state_changes[0].outcome, 'failed')
  assert.deepEqual(defeatBrief.visible_state_changes[0].confirmed_fact_keys, defeatFacts.fact_keys)

  for (const output of [victoryText, JSON.stringify(victoryBrief), defeatText, JSON.stringify(defeatBrief)]) {
    assert.doesNotMatch(output, /Тайное убежище|Круг готовит новый заговор|Личный сон Ады|Только Ада увидела знак/u)
    assert.doesNotMatch(output, /promise:personal|promise:hidden-npc|fact:mask-fate|fact:personal|faction:cabal/u)
  }
})
