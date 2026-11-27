import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalCombatSpellFor, spellCatalogInfo } from '../server/combat-spells.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, resolveCommand, attackForecast } from '../server/rules-engine.mjs'

import { BASIC_IDS, basicFixture, basicRun } from './basic-spell-fixture.mjs'

const cast = (state, id, values = [], target = 'ally', extra = {}) => basicRun(state, { command_type: 'CastSpell', spell_id: id, target_id: target, target_ids: [target], ...extra }, values)
const apply = (state, result) => result.events.reduce(applyGameEvent, state)
const event = (result, type) => result.events.find(e => e.event_type === type)
const damage = result => event(result, 'DamageApplied')?.payload
const healing = result => event(result, 'HealingApplied')?.payload
function refused(state, command, code) { const before = JSON.stringify(state); assert.throws(() => basicRun(state, command), error => error.code === code, code); assert.equal(JSON.stringify(state), before) }

test('восемь профилей проверены именно в 2014; другая редакция остаётся partial', () => {
  for (const id of BASIC_IDS) {
    assert.equal(canonicalCombatSpellFor(id, { rulesetId: 'dnd_5e_2014' }).mechanicsSupport, 'verified', id)
    assert.equal(canonicalCombatSpellFor(id).mechanicsSupport, 'partial', id)
  }
  assert.equal(spellCatalogInfo({ rulesetId: 'dnd_5e_2014' }).verifiedMechanics, 8)
  assert.equal(spellCatalogInfo().verifiedMechanics, 0)
})

for (const [id, sides, type, characterClass] of [['poison-spray', 12, 'poison', 'wizard'], ['sacred-flame', 8, 'radiant', 'cleric']]) {
  for (const [level, count] of [[1, 1], [4, 1], [5, 2], [10, 2], [11, 3], [12, 3]]) test(`${id}: уровень ${level} даёт ${count}к${sides}, без ячейки`, () => {
    const state = basicFixture({ characterClass, level, combat: true })
    const result = cast(state, id, [...Array(count).fill(3), 1], 'enemy')
    assert.equal(damage(result).raw_amount, count * 3)
    assert.equal(damage(result).damage_type, type)
    assert.equal(result.events.filter(e => e.event_type === 'ResourceSpent').length, 0)
  })
  test(`${id}: успешный спасбросок полностью предотвращает урон`, () => {
    const result = cast(basicFixture({ characterClass, level: 1, combat: true }), id, [sides, 20], 'enemy')
    assert.equal(event(result, 'SpellSavingThrowResolved').payload.saved, true)
    assert.equal(damage(result)?.applied_amount ?? 0, 0)
  })
  test(`${id}: иммунитет, сопротивление и уязвимость считают настоящий тип`, () => {
    for (const [field, expected] of [['immunities', 0], ['resistances', 3], ['vulnerabilities', 14]]) {
      const state = basicFixture({ characterClass, level: 1, combat: true })
      state.mechanics.defenses.enemy = { [field]: [type] }
      assert.equal(damage(cast(state, id, [7, 1], 'enemy'))?.applied_amount ?? 0, expected, field)
    }
  })
}

test('Священное пламя игнорирует бонус укрытия к спасброску', () => {
  const state = basicFixture({ level: 1, combat: true })
  state.enemies[0].cover = 'three-quarters'
  const result = cast(state, 'sacred-flame', [4, 11], 'enemy')
  assert.equal(event(result, 'SpellSavingThrowResolved').payload.total, 11)
  assert.equal(event(result, 'SpellSavingThrowResolved').payload.saved, false)
})

for (const slot of [1, 2, 3, 4, 5, 6]) test(`Нанесение ран: ячейка ${slot}, ${slot + 2}к10 без модификатора`, () => {
  const result = cast(basicFixture({ combat: true }), 'inflict-wounds', [15, ...Array(slot + 2).fill(2)], 'enemy', { slot_level: slot })
  assert.equal(damage(result).raw_amount, (slot + 2) * 2)
  assert.equal(damage(result).damage_type, 'necrotic')
  assert.equal(event(result, 'ResourceSpent').payload.resource, `spell_slots_${slot}`)
})
test('Нанесение ран: крит удваивает кости, промах расходует ячейку и действие', () => {
  const state = basicFixture({ combat: true })
  assert.equal(damage(cast(state, 'inflict-wounds', [20, ...Array(6).fill(2)], 'enemy')).raw_amount, 12)
  const result = cast(state, 'inflict-wounds', [1], 'enemy')
  assert.equal(damage(result), undefined)
  assert.equal(event(result, 'ResourceSpent').payload.after, 2)
  assert.equal(apply(state, result).mechanics.combat.action_economy.caster.action, false)
})

