import assert from 'node:assert/strict'
import test from 'node:test'

import { levelKey } from '../server/adventure-director.mjs'
import { generateBuildingScene } from '../server/building-generator.mjs'
import { DiceService, SequenceDiceRng } from '../server/dice-service.mjs'
import { normalizeDeclaredLevels } from '../server/level-generator.mjs'
import { applyGameEvent, normalizeCampaignState, replayEvents, resolveCommand, worldTimeSeconds } from '../server/rules-engine.mjs'
import { legacyCellsFromTacticalMap, serializeTacticalMap } from '../server/tactical-map.mjs'

function dice(values = []) {
  let id = 0
  return new DiceService({
    rng: new SequenceDiceRng(values),
    idFactory: () => `summon-expiry-${++id}`,
    now: () => '2026-09-22T12:00:00.000Z',
  })
}

function field() {
  const cells = Array.from({ length: 10 * 4 }, (_, index) => ({
    x: index % 10, y: Math.floor(index / 10), type: 'floor', revealed: true,
  }))
  return normalizeCampaignState({
    sessionCode: 'SUMMON-EXPIRY',
    partyMemberIds: ['caster'],
    players: [{
      id: 'caster', character: 'Жрец', characterClass: 'cleric', level: 5,
      hp: 40, maxHp: 40, armor: 16, speed: 30, proficiency: 3,
      abilities: { str: 10, dex: 14, con: 14, int: 10, wis: 18, cha: 12 },
      knownSpellIds: ['light', 'mending', 'guidance', 'spiritual-weapon'],
      preparedSpellIds: ['spiritual-weapon'], inventory: [], x: 1, y: 1,
    }],
    enemies: [{ id: 'foe', name: 'Враг', hp: 20, maxHp: 20, armor: 12, speed: 30, alive: true, x: 7, y: 1 }],
    scene: { turn: 1, cells },
    mechanics: {
      resources: { caster: { spell_slots_2: { current: 2, max: 2 } } },
      combat: { active: false, round: 0, active_index: -1, initiative: [], action_economy: {} },
      world_time: { amount: 0, unit: 'minute', elapsed_minutes: 0, second_remainder: 0 },
    },
  })
}

const authoritative = (command) => ({ ...command, server_authoritative: true })
const options = (diceService) => ({ diceService, context: { serverAuthoritativeCombat: true, isAdmin: true } })

function levelField() {
  const levels = normalizeDeclaredLevels([{ offset: 1, hint: 'верхний зал' }, { offset: -1, hint: 'подвал' }])
  const map = generateBuildingScene({ seed: 'summon-expiry-levels', locationId: 'summon-loc', levels })
  const spawn = map.spawnPoints.find((point) => point.role === 'party')
  const cells = legacyCellsFromTacticalMap(map)
  return normalizeCampaignState({
    sessionCode: 'SUMMON-LEVELS',
    activePlayerId: 'caster',
    partyMemberIds: ['caster'],
    players: [{
      id: 'caster', character: 'Жрец', characterClass: 'cleric', level: 5,
      hp: 40, maxHp: 40, armor: 16, speed: 30, proficiency: 3,
      abilities: { str: 10, dex: 14, con: 14, int: 10, wis: 18, cha: 12 },
      knownSpellIds: ['spiritual-weapon'], preparedSpellIds: ['spiritual-weapon'], inventory: [],
      x: spawn.x, y: spawn.y,
    }],
    worldMap: { seed: 'summon-expiry-world', currentLocationId: 'summon-loc', locations: [{ id: 'summon-loc', name: 'Башня', kind: 'settlement' }] },
    scene: { title: 'Башня', location: 'Башня', location_id: 'summon-loc', turn: 1, levels, map: serializeTacticalMap(map), cells },
    mechanics: { resources: { caster: { spell_slots_2: { current: 2, max: 2 } } }, world_time: { amount: 0, unit: 'minute', elapsed_minutes: 0 } },
  })
}

