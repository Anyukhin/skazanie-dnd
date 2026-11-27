import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { CLASS_RESOURCES_2024_POLICY_ID, combatResourceMaximumsFor, combatResourceRecoveryFor } from '../server/combat-actions.mjs'
import { normalizeCampaignState, replayEvents, resolveCommands } from '../server/rules-engine.mjs'
import { rulesetLock } from '../server/ruleset-config.mjs'

// Боевой плейтест 2026-10-03: жрец 3-го уровня в кампании 2024 имел один
// «Божественный канал», а по редакции 2024 их два. Таблица запасов была
// написана по 2014; новая включается маркером политики только у новых кампаний,
// чтобы replay уже идущих не менял их запасы.

function dice() {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng([4, 4, 4, 4]), idFactory: () => `class-resources-roll-${++id}`, now: () => '2026-10-03T12:00:00.000Z' })
}

function campaign({ rulesetId = 'srd_5_2_1', policy = true, level = 3 } = {}) {
  return normalizeCampaignState({
    sessionCode: 'CLASS-RES-2024',
    ruleset_id: rulesetId,
    enabled_house_rules: policy ? [CLASS_RESOURCES_2024_POLICY_ID] : [],
    partyMemberIds: ['cleric', 'fighter'],
    players: [
      { id: 'cleric', character: 'Бранда', characterClass: 'cleric', subclass: 'Домен жизни', level, hp: 20, maxHp: 20, armor: 16, speed: 30, abilities: { str: 10, dex: 10, con: 12, int: 10, wis: 16, cha: 12 }, inventory: [], x: 0, y: 0 },
      { id: 'fighter', character: 'Торвальд', characterClass: 'fighter', level, hp: 28, maxHp: 28, armor: 16, speed: 30, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], x: 1, y: 0 },
    ],
    scene: { turn: 1, cells: [{ x: 0, y: 0, type: 'floor', revealed: true }, { x: 1, y: 0, type: 'floor', revealed: true }] },
  })
}

test('таблица 2024: два канала на 2-м, три на 6-м; Второе дыхание 2/3/4; Дикий облик 3 на 6-м', () => {
  const policy = { classResources2024: true }
  assert.equal(combatResourceMaximumsFor({ characterClass: 'cleric', level: 3 }).channel_divinity, 1, 'без политики — прежняя таблица')
  assert.equal(combatResourceMaximumsFor({ characterClass: 'cleric', level: 2 }, policy).channel_divinity, 2)
  assert.equal(combatResourceMaximumsFor({ characterClass: 'cleric', level: 6 }, policy).channel_divinity, 3)
  assert.equal(combatResourceMaximumsFor({ characterClass: 'fighter', level: 1 }, policy).second_wind, 2)
  assert.equal(combatResourceMaximumsFor({ characterClass: 'fighter', level: 4 }, policy).second_wind, 3)
  assert.equal(combatResourceMaximumsFor({ characterClass: 'fighter', level: 10 }, policy).second_wind, 4)
  assert.equal(combatResourceMaximumsFor({ characterClass: 'druid', level: 6 }, policy).wild_shape, 3)
  assert.equal(combatResourceRecoveryFor({ characterClass: 'barbarian', level: 3 }, policy).rage, 'one_short_all_long')
  assert.equal(combatResourceRecoveryFor({ characterClass: 'barbarian', level: 3 }).rage, 'long')
})

test('новая кампания 2024 получает политику, 2014 — нет', () => {
  assert.ok(rulesetLock('srd_5_2_1').enabled_house_rules.includes(CLASS_RESOURCES_2024_POLICY_ID))
  assert.ok(!rulesetLock('dnd_5e_2014').enabled_house_rules.includes(CLASS_RESOURCES_2024_POLICY_ID))
})

test('запасы в состоянии кампании следуют политике, а не одной редакции', () => {
  const current = campaign()
  assert.deepEqual(current.mechanics.resources.cleric.channel_divinity, { current: 2, max: 2 })
  assert.deepEqual(current.mechanics.resources.fighter.second_wind, { current: 2, max: 2 })
  const legacy = campaign({ policy: false })
  assert.deepEqual(legacy.mechanics.resources.cleric.channel_divinity, { current: 1, max: 1 }, 'кампания 2024 без маркера живёт по прежней таблице')
  const classic = campaign({ rulesetId: 'dnd_5e_2014' })
  assert.deepEqual(classic.mechanics.resources.cleric.channel_divinity, { current: 1, max: 1 }, 'в 2014 маркер ничего не меняет')
})

function rest(state, actorId, kind) {
  return resolveCommands([
    { command_type: 'StartRest', actor_id: actorId, kind },
    { command_type: 'AdvanceTime', amount: kind === 'long' ? 480 : 60, unit: 'minute' },
    { command_type: 'CompleteRest', actor_id: actorId, kind },
  ], state, { diceService: dice(), context: { allowedActorIds: [actorId] } })
}

test('короткий отдых в 2024 возвращает один заряд канала, продолжительный — все; replay совпадает', () => {
  const initial = campaign()
  initial.mechanics.resources.cleric.channel_divinity = { current: 0, max: 2 }
  initial.mechanics.resources.fighter.second_wind = { current: 0, max: 2 }
  const short = rest(initial, 'cleric', 'short')
  assert.deepEqual(short.state.mechanics.resources.cleric.channel_divinity, { current: 1, max: 2 })
  assert.deepEqual(replayEvents(initial, short.events).mechanics.resources.cleric.channel_divinity, { current: 1, max: 2 })
  const long = rest(short.state, 'cleric', 'long')
  assert.deepEqual(long.state.mechanics.resources.cleric.channel_divinity, { current: 2, max: 2 })

  const legacy = campaign({ policy: false })
  legacy.mechanics.resources.cleric.channel_divinity = { current: 0, max: 1 }
  assert.deepEqual(rest(legacy, 'cleric', 'short').state.mechanics.resources.cleric.channel_divinity, { current: 1, max: 1 }, 'прежняя кампания: короткий отдых возвращает всё')
})
