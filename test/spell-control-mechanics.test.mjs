import assert from 'node:assert/strict'
import test from 'node:test'

import { combatSpellFor } from '../server/combat-spells.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `control-roll-${++id}`, now: () => '2026-07-26T12:00:00.000Z' })
}

const SWORD = { id: 'sword', name: 'Длинный меч', type: 'weapon', quantity: 1, equipped: true, combat: { kind: 'melee', ability: 'str', damage: '1d8', damageType: 'slashing', normalRange: 5 } }

/**
 * A level-5 cleric (DC 15) with a humanoid and an undead enemy side by side:
 * Hold Person must separate the two by creature type, not by hit points.
 */
function controlState() {
  const cells = Array.from({ length: 40 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'CONTROL-1',
    partyMemberIds: ['cleric', 'fighter'],
    players: [
      { id: 'cleric', character: 'Мира', role: 'Жрец · ур. 5', characterClass: 'cleric', level: 5, hp: 30, maxHp: 30, armor: 16, speed: 30, proficiency: 3, abilities: { str: 10, dex: 12, con: 14, int: 10, wis: 18, cha: 10 }, inventory: [], x: 1, y: 1 },
      { id: 'fighter', character: 'Бранн', role: 'Воин · ур. 5', characterClass: 'fighter', level: 5, hp: 40, maxHp: 40, armor: 17, speed: 30, proficiency: 3, abilities: { str: 16, dex: 12, con: 16, int: 10, wis: 10, cha: 10 }, inventory: [SWORD], x: 1, y: 2 },
    ],
    enemies: [
      { id: 'bandit', name: 'Разбойник', creature_type: 'humanoid', hp: 60, maxHp: 60, armor: 12, speed: 30, abilities: { str: 12, dex: 14, con: 12, int: 10, wis: 8, cha: 10 }, x: 2, y: 2, alive: true },
      { id: 'bandit-two', name: 'Второй разбойник', creature_type: 'humanoid', hp: 60, maxHp: 60, armor: 12, speed: 30, abilities: { str: 12, dex: 14, con: 12, int: 10, wis: 8, cha: 10 }, x: 3, y: 2, alive: true },
      { id: 'skeleton', name: 'Скелет', creature_type: 'undead', hp: 30, maxHp: 30, armor: 13, speed: 30, abilities: { str: 10, dex: 14, con: 15, int: 6, wis: 8, cha: 5 }, x: 3, y: 1, alive: true },
    ],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'cleric', total: 20 }, { actor_id: 'fighter', total: 18 }, { actor_id: 'bandit', total: 12 }],
        action_economy: {
          cleric: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          fighter: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

function hold(state, values, extra = {}) {
  return resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'hold-person', target_id: 'bandit', ...extra }),
    state,
    options(dice(values)),
  )
}

const saveEvent = (result) => result.events.find((event) => event.event_type === 'SpellSavingThrowResolved')
const paralysis = (result, target = 'bandit') => result.events.find((event) => event.event_type === 'ConditionAdded'
  && event.payload.condition === 'paralyzed' && event.target_ids.includes(target))

test('Удержание личности объявлено серверным правилом, а не эвристикой каталога', () => {
  const spell = combatSpellFor({ characterClass: 'cleric', level: 5, abilities: { wis: 18 } }, 'hold-person')
  assert.equal(spell.mechanicsSupport, 'partial')
  assert.equal(spell.mechanicsAccuracy, 'verified-dndsu')
  assert.equal(spell.kind, 'debuff')
  assert.equal(spell.target, 'enemy', 'автогенерация считала заклинание благословением союзника')
  assert.equal(spell.saveAbility, 'wis')
  assert.equal(spell.concentration, true)
  assert.deepEqual(spell.requiredCreatureTypes, ['humanoid'])
  assert.equal(spell.repeatSaveAtTurnEnd, true)
})

test('гуманоид, провалив спасбросок Мудрости, парализован на время концентрации', () => {
  const result = hold(controlState(), [12])
  const save = saveEvent(result)
  assert.equal(save.payload.ability, 'wis')
  assert.equal(save.payload.difficulty, 15)
  assert.equal(save.payload.saved, false)
  const added = paralysis(result)
  assert.equal(added.payload.duration, 'concentration')
  assert.equal(added.payload.repeat_save_timing, 'turn-end')
  assert.equal(added.payload.save_ability, 'wis')
  assert.equal(added.payload.save_dc, 15)
  assert.ok(result.events.some((event) => event.event_type === 'ConcentrationStarted'))
})

