import assert from 'node:assert/strict'
import test from 'node:test'

import { spellRuntimeFixture } from '../eval/spell-runtime-audit.mjs'
import { canonicalCombatSpellFor } from '../server/combat-spells.mjs'
import { auditSpellOverrides } from '../server/spell-override-audit.mjs'
import { DiceService } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand } from '../server/rules-engine.mjs'

// Данные заклинаний D&D 2014, которые карточка обещает, а профиль не задавал:
// усиление ячейкой, срок призыва и области, половина урона при успехе,
// невосприимчивость по типу существа.

const context = { serverAuthoritativeCombat: true, allowedActorIds: ['caster'] }
const dice = (mode = 'high') => new DiceService({ rng: { randint: (min, max) => (mode === 'low' ? min : max) } })

function cast(spellId, patch = {}, { mode = 'high', mutate } = {}) {
  const { state, command } = spellRuntimeFixture(spellId)
  state.scene.cells = Array.from({ length: 400 }, (_, index) => ({ x: index % 20, y: Math.floor(index / 20), type: 'floor', revealed: true }))
  mutate?.(state)
  const result = resolveCommand({ ...command, ...patch, server_authoritative: true }, state, { diceService: dice(mode), context })
  return { state, events: result.events, after: result.events.reduce(applyGameEvent, state) }
}
const rolled = (events, purpose) => events.find((event) => event.event_type === 'DieRolled' && String(event.payload.purpose).startsWith(purpose))?.payload.expression
const summons = (events) => events.filter((event) => event.event_type === 'SummonedCreatureCreated').map((event) => event.payload.summon)

test('Усиление урона ячейкой задано там, где его обещает карточка', () => {
  assert.equal(rolled(cast('fireball', { slot_level: 5 }).events, 'spell_damage:fireball'), '10d6')
  assert.equal(rolled(cast('storm-sphere', { slot_level: 6 }).events, 'spell_damage:storm-sphere'), '4d6')
  assert.equal(rolled(cast('rime-s-binding-ice', { slot_level: 6 }).events, 'spell_damage:rime-s-binding-ice'), '7d8')
})

test('Отложенный урон растёт у Мельфовой стрелы и не растёт у Едкого шара', () => {
  const arrow = cast('melf-s-acid-arrow', { slot_level: 6 })
  assert.equal(arrow.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.recurring_damage)?.payload.recurring_damage, '6d4')
  const sphere = cast('vitriolic-sphere', { slot_level: 6, to: { x: 12, y: 2 } }, { mode: 'low', mutate: (state) => { state.mechanics.positions.enemy = { x: 12, y: 2 } } })
  assert.equal(rolled(sphere.events, 'spell_damage:vitriolic-sphere'), '14d4')
  assert.equal(sphere.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.recurring_damage)?.payload.recurring_damage, '5d4')
})

test('Исцеляющий дух на ячейке 4-го круга лечит 3к6', () => {
  const spirit = cast('healing-spirit', { slot_level: 4, to: { x: 6, y: 2 } })
  const area = spirit.after.mechanics.active_effects.find((effect) => effect.spell_id === 'healing-spirit')
  assert.equal(area.healing, '3d6')
})

test('Улучшение характеристики на 4-м круге принимает вторую цель', () => {
  const enhanced = cast('enhance-ability', { slot_level: 4, target_id: 'ally', target_ids: ['ally', 'caster'] })
  assert.equal(enhanced.events.filter((event) => event.event_type === 'ConditionAdded').length, 2)
})

test('Ослепляющая кара не усиливается: в редакции 2014 у неё нет усиления', () => {
  const profile = canonicalCombatSpellFor('blinding-smite', { rulesetId: 'dnd_5e_2014' })
  assert.equal(profile.upcastDicePerLevel, undefined)
  assert.equal(profile.higherLevels, null)
  assert.doesNotMatch(profile.description, /Ячейка выше/u)
})

