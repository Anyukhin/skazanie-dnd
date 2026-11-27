import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CampaignControlError,
  campaignRewindEvent,
  planCampaignControl,
} from '../server/campaign-controls.mjs'

function event(version, eventType, commandId, payload = {}) {
  return {
    event_id: `${commandId}:${version}`,
    command_id: commandId,
    idempotency_key: commandId,
    event_type: eventType,
    state_version_before: version - 1,
    state_version_after: version,
    payload,
  }
}

test('откат хода возвращает состояние до всей последней команды, а не до одного события', () => {
  const plan = planCampaignControl({
    action: 'rewind_turn',
    currentVersion: 6,
    events: [
      event(1, 'LegacyStateImported', 'bootstrap'),
      event(2, 'SceneAdvanced', 'scene-2'),
      event(3, 'NarrativeSummaryRecorded', 'scene-2'),
      event(4, 'AttackResolved', 'turn-1'),
      event(5, 'DamageApplied', 'turn-1'),
      event(6, 'MovementResolved', 'turn-2'),
    ],
  })
  assert.equal(plan.targetVersion, 5)
  assert.equal(plan.commandId, 'turn-2')
  assert.deepEqual(plan.revertedEventTypes, ['MovementResolved'])
})

test('переигрывание сцены сохраняет сам переход и отменяет только действия после него', () => {
  const plan = planCampaignControl({
    action: 'replay_scene',
    currentVersion: 7,
    events: [
      event(1, 'LegacyStateImported', 'bootstrap'),
      event(2, 'SceneAdvanced', 'scene-2'),
      event(3, 'NarrativeSummaryRecorded', 'scene-2'),
      event(4, 'MerchantCreated', 'scene-2'),
      event(5, 'MovementResolved', 'turn-1'),
      event(6, 'AttackResolved', 'turn-2'),
      event(7, 'DamageApplied', 'turn-2'),
    ],
  })
  assert.equal(plan.targetVersion, 4)
  assert.deepEqual(plan.revertedEventTypes, ['MovementResolved', 'AttackResolved', 'DamageApplied'])
})

test('откат не пересекает смену арки или финал кампании', () => {
  assert.throws(
    () => planCampaignControl({
      action: 'rewind_turn',
      currentVersion: 3,
      events: [
        event(1, 'LegacyStateImported', 'bootstrap'),
        event(2, 'AttackResolved', 'old-arc-turn'),
        event(3, 'CampaignArcCompleted', 'arc-transition'),
      ],
    }),
    (error) => error instanceof CampaignControlError && error.code === 'NOTHING_TO_REWIND',
  )
  assert.throws(
    () => planCampaignControl({
      action: 'replay_scene',
      currentVersion: 2,
      events: [
        event(1, 'LegacyStateImported', 'bootstrap'),
        event(2, 'CampaignCompleted', 'finale'),
      ],
    }),
    (error) => error instanceof CampaignControlError && error.code === 'NOTHING_TO_REPLAY',
  )
})

test('цепочка CampaignRewound не возвращает уже отменённую ветвь в действующую историю', () => {
  const firstPlan = planCampaignControl({
    action: 'rewind_turn',
    currentVersion: 5,
    events: [
      event(1, 'LegacyStateImported', 'bootstrap'),
      event(2, 'SceneAdvanced', 'scene'),
      event(3, 'MovementResolved', 'turn-1'),
      event(4, 'AttackResolved', 'turn-2'),
      event(5, 'CampaignRewound', 'rewind-1', { target_version: 3 }),
    ],
  })
  assert.equal(firstPlan.targetVersion, 2)
  assert.equal(firstPlan.commandId, 'turn-1')
})

test('событие отката несёт целевое состояние, но сохраняет паузу и настройку цепочки арок', () => {
  const rewind = campaignRewindEvent({
    action: 'rewind_turn',
    targetVersion: 12,
    actorId: 'owner',
    occurredAt: '2026-07-31T00:00:00.000Z',
    targetState: {
      state_version: 12,
      isNarrating: true,
      mechanics: { campaign_lifecycle: { status: 'active' }, combat: { active: false } },
      campaignConcept: { arc_chain: false, title: 'Старая арка' },
    },
    currentState: {
      state_version: 20,
      mechanics: { campaign_lifecycle: { status: 'paused', reason: 'manual' } },
      campaignConcept: { arc_chain: true },
    },
  })
  assert.equal(rewind.event_type, 'CampaignRewound')
  assert.equal(rewind.payload.target_version, 12)
  assert.equal(rewind.payload.rewound_from_version, 20)
  assert.equal(rewind.payload.state.isNarrating, false)
  assert.equal(rewind.payload.state.mechanics.campaign_lifecycle.status, 'paused')
  assert.equal(rewind.payload.state.campaignConcept.arc_chain, true)
})
