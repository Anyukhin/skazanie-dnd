import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertCampaignPlayable,
  buildEpilogueNarrationBrief,
  buildDeterministicEpilogue,
  campaignCanAutoComplete,
  lifecycleEventForAction,
  normalizeCampaignLifecycle,
} from '../server/campaign-lifecycle.mjs'
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

test('deterministic epilogue uses committed campaign facts', () => {
  assert.equal(
    buildDeterministicEpilogue(campaign()),
    'История «Предел зимы» завершена. Последняя цель: Остановить бурю. Финальная глава развернулась в месте «Северная башня». В летописи мира остаются: Ада.',
  )
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