test('успешный спасбросок оставляет цель свободной', () => {
  const result = hold(controlState(), [17])
  assert.equal(saveEvent(result).payload.saved, true)
  assert.equal(paralysis(result), undefined)
})

test('нежить нельзя удержать заклинанием для гуманоидов', () => {
  const result = hold(controlState(), [1], { target_id: 'skeleton' })
  const save = saveEvent(result)
  assert.equal(save.payload.saved, true, 'даже натуральная 1 не удерживает нежить')
  assert.equal(save.payload.automatic_success, true)
  assert.equal(save.payload.immunity, 'undead')
  assert.equal(paralysis(result, 'skeleton'), undefined)
})

test('ячейка третьего круга удерживает вторую цель', () => {
  const result = hold(controlState(), [12, 11], { slot_level: 3, target_ids: ['bandit', 'bandit-two'] })
  assert.equal(paralysis(result, 'bandit')?.payload.condition, 'paralyzed')
  assert.equal(paralysis(result, 'bandit-two')?.payload.condition, 'paralyzed')
  const spent = result.events.find((event) => event.event_type === 'ResourceSpent')
  assert.equal(spent.payload.resource, 'spell_slots_3')
})

test('удержание превращает следующий ближний удар союзника в критический', () => {
  const state = controlState()
  const held = hold(state, [12])
  const afterHold = replayEvents(state, held.events)
  const passed = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'cleric' }), afterHold, options(dice()))
  const fighterTurn = replayEvents(afterHold, passed.events)
  const strike = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'fighter', target_id: 'bandit', item_id: 'sword' }),
    fighterTurn,
    options(dice([9, 13, 5, 6])),
  )
  const resolved = strike.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(resolved.payload.hit, true)
  assert.notEqual(resolved.payload.kept, 20)
  assert.equal(resolved.payload.critical, true)
  assert.equal(resolved.payload.automatic_critical, true)
  assert.deepEqual(resolved.payload.condition_advantage, ['target:paralyzed'])
  assert.equal(strike.rolls.find((entry) => entry.purpose === 'damage').expression, '2d8+3')
})

test('Удержание чудовища держит зверя и не действует на нежить', () => {
  const state = controlState()
  const beast = normalizeCampaignState({
    ...state,
    players: [{ ...state.players[0], characterClass: 'wizard', level: 9, proficiency: 4, abilities: { ...state.players[0].abilities, int: 18 } }, state.players[1]],
  })
  const held = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'hold-monster', target_id: 'bandit' }),
    beast,
    options(dice([10])),
  )
  const added = paralysis(held)
  assert.equal(added.payload.condition, 'paralyzed')
  assert.equal(added.payload.repeat_save_timing, 'turn-end')
  assert.equal(held.events.find((event) => event.event_type === 'ResourceSpent').payload.resource, 'spell_slots_5')

  const undead = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'hold-monster', target_id: 'skeleton' }),
    beast,
    options(dice([1])),
  )
  assert.equal(saveEvent(undead).payload.immunity, 'undead')
  assert.equal(paralysis(undead, 'skeleton'), undefined)
})

