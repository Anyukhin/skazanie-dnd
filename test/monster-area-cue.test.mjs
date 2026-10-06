import assert from 'node:assert/strict'
import test from 'node:test'

import { compileClientModules } from './kit/client-ts.mjs'

// Дыхание дракона и другие области существ приходят в хронике строкой
// `area-attack` с источником и направлением; доска рисует их той же вспышкой,
// что и заклинания, в цвете вида урона.
const { modules: [animation] } = await compileClientModules(['src/combat-animation.ts'])

const breath = {
  id: 'log-1', type: 'area-attack', actorId: 'astohan-sargat', actorKind: 'enemy', itemName: 'Огненное дыхание',
  from: { x: 6, y: 2 }, area: { x: 4, y: 2, radiusFeet: 30, shape: 'cone' }, targetIds: ['hero'], damageType: 'fire', ability: 'dex',
}

test('дыхание конусом становится вспышкой от дракона к цели', () => {
  const [cue] = animation.combatAnimationCuesFromBattleLog([breath])
  assert.equal(cue.kind, 'burst')
  assert.equal(cue.shape, 'cone')
  assert.equal(cue.originMode, 'self')
  assert.deepEqual(cue.origin, { x: 6, y: 2 })
  assert.deepEqual(cue.center, { x: 4, y: 2 })
  assert.equal(cue.sizeFeet, 30)
  assert.equal(cue.damageType, 'fire')
  assert.deepEqual(cue.targetIds, ['hero'])
})

test('взмах крыльев кругом — вспышка вокруг существа', () => {
  const [cue] = animation.combatAnimationCuesFromBattleLog([{ ...breath, id: 'log-2', itemName: 'Взмах крыльев', area: { x: 6, y: 2, radiusFeet: 10, shape: 'sphere' }, damageType: 'bludgeoning' }])
  assert.equal(cue.shape, 'sphere')
  assert.equal(cue.originMode, 'point')
})

test('без источника (туман или старая запись, вещь героя) вспышки нет', () => {
  const { from: _from, ...hidden } = breath
  assert.deepEqual(animation.combatAnimationCuesFromBattleLog([{ ...hidden, area: undefined }]), [])
  assert.deepEqual(animation.combatAnimationCuesFromBattleLog([{ id: 'item', type: 'area-attack', actorId: 'hero', actorKind: 'player', itemName: 'Граната', area: { x: 3, y: 3, radiusFeet: 10 } }]), [])
})

test('живое событие даёт ту же вспышку и с тем же id, что и строка хроники', () => {
  const event = {
    event_id: 'log-1', event_type: 'LegendaryActionUsed', actor_id: 'astohan-sargat', target_ids: ['astohan-sargat'],
    payload: { action_id: 'fire-breath', name: 'Огненное дыхание', area: { shape: 'cone', from: { x: 6, y: 2 }, to: { x: 4, y: 2 }, size_feet: 30, damage_type: 'fire', target_ids: ['hero'] } },
  }
  const [live] = animation.combatAnimationCuesFromEvents([event])
  const [logged] = animation.combatAnimationCuesFromBattleLog([breath])
  assert.equal(live.id, logged.id, 'один id — одна вспышка, а не две')
  for (const key of ['kind', 'shape', 'originMode', 'sizeFeet', 'damageType']) assert.equal(live[key], logged[key], key)
  assert.deepEqual([live.origin, live.center, live.targetIds], [logged.origin, logged.center, logged.targetIds])
  // Событие без области (туман срезал её в проекции) вспышки не даёт.
  assert.deepEqual(animation.combatAnimationCuesFromEvents([{ ...event, payload: { action_id: 'fire-breath' } }]).filter((cue) => cue.kind === 'burst'), [])
})