for (const [id, sides, action] of [['cure-wounds', 8, 'action'], ['healing-word', 4, 'bonus_action']]) {
  for (const slot of [1, 2, 3, 4, 5, 6]) test(`${id}: ячейка ${slot}, ${slot}к${sides}+3`, () => {
    const state = basicFixture()
    const result = cast(state, id, Array(slot).fill(2), 'ally', { slot_level: slot })
    assert.equal(healing(result).applied_amount, slot * 2 + 3)
    assert.equal(event(result, 'ResourceSpent').payload.resource, `spell_slots_${slot}`)
    assert.equal(event(result, 'SpellCast').payload.action_type, action)
  })
  test(`${id}: нежить и конструкты не лечатся, применение расходует ячейку`, () => {
    for (const creature_type of ['undead', 'construct']) {
      const state = basicFixture(); state.players[1].creature_type = creature_type
      const result = cast(state, id, [4])
      assert.equal(healing(result), undefined)
      assert.equal(apply(state, result).players[1].hp, 40)
      assert.equal(event(result, 'ResourceSpent').payload.after, 2)
    }
  })
  test(`${id}: предел хитов, блокировка лечения, умирающий и отрицательный модификатор`, () => {
    const state = basicFixture(); state.players[1].hp = 99
    assert.equal(healing(cast(state, id, [4])).hp_after, 100)
    state.mechanics.conditions.ally = [{ id: 'healing-blocked' }]
    assert.equal(healing(cast(state, id, [4])).hp_after, 99)
    state.players[1].hp = 0; state.mechanics.conditions.ally = [{ id: 'unconscious' }]
    state.mechanics.death.saving_throws.ally = { successes: 1, failures: 2, stable: false }
    const revived = apply(state, cast(state, id, [4]))
    assert.equal(revived.players[1].hp, 7)
    assert.equal(revived.mechanics.death.saving_throws.ally, undefined)
    state.players[0].abilities.wis = 3; state.players[1].hp = 40; state.mechanics.conditions.ally = []
    assert.equal(healing(cast(state, id, [1])).hp_after, 40)
  })
  test(`${id}: Ученик жизни использует круг потраченной ячейки`, () => {
    const state = basicFixture({ subclass: 'life' })
    const result = cast(state, id, [2, 2, 2], 'ally', { slot_level: 3 })
    assert.equal(healing(result).requested_amount, 14)
    assert.equal(healing(result).disciple_of_life_bonus, 5)
    assert.equal(result.events.find(e => e.payload.reason === 'blessed-healer').payload.applied_amount, 5)
  })
  test(`${id}: можно лечить противника и себя`, () => {
    const state = basicFixture({ combat: true }); state.enemies[0].hp = 40
    assert.equal(healing(cast(state, id, [2], 'enemy')).hp_after, 45)
    assert.equal(healing(cast(state, id, [2], 'caster')).hp_after, 45)
  })
}

test('Лечащее слово: занятые руки не мешают словам; бонусная магия ограничивает другую магию 2014', () => {
  const state = basicFixture({ combat: true })
  state.players[0].inventory.push(materializeCatalogItem('srd_5_2_1:mace', { id: 'mace', equipped: true }), materializeCatalogItem('srd_5_2_1:shield', { id: 'shield', equipped: true }))
  const healed = apply(state, cast(state, 'healing-word', [2]))
  assert.equal(healed.mechanics.combat.action_economy.caster.bonus_action, false)
  refused(healed, { command_type: 'CastSpell', spell_id: 'inflict-wounds', target_id: 'enemy' }, 'SPELL_SOMATIC_COMPONENT_BLOCKED')
  state.players[0].inventory = state.players[0].inventory.filter(item => item.id !== 'mace' && item.id !== 'shield')
  const freeHands = apply(state, cast(state, 'healing-word', [2]))
  assert.throws(() => cast(freeHands, 'inflict-wounds', [15, 2, 2, 2], 'enemy'), error => /BONUS|SPELL/u.test(error.code))
  assert.ok(event(cast(freeHands, 'sacred-flame', [2, 2, 2, 1], 'enemy'), 'SpellCast'))
})

test('выбор существа не ограничен командой: усиления и урон доступны союзнику и противнику', () => {
  const state = basicFixture({ combat: true })
  for (const id of ['bless', 'shield-of-faith']) assert.ok(event(cast(state, id, [], 'enemy'), 'ConditionAdded'))
  assert.equal(damage(cast(state, 'inflict-wounds', [15, 2, 2, 2], 'ally')).applied_amount, 6)
})

for (const [slot, maximum] of [[1, 3], [2, 4], [6, 8]]) test(`Благословение: ячейка ${slot} допускает ${maximum} выбранных существ`, () => {
  const state = basicFixture(); state.players.forEach((hero, i) => { state.mechanics.positions[hero.id] = { x: i % 4 + 1, y: Math.floor(i / 4) + 1 } })
  const targets = state.players.slice(0, maximum).map(hero => hero.id)
  const result = cast(state, 'bless', [], targets[0], { target_ids: targets, slot_level: slot })
  assert.deepEqual(result.events.filter(e => e.event_type === 'ConditionAdded').map(e => e.target_ids[0]), targets)
  if (slot < 6) refused(state, { command_type: 'CastSpell', spell_id: 'bless', target_ids: [...targets, state.players[maximum].id], slot_level: slot }, 'TOO_MANY_SPELL_TARGETS')
})