function levelTransition(state, commandId, level) {
  const map = state.scene.map
  const target = JSON.parse(JSON.stringify(map)).props.find((prop) => Number(prop.transition?.toLevel) === level)
  return resolveCommand({ command_type: 'UseLevelTransition', command_id: commandId, actor_id: 'caster', prop_id: target.id }, state, options(dice()))
}

function cast(state, commandId, to = null) {
  return resolveCommand(authoritative({
    command_type: 'CastSpell', command_id: commandId, actor_id: 'caster',
    spell_id: 'spiritual-weapon', to: to ?? { x: commandId === 'cast-1' ? 4 : 5, y: 1 }, slot_level: 2,
  }), state, options(dice()))
}

function advance(state, commandId, amount) {
  return resolveCommand(authoritative({
    command_type: 'AdvanceTime', command_id: commandId, actor_id: 'caster', amount, unit: 'second',
  }), state, options(dice()))
}

function concentrationState({ stashed = false } = {}) {
  const initial = field()
  initial.players = [{ ...initial.players[0], characterClass: 'druid', knownSpellIds: ['summon-beast'], preparedSpellIds: ['summon-beast'] }]
  const castResult = resolveCommand(authoritative({
    command_type: 'CastSpell', command_id: `concentration-${stashed ? 'stashed' : 'active'}`,
    actor_id: 'caster', spell_id: 'summon-beast', to: { x: 4, y: 1 }, slot_level: 2,
  }), initial, options(dice()))
  let state = replayEvents(initial, castResult.events)
  const summon = state.actors.find((actor) => actor.kind === 'summon')
  assert.ok(summon)
  if (stashed) {
    state.levelEntities = { 'summon-loc:1': { summons: [summon], positions: { [summon.id]: { x: summon.x, y: summon.y } } } }
    state.actors = []
    state.mechanics.positions = {}
  }
  return { state, summon }
}

test('призыв жив на 59-й секунде и исчезает ровно на 60-й вне боя', () => {
  const initial = field()
  const castResult = cast(initial, 'cast-1')
  const created = castResult.events.find((event) => event.event_type === 'SummonedCreatureCreated')
  assert.ok(created)
  assert.equal(created.payload.summon.summon_lifecycle_version, 2)
  assert.equal(created.payload.summon.expires_at_seconds, 60)
  let state = replayEvents(initial, castResult.events)

  const at59 = advance(state, 'advance-59', 59)
  state = replayEvents(state, at59.events)
  assert.equal(worldTimeSeconds(state), 59)
  assert.equal(state.actors.some((actor) => actor.id === created.payload.summon.id), true)
  assert.equal(at59.events.some((event) => event.event_type === 'SummonedCreatureDismissed'), false)

  const at60 = advance(state, 'advance-60', 1)
  state = replayEvents(state, at60.events)
  assert.equal(worldTimeSeconds(state), 60)
  assert.equal(state.actors.some((actor) => actor.id === created.payload.summon.id), false)
  assert.equal(at60.events.filter((event) => event.event_type === 'SummonedCreatureDismissed').length, 1)
})

test('два призыва переживают переход в бой и удаляются в исследовании', () => {
  let state = field()
  state = replayEvents(state, cast(state, 'cast-1').events)
  state = replayEvents(state, cast(state, 'cast-2').events)
  state = replayEvents(state, advance(state, 'advance-59', 59).events)
  assert.equal(state.actors.filter((actor) => actor.kind === 'summon').length, 2)

  const started = resolveCommand(authoritative({ command_type: 'StartCombat', actor_id: 'caster', command_id: 'start-combat' }), state, options(dice([15, 10])))
  state = replayEvents(state, started.events)
  assert.equal(state.mechanics.combat.initiative.filter((entry) => String(entry.actor_id).startsWith('summon-')).length, 2)
  assert.equal(state.actors.filter((actor) => actor.kind === 'summon').length, 2)

  const ended = resolveCommand(authoritative({ command_type: 'EndCombat', actor_id: 'caster', command_id: 'end-combat' }), state, options(dice()))
  state = replayEvents(state, ended.events)
  assert.equal(state.mechanics.combat.active, false)
  assert.equal(state.actors.filter((actor) => actor.kind === 'summon').length, 2)

  state = replayEvents(state, advance(state, 'advance-final-second', 1).events)
  assert.equal(state.actors.filter((actor) => actor.kind === 'summon').length, 0)
})

