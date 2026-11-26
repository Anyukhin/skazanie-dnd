import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveCommand, replayEvents } from '../server/rules-engine.mjs'
import { canonicalCombatSpellFor } from '../server/combat-spells.mjs'
import { spellRuntimeFixture } from '../eval/spell-runtime-audit.mjs'
import { deserializeTacticalMap, serializeTacticalMap, setEdge } from '../server/tactical-map.mjs'
import { DiceService } from '../server/dice-service.mjs'

const authoritative = command => ({ ...command, server_authoritative: true })
const dice = () => new DiceService({ rng: { randint: (min, max) => min }, idFactory: (() => { let n = 0; return () => `party-buff-${++n}` })(), now: () => '2026-01-01T00:00:00.000Z' })

test('Ускорение даёт преимущество только на спасброске Ловкости', () => {
  const dex = spellRuntimeFixture('acid-splash')
  dex.state.mechanics.conditions.enemy = [{ id: 'hasted' }]
  const result = resolveCommand(authoritative({ ...dex.command, target_id: 'enemy' }), dex.state, {
    diceService: dice(),
    context: { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] },
  })
  const save = result.events.find(event => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(save?.payload.ability, 'dex')
  assert.equal(save?.payload.save_advantage_condition, 'hasted')

  const wisdom = spellRuntimeFixture('dissonant-whispers')
  wisdom.state.mechanics.conditions.enemy = [{ id: 'hasted' }]
  const other = resolveCommand(authoritative({ ...wisdom.command, target_id: 'enemy' }), wisdom.state, {
    diceService: dice(),
    context: { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] },
  })
  const otherSave = other.events.find(event => event.event_type === 'SpellSavingThrowResolved')
  assert.equal(otherSave?.payload.ability, 'wis')
  assert.equal(otherSave?.payload.save_advantage_condition ?? null, null)
})

test('Множественное лечащее слово требует линию обзора для каждой выбранной цели', () => {
  const fixture = spellRuntimeFixture('mass-healing-word')
  const map = deserializeTacticalMap(fixture.state.scene.map)
  setEdge(map, 2, 2, 2, 3, { kind: 'wall', blocksMove: true, blocksSight: true })
  fixture.state.scene.map = serializeTacticalMap(map)
  fixture.state.scene.cells = []
  const command = authoritative({ ...fixture.command, target_ids: ['caster', 'ally'], target_id: undefined })
  const result = resolveCommand(command, fixture.state, {
    diceService: dice(),
    context: { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] },
  })
  const healed = result.events.filter(event => event.event_type === 'HealingApplied').map(event => event.target_ids[0])
  assert.deepEqual(healed, ['caster'])
})

