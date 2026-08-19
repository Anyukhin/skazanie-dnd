// Волна «магия за пределами удара»: заклинания, которые двигают не хиты, а
// мир — замок, свет, предел хитов, состояния, чужой эффект и лечащую область.
//
// Сторож держит один и тот же контракт для каждого: команда рождает событие,
// реплей события даёт то же состояние, а отказ по цели или дальности приходит
// раньше, чем тратится ячейка. Отдельно проверяется обратная сторона: карточки,
// которым движку нечего исполнить, обязаны отказывать **с названной причиной**,
// а не общей формулой «пока не размечено».
import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { LOCKPICK_NOISE_SEVERITY } from '../server/lockpicking.mjs'
import { RulesValidationError, applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { sceneInteractionDefinition } from '../server/scene-interactions.mjs'
import { addProp, createTacticalMap, deserializeTacticalMap, serializeTacticalMap, setCell, setDoor } from '../server/tactical-map.mjs'
import { timeOfDayOf } from '../server/weather.mjs'

function dice(values = Array.from({ length: 80 }, () => 10)) {
  let id = 0
  return new DiceService({ rng: new SequenceDiceRng(values), idFactory: () => `utility-roll-${++id}`, now: () => '2026-08-18T12:00:00.000Z' })
}

const options = (values) => ({ diceService: dice(values), context: { serverAuthoritativeCombat: true, isAdmin: true } })

let commandCounter = 0
function cast(state, command, values) {
  commandCounter += 1
  return resolveCommand(
    { campaign_id: 'utility-1', command_id: `cmd-${commandCounter}`, server_authoritative: true, ...command },
    state,
    options(values),
  )
}

function rejects(state, command, code, values) {
  assert.throws(
    () => cast(state, command, values),
    (error) => error instanceof RulesValidationError && error.code === code,
    `${command.command_type}/${command.spell_id ?? ''} ожидал ${code}`,
  )
}

const applyAll = (state, events) => events.reduce((current, event) => applyGameEvent(current, event), state)
const typesOf = (events) => events.map((event) => event.event_type)
const conditionsOf = (state, id) => (state.mechanics.conditions[id] ?? []).map((condition) => condition.id)

/** Вернуть заклинателю действие: два применения подряд — приём теста, а не правило. */
function refreshed(state, id = 'caster') {
  state.mechanics.combat.action_economy[id] = { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 }
  return state
}

/**
 * Ровное поле без карты: заклинатель, союзник и двое противников. Класс и
 * уровень задаются вызывающим — круг ячейки у каждой карточки свой, и ниже
 * своего круга её не произнести.
 */
function field({ characterClass = 'cleric', level = 5, combat = true, scene = {}, mechanics = {} } = {}) {
  const cells = Array.from({ length: 100 }, (_, index) => ({ x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true }))
  return normalizeCampaignState({
    sessionCode: 'UTILITY-1',
    campaign_id: 'utility-1',
    partyMemberIds: ['caster', 'ally'],
    players: [
      { id: 'caster', character: 'Заклинатель', characterClass, level, hp: 30, maxHp: 30, armor: 14, speed: 30, proficiency: 3, abilities: { str: 10, dex: 12, con: 14, int: 16, wis: 18, cha: 16 }, inventory: [], x: 1, y: 1 },
      { id: 'ally', character: 'Союзник', characterClass: 'fighter', level: 5, hp: 10, maxHp: 40, armor: 16, speed: 30, proficiency: 3, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 10 }, inventory: [], x: 2, y: 1 },
    ],
    enemies: [
      { id: 'foe', name: 'Враг', hp: 30, maxHp: 30, armor: 13, speed: 30, attackBonus: 5, damageDice: 6, damageBonus: 2, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, x: 3, y: 1, alive: true },
      { id: 'far-foe', name: 'Дальний враг', hp: 30, maxHp: 30, armor: 13, speed: 30, attackBonus: 5, damageDice: 6, damageBonus: 2, abilities: { str: 14, dex: 12, con: 12, int: 10, wis: 10, cha: 10 }, x: 9, y: 9, alive: true },
    ],
    scene: { turn: 1, cells, ...scene },
    mechanics: {
      world_time: { elapsed_minutes: 0 },
      ...mechanics,
      combat: combat
        ? {
          active: true, round: 1, active_index: 0,
          initiative: [{ actor_id: 'caster', total: 20 }, { actor_id: 'ally', total: 15 }, { actor_id: 'foe', total: 10 }],
          action_economy: {
            caster: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
            ally: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
            foe: { action: true, bonus_action: true, reaction: true, movement: true, movement_spent: 0 },
          },
        }
        : { active: false, round: 0, active_index: 0, initiative: [], action_economy: {} },
    },
  })
}