test('Благословение: к4 к каждому спасброску, не к проверке; получатель может отказаться от бонуса', () => {
  let state = apply(basicFixture(), cast(basicFixture(), 'bless', [], 'caster'))
  for (let i = 0; i < 2; i++) {
    const result = basicRun(state, { command_type: 'MakeSavingThrow', ability: 'dex', difficulty: 15 }, [3, 12])
    assert.equal(event(result, 'SavingThrowResolved').payload.total, 15)
    state = apply(state, result)
  }
  assert.equal(event(basicRun(state, { command_type: 'MakeAbilityCheck', ability: 'dex', difficulty: 15 }, [12]), 'AbilityCheckResolved').payload.total, 12)
  const toggled = basicRun(state, { command_type: 'SetSpellBonusPreference', spell_id: 'bless', enabled: false })
  state = apply(state, toggled)
  assert.equal(event(basicRun(state, { command_type: 'MakeSavingThrow', ability: 'dex', difficulty: 15 }, [12]), 'SavingThrowResolved').payload.total, 12)
  assert.ok(state.mechanics.conditions.caster.some(condition => condition.id === 'bless-d4'))
})

test('Щит веры: +2 к КД, без дополнительных хитов и без сложения повторных экземпляров', () => {
  const state = basicFixture()
  const protectedState = apply(state, cast(state, 'shield-of-faith'))
  assert.equal(attackForecast(protectedState, 'enemy', 'ally').armor_class, 14)
  assert.equal(protectedState.players[1].hp, 40)
  assert.equal(protectedState.mechanics.temporary_hp.ally ?? 0, 0)
  const second = basicRun(protectedState, { command_type: 'CastSpell', spell_id: 'shield-of-faith', target_id: 'ally', command_id: 'second' })
  assert.equal(attackForecast(apply(protectedState, second), 'enemy', 'ally').armor_class, 14)
})

for (const [id, seconds] of [['bless', 60], ['shield-of-faith', 600]]) test(`${id}: точный срок ${seconds} секунд и снятие концентрации`, () => {
  const state = basicFixture()
  const activated = apply(state, cast(state, id))
  const condition = activated.mechanics.conditions.ally[0]
  assert.equal(condition.expires_at_seconds - condition.started_at_seconds, seconds)
  const ended = apply(activated, basicRun(activated, { command_type: 'AdvanceTime', amount: seconds, unit: 'second' }))
  assert.ok(!ended.mechanics.conditions.ally.some(c => c.spell_id === id))
  assert.equal(ended.mechanics.concentration.caster, undefined)
})

for (const id of BASIC_IDS) test(`${id}: речь, руки, дальность и сохранение событий`, () => {
  const characterClass = ['poison-spray', 'blade-ward'].includes(id) ? 'wizard' : 'cleric'
  const state = basicFixture({ characterClass, level: 3, combat: true })
  state.mechanics.conditions.caster = [{ id: 'silenced' }]
  refused(state, { command_type: 'CastSpell', spell_id: id, target_id: 'enemy' }, 'SPELL_VERBAL_COMPONENT_BLOCKED')
  state.mechanics.conditions.caster = []
  const target = ['poison-spray', 'sacred-flame', 'inflict-wounds'].includes(id) ? 'enemy' : id === 'blade-ward' ? 'caster' : 'ally'
  const values = id === 'inflict-wounds' ? [15, 2, 2, 2] : ['poison-spray', 'sacred-flame'].includes(id) ? [2, 1] : ['cure-wounds', 'healing-word'].includes(id) ? [2] : []
  const result = cast(state, id, values, target)
  const original = JSON.parse(JSON.stringify(apply(state, result)))
  const replay = JSON.parse(JSON.stringify(apply(state, { events: JSON.parse(JSON.stringify(result.events)) })))
  assert.deepEqual(replay, original)
  if (id !== 'blade-ward') { state.scene.map = null; state.scene.cells = Array.from({ length: 1024 }, (_, i) => ({ x: i % 32, y: Math.floor(i / 32), type: 'floor', revealed: true })); state.mechanics.positions.enemy = { x: 30, y: 30 }; state.mechanics.positions.ally = { x: 30, y: 30 }; refused(state, { command_type: 'CastSpell', spell_id: id, target_id: target }, 'TARGET_OUT_OF_RANGE') }
})

test('видимое существо обязательно для Ядовитых брызг, Священного пламени и Лечащего слова', () => {
  for (const id of ['poison-spray', 'sacred-flame', 'healing-word']) {
    const state = basicFixture({ characterClass: id === 'poison-spray' ? 'wizard' : 'cleric', combat: true })
    const target = id === 'healing-word' ? 'ally' : 'enemy'
    for (const [actor, condition] of [['caster', 'blinded'], [target, 'invisible']]) {
      state.mechanics.conditions = { [actor]: [{ id: condition }] }
      refused(state, { command_type: 'CastSpell', spell_id: id, target_id: target }, 'SPELL_TARGET_REQUIRES_SIGHT')
    }
  }
})
