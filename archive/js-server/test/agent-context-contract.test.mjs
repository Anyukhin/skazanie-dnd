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

test('контекст сцены несёт, что карта мира обещает об этом месте', async () => {
  // Замеры 11–18 (2026-10-11): «маяк, чей свет вновь замечают по ночам», а
  // на «загорится ли огонь?» ведущий отвечал «в темноте не видно».
  const { sceneContextForAgent } = await import('../server/agent-context.mjs')
  const state = {
    scene: { title: 'Свет над скалой', location: 'Заброшенный маяк' },
    worldMap: { currentLocationId: 'lh', locations: [{ id: 'lh', name: 'Заброшенный маяк', summary: 'Маяк на скале, чей свет вновь замечают по ночам.', known: true }] },
  }
  assert.equal(sceneContextForAgent(state).place_summary, 'Маяк на скале, чей свет вновь замечают по ночам.')
  assert.equal(sceneContextForAgent({ scene: state.scene }).place_summary, undefined)
})

test('сводка поля: кто где стоит, в каком состоянии и кто рядом — без чисел и скрытых врагов', async () => {
  // Замеры 27–31 (2026-10-11): рассказчик знал только, где стоит сам
  // действующий, — описывал очаг и свечи, когда отряд стоял на причале.
  const { fieldSummaryFor } = await import('../server/agent-context.mjs')
  const { setCell } = await import('../server/tactical-map.mjs')
  const map = createTacticalMap({ width: 6, height: 3, locationId: 'pier', seed: 'field', sizeClass: 'arena' })
  addZone(map, { id: 'pier', kind: 'exterior', material: 'wood', lightLevel: 'dim', floorDirection: 'horizontal', label: 'Причал' })
  addZone(map, { id: 'hall', kind: 'interior', material: 'wood', lightLevel: 'bright', floorDirection: 'horizontal', label: 'Общий зал' })
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 6; x += 1) setCell(map, x, y, { passable: true, revealed: x < 5, zone: x < 3 ? 'pier' : 'hall' })
  const state = normalizeCampaignState({
    scene: { title: 'Причал', location: 'Серый Причал', location_id: 'pier', map: serializeTacticalMap(map) },
    players: [
      { id: 'mirel', character: 'Мирель', hp: 20, maxHp: 20, x: 0, y: 1 },
      { id: 'borin', character: 'Борин', hp: 9, maxHp: 31, x: 1, y: 1 },
    ],
    enemies: [
      { id: 'cult', name: 'Культист 1', hp: 3, maxHp: 9, alive: true, x: 2, y: 1 },
      { id: 'hidden', name: 'Культист 2', hp: 9, maxHp: 9, alive: true, x: 5, y: 1 },
    ],
    mechanics: { combat: { active: true }, positions: { mirel: { x: 0, y: 1 }, borin: { x: 1, y: 1 }, cult: { x: 2, y: 1 }, hidden: { x: 5, y: 1 } } },
  })
  const field = fieldSummaryFor(state)
  assert.deepEqual(field.heroes.map((hero) => [hero.name, hero.area, hero.indoors, hero.condition]), [['Мирель', 'Причал', false, 'цел'], ['Борин', 'Причал', false, 'тяжело ранен']])
  assert.deepEqual(field.heroes[1].next_to, ['Мирель', 'Культист 1'])
  assert.deepEqual(field.enemies.map((enemy) => [enemy.name, enemy.condition]), [['Культист 1', 'тяжело ранен']], 'враг на нераскрытой клетке не называется')
  assert.doesNotMatch(JSON.stringify(field), /\d+\s*\/\s*\d+|"hp"/u, 'чисел здоровья нет')
  assert.ok(sceneContextForAgent(state, 'borin').field, 'сводка уходит рассказчику')
})