test('Страх в конусе делает цель испуганной и запрещает ей приближаться к заклинателю', () => {
  const cells = Array.from({ length: 40 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  const state = normalizeCampaignState({
    sessionCode: 'CONTROL-FEAR',
    partyMemberIds: ['bard'],
    players: [{ id: 'bard', character: 'Лира', role: 'Бард · ур. 9', characterClass: 'bard', level: 9, hp: 40, maxHp: 40, armor: 15, speed: 30, proficiency: 4, abilities: { str: 10, dex: 14, con: 14, int: 12, wis: 12, cha: 18 }, inventory: [], x: 1, y: 1 }],
    enemies: [{ id: 'brute', name: 'Громила', creature_type: 'humanoid', hp: 50, maxHp: 50, armor: 13, speed: 30, abilities: { str: 16, dex: 10, con: 14, int: 8, wis: 8, cha: 8 }, x: 5, y: 1, alive: true }],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'bard', total: 20 }, { actor_id: 'brute', total: 10 }],
        action_economy: {
          bard: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          brute: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'bard', spell_id: 'fear', to: { x: 7, y: 1 } }),
    state,
    options(dice([4])),
  )
  const frightened = cast.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'frightened')
  assert.ok(frightened, 'конус обязан накрыть цель')
  assert.equal(frightened.payload.source_actor, 'bard')
  assert.equal(frightened.payload.duration, 'concentration')
  assert.equal(frightened.payload.repeat_save_timing, 'turn-end')

  const afterFear = replayEvents(state, cast.events)
  const brutesTurn = { ...afterFear, mechanics: { ...afterFear.mechanics, combat: { ...afterFear.mechanics.combat, active_index: 1 } } }
  assert.throws(
    () => resolveCommand(authoritative({ command_type: 'MoveActor', actor_id: 'brute', to: { x: 4, y: 1 } }), brutesTurn, options(dice())),
    (error) => error.code === 'FRIGHTENED_CLOSER',
    'испуганное существо не имеет права идти на источник страха',
  )
  const away = resolveCommand(authoritative({ command_type: 'MoveActor', actor_id: 'brute', to: { x: 6, y: 1 } }), brutesTurn, options(dice()))
  assert.ok(away.events.some((event) => event.event_type === 'ActorMoved'), 'отступать испуганное существо обязано мочь')
})

test('Высшая невидимость даёт цели преимущество, а врагам — помеху', () => {
  const state = controlState()
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'greater-invisibility', target_id: 'fighter' }),
    normalizeCampaignState({ ...state, players: [{ ...state.players[0], characterClass: 'bard', level: 9, proficiency: 4, abilities: { ...state.players[0].abilities, cha: 18 } }, state.players[1]] }),
    options(dice()),
  )
  const added = cast.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'invisible')
  assert.equal(added.payload.duration, 'concentration')
  assert.deepEqual(added.target_ids, ['fighter'])
  const hidden = replayEvents(state, cast.events)
  const ended = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'cleric' }), hidden, options(dice()))
  const strike = resolveCommand(
    authoritative({ command_type: 'MakeAttack', actor_id: 'fighter', target_id: 'bandit', item_id: 'sword' }),
    replayEvents(hidden, ended.events),
    options(dice([6, 15, 4])),
  )
  const resolved = strike.events.find((event) => event.event_type === 'AttackResolved')
  assert.equal(resolved.payload.kept, 15, 'невидимый атакующий бросает с преимуществом')
  assert.deepEqual(resolved.payload.condition_advantage, ['attacker:invisible'])
})

/**
 * A wizard far enough from two clustered enemies that every area below covers
 * the pair and never the caster: friendly fire is a real rule here, so the
 * fixture has to keep it out of the way deliberately.
 */
function areaState() {
  const cells = Array.from({ length: 40 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'CONTROL-AREA',
    partyMemberIds: ['mage'],
    players: [{ id: 'mage', character: 'Аль', role: 'Волшебник · ур. 11', characterClass: 'wizard', level: 11, hp: 40, maxHp: 40, armor: 12, speed: 30, proficiency: 4, abilities: { str: 8, dex: 14, con: 14, int: 18, wis: 12, cha: 10 }, inventory: [], x: 1, y: 1 }],
    enemies: [
      { id: 'thug', name: 'Головорез', creature_type: 'humanoid', hp: 40, maxHp: 40, armor: 12, speed: 30, abilities: { str: 14, dex: 14, con: 12, int: 10, wis: 10, cha: 10 }, x: 5, y: 1, alive: true },
      { id: 'thug-two', name: 'Второй головорез', creature_type: 'humanoid', hp: 40, maxHp: 40, armor: 12, speed: 30, abilities: { str: 14, dex: 14, con: 15, int: 10, wis: 10, cha: 10 }, x: 5, y: 2, alive: true },
    ],
    scene: { turn: 1, cells },
    mechanics: {
      combat: {
        active: true, round: 1, active_index: 0,
        initiative: [{ actor_id: 'mage', total: 20 }, { actor_id: 'thug', total: 12 }, { actor_id: 'thug-two', total: 10 }],
        action_economy: {
          mage: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          thug: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          'thug-two': { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
        },
      },
    },
  })
}

const castArea = (state, spellId, values, to = { x: 5, y: 1 }, extra = {}) => resolveCommand(
  authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: spellId, to, ...extra }),
  state,
  options(dice(values)),
)