// ---------------------------------------------------------------------------
// Открывание: замок снимается без проверки, но громко

/** Сид, при котором сундук родился запертым и без ловушки. Подбирается, а не назначается. */
function lockedChestSeed() {
  const prop = { id: 'prop-chest', assetId: 'chest' }
  for (let index = 0; index < 10_000; index += 1) {
    const seed = `knock-${index}`
    const definition = sceneInteractionDefinition({ mapSeed: seed, props: [prop], propId: prop.id })
    if (definition.lock && !definition.trap) return seed
  }
  throw new Error('Не найден сид запертого сундука без ловушки')
}

const CHEST_SEED = lockedChestSeed()

/** Запертая дверь на восточном ребре (3,1), запертый сундук в (2,1), волшебник в (1,1). */
function vault({ witnesses = false, doorState = 'locked' } = {}) {
  const map = createTacticalMap({ width: 7, height: 4, locationId: 'vault', seed: CHEST_SEED, sizeClass: 'arena' })
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 7; x += 1) {
      setCell(map, x, y, { passable: !(x === 0 || y === 0 || x === 6 || y === 3), material: 'stone', revealed: true })
    }
  }
  addProp(map, { id: 'prop-chest', assetId: 'chest', x: 2.5, y: 1.5, footprint: [{ x: 2, y: 1 }], interactive: true })
  setDoor(map, { id: 'door-vault', x: 3, y: 1, dir: 'e', state: doorState, lockDc: 15, blocksMove: true, blocksSight: true })
  return normalizeCampaignState({
    sessionCode: 'KNOCK-1',
    campaign_id: 'utility-1',
    partyMemberIds: ['caster'],
    players: [{
      id: 'caster', character: 'Ильма', characterClass: 'wizard', level: 5, hp: 20, maxHp: 20,
      armor: 12, speed: 30, proficiency: 3, x: 3, y: 1,
      abilities: { str: 10, dex: 14, con: 12, int: 16, wis: 10, cha: 10 }, inventory: [],
    }],
    social: { npcs: witnesses ? [{ id: 'npc-1', name: 'Горазд', role: 'купец', location: 'Хранилище', available: true, visibility: 'party' }] : [] },
    scene: { turn: 1, location: 'Хранилище', locationId: 'vault', map: serializeTacticalMap(map) },
    mechanics: { world_time: { elapsed_minutes: 0 }, positions: { caster: { x: 3, y: 1 } }, combat: { active: false } },
  })
}

const doorStateOf = (state) => deserializeTacticalMap(state.scene.map).doors.find((door) => door.id === 'door-vault')?.state

test('Открывание снимает замок двери без единой проверки и переживает реплей', () => {
  const state = vault()
  assert.equal(doorStateOf(state), 'locked')
  const result = cast(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'knock', to: { x: 3, y: 1 } })

  // Ни одного броска: заклинание обходит СЛ замка, а не облегчает её.
  assert.ok(!typesOf(result.events).includes('AbilityCheckResolved'), 'у Открывания нет проверки')
  const changed = result.events.find((event) => event.event_type === 'DoorStateChanged')
  assert.equal(changed.payload.previous_state, 'locked')
  assert.equal(changed.payload.state, 'closed')
  assert.equal(changed.payload.method, 'knock')

  const after = replayEvents(state, result.events)
  assert.equal(doorStateOf(after), 'closed', 'замка больше нет, но створка закрыта')
  assert.equal(after.mechanics.resources.caster.spell_slots_2.current, 2, 'ячейка второго круга потрачена')

  // Створку теперь открывают рукой — тем же обычным действием, что и всегда.
  const opened = cast(after, { command_type: 'OperateDoor', actor_id: 'caster', door_id: 'door-vault', intent: 'open' })
  assert.equal(doorStateOf(replayEvents(after, opened.events)), 'open')
})

