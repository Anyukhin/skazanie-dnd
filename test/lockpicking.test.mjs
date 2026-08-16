import assert from 'node:assert/strict'
import test from 'node:test'

import { DiceService } from '../server/dice-service.mjs'
import { WANTED_CRIME_POINTS } from '../server/law-and-order.mjs'
import {
  LOCKPICK_NOISE_SEVERITY,
  THIEVES_TOOLS_ID,
  hasThievesTools,
  lockpickNoiseFor,
  lockpickTraceNoticedFor,
} from '../server/lockpicking.mjs'
import { RulesValidationError, applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand } from '../server/rules-engine.mjs'
import { sceneInteractionCatalogEntry, sceneInteractionDefinition, sceneObjectOperationFromText } from '../server/scene-interactions.mjs'
import { addProp, createTacticalMap, deserializeTacticalMap, serializeTacticalMap, setCell, setDoor } from '../server/tactical-map.mjs'
import { DEED_KINDS } from '../server/world-deeds.mjs'
import { campaignStateForViewer } from '../server/viewer-projection.mjs'

const PLAYER = Object.freeze({ id: 'user-1', role: 'player' })

class FixedRng {
  constructor(value) { this.value = value }
  randint(minimum, maximum) { return Math.max(minimum, Math.min(maximum, this.value)) }
}

function dice(value = 20) {
  let id = 0
  return new DiceService({ rng: new FixedRng(value), idFactory: () => `roll-${++id}`, now: () => '2026-08-16T00:00:00.000Z' })
}

/**
 * Сид, при котором сундук родился запертым. Запертость выводится из сида карты
 * (`sceneInteractionDefinition`), поэтому подбирается, а не назначается: второго
 * пути объявить замок в проекте нет и заводить его нельзя.
 */
function lockedChestSeed() {
  const prop = { id: 'prop-chest', assetId: 'chest' }
  for (let index = 0; index < 10_000; index += 1) {
    const seed = `lockpick-${index}`
    const definition = sceneInteractionDefinition({ mapSeed: seed, props: [prop], propId: prop.id })
    if (definition.lock && !definition.trap) return seed
  }
  throw new Error('Не найден сид запертого сундука без ловушки')
}

const CHEST_SEED = lockedChestSeed()

/**
 * Две комнаты через запертую дверь, запертый сундук у героя под рукой и, по
 * желанию, живые люди в сцене.
 *
 *   0 1 2 3 4 5 6
 * 0 # # # # # # #
 * 1 # . C H|? ? #     C — сундук в (2,1), H — герой в (3,1),
 * 2 # . . # ? ? #     «|» — запертая дверь на восточном ребре, «?» — туман
 * 3 # # # # # # #
 *
 * Дальняя комната не раскрыта намеренно: именно так игрок и подходит к
 * запертой двери впервые, и только на такой карте видно, что взломанная дверь
 * действительно открывает то, что за ней.
 */