test('истечение нескольких фишек в бою сохраняет следующего участника инициативы', () => {
  let state = field()
  state = replayEvents(state, cast(state, 'cast-1').events)
  state = replayEvents(state, cast(state, 'cast-2').events)
  state = replayEvents(state, advance(state, 'advance-59', 59).events)
  state = replayEvents(state, resolveCommand(authoritative({ command_type: 'StartCombat', actor_id: 'caster', command_id: 'start-combat' }), state, options(dice([15, 10]))).events)

  const turnActors = []
  const dismissals = []
  for (let step = 0; step < 8 && state.mechanics.combat.round < 2; step += 1) {
    const actorId = state.mechanics.combat.initiative[state.mechanics.combat.active_index]?.actor_id
    turnActors.push(actorId)
    const ended = resolveCommand(authoritative({ command_type: 'EndTurn', actor_id: actorId, command_id: `end-${step}` }), state, options(dice()))
    dismissals.push(...ended.events.filter((event) => event.event_type === 'SummonedCreatureDismissed'))
    state = replayEvents(state, ended.events)
  }

  assert.deepEqual(turnActors.slice(0, 4).map(String), [
    'caster', 'summon-caster-cast-1', 'summon-caster-cast-2', 'foe',
  ])
  assert.equal(dismissals.length, 2)
  assert.equal(state.actors.filter((actor) => actor.kind === 'summon').length, 0)
  assert.equal(state.mechanics.combat.initiative[state.mechanics.combat.active_index]?.actor_id, 'caster')
})

test('старый снимок призыва без дедлайна остаётся совместимым с replay', () => {
  let state = field()
  state.actors = [{
    id: 'legacy-summon', name: 'Старый дух', kind: 'summon', faction: 'party',
    ownerId: 'caster', controllerId: 'caster', hp: 10, maxHp: 10, alive: true, x: 3, y: 1,
  }]
  state = normalizeCampaignState(state)
  state = replayEvents(state, advance(state, 'legacy-advance-60', 60).events)
  assert.equal(state.actors.some((actor) => actor.id === 'legacy-summon'), true)
})

test('новые поля призыва игнорируются у старого Created без lifecycle marker', () => {
  const state = field()
  const after = applyGameEvent(state, {
    event_type: 'SummonedCreatureCreated', actor_id: 'caster', target_ids: ['legacy-created'],
    reducer_version: 15, state_version_after: 1,
    payload: {
      summon: {
        id: 'legacy-created', name: 'Старый дух', kind: 'summon', faction: 'party',
        ownerId: 'caster', controllerId: 'caster', hp: 10, maxHp: 10, alive: true, x: 3, y: 1,
        summon_lifecycle_version: 2, expires_at_seconds: 60,
      },
    },
  })
  const created = after.actors.find((actor) => actor.id === 'legacy-created')
  assert.ok(created)
  assert.equal(created.summon_lifecycle_version, undefined)
  assert.equal(created.expires_at_seconds, undefined)
  const advanced = replayEvents(after, advance(after, 'legacy-created-advance', 60).events)
  assert.equal(advanced.actors.some((actor) => actor.id === 'legacy-created'), true)
})