test('Открывание снимает замок сундука, не открывая его: добыча и ловушка остаются на обычном пути', () => {
  const state = vault()
  const result = cast(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'knock', to: { x: 2, y: 1 } })
  const changed = result.events.find((event) => event.event_type === 'SceneObjectStateChanged')
  assert.equal(changed.payload.prop_id, 'prop-chest')
  assert.equal(changed.payload.previous_state, 'locked')
  assert.equal(changed.payload.state, 'closed')
  assert.ok(!typesOf(result.events).includes('SceneObjectLootRevealed'), 'заклинание не вскрывает содержимое')

  const after = replayEvents(state, result.events)
  assert.equal(after.mechanics.scene_interactions['prop-chest'].state, 'closed')
})

test('стук Открывания зовёт свидетелей самой громкой ступенью шума, и всегда', () => {
  const quiet = cast(vault(), { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'knock', to: { x: 3, y: 1 } })
  assert.ok(!typesOf(quiet.events).includes('LockpickNoticed'), 'в пустом подземелье стук никого не обидел')

  const heard = cast(vault({ witnesses: true }), { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'knock', to: { x: 3, y: 1 } })
  const noticed = heard.events.find((event) => event.event_type === 'LockpickNoticed')
  assert.equal(noticed.payload.severity, LOCKPICK_NOISE_SEVERITY.fumble, 'у грохота нет исхода «получилось тихо»')
  assert.equal(noticed.payload.loud, true)
  assert.deepEqual(noticed.payload.witness_ids, ['npc-1'])
})

test('Открывание отказывается там, где замка нет, и там, куда не дотянуться', () => {
  rejects(vault({ doorState: 'closed' }), { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'knock', to: { x: 4, y: 1 } }, 'NO_LOCK_TO_OPEN')
  // Шестьдесят футов — двенадцать клеток; карта хранилища меньше, поэтому
  // дальность проверяется на ровном поле.
  const wizard = field({ characterClass: 'wizard', level: 5, combat: false })
  rejects(wizard, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'knock', to: { x: 9, y: 9 } }, 'NO_LOCK_TO_OPEN')
})

// ---------------------------------------------------------------------------
// Свет: единственная темнота, выраженная в движке числом

/** Мировая минута, на которую приходится ночь. */
function nightMinutes() {
  for (let minute = 0; minute < 1_440; minute += 10) {
    if (timeOfDayOf(minute) === 'night') return minute
  }
  throw new Error('Ночь не найдена на шкале суток')
}

const NIGHT = nightMinutes()

const outdoorsAtNight = () => field({
  characterClass: 'cleric', level: 5, combat: false,
  scene: { scene_kind: 'wilderness', location: 'Поле' },
  mechanics: { world_time: { elapsed_minutes: NIGHT } },
})

const perceptionCheck = (state, actorId) => cast(state, {
  command_type: 'MakeAbilityCheck', actor_id: actorId, ability: 'wis', skill: 'perception', difficulty: 12,
}, [5, 18])

test('Свет вешает маркер с часовой длительностью по мировым часам', () => {
  const state = outdoorsAtNight()
  const result = cast(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'light', target_id: 'caster', target_ids: ['caster'] })
  const added = result.events.find((event) => event.event_type === 'ConditionAdded')
  assert.equal(added.payload.condition, 'light')
  assert.equal(added.payload.duration, 'minutes:60')
  assert.equal(added.payload.expires_at_minutes, NIGHT + 60)

  const lit = replayEvents(state, result.events)
  assert.ok(conditionsOf(lit, 'caster').includes('light'))
  // Заговор ячейки не тратит.
  assert.deepEqual(lit.mechanics.resources.caster.spell_slots_1, state.mechanics.resources.caster.spell_slots_1)
})

