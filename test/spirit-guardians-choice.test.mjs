import assert from 'node:assert/strict'
import test from 'node:test'

import { spellRuntimeFixture } from '../eval/spell-runtime-audit.mjs'
import { applyGameEvent, resolveCommand } from '../server/rules-engine.mjs'
import { DiceService } from '../server/dice-service.mjs'

function cast(option) {
  const { state, command } = spellRuntimeFixture('spirit-guardians')
  command.server_authoritative = true
  command.spell_option = option
  return resolveCommand(command, state, {
    diceService: new DiceService({ rng: { randint: (min) => min } }),
    context: { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] },
  })
}

test('Духовные стражи позволяют выбрать излучение или некротическую энергию при создании ауры', () => {
  for (const option of ['radiant', 'necrotic']) {
    const result = cast(option)
    const castEvent = result.events.find(event => event.event_type === 'SpellCast')
    const area = result.events.find(event => event.event_type === 'SpellAreaCreated')
    assert.equal(castEvent.payload.damage_type, option)
    assert.equal(castEvent.payload.spell_option, option)
    assert.equal(area.payload.effect.damage_type, option)
    assert.ok(area.payload.effect.trigger_on_turn_start)
    assert.ok(area.payload.effect.follows_source)
  }
})

test('Духовные стражи отклоняют неподдержанный тип выбора', () => {
  assert.throws(() => cast('fire'), error => error.code === 'SPELL_OPTION_REQUIRED')
})

test('Выбранный тип урона сохраняется при replay', () => {
  const { state, command } = spellRuntimeFixture('spirit-guardians')
  command.server_authoritative = true
  command.spell_option = 'necrotic'
  const result = resolveCommand(command, state, {
    diceService: new DiceService({ rng: { randint: (min) => min } }),
    context: { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] },
  })
  const replayed = result.events.reduce(applyGameEvent, structuredClone(state))
  assert.equal(replayed.mechanics.active_effects[0].damage_type, 'necrotic')
})