test('Паутина опутывает провалившего спасбросок и обнуляет его скорость', () => {
  const state = areaState()
  const cast = castArea(state, 'web', [3, 4])
  const restrained = cast.events.filter((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'restrained')
  assert.equal(restrained.length, 2, 'куб паутины обязан накрыть обоих врагов')
  assert.equal(restrained[0].payload.duration, 'concentration')

  const webbed = replayEvents(state, cast.events)
  const thugsTurn = { ...webbed, mechanics: { ...webbed.mechanics, combat: { ...webbed.mechanics.combat, active_index: 1 } } }
  assert.throws(
    () => resolveCommand(authoritative({ command_type: 'MoveActor', actor_id: 'thug', to: { x: 7, y: 1 } }), thugsTurn, options(dice())),
    (error) => error.code === 'SPEED_IS_ZERO' && error.message.includes('restrained'),
  )
})

test('Гипнотический узор очаровывает, обездвиживает и снимается любым уроном', () => {
  const cast = castArea(areaState(), 'hypnotic-pattern', [3, 4])
  const applied = cast.events.filter((event) => event.event_type === 'ConditionAdded' && event.target_ids.includes('thug')).map((event) => event.payload.condition)
  assert.deepEqual(applied, ['charmed', 'incapacitated', 'speed-zero'])
  const charmed = cast.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'charmed')
  assert.equal(charmed.payload.break_on_damage_from_source_allies, true)
  assert.equal(charmed.payload.duration, 'concentration')
})

test('Звуковая волна делит урон пополам при успешном спасброске', () => {
  const cast = castArea(areaState(), 'shatter', [4, 4, 4, 20, 2])
  const rolled = cast.rolls.find((entry) => entry.purpose.startsWith('spell_damage'))
  assert.equal(rolled.expression, '3d8')
  const damages = cast.events.filter((event) => event.event_type === 'DamageApplied')
  assert.equal(damages.length, 2, 'сфера обязана накрыть обоих врагов')
  const saved = damages.find((event) => event.payload.saved === true)
  const failed = damages.find((event) => event.payload.saved === false)
  assert.ok(saved && failed, 'нужен и успешный, и провальный спасбросок')
  assert.equal(failed.payload.raw_amount, 12)
  assert.equal(saved.payload.raw_amount, 6)
  assert.equal(failed.payload.damage_type, 'thunder')
})

test('Конус холода накрывает направленную область и масштабируется ячейкой', () => {
  const cast = castArea(areaState(), 'cone-of-cold', [5, 5, 5, 5, 5, 5, 5, 5, 5, 10, 10], { x: 7, y: 1 })
  const rolled = cast.rolls.find((entry) => entry.purpose.startsWith('spell_damage'))
  assert.equal(rolled.expression, '8d8')
  assert.ok(cast.events.some((event) => event.event_type === 'DamageApplied' && event.payload.damage_type === 'cold'))
  const upcast = castArea(areaState(), 'cone-of-cold', Array.from({ length: 13 }, () => 5), { x: 7, y: 1 }, { slot_level: 6 })
  assert.equal(upcast.rolls.find((entry) => entry.purpose.startsWith('spell_damage')).expression, '9d8', 'ячейка шестого круга добавляет кость')
  assert.equal(upcast.events.find((event) => event.event_type === 'ResourceSpent').payload.resource, 'spell_slots_6')
})

test('Туманный шаг переносит бонусным действием и только в свободную видимую клетку', () => {
  const state = areaState()
  const step = castArea(state, 'misty-step', [], { x: 4, y: 3 })
  const moved = step.events.find((event) => event.event_type === 'ActorMoved')
  assert.equal(moved.payload.teleport, true)
  assert.deepEqual(moved.payload.to, { x: 4, y: 3 })
  assert.equal(moved.payload.distance, 0, 'телепорт не тратит перемещение')
  const spent = step.events.find((event) => event.event_type === 'ResourceSpent')
  assert.equal(spent.payload.resource, 'spell_slots_2')

  assert.throws(
    () => castArea(state, 'misty-step', [], { x: 5, y: 1 }),
    (error) => error.code === 'INVALID_DESTINATION',
    'занятую клетку телепорт занимать не имеет права',
  )
  assert.throws(
    () => castArea(state, 'misty-step', [], { x: 9, y: 3 }),
    (error) => error.code === 'TARGET_OUT_OF_RANGE',
    'дальность 30 футов обязана проверяться сервером',
  )
})