test('Свет снимает ночную помеху Восприятию — себе и тем, кто рядом, — и гаснет через час', () => {
  const dark = outdoorsAtNight()
  assert.equal(perceptionCheck(dark, 'caster').events[0].payload.weather_disadvantage, 'ночь')

  const lit = replayEvents(dark, cast(dark, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'light', target_id: 'caster', target_ids: ['caster'] }).events)
  assert.equal(perceptionCheck(lit, 'caster').events[0].payload.weather_disadvantage, undefined, 'носитель огонька видит без помехи')
  assert.equal(perceptionCheck(lit, 'ally').events[0].payload.weather_disadvantage, undefined, 'сосед в круге света — тоже')
  assert.equal(perceptionCheck(lit, 'far-foe').events[0].payload.weather_disadvantage, 'ночь', 'а тот, кто далеко, остаётся в темноте')

  const later = applyAll(lit, cast(lit, { command_type: 'AdvanceTime', actor_id: 'caster', amount: 61, unit: 'minute' }).events)
  assert.ok(!conditionsOf(later, 'caster').includes('light'), 'через час огонёк гаснет сам')
  assert.equal(perceptionCheck(later, 'caster').events[0].payload.weather_disadvantage, 'ночь')
})

// ---------------------------------------------------------------------------
// Подмога: предел хитов до продолжительного отдыха

test('Подмога поднимает предел и текущие хиты троим и возвращает их продолжительным отдыхом', () => {
  const state = field({ characterClass: 'cleric', level: 5, combat: false })
  const result = cast(state, {
    command_type: 'CastSpell', actor_id: 'caster', spell_id: 'aid', target_id: 'ally', target_ids: ['caster', 'ally'],
  })
  const raised = result.events.filter((event) => event.event_type === 'HitPointMaximumIncreased')
  assert.deepEqual(raised.map((event) => event.target_ids[0]), ['caster', 'ally'])
  assert.equal(raised[0].payload.maximum_hp_before, 30)
  assert.equal(raised[0].payload.maximum_hp_after, 35)

  const aided = replayEvents(state, result.events)
  assert.equal(aided.players.find((player) => player.id === 'ally').maxHp, 45)
  assert.equal(aided.players.find((player) => player.id === 'ally').hp, 15, 'текущие растут вместе с пределом')
  assert.ok(conditionsOf(aided, 'ally').includes('aid-hit-point-maximum:5'))

  // Повторный реплей тех же событий обязан дать тот же лист: значения в
  // событии абсолютные, и прибавка не складывается сама с собой.
  assert.deepEqual(replayEvents(state, result.events).players, aided.players)

  const started = replayEvents(aided, cast(aided, { command_type: 'StartRest', actor_id: 'ally', kind: 'long' }).events)
  const rested = replayEvents(started, cast(started, { command_type: 'AdvanceTime', actor_id: 'ally', amount: 8, unit: 'hour' }).events)
  const completed = cast(rested, { command_type: 'CompleteRest', actor_id: 'ally', kind: 'long' })
  const morning = replayEvents(rested, completed.events)
  assert.equal(morning.players.find((player) => player.id === 'ally').maxHp, 40, 'отдых возвращает предел на место')
  assert.equal(morning.players.find((player) => player.id === 'ally').hp, 40)
  assert.ok(!conditionsOf(morning, 'ally').includes('aid-hit-point-maximum:5'))
})

test('Подмога усиливается ячейкой и отказывается от четвёртой цели', () => {
  const state = field({ characterClass: 'cleric', level: 9 })
  const upcast = cast(state, {
    command_type: 'CastSpell', actor_id: 'caster', spell_id: 'aid', target_id: 'ally', target_ids: ['ally'], slot_level: 4,
  })
  assert.equal(upcast.events.find((event) => event.event_type === 'HitPointMaximumIncreased').payload.applied_amount, 15)

  rejects(state, {
    command_type: 'CastSpell', actor_id: 'caster', spell_id: 'aid', target_id: 'ally', target_ids: ['caster', 'ally', 'foe', 'far-foe'],
  }, 'TOO_MANY_SPELL_TARGETS')
  rejects(state, {
    command_type: 'CastSpell', actor_id: 'caster', spell_id: 'aid', target_id: 'foe', target_ids: ['foe'],
  }, 'INVALID_SPELL_TARGET')
})

