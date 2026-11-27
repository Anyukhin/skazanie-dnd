import assert from 'node:assert/strict'
import test from 'node:test'
import { applyGameEvent, normalizeCampaignState } from '../server/rules-engine.mjs'
import { basicFixture, basicRun } from './basic-spell-fixture.mjs'

// Редакция 2024: за ход тратится только одна ячейка заклинания. Найдено в
// боевом плейтесте 2026-10-03: жрец творил «Направляющий снаряд» действием и
// «Лечащее слово» бонусным действием одним ходом.

// Двойка помещается в любую кость, от к4 лечения до к20 спасброска.
const DICE = Array(12).fill(2)
const fixture2024 = () => normalizeCampaignState({
  ...basicFixture({ combat: true }),
  ruleset_id: 'srd_5_2_1',
  ruleset_version: '5.2.1',
  enabled_rule_packs: ['srd_5_2_1'],
  enabled_house_rules: [],
})
const cast = (state, id, target) => basicRun(state, { command_type: 'CastSpell', spell_id: id, target_id: target, target_ids: [target] }, DICE)
const apply = (state, result) => result.events.reduce(applyGameEvent, state)
const spellCast = (result) => result.events.find((event) => event.event_type === 'SpellCast')

test('2024: вторая ячейка за ход отклоняется, а состояние не меняется', () => {
  const state = fixture2024()
  const first = cast(state, 'inflict-wounds', 'enemy')
  assert.equal(spellCast(first).payload.slot_spell_2024_version, 1)
  const after = apply(state, first)
  assert.equal(after.mechanics.combat.action_economy.caster.slot_spell_cast_2024, true)
  const before = JSON.stringify(after)
  assert.throws(() => cast(after, 'healing-word', 'ally'), (error) => error.code === 'ONE_SPELL_SLOT_PER_TURN')
  assert.equal(JSON.stringify(after), before)
})

test('2024: порядок не важен — после бонусного заклинания с ячейкой действие с ячейкой тоже запрещено', () => {
  const state = fixture2024()
  const healed = apply(state, cast(state, 'healing-word', 'ally'))
  assert.throws(() => cast(healed, 'inflict-wounds', 'enemy'), (error) => error.code === 'ONE_SPELL_SLOT_PER_TURN')
})

test('2024: заговор ячейку не тратит и после заклинания с ячейкой разрешён', () => {
  const state = fixture2024()
  const healed = apply(state, cast(state, 'healing-word', 'ally'))
  const flame = cast(healed, 'sacred-flame', 'enemy')
  assert.ok(spellCast(flame))
  assert.equal(spellCast(flame).payload.slot_spell_2024_version, undefined)
})

test('replay старых событий без метки не запрещает вторую ячейку задним числом', () => {
  const state = fixture2024()
  const legacy = cast(state, 'inflict-wounds', 'enemy').events.map((event) => {
    if (event.event_type !== 'SpellCast') return event
    const { slot_spell_2024_version: _version, ...payload } = event.payload
    return { ...event, payload }
  })
  const replayed = legacy.reduce(applyGameEvent, state)
  assert.equal(replayed.mechanics.combat.action_economy.caster.slot_spell_cast_2024, undefined)
  assert.ok(spellCast(cast(replayed, 'healing-word', 'ally')))
})

test('редакция 2014 живёт по своему правилу и метку 2024 не пишет', () => {
  const state = basicFixture({ combat: true })
  const first = cast(state, 'inflict-wounds', 'enemy')
  assert.equal(spellCast(first).payload.slot_spell_2024_version, undefined)
})
