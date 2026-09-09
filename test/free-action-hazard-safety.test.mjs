import assert from 'node:assert/strict'
import test from 'node:test'
import { bindFreeActionReadingToState, resolveHazardContact } from '../server/free-action-adjudication.mjs'
import { normalizeCampaignState } from '../server/rules-engine.mjs'
import { addProp, createTacticalMap, serializeTacticalMap, setEdge } from '../server/tactical-map.mjs'

function fixture({ wall = false, extinguished = false } = {}) {
  const map = createTacticalMap({ width: 3, height: 1, locationId: 'hazard-safety', seed: 'hazard-safety', fill: { passable: true, revealed: true, material: 'stone' } })
  addProp(map, { id: 'fire', assetId: 'campfire', x: 1.5, y: .5, footprint: [{ x: 1, y: 0 }] })
  if (wall) setEdge(map, 0, 0, 1, 0, { kind: 'wall', blocksMove: true, blocksSight: true })
  return normalizeCampaignState({
    players: [{ id: 'hero', character: 'Ада', hp: 20, maxHp: 20, x: 0, y: 0, inventory: [] }],
    scene: { location: 'Зал', cells: [], map: serializeTacticalMap(map) },
    mechanics: extinguished ? { scene_interactions: { fire: { state: 'extinguished' } } } : {},
  })
}

function contact(state, text, hazard = 'fire') {
  const reading = bindFreeActionReadingToState(state, 'hero', text, {
    activity_kind: 'stunt', skill: 'acrobatics', ability: 'dex', plausibility: 'strenuous',
    risk: 'minor', consequence_type: 'injury', hazard, effect: 'none',
  })
  return resolveHazardContact(state, 'hero', text, reading)
}

test('избегание огня, отрицание и положение рядом не означают намеренного самоурона', () => {
  const state = fixture()
  for (const text of ['Перепрыгиваю через костёр', 'Не касаюсь огня', 'Сажусь рядом с костром']) {
    assert.notEqual(contact(state, text)?.status, 'contact', text)
  }
})

test('стена и погасший огонь не позволяют подтвердить контакт с пламенем', () => {
  for (const options of [{ wall: true }, { extinguished: true }]) {
    assert.equal(contact(fixture(options), 'Сажусь в огонь')?.status, 'unavailable')
  }
})

test('слово «пару» не превращается в опасность горячего пара', () => {
  assert.equal(contact(fixture(), 'Прыгаю пару раз на месте', ''), null)
})