test('будущий summon lifecycle version не получает текущую expiry-политику', () => {
  const state = field()
  const after = applyGameEvent(state, {
    event_type: 'SummonedCreatureCreated', actor_id: 'caster', target_ids: ['future-created'],
    reducer_version: 15, state_version_after: 1,
    payload: {
      summon_lifecycle_version: 99,
      summon: {
        id: 'future-created', name: 'Будущий дух', kind: 'summon', faction: 'party',
        ownerId: 'caster', controllerId: 'caster', hp: 10, maxHp: 10, alive: true, x: 3, y: 1,
        summon_lifecycle_version: 99, expires_at_seconds: 60,
      },
    },
  })
  const created = after.actors.find((actor) => actor.id === 'future-created')
  assert.ok(created)
  assert.equal(created.summon_lifecycle_version, undefined)
  assert.equal(created.expires_at_seconds, undefined)
  const advanced = replayEvents(after, advance(after, 'future-created-advance', 60).events)
  assert.equal(advanced.actors.some((actor) => actor.id === 'future-created'), true)
})

test('большой скачок времени создаёт одно dismissal и не оставляет призыв после restart', () => {
  const initial = field()
  const castResult = cast(initial, 'large-cast')
  const afterCast = replayEvents(initial, castResult.events)
  const advanced = advance(afterCast, 'large-advance', 121)
  assert.equal(advanced.events.filter((event) => event.event_type === 'SummonedCreatureDismissed').length, 1)
  const live = replayEvents(afterCast, advanced.events)
  assert.equal(live.actors.some((actor) => actor.kind === 'summon'), false)
  assert.deepEqual(replayEvents(initial, [...castResult.events, ...advanced.events]), live)
})

test('два источника считают срок независимо: первый истекает, второй остаётся', () => {
  let state = field()
  state = replayEvents(state, cast(state, 'independent-a').events)
  state = replayEvents(state, advance(state, 'independent-30', 30).events)
  state = replayEvents(state, cast(state, 'independent-b', { x: 6, y: 1 }).events)
  const first = advance(state, 'independent-30b', 30)
  state = replayEvents(state, first.events)
  assert.equal(first.events.filter((event) => event.event_type === 'SummonedCreatureDismissed').length, 1)
  assert.equal(state.actors.filter((actor) => actor.kind === 'summon').length, 1)
  const remaining = state.actors.find((actor) => actor.kind === 'summon')
  assert.equal(remaining.expires_at_seconds, 90)
  state = replayEvents(state, advance(state, 'independent-30c', 30).events)
  assert.equal(state.actors.filter((actor) => actor.kind === 'summon').length, 0)
})

test('призыв в стэше переживает уход и возврат, а срок удаляет его из стэша или поля', () => {
  let state = levelField()
  const created = cast(state, 'level-cast', { x: state.players[0].x, y: state.players[0].y })
  state = replayEvents(state, created.events)
  state = replayEvents(state, advance(state, 'level-advance-59', 59).events)
  const stairs = state.scene.map.props.find((prop) => Number(prop.transition?.toLevel) === 1).footprint[0]
  state.players = state.players.map((player) => player.id === 'caster' ? { ...player, x: stairs.x, y: stairs.y } : player)
  state.mechanics.positions.caster = { x: stairs.x, y: stairs.y }
  const up = levelTransition(state, 'level-up', 1)
  assert.equal(up.events[0].event_type, 'MapLevelChanged')
  state = replayEvents(state, up.events)
  const summonId = created.events.find((event) => event.event_type === 'SummonedCreatureCreated').payload.summon.id
  assert.equal(state.actors.some((actor) => actor.id === summonId), false)
  assert.ok(state.levelEntities?.[levelKey('summon-loc', 0)]?.summons?.some((actor) => actor.id === summonId))

  const down = levelTransition(state, 'level-down', 0)
  state = replayEvents(state, down.events)
  assert.equal(state.actors.some((actor) => actor.id === summonId), true)
  const expired = advance(state, 'level-expire', 1)
  state = replayEvents(state, expired.events)
  assert.equal(state.actors.some((actor) => actor.id === summonId), false)
  assert.equal(Boolean(state.levelEntities?.[levelKey('summon-loc', 0)]?.summons?.some((actor) => actor.id === summonId)), false)
})

