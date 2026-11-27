import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { materializeCatalogItem } from '../server/item-catalog.mjs'
import * as rules from '../server/rules-engine.mjs'
import { createTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'
import { getWorldTemplate } from '../server/world-template-catalog.mjs'

let sequence = 0
function execute(state, command, context = {}) {
  const result = rules.resolveCommand({ command_id: `longstrider-${++sequence}`, server_authoritative: true, actor_id: 'caster', ...command }, state, {
    diceService: new DiceService({ rng: new SequenceDiceRng(Array(100).fill(10)) }),
    context: { allowedActorIds: ['caster'], serverAuthoritativeCombat: true, ...context },
  })
  const after = rules.replayEvents(state, result.events)
  assert.deepEqual(after, result.events.reduce((next, event) => rules.applyGameEvent(next, event), state))
  return { ...result, state: after }
}
const cast = (state, extra = {}) => execute(state, { command_type: 'CastSpell', spell_id: 'longstrider', target_id: 'caster', slot_level: 1, casting_resource: 'spell_slots_1', ...extra })
const advance = (state, amount, unit = 'minute') => execute(state, { command_type: 'AdvanceTime', amount, unit }, { isAdmin: true })
const effects = (state, id = 'caster') => (state.mechanics.conditions[id] ?? []).filter((effect) => effect.spell_id === 'longstrider')
const move = (state, x, y = 2) => execute(state, { command_type: 'MoveActor', to: { x, y } })

function field({ combat = false, spent = 0 } = {}) {
  return rules.normalizeCampaignState({
    sessionCode: 'LONGSTRIDER-RULE', ruleset_id: 'dnd_5e_2014', ruleset_version: '2014.1.0',
    enabled_house_rules: ['skazanie:2014-preview-legacy-catalogs-v1'],
    partyMemberIds: ['caster', 'ally', 'third'], activePlayerId: 'caster',
    players: [
      { id: 'caster', character: 'Мира', characterClass: 'wizard', level: 3, hp: 24, maxHp: 24, armor: 12,
        speed: 30, baseSpeed: 30, proficiency: 2, abilities: { str: 10, dex: 14, con: 14, int: 16, wis: 12, cha: 8 },
        knownSpellIds: ['longstrider'], preparedSpellIds: ['longstrider'],
        inventory: [materializeCatalogItem('srd_5_2_1:component-pouch', { id: 'pouch', quantity: 1 })], x: 1, y: 2 },
      { id: 'ally', character: 'Борен', characterClass: 'fighter', level: 3, hp: 30, maxHp: 30, armor: 14,
        speed: 30, baseSpeed: 30, abilities: { str: 16, dex: 12, con: 14 }, inventory: [], x: 1, y: 1 },
      { id: 'third', character: 'Эла', characterClass: 'fighter', level: 3, hp: 30, maxHp: 30, armor: 14,
        speed: 30, baseSpeed: 30, abilities: { str: 16, dex: 12, con: 14 }, inventory: [], x: 0, y: 2 },
    ],
    enemies: [{ id: 'enemy', name: 'Противник', hp: 20, maxHp: 20, armor: 12, speed: 30,
      abilities: { str: 10, dex: 10, con: 10 }, x: 19, y: 0, alive: true }],
    scene: { turn: 1, cells: Array.from({ length: 100 }, (_, index) => ({ x: index % 20, y: Math.floor(index / 20), type: 'floor', revealed: true })) },
    mechanics: {
      world_time: { elapsed_minutes: 0 },
      resources: { caster: { spell_slots_1: { current: 4, max: 4 }, spell_slots_2: { current: 2, max: 2 } } },
      combat: { active: combat, round: combat ? 1 : 0, active_index: combat ? 0 : -1,
        initiative: combat ? ['caster', 'ally', 'third', 'enemy'].map((actor_id, index) => ({ actor_id, total: 20 - index })) : [],
        action_economy: Object.fromEntries(['caster', 'ally', 'third', 'enemy'].map((id) => [id, { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: id === 'caster' ? spent : 0 }])),
      },
    },
  })
}

test('Скороход накладывается настоящим CastSpell на час, не меняет базу и оплачивается один раз', () => {
  const initial = field()
  const before = structuredClone(initial)
  const result = cast(initial)
  assert.deepEqual(initial, before, 'вычисление команды не меняет входное состояние')
  assert.equal(result.events.filter((event) => event.event_type === 'ResourceSpent').length, 1)
  assert.equal(result.state.mechanics.resources.caster.spell_slots_1.current, 3)
  assert.equal(result.state.players[0].speed, 30)
  assert.equal(result.state.players[0].baseSpeed, 30)
  assert.equal(rules.movementForActor(result.state, 'caster').current_speed, 40)
  assert.equal(result.state.mechanics.concentration.caster, undefined)
  assert.equal(effects(result.state).length, 1)
  assert.equal(effects(result.state)[0].expires_at_seconds - effects(result.state)[0].started_at_seconds, 3600)
  assert.equal(effects(result.state)[0].duration, 'seconds:3600')
})

test('ячейка второго круга даёт двум выбранным целям по 10 футов за одну оплату', () => {
  const result = cast(field(), { target_id: undefined, target_ids: ['caster', 'ally'], slot_level: 2, casting_resource: 'spell_slots_2' })
  assert.equal(result.events.filter((event) => event.event_type === 'ResourceSpent').length, 1)
  assert.equal(result.state.mechanics.resources.caster.spell_slots_1.current, 4)
  assert.equal(result.state.mechanics.resources.caster.spell_slots_2.current, 1)
  for (const id of ['caster', 'ally']) {
    assert.equal(rules.movementForActor(result.state, id).current_speed, 40)
    assert.equal(effects(result.state, id)[0].expires_at_seconds - effects(result.state, id)[0].started_at_seconds, 3600)
  }
  assert.equal(effects(result.state, 'third').length, 0)
})

for (const [name, update, command, code] of [
  ['повтор цели', () => {}, { target_id: undefined, target_ids: ['ally', 'ally'], slot_level: 2, casting_resource: 'spell_slots_2' }, 'INVALID_SPELL_TARGETS'],
  ['лишняя цель', () => {}, { target_id: undefined, target_ids: ['caster', 'ally'] }, 'TOO_MANY_SPELL_TARGETS'],
  ['цель вне касания', (state) => { state.players[1].x = 5; state.mechanics.positions.ally.x = 5 }, { target_id: 'ally' }, 'TARGET_OUT_OF_RANGE'],
  ['исчерпанная явная ячейка', (state) => { state.mechanics.resources.caster.spell_slots_1.current = 0 }, {}, 'INSUFFICIENT_RESOURCE'],
  ['несуществующий круг', () => {}, { slot_level: 9, casting_resource: undefined }, 'INVALID_SPELL_SLOT_LEVEL'],
  ['несуществующий источник ячейки', () => {}, { slot_level: 9, casting_resource: 'spell_slots_9' }, 'INVALID_CASTING_RESOURCE'],
  ['несогласованный источник ячейки', () => {}, { slot_level: 1, casting_resource: 'spell_slots_2' }, 'INVALID_CASTING_RESOURCE'],
  ['массив вместо источника ячейки', () => {}, { casting_resource: ['spell_slots_1'] }, 'INVALID_CASTING_RESOURCE'],
  ['объект вместо источника ячейки', () => {}, { casting_resource: { resource: 'spell_slots_1' } }, 'INVALID_CASTING_RESOURCE'],
  ['нет компонентов', (state) => { state.players[0].inventory = [] }, {}, 'SPELL_MATERIAL_COMPONENT_REQUIRED'],
]) test(`Скороход отклоняет ${name} без частичных эффектов и расхода`, () => {
  const initial = field()
  update(initial)
  const before = structuredClone(initial)
  assert.throws(() => cast(initial, command), { code })
  assert.deepEqual(initial, before)
})

test('20 потраченных футов остаются потраченными: после наложения доступны ровно ещё 20', () => {
  const initial = field({ combat: true, spent: 20 })
  const enchanted = cast(initial).state
  const movement = rules.movementForActor(enchanted, 'caster')
  assert.equal(movement.current_speed, 40)
  assert.equal(movement.movement_spent, 20)
  assert.equal(movement.movement_remaining, 20)
  assert.throws(() => move(enchanted, 6), { code: 'SPEED_EXCEEDED' })
  const moved = move(enchanted, 5).state
  assert.equal(rules.movementForActor(moved, 'caster').movement_remaining, 0)
})

test('Скороход открывает ещё 10 футов после реального исчерпания всех 30 футов движения', () => {
  const spent = move(field({ combat: true }), 7).state
  assert.equal(spent.mechanics.combat.action_economy.caster.movement, false)
  assert.equal(rules.movementForActor(spent, 'caster').movement_remaining, 0)
  const enchanted = cast(spent).state
  assert.equal(rules.movementForActor(enchanted, 'caster').movement_spent, 30)
  assert.equal(rules.movementForActor(enchanted, 'caster').movement_remaining, 10)
  assert.throws(() => move(enchanted, 10), { code: 'SPEED_EXCEEDED' })
  const moved = move(enchanted, 9).state
  assert.equal(rules.movementForActor(moved, 'caster').movement_spent, 40)
  assert.equal(rules.movementForActor(moved, 'caster').movement_remaining, 0)
})

test('две реальные версии не складываются, на 60-й минуте остаётся только более новая', () => {
  const first = cast(field()).state
  const second = cast(advance(first, 10).state).state
  assert.equal(effects(second).length, 2)
  assert.notEqual(effects(second)[0].effect_id, effects(second)[1].effect_id)
  assert.equal(rules.movementForActor(second, 'caster').current_speed, 40)
  const minute60 = advance(second, 50)
  assert.equal(effects(minute60.state).length, 1)
  assert.equal(rules.movementForActor(minute60.state, 'caster').current_speed, 40)
  const minute70 = advance(minute60.state, 10)
  assert.equal(effects(minute70.state).length, 0)
  assert.equal(rules.movementForActor(minute70.state, 'caster').current_speed, 30)
  assert.equal(advance(minute70.state, 1).events.some((event) => event.event_type === 'ConditionRemoved' && event.payload.condition === 'longstrider'), false)
})

test('захват подавляет прибавку, но не её срок; освобождение после границы её не возвращает', () => {
  const enchanted = cast(field({ combat: true })).state
  enchanted.mechanics.conditions.caster.push({ id: 'grappled', effect_id: 'test-grapple' })
  assert.equal(rules.movementForActor(enchanted, 'caster').current_speed, 0)
  assert.equal(rules.movementForActor(enchanted, 'caster').movement_remaining, 0)
  assert.ok(rules.movementForActor(enchanted, 'caster').blocked_reason)
  assert.throws(() => move(enchanted, 2))
  const expired = advance(enchanted, 60).state
  expired.mechanics.conditions.caster = expired.mechanics.conditions.caster.filter((effect) => effect.id !== 'grappled')
  assert.equal(rules.movementForActor(expired, 'caster').current_speed, 30)
  assert.equal(effects(expired).length, 0)
})

test('истечение не возвращает устаревшую скорость и сохраняет чужое замедление', () => {
  const enchanted = cast(field()).state
  enchanted.players[0].speed = 35
  enchanted.players[0].baseSpeed = 35
  enchanted.mechanics.conditions.caster.push({ id: 'speed-reduced-10', effect_id: 'other-speed-source' })
  assert.equal(rules.movementForActor(enchanted, 'caster').current_speed, 35)
  const expired = advance(enchanted, 60).state
  assert.equal(expired.players[0].speed, 35)
  assert.equal(rules.movementForActor(expired, 'caster').current_speed, 25)
  assert.ok(expired.mechanics.conditions.caster.some((effect) => effect.effect_id === 'other-speed-source'))
})

test('срок сохраняется при входе/выходе из боя и кончается точно на 3600-й секунде', () => {
  const initial = field()
  const enchanted = cast(initial)
  const moved = move(enchanted.state, 4)
  const began = execute(moved.state, { command_type: 'StartCombat' })
  assert.equal(effects(began.state)[0].expires_at_seconds, 3600)
  const combatMove = move(began.state, 12)
  const ended = execute(combatMove.state, { command_type: 'EndCombat' }, { isAdmin: true })
  const restored = rules.normalizeCampaignState(JSON.parse(JSON.stringify(ended.state)))
  assert.equal(effects(restored)[0].expires_at_seconds, 3600)
  assert.equal(rules.movementForActor(restored, 'caster').current_speed, 40)
  const beforeEnd = advance(restored, 3599 - rules.worldTimeSeconds(restored), 'second')
  assert.equal(effects(beforeEnd.state).length, 1)
  assert.equal(rules.movementForActor(beforeEnd.state, 'caster').current_speed, 40)
  const expired = advance(beforeEnd.state, 1, 'second')
  assert.equal(effects(expired.state).length, 0)
  assert.equal(rules.movementForActor(expired.state, 'caster').current_speed, 30)
  const events = [enchanted, moved, began, combatMove, ended, beforeEnd, expired].flatMap((result) => result.events)
  assert.deepEqual(rules.replayEvents(initial, events), expired.state)
})

test('один полный раунд четырёх участников продвигает срок на шесть секунд', () => {
  let state = cast(field()).state
  state = execute(state, { command_type: 'StartCombat' }).state
  const before = rules.worldTimeSeconds(state)
  for (let index = 0; index < 4; index += 1) {
    const actor_id = state.mechanics.combat.initiative[state.mechanics.combat.active_index].actor_id
    state = execute(state, { command_type: 'EndTurn', actor_id }, { isAdmin: true }).state
    assert.equal(rules.worldTimeSeconds(state) - before, index === 3 ? 6 : 0)
  }
  assert.equal(effects(state)[0].expires_at_seconds, 3600)
})

test('Рывок использует текущую скорость и меняет остаток при истечении Скорохода', () => {
  const enchanted = cast(field()).state
  const began = execute(enchanted, { command_type: 'StartCombat' }).state
  const dashed = execute(began, { command_type: 'UseCombatAction', action_id: 'dash' }).state
  assert.equal(rules.movementForActor(dashed, 'caster').movement_remaining, 80)
  const moved = move(dashed, 5).state
  assert.equal(rules.movementForActor(moved, 'caster').movement_remaining, 60)
  const expired = advance(moved, 60).state
  assert.equal(rules.movementForActor(expired, 'caster').movement_remaining, 40)
})

test('труднопроходимая местность оплачивается отдельно от увеличенной скорости', () => {
  const initial = field({ combat: true })
  initial.scene.map = serializeTacticalMap(createTacticalMap({ width: 20, height: 5,
    fill: { passable: true, revealed: true, moveCost: 2 } }))
  const enchanted = cast(initial).state
  assert.throws(() => move(enchanted, 6), { code: 'SPEED_EXCEEDED' })
  const moved = move(enchanted, 5).state
  assert.equal(rules.movementForActor(moved, 'caster').movement_remaining, 0)
})

test('поддержанное Замедление вдвое уменьшает скорость вместе с бонусом Скорохода', () => {
  const enchanted = cast(field({ combat: true })).state
  enchanted.mechanics.conditions.caster.push({ id: 'slowed', effect_id: 'existing-slow' })
  assert.equal(rules.movementForActor(enchanted, 'caster').current_speed, 20)
  assert.throws(() => move(enchanted, 6), { code: 'SPEED_EXCEEDED' })
  assert.equal(rules.movementForActor(move(enchanted, 5).state, 'caster').movement_remaining, 0)
})

test('исследование оплачивает 40 футов шестью секундами со Скороходом и восемью без него', () => {
  assert.equal(rules.worldTimeSeconds(move(field(), 9).state), 8)
  const enchanted = cast(field()).state
  assert.equal(rules.worldTimeSeconds(move(enchanted, 9).state), 6)
})

test('восемь переходов по 5 футов сохраняют дробные секунды и равны одному пути на 40 футов', () => {
  const initial = cast(field()).state
  let state = initial
  const events = []
  for (let x = 2; x <= 9; x += 1) {
    const moved = move(state, x)
    events.push(...moved.events)
    state = rules.normalizeCampaignState(JSON.parse(JSON.stringify(moved.state)))
    assert.equal(rules.worldTimeSeconds(state), (x - 1) * 0.75)
  }
  assert.equal(rules.worldTimeSeconds(state), rules.worldTimeSeconds(move(initial, 9).state))
  assert.deepEqual(rules.replayEvents(initial, events), state)
})

test('при истечении через две секунды оставшаяся часть исследовательского пути идёт с базовой скоростью', () => {
  const initial = advance(cast(field()).state, 3598, 'second').state
  const moved = move(initial, 9)
  // За первые 2 с герой проходит 40/3 фута, за оставшиеся 80/3 фута — ещё 16/3 с.
  assert.ok(Math.abs((rules.worldTimeSeconds(moved.state) - 3598) - 22 / 3) <= 0.001)
  assert.equal(effects(moved.state).length, 0)
  assert.equal(rules.movementForActor(moved.state, 'caster').current_speed, 30)
  assert.equal(moved.events.filter((event) => event.event_type === 'TimeAdvanced').length, 1)
  assert.deepEqual(rules.replayEvents(initial, moved.events), moved.state)
})

function neutralField({ visibility = 'party', x = 2 } = {}) {
  const state = field()
  const npc = structuredClone(getWorldTemplate('astohan-plains').opening.npcs[0])
  const location = { location: 'Рынок', location_id: 'market', locationId: 'market' }
  return { npcId: npc.id, state: rules.normalizeCampaignState({
    ...state, enemies: [], scene: { ...state.scene, ...location },
    social: { npcs: [{ ...npc, ...location, visibility, reveal_on_presence: false, available: true }] },
    npc_world: { schema_version: 1,
      placements: [{ npc_id: npc.id, location_id: 'market', x, y: 2, placement_reason: 'test' }],
      profiles: { [npc.id]: npc.mechanics },
      vitals: { [npc.id]: { hp: npc.mechanics.hp, max_hp: npc.mechanics.hp, alive: true } },
    },
  }) }
}

test('видимый мирный NPC получает настоящий эффект без создания боя и сохраняет его при входе во встречу', () => {
  const { state, npcId } = neutralField()
  const enchanted = cast(state, { target_id: npcId })
  assert.equal(enchanted.state.mechanics.combat.active, false)
  assert.deepEqual(enchanted.state.enemies, state.enemies)
  assert.deepEqual(enchanted.state.actors, state.actors)
  assert.deepEqual(enchanted.state.npc_world, state.npc_world)
  assert.equal(effects(enchanted.state, npcId).length, 1)
  const created = execute(enchanted.state, { command_type: 'CreateEncounter', npc_id: npcId,
    seed: 'longstrider-neutral-npc', theme: 'generic', difficulty: 'easy' }, { isDirector: true })
  const began = execute(created.state, { command_type: 'StartCombat' })
  assert.ok(began.state.enemies.some((actor) => actor.id === npcId))
  assert.deepEqual(effects(began.state, npcId), effects(enchanted.state, npcId))
  const movement = rules.movementForActor(began.state, npcId)
  assert.equal(movement.current_speed, movement.base_speed + 10)
})

for (const [name, setup, code] of [
  ['скрытого', { visibility: 'gm_only' }, 'TARGET_NOT_FOUND'],
  ['далёкого', { x: 5 }, 'TARGET_OUT_OF_RANGE'],
]) test(`Скороход не позволяет выбрать ${name} мирного NPC`, () => {
  const { state, npcId } = neutralField(setup)
  const before = structuredClone(state)
  assert.throws(() => cast(state, { target_id: npcId }), { code })
  if (setup.visibility === 'gm_only') assert.throws(() => cast(state, { target_id: 'missing-npc' }), { code })
  assert.deepEqual(state, before)
})