// ---------------------------------------------------------------------------
// Полное исцеление: плоские 70 и снятие слепоты с глухотой

test('Полное исцеление возвращает ровно 70 хитов без броска и снимает слепоту и глухоту', () => {
  const state = field({ characterClass: 'cleric', level: 11, mechanics: { conditions: { ally: [{ id: 'blinded' }, { id: 'deafened' }, { id: 'poisoned' }] } } })
  const result = cast(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'heal', target_id: 'ally', target_ids: ['ally'] })

  assert.ok(!typesOf(result.events).includes('DieRolled'), 'семьдесят хитов — не кость')
  const healed = result.events.find((event) => event.event_type === 'HealingApplied')
  assert.equal(healed.payload.requested_amount, 70)
  assert.equal(healed.payload.applied_amount, 30, 'выше максимума хиты не растут')

  const after = replayEvents(state, result.events)
  assert.equal(after.players.find((player) => player.id === 'ally').hp, 40)
  assert.deepEqual(conditionsOf(after, 'ally'), ['poisoned'], 'болезнь и отравление заклинанию не подчиняются')
})

test('Полное исцеление требует союзника, а лечение касанием — вытянутой руки', () => {
  const state = field({ characterClass: 'cleric', level: 11 })
  rejects(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'heal', target_id: 'foe', target_ids: ['foe'] }, 'INVALID_SPELL_TARGET')

  // Высшее восстановление творится касанием: три клетки — уже не касание.
  const far = field({ characterClass: 'cleric', level: 9 })
  far.mechanics.positions.ally = { x: 4, y: 1 }
  rejects(
    far,
    { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'greater-restoration', target_id: 'ally', target_ids: ['ally'], spell_option: 'charmed' },
    'TARGET_OUT_OF_RANGE',
  )
})

// ---------------------------------------------------------------------------
// Высшее восстановление: одно из трёх, и истощение — на ступень

test('Высшее восстановление снимает выбранное состояние и требует выбора', () => {
  const state = field({ characterClass: 'cleric', level: 9, mechanics: { conditions: { ally: [{ id: 'charmed' }, { id: 'petrified' }] } } })
  rejects(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'greater-restoration', target_id: 'ally', target_ids: ['ally'] }, 'SPELL_OPTION_REQUIRED')

  const cured = cast(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'greater-restoration', target_id: 'ally', target_ids: ['ally'], spell_option: 'petrified' })
  assert.deepEqual(
    cured.events.filter((event) => event.event_type === 'ConditionRemoved').map((event) => event.payload.condition),
    ['petrified'],
  )
  assert.deepEqual(conditionsOf(replayEvents(state, cured.events), 'ally'), ['charmed'])
})

test('Высшее восстановление опускает истощение ровно на одну ступень', () => {
  const state = field({ characterClass: 'cleric', level: 9, mechanics: { conditions: { ally: [{ id: 'exhaustion:3', duration: 'until-removed' }] } } })
  const result = cast(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'greater-restoration', target_id: 'ally', target_ids: ['ally'], spell_option: 'exhaustion' })
  const after = replayEvents(state, result.events)
  assert.deepEqual(conditionsOf(after, 'ally'), ['exhaustion:2'], 'третья ступень становится второй, а не исчезает')

  const last = field({ characterClass: 'cleric', level: 9, mechanics: { conditions: { ally: [{ id: 'exhaustion:1', duration: 'until-removed' }] } } })
  const cleared = replayEvents(last, cast(last, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'greater-restoration', target_id: 'ally', target_ids: ['ally'], spell_option: 'exhaustion' }).events)
  assert.deepEqual(conditionsOf(cleared, 'ally'), [], 'с первой ступени истощение уходит совсем')

  const healthy = field({ characterClass: 'cleric', level: 9 })
  const nothing = cast(healthy, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'greater-restoration', target_id: 'ally', target_ids: ['ally'], spell_option: 'exhaustion' })
  assert.ok(!typesOf(nothing.events).includes('ConditionRemoved'), 'снятие того, чего нет, событий не создаёт')
})