test('смена сцены очищает условия, инициативу и ожидающую команду призыва', () => {
  let state = replayEvents(field(), cast(field(), 'scene-cast').events)
  const summon = state.actors.find((actor) => actor.kind === 'summon')
  state.mechanics.conditions[summon.id] = [{ id: 'blessed-by-summon', source_actor: summon.id }]
  state.mechanics.conditions.caster = [{ id: 'summon-command', source_actor: summon.id }]
  state.mechanics.combat.readied[summon.id] = { trigger: 'enemy-approaches', actor_id: summon.id }
  state.mechanics.combat.reaction_window = { id: 'pending-summon', pending_command: { actor_id: summon.id } }
  const nextScene = {
    ...state.scene,
    title: 'Новая сцена', location: 'Новая сцена', turn: 2,
    cells: state.scene.cells.map((cell) => ({ ...cell })),
  }
  const next = applyGameEvent(state, {
    event_type: 'SceneAdvanced', actor_id: null, target_ids: [],
    payload: {
      scene: nextScene, worldMap: state.worldMap, party_positions: [{ actor_id: 'caster', x: 1, y: 1 }],
      summon_lifecycle_version: 2,
    },
  })
  assert.equal(next.actors.some((actor) => actor.id === summon.id), false)
  assert.equal(next.mechanics.conditions[summon.id], undefined)
  assert.equal(next.mechanics.conditions.caster?.some((condition) => condition.source_actor === summon.id), false)
  assert.equal(next.mechanics.combat.readied[summon.id], undefined)
  assert.equal(next.mechanics.combat.reaction_window, null)
})

test('новые death/0 HP события чистят стэшированную концентрацию, старые без marker сохраняют её', () => {
  for (const eventType of ['HeroDied', 'HitPointsReducedToZero']) {
    const markedState = concentrationState({ stashed: true }).state
    const marked = applyGameEvent(markedState, {
      event_type: eventType, actor_id: 'caster', target_ids: ['caster'],
      payload: { summon_lifecycle_version: 2 },
    })
    assert.equal(marked.mechanics.concentration.caster, undefined, `${eventType}: концентрация завершена`)
    assert.equal(marked.levelEntities['summon-loc:1'].summons.length, 0, `${eventType}: стэш очищен`)

    const legacyState = concentrationState({ stashed: true }).state
    const legacy = applyGameEvent(legacyState, {
      event_type: eventType, actor_id: 'caster', target_ids: ['caster'], payload: {},
      reducer_version: 15, state_version_after: 1,
    })
    assert.equal(legacy.mechanics.concentration.caster, undefined, `${eventType}: legacy всё ещё завершает саму концентрацию`)
    assert.equal(legacy.levelEntities['summon-loc:1'].summons.length, 1, `${eventType}: legacy не получает новую очистку`)
  }
})

