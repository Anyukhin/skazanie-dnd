import assert from 'node:assert/strict'
import test from 'node:test'

import { sceneContextForAgent } from '../server/agent-context.mjs'
import { AutonomousCampaignOrchestrator } from '../server/autonomous-orchestrator.mjs'
import { interpretFreeAction } from '../server/free-action-adjudication.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { addProp, addZone, createTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'

function mapState({ props = true } = {}) {
  const map = createTacticalMap({
    width: 20, height: 2, locationId: 'hall', seed: 'agent-context',
    fill: { passable: true, revealed: true, material: 'stone' },
  })
  addZone(map, { id: 'hall', label: 'Зал', kind: 'interior' })
  if (props) for (let index = 0; index < 17; index += 1) {
    addProp(map, {
      id: `table-${index}`, assetId: 'table_long', x: index + .5, y: .5,
      footprint: [{ x: index, y: 0 }],
      ...(index === 16 ? { visibility: 'gm_only' } : {}),
    })
  }
  return {
    sessionCode: 'CONTEXT-1', state_version: 7,
    scene: { title: 'Зал', location: 'Зал', location_id: 'hall', map: serializeTacticalMap(map) },
    players: [{ id: 'hero', character: 'Ада', x: 0, y: 0 }],
    mechanics: { positions: { hero: { x: 0, y: 0 } } },
  }
}

test('контекст карты сохраняет ID видимых пропсов и обозначает усечение после visibility-фильтра', () => {
  const context = sceneContextForAgent(mapState(), 'hero')
  assert.deepEqual(context.spatial_context.objects.map((entry) => entry.id), Array.from({ length: 16 }, (_, index) => `table-${index}`))
  assert.equal(context.spatial_context.objects_status, 'truncated')
  assert.equal(context.spatial_context.objects_complete_within_scope, false)
  assert.equal(context.spatial_context.objects_truncation_reason, 'item_limit')
  assert.doesNotMatch(JSON.stringify(context), /table-16|gm_only/u)
  assert.deepEqual(context.context_metadata, {
    role: 'scene_context', actor_id: 'hero', target_id: null, campaign_id: 'CONTEXT-1',
    state_version: 7, contract_version: 'scene-context/v2', schema_version: 1,
  })
})

test('пустая и недоступная карта не смешиваются', () => {
  const empty = sceneContextForAgent(mapState({ props: false }), 'hero').spatial_context
  assert.equal(empty.objects_status, 'empty')
  assert.equal(empty.objects_complete_within_scope, true)

  const broken = sceneContextForAgent({ scene: { title: 'Зал', map: { width: 3, height: 3, layers: { present: 'broken' } } } }, 'hero').spatial_context
  assert.equal(broken.objects_status, 'unavailable')
  assert.equal(broken.objects_complete_within_scope, null)
  assert.equal(broken.objects_truncation_reason, 'source_unavailable')
})

test('прочтение свободного действия отклоняется, если состояние изменилось во время ответа агента', async () => {
  let stateVersion = 0
  let commits = 0
  const initial = normalizeCampaignState({
    sessionCode: 'STALE-1', partyMemberIds: ['hero'], activePlayerId: 'hero',
    players: [{ id: 'hero', character: 'Ада', hp: 10, maxHp: 10, armor: 10, speed: 30, x: 0, y: 0 }],
    scene: { title: 'Зал', location: 'Зал', objective: 'Осмотреться', cells: [{ x: 0, y: 0, type: 'floor', revealed: true }] },
    mechanics: { combat: { active: false }, world_time: { elapsed_minutes: 0 } },
  })
  const eventStore = {
    async getByIdempotencyKey() { return null },
    async load() { return { state: { ...structuredClone(initial), state_version: stateVersion }, state_version: stateVersion } },
    async commit() { commits += 1; throw new Error('commit не должен быть вызван') },
  }
  const actionAdjudicator = {
    llmClient: { completeJson: async () => ({}) },
    async read(_state, _actorId, text, fallback) {
      stateVersion = 1
      return { ...interpretFreeAction(text), ...fallback }
    },
  }
  const orchestrator = new AutonomousCampaignOrchestrator({
    eventStore, rulesEngine: {}, actionAdjudicator,
  })
  const result = await orchestrator.handleUnknownAction({
    campaignId: 'STALE-1', playerId: 'hero', action: 'Кувыркаюсь на месте',
    idempotencyKey: 'stale-action', intent: { free_action_kind: 'generic' },
  })
  assert.equal(result.kind, 'clarification')
  assert.match(result.narration, /Обстановка изменилась/u)
  assert.equal(result.state_version, 1)
  assert.equal(result.context_metadata.state_version, 0)
  assert.equal(commits, 0)
})