// ---------------------------------------------------------------------------
// Рассеивание магии

test('Рассеивание магии убирает чужую область без проверки, пока её круг не выше ячейки', () => {
  const wizard = field({ characterClass: 'wizard', level: 7 })
  const greased = refreshed(replayEvents(wizard, cast(wizard, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'grease', to: { x: 4, y: 1 } }, [1, 1, 1, 1]).events))
  assert.ok(greased.mechanics.active_effects.some((effect) => effect.spell_id === 'grease'))

  const result = cast(greased, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'dispel-magic', to: { x: 4, y: 1 } })
  assert.ok(!typesOf(result.events).includes('AbilityCheckResolved'), 'первый круг ниже третьего — проверки нет')
  assert.ok(result.events.some((event) => event.event_type === 'SpellAreaRemoved' && event.payload.reason === 'dispelled'))

  const clear = replayEvents(greased, result.events)
  assert.ok(!clear.mechanics.active_effects.some((effect) => effect.spell_id === 'grease'))
})

test('эффект круга выше ячейки требует серверной проверки против СЛ 10 + круг', () => {
  const wizard = field({ characterClass: 'wizard', level: 7 })
  const storm = refreshed(replayEvents(wizard, cast(wizard, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'ice-storm', to: { x: 5, y: 5 } }, Array.from({ length: 40 }, () => 4)).events))
  assert.ok(storm.mechanics.active_effects.some((effect) => effect.spell_id === 'ice-storm'))

  const failed = cast(storm, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'dispel-magic', to: { x: 5, y: 5 } }, [1])
  const check = failed.events.find((event) => event.event_type === 'AbilityCheckResolved')
  assert.equal(check.payload.difficulty, 14, 'СЛ 10 + четвёртый круг')
  assert.equal(check.payload.success, false)
  assert.ok(!typesOf(failed.events).includes('SpellAreaRemoved'), 'провал ничего не рассеивает')

  const succeeded = cast(storm, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'dispel-magic', to: { x: 5, y: 5 } }, [20])
  assert.ok(typesOf(succeeded.events).includes('SpellAreaRemoved'))
})

test('Рассеивание магии прекращает концентрацию вместе с областью, которую та держит', () => {
  const druid = field({ characterClass: 'druid', level: 7 })
  const web = refreshed(replayEvents(druid, cast(druid, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'entangle', to: { x: 5, y: 5 } }, [20, 20, 20, 20]).events))
  assert.ok(web.mechanics.concentration.caster)

  const result = cast(web, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'dispel-magic', to: { x: 5, y: 5 } })
  const ended = result.events.find((event) => event.event_type === 'ConcentrationEnded')
  assert.equal(ended.payload.reason, 'dispelled')

  const after = replayEvents(web, result.events)
  assert.equal(after.mechanics.concentration.caster, undefined)
  assert.ok(!after.mechanics.active_effects.some((effect) => effect.spell_id === 'entangle'))
})

test('Рассеивание магии в пустой точке отказывает до траты ячейки', () => {
  const wizard = field({ characterClass: 'wizard', level: 7 })
  const before = wizard.mechanics.resources.caster.spell_slots_3.current
  rejects(wizard, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'dispel-magic', to: { x: 5, y: 5 } }, 'NO_MAGIC_TO_DISPEL')
  assert.equal(wizard.mechanics.resources.caster.spell_slots_3.current, before)
})

// ---------------------------------------------------------------------------
// Тьма

