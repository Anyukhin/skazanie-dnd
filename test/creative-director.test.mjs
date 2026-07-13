import assert from 'node:assert/strict'
import test from 'node:test'

import { CreativeDirector, criticalMomentFor } from '../server/creative-director.mjs'

const state = {
  scene: { title: 'Зал', location: 'Крепость', mood: 'Гулкий камень', objective: 'Выстоять' },
  players: [{ id: 'hero', character: 'Лира' }],
  enemies: [{ id: 'guard', name: 'Страж', hp: 0, maxHp: 12, alive: false }],
  actors: [],
}

test('creative director is completely bypassed for movement and ordinary attacks', async () => {
  let calls = 0
  const director = new CreativeDirector({ narrator: { render: async () => { calls += 1; return { narration: 'unexpected' } } } })
  const events = [
    { event_type: 'ActorMoved', actor_id: 'hero', target_ids: ['hero'], payload: { distance: 10 }, visibility: 'public' },
    { event_type: 'AttackResolved', actor_id: 'hero', target_ids: ['guard'], payload: { total: 14, armor_class: 12, hit: true }, visibility: 'public' },
  ]
  assert.equal(criticalMomentFor(events, state), null)
  assert.equal(await director.renderCriticalMoment({ events, state }), null)
  assert.equal(calls, 0)
})

test('enemy death invokes creative narration only after the mechanical event is committed', async () => {
  let calls = 0
  const director = new CreativeDirector({ narrator: { render: async (brief) => {
    calls += 1
    assert.equal(brief.known_environment.critical_moment.kind, 'enemy_defeated')
    return { narration: 'Страж оседает у расколотой колонны.', provider: 'fake-agent', verification: { valid: true }, suggestions: [] }
  } } })
  const events = [{ event_type: 'HitPointsReducedToZero', actor_id: 'hero', target_ids: ['guard'], payload: { hp_after: 0 }, visibility: 'public' }]
  const result = await director.renderCriticalMoment({ events, state, viewer: { playerId: 'hero', partyIds: ['hero'], isPartyMember: true } })
  assert.equal(calls, 1)
  assert.equal(result.trigger.kind, 'enemy_defeated')
  assert.match(result.narration, /Страж/u)
})
