import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { campaignStateForViewer, mechanicsForViewer } from '../server/viewer-projection.mjs'

const user = { role: 'player', heroIds: ['hero'] }
const effectId = 'longstrider:018a3368-9848-41a6-8351-84b2920a1058'
const condition = (source = 'hero') => ({ id: 'longstrider', spell_id: 'longstrider', effect_id: effectId, source_actor: source, started_at_seconds: 0, expires_at_seconds: 3600 })
function field() {
  return normalizeCampaignState({
    sessionCode: 'LONGSTRIDER-PROJECTION', activePlayerId: 'hero', partyMemberIds: ['hero'],
    players: [{ id: 'hero', character: 'Лира', hp: 10, maxHp: 10, speed: 30, x: 0, y: 0, inventory: [] }],
    actors: [{ id: 'hidden-summon', name: 'Скрытый призыв', kind: 'summon', visibility: 'gm_only', hp: 10, maxHp: 10, speed: 30, x: 1, y: 0 }],
    scene: { location: 'Трактир', location_id: 'inn', cells: [{ x: 0, y: 0, type: 'floor', revealed: true }, { x: 1, y: 0, type: 'floor', revealed: true }] },
    social: { npcs: [{ id: 'brom', name: 'Бром', location: 'Трактир', available: true, visibility: 'party' }] },
    npc_world: { placements: [{ npc_id: 'brom', location_id: 'inn', x: 1, y: 0 }] },
    mechanics: { world_time: { elapsed_minutes: 0 }, conditions: { hero: [condition('hidden-summon')], 'hidden-summon': [condition()], brom: [condition()] } },
    battleLog: [{ id: 'mixed', type: 'spell', actorId: 'hero', targetId: 'hidden-summon', targetIds: ['hidden-summon', 'hero', 'brom'], spellId: 'longstrider' },
      { id: 'hidden', type: 'spell', actorId: 'hidden-summon', targetId: 'hidden-summon', targetIds: ['hidden-summon'], spellId: 'longstrider' }],
  })
}

test('Скороход не раскрывает скрытого владельца, источник или цель через условия, movement и журнал', () => {
  const state = field()
  const before = structuredClone(state)
  const view = campaignStateForViewer(state, user, 'hero')
  assert.deepEqual(view.actors, [])
  assert.deepEqual(Object.keys(view.mechanics.movement), ['hero'])
  assert.equal(view.mechanics.conditions['hidden-summon'], undefined)
  assert.equal(view.mechanics.conditions.hero[0].source_actor, undefined)
  assert.equal(view.mechanics.conditions.hero[0].effect_id, effectId, 'непрозрачный ID инстанса сохраняется для стабильного представления')
  assert.equal(view.mechanics.movement.hero.effects[0].effect_id, effectId)
  assert.equal(JSON.stringify(view.mechanics.movement).includes('hidden-summon'), false)
  assert.deepEqual(view.battleLog.map((entry) => entry.id), ['mixed'])
  assert.equal(view.battleLog[0].targetId, 'hero')
  assert.deepEqual(view.battleLog[0].targetIds, ['hero', 'brom'])
  assert.deepEqual(state, before, 'проекция не меняет сохранённые эффекты и журнал')
})

test('уход NPC в другую сцену скрывает его эффект; возвращение показывает прежний инстанс', () => {
  const state = field()
  assert.equal(campaignStateForViewer(state, user, 'hero').mechanics.conditions.brom[0].effect_id, effectId)
  state.scene.location_id = 'road'
  state.scene.location = 'Дорога'
  assert.equal(campaignStateForViewer(state, user, 'hero').mechanics.conditions.brom, undefined)
  assert.equal(state.mechanics.conditions.brom[0].effect_id, effectId)
  state.scene.location_id = 'inn'
  state.scene.location = 'Трактир'
  assert.equal(campaignStateForViewer(state, user, 'hero').mechanics.conditions.brom[0].effect_id, effectId)
})

test('канал HTTP механики снимает скрытые ID со смешанного наложения и исключает полностью скрытое', () => {
  const state = field()
  const events = [
    { event_id: 'mixed', event_type: 'SpellCast', actor_id: 'hero', target_ids: ['hidden-summon', 'brom'], payload: { spell_id: 'longstrider', target_id: 'hidden-summon' } },
    { event_id: 'hidden', event_type: 'SpellCast', actor_id: 'hidden-summon', target_ids: ['hidden-summon'], payload: { spell_id: 'longstrider' } },
    { event_id: 'hidden-condition', event_type: 'ConditionAdded', actor_id: 'hero', target_ids: ['hidden-summon'], payload: { condition: 'longstrider', effect_id: effectId, source_actor: 'hero' } },
    { event_id: 'visible-condition', event_type: 'ConditionAdded', actor_id: 'hidden-summon', target_ids: ['hero'], payload: { condition: 'longstrider', effect_id: effectId, source_actor: 'hidden-summon' } },
  ]
  const before = structuredClone(events)
  const projected = mechanicsForViewer(events, user, 'hero', state)
  assert.deepEqual(projected.map((event) => event.event_id), ['mixed', 'visible-condition'])
  assert.deepEqual(projected[0].target_ids, ['brom'])
  assert.equal(projected[0].payload.target_id, undefined)
  assert.equal(projected[1].actor_id, undefined)
  assert.equal(projected[1].payload.source_actor, undefined)
  assert.equal(JSON.stringify(projected).includes('hidden-summon'), false)
  assert.deepEqual(events, before)
})

test('видимый кастер с отфильтрованными целями сохраняет пустой список, без ложного эффекта на себе', () => {
  const state = field()
  state.battleLog = [{ id: 'empty-targets', type: 'spell', actorId: 'hero', targetId: 'hidden-summon', targetIds: ['hidden-summon'], spellId: 'longstrider' }]
  const view = campaignStateForViewer(state, user, 'hero')
  assert.deepEqual(view.battleLog[0].targetIds, [])
  assert.equal(view.battleLog[0].targetId, undefined)
  assert.equal(view.battleLog[0].actorId, 'hero')
})