test('Духи TCE растут с ячейкой, а число призванных — по множителю правила', () => {
  const [low] = summons(cast('summon-beast', { slot_level: 2, to: { x: 10, y: 10 } }).events)
  const [high] = summons(cast('summon-beast', { slot_level: 6, to: { x: 10, y: 10 } }).events)
  assert.ok(high.maxHp > low.maxHp && high.armor > low.armor)
  assert.notEqual(high.attack_profile.damage_expression, low.attack_profile.damage_expression)
  assert.equal(summons(cast('animate-objects', { slot_level: 6, to: { x: 10, y: 10 } }).events).length, 12)
  assert.equal(summons(cast('conjure-animals', { slot_level: 5, to: { x: 10, y: 10 } }).events).length, 16)
  assert.equal(summons(cast('conjure-woodland-beings', { slot_level: 6, to: { x: 10, y: 10 } }).events).length, 16)
  assert.equal(summons(cast('summon-lesser-demons', { slot_level: 3, to: { x: 10, y: 10 } }).events).length, 4)
  assert.equal(summons(cast('summon-lesser-demons', { slot_level: 6, to: { x: 10, y: 10 } }).events).length, 8)
})

test('Срок призыва и длящейся области соответствует карточке', () => {
  const lifetime = (spellId, patch) => {
    const { events } = cast(spellId, patch)
    const [summon] = summons(events)
    const startedAt = 0
    return summon.expires_at_seconds - startedAt
  }
  assert.equal(lifetime('mordenkainen-s-faithful-hound', { to: { x: 4, y: 4 } }), 8 * 3600)
  assert.equal(lifetime('summon-greater-demon', { to: { x: 4, y: 4 } }), 3600)
  assert.equal(lifetime('conjure-woodland-beings', { to: { x: 10, y: 10 } }), 3600)
  const guardians = cast('spirit-guardians')
  const area = guardians.after.mechanics.active_effects.find((effect) => effect.spell_id === 'spirit-guardians')
  assert.equal(area.expires_round - guardians.state.mechanics.combat.round, 100, '10 минут — сто раундов')
})

test('Половина урона при успешном спасброске у Враждебности и копья Раулотима', () => {
  for (const spellId of ['antagonize', 'raulothim-s-psychic-lance']) {
    const { events } = cast(spellId)
    const save = events.find((event) => event.event_type === 'SpellSavingThrowResolved')
    const damage = events.find((event) => event.event_type === 'DamageApplied')
    assert.equal(save.payload.saved, true, spellId)
    assert.ok(damage?.payload.applied_amount > 0, `${spellId}: половина урона при успехе`)
  }
})

test('Усыхание не действует на нежить и конструктов, лечащее слово отряда их не лечит', () => {
  for (const type of ['undead', 'construct']) {
    const blight = cast('blight', {}, { mode: 'low', mutate: (state) => { state.enemies[0].creature_type = type } })
    assert.equal(blight.events.some((event) => event.event_type === 'DamageApplied'), false, `Усыхание по ${type}`)
  }
  assert.ok(cast('blight', {}, { mode: 'low' }).events.some((event) => event.event_type === 'DamageApplied'), 'по живому существу бьёт')
  const word = cast('mass-healing-word', {}, { mutate: (state) => { state.players[1].creature_type = 'undead' } })
  assert.equal(word.events.some((event) => event.event_type === 'HealingApplied'), false)
})

test('Прежняя редакция не меняет срок призыва и иммунитеты 2014', () => {
  const { state, command } = spellRuntimeFixture('mass-healing-word')
  const legacy = normalizeCampaignState({ ...structuredClone(state), ruleset_id: 'srd_5_2_1', ruleset_version: undefined, enabled_house_rules: [] })
  legacy.players[1].creature_type = 'undead'
  const result = resolveCommand({ ...command, server_authoritative: true }, legacy, { diceService: dice(), context })
  assert.ok(result.events.some((event) => event.event_type === 'HealingApplied'), 'ограничение 2014 лежит в mechanics2014')
})

test('Духовное оружие добавляет модификатор и +1к8 за каждые два круга сверх второго', () => {
  const damage = (slot) => summons(cast('spiritual-weapon', { slot_level: slot, to: { x: 4, y: 4 } }).events)[0].attack_profile.damage_expression
  assert.equal(damage(2), '1d8+4')
  assert.equal(damage(3), '1d8+4')
  assert.equal(damage(4), '2d8+4')
  assert.equal(damage(6), '3d8+4')
})

test('Аудит перечисляет только известные пробелы усиления', () => {
  // Новое заклинание с обещанием усиления без поля попадёт сюда и уронит тест:
  // либо задать поле, либо осознанно объявить причину в аудите.
  assert.deepEqual(auditSpellOverrides().upcastGaps.map((gap) => gap.id).sort(), [
    'absorb-elements', 'ashardalon-s-stride', 'elemental-weapon', 'spirit-shroud',
  ])
})