test('новые death/0 HP команды пишут lifecycle marker, а nullable expiry не истекает в нулевой момент', () => {
  const zeroHpState = field()
  zeroHpState.players[0].hp = 1
  const zeroHp = resolveCommand(authoritative({
    command_type: 'ApplyDamage', command_id: 'marker-zero-hp', actor_id: 'caster', target_id: 'caster', amount: 10, damage_type: 'force',
  }), zeroHpState, options(dice()))
  assert.equal(zeroHp.events.find((event) => event.event_type === 'HitPointsReducedToZero')?.payload.summon_lifecycle_version, 2)

  const deathState = field()
  deathState.players[0].hp = 1
  const death = resolveCommand(authoritative({
    command_type: 'ApplyDamage', command_id: 'marker-death', actor_id: 'caster', target_id: 'caster', amount: 41, damage_type: 'force',
  }), deathState, options(dice()))
  assert.equal(death.events.find((event) => event.event_type === 'HeroDied')?.payload.summon_lifecycle_version, 2)

  const nullable = field()
  nullable.actors = [{
    id: 'nullable-summon', name: 'Без срока', kind: 'summon', faction: 'party', ownerId: 'caster', controllerId: 'caster',
    summon_lifecycle_version: 2, expires_at_seconds: null, expiresAtSeconds: null,
    hp: 10, maxHp: 10, alive: true, x: 3, y: 1,
  }]
  const advanced = advance(nullable, 'nullable-advance', 60)
  assert.equal(advanced.events.some((event) => event.event_type === 'SummonedCreatureDismissed'), false)
  const afterAdvance = replayEvents(nullable, advanced.events)
  assert.equal(afterAdvance.actors.some((actor) => actor.id === 'nullable-summon'), true)
  const started = resolveCommand(authoritative({ command_type: 'StartCombat', command_id: 'nullable-start', actor_id: 'caster' }), afterAdvance, options(dice([15, 10])))
  assert.equal(started.events.some((event) => event.event_type === 'SummonedCreatureDismissed'), false)
  const afterStart = replayEvents(afterAdvance, started.events)
  assert.equal(afterStart.actors.some((actor) => actor.id === 'nullable-summon'), true)
})

test('новая смена сцены чистит concentration pointer вместе с последним summon', () => {
  const { state, summon } = concentrationState()
  const nextScene = {
    ...state.scene, title: 'Новая сцена', location: 'Новая сцена', turn: 2,
    cells: state.scene.cells.map((cell) => ({ ...cell })),
  }
  const next = applyGameEvent(state, {
    event_type: 'SceneAdvanced', actor_id: null, target_ids: [],
    payload: {
      scene: nextScene, worldMap: state.worldMap, party_positions: [{ actor_id: 'caster', x: 1, y: 1 }],
      summon_lifecycle_version: 2,
    },
  })
  assert.equal(next.actors.some((actor) => actor.id === summon.id), false)
  assert.equal(next.mechanics.concentration.caster, undefined)
})

test('приостановленная кампания не двигает мировые часы и не истекает', () => {
  const state = field()
  state.mechanics.campaign_lifecycle.status = 'paused'
  assert.throws(() => advance(state, 'paused-advance', 60), (error) => error.code === 'CAMPAIGN_PAUSED')
  assert.equal(worldTimeSeconds(state), 0)
})

test('ConcentrationEnded снимает стэшированный призыв с тем же source effect', () => {
  const initial = normalizeCampaignState({
    ...field(),
    players: [{ ...field().players[0], characterClass: 'druid', knownSpellIds: ['summon-beast'], preparedSpellIds: ['summon-beast'] }],
  })
  const castResult = resolveCommand(authoritative({ command_type: 'CastSpell', command_id: 'concentration-cast', actor_id: 'caster', spell_id: 'summon-beast', to: { x: 4, y: 1 }, slot_level: 2 }), initial, options(dice()))
  let state = replayEvents(initial, castResult.events)
  const summon = state.actors.find((actor) => actor.kind === 'summon')
  assert.ok(summon)
  state.levelEntities = { 'summon-loc:1': { summons: [summon], positions: { [summon.id]: { x: summon.x, y: summon.y } } } }
  state.actors = []
  state.mechanics.positions = {}
  const ended = resolveCommand(authoritative({ command_type: 'EndConcentration', command_id: 'concentration-end', actor_id: 'caster' }), state, options(dice()))
  state = replayEvents(state, ended.events)
  assert.equal(state.mechanics.concentration.caster, undefined)
  assert.equal(state.levelEntities['summon-loc:1'].summons.some((actor) => actor.id === summon.id), false)
})