test('Тьма создаёт область и даёт помеху атакам изнутри и по тем, кто внутри', () => {
  const wizard = field({ characterClass: 'wizard', level: 5 })
  const result = cast(wizard, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'darkness', to: { x: 3, y: 1 } })
  const area = result.events.find((event) => event.event_type === 'SpellAreaCreated')
  assert.equal(area.payload.effect.spell_id, 'darkness')
  assert.equal(area.payload.effect.condition, 'magical-darkness')
  assert.equal(area.payload.effect.concentration, true)

  const dark = replayEvents(wizard, result.events)
  assert.ok(conditionsOf(dark, 'foe').includes('magical-darkness'), 'стоящий внутри погружается сразу')
  assert.ok(!conditionsOf(dark, 'far-foe').includes('magical-darkness'))

  dark.mechanics.combat.active_index = 2
  const swing = cast(dark, { command_type: 'MakeAttack', actor_id: 'foe', target_id: 'ally' }, [18, 4, 3])
  assert.equal(swing.events.find((event) => event.event_type === 'AttackResolved').payload.mode, 'disadvantage')
})

test('Тьма гаснет вместе с концентрацией', () => {
  const wizard = field({ characterClass: 'wizard', level: 5 })
  const dark = replayEvents(wizard, cast(wizard, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'darkness', to: { x: 3, y: 1 } }).events)
  const after = replayEvents(dark, cast(dark, { command_type: 'EndConcentration', actor_id: 'caster', reason: 'voluntary' }).events)
  assert.ok(!after.mechanics.active_effects.some((effect) => effect.spell_id === 'darkness'))
  assert.ok(!conditionsOf(after, 'foe').includes('magical-darkness'))
})

// ---------------------------------------------------------------------------
// Исцеляющий дух

test('Исцеляющий дух лечит союзника в конце его хода и не лечит противника', () => {
  const druid = field({ characterClass: 'druid', level: 5 })
  const result = cast(druid, { command_type: 'CastSpell', actor_id: 'caster', spell_id: 'healing-spirit', to: { x: 2, y: 1 } })
  const area = result.events.find((event) => event.event_type === 'SpellAreaCreated')
  assert.equal(area.payload.effect.healing, '1d6')
  assert.equal(area.payload.effect.trigger_on_turn_end, true)

  const spirited = replayEvents(druid, result.events)
  spirited.mechanics.combat.active_index = 1
  const allyTurn = cast(spirited, { command_type: 'EndTurn', actor_id: 'ally' }, [4])
  const healed = allyTurn.events.find((event) => event.event_type === 'HealingApplied')
  assert.equal(healed.payload.spell_id, 'healing-spirit')
  assert.equal(healed.payload.trigger, 'turn-end')
  assert.equal(replayEvents(spirited, allyTurn.events).players.find((player) => player.id === 'ally').hp, 14)

  // Противника, вставшего в ту же клетку, дух не лечит: выбора у сервера нет,
  // а молча поднятый враг был бы ловушкой, а не приближением правила.
  const invaded = replayEvents(druid, result.events)
  invaded.mechanics.positions.foe = { x: 2, y: 1 }
  invaded.enemies.find((enemy) => enemy.id === 'foe').hp = 10
  invaded.mechanics.combat.active_index = 2
  const foeTurn = cast(invaded, { command_type: 'EndTurn', actor_id: 'foe' }, [4])
  assert.ok(!foeTurn.events.some((event) => event.event_type === 'HealingApplied'))
})

// ---------------------------------------------------------------------------
// Заблокированные карточки обязаны называть причину

test('карточка без исполнимой механики отказывает с названной причиной, а не общей формулой', () => {
  const cases = [
    ['fly', 'wizard', 7, /высотного перемещения/u],
    ['levitate', 'wizard', 7, /высотного перемещения/u],
    ['feather-fall', 'wizard', 7, /ни высоты, ни падения/u],
    ['revivify', 'cleric', 9, /момент смерти/u],
    ['detect-magic', 'cleric', 9, /уже опознанными/u],
  ]
  for (const [spellId, characterClass, level, reason] of cases) {
    const state = field({ characterClass, level, combat: false })
    assert.throws(
      () => cast(state, { command_type: 'CastSpell', actor_id: 'caster', spell_id: spellId, target_id: 'ally', target_ids: ['ally'], to: { x: 2, y: 1 } }),
      (error) => error.code === 'RULING_REQUIRED' && reason.test(error.message),
      `${spellId} обязан объяснить, чего движку не хватает`,
    )
  }
})