test('Ледяной шторм роняет ничком и делает область труднопроходимой', () => {
  const state = areaState()
  // Радиус 20 футов — четыре клетки, поэтому центр вынесен за спину врагам:
  // иначе шторм накрыл бы и заклинателя.
  const cast = castArea(state, 'sleet-storm', [3, 4], { x: 8, y: 1 })
  const prone = cast.events.filter((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'prone')
  assert.equal(prone.length, 2, 'область обязана накрыть обоих врагов и не задеть заклинателя')
  const area = cast.events.find((event) => event.event_type === 'SpellAreaCreated')
  assert.equal(area.payload.effect.difficult_terrain, true)
  assert.equal(area.payload.effect.trigger_on_enter, true)
  assert.equal(area.payload.effect.trigger_on_turn_end, true)
  assert.equal(area.payload.effect.condition, 'prone')

  // Ползание удваивает цену шага, а труднопроходимость добавляет ещё пять футов,
  // поэтому перемещение упавшего внутри шторма обязано упереться в скорость.
  const stormed = replayEvents(state, cast.events)
  const thugsTurn = { ...stormed, mechanics: { ...stormed.mechanics, combat: { ...stormed.mechanics.combat, active_index: 1 } } }
  assert.throws(
    () => resolveCommand(authoritative({ command_type: 'MoveActor', actor_id: 'thug', to: { x: 1, y: 3 } }), thugsTurn, options(dice())),
    (error) => error.code === 'SPEED_EXCEEDED',
  )
})

test('Слепота/глухота накладывает именно выбранный эффект', () => {
  const blinded = hold(controlState(), [8], { spell_id: 'blindness-deafness', spell_option: 'blinded' })
  assert.equal(saveEvent(blinded).payload.ability, 'con')
  const blindedCondition = blinded.events.find((event) => event.event_type === 'ConditionAdded')
  assert.equal(blindedCondition.payload.condition, 'blinded')
  assert.equal(blindedCondition.payload.duration, 'rounds:10')

  const deafened = hold(controlState(), [8], { spell_id: 'blindness-deafness', spell_option: 'deafened' })
  const applied = deafened.events.filter((event) => event.event_type === 'ConditionAdded').map((event) => event.payload.condition)
  assert.deepEqual(applied, ['deafened'], 'выбор глухоты не имеет права ослеплять цель')

  assert.throws(
    () => hold(controlState(), [8], { spell_id: 'blindness-deafness' }),
    (error) => error.code === 'SPELL_OPTION_REQUIRED',
    'сервер обязан требовать выбор эффекта',
  )
})

test('Цепная молния бьёт по четырём целям и делит урон при успешном спасброске', () => {
  const state = areaState()
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'mage', spell_id: 'chain-lightning', target_id: 'thug', target_ids: ['thug', 'thug-two'] }),
    normalizeCampaignState({ ...state, players: [{ ...state.players[0], level: 12 }] }),
    options(dice([...Array.from({ length: 10 }, () => 5), 20, 2])),
  )
  const rolled = cast.rolls.find((entry) => entry.purpose.startsWith('spell_damage'))
  assert.equal(rolled.expression, '10d8')
  const damages = cast.events.filter((event) => event.event_type === 'DamageApplied')
  assert.equal(damages.length, 2)
  const saved = damages.find((event) => event.payload.saved === true)
  const failed = damages.find((event) => event.payload.saved === false)
  assert.equal(failed.payload.raw_amount, 50)
  assert.equal(saved.payload.raw_amount, 25)
  assert.equal(failed.payload.damage_type, 'lightning')
})

test('Незримый путь добавляет +10 к Скрытности и меняет решение о внезапности', () => {
  const state = controlState()
  const druid = normalizeCampaignState({
    ...state,
    players: [{ ...state.players[0], characterClass: 'druid', level: 9, proficiency: 4 }, state.players[1]],
  })
  const cast = resolveCommand(
    authoritative({ command_type: 'CastSpell', actor_id: 'cleric', spell_id: 'pass-without-trace', target_id: 'fighter', target_ids: ['fighter'] }),
    druid,
    options(dice()),
  )
  const veiled = cast.events.find((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'pass-without-trace')
  assert.deepEqual(veiled.target_ids, ['fighter'])

  const covered = replayEvents(druid, cast.events)
  const ended = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: 'cleric' }), covered, options(dice()))
  const hidden = resolveCommand(
    authoritative({ command_type: 'UseCombatAction', actor_id: 'fighter', action_id: 'hide' }),
    replayEvents(covered, ended.events),
    options(dice([6])),
  )
  // Ловкость 12 (+1), владение Скрытностью (+3) и пелена (+10).
  const check = hidden.events.find((event) => event.event_type === 'AbilityCheckResolved')
  assert.equal(check.payload.modifier, 1 + 3 + 10, 'к модификатору Ловкости обязан добавиться бонус пелены')
  assert.equal(hidden.events.find((event) => event.event_type === 'ConditionAdded').payload.check_total, 20)
})