test('dismiss одного из двух призывов с общим effect_id сохраняет второго, общий effect и концентрацию', () => {
  const castResult = cast(field(), 'shared-effect-cast')
  let state = replayEvents(field(), castResult.events)
  const first = state.actors.find((actor) => actor.kind === 'summon')
  assert.ok(first)
  const second = { ...first, id: 'shared-effect-second', x: first.x + 1 }
  state.actors = [first, second]
  state.mechanics.conditions[first.id] = [{ id: 'only-first', source_actor: first.id, effect_id: first.sourceEffectId }]
  state.mechanics.conditions[second.id] = [{ id: 'only-second', source_actor: second.id, effect_id: second.sourceEffectId }]
  state.mechanics.conditions.caster = [{ id: 'shared-condition', source_actor: 'caster', effect_id: first.sourceEffectId }]
  state.mechanics.active_effects = [{ id: 'shared-area', effect_id: first.sourceEffectId, source_actor: 'caster' }]
  state.mechanics.concentration.caster = { effect_id: first.sourceEffectId }
  state = normalizeCampaignState(state)

  const after = applyGameEvent(state, {
    event_type: 'SummonedCreatureDismissed', actor_id: 'caster', target_ids: [first.id],
    payload: { reason: 'test', summon_lifecycle_version: 2 },
  })
  assert.equal(after.actors.some((actor) => actor.id === first.id), false)
  assert.equal(after.actors.some((actor) => actor.id === second.id), true)
  assert.equal(after.mechanics.conditions[first.id], undefined)
  assert.deepEqual(after.mechanics.conditions.caster, [{ id: 'shared-condition', source_actor: 'caster', effect_id: first.sourceEffectId }])
  assert.deepEqual(after.mechanics.active_effects, [{ id: 'shared-area', effect_id: first.sourceEffectId, source_actor: 'caster' }])
  assert.equal(after.mechanics.concentration.caster.effect_id, first.sourceEffectId)
})

test('истечение одного из двух призывов с общим effect_id сохраняет второго до его срока', () => {
  const castResult = cast(field(), 'shared-expiry-cast')
  let state = replayEvents(field(), castResult.events)
  const first = state.actors.find((actor) => actor.kind === 'summon')
  assert.ok(first)
  const second = { ...first, id: 'shared-expiry-second', x: first.x + 1, expires_at_seconds: 120 }
  state.actors = [first, second]
  state.mechanics.conditions[first.id] = [{ id: 'only-first', source_actor: first.id, effect_id: first.sourceEffectId }]
  state.mechanics.conditions[second.id] = [{ id: 'only-second', source_actor: second.id, effect_id: second.sourceEffectId }]
  state.mechanics.conditions.caster = [{ id: 'shared-condition', source_actor: 'caster', effect_id: first.sourceEffectId }]
  state.mechanics.active_effects = [{ id: 'shared-area', effect_id: first.sourceEffectId, source_actor: 'caster' }]
  state.mechanics.concentration.caster = { effect_id: first.sourceEffectId }
  state = normalizeCampaignState(state)

  state = replayEvents(state, advance(state, 'shared-expiry-60', 60).events)
  assert.equal(state.actors.some((actor) => actor.id === first.id), false)
  assert.equal(state.actors.some((actor) => actor.id === second.id), true)
  assert.deepEqual(state.mechanics.conditions.caster, [{ id: 'shared-condition', source_actor: 'caster', effect_id: first.sourceEffectId }])
  assert.deepEqual(state.mechanics.active_effects, [{ id: 'shared-area', effect_id: first.sourceEffectId, source_actor: 'caster' }])
  assert.equal(state.mechanics.concentration.caster.effect_id, first.sourceEffectId)

  state = replayEvents(state, advance(state, 'shared-expiry-120', 60).events)
  assert.equal(state.actors.some((actor) => actor.id === second.id), false)
  assert.equal(state.mechanics.concentration.caster, undefined)
  assert.deepEqual(state.mechanics.active_effects, [])
})