function fixture({ thief = true, witnesses = false, combat = false, doorState = 'locked', lockDc = 15 } = {}) {
  const map = createTacticalMap({ width: 7, height: 4, locationId: 'vault', seed: CHEST_SEED, sizeClass: 'arena' })
  for (let y = 0; y < 4; y += 1) {
    for (let x = 0; x < 7; x += 1) {
      const border = x === 0 || y === 0 || x === 6 || y === 3
      const partition = x === 3 && y === 2
      setCell(map, x, y, { passable: !border && !partition, material: 'stone', revealed: x < 4 })
    }
  }
  addProp(map, { id: 'prop-chest', assetId: 'chest', x: 2.5, y: 1.5, footprint: [{ x: 2, y: 1 }], interactive: true })
  setDoor(map, { id: 'door-vault', x: 3, y: 1, dir: 'e', state: doorState, lockDc, blocksMove: true, blocksSight: true })
  return normalizeCampaignState({
    sessionCode: 'LOCKPICK-1',
    partyMemberIds: ['hero'],
    members: [{ user_id: 'user-1', hero_id: 'hero', role: 'player' }],
    players: [{
      id: 'hero',
      character: 'Ильма',
      hp: 20,
      maxHp: 20,
      armor: 14,
      speed: 30,
      level: 3,
      proficiency: 2,
      x: 3,
      y: 1,
      abilities: { str: 10, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
      // Владение приходит предысторией: отдельного предмета «воровские
      // инструменты» в каталоге нет (`docs/known-limitations.md`).
      ...(thief ? { backgroundId: 'criminal' } : {}),
      inventory: [],
    }],
    social: {
      npcs: witnesses
        ? [{ id: 'npc-1', name: 'Горазд', role: 'купец', location: 'Хранилище', available: true, visibility: 'party' }]
        : [],
    },
    worldMap: {
      seed: 'vault-seed',
      regions: [{ id: 'region-1', name: 'Приречье', biome: 'plains', x: 200, y: 200, radius: 205 }],
      locations: [{ id: 'vault', name: 'Хранилище', kind: 'town', x: 200, y: 200, regionId: 'region-1' }],
      currentLocationId: 'vault',
    },
    scene: { turn: 1, location: 'Хранилище', locationId: 'vault', map: serializeTacticalMap(map) },
    mechanics: {
      positions: { hero: { x: 3, y: 1 } },
      combat: combat
        ? { active: true, round: 1, active_index: 0, initiative: [{ actor_id: 'hero', total: 18 }], action_economy: { hero: { action: true, bonus_action: true, reaction: true, movement_spent: 0 } } }
        : { active: false },
    },
  })
}

function commit(state, command, { roll = 20 } = {}) {
  const commandId = `${command.command_type}-${Math.random().toString(36).slice(2, 10)}`
  const result = resolveCommand(
    { campaign_id: 'campaign-1', command_id: commandId, server_authoritative: true, ...command },
    state,
    { diceService: dice(roll), context: { isAdmin: true, serverAuthoritativeCombat: true } },
  )
  const events = result.events.map((event, index) => ({ ...event, event_id: event.event_id ?? `${commandId}:${index + 1}` }))
  return { events, state: events.reduce(applyGameEvent, state) }
}

function rejects(state, command, code, { roll = 20 } = {}) {
  assert.throws(
    () => resolveCommand(
      { campaign_id: 'campaign-1', command_id: 'cmd-1', server_authoritative: true, ...command },
      state,
      { diceService: dice(roll), context: { isAdmin: true, serverAuthoritativeCombat: true } },
    ),
    (error) => error instanceof RulesValidationError && error.code === code,
    `${command.command_type}/${command.intent} ожидал ${code}`,
  )
}

const eventTypes = (events) => events.map((event) => event.event_type)
const doorStateOf = (state) => deserializeTacticalMap(state.scene.map).doors.find((door) => door.id === 'door-vault')?.state
const deedsOf = (state) => (state.world_deeds?.deeds ?? [])

const pickDoor = (state, options) => commit(state, { command_type: 'OperateDoor', actor_id: 'hero', door_id: 'door-vault', intent: 'lockpick' }, options)
const pickChest = (state, options) => commit(state, { command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-chest', intent: 'lockpick' }, options)

// ---------------------------------------------------------------------------
// Владение инструментами

test('владение читается из предыстории, а не из рюкзака, и других способов нет', () => {
  assert.equal(hasThievesTools({ backgroundId: 'criminal' }), true)
  assert.equal(hasThievesTools({ backgroundId: 'wayfarer' }), true)
  assert.equal(hasThievesTools({ backgroundId: 'sage' }), false)
  assert.equal(hasThievesTools({ backgroundId: 'нет-такой' }), false)
  assert.equal(hasThievesTools({}), false)
  assert.equal(hasThievesTools(null), false)
  // Уже достроенный разбор предыстории принимается как готовый ответ, а
  // перенесённый лист — своим списком инструментов.
  assert.equal(hasThievesTools({ backgroundBenefits: { tool_proficiency: THIEVES_TOOLS_ID } }), true)
  assert.equal(hasThievesTools({ toolProficiencies: ['herbalism_kit', THIEVES_TOOLS_ID] }), true)
  assert.equal(hasThievesTools({ toolProficiencies: ['herbalism_kit'] }), false)
  // Ловкость рук — навык, а не инструмент: одним им замок не вскрыть.
  assert.equal(hasThievesTools({ classSkillProficiencies: ['sleight_of_hand'] }), false)
})

// ---------------------------------------------------------------------------
// Контейнер

test('без владения сундук отмычкой не вскрыть, а сила остаётся доступной', () => {
  const state = fixture({ thief: false })
  rejects(state, { command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-chest', intent: 'lockpick' }, 'THIEVES_TOOLS_REQUIRED')
  // «Открыть» на запертом больше не катает Ловкость рук молча: путей ровно два
  // и оба названы отказом.
  rejects(state, { command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-chest', intent: 'open' }, 'SCENE_OBJECT_LOCKED')
  // Сила — как была: ветка server-authoritative, СЛ замка та же, ход тратится.
  const forced = commit(state, {
    command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-chest', intent: 'open', approach: 'force',
  }, { roll: 20 })
  assert.ok(eventTypes(forced.events).includes('SceneObjectLootRevealed'), 'сила обязана остаться рабочим путём')
  const check = forced.events.find((event) => event.event_type === 'SceneObjectCheckResolved')
  assert.equal(check.payload.skill, 'athletics')
})

test('владеющий вскрывает сундук отмычкой: бонус мастерства, след в памяти сцены и находка', () => {
  const state = fixture()
  const picked = pickChest(state, { roll: 20 })
  const check = picked.events.find((event) => event.event_type === 'SceneObjectCheckResolved')
  assert.equal(check.payload.ability, 'dex')
  // Ловкость 14 (+2) и бонус мастерства +2 за инструмент: навыком герой не
  // владеет, и бонус всё равно есть — его даёт владение инструментом.
  assert.equal(check.payload.modifier, 4)
  assert.ok(eventTypes(picked.events).includes('SceneObjectLootRevealed'))
  const changed = picked.events.find((event) => event.event_type === 'SceneObjectStateChanged')
  assert.equal(changed.payload.state, 'open')
  assert.equal(changed.payload.lockpicked, true)
  const trace = picked.state.mechanics.scene_interactions['prop-chest']
  assert.equal(trace.lockpicked, true)
  assert.equal(trace.lockpicked_by, 'hero')
  assert.equal(trace.opened, true)
})

test('незапертому сундуку отмычка не нужна, и отказ не стоит ни хода, ни броска', () => {
  const state = fixture()
  const opened = pickChest(state, { roll: 20 })
  rejects(opened.state, { command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-chest', intent: 'lockpick' }, 'SCENE_OBJECT_ALREADY_OPEN')
  // Сундук без замка честно об этом говорит, а не катает бросок впустую.
  const unlockedSeed = (() => {
    for (let index = 0; index < 10_000; index += 1) {
      const seed = `unlocked-${index}`
      if (!sceneInteractionDefinition({ mapSeed: seed, props: [{ id: 'prop-chest', assetId: 'chest' }], propId: 'prop-chest' }).lock) return seed
    }
    throw new Error('Не найден сид незапертого сундука')
  })()
  const plain = structuredClone(state)
  const map = deserializeTacticalMap(plain.scene.map)
  map.seed = unlockedSeed
  plain.scene.map = serializeTacticalMap(map)
  rejects(plain, { command_type: 'OperateSceneObject', actor_id: 'hero', prop_id: 'prop-chest', intent: 'lockpick' }, 'SCENE_OBJECT_NOT_LOCKED')
})

// ---------------------------------------------------------------------------
// Дверь

test('дверь под отмычкой: без владения отказ, с владением — проверка против lockDc', () => {
  rejects(fixture({ thief: false }), { command_type: 'OperateDoor', actor_id: 'hero', door_id: 'door-vault', intent: 'lockpick' }, 'THIEVES_TOOLS_REQUIRED')
  const picked = pickDoor(fixture({ combat: true }), { roll: 20 })
  const event = picked.events.find((item) => item.event_type === 'DoorLockpicked')
  assert.equal(event.payload.success, true)
  assert.equal(event.payload.difficulty, 15)
  assert.equal(event.payload.previous_state, 'locked')
  // Дверь **взломана**, а не выломана: полотно цело, и это отличимо от силы.
  assert.equal(doorStateOf(picked.state), 'open')
  assert.equal(picked.state.mechanics.combat.action_economy.hero.action, false, 'взлом стоит действия')
  const trace = picked.state.mechanics.scene_interactions['door:door-vault']
  assert.equal(trace.lockpicked, true)
  assert.equal(trace.state, 'lockpicked')
  assert.ok(eventTypes(picked.events).includes('AreaRevealed'), 'открытая дверь обязана раскрыть комнату за собой')
})

test('неудачный взлом двери стоит хода, дверь остаётся запертой и следа не оставляет', () => {
  const failed = pickDoor(fixture({ combat: true, lockDc: 25 }), { roll: 2 })
  assert.equal(failed.events.find((item) => item.event_type === 'DoorLockpicked').payload.success, false)
  assert.equal(doorStateOf(failed.state), 'locked')
  assert.equal(failed.state.mechanics.combat.action_economy.hero.action, false)
  assert.equal(failed.state.mechanics.scene_interactions['door:door-vault'], undefined)
})

test('взломанная дверь отличима от выломанной и в состоянии, и в летописи поступков', () => {
  const picked = pickDoor(fixture({ witnesses: true }), { roll: 20 })
  const forced = commit(fixture({ witnesses: true }), { command_type: 'OperateDoor', actor_id: 'hero', door_id: 'door-vault', intent: 'force' }, { roll: 20 })
  assert.equal(doorStateOf(picked.state), 'open')
  assert.equal(doorStateOf(forced.state), 'broken')
  assert.equal(deedsOf(forced.state).at(-1).kind, 'destruction')
  // Тихо снятый замок разрушением не считается: ломать было нечего.
  assert.equal(deedsOf(picked.state).some((deed) => deed.kind === 'destruction'), false)
  // Взломанную дверь можно закрыть обратно; выломанную — нет.
  assert.ok(commit(picked.state, { command_type: 'OperateDoor', actor_id: 'hero', door_id: 'door-vault', intent: 'close' }).events.length)
  rejects(forced.state, { command_type: 'OperateDoor', actor_id: 'hero', door_id: 'door-vault', intent: 'close' }, 'DOOR_BROKEN')
})

test('незапертую дверь взламывать нечего', () => {
  rejects(fixture({ doorState: 'closed' }), { command_type: 'OperateDoor', actor_id: 'hero', door_id: 'door-vault', intent: 'lockpick' }, 'DOOR_NOT_LOCKED')
})

// ---------------------------------------------------------------------------
// Шум, свидетели и летопись

test('ступень шума считается политикой, а не броском: провал — мелочь, натуральная единица — громче', () => {
  assert.equal(lockpickNoiseFor({ success: true, natural: 1 }), null, 'удачный взлом не шумит')
  assert.equal(lockpickNoiseFor({ success: false, natural: 7 }).severity, LOCKPICK_NOISE_SEVERITY.failure)
  assert.equal(lockpickNoiseFor({ success: false, natural: 1 }).severity, LOCKPICK_NOISE_SEVERITY.fumble)
  assert.equal(lockpickNoiseFor({ success: false, natural: 1 }).loud, true)
})

test('провал при живых людях в сцене — поступок «взлом» мелкой ступени, а натуральная единица поднимает ступень', () => {
  const quiet = pickDoor(fixture({ lockDc: 25 }), { roll: 5 })
  assert.equal(eventTypes(quiet.events).includes('LockpickNoticed'), false, 'в пустой сцене шум некому услышать')
  assert.equal(deedsOf(quiet.state).length, 0)

  const heard = pickDoor(fixture({ witnesses: true, lockDc: 25 }), { roll: 5 })
  const noticed = heard.events.find((event) => event.event_type === 'LockpickNoticed')
  assert.equal(noticed.payload.reason, 'noise')
  assert.equal(noticed.payload.severity, 'minor')
  assert.deepEqual(noticed.payload.witness_ids, ['npc-1'])
  const minorDeed = deedsOf(heard.state).at(-1)
  assert.equal(minorDeed.kind, 'break_in')
  assert.equal(minorDeed.severity, 'minor')
  assert.deepEqual(minorDeed.witness_ids, ['npc-1'])
  assert.equal(minorDeed.secret, false)
  assert.match(minorDeed.summary, /взлом отмычками/u)

  const fumbled = pickDoor(fixture({ witnesses: true, lockDc: 25 }), { roll: 1 })
  const loud = fumbled.events.find((event) => event.event_type === 'LockpickNoticed')
  assert.equal(loud.payload.severity, 'major')
  assert.equal(loud.payload.loud, true)
  assert.equal(deedsOf(fumbled.state).at(-1).severity, 'major')
  // Средняя ступень говорит о себе раньше: местная молва рождается вдвое
  // быстрее мелочи.
  assert.ok(deedsOf(fumbled.state).at(-1).spread_at_minutes < minorDeed.spread_at_minutes)
})

test('взлом не заводится в таблицу закона: шум — не преступление, и ступень розыска он не двигает', () => {
  assert.ok(DEED_KINDS.break_in, 'вид поступка обязан быть объявлен')
  assert.equal(Object.hasOwn(WANTED_CRIME_POINTS, 'break_in'), false)
  const heard = pickDoor(fixture({ witnesses: true, lockDc: 25 }), { roll: 5 })
  assert.deepEqual(heard.state.law?.crimes ?? [], [])
})

test('замеченный след — детерминированная доля, а не бросок: тот же вход даёт тот же исход', () => {
  const first = pickDoor(fixture({ witnesses: true }), { roll: 20 })
  const second = pickDoor(fixture({ witnesses: true }), { roll: 20 })
  assert.deepEqual(
    eventTypes(first.events).filter((type) => type === 'LockpickNoticed'),
    eventTypes(second.events).filter((type) => type === 'LockpickNoticed'),
    'один и тот же взлом обязан кончаться одинаково и после replay',
  )
  // Сама доля тоже проверяется прямо: без свидетелей следа не замечают, а
  // разные цели дают разные исходы — иначе доля была бы фикцией.
  const state = fixture({ witnesses: true })
  assert.equal(lockpickTraceNoticedFor(state, { targetId: 'door-vault', witnessIds: [] }), null)
  const outcomes = Array.from({ length: 40 }, (_, index) => Boolean(lockpickTraceNoticedFor(state, { targetId: `lock-${index}`, witnessIds: ['npc-1'] })))
  assert.ok(outcomes.some(Boolean), 'хоть какой-то сорванный замок обязан быть замечен')
  assert.ok(outcomes.some((value) => !value), 'замечать каждый замок — это не доля, а правило')
})

// ---------------------------------------------------------------------------
// Свободная фраза, проекция и replay

test('свободная фраза различает отмычку и плечо', () => {
  assert.deepEqual(sceneObjectOperationFromText('Вскрыть замок сундука отмычкой'), {
    intent: 'lockpick', approach: 'hand', aliases: ['chest'],
  })
  assert.deepEqual(sceneObjectOperationFromText('Поковыряться в замке — ларец'), {
    intent: 'lockpick', approach: 'hand', aliases: ['chest'],
  })
  // «Взломать замок» — тоже отмычка, хотя слово то же, что у выламывания:
  // порядок веток решает спор в пользу инструмента, когда назван замок.
  assert.equal(sceneObjectOperationFromText('Взломать замок двери').intent, 'lockpick')
  // Слово «взломать» без замка по-прежнему означает силу: за ним стоит плечо и
  // топор, а не инструмент.
  assert.deepEqual(sceneObjectOperationFromText('Разбить бочку топором'), {
    intent: 'open', approach: 'force', aliases: ['barrel'],
  })
  assert.equal(sceneInteractionCatalogEntry('chest').verbs.includes('lockpick'), true)
  assert.equal(sceneInteractionCatalogEntry('bookshelf').verbs.includes('lockpick'), false)
})

test('игроку не уезжает ни СЛ замка, ни летопись поступков', () => {
  const heard = pickDoor(fixture({ witnesses: true, lockDc: 25 }), { roll: 5 })
  const room = campaignStateForViewer(heard.state, PLAYER, 'hero')
  assert.equal(room.world_deeds, undefined, 'летопись поступков принадлежит ведущему')
  const serialized = JSON.stringify(room)
  assert.equal(serialized.includes('"break_in"'), false)
  assert.equal(serialized.includes('scene-object:container:lockpick'), false)
  // Замок двери в проекции карты остаётся, потому что он и так был там до этой
  // задачи: игрок видит запертую дверь, а не её сложность.
  const door = (room.scene?.map?.doors ?? []).find((entry) => entry.id === 'door-vault')
  assert.equal(door?.state, 'locked')
})

test('взлом переживает replay: и состояние двери, и след, и поступок', () => {
  const start = fixture({ witnesses: true, lockDc: 25 })
  const failedDoor = pickDoor(start, { roll: 1 })
  const openedChest = pickChest(failedDoor.state, { roll: 20 })
  const events = [...failedDoor.events, ...openedChest.events]
  const replayed = replayEvents(start, events)
  assert.deepEqual(replayed, openedChest.state)
  assert.equal(replayed.mechanics.scene_interactions['prop-chest'].lockpicked, true)
  assert.equal(deedsOf(replayed).filter((deed) => deed.kind === 'break_in').length, deedsOf(openedChest.state).filter((deed) => deed.kind === 'break_in').length)
})