test('площадные заклинания второго и третьего круга исполняются сервером целиком', () => {
  const cases = [
    { id: 'snilloc-s-snowball-swarm', to: { x: 5, y: 1 }, expression: '3d6', type: 'cold', slot: 'spell_slots_2' },
    { id: 'erupting-earth', to: { x: 5, y: 1 }, expression: '3d12', type: 'bludgeoning', slot: 'spell_slots_3' },
  ]
  for (const entry of cases) {
    const cast = castArea(areaState(), entry.id, [...Array.from({ length: 12 }, () => 3), 20, 2], entry.to)
    const rolled = cast.rolls.find((roll) => roll.purpose.startsWith('spell_damage'))
    assert.equal(rolled.expression, entry.expression, `${entry.id}: неверная формула урона`)
    assert.equal(cast.events.find((event) => event.event_type === 'ResourceSpent').payload.resource, entry.slot)
    const damages = cast.events.filter((event) => event.event_type === 'DamageApplied')
    assert.ok(damages.length >= 1, `${entry.id}: область никого не задела`)
    assert.equal(damages[0].payload.damage_type, entry.type)
    const saved = damages.find((event) => event.payload.saved === true)
    if (saved) assert.equal(saved.payload.raw_amount, Math.floor(rolled.total / 2), `${entry.id}: успех обязан делить урон пополам`)
  }
})

test('Град снарядов доступен следопыту и накрывает конус', () => {
  const state = areaState()
  const ranger = normalizeCampaignState({
    ...state,
    players: [{ ...state.players[0], characterClass: 'ranger', level: 9, proficiency: 4, abilities: { ...state.players[0].abilities, wis: 18 } }],
  })
  const cast = castArea(ranger, 'conjure-barrage', [...Array.from({ length: 3 }, () => 3), 20, 2], { x: 8, y: 1 })
  assert.equal(cast.rolls.find((roll) => roll.purpose.startsWith('spell_damage')).expression, '3d8')
  assert.equal(cast.events.find((event) => event.event_type === 'ResourceSpent').payload.resource, 'spell_slots_3')
  assert.ok(cast.events.some((event) => event.event_type === 'DamageApplied' && event.payload.damage_type === 'bludgeoning'))
})

test('Сковывающий лёд Рима и ранит, и обездвиживает провалившего спасбросок', () => {
  const state = areaState()
  const cast = castArea(state, 'rime-s-binding-ice', [...Array.from({ length: 3 }, () => 4), 2, 20], { x: 7, y: 1 })
  const restrained = cast.events.filter((event) => event.event_type === 'ConditionAdded' && event.payload.condition === 'restrained')
  assert.equal(restrained.length, 1, 'сковывает только провалившего спасбросок')
  const damages = cast.events.filter((event) => event.event_type === 'DamageApplied')
  assert.equal(damages.length, 2, 'урон получают обе цели')
  const frozen = restrained[0].target_ids[0]
  const iced = replayEvents(state, cast.events)
  const index = iced.mechanics.combat.initiative.findIndex((entry) => entry.actor_id === frozen)
  assert.throws(
    () => resolveCommand(
      authoritative({ command_type: 'MoveActor', actor_id: frozen, to: { x: 7, y: 3 } }),
      { ...iced, mechanics: { ...iced.mechanics, combat: { ...iced.mechanics.combat, active_index: index } } },
      options(dice()),
    ),
    (error) => error.code === 'SPEED_IS_ZERO',
  )
})

test('исход удержания одинаков после replay', () => {
  const state = controlState()
  const result = hold(state, [12])
  assert.deepEqual(replayEvents(state, result.events), result.events.reduce(applyGameEvent, state))
})