test('старое событие dismissal не получает новую recursive cleanup-политику', () => {
  const castResult = cast(field(), 'legacy-cleanup-cast')
  let state = replayEvents(field(), castResult.events)
  const created = state.actors.find((actor) => actor.kind === 'summon')
  assert.ok(created)
  state.mechanics.conditions.caster = [{ id: 'legacy-condition', source_actor: 'caster', effect_id: created.sourceEffectId }]
  state.mechanics.active_effects = [{ id: 'legacy-area', effect_id: created.sourceEffectId, source_actor: 'caster' }]
  state = normalizeCampaignState(state)

  const legacy = applyGameEvent(state, {
    event_type: 'SummonedCreatureDismissed', actor_id: 'caster', target_ids: [created.id],
    reducer_version: 15, state_version_after: 1,
    payload: { reason: 'legacy' },
  })
  assert.equal(legacy.actors.some((actor) => actor.id === created.id), false)
  assert.deepEqual(legacy.mechanics.conditions.caster, [{ id: 'legacy-condition', source_actor: 'caster', effect_id: created.sourceEffectId }])
  assert.deepEqual(legacy.mechanics.active_effects, [{ id: 'legacy-area', effect_id: created.sourceEffectId, source_actor: 'caster' }])
})

test('сохранённые reducer15 SceneAdvanced и ConcentrationEnded без marker сохраняют baseline replay', () => {
  const castResult = cast(field(), 'legacy-scene-cast')
  let state = replayEvents(field(), castResult.events)
  const created = state.actors.find((actor) => actor.kind === 'summon')
  assert.ok(created)
  state.mechanics.conditions[created.id] = [{ id: 'legacy-summon-condition', source_actor: created.id }]
  const nextScene = { ...state.scene, title: 'Legacy scene', location: 'Legacy scene', turn: 2, cells: state.scene.cells.map((cell) => ({ ...cell })) }

  const sceneAfter = applyGameEvent(state, {
    event_type: 'SceneAdvanced', actor_id: null, target_ids: [], reducer_version: 15, state_version_after: 1,
    payload: { scene: nextScene, worldMap: state.worldMap, party_positions: [{ actor_id: 'caster', x: 1, y: 1 }] },
  })
  assert.equal(sceneAfter.actors.some((actor) => actor.id === created.id), false)
  assert.deepEqual(sceneAfter.mechanics.conditions[created.id], [{ id: 'legacy-summon-condition', source_actor: created.id }])

  const concentrationState = replayEvents(field(), cast(field(), 'legacy-concentration-cast').events)
  const concentrationSummon = concentrationState.actors.find((actor) => actor.kind === 'summon')
  assert.ok(concentrationSummon)
  concentrationState.levelEntities = { 'legacy-level:1': { summons: [concentrationSummon], positions: { [concentrationSummon.id]: { x: concentrationSummon.x, y: concentrationSummon.y } } } }
  concentrationState.actors = []
  concentrationState.mechanics.positions = {}
  concentrationState.mechanics.concentration.caster = { effect_id: concentrationSummon.sourceEffectId }
  concentrationState.mechanics.conditions.caster = [{ id: 'legacy-concentration-condition', effect_id: concentrationSummon.sourceEffectId }]
  concentrationState.mechanics.active_effects = [{ id: 'legacy-concentration-area', effect_id: concentrationSummon.sourceEffectId }]

  const concentrationAfter = applyGameEvent(concentrationState, {
    event_type: 'ConcentrationEnded', actor_id: 'caster', target_ids: ['caster'], reducer_version: 15, state_version_after: 1,
    payload: { effect_id: concentrationSummon.sourceEffectId, reason: 'legacy' },
  })
  assert.equal(concentrationAfter.mechanics.concentration.caster, undefined)
  assert.deepEqual(concentrationAfter.mechanics.conditions.caster, [])
  assert.deepEqual(concentrationAfter.mechanics.active_effects, [])
  assert.equal(concentrationAfter.levelEntities['legacy-level:1'].summons.some((actor) => actor.id === concentrationSummon.id), true)
})
